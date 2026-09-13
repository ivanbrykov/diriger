import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpAttemptExecutor } from "../src/attempt-executor.js";
import { OwnershipLock } from "../src/ownership.js";
import { launchGuarded } from "../src/guard.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function run(
  body: string,
  timeout = 200,
  lifecycle: string[] = [],
  watchdog = { timeoutMs: 200, textBytes: 256 },
  limits = { maxToolCalls: 100, maxToolRepetitions: 8 },
) {
  const root = await mkdtemp(join(tmpdir(), "acp-"));
  roots.push(root);
  const agent = join(root, "agent");
  await writeFile(join(root, "plan"), "do it");
  await writeFile(
    join(root, "prompt.md"),
    "{{ plan }}\nStage: {{ stage }}\nAttempt: {{ attempt }}\nRepository: {{ repository_path }}\nPlan: {{ plan_path }}\nFailure report: {{ failure_report_path }}\nReport: {{ worker_report_path }}\n{{ worker_judgment }}\n",
  );
  await writeFile(agent, "#!/usr/bin/env bash\n" + body);
  await chmod(agent, 0o755);
  return new AcpAttemptExecutor().execute({
    config: {
      repositoryPath: root,
      planPath: join(root, "plan"),
      stage: "1",
      verifierPath: join(root, "plan"),
      promptPath: join(root, "prompt.md"),
      evidencePath: root,
      acpCommand: [agent],
      workerTimeoutMs: timeout,
      noToolTimeoutMs: watchdog.timeoutMs,
      noToolOutputBytes: watchdog.textBytes,
      maxToolCalls: limits.maxToolCalls,
      maxToolRepetitions: limits.maxToolRepetitions,
      maxAttempts: 1,
      runId: "t",
    },
    attempt: 1,
    failureReportPath: "/dev/null",
    prefix: join(root, "a"),
    onLifecycle: async (state) => {
      lifecycle.push(state);
    },
  });
}
const good =
  'read a; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"result\\":{\\"protocolVersion\\":1}}"; read b; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":2,\\"result\\":{\\"sessionId\\":\\"s\\"}}"; read c; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":3,\\"result\\":{\\"stopReason\\":\\"end_turn\\"}}"; sleep 5';
test("accepts end_turn after cleanup and records actual peer exit", async () => {
  const lifecycle: string[] = [];
  const result = await run(good, 5_000, lifecycle);
  expect(result.worker.exitCode).toBe(0);
  expect(result.protocol?.processExitCode).toBe(143);
  expect(result.protocol?.protocolVersion).toBe(1);
  expect(result.protocol?.cleanupComplete).toBe(true);
  expect(lifecycle).toEqual([
    "session_ready",
    "prompt_in_flight",
    "prompt_finished",
    "cleanup_pending",
    "cleanup_complete",
  ]);
});
test("EOF rejects pending requests", async () => {
  expect((await run("exit 0")).worker.terminationReason).toBe("protocol-error");
});
test("malformed frames fail", async () => {
  expect((await run("echo nope")).worker.terminationReason).toBe(
    "protocol-error",
  );
});
test("requires negotiated protocol v1", async () => {
  const r = await run(
    'read a; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"result\\":{\\"protocolVersion\\":2}}"; sleep 1',
  );
  expect(r.protocol?.error).toContain("protocol version 1");
});
test("permission uses nested cancellation and is terminally blocked", async () => {
  const r = await run(
    'read a; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"permission-1\\",\\"method\\":\\"session/request_permission\\"}"; read x; echo "$x" >&2; sleep 1',
  );
  expect(r.worker.terminationReason).toBe("permission-denied");
});
test("unknown server requests are explicitly blocked", async () => {
  const r = await run(
    'read a; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"server-1\\",\\"method\\":\\"unknown/request\\"}"; read x; echo "$x" >&2; sleep 1',
  );
  expect(r.worker.terminationReason).toBe("protocol-error");
});
test("lifecycle failures still terminate the peer", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-lifecycle-"));
  roots.push(root);
  const agent = join(root, "agent");
  await writeFile(join(root, "plan"), "do it");
  await writeFile(join(root, "prompt.md"), "{{ plan }}\n{{ worker_judgment }}\n");
  await writeFile(agent, "#!/usr/bin/env bash\n" + good);
  await chmod(agent, 0o755);
  const r = await new AcpAttemptExecutor().execute({
    config: {
      repositoryPath: root,
      planPath: join(root, "plan"),
      stage: "1",
      verifierPath: join(root, "plan"),
      promptPath: join(root, "prompt.md"),
      evidencePath: root,
      acpCommand: [agent],
      workerTimeoutMs: 5_000,
      noToolTimeoutMs: 1,
      noToolOutputBytes: 1,
      maxToolCalls: 100,
      maxToolRepetitions: 8,
      maxAttempts: 1,
      runId: "t",
    },
    attempt: 1,
    failureReportPath: "/dev/null",
    prefix: join(root, "a"),
    onLifecycle: async (state) => {
      if (state === "cleanup_pending")
        throw new Error("checkpoint unavailable");
    },
  });
  expect(r.worker.terminationReason).toBe("protocol-error");
  expect(r.protocol?.processExitCode).toBe(143);
});
test("string response IDs are invalid for numeric client calls", async () => {
  const r = await run(
    'read a; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"1\\",\\"result\\":{}}"; sleep 1',
  );
  expect(r.worker.terminationReason).toBe("protocol-error");
});
test("deadline returns when cancellation gets no reply", async () => {
  expect((await run("sleep 5", 50)).worker.terminationReason).toBe("timeout");
});

const initFrame = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: 1 },
});
const sessionFrame = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: { sessionId: "s" },
});
function updateFrame(
  sessionUpdate: string,
  content?: { type: string; text?: string },
  sessionId = "s",
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate,
        ...(content === undefined ? {} : { content }),
      },
    },
  });
}
const textUpdateFrame = updateFrame("agent_message_chunk", {
  type: "text",
  text: "semantic text",
});
const toolUpdateFrame = JSON.stringify({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "s", update: { sessionUpdate: "tool_call_update" } },
});
function toolCallFrame(title: string, rawInput: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        kind: "execute",
        title,
        rawInput,
      },
    },
  });
}
const endTurnFrame = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  result: { stopReason: "end_turn" },
});
test("tool-free semantic text eventually terminates without resetting its budget", async () => {
  const body =
    "read a; echo '" +
    initFrame +
    "'; read b; echo '" +
    sessionFrame +
    "'; read c; while true; do echo '" +
    textUpdateFrame +
    "'; sleep 0.05; done";
  const r = await run(body, 2_000);
  expect(r.worker.terminationReason).toBe("no-tool-progress");
  expect(r.protocol?.error).toContain("tool-free generated text budget");
  expect(r.protocol?.watchdog?.toolFreeTextBytes).toBeGreaterThan(1);
  expect(r.protocol?.watchdog?.toolFreeWireBytes).toBeGreaterThan(
    r.protocol?.watchdog?.toolFreeTextBytes ?? 0,
  );
}, 5_000);
test("tool-call updates keep the prompt alive until end_turn", async () => {
  const body =
    "read a; echo '" +
    initFrame +
    "'; read b; echo '" +
    sessionFrame +
    "'; read c; for i in 1 2 3 4 5 6 7 8 9 10; do echo '" +
    toolUpdateFrame +
    "'; sleep 0.15; done; echo '" +
    endTurnFrame +
    "'; sleep 5";
  const r = await run(body, 5_000);
  expect(r.worker.terminationReason).toBeUndefined();
  expect(r.worker.exitCode).toBe(0);
}, 10_000);

test("tool calls beyond the attempt budget terminate with tool-call-limit", async () => {
  const body =
    `read a; echo '${initFrame}'; read b; echo '${sessionFrame}'; read c; ` +
    `echo '${toolCallFrame("read", { path: "a" })}'; ` +
    `echo '${toolCallFrame("read", { path: "b" })}'; ` +
    `echo '${toolCallFrame("read", { path: "c" })}'; ` +
    `echo '${toolCallFrame("read", { path: "d" })}'; sleep 5`;
  const r = await run(body, 5_000, [], { timeoutMs: 200, textBytes: 256 }, {
    maxToolCalls: 3,
    maxToolRepetitions: 8,
  });
  expect(r.worker.terminationReason).toBe("tool-call-limit");
  expect(r.protocol?.error).toContain("tool-call budget");
  expect(r.protocol?.toolCalls).toBe(4);
}, 5_000);

test("consecutive identical tool calls terminate with tool-call-limit", async () => {
  const repeated = toolCallFrame("edit", { path: "a", text: "x" });
  const distinct = toolCallFrame("edit", { path: "a", text: "y" });
  const body =
    `read a; echo '${initFrame}'; read b; echo '${sessionFrame}'; read c; ` +
    `echo '${distinct}'; echo '${repeated}'; echo '${repeated}'; echo '${repeated}'; sleep 5`;
  const r = await run(body, 5_000, [], { timeoutMs: 200, textBytes: 256 }, {
    maxToolCalls: 100,
    maxToolRepetitions: 2,
  });
  expect(r.worker.terminationReason).toBe("tool-call-limit");
  expect(r.protocol?.error).toContain("repeated an identical tool call");
  expect(r.protocol?.toolCalls).toBe(4);
}, 5_000);

test("fragmented thought frames use decoded text bytes instead of wire framing", async () => {
  const thought = updateFrame("agent_thought_chunk", { type: "text", text: "x" });
  const body =
    `read a; echo '${initFrame}'; read b; echo '${sessionFrame}'; read c; ` +
    `for i in $(seq 1 4000); do echo '${thought}'; done; ` +
    `sleep 1.2; ` +
    `echo '${endTurnFrame}'; sleep 5`;
  const r = await run(body, 5_000, [], {
    timeoutMs: 200,
    textBytes: 256 * 1024,
  });
  expect(r.worker.terminationReason).toBeUndefined();
  expect(r.worker.exitCode).toBe(0);
}, 10_000);

test("coarse and fragmented Unicode text have the same semantic budget", async () => {
  const runText = async (text: string, count = 1) => {
    const frame = updateFrame("agent_thought_chunk", { type: "text", text });
    const body =
      `read a; echo '${initFrame}'; read b; echo '${sessionFrame}'; read c; ` +
      `for i in $(seq 1 ${count}); do echo '${frame}'; done; sleep 5`;
    return run(body, 2_000);
  };
  const coarse = await runText("é".repeat(2000));
  const fine = await runText("é", 2000);
  expect(coarse.worker.terminationReason).toBe("no-tool-progress");
  expect(fine.worker.terminationReason).toBe("no-tool-progress");
  expect(coarse.protocol?.watchdog?.toolFreeTextBytes).toBe(4000);
  expect(fine.protocol?.watchdog?.toolFreeTextBytes).toBe(4000);
}, 10_000);

test("only active-session text counts and a valid tool update resets the budget", async () => {
  const text = updateFrame("agent_thought_chunk", { type: "text", text: "x".repeat(4) });
  const ignored = updateFrame(
    "agent_thought_chunk",
    { type: "text", text: "x".repeat(1000) },
    "other",
  );
  const metadata = updateFrame("session_info", {
    type: "text",
    text: "x".repeat(1000),
  });
  const body =
    `read a; echo '${initFrame}'; read b; echo '${sessionFrame}'; read c; ` +
    `echo '${ignored}'; echo '${metadata}'; echo '${text}'; echo '${toolUpdateFrame}'; ` +
    `echo '${text}'; sleep 5`;
  const r = await run(body, 2_000, [], { timeoutMs: 200, textBytes: 3 });
  expect(r.worker.terminationReason).toBe("no-tool-progress");
  expect(r.protocol?.watchdog?.toolFreeTextBytes).toBe(4);
}, 5_000);

test("wall timeout still bounds ongoing thought generation", async () => {
  const thought = updateFrame("agent_thought_chunk", { type: "text", text: "x" });
  const body =
    `read a; echo '${initFrame}'; read b; echo '${sessionFrame}'; read c; ` +
    `while true; do echo '${thought}'; sleep 0.05; done`;
  const r = await run(body, 300, [], { timeoutMs: 100, textBytes: 1_000_000 });
  expect(r.worker.terminationReason).toBe("timeout");
}, 5_000);

test("guarded ACP end_turn survives TERM-resistant peer missing its durable exit result", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-guarded-"));
  roots.push(root);
  const agent = join(root, "agent");
  await writeFile(join(root, "plan"), "do it");
  await writeFile(join(root, "prompt.md"), "{{ plan }}\n{{ worker_judgment }}\n");
  await writeFile(
    agent,
    "#!/usr/bin/env bash\n" +
      'trap "" TERM; read a; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"result\\":{\\"protocolVersion\\":1}}"; read b; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":2,\\"result\\":{\\"sessionId\\":\\"s\\"}}"; read c; echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":3,\\"result\\":{\\"stopReason\\":\\"end_turn\\"}}"; while :; do sleep .01; done',
  );
  await chmod(agent, 0o755);
  Bun.spawnSync(["git", "init", "-q", root]);
  const lock = await OwnershipLock.acquire(root, join(root, "evidence"));
  try {
    const started = Date.now();
    const result = await new AcpAttemptExecutor().execute({
      config: {
        repositoryPath: root,
        planPath: join(root, "plan"),
        stage: "1",
        verifierPath: join(root, "plan"),
        promptPath: join(root, "prompt.md"),
        evidencePath: root,
        acpCommand: [agent],
        workerTimeoutMs: 5_000,
        noToolTimeoutMs: 1,
        noToolOutputBytes: 1,
        maxToolCalls: 100,
        maxToolRepetitions: 8,
        maxAttempts: 1,
        runId: "t",
      },
      attempt: 1,
      failureReportPath: "/dev/null",
      prefix: join(root, "a"),
      guardedLaunch: (command, controlPath, beforeAuthorize) =>
        launchGuarded({
          lock,
          command,
          cwd: root,
          controlPath,
          terminationGraceMs: 30,
          ...(beforeAuthorize === undefined ? {} : { beforeAuthorize }),
        }),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.worker.exitCode).toBe(0);
    expect(result.protocol?.cleanupComplete).toBeTrue();
    expect(result.protocol?.processExitCode).toBeNull();
    expect(result.protocol?.processExitUnavailable).toBeTrue();
    expect(result.protocol?.wrapperExitCode).toBeNumber();
  } finally {
    await lock.release();
  }
}, 5_000);

test("ACP permits finite notification output above 8 MiB below the 64 MiB worker budget", async () => {
  const notificationPrefix =
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","text":"';
  const body =
    `read a; echo '${initFrame}'; read b; echo '${sessionFrame}'; read c; ` +
    `for i in $(seq 1 11); do printf '%s' '${notificationPrefix}'; head -c 900000 /dev/zero | tr '\\0' x; echo '"}}}'; done; ` +
    `echo '${endTurnFrame}'; sleep 5`;
  const r = await run(body, 10_000);
  expect(r.worker.terminationReason).toBeUndefined();
  expect(r.worker.exitCode).toBe(0);
}, 15_000);
