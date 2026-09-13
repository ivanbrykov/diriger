import { investigationSeconds, workerJudgmentInstructions } from "./worker-report.js";
import { renderPrompt } from "./prompt.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  launchGuarded,
  MissingGuardedChildResultError,
  type GuardedLaunch,
} from "./guard.js";
import type { OwnershipLock } from "./ownership.js";
import type {
  ProcessResult,
  SupervisorConfig,
  TerminationReason,
} from "./types.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
type RpcId = number | string;
type Response = {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { message?: string };
};
type Request = { jsonrpc: "2.0"; id?: RpcId; method: string };

export interface AttemptProtocol {
  protocolVersion?: number;
  sessionId?: string;
  stopReason?: string;
  capabilities?: unknown;
  error?: string;
  processExitCode: number | null;
  processExitUnavailable?: boolean;
  wrapperExitCode?: number;
  cleanupComplete: boolean;
  /** ACP tool-call session updates observed before the attempt ended. */
  toolCalls?: number;
  /** Present only when the ACP tool-free generation watchdog fired. */
  watchdog?: {
    readonly toolProgressAgeMs: number;
    readonly meaningfulActivityAgeMs: number;
    readonly toolFreeTextBytes: number;
    readonly toolFreeWireBytes: number;
  };
}
export interface AttemptExecution {
  worker: ProcessResult;
  protocol?: AttemptProtocol;
}
export type AttemptLifecycle =
  | "session_ready"
  | "prompt_in_flight"
  | "prompt_finished"
  | "cleanup_pending"
  | "cleanup_complete";
export interface AttemptExecutorInput {
  config: SupervisorConfig;
  attempt: number;
  failureReportPath: string;
  workerReportPath?: string;
  prefix: string;
  onLifecycle?: (state: AttemptLifecycle) => void | Promise<void>;
  guardedLaunch?: (
    command: ReadonlyArray<string>,
    controlPath: string,
    beforeAuthorize?: () => Promise<void>,
  ) => Promise<GuardedLaunch>;
}
export interface AttemptExecutor {
  execute(input: AttemptExecutorInput): Promise<AttemptExecution>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}
function response(value: unknown): Response | undefined {
  if (!object(value) || value.jsonrpc !== "2.0" || !id(value.id))
    return undefined;
  const result = Object.hasOwn(value, "result"),
    error = Object.hasOwn(value, "error");
  return result !== error && (!error || object(value.error))
    ? (value as Response)
    : undefined;
}
function request(value: unknown): Request | undefined {
  return object(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    (!Object.hasOwn(value, "id") || id(value.id))
    ? (value as Request)
    : undefined;
}
function updateKind(update: Record<string, unknown>): string | undefined {
  const kind = update.sessionUpdate;
  return typeof kind === "string"
    ? kind
    : object(kind) && typeof kind.type === "string"
      ? kind.type
      : undefined;
}

function activeUpdate(
  message: Request,
  sessionId: string | undefined,
): Record<string, unknown> | undefined {
  if (
    message.method !== "session/update" ||
    !object((message as unknown as { params?: unknown }).params)
  )
    return undefined;
  const params = (message as unknown as { params: Record<string, unknown> })
    .params;
  return params.sessionId === sessionId && object(params.update)
    ? params.update
    : undefined;
}

function textBytes(update: Record<string, unknown>): number {
  const kind = updateKind(update);
  if (kind !== "agent_thought_chunk" && kind !== "agent_message_chunk")
    return 0;
  const content = update.content;
  if (!object(content) || content.type !== "text" || typeof content.text !== "string")
    return 0;
  return new TextEncoder().encode(content.text).byteLength;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export class AcpAttemptExecutor implements AttemptExecutor {
  async execute(input: AttemptExecutorInput): Promise<AttemptExecution> {
    const { config, attempt, failureReportPath, prefix, onLifecycle } = input;
    if (config.acpCommand === undefined || config.acpCommand.length === 0)
      throw new Error("ACP worker requires --acp-command");
    await mkdir(dirname(prefix), { recursive: true });
    let child: Bun.ReadableSubprocess;
    let guarded: GuardedLaunch | undefined;
    try {
      guarded =
        input.guardedLaunch === undefined
          ? undefined
          : await input.guardedLaunch(
              config.acpCommand,
              prefix + "-guard",
              async () => {
                await onLifecycle?.("prompt_in_flight");
              },
            );
      child =
        guarded === undefined
          ? Bun.spawn([...config.acpCommand], {
              cwd: config.repositoryPath,
              env: config.workerEnvironment ?? process.env,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              detached: true,
            })
          : (guarded.process as Bun.ReadableSubprocess);
    } catch {
      return { worker: { exitCode: 1, terminationReason: "spawn-error" } };
    }

    const out = Bun.file(prefix + "-worker.acp.jsonl").writer(),
      err = Bun.file(prefix + "-worker.stderr.log").writer();
    const stdin = child.stdin as { write(value: string): void; flush(): number | Promise<number>; end(): void };
    const calls = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    let next = 1,
      protocolVersion: number | undefined,
      sessionId: string | undefined,
      stopReason: string | undefined,
      capabilities: unknown;
    let cleanupComplete = false;
    let failure: string | undefined,
      reason: TerminationReason | undefined,
      cleanupPromise: Promise<void> | undefined;
    let lastToolAt = Date.now(),
      lastMeaningfulActivityAt = Date.now(),
      toolFreeTextBytes = 0,
      toolFreeWireBytes = 0,
      promptInFlight = false;
    let toolCalls = 0,
      toolRepetitions = 0,
      lastToolCall: string | undefined;
    let watchdogSnapshot: AttemptProtocol["watchdog"] | undefined;
    const lifecycle = async (state: AttemptLifecycle) => {
      await onLifecycle?.(state);
    };
    const rejectCalls = (message: string) => {
      for (const call of calls.values()) call.reject(new Error(message));
      calls.clear();
    };
    const fail = (error: unknown, termination: TerminationReason) => {
      failure ??= error instanceof Error ? error.message : String(error);
      reason ??= termination;
      rejectCalls(failure);
    };
    const send = (message: unknown) => {
      try {
        stdin.write(JSON.stringify(message) + "\n");
        void Promise.resolve(stdin.flush()).catch(() => fail("ACP stdin flush failed", "protocol-error"));
      } catch {
        fail("ACP stdin closed", "protocol-error");
      }
    };
    const cleanup = async (termination?: TerminationReason): Promise<void> => {
      if (cleanupPromise !== undefined) return cleanupPromise;
      cleanupPromise = (async () => {
        reason ??= termination;
        if (guarded !== undefined) {
          await guarded.cleanup();
          return;
        }
        let lifecycleError: unknown;
        try {
          await lifecycle("cleanup_pending");
        } catch (error) {
          lifecycleError = error;
        }
        try {
          if (reason === "timeout" && sessionId !== undefined)
            send({
              jsonrpc: "2.0",
              method: "session/cancel",
              params: { sessionId },
            });
          try {
            stdin.end();
          } catch {
            /* peer closed stdin */
          }
          signalGroup(child.pid, "SIGTERM");
          await new Promise<void>((resolve) =>
            setTimeout(resolve, KILL_GRACE_MS),
          );
          signalGroup(child.pid, "SIGKILL");
        } finally {
          if (lifecycleError !== undefined) throw lifecycleError;
        }
      })();
      return cleanupPromise;
    };
    const call = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const requestId = next++;
        calls.set(requestId, { resolve, reject });
        send({ jsonrpc: "2.0", id: requestId, method, params });
      });
    const stderr = (async () => {
      const reader = child.stderr.getReader();
      let bytes = 0;
      try {
        for (;;) {
          const value = await reader.read();
          if (value.done) return;
          bytes += value.value.byteLength;
          if (bytes > MAX_STREAM_BYTES)
            throw new Error(
              "ACP stderr exceeds " + MAX_STREAM_BYTES + " bytes",
            );
          err.write(value.value);
        }
      } catch (error) {
        fail(error, "protocol-error");
        try {
          await cleanup("protocol-error");
        } catch {
          /* final cleanup reports the preserved cause */
        }
      } finally {
        await err.end();
      }
    })();
    const stdout = (async () => {
      const reader = child.stdout.getReader(),
        decoder = new TextDecoder(),
        encoder = new TextEncoder();
      let bytes = 0,
        pending = "";
      const handle = (message: unknown) => {
        const reply = response(message);
        if (reply !== undefined) {
          if (typeof reply.id !== "number")
            throw new Error(
              "ACP response id must match a numeric client request",
            );
          const sent = calls.get(reply.id);
          if (sent === undefined)
            throw new Error("unexpected ACP response id " + reply.id);
          calls.delete(reply.id);
          if (reply.error !== undefined)
            sent.reject(
              new Error(reply.error.message ?? "ACP returned an error"),
            );
          else sent.resolve(reply.result);
          return;
        }
        const incoming = request(message);
        if (incoming === undefined)
          throw new Error("invalid ACP JSON-RPC message");
        if (incoming.id === undefined) {
          if (!promptInFlight || sessionId === undefined) return;
          const update = activeUpdate(incoming, sessionId);
          if (update === undefined) return;
          const kind = updateKind(update);
          if (kind === "tool_call" || kind === "tool_call_update") {
            lastToolAt = Date.now();
            lastMeaningfulActivityAt = lastToolAt;
            toolFreeTextBytes = 0;
            toolFreeWireBytes = 0;
            if (kind === "tool_call") {
              toolCalls += 1;
              const identity = JSON.stringify([
                update.kind ?? null,
                update.title ?? null,
                update.rawInput ?? null,
              ]);
              toolRepetitions =
                identity === lastToolCall ? toolRepetitions + 1 : 1;
              lastToolCall = identity;
              if (toolCalls > config.maxToolCalls) {
                fail(
                  "ACP tool-call budget exceeded",
                  "tool-call-limit",
                );
                void cleanup("tool-call-limit").catch(() => {});
              } else if (toolRepetitions > config.maxToolRepetitions) {
                fail(
                  "ACP repeated an identical tool call beyond its budget",
                  "tool-call-limit",
                );
                void cleanup("tool-call-limit").catch(() => {});
              }
            }
            return;
          }
          const bytes = textBytes(update);
          if (bytes > 0) {
            lastMeaningfulActivityAt = Date.now();
            toolFreeTextBytes += bytes;
          }
          return;
        }
        if (incoming.method === "session/request_permission") {
          send({
            jsonrpc: "2.0",
            id: incoming.id,
            result: { outcome: { outcome: "cancelled" } },
          });
          throw new Error("ACP permission request blocked");
        }
        send({
          jsonrpc: "2.0",
          id: incoming.id,
          error: { code: -32601, message: "client capability not implemented" },
        });
        throw new Error("ACP server request blocked: " + incoming.method);
      };
      try {
        for (;;) {
          const value = await reader.read();
          if (value.done) break;
          bytes += value.value.byteLength;
          if (bytes > MAX_STREAM_BYTES)
            throw new Error(
              "ACP stdout exceeds " + MAX_STREAM_BYTES + " bytes",
            );
          out.write(value.value);
          pending += decoder.decode(value.value, { stream: true });
          for (
            let newline = pending.indexOf("\n");
            newline >= 0;
            newline = pending.indexOf("\n")
          ) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (encoder.encode(line).byteLength > MAX_FRAME_BYTES)
              throw new Error(
                "ACP frame exceeds " + MAX_FRAME_BYTES + " bytes",
              );
            let message: unknown;
            try {
              message = JSON.parse(line);
            } catch {
              throw new Error("malformed ACP JSON-RPC frame");
            }
            if (promptInFlight)
              toolFreeWireBytes += encoder.encode(line).byteLength + 1;
            handle(message);
          }
          if (encoder.encode(pending).byteLength > MAX_FRAME_BYTES)
            throw new Error(
              "ACP partial frame exceeds " + MAX_FRAME_BYTES + " bytes",
            );
        }
        pending += decoder.decode();
        if (pending.trim() !== "") throw new Error("unterminated ACP frame");
      } catch (error) {
        fail(
          error,
          error instanceof Error &&
            error.message.includes("permission request blocked")
            ? "permission-denied"
            : "protocol-error",
        );
        try {
          await cleanup(reason);
        } catch {
          /* final cleanup reports the preserved cause */
        }
      } finally {
        await out.end();
        rejectCalls(failure ?? "ACP stdout closed");
      }
    })();
    const deadline = setTimeout(() => {
      fail("ACP deadline exceeded", "timeout");
      void cleanup("timeout").catch(() => {});
    }, config.workerTimeoutMs);
    const watchdog = setInterval(() => {
      if (
        promptInFlight &&
        Date.now() - lastToolAt >= config.noToolTimeoutMs &&
        toolFreeTextBytes >= config.noToolOutputBytes
      ) {
        watchdogSnapshot ??= {
          toolProgressAgeMs: Math.min(
            Date.now() - lastToolAt,
            config.workerTimeoutMs,
          ),
          meaningfulActivityAgeMs: Math.min(
            Date.now() - lastMeaningfulActivityAt,
            config.workerTimeoutMs,
          ),
          toolFreeTextBytes,
          toolFreeWireBytes,
        };
        fail(
          "ACP tool-free generated text budget exceeded",
          "no-tool-progress",
        );
        void cleanup("no-tool-progress").catch(() => {});
      }
    }, Math.min(1_000, Math.max(25, Math.floor(config.noToolTimeoutMs / 4))));
    try {
      const initialize = await call("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      if (!object(initialize) || initialize.protocolVersion !== 1)
        throw new Error("ACP peer did not negotiate protocol version 1");
      protocolVersion = initialize.protocolVersion as number;
      capabilities = initialize.agentCapabilities;
      const session = await call("session/new", {
        cwd: config.repositoryPath,
        mcpServers: [],
      });
      if (!object(session) || typeof session.sessionId !== "string")
        throw new Error("ACP session/new did not return sessionId");
      sessionId = session.sessionId;
      await lifecycle("session_ready");
      const plan = await Bun.file(config.planPath).text();
      const template = await Bun.file(config.promptPath).text();
      const brief = renderPrompt(template, {
        plan,
        repository_path: config.repositoryPath,
        plan_path: config.planPath,
        stage: config.stage,
        attempt: String(attempt),
        failure_report_path: failureReportPath,
        worker_report_path: input.workerReportPath ?? "",
        worker_judgment:
          input.workerReportPath === undefined
            ? ""
            : workerJudgmentInstructions(
                input.workerReportPath,
                investigationSeconds(config.workerTimeoutMs),
              ),
      });
      await lifecycle("prompt_in_flight");
      lastToolAt = Date.now();
      lastMeaningfulActivityAt = lastToolAt;
      toolFreeTextBytes = 0;
      toolFreeWireBytes = 0;
      promptInFlight = true;
      const prompt = await call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: brief }],
      });
      if (!object(prompt) || typeof prompt.stopReason !== "string")
        throw new Error("ACP session/prompt did not return stopReason");
      stopReason = prompt.stopReason;
      promptInFlight = false;
      await lifecycle("prompt_finished");
      if (stopReason !== "end_turn")
        throw new Error("ACP prompt stopped: " + stopReason);
    } catch (error) {
      fail(
        error,
        error instanceof Error &&
          error.message.includes("permission request blocked")
          ? "permission-denied"
          : (reason ?? "protocol-error"),
      );
    } finally {
      clearTimeout(deadline);
      clearInterval(watchdog);
      try {
        await cleanup();
      } catch (error) {
        fail(error, "protocol-error");
      }
      await Promise.all([stdout, stderr]);
      await child.exited;
      try {
        await lifecycle("cleanup_complete");
        cleanupComplete = true;
      } catch (error) {
        fail(error, "protocol-error");
      }
    }
    let processExitCode: number | null;
    let wrapperExitCode: number | undefined;
    try {
      processExitCode =
        guarded === undefined ? await child.exited : await guarded.childExited;
    } catch (error) {
      if (!(error instanceof MissingGuardedChildResultError)) throw error;
      processExitCode = null;
      wrapperExitCode = error.wrapperExitCode;
    }
    // ACP completion is the successful end_turn plus proven group cleanup.
    // A cleanup KILL can legitimately prevent durable recording of the peer's
    // OS exit status, so it must not rewrite that completed protocol outcome.
    const eligible =
      reason === undefined && stopReason === "end_turn" && cleanupComplete;
    return {
      worker: {
        exitCode: eligible ? 0 : (processExitCode ?? wrapperExitCode ?? 1),
        ...(reason === undefined ? {} : { terminationReason: reason }),
      },
      protocol: {
        processExitCode,
        ...(processExitCode === null ? { processExitUnavailable: true } : {}),
        ...(wrapperExitCode === undefined ? {} : { wrapperExitCode }),
        cleanupComplete,
        ...(toolCalls === 0 ? {} : { toolCalls }),
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(stopReason === undefined ? {} : { stopReason }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(failure === undefined ? {} : { error: failure }),
        ...(watchdogSnapshot === undefined ? {} : { watchdog: watchdogSnapshot }),
      },
    };
  }
}
