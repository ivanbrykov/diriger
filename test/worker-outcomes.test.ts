import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeSupervision, supervise } from "../src/supervisor.js";
import { checkpoint, createFrozenRun, readState, reserveAttempt } from "../src/state.js";
import type { SupervisorConfig } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
function git(repo: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-outcome-")); roots.push(root);
  const repo = join(root, "repo"), evidence = join(root, "evidence"), plan = join(root, "plan.md"), verifier = join(root, "verify"), agent = join(root, "agent.py"), prompt = join(root, "worker.md"), marker = join(root, "verified");
  await mkdir(repo); await writeFile(join(repo, "README.md"), "base\n"); await writeFile(plan, "do work\n");
  await writeFile(prompt, "{{ plan }}\nRepository: {{ repository_path }}\nStage: {{ stage }}\nAttempt: {{ attempt }}\nFailure report: {{ failure_report_path }}\nReport: {{ worker_report_path }}\n{{ worker_judgment }}\n");
  await writeFile(verifier, "#!/usr/bin/env bash\nset -eu\ntest -f \"$SAMOVAR_BENCH_REPO/result.txt\"\n"); await chmod(verifier, 0o755);
  git(repo, ["init", "-q", "-b", "main"]); git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.invalid"]); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
  const config: SupervisorConfig = { repositoryPath: repo, planPath: plan, stage: "outcome", verifierPath: verifier, promptPath: prompt, evidencePath: evidence, acpCommand: ["python3", agent], workerReportRequired: true, maxAttempts: 2, workerTimeoutMs: 5_000, noToolTimeoutMs: 5_000, noToolOutputBytes: 100_000, maxToolCalls: 100, maxToolRepetitions: 8, runId: "outcome-test" };
  return { root, repo, evidence, plan, verifier, agent, prompt, marker, config };
}
async function acpWorker(path: string, report?: string) {
  const lines = [
    "#!/usr/bin/env python3",
    "import json, re, subprocess, sys",
    "def receive():",
    "    line = sys.stdin.readline()",
    "    if not line: sys.exit(1)",
    "    return json.loads(line)",
    "def send(value):",
    "    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\\n')",
    "    sys.stdout.flush()",
    "init = receive()",
    "send({'jsonrpc':'2.0','id':init['id'],'result':{'protocolVersion':1}})",
    "session = receive()",
    "repo = session['params']['cwd']",
    "send({'jsonrpc':'2.0','id':session['id'],'result':{'sessionId':'outcome'}})",
    "prompt = receive()",
    "brief = '\\n'.join(part.get('text','') for part in prompt['params']['prompt'] if isinstance(part, dict))",
  ];
  if (report !== undefined) {
    lines.push(
      "match = re.search(r'^Report: (\\S+)$', brief, re.M)",
      "if not match: raise RuntimeError('worker report path absent from prompt: ' + brief)",
      `open(match.group(1), 'w', encoding='utf-8').write(r'''${report}''' + '\\n')`,
    );
  }
  lines.push(
    "open(repo + '/result.txt', 'w').write('done\\n')",
    "subprocess.run(['git', 'add', 'result.txt'], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    "subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'worker'], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    "send({'jsonrpc':'2.0','id':prompt['id'],'result':{'stopReason':'end_turn'}})",
    "while sys.stdin.readline(): pass",
  );
  await writeFile(path, lines.join("\n") + "\n"); await chmod(path, 0o755);
}

test("a blocked worker produces a durable terminal outcome without verifier or retry", async () => {
  const f = await fixture();
  await acpWorker(f.agent, '{"version":1,"status":"blocked","summary":"need a choice","knownGaps":[],"decisions":[],"validation":[],"blocker":{"assumption":"two APIs","evidence":["callers disagree"],"attemptedApproaches":["inspected callers"],"smallestAlternative":"choose one","decisionNeeded":"select API"}}');
  await writeFile(f.verifier, `#!/usr/bin/env bash\nset -eu\ntouch ${f.marker}\n`); await chmod(f.verifier, 0o755);
  const record = await supervise(f.config);
  expect(record.status).toBe("task-blocked"); expect(record.attempts).toHaveLength(1); expect(record.attempts[0]?.workerReport?.status).toBe("blocked"); expect(await Bun.file(f.marker).exists()).toBeFalse(); expect((await readState(f.evidence)).phase).toBe("task_blocked"); expect((await resumeSupervision(f.evidence)).status).toBe("task-blocked");
  expect(Bun.spawnSync([process.execPath, "src/cli.ts", "status", "--evidence", f.evidence], { cwd: process.cwd() }).exitCode).toBe(4);
  expect(Bun.spawnSync([process.execPath, "src/cli.ts", "resume", "--evidence", f.evidence], { cwd: process.cwd() }).exitCode).toBe(4);
}, 10_000);

test("a complete gap-free report permits normal acceptance", async () => {
  const f = await fixture();
  await acpWorker(f.agent, '{"version":1,"status":"complete","summary":"done","knownGaps":[],"decisions":[],"validation":["verifier"]}');
  const record = await supervise(f.config);
  expect(record.status).toBe("accepted"); expect(record.attempts[0]?.workerReport?.status).toBe("complete"); expect((await readState(f.evidence)).phase).toBe("accepted");
}, 10_000);

test("complete report known gaps vetoes a green verifier before acceptance", async () => {
  const f = await fixture(); await acpWorker(f.agent, '{"version":1,"status":"complete","summary":"partial","knownGaps":["missing migration"],"decisions":[],"validation":["unit test"]}');
  await writeFile(f.verifier, `#!/usr/bin/env bash\nset -eu\ntouch ${f.marker}\ntest "$(cat "$SAMOVAR_BENCH_REPO/result.txt")" = done\n`); await chmod(f.verifier, 0o755);
  const record = await supervise(f.config);
  expect(record.status).toBe("task-blocked"); expect(await Bun.file(f.marker).exists()).toBeTrue(); expect((await readState(f.evidence)).phase).toBe("task_blocked"); expect(record.attempts[0]?.verification?.exitCode).toBe(0);
}, 10_000);

test("missing required report is never accepted", async () => {
  const f = await fixture(); await acpWorker(f.agent); const record = await supervise(f.config);
  expect(record.status).toBe("failed"); expect(record.attempts[0]?.verification).toBeUndefined(); expect((await readState(f.evidence)).phase).toBe("failed");
}, 10_000);

test("recovery preserves a blocked snapshot written before its state reference", async () => {
  const f = await fixture(), initial = { head: git(f.repo, ["rev-parse", "HEAD"]), ref: git(f.repo, ["rev-parse", "--symbolic-full-name", "HEAD"]), worktree: f.repo };
  await createFrozenRun({ evidencePath: f.evidence, runId: f.config.runId, resolvedConfig: f.config as unknown as import("../src/state.js").Json, initial, planPath: f.plan, promptPath: f.prompt, verifier: { argv: [f.verifier], cwd: f.repo, entryPath: f.verifier, selfContained: true } });
  await reserveAttempt(f.evidence, { startedAt: "2026-01-01T00:00:00.000Z" }); await checkpoint(f.evidence, { phase: "worker_running" });
  await writeFile(join(f.evidence, "attempt-1-report.json"), JSON.stringify({ version: 1, status: "blocked", summary: "need a choice", knownGaps: [], decisions: [], validation: [], blocker: { assumption: "two contracts", evidence: ["callers differ"], attemptedApproaches: ["inspected callers"], smallestAlternative: "select one", decisionNeeded: "choose contract" } }));
  await checkpoint(f.evidence, { phase: "worker_finished", attempt: { attempt: 1, worker: { exitCode: 0 } } });
  const record = await resumeSupervision(f.evidence);
  expect(record.status).toBe("task-blocked"); expect(record.attempts[0]?.workerReport?.blocker?.decisionNeeded).toBe("choose contract"); expect((await readState(f.evidence)).phase).toBe("task_blocked");
}, 10_000);

async function interruptedReport(report: Record<string, import("../src/state.js").Json>, durable: boolean, completed: boolean) {
  const f = await fixture();
  const initial = { head: git(f.repo, ["rev-parse", "HEAD"]), ref: git(f.repo, ["rev-parse", "--symbolic-full-name", "HEAD"]), worktree: f.repo };
  await createFrozenRun({ evidencePath: f.evidence, runId: f.config.runId, resolvedConfig: f.config as unknown as import("../src/state.js").Json, initial, planPath: f.plan, promptPath: f.prompt, verifier: { argv: [f.verifier], cwd: f.repo, entryPath: f.verifier, selfContained: true } });
  await reserveAttempt(f.evidence, { startedAt: new Date().toISOString() });
  await checkpoint(f.evidence, { phase: "worker_running" });
  const { writeAttemptArtifact } = await import("../src/state.js");
  const artifact = durable ? await writeAttemptArtifact(f.evidence, 1, "worker-report.json", report) : undefined;
  if (!durable) await writeFile(join(f.evidence, "attempt-1-report.json"), JSON.stringify(report));
  if (completed || artifact) await checkpoint(f.evidence, { phase: completed ? "worker_finished" : "worker_running", attempt: { attempt: 1, ...(completed ? { worker: { exitCode: 0 } } : {}), ...(artifact ? { workerReportArtifact: artifact as unknown as import("../src/state.js").Json } : {}) } });
  return { ...f, artifact };
}
const vetoReport = { version: 1, status: "blocked", summary: "caller decision needed", knownGaps: [], decisions: [], validation: [], blocker: { assumption: "unsupported API", evidence: ["minimal reproduction"], attemptedApproaches: ["checked runtime"], smallestAlternative: "native capability", decisionNeeded: "choose contract" } };

test("pending veto without durable worker completion cannot trigger a fresh attempt", async () => {
  const f = await interruptedReport(vetoReport, false, false);
  const { reconcileRun } = await import("../src/reconciliation.js");
  const decision = await reconcileRun(f.evidence, await readState(f.evidence), 2);
  expect(decision.action).toBe("blocked"); expect(decision.reason).toContain("not durably proven");
  expect(Bun.spawnSync([process.execPath, "src/cli.ts", "status", "--evidence", f.evidence], { cwd: process.cwd() }).exitCode).toBe(3);
  await expect(resumeSupervision(f.evidence)).rejects.toThrow();
  expect((await readState(f.evidence)).reservedAttempts).toBe(1);
});
test("referenced report corruption blocks recovery rather than retrying", async () => {
  const f = await interruptedReport(vetoReport, true, true);
  const path = join(f.evidence, f.artifact!.path); await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({ ...vetoReport, summary: "altered report" }));
  const { reconcileRun } = await import("../src/reconciliation.js");
  expect((await reconcileRun(f.evidence, await readState(f.evidence), 2)).action).toBe("blocked");
});
test("known gaps cannot mask verifier candidate drift", async () => {
  const f = await interruptedReport({ version: 1, status: "complete", summary: "done with gap", knownGaps: ["smoke incomplete"], decisions: [], validation: [] }, true, true);
  await writeFile(join(f.repo, "result.txt"), "candidate"); git(f.repo, ["add", "."]); git(f.repo, ["commit", "-qm", "candidate"]);
  await checkpoint(f.evidence, { phase: "verifying", candidateHead: git(f.repo, ["rev-parse", "HEAD"]) });
  await writeFile(join(f.repo, "result.txt"), "verifier drift");
  const { reconcileRun } = await import("../src/reconciliation.js");
  expect((await reconcileRun(f.evidence, await readState(f.evidence), 2)).reason).toBe("verifier candidate drift");
});
