import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFrozenChain,
  parseRunManifest,
  resumeManifest,
  runManifest,
} from "../src/chain.js";
import type { ChainState } from "../src/types.js";

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
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr));
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
send({'jsonrpc':'2.0','id':session['id'],'result':{'sessionId':'chain'}})
prompt = receive()
brief = '\\n'.join(part.get('text','') for part in prompt['params']['prompt'] if isinstance(part, dict))
report = re.search(r'^Report: (\\S+)$', brief, re.M).group(1)
`;

const AGENT_WORK = `import subprocess
name = re.search(r'write (\\S+)', brief).group(1)
open(repo + '/' + name, 'w').write('ok\\n')
open(report, 'w').write(json.dumps({'version':1,'status':'complete','summary':'wrote '+name,'knownGaps':[],'decisions':[],'validation':['verifier']}))
subprocess.run(['git','add','-A'], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run(['git','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','write '+name], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`;

const AGENT_EPILOGUE = `send({'jsonrpc':'2.0','id':prompt['id'],'result':{'stopReason':'end_turn'}})
while sys.stdin.readline(): pass
`;

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly manifest: string;
  readonly evidence: string;
}

async function fixture(stageIds: ReadonlyArray<string> = ["s1", "s2"]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "diriger-chain-"));
  roots.push(root);
  const repository = join(root, "repo");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "baseline\n");
  git(repository, ["init", "-b", "main"]);
  git(repository, ["add", "."]);
  git(repository, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "baseline",
  ]);
  const agent = join(root, "agent.py");
  await writeFile(agent, AGENT_PREAMBLE + AGENT_WORK + AGENT_EPILOGUE);
  await chmod(agent, 0o755);
  await writeFile(
    join(root, "worker.md"),
    "{{ plan }}\nStage: {{ stage }}\nReport: {{ worker_report_path }}\n{{ worker_judgment }}\n",
  );
  const stages = [];
  let index = 1;
  const expected: string[] = [];
  for (const id of stageIds) {
    const file = `${index}.txt`;
    expected.push(file);
    const verifier = join(root, `${id}.verify`);
    await writeFile(join(root, `${id}.md`), `write ${file}\n`);
    await writeFile(
      verifier,
      `#!/usr/bin/env bash\nset -euo pipefail\n` +
        expected
          .map((name) => `test -f "$SAMOVAR_BENCH_REPO/${name}"\n`)
          .join(""),
    );
    await chmod(verifier, 0o755);
    stages.push({ id, plan: `${id}.md`, verifier: `${id}.verify` });
    index += 1;
  }
  const evidence = join(root, "evidence");
  const manifest = join(root, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 2,
      chain: "two-stage",
      repository: "repo",
      evidence: "evidence",
      prompt: "worker.md",
      worker: { command: ["python3", agent] },
      defaults: {
        maxAttempts: 1,
        workerTimeoutSeconds: 10,
        noToolTimeoutSeconds: 10,
        noToolOutputBytes: 1_000_000,
        maxToolCalls: 100,
        toolCallCushion: 0,
      },
      stages,
    }),
  );
  return { root, repository, manifest, evidence };
}

async function run(f: Fixture): Promise<ChainState> {
  return await runManifest(await parseRunManifest(f.manifest));
}

describe("manifest-driven chain", () => {
  test("runs sequential stages and hands off the accepted commit", async () => {
    const f = await fixture();
    const state = await run(f);
    expect(state.outcome).toBe("accepted");
    expect(state.stages.map((stage) => stage.status)).toEqual([
      "accepted",
      "accepted",
    ]);
    const s1 = state.stages[0]!;
    const s2 = state.stages[1]!;
    expect(s1.commit).toBeDefined();
    expect(s2.commit).toBeDefined();
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        f.repository,
        "merge-base",
        "--is-ancestor",
        s1.commit!,
        s2.commit!,
      ]).exitCode,
    ).toBe(0);
    const second = JSON.parse(
      await readFile(
        join(f.evidence, "stages", "s2", "inputs", "config.frozen.json"),
        "utf8",
      ),
    ) as { previousStageCommit?: string; previousStageReportPath?: string };
    expect(second.previousStageCommit).toBe(s1.commit);
    expect(second.previousStageReportPath).toContain("worker-report.json");
    expect(
      await Bun.file(second.previousStageReportPath!).exists(),
    ).toBeTrue();
    expect(
      await Bun.file(join(f.evidence, "stages", "s1", "run.json")).exists(),
    ).toBeTrue();
  }, 30_000);

  test("a one-stage manifest is the trivial chain case", async () => {
    const f = await fixture(["only"]);
    const state = await run(f);
    expect(state.outcome).toBe("accepted");
    expect(state.stages).toHaveLength(1);
    expect(
      await Bun.file(join(f.evidence, "chain", "state.json")).exists(),
    ).toBeTrue();
    expect(
      await Bun.file(join(f.evidence, "stages", "only", "run.json")).exists(),
    ).toBeTrue();
  }, 20_000);

  test("a v3 checks manifest runs the checks entry and is accepted", async () => {
    const f = await fixture(["only"]);
    const raw = JSON.parse(await readFile(f.manifest, "utf8")) as {
      version: number;
      stages: ReadonlyArray<Record<string, unknown>>;
    };
    raw.version = 3;
    raw.stages = raw.stages.map((stage) => ({
      id: stage.id,
      plan: stage.plan,
      checks: stage.verifier,
    }));
    await writeFile(f.manifest, JSON.stringify(raw));
    const state = await run(f);
    expect(state.outcome).toBe("accepted");
    expect(state.stages[0]!.status).toBe("accepted");
  }, 20_000);

  test("refuses to reuse an existing evidence directory", async () => {
    const f = await fixture(["only"]);
    await run(f);
    const manifest = await parseRunManifest(f.manifest);
    await expect(runManifest(manifest)).rejects.toThrow(
      "evidence directory already exists",
    );
  }, 20_000);

  test("resume starts every pending stage from a frozen chain", async () => {
    const f = await fixture();
    const manifest = await parseRunManifest(f.manifest);
    await createFrozenChain(manifest);
    const state = await resumeManifest(f.evidence);
    expect(state.outcome).toBe("accepted");
    expect(state.stages.map((stage) => stage.status)).toEqual([
      "accepted",
      "accepted",
    ]);
  }, 30_000);

  test("resume keeps accepted stages without re-running a worker", async () => {
    const f = await fixture();
    const first = await run(f);
    const state = await resumeManifest(f.evidence);
    expect(state.outcome).toBe("accepted");
    expect(state.stages).toEqual(first.stages);
  }, 20_000);
});
