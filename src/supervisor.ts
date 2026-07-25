import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { runObservedProcess, runVerification } from "./process.js";
import type {
  AttemptRecord,
  RunRecord,
  SupervisorConfig,
  VerificationResult,
} from "./types.js";

const FAILURE_OUTPUT_LIMIT = 24_000;

function now(): string {
  return new Date().toISOString();
}

function runGit(repositoryPath: string, args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync(["git", "-C", repositoryPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
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
  return runGit(repositoryPath, [
    "log",
    "-5",
    "--format=%H %s",
  ]);
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
  await assertFile(config.workerRecipePath, "worker recipe");

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
    "Reproduce the failure, inspect any existing changes, implement the missing",
    "behavior, add a regression test, and finish with a clean new commit.",
    "",
  ].join("\n");
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

export async function supervise(config: SupervisorConfig): Promise<RunRecord> {
  await validateConfig(config);
  await mkdir(config.evidencePath, { recursive: true });

  const startedAt = now();
  const attempts: AttemptRecord[] = [];
  let failureReportPath = "/dev/null";

  console.log(
    `[stage ${config.stage}] supervisor.started run=${config.runId}`,
  );

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const attemptStartedAt = now();
    const preHead = head(config.repositoryPath);
    const prefix = `${config.evidencePath}/attempt-${attempt}`;

    console.log(
      `[stage ${config.stage} attempt ${attempt}] worker.started head=${preHead.slice(0, 8)}`,
    );

    const worker = await runObservedProcess({
      command: [
        config.gooseBin,
        "run",
        "--recipe",
        config.workerRecipePath,
        "--params",
        `repository_path=${config.repositoryPath}`,
        "--params",
        `plan_path=${config.planPath}`,
        "--params",
        `stage=${config.stage}`,
        "--params",
        `attempt=${attempt}`,
        "--params",
        `failure_report_path=${failureReportPath}`,
        "--name",
        `${config.runId}-stage-${config.stage}-attempt-${attempt}`,
        "--output-format",
        "stream-json",
        "--max-turns",
        "100",
        "--max-tool-repetitions",
        "8",
      ],
      cwd: config.repositoryPath,
      env: process.env,
      stdoutPath: `${prefix}-worker.stream.jsonl`,
      stderrPath: `${prefix}-worker.stderr.log`,
      timeoutMs: config.workerTimeoutMs,
      noToolTimeoutMs: config.noToolTimeoutMs,
      noToolOutputBytes: config.noToolOutputBytes,
      onTool: (tool) => {
        console.log(
          `[stage ${config.stage} attempt ${attempt}] worker.tool ${tool}`,
        );
      },
    });

    const postHead = head(config.repositoryPath);
    const postStatus = status(config.repositoryPath);
    console.log(
      `[stage ${config.stage} attempt ${attempt}] worker.finished exit=${worker.exitCode} head=${postHead.slice(0, 8)} clean=${postStatus === ""}`,
    );

    const problem = workerProblem(
      worker.exitCode,
      worker.terminationReason,
      preHead,
      postHead,
      postStatus,
    );

    let verification: VerificationResult | undefined;
    let failureReason = problem;
    if (problem === undefined) {
      console.log(
        `[stage ${config.stage} attempt ${attempt}] verification.started`,
      );
      verification = await runVerification(
        [config.verifierPath, config.stage],
        config.repositoryPath,
        {
          ...process.env,
          SAMOVAR_BENCH_REPO: config.repositoryPath,
        },
        10 * 60_000,
      );
      await writeFile(
        `${prefix}-verification.txt`,
        verification.output,
      );
      console.log(
        `[stage ${config.stage} attempt ${attempt}] verification.finished exit=${verification.exitCode}`,
      );

      if (verification.exitCode !== 0 || verification.timedOut) {
        failureReason = verification.timedOut
          ? "verifier timed out"
          : `verifier exited with code ${verification.exitCode}`;
      }
    }

    let currentFailureReportPath: string | undefined;
    if (failureReason !== undefined) {
      currentFailureReportPath = `${prefix}-failure.md`;
      await writeFile(
        currentFailureReportPath,
        failureReport(
          config,
          attempt,
          failureReason,
          verification,
        ),
      );
      failureReportPath = currentFailureReportPath;
      console.log(
        `[stage ${config.stage} attempt ${attempt}] attempt.failed reason=${failureReason}`,
      );
    }

    attempts.push({
      attempt,
      startedAt: attemptStartedAt,
      finishedAt: now(),
      preHead,
      postHead,
      postStatus,
      worker,
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
      await persistRun(config, record);
      console.log(
        `[stage ${config.stage}] supervisor.accepted head=${postHead}`,
      );
      return record;
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
  await persistRun(config, record);
  console.log(
    `[stage ${config.stage}] supervisor.failed attempts=${config.maxAttempts}`,
  );
  return record;
}

