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
    const process = Bun.spawn(
      [
        processExecPath(),
        cli,
        "run",
        "--repo",
        config.repositoryPath,
        "--plan",
        config.planPath,
        "--stage",
        config.stage,
        "--verifier",
        config.verifierPath,
        "--acp-command",
        JSON.stringify(["python3", agent]),
        "--prompt",
        config.promptPath,
        "--evidence",
        config.evidencePath,
        "--max-attempts",
        "1",
        "--run-id",
        "fake-cli-failure",
      ],
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
    await writeFile(config.verifierPath, "#!/usr/bin/env bash\nexit 99\n");
    await chmod(config.verifierPath, 0o755);
    const state = await readState(config.evidencePath);
    expect(
      await readFile(
        join(config.evidencePath, state.inputs.verifier.entry.path),
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
