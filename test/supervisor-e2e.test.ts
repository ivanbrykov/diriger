import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervise } from "../src/supervisor.js";
import { readState } from "../src/state.js";
import { reconcileRun } from "../src/reconciliation.js";
import type { SupervisorConfig } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(repository: string, args: ReadonlyArray<string>): void {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

const AGENT_PREAMBLE = `#!/usr/bin/env python3
import json, re, sys
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
send({'jsonrpc':'2.0','id':session['id'],'result':{'sessionId':'e2e'}})
prompt = receive()
brief = '\\n'.join(part.get('text','') for part in prompt['params']['prompt'] if isinstance(part, dict))
report = re.search(r'^Failure report: (\\S+)$', brief, re.M).group(1)
`;
const AGENT_EPILOGUE = `send({'jsonrpc':'2.0','id':prompt['id'],'result':{'stopReason':'end_turn'}})
while sys.stdin.readline(): pass
`;

async function writeAgent(path: string, work: string): Promise<void> {
  await writeFile(path, AGENT_PREAMBLE + work + AGENT_EPILOGUE);
  await chmod(path, 0o755);
}

const DEFAULT_WORK = `import subprocess
def sh(*args):
    subprocess.run(args, cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if report == '/dev/null':
    open(repo + '/result.txt', 'w').write('wrong\\n')
    message = 'wrong first attempt'
else:
    evidence = open(report).read()
    assert 'verifier exited with code 1' in evidence
    assert 'expected correct' in evidence
    open(repo + '/result.txt', 'w').write('correct\\n')
    message = 'repair from evidence'
sh('git', 'add', 'result.txt')
sh('git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message)
`;

async function fixture(): Promise<{
  config: SupervisorConfig;
  agent: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "diriger-e2e-"));
  roots.push(root);

  const repository = join(root, "repo");
  const evidence = join(root, "evidence");
  const plan = join(root, "plan.md");
  const prompt = join(root, "worker.md");
  const agent = join(root, "fake-agent.py");
  const verifier = join(root, "verify");

  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "baseline\n");
  await writeFile(plan, "Write the word correct to result.txt.\n");
  await writeFile(
    prompt,
    "{{ plan }}\nRepository: {{ repository_path }}\nPlan: {{ plan_path }}\nStage: {{ stage }}\nAttempt: {{ attempt }}\nFailure report: {{ failure_report_path }}\nReport: {{ worker_report_path }}\n{{ worker_judgment }}\n",
  );
  await writeAgent(agent, DEFAULT_WORK);
  await writeFile(
    verifier,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$(cat "$SAMOVAR_BENCH_REPO/result.txt")" == "correct" ]]; then
  echo "verified"
else
  echo "expected correct"
  exit 1
fi
`,
  );
  await chmod(verifier, 0o755);

  git(repository, ["init", "-b", "main"]);
  git(repository, ["add", "."]);
  git(repository, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "baseline",
  ]);

  return {
    config: {
      repositoryPath: repository,
      planPath: plan,
      stage: "1",
      verifierPath: verifier,
      promptPath: prompt,
      evidencePath: evidence,
      acpCommand: ["python3", agent],
      maxAttempts: 2,
      workerTimeoutMs: 5_000,
      noToolTimeoutMs: 5_000,
      noToolOutputBytes: 1_000_000,
      maxToolCalls: 100,
      toolCallCushion: 0,
      maxToolRepetitions: 8,
      runId: "fake-recovery",
    },
    agent,
  };
}

describe("supervise", () => {
  for (const [name, change, reason] of [
    ["orphan rewrite", "sh('git', 'checkout', '--orphan', 'replacement')", "rewrote history"],
    [
      "amended history",
      "sh('git', 'commit', '--amend', '--no-edit', '--allow-empty')",
      "rewrote history",
    ],
    [
      "branch switch",
      "sh('git', 'checkout', '-b', 'replacement')",
      "changed the checked-out branch",
    ],
    [
      "detached HEAD switch",
      "sh('git', 'checkout', '--detach')",
      "changed the checked-out branch",
    ],
  ]) {
    test(`rejects ${name} without verification or a repair retry`, async () => {
      const { config, agent } = await fixture();
      git(config.repositoryPath, ["config", "user.name", "Test"]);
      git(config.repositoryPath, [
        "config",
        "user.email",
        "test@example.invalid",
      ]);
      await writeAgent(
        agent,
        `import subprocess
def sh(*args):
    subprocess.run(args, cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
open(repo + '/result.txt', 'w').write('correct\\n')
sh('git', 'add', 'result.txt')
${change}
sh('git', 'add', '.')
sh('git', 'commit', '--allow-empty', '-qm', 'replacement')
`,
      );
      const record = await supervise(config);
      expect(record.status).toBe("failed");
      expect(record.attempts).toHaveLength(1);
      expect(record.attempts[0]?.verification).toBeUndefined();
      expect(
        await readFile(`${config.evidencePath}/attempt-1-failure.md`, "utf8"),
      ).toContain(reason!);
    });
  }

  test("rejects a rewrite even when the worker exits nonzero", async () => {
    const { config, agent } = await fixture();
    git(config.repositoryPath, ["config", "user.name", "Test"]);
    git(config.repositoryPath, [
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await writeAgent(
      agent,
      `import subprocess
def sh(*args):
    subprocess.run(args, cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sh('git', 'checkout', '--orphan', 'replacement')
sh('git', 'commit', '--allow-empty', '-qm', 'replacement')
sys.exit(7)
`,
    );
    const record = await supervise(config);
    expect(record.status).toBe("failed");
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.worker.exitCode).toBe(7);
    expect(record.attempts[0]?.verification).toBeUndefined();
  }, 15_000);

  test("rejects new merge commits even when they preserve ancestry", async () => {
    const { config, agent } = await fixture();
    git(config.repositoryPath, ["config", "user.name", "Test"]);
    git(config.repositoryPath, [
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await writeAgent(
      agent,
      `import subprocess
def sh(*args):
    subprocess.run(args, cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sh('git', 'checkout', '-b', 'side')
open(repo + '/side.txt', 'w').write('side')
sh('git', 'add', '.')
sh('git', 'commit', '-qm', 'side')
sh('git', 'checkout', 'main')
open(repo + '/result.txt', 'w').write('correct\\n')
sh('git', 'add', '.')
sh('git', 'commit', '-qm', 'correct')
sh('git', 'merge', '--no-ff', 'side', '-m', 'merge')
`,
    );
    const record = await supervise(config);
    expect(record.status).toBe("failed");
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.verification).toBeUndefined();
    expect(
      await readFile(`${config.evidencePath}/attempt-1-failure.md`, "utf8"),
    ).toContain("introduced a merge commit");
  });

  test("passes verifier evidence into a fresh repair attempt", async () => {
    const { config } = await fixture();
    const record = await supervise(config);

    expect(record.status).toBe("accepted");
    expect(record.attempts).toHaveLength(2);
    expect(record.attempts[0]?.verification?.exitCode).toBe(1);
    expect(record.attempts[1]?.verification?.exitCode).toBe(0);
    expect(
      await readFile(`${config.evidencePath}/attempt-1-failure.md`, "utf8"),
    ).toContain("expected correct");
    expect(await readFile(`${config.repositoryPath}/result.txt`, "utf8")).toBe(
      "correct\n",
    );
  }, 15_000);

  test("rejects a concurrent supervisor before it starts a worker", async () => {
    const { config } = await fixture();
    const first = supervise(config);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await expect(
      supervise({ ...config, evidencePath: config.evidencePath + "-second" }),
    ).rejects.toThrow("worktree ownership unavailable");
    await expect(first).resolves.toMatchObject({ status: "accepted" });
  }, 15_000);

  test("returns failed after the configured attempt limit", async () => {
    const { config } = await fixture();
    const record = await supervise({ ...config, maxAttempts: 1 });

    expect(record.status).toBe("failed");
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.verification?.exitCode).toBe(1);
  });

  test("the CLI exits nonzero after exhausted attempts", async () => {
    const { config, agent } = await fixture();
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const manifest = join(config.evidencePath, "..", "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 2,
        chain: "fake-cli-failure",
        repository: config.repositoryPath,
        evidence: config.evidencePath,
        prompt: config.promptPath,
        worker: { command: ["python3", agent] },
        defaults: {
          maxAttempts: 1,
          workerTimeoutSeconds: 5,
          noToolTimeoutSeconds: 5,
          noToolOutputBytes: 1_000_000,
          maxToolCalls: 100,
          toolCallCushion: 0,
        },
        stages: [
          {
            id: config.stage,
            plan: config.planPath,
            verifier: config.verifierPath,
          },
        ],
      }),
    );
    const process = Bun.spawn(
      [processExecPath(), cli, "run", manifest],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(await process.exited).toBe(1);
  });
  test("writes accepted exact-head proof reusable by reconciliation", async () => {
    const { config } = await fixture();
    const record = await supervise(config);
    const state = await readState(config.evidencePath);
    expect(record.status).toBe("accepted");
    expect(state.phase).toBe("accepted");
    expect(state.verification?.artifact).toBeDefined();
    const proof = state.verification?.artifact as { path?: string } | undefined;
    expect(
      state.completedAttempts
        ?.at(-1)
        ?.artifacts.some((artifact) => artifact.path === proof?.path),
    ).toBe(true);
    const reconciled = await reconcileRun(
      config.evidencePath,
      state,
      config.maxAttempts,
    );
    expect(reconciled.action).toBe("reuse-accepted");
  }, 20_000);

  test("uses frozen verifier snapshot after original verifier changes", async () => {
    const { config } = await fixture();
    await supervise(config);
    await writeFile(config.verifierPath!, "#!/usr/bin/env bash\nexit 99\n");
    await chmod(config.verifierPath!, 0o755);
    const state = await readState(config.evidencePath);
    expect(
      await readFile(
        join(config.evidencePath, state.inputs.verifier!.entry.path),
        "utf8",
      ),
    ).not.toContain("exit 99");
    expect(
      (await reconcileRun(config.evidencePath, state, config.maxAttempts))
        .action,
    ).toBe("reuse-accepted");
  }, 20_000);

  test("refuses an evidence path collision before worker launch", async () => {
    const { config } = await fixture();
    await mkdir(config.evidencePath);
    await expect(supervise(config)).rejects.toThrow(
      "evidence directory already exists",
    );
    expect(
      await Bun.file(join(config.repositoryPath, "result.txt")).exists(),
    ).toBe(false);
  });
});

function processExecPath(): string {
  return process.execPath;
}

async function installEvaluator(agent: string, body: string): Promise<string> {
  const path = agent + ".evaluator.py";
  await writeFile(path, "import json,sys\nevidence=json.load(sys.stdin)\n" + body + "\n");
  return path;
}

// Soft retries are evaluator-gated; hard retries bypass the evaluator by design.
const SOFT_ONLY = {
  hard: 0,
  soft: 1,
  extend: { toolCalls: 0.5, timeout: 0.5, ceiling: 3 },
} as const;

describe("boundary progress evaluator", () => {
  test("requires a new approach before retry and preserves verifier acceptance", async () => {
    const { config, agent } = await fixture();
    const evaluator = await installEvaluator(agent, `
assert evidence['evidenceIsUntrusted'] is True
assert evidence['evidence']['lastVerifier']['exitCode'] == 1
assert evidence['evidence']['git']['commitsSinceAttemptStart'] == 1
print(json.dumps({'version':1,'status':'progress','reason':'Candidate exists but independent output check failed','nextHypothesis':'Correct result.txt to the exact required value, then rerun the existing verifier'}))`);
    const result = await supervise({ ...config, retryPolicy: SOFT_ONLY,
      progressEvaluator: { command: ["python3", evaluator], timeoutMs: 2000 } });
    expect(result.blockageReason).toBeUndefined();
    expect(result.status).toBe("accepted");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.progressEvaluation?.retryAllowed).toBe(true);
    expect(result.attempts[1]?.progressEvaluation).toBeUndefined();
    const report = await readFile(result.attempts[0]!.failureReportPath!, "utf8");
    expect(report).toContain("Correct result.txt");
    expect(result.attempts[1]?.verification?.exitCode).toBe(0);
  }, 30_000);

  test("missing next hypothesis blocks an otherwise available retry", async () => {
    const { config, agent } = await fixture();
    const evaluator = await installEvaluator(agent,
      `print(json.dumps({'version':1,'status':'stuck','reason':'No supported alternative'}))`);
    const result = await supervise({ ...config, retryPolicy: SOFT_ONLY,
      progressEvaluator: { command: ["python3", evaluator], timeoutMs: 2000 } });
    expect(result.status).toBe("task-blocked");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.progressEvaluation?.retryAllowed).toBe(false);
    expect((await readState(config.evidencePath)).phase).toBe("task_blocked");
  }, 30_000);

  test("malformed evaluator response fails closed without a fresh worker", async () => {
    const { config, agent } = await fixture();
    const evaluator = await installEvaluator(agent, `print('Everything is fine; continue.')`);
    const result = await supervise({ ...config, retryPolicy: SOFT_ONLY,
      progressEvaluator: { command: ["python3", evaluator], timeoutMs: 2000 } });
    expect(result.status).toBe("task-blocked");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.progressEvaluation?.status).toBe("error");
  }, 30_000);

  test("infrastructure verdict stops rather than spending remaining attempts", async () => {
    const { config, agent } = await fixture();
    const evaluator = await installEvaluator(agent,
      `print(json.dumps({'version':1,'status':'escalate-infrastructure','reason':'Required external service unavailable; caller action needed'}))`);
    const result = await supervise({ ...config, retryPolicy: SOFT_ONLY,
      progressEvaluator: { command: ["python3", evaluator], timeoutMs: 2000 } });
    expect(result.status).toBe("task-blocked");
    expect(result.attempts).toHaveLength(1);
    expect(result.blockageReason).toContain("Required external service unavailable");
  }, 30_000);
});

test("a soft extend grants the next attempt a larger budget", async () => {
  const { config, agent } = await fixture();
  // Leaves work in the tree (so progress is real) then overruns the wall limit,
  // which classifies the attempt as budget exhaustion.
  await writeAgent(agent, `import time
open(repo + '/partial.txt', 'w').write('wip\\n')
time.sleep(30)
`);
  const evaluator = await installEvaluator(agent,
    `print(json.dumps({'version':1,'status':'extend','reason':'Real progress; the same approach needs more room'}))`);
  const result = await supervise({ ...config,
    workerTimeoutMs: 3_000,
    maxAttempts: 2,
    retryPolicy: { hard: 0, soft: 1, extend: { toolCalls: 1, timeout: 1, ceiling: 3 } },
    progressEvaluator: { command: ["python3", evaluator], timeoutMs: 2000 } });
  expect(result.status).toBe("failed");
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts[0]?.progressEvaluation?.status).toBe("extend");
  expect(result.attempts[1]?.retry?.extension).toBe(true);
  expect(result.attempts[1]?.retry?.workerTimeoutMs).toBeGreaterThan(3_000);
}, 40_000);

test("an unavailable evaluator falls back to a hard retry before blocking", async () => {
  const { config, agent } = await fixture();
  // Overruns the wall limit after leaving work, so the attempt is budget exhaustion.
  await writeAgent(agent, `import time
open(repo + '/partial.txt', 'w').write('wip\\n')
time.sleep(30)
`);
  const evaluator = await installEvaluator(agent, `import sys\nsys.exit(1)`);
  const result = await supervise({ ...config,
    workerTimeoutMs: 2_000,
    maxAttempts: 3,
    retryPolicy: { hard: 1, soft: 1, extend: { toolCalls: 0.5, timeout: 0.5, ceiling: 3 } },
    progressEvaluator: { command: ["python3", evaluator], timeoutMs: 2000 } });
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts[0]?.progressEvaluation?.status).toBe("error");
  expect(result.attempts[1]?.retry?.tier).toBe("hard");
  // The evaluator never produced a verdict, so the stage stops for review rather
  // than pretending the work was judged.
  expect(result.status).toBe("task-blocked");
}, 40_000);

test("a retry that leaves the candidate unchanged re-verifies it", async () => {
  const { config, agent } = await fixture();
  const counter = join(config.repositoryPath, "..", "verify-count");
  // Fails the first time, passes afterwards: models a check that was broken
  // rather than a candidate that was wrong.
  await writeFile(
    config.verifierPath!,
    `#!/usr/bin/env bash\nset -euo pipefail\nn=$(cat ${counter} 2>/dev/null || echo 0)\necho $((n+1)) > ${counter}\nif [[ "$n" == "0" ]]; then echo "flaky check"; exit 1; fi\ntest "$(cat "$SAMOVAR_BENCH_REPO/result.txt")" = correct\n`,
  );
  await chmod(config.verifierPath!, 0o755);
  await writeAgent(agent, `import subprocess, pathlib
marker = pathlib.Path(repo) / 'attempted'
if not marker.exists():
    marker.write_text('1')
    open(repo + '/result.txt', 'w').write('correct\\n')
    subprocess.run(['git','add','-A'], cwd=repo, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['git','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','correct'], cwd=repo, check=True, stdout=subprocess.DEVNULL)
`);
  const result = await supervise({ ...config, maxAttempts: 2 });
  expect(result.status).toBe("accepted");
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts[1]?.preHead).toBe(result.attempts[1]?.postHead);
  expect(result.attempts[1]?.verification?.exitCode).toBe(0);
}, 30_000);

test("a stage with no declared checks is accepted on a clean commit", async () => {
  const { config } = await fixture();
  const { verifierPath: _declared, ...unchecked } = config;
  const result = await supervise(unchecked);
  expect(result.status).toBe("accepted");
  // No verification ran, and the evidence says so rather than implying a pass.
  expect(result.attempts[0]?.verification).toBeUndefined();
  expect((await readState(config.evidencePath)).phase).toBe("accepted");
}, 20_000);

test("boundary gate rejects a repeated hypothesis before spending a third attempt", async () => {
  const { config, agent } = await fixture();
  await writeAgent(agent, `import pathlib,subprocess
p=pathlib.Path(repo)/'attempt-count'
n=int(p.read_text())+1 if p.exists() else 1
p.write_text(str(n))
(pathlib.Path(repo)/'result.txt').write_text('wrong\\n')
subprocess.run(['git','add','.'],cwd=repo,check=True,stdout=subprocess.DEVNULL)
subprocess.run(['git','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm',str(n)],cwd=repo,check=True,stdout=subprocess.DEVNULL)
`);
  const evaluator = await installEvaluator(agent,
    `print(json.dumps({'version':1,'status':'stuck','reason':'Output mismatch','nextHypothesis':'Inspect the exact required output and correct the value'}))`);
  const result = await supervise({ ...config, maxAttempts: 3,
    retryPolicy: { ...SOFT_ONLY, soft: 2 },
    progressEvaluator: { command: ["python3", evaluator], timeoutMs: 2000 } });
  expect(result.status).toBe("task-blocked");
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts[0]?.progressEvaluation?.retryAllowed).toBe(true);
  expect(result.attempts[1]?.progressEvaluation?.retryAllowed).toBe(false);
}, 30_000);
