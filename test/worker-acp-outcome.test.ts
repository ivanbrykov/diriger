import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervise } from "../src/supervisor.js";
import { readState } from "../src/state.js";
import type { SupervisorConfig } from "../src/types.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function git(repo: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

test("a supervised ACP blocked report is terminal without verifier or a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-worker-outcome-"));
  roots.push(root);
  const repo = join(root, "repo"), evidence = join(root, "evidence"), plan = join(root, "plan.md"), verifier = join(root, "verify"), agent = join(root, "agent.py"), marker = join(root, "verifier-ran");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "base\n");
  await writeFile(plan, "resolve the contract\n");
  await writeFile(verifier, `#!/usr/bin/env bash\nset -eu\ntouch ${marker}\n`);
  await chmod(verifier, 0o755);
  await writeFile(agent, [
    "#!/usr/bin/env python3",
    "import json, re, sys",
    "def receive():",
    "    line = sys.stdin.readline()",
    "    if not line: raise RuntimeError('missing client request')",
    "    return json.loads(line)",
    "def send(value):",
    "    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\\n')",
    "    sys.stdout.flush()",
    "initial = receive()",
    "send({'jsonrpc':'2.0','id':initial['id'],'result':{'protocolVersion':1}})",
    "session = receive()",
    "send({'jsonrpc':'2.0','id':session['id'],'result':{'sessionId':'worker-outcome'}})",
    "prompt = receive()",
    "brief = '\\n'.join(part.get('text', '') for part in prompt['params']['prompt'] if isinstance(part, dict))",
    "match = re.search(r'(/[^\\s\"\\\\]+-report\\.json)', brief)",
    "if not match: raise RuntimeError('worker report path absent from prompt: ' + brief)",
    "with open(match.group(1), 'w', encoding='utf-8') as report:",
    "    json.dump({'version':1,'status':'blocked','summary':'contract decision required','knownGaps':[],'decisions':['deferred incompatible API choice'],'validation':['inspected both callers'],'blocker':{'assumption':'either API is safe','evidence':['callers require incompatible shapes'],'attemptedApproaches':['traced both callers'],'smallestAlternative':'choose one API contract','decisionNeeded':'select the supported API contract'}}, report)",
    "send({'jsonrpc':'2.0','id':prompt['id'],'result':{'stopReason':'end_turn'}})",
    "while sys.stdin.readline(): pass",
  ].join("\n") + "\n");
  await chmod(agent, 0o755);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const config: SupervisorConfig = {
    repositoryPath: repo,
    planPath: plan,
    stage: "acp-outcome",
    verifierPath: verifier,
    evidencePath: evidence,
    gooseBin: "goose",
    workerKind: "acp",
    acpCommand: ["python3", agent],
    workerReportRequired: true,
    maxAttempts: 2,
    workerTimeoutMs: 10_000,
    noToolTimeoutMs: 5_000,
    noToolOutputBytes: 100_000,
    runId: "acp-outcome",
  };
  const record = await supervise(config);
  expect(record.status).toBe("task-blocked");
  expect(record.attempts).toHaveLength(1);
  expect(record.attempts[0]?.workerReport?.status).toBe("blocked");
  expect(await Bun.file(marker).exists()).toBeFalse();
  expect((await readState(evidence)).phase).toBe("task_blocked");
}, 30_000);
