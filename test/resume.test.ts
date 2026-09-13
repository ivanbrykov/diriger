import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResumeBlockedError,
  resumeSupervision,
  supervise,
} from "../src/supervisor.js";
import { captureWorkerProfile } from "../src/worker-profile.js";
import {
  checkpoint,
  checkpointCompletedAttempt,
  createFrozenRun,
  readState,
  reserveAttempt,
  writeAttemptArtifact,
} from "../src/state.js";
import type { SupervisorConfig } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(repo: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
async function lines(path: string): Promise<string[]> {
  return (await Bun.file(path).text()).trim().split("\n").filter(Boolean);
}

async function fixture(maxAttempts = 2) {
  const root = await mkdtemp(join(tmpdir(), "diriger-resume-"));
  roots.push(root);
  const repo = join(root, "repo"),
    evidence = join(root, "evidence"),
    plan = join(root, "plan.md"),
    prompt = join(root, "worker.md");
  const worker = join(root, "worker.py"),
    verifier = join(root, "verifier"),
    workerMarker = join(root, "worker.calls"),
    verifierMarker = join(root, "verifier.calls");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "base\n");
  await writeFile(plan, "make result\n");
  await writeFile(
    prompt,
    "{{ plan }}\nRepository: {{ repository_path }}\nStage: {{ stage }}\nAttempt: {{ attempt }}\nFailure report: {{ failure_report_path }}\nReport: {{ worker_report_path }}\n{{ worker_judgment }}\n",
  );
  await writeFile(
    worker,
    `#!/usr/bin/env python3
import json, re, subprocess, sys
def receive():
    line = sys.stdin.readline()
    if not line: sys.exit(1)
    return json.loads(line)
def send(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\\n')
    sys.stdout.flush()
init = receive()
send({'jsonrpc':'2.0','id':init['id'],'result':{'protocolVersion':1}})
session = receive()
repo = session['params']['cwd']
send({'jsonrpc':'2.0','id':session['id'],'result':{'sessionId':'resume'}})
prompt = receive()
brief = '\\n'.join(part.get('text','') for part in prompt['params']['prompt'] if isinstance(part, dict))
report = re.search(r'^Failure report: (\\S+)$', brief, re.M).group(1)
open(${JSON.stringify(workerMarker)}, 'a').write('worker:%s\\n' % report)
open(repo + '/result.txt', 'w').write('correct\\n')
subprocess.run(['git', 'add', 'result.txt'], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'worker'], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
send({'jsonrpc':'2.0','id':prompt['id'],'result':{'stopReason':'end_turn'}})
while sys.stdin.readline(): pass
`,
  );
  await writeFile(
    verifier,
    `#!/usr/bin/env bash
set -euo pipefail
grep -q '"phase": "verifying"' "${evidence}/state.json"
printf 'verifier\\n' >> "${verifierMarker}"
test "$(cat "$SAMOVAR_BENCH_REPO/result.txt")" = correct
`,
  );
  await chmod(worker, 0o755);
  await chmod(verifier, 0o755);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const config: SupervisorConfig = {
    repositoryPath: repo,
    planPath: plan,
    stage: "resume",
    verifierPath: verifier,
    promptPath: prompt,
    evidencePath: evidence,
    acpCommand: ["python3", worker],
    maxAttempts,
    workerTimeoutMs: 5_000,
    noToolTimeoutMs: 5_000,
    noToolOutputBytes: 100_000,
    maxToolCalls: 100,
    maxToolRepetitions: 8,
    runId: "resume-case",
  };
  return {
    root,
    repo,
    evidence,
    plan,
    prompt,
    worker,
    verifier,
    workerMarker,
    verifierMarker,
    config,
  };
}

async function frozen(
  f: Awaited<ReturnType<typeof fixture>>,
  withProfile = true,
  environment: NodeJS.ProcessEnv = process.env,
  profileVersion: 1 | 2 = 2,
) {
  const head = git(f.repo, ["rev-parse", "HEAD"]),
    ref = git(f.repo, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  const captured = withProfile
    ? await captureWorkerProfile(f.config, environment)
    : undefined;
  const profile =
    captured === undefined
      ? undefined
      : profileVersion === 2
        ? captured
        : (() => {
            const legacy = JSON.parse(JSON.stringify(captured)) as Record<
              string,
              unknown
            >;
            legacy.version = 1;
            delete legacy.openaiRoute;
            return legacy;
          })();
  return createFrozenRun({
    evidencePath: f.evidence,
    runId: f.config.runId,
    resolvedConfig: f.config as unknown as import("../src/state.js").Json,
    initial: { head, ref, worktree: f.repo },
    planPath: f.plan,
    promptPath: f.prompt,
    ...(profile === undefined
      ? {}
      : { profile: profile as import("../src/state.js").Json }),
    verifier: {
      argv: [f.verifier, f.config.stage],
      cwd: f.repo,
      entryPath: f.verifier,
      selfContained: true,
    },
  });
}
async function commitCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(f.repo, "result.txt"), "correct\n");
  git(f.repo, ["add", "result.txt"]);
  git(f.repo, ["commit", "-qm", "candidate"]);
  return git(f.repo, ["rev-parse", "HEAD"]);
}

async function verifiedCheckpoint(
  f: Awaited<ReturnType<typeof fixture>>,
  profileVersion: 1 | 2 = 2,
) {
  const initial = await frozen(f, true, process.env, profileVersion);
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, { phase: "worker_running" });
  const candidateHead = await commitCandidate(f);
  await checkpoint(f.evidence, { phase: "worker_finished", candidateHead });
  await checkpoint(f.evidence, { phase: "verifying" });
  const proof = await writeAttemptArtifact(f.evidence, 1, "verification.json", {
    version: 1,
    candidateHead,
    headAfter: candidateHead,
    refAfter: initial.initial.ref,
    statusAfter: "",
    exitCode: 0,
    timedOut: false,
    command: ["must-not-run"],
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
  });
  await checkpointCompletedAttempt(f.evidence, {
    attempt: 1,
    artifacts: [proof],
    result: {
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:02.000Z",
      preHead: initial.initial.head,
      postHead: candidateHead,
      postStatus: "",
      worker: { exitCode: 0 },
    },
  });
  await checkpoint(f.evidence, {
    phase: "verified",
    candidateHead,
    verification: {
      artifact: proof as unknown as import("../src/state.js").Json,
    },
  });
  return { initial, candidateHead };
}

test("an accepted run resumes without rerunning worker or verifier and preserves its record", async () => {
  const f = await fixture(1);
  const original = await supervise(f.config);
  const beforeState = await readState(f.evidence);
  const workers = await lines(f.workerMarker),
    verifiers = await lines(f.verifierMarker);
  const resumed = await resumeSupervision(f.evidence);
  const afterState = await readState(f.evidence);
  expect(resumed).toEqual(original);
  expect(await lines(f.workerMarker)).toEqual(workers);
  expect(await lines(f.verifierMarker)).toEqual(verifiers);
  expect(afterState.phase).toBe("accepted");
  expect(afterState.candidateHead).toBe(beforeState.candidateHead);
  expect(afterState.reservedAttempts).toBe(beforeState.reservedAttempts);
  expect(afterState.completedAttempts).toEqual(beforeState.completedAttempts);
  expect(afterState.startedAt).toBe(beforeState.startedAt);
});

test("accepted checkpoint reconstructs a missing run summary from immutable state", async () => {
  const f = await fixture(1);
  await supervise(f.config);
  await unlink(join(f.evidence, "run.json"));
  const resumed = await resumeSupervision(f.evidence);
  const summary = JSON.parse(
    await readFile(join(f.evidence, "run.json"), "utf8"),
  );
  expect(summary).toEqual(resumed);
  expect(resumed.status).toBe("accepted");
  expect(resumed.acceptedHead).toBe(git(f.repo, ["rev-parse", "HEAD"]));
});

test("a verified immutable proof is finalized without a model or verifier call", async () => {
  const f = await fixture();
  const { candidateHead } = await verifiedCheckpoint(f);
  const record = await resumeSupervision(f.evidence);
  expect(record.status).toBe("accepted");
  expect(record.acceptedHead).toBe(candidateHead);
  expect(await Bun.file(f.workerMarker).exists()).toBeFalse();
  expect(await Bun.file(f.verifierMarker).exists()).toBeFalse();
  expect((await readState(f.evidence)).phase).toBe("accepted");
});

test("a profile-less legacy state cannot launch a fresh worker on resume", async () => {
  const f = await fixture();
  await frozen(f, false);
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, { phase: "worker_running" });
  await expect(resumeSupervision(f.evidence)).rejects.toBeInstanceOf(
    ResumeBlockedError,
  );
  expect(await Bun.file(f.workerMarker).exists()).toBeFalse();
});

test("OpenAI host and path drift block a fresh repair before a worker starts", async () => {
  const f = await fixture();
  const originalHost = process.env.OPENAI_HOST;
  const originalPath = process.env.OPENAI_BASE_PATH;
  try {
    const pinned = {
      ...process.env,
      OPENAI_HOST: "http://route-one.invalid",
      OPENAI_BASE_PATH: "v1/chat/completions",
    };
    await frozen(f, true, pinned);
    await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
    await checkpoint(f.evidence, { phase: "worker_running" });
    process.env.OPENAI_HOST = "http://route-two.invalid";
    process.env.OPENAI_BASE_PATH = "v1/chat/completions";
    await expect(resumeSupervision(f.evidence)).rejects.toThrow(
      "worker runtime profile drift",
    );
    expect(await Bun.file(f.workerMarker).exists()).toBeFalse();
    process.env.OPENAI_HOST = "http://route-one.invalid";
    process.env.OPENAI_BASE_PATH = "v1/responses";
    await expect(resumeSupervision(f.evidence)).rejects.toThrow(
      "worker runtime profile drift",
    );
    expect(await Bun.file(f.workerMarker).exists()).toBeFalse();
  } finally {
    if (originalHost === undefined) delete process.env.OPENAI_HOST;
    else process.env.OPENAI_HOST = originalHost;
    if (originalPath === undefined) delete process.env.OPENAI_BASE_PATH;
    else process.env.OPENAI_BASE_PATH = originalPath;
  }
});

test("old route-unpinned profiles remain read-only on resume", async () => {
  const f = await fixture();
  await frozen(f, true, process.env, 1);
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, { phase: "worker_running" });
  await expect(resumeSupervision(f.evidence)).rejects.toThrow(
    "unsupported frozen runtime profile version",
  );
  expect(await Bun.file(f.workerMarker).exists()).toBeFalse();

  const accepted = await fixture();
  const { candidateHead } = await verifiedCheckpoint(accepted, 1);
  expect(candidateHead).toBeDefined();
  const record = await resumeSupervision(accepted.evidence);
  expect(record.status).toBe("accepted");
  expect((await resumeSupervision(accepted.evidence)).status).toBe("accepted");

  const verifierOnly = await fixture();
  await frozen(verifierOnly, true, process.env, 1);
  await reserveAttempt(verifierOnly.evidence, {
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  await checkpoint(verifierOnly.evidence, { phase: "worker_running" });
  await commitCandidate(verifierOnly);
  const verified = await resumeSupervision(verifierOnly.evidence);
  expect(verified.status).toBe("accepted");
  expect(await Bun.file(verifierOnly.workerMarker).exists()).toBeFalse();
  expect(await lines(verifierOnly.verifierMarker)).toEqual(["verifier"]);
});

test("accepted proof reuse does not validate the live worker profile", async () => {
  const f = await fixture(1);
  const originalHost = process.env.OPENAI_HOST;
  try {
    process.env.OPENAI_HOST = "http://route-one.invalid";
    await supervise(f.config);
    process.env.OPENAI_HOST = "http://route-two.invalid";
    const record = await resumeSupervision(f.evidence);
    expect(record.status).toBe("accepted");
    expect((await lines(f.workerMarker)).length).toBe(1);
  } finally {
    if (originalHost === undefined) delete process.env.OPENAI_HOST;
    else process.env.OPENAI_HOST = originalHost;
  }
});

test("a dirty interrupted worker is preserved and requests a fresh repair without consuming its attempt", async () => {
  const f = await fixture();
  await frozen(f);
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, {
    phase: "worker_running",
    attempt: {
      attempt: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      lifecycle: "authorized",
    },
  });
  await writeFile(join(f.repo, "interrupted.txt"), "do not erase\n");
  const before = await readState(f.evidence);
  const recovered = await resumeSupervision(f.evidence);
  expect(await Bun.file(join(f.repo, "interrupted.txt")).text()).toBe(
    "do not erase\n",
  );
  const after = await readState(f.evidence);
  expect(after.reservedAttempts).toBe(2);
  expect(after.reservedAttempts).toBe(before.reservedAttempts + 1);
  expect((await lines(f.workerMarker))[0]).not.toBe("worker:/dev/null");
  expect(recovered.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  expect(recovered.attempts[0]?.worker).toEqual({
    exitCode: -1,
    resultUnavailable: true,
  });

  const exhausted = await fixture(1);
  await frozen(exhausted);
  await reserveAttempt(exhausted.evidence, {
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  await checkpoint(exhausted.evidence, { phase: "worker_running" });
  await writeFile(join(exhausted.repo, "interrupted.txt"), "preserve\n");
  const terminal = await resumeSupervision(exhausted.evidence);
  expect(terminal.status).toBe("failed");
  expect(await Bun.file(exhausted.workerMarker).exists()).toBeFalse();
  expect(await Bun.file(exhausted.verifierMarker).exists()).toBeFalse();
  expect(await Bun.file(join(exhausted.repo, "interrupted.txt")).text()).toBe(
    "preserve\n",
  );
  expect((await readState(exhausted.evidence)).reservedAttempts).toBe(1);
});

test("a clean committed descendant with a missing worker result is frozen to verification and accepted with an explicit unknown exit", async () => {
  const f = await fixture();
  await frozen(f);
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, { phase: "worker_running" });
  const candidate = await commitCandidate(f);
  const record = await resumeSupervision(f.evidence);
  const state = await readState(f.evidence);
  expect(record.status).toBe("accepted");
  expect(record.acceptedHead).toBe(candidate);
  expect(record.attempts).toHaveLength(1);
  expect(record.attempts[0]?.worker).toEqual({
    exitCode: -1,
    resultUnavailable: true,
  });
  expect(await lines(f.verifierMarker)).toEqual(["verifier"]);
  expect(state.phase).toBe("accepted");
});

test("a failed resumed verifier stays unaccepted, does not loop, and frozen input or HEAD drift blocks recovery", async () => {
  const f = await fixture(1);
  await writeFile(f.verifier, "#!/usr/bin/env bash\nexit 1\n");
  await chmod(f.verifier, 0o755);
  await frozen(f);
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" });
  await checkpoint(f.evidence, { phase: "worker_running" });
  await commitCandidate(f);
  await checkpoint(f.evidence, {
    phase: "worker_finished",
    candidateHead: git(f.repo, ["rev-parse", "HEAD"]),
  });
  await checkpoint(f.evidence, { phase: "verifying" });
  await expect(resumeSupervision(f.evidence)).rejects.toThrow(
    "recovered verifier failed",
  );
  expect((await readState(f.evidence)).phase).toBe("verifying");
  await writeFile(join(f.repo, "drift"), "x\n");
  await expect(resumeSupervision(f.evidence)).rejects.toThrow(
    "verifier candidate drift",
  );
  expect((await readState(f.evidence)).phase).toBe("verifying");
  await rm(join(f.repo, "drift"));
  await writeFile(join(f.evidence, "inputs", "verifier-entry"), "tampered\n");
  await expect(resumeSupervision(f.evidence)).rejects.toThrow(
    "frozen input drift",
  );
});
