import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeSupervision } from "../src/supervisor.js";
import {
  checkpoint,
  checkpointCompletedAttempt,
  createFrozenRun,
  readState,
  reserveAttempt,
  writeAttemptArtifact,
} from "../src/state.js";
import type { RunRecord, SupervisorConfig } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(repo: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture(workerReportRequired: boolean) {
  const root = await mkdtemp(join(tmpdir(), "diriger-summary-crash-"));
  roots.push(root);
  const repo = join(root, "repo"), evidence = join(root, "evidence"), plan = join(root, "plan.md"), prompt = join(root, "worker.md"), verifier = join(root, "verify");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "base\n");
  await writeFile(plan, "work\n");
  await writeFile(prompt, "{{ plan }}\n{{ worker_judgment }}\n");
  await writeFile(verifier, "#!/usr/bin/env bash\nexit 0\n");
  await chmod(verifier, 0o755);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const config: SupervisorConfig = {
    repositoryPath: repo,
    planPath: plan,
    stage: "summary",
    verifierPath: verifier,
    promptPath: prompt,
    evidencePath: evidence,
    acpCommand: ["python3", join(root, "agent.py")],
    workerReportRequired,
    maxAttempts: 2,
    workerTimeoutMs: 5_000,
    noToolTimeoutMs: 5_000,
    noToolOutputBytes: 1_000,
    maxToolCalls: 100,
    maxToolRepetitions: 8,
    runId: workerReportRequired ? "blocked-summary" : "accepted-summary",
  };
  const initial = {
    head: git(repo, ["rev-parse", "HEAD"]),
    ref: git(repo, ["rev-parse", "--symbolic-full-name", "HEAD"]),
    worktree: repo,
  };
  await createFrozenRun({
    evidencePath: evidence,
    runId: config.runId,
    resolvedConfig: config as unknown as import("../src/state.js").Json,
    initial,
    planPath: plan,
    promptPath: prompt,
    verifier: { argv: [verifier], cwd: repo, entryPath: verifier, selfContained: true },
  });
  return { repo, evidence, config, initial };
}

test("resume adopts a pre-checkpoint accepted summary without changing its timestamps", async () => {
  const f = await fixture(false);
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, { phase: "worker_running" });
  await writeFile(join(f.repo, "result.txt"), "done\n");
  git(f.repo, ["add", "result.txt"]);
  git(f.repo, ["commit", "-qm", "candidate"]);
  const candidateHead = git(f.repo, ["rev-parse", "HEAD"]);
  const proof = await writeAttemptArtifact(f.evidence, 1, "verification.json", {
    version: 1,
    candidateHead,
    headAfter: candidateHead,
    refAfter: f.initial.ref,
    statusAfter: "",
    exitCode: 0,
    timedOut: false,
    command: ["verify"],
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
  });
  await checkpoint(f.evidence, { phase: "worker_finished", candidateHead });
  await checkpointCompletedAttempt(f.evidence, {
    attempt: 1,
    artifacts: [proof],
    result: {
      accepted: true,
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      preHead: f.initial.head,
      postHead: candidateHead,
      postStatus: "",
      worker: { exitCode: 0 },
    },
  });
  await checkpoint(f.evidence, { phase: "verifying", candidateHead });
  await checkpoint(f.evidence, {
    phase: "verified",
    candidateHead,
    verification: { artifact: proof as unknown as import("../src/state.js").Json },
  });
  const state = await readState(f.evidence);
  const saved: RunRecord = {
    runId: f.config.runId,
    stage: f.config.stage,
    repositoryPath: f.repo,
    planPath: f.config.planPath,
    startedAt: (await readState(f.evidence)).startedAt,
    finishedAt: "1999-01-01T00:00:01.000Z",
    status: "accepted",
    acceptedHead: candidateHead,
    attempts: [{
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "1999-01-01T00:00:01.000Z",
      preHead: f.initial.head,
      postHead: candidateHead,
      postStatus: "",
      worker: { exitCode: 0 },
    }],
  };
  const artifact = await writeAttemptArtifact(f.evidence, 1, "run-summary.json", saved as unknown as import("../src/state.js").Json);
  const bytes = await Bun.file(join(f.evidence, artifact.path)).arrayBuffer();
  expect(state.phase).toBe("verified");
  await chmod(join(f.evidence, artifact.path), 0o600);
  await writeFile(join(f.evidence, artifact.path), JSON.stringify({ ...saved, acceptedHead: f.initial.head }));
  await expect(resumeSupervision(f.evidence)).rejects.toThrow("summary evidence drift");
  expect((await readState(f.evidence)).phase).toBe("verified");
  await writeFile(join(f.evidence, artifact.path), new Uint8Array(bytes));
  expect(await resumeSupervision(f.evidence)).toEqual(saved);
  expect(await Bun.file(join(f.evidence, artifact.path)).arrayBuffer()).toEqual(bytes);
  expect((await readState(f.evidence)).phase).toBe("accepted");
  expect(await resumeSupervision(f.evidence)).toEqual(saved);
});

test("resume adopts a pre-checkpoint task-blocked summary without changing its timestamps", async () => {
  const f = await fixture(true);
  const report: import("../src/worker-report.js").WorkerReport = {
    version: 1,
    status: "blocked",
    summary: "caller decision needed",
    knownGaps: [],
    decisions: [],
    validation: [],
    blocker: {
      assumption: "contract is ambiguous",
      evidence: ["two callers conflict"],
      attemptedApproaches: ["inspected callers"],
      smallestAlternative: "choose one contract",
      decisionNeeded: "select contract",
    },
  };
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, { phase: "worker_running" });
  const reportArtifact = await writeAttemptArtifact(
    f.evidence,
    1,
    "worker-report.json",
    report as unknown as import("../src/state.js").Json,
  );
  await checkpoint(f.evidence, {
    phase: "worker_finished",
    attempt: { attempt: 1, worker: { exitCode: 0 }, workerReportArtifact: reportArtifact as unknown as import("../src/state.js").Json },
  });
  await checkpointCompletedAttempt(f.evidence, {
    attempt: 1,
    artifacts: [reportArtifact],
    result: {
      accepted: false,
      taskBlocked: true,
      blockageReason: report.blocker!.decisionNeeded,
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      preHead: f.initial.head,
      postHead: f.initial.head,
      postStatus: "",
      worker: { exitCode: 0 },
      workerReport: report as unknown as import("../src/state.js").Json,
    },
  });
  const saved: RunRecord = {
    runId: f.config.runId,
    stage: f.config.stage,
    repositoryPath: f.repo,
    planPath: f.config.planPath,
    startedAt: (await readState(f.evidence)).startedAt,
    finishedAt: "1999-01-01T00:00:01.000Z",
    status: "task-blocked",
    blockageReason: report.blocker!.decisionNeeded,
    attempts: [{
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "1999-01-01T00:00:01.000Z",
      preHead: f.initial.head,
      postHead: f.initial.head,
      postStatus: "",
      worker: { exitCode: 0 },
      workerReport: report,
    }],
  };
  const artifact = await writeAttemptArtifact(f.evidence, 1, "task-blocked-summary.json", saved as unknown as import("../src/state.js").Json);
  const bytes = await Bun.file(join(f.evidence, artifact.path)).arrayBuffer();
  expect(await resumeSupervision(f.evidence)).toEqual(saved);
  expect(await Bun.file(join(f.evidence, artifact.path)).arrayBuffer()).toEqual(bytes);
  expect((await readState(f.evidence)).phase).toBe("task_blocked");
  expect(await resumeSupervision(f.evidence)).toEqual(saved);
});
