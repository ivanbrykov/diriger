import { writeFile } from "node:fs/promises";
import {
  createFrozenRun,
  reserveAttempt,
  checkpoint,
  checkpointCompletedAttempt,
  writeAttemptArtifact,
  writeRunSummary,
  readState,
  validateFrozenInputs,
  type ArtifactRef,
  type Json,
  type State,
} from "./state.js";
import { isAbsolute, join } from "node:path";
import { executorFor, type AttemptLifecycle } from "./attempt-executor.js";
import { launchGuarded } from "./guard.js";
import { OwnershipLock, diagnoseOwnership } from "./ownership.js";
import { reconcileRun } from "./reconciliation.js";
import { runVerification } from "./process.js";
import type {
  AttemptRecord,
  RunRecord,
  SupervisorConfig,
  VerificationResult,
} from "./types.js";
import {
  captureWorkerProfile,
  frozenWorkerEnvironment,
  supportsFreshWorker,
  validateWorkerProfile,
  type WorkerProfile,
} from "./worker-profile.js";

const FAILURE_OUTPUT_LIMIT = 24_000;

function now(): string {
  return new Date().toISOString();
}

function runGit(repositoryPath: string, args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync(
    ["git", "--no-replace-objects", "-C", repositoryPath, ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    const error = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${error}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function head(repositoryPath: string): string {
  return runGit(repositoryPath, ["rev-parse", "HEAD"]);
}

function status(repositoryPath: string): string {
  return runGit(repositoryPath, ["status", "--porcelain=v1"]);
}

function recentLog(repositoryPath: string): string {
  return runGit(repositoryPath, ["log", "-5", "--format=%H %s"]);
}

async function assertFile(path: string, label: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path: ${path}`);
  }
  if (!(await Bun.file(path).exists())) {
    throw new Error(`${label} does not exist: ${path}`);
  }
}

export async function validateConfig(config: SupervisorConfig): Promise<void> {
  await assertFile(config.planPath, "plan");
  await assertFile(config.verifierPath, "verifier");
  if (config.workerKind !== "acp") {
    if (config.workerRecipePath === undefined) {
      throw new Error("worker recipe is required for a Goose worker");
    }
    await assertFile(config.workerRecipePath, "worker recipe");
  }

  if (!isAbsolute(config.repositoryPath)) {
    throw new Error(
      `repository must be an absolute path: ${config.repositoryPath}`,
    );
  }
  if (!isAbsolute(config.evidencePath)) {
    throw new Error(
      `evidence must be an absolute path: ${config.evidencePath}`,
    );
  }
  if (config.maxAttempts < 1) {
    throw new Error("max attempts must be at least 1");
  }

  runGit(config.repositoryPath, ["rev-parse", "--is-inside-work-tree"]);
}

export function boundedFailureOutput(output: string): string {
  if (output.length <= FAILURE_OUTPUT_LIMIT) {
    return output;
  }

  const half = Math.floor(FAILURE_OUTPUT_LIMIT / 2);
  return [
    output.slice(0, half),
    "\n\n... verifier output truncated by supervisor ...\n\n",
    output.slice(-half),
  ].join("");
}

function failureReport(
  config: SupervisorConfig,
  attempt: number,
  reason: string,
  verification: VerificationResult | undefined,
  historyViolation: boolean,
): string {
  const verificationSection =
    verification === undefined
      ? "Verifier was not run because the worker did not leave an acceptable Git state."
      : [
          `Verifier exit code: ${verification.exitCode}`,
          `Verifier timed out: ${verification.timedOut}`,
          "",
          "```text",
          boundedFailureOutput(verification.output),
          "```",
        ].join("\n");

  return [
    "# Supervisor Failure Report",
    "",
    `Run: ${config.runId}`,
    `Stage: ${config.stage}`,
    `Failed attempt: ${attempt}`,
    `Repository: ${config.repositoryPath}`,
    `Plan: ${config.planPath}`,
    `Reason: ${reason}`,
    "",
    "## Git Status",
    "",
    "```text",
    status(config.repositoryPath) || "(clean)",
    "```",
    "",
    "## Recent Commits",
    "",
    "```text",
    recentLog(config.repositoryPath),
    "```",
    "",
    "## Verification",
    "",
    verificationSection,
    "",
    ...(historyViolation
      ? [
          "Run stopped: history violations are not retried. Inspect the preserved",
          "worktree and restore the intended history before starting another run.",
        ]
      : [
          "Reproduce the failure, inspect any existing changes, implement the missing",
          "behavior, add a regression test, and finish with a clean new commit.",
        ]),
    "",
  ].join("\n");
}

function historyProblem(
  repositoryPath: string,
  preHead: string,
  postHead: string,
  originalRef: string,
): string | undefined {
  const ancestry = Bun.spawnSync(
    [
      "git",
      "--no-replace-objects",
      "-C",
      repositoryPath,
      "merge-base",
      "--is-ancestor",
      preHead,
      postHead,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (ancestry.exitCode === 1) {
    return "worker rewrote history: previous HEAD is not an ancestor of new HEAD";
  }
  if (ancestry.exitCode !== 0) {
    const message = new TextDecoder().decode(ancestry.stderr).trim();
    throw new Error(`git ancestry check failed: ${message}`);
  }
  if (
    runGit(repositoryPath, ["rev-parse", "--symbolic-full-name", "HEAD"]) !==
    originalRef
  ) {
    return "worker changed the checked-out branch";
  }
  if (
    runGit(repositoryPath, [
      "rev-list",
      "--merges",
      `${preHead}..${postHead}`,
    ]) !== ""
  ) {
    return "worker introduced a merge commit";
  }
  return undefined;
}

function workerProblem(
  exitCode: number,
  terminationReason: string | undefined,
  preHead: string,
  postHead: string,
  postStatus: string,
): string | undefined {
  if (terminationReason !== undefined) {
    return `worker terminated by supervisor: ${terminationReason}`;
  }
  if (exitCode !== 0) {
    return `worker exited with code ${exitCode}`;
  }
  if (postStatus !== "") {
    return "worker left a dirty worktree";
  }
  if (preHead === postHead) {
    return "worker produced no new commit";
  }
  return undefined;
}

async function persistRun(
  config: SupervisorConfig,
  record: RunRecord,
): Promise<void> {
  await writeFile(
    `${config.evidencePath}/run.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export class ResumeBlockedError extends Error {}

function restoredRecord(state: State, config: SupervisorConfig): RunRecord {
  const attempts = (state.completedAttempts ?? [])
    .map((entry) => entry.result)
    .filter(
      (value): value is Readonly<Record<string, Json>> => value !== undefined,
    )
    .map(
      (value) =>
        JSON.parse(
          JSON.stringify({
            attempt: value.attempt,
            startedAt: value.startedAt,
            finishedAt: value.finishedAt ?? state.updatedAt,
            preHead: value.preHead,
            postHead: value.postHead,
            postStatus: value.postStatus,
            worker: value.worker,
            ...(value.protocol === null || value.protocol === undefined
              ? {}
              : { protocol: value.protocol }),
            ...(value.verification === null || value.verification === undefined
              ? {}
              : { verification: value.verification }),
            ...(value.failureReportPath === null ||
            value.failureReportPath === undefined
              ? {}
              : { failureReportPath: value.failureReportPath }),
          }),
        ) as unknown as AttemptRecord,
    )
    .sort((a, b) => a.attempt - b.attempt);
  const accepted = state.phase === "accepted" || state.phase === "verified";
  return {
    runId: state.runId,
    stage: config.stage,
    repositoryPath: state.initial.worktree,
    planPath: config.planPath,
    startedAt: state.startedAt,
    finishedAt: state.updatedAt,
    status: accepted ? "accepted" : "failed",
    ...(accepted ? { acceptedHead: state.candidateHead } : {}),
    attempts,
  };
}

async function commitAcceptedSummary(
  evidencePath: string,
  state: State,
  record: RunRecord,
): Promise<RunRecord> {
  const summaryArtifact = await writeAttemptArtifact(
    evidencePath,
    Math.max(1, state.reservedAttempts),
    "run-summary.json",
    JSON.parse(JSON.stringify(record)) as Json,
  );
  await checkpoint(evidencePath, {
    phase: "accepted",
    ...(state.candidateHead === undefined
      ? {}
      : { candidateHead: state.candidateHead }),
    summaryArtifact,
  });
  await writeRunSummary(
    evidencePath,
    JSON.parse(JSON.stringify(record)) as Json,
  );
  return record;
}

export async function resumeSupervision(
  evidencePath: string,
): Promise<RunRecord> {
  const state = await validateFrozenInputs(evidencePath);
  let config = JSON.parse(
    await Bun.file(join(evidencePath, state.inputs.config.path)).text(),
  ) as SupervisorConfig;
  const profile =
    state.inputs.profile === undefined
      ? undefined
      : (JSON.parse(
          await Bun.file(join(evidencePath, state.inputs.profile.path)).text(),
        ) as WorkerProfile);
  const ownership = await diagnoseOwnership(state.initial.worktree);
  if (ownership.state !== "free")
    throw new ResumeBlockedError(
      "resume requires reconciled safe ownership: " +
        ("reason" in ownership ? ownership.reason : ownership.state),
    );
  const lock = await OwnershipLock.acquire(
    state.initial.worktree,
    evidencePath,
  );
  try {
    const current = await validateFrozenInputs(evidencePath, {
      runId: state.runId,
      initial: state.initial,
    });
    const decision = await reconcileRun(
      evidencePath,
      current,
      config.maxAttempts,
    );
    if (decision.action === "fresh-repair") {
      if (profile === undefined)
        throw new ResumeBlockedError(
          "resume cannot launch a fresh worker without a frozen runtime profile",
        );
      if (!supportsFreshWorker(profile))
        throw new ResumeBlockedError(
          "resume cannot launch a fresh worker with an unsupported frozen runtime profile version",
        );
      await validateWorkerProfile(profile, config);
      config = {
        ...config,
        workerEnvironment: frozenWorkerEnvironment(profile),
      };
    }
    if (decision.action === "reuse-accepted") {
      if (current.summaryArtifact === undefined)
        throw new Error(
          "accepted checkpoint has no immutable summary artifact",
        );
      const bytes = await Bun.file(
        join(evidencePath, current.summaryArtifact.path),
      ).arrayBuffer();
      const record = JSON.parse(new TextDecoder().decode(bytes)) as RunRecord;
      if (
        record.runId !== current.runId ||
        record.status !== "accepted" ||
        record.acceptedHead !== current.candidateHead
      )
        throw new Error("immutable summary identity drift");
      await writeRunSummary(
        evidencePath,
        JSON.parse(new TextDecoder().decode(bytes)) as Json,
      );
      return record;
    }
    if (decision.action === "finalize-verified") {
      const record = restoredRecord({ ...current, phase: "accepted" }, config);
      return await commitAcceptedSummary(evidencePath, current, record);
    }
    if (
      decision.action === "rerun-verifier" ||
      decision.action === "verify-candidate"
    ) {
      let verifierState = current;
      if (verifierState.phase === "worker_starting")
        verifierState = await checkpoint(evidencePath, {
          phase: "worker_running",
        });
      if (verifierState.phase === "worker_running")
        verifierState = await checkpoint(evidencePath, {
          phase: "worker_finished",
          ...(decision.candidateHead === undefined
            ? {}
            : { candidateHead: decision.candidateHead }),
        });
      const candidateHead =
        decision.candidateHead ?? verifierState.candidateHead;
      if (candidateHead === undefined)
        throw new Error("resume verifier lacks candidate HEAD");
      const attempt = current.reservedAttempts;
      await checkpoint(evidencePath, { phase: "verifying", candidateHead });
      const command = [...current.inputs.verifier.argv];
      const startedAt = now();
      const verification = await runVerification(
        command,
        current.initial.worktree,
        { ...process.env, SAMOVAR_BENCH_REPO: current.initial.worktree },
        10 * 60_000,
        await launchGuarded({
          lock,
          command,
          cwd: current.initial.worktree,
          env: { ...process.env, SAMOVAR_BENCH_REPO: current.initial.worktree },
          controlPath: join(evidencePath, "recovery-verifier-guard"),
        }),
      );
      const finishedAt = now(),
        headAfter = head(current.initial.worktree),
        refAfter = runGit(current.initial.worktree, [
          "rev-parse",
          "--symbolic-full-name",
          "HEAD",
        ]),
        statusAfter = status(current.initial.worktree);
      const proof = await writeAttemptArtifact(
        evidencePath,
        attempt,
        "verification-recovery-" + crypto.randomUUID() + ".json",
        {
          version: 1,
          candidateHead,
          headAfter,
          refAfter,
          statusAfter,
          exitCode: verification.exitCode,
          timedOut: verification.timedOut,
          command,
          startedAt,
          finishedAt,
        },
      );
      const recovered = {
        attempt,
        startedAt,
        finishedAt,
        postHead: candidateHead,
        postStatus: statusAfter,
        worker: { exitCode: -1, resultUnavailable: true },
        verification,
        recovery: "unknown worker result verified",
      };
      const existing = current.completedAttempts ?? [];
      const prior = existing.find((item) => item.attempt === attempt);
      const completed =
        prior === undefined
          ? [
              ...existing,
              {
                attempt,
                artifacts: [proof],
                result: JSON.parse(JSON.stringify(recovered)) as Record<
                  string,
                  Json
                >,
              },
            ]
          : existing.map((item) =>
              item.attempt === attempt
                ? {
                    ...item,
                    artifacts: [...item.artifacts, proof],
                    result:
                      item.result ??
                      (JSON.parse(JSON.stringify(recovered)) as Record<
                        string,
                        Json
                      >),
                  }
                : item,
            );
      await checkpoint(evidencePath, {
        completedAttempts: completed,
        candidateHead,
        verification: { artifact: proof as unknown as Json },
      } as never);
      if (
        verification.exitCode !== 0 ||
        verification.timedOut ||
        headAfter !== candidateHead ||
        refAfter !== current.initial.ref ||
        statusAfter !== ""
      )
        throw new Error("recovered verifier failed or changed candidate");
      await checkpoint(evidencePath, {
        phase: "verified",
        candidateHead,
        verification: { artifact: proof as unknown as Json },
      });
      const acceptedState = {
        ...(await readState(evidencePath)),
        phase: "accepted" as const,
        candidateHead,
      };
      const record = restoredRecord(acceptedState, config);
      return await commitAcceptedSummary(evidencePath, acceptedState, record);
    }
    if (decision.action === "fresh-repair") {
      let prepared = current;
      if (prepared.phase === "worker_starting")
        prepared = await checkpoint(evidencePath, { phase: "worker_running" });
      if (prepared.phase === "worker_running")
        prepared = await checkpoint(evidencePath, { phase: "worker_finished" });
      const interruptionPath = join(
        evidencePath,
        "attempt-" + prepared.reservedAttempts + "-interrupted.md",
      );
      const interruption =
        "# Interrupted Attempt\n\nAttempt: " +
        prepared.reservedAttempts +
        "\nState: " +
        prepared.phase +
        "\n\nThe prior worker result was not durably recorded. Preserve existing work and repair it in a clean descendant commit.\n";
      await writeFile(interruptionPath, interruption);
      const interruptionArtifact = await writeAttemptArtifact(
        evidencePath,
        prepared.reservedAttempts,
        "interrupted.md",
        new TextEncoder().encode(interruption),
      );
      if (
        !(prepared.completedAttempts ?? []).some(
          (item) => item.attempt === prepared.reservedAttempts,
        )
      ) {
        prepared = await checkpoint(evidencePath, {
          completedAttempts: [
            ...(prepared.completedAttempts ?? []),
            {
              attempt: prepared.reservedAttempts,
              artifacts: [interruptionArtifact],
              result: {
                attempt: prepared.reservedAttempts,
                startedAt: prepared.attempt?.startedAt ?? prepared.updatedAt,
                finishedAt: prepared.updatedAt,
                worker: { exitCode: -1, resultUnavailable: true },
                recovery: "interrupted worker result unavailable",
              },
            },
          ],
        } as never);
      }
      return await superviseOwned(config, lock, prepared, interruptionPath);
    }
    if (decision.action === "terminal") {
      const record =
        current.summaryArtifact === undefined
          ? restoredRecord(current, config)
          : (JSON.parse(
              await Bun.file(
                join(evidencePath, current.summaryArtifact.path),
              ).text(),
            ) as RunRecord);
      await writeRunSummary(
        evidencePath,
        JSON.parse(JSON.stringify(record)) as Json,
      );
      return record;
    }
    if (decision.action === "blocked")
      throw new ResumeBlockedError("resume blocked: " + decision.reason);
    throw new Error("resume cannot continue: " + decision.action);
  } finally {
    await lock.release();
  }
}

export async function supervise(config: SupervisorConfig): Promise<RunRecord> {
  await validateConfig(config);
  const lock = await OwnershipLock.acquire(
    config.repositoryPath,
    config.evidencePath,
  );
  try {
    if (status(config.repositoryPath) !== "") {
      throw new Error("repository must be clean before supervision starts");
    }
    return await superviseOwned(config, lock);
  } finally {
    await lock.release();
  }
}

async function superviseOwned(
  config: SupervisorConfig,
  lock: OwnershipLock,
  existing?: State,
  resumeFailurePath?: string,
): Promise<RunRecord> {
  const newProfile =
    existing === undefined ? await captureWorkerProfile(config) : undefined;
  const initialHead = existing?.initial.head ?? head(config.repositoryPath);
  const initialRef =
    existing?.initial.ref ??
    runGit(config.repositoryPath, [
      "rev-parse",
      "--symbolic-full-name",
      "HEAD",
    ]);
  const frozen =
    existing ??
    (await createFrozenRun({
      evidencePath: config.evidencePath,
      runId: config.runId,
      resolvedConfig: JSON.parse(
        JSON.stringify({
          ...config,
          workerRecipePath: config.workerRecipePath ?? null,
          acpCommand:
            config.acpCommand === undefined ? null : [...config.acpCommand],
        }),
      ) as Json,
      initial: {
        head: initialHead,
        ref: initialRef,
        worktree: config.repositoryPath,
      },
      planPath: config.planPath,
      ...(config.workerRecipePath === undefined
        ? {}
        : { recipePath: config.workerRecipePath }),
      ...(newProfile === undefined
        ? {}
        : { profile: newProfile as unknown as Json }),
      verifier: {
        argv: [config.verifierPath, config.stage],
        cwd: config.repositoryPath,
        entryPath: config.verifierPath,
        selfContained: config.verifierSelfContained ?? true,
        ...(config.verifierDependencies === undefined
          ? {}
          : { dependencies: config.verifierDependencies }),
        ...(config.verifierSnapshotRoot === undefined
          ? {}
          : { snapshotRoot: config.verifierSnapshotRoot }),
      },
    }));

  const startedAt = frozen.startedAt;
  const attempts: AttemptRecord[] =
    existing === undefined
      ? []
      : [...restoredRecord(existing, config).attempts];
  let failureReportPath = resumeFailurePath ?? "/dev/null";
  const frozenConfig: SupervisorConfig = {
    ...config,
    planPath: join(config.evidencePath, frozen.inputs.plan.path),
    ...(frozen.inputs.recipe === undefined
      ? {}
      : {
          workerRecipePath: join(
            config.evidencePath,
            frozen.inputs.recipe.path,
          ),
        }),
    ...(frozen.inputs.profile === undefined
      ? {}
      : {
          workerEnvironment: frozenWorkerEnvironment(
            JSON.parse(
              await Bun.file(
                join(config.evidencePath, frozen.inputs.profile.path),
              ).text(),
            ) as WorkerProfile,
          ),
        }),
  };
  const executor = executorFor(frozenConfig);
  const originalRef = runGit(config.repositoryPath, [
    "rev-parse",
    "--symbolic-full-name",
    "HEAD",
  ]);

  console.log(`[stage ${config.stage}] supervisor.started run=${config.runId}`);

  for (
    let attempt = (existing?.reservedAttempts ?? 0) + 1;
    attempt <= config.maxAttempts;
    attempt += 1
  ) {
    const attemptStartedAt = now();
    await reserveAttempt(config.evidencePath, { startedAt: attemptStartedAt });
    const preHead = head(config.repositoryPath);
    const prefix = `${config.evidencePath}/attempt-${attempt}`;

    console.log(
      `[stage ${config.stage} attempt ${attempt}] worker.started head=${preHead.slice(0, 8)}`,
    );

    const deadline = new Date(
      Date.now() + config.workerTimeoutMs,
    ).toISOString();
    const updateAttempt = async (
      fields: Record<string, Json>,
    ): Promise<void> => {
      const current = await readState(config.evidencePath);
      await checkpoint(config.evidencePath, {
        attempt: { ...(current.attempt ?? {}), ...fields } as never,
      });
    };
    const onLifecycle = async (event: AttemptLifecycle): Promise<void> => {
      await updateAttempt({ lifecycle: event });
    };
    const execution = await executor.execute({
      config: frozenConfig,
      attempt,
      failureReportPath,
      prefix,
      onLifecycle,
      guardedLaunch: (command, controlPath, beforeAuthorize) =>
        launchGuarded({
          lock,
          command,
          cwd: config.repositoryPath,
          env: frozenConfig.workerEnvironment ?? process.env,
          controlPath,
          beforeAuthorize: async () => {
            const metadata = lock.metadata;
            await checkpoint(config.evidencePath, {
              phase: "worker_running",
              attempt: {
                attempt,
                startedAt: attemptStartedAt,
                deadline,
                lifecycle: "authorized",
                controlPath,
                guard: JSON.parse(
                  JSON.stringify(metadata.guard ?? null),
                ) as Json,
                processGroup: JSON.parse(
                  JSON.stringify(metadata.processGroupLeader ?? null),
                ) as Json,
              } as never,
            });
            await beforeAuthorize?.();
          },
        }),
    });
    const worker = execution.worker;
    const artifacts: ArtifactRef[] = [];
    const workerArtifact = await writeAttemptArtifact(
      config.evidencePath,
      attempt,
      "worker-result.json",
      JSON.parse(
        JSON.stringify({
          version: 1,
          attempt,
          startedAt: attemptStartedAt,
          finishedAt: now(),
          worker,
          protocol: execution.protocol ?? null,
        }),
      ) as Json,
    );
    const gitArtifact = await writeAttemptArtifact(
      config.evidencePath,
      attempt,
      "git.json",
      {
        version: 1,
        preHead,
        postHead: head(config.repositoryPath),
        postStatus: status(config.repositoryPath),
        refAfter: runGit(config.repositoryPath, [
          "rev-parse",
          "--symbolic-full-name",
          "HEAD",
        ]),
      },
    );
    artifacts.push(workerArtifact, gitArtifact);
    await checkpoint(config.evidencePath, {
      phase: "worker_finished",
      attempt: JSON.parse(
        JSON.stringify({
          attempt,
          startedAt: attemptStartedAt,
          deadline,
          lifecycle: "cleanup_complete",
          workerArtifact,
          gitArtifact,
          worker,
        }),
      ) as never,
      ...(execution.protocol === undefined
        ? {}
        : {
            protocol: JSON.parse(JSON.stringify(execution.protocol)) as never,
          }),
    });

    const postHead = head(config.repositoryPath);
    const postStatus = status(config.repositoryPath);
    console.log(
      `[stage ${config.stage} attempt ${attempt}] worker.finished exit=${worker.exitCode} head=${postHead.slice(0, 8)} clean=${postStatus === ""}`,
    );

    // Check history even when the worker failed: retries must not adopt a rewrite.
    const historyFailure = historyProblem(
      config.repositoryPath,
      preHead,
      postHead,
      originalRef,
    );
    const problem =
      historyFailure ??
      workerProblem(
        worker.exitCode,
        worker.terminationReason,
        preHead,
        postHead,
        postStatus,
      );

    let verification: VerificationResult | undefined;
    let verifierIntegrityFailure = false;
    let failureReason = problem;
    if (problem === undefined) {
      console.log(
        `[stage ${config.stage} attempt ${attempt}] verification.started`,
      );
      await checkpoint(config.evidencePath, {
        phase: "verifying",
        candidateHead: postHead,
      });
      const verifierCommand = [...frozen.inputs.verifier.argv];
      const verificationStartedAt = now();
      verification = await runVerification(
        verifierCommand,
        config.repositoryPath,
        { ...process.env, SAMOVAR_BENCH_REPO: config.repositoryPath },
        10 * 60_000,
        await launchGuarded({
          lock,
          command: verifierCommand,
          cwd: config.repositoryPath,
          env: { ...process.env, SAMOVAR_BENCH_REPO: config.repositoryPath },
          controlPath: prefix + "-verification-guard",
        }),
      );
      const verificationFinishedAt = now();
      const headAfter = head(config.repositoryPath);
      const refAfter = runGit(config.repositoryPath, [
        "rev-parse",
        "--symbolic-full-name",
        "HEAD",
      ]);
      const statusAfter = status(config.repositoryPath);
      artifacts.push(
        await writeAttemptArtifact(
          config.evidencePath,
          attempt,
          "verification-output.txt",
          new TextEncoder().encode(verification.output),
        ),
      );
      const verificationArtifact = await writeAttemptArtifact(
        config.evidencePath,
        attempt,
        "verification.json",
        {
          version: 1,
          candidateHead: postHead,
          headAfter,
          refAfter,
          statusAfter,
          exitCode: verification.exitCode,
          timedOut: verification.timedOut,
          command: verifierCommand,
          startedAt: verificationStartedAt,
          finishedAt: verificationFinishedAt,
        },
      );
      artifacts.push(verificationArtifact);
      await checkpoint(config.evidencePath, {
        candidateHead: postHead,
        verification: { artifact: verificationArtifact as unknown as Json },
      });
      console.log(
        `[stage ${config.stage} attempt ${attempt}] verification.finished exit=${verification.exitCode}`,
      );

      if (verification.exitCode !== 0 || verification.timedOut) {
        failureReason = verification.timedOut
          ? "verifier timed out"
          : `verifier exited with code ${verification.exitCode}`;
      }
      const verifiedHead = headAfter;
      const verifiedStatus = statusAfter;
      if (
        verifiedHead !== postHead ||
        runGit(config.repositoryPath, [
          "rev-parse",
          "--symbolic-full-name",
          "HEAD",
        ]) !== originalRef
      ) {
        failureReason = "verifier changed HEAD after candidate inspection";
        verifierIntegrityFailure = true;
      } else if (verifiedStatus !== "") {
        failureReason = "verifier left a dirty worktree";
        verifierIntegrityFailure = true;
      }
      if (failureReason === undefined) {
        await checkpointCompletedAttempt(config.evidencePath, {
          attempt,
          artifacts,
          result: JSON.parse(
            JSON.stringify({
              accepted: true,
              attempt,
              startedAt: attemptStartedAt,
              finishedAt: verificationFinishedAt,
              preHead,
              postHead,
              postStatus,
              worker,
              protocol: execution.protocol ?? null,
              verification,
            }),
          ) as Record<string, Json>,
        });
        await checkpoint(config.evidencePath, {
          phase: "verified",
          candidateHead: postHead,
          verification: { artifact: verificationArtifact as unknown as Json },
        });
      }
    }

    let currentFailureReportPath: string | undefined;
    if (failureReason !== undefined) {
      currentFailureReportPath = prefix + "-failure.md";
      const report = failureReport(
        config,
        attempt,
        failureReason,
        verification,
        historyFailure !== undefined,
      );
      await writeFile(currentFailureReportPath, report);
      artifacts.push(
        await writeAttemptArtifact(
          config.evidencePath,
          attempt,
          "failure.md",
          new TextEncoder().encode(report),
        ),
      );
      failureReportPath = currentFailureReportPath;
      console.log(
        `[stage ${config.stage} attempt ${attempt}] attempt.failed reason=${failureReason}`,
      );
    }

    if (failureReason !== undefined)
      await checkpointCompletedAttempt(config.evidencePath, {
        attempt,
        artifacts,
        result: JSON.parse(
          JSON.stringify({
            accepted: false,
            failureReason,
            attempt,
            startedAt: attemptStartedAt,
            preHead,
            postHead,
            postStatus,
            worker,
            protocol: execution.protocol ?? null,
            verification: verification ?? null,
            failureReportPath: currentFailureReportPath ?? null,
          }),
        ) as Record<string, Json>,
      });
    attempts.push({
      attempt,
      startedAt: attemptStartedAt,
      finishedAt: now(),
      preHead,
      postHead,
      postStatus,
      worker,
      ...(execution.protocol === undefined
        ? {}
        : { protocol: execution.protocol }),
      ...(verification === undefined ? {} : { verification }),
      ...(currentFailureReportPath === undefined
        ? {}
        : { failureReportPath: currentFailureReportPath }),
    });

    if (failureReason === undefined) {
      const record: RunRecord = {
        runId: config.runId,
        stage: config.stage,
        repositoryPath: config.repositoryPath,
        planPath: config.planPath,
        startedAt,
        finishedAt: now(),
        status: "accepted",
        acceptedHead: postHead,
        attempts,
      };
      await commitAcceptedSummary(
        config.evidencePath,
        { ...(await readState(config.evidencePath)), candidateHead: postHead },
        record,
      );
      console.log(
        `[stage ${config.stage}] supervisor.accepted head=${postHead}`,
      );
      return record;
    }
    if (historyFailure !== undefined || verifierIntegrityFailure) {
      // Preserve the evidence and worktree for inspection; never reset or retry a rewrite.
      break;
    }
  }

  const record: RunRecord = {
    runId: config.runId,
    stage: config.stage,
    repositoryPath: config.repositoryPath,
    planPath: config.planPath,
    startedAt,
    finishedAt: now(),
    status: "failed",
    attempts,
  };
  const summaryAttempt = Math.max(1, frozen.reservedAttempts);
  const summaryArtifact = await writeAttemptArtifact(
    config.evidencePath,
    summaryAttempt,
    "run-summary.json",
    JSON.parse(JSON.stringify(record)) as Json,
  );
  await checkpoint(config.evidencePath, { phase: "failed", summaryArtifact });
  await writeRunSummary(
    config.evidencePath,
    JSON.parse(JSON.stringify(record)) as Json,
  );
  console.log(
    `[stage ${config.stage}] supervisor.failed attempts=${attempts.length}`,
  );
  return record;
}
