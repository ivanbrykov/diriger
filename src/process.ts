import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MissingGuardedChildResultError, type GuardedLaunch } from "./guard.js";
import type {
  ProcessResult,
  TerminationReason,
  Usage,
  VerificationResult,
} from "./types.js";

interface ObservedProcessOptions {
  readonly command: ReadonlyArray<string>;
  readonly guardedLaunch?: GuardedLaunch;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly timeoutMs: number;
  readonly noToolTimeoutMs: number;
  readonly noToolOutputBytes: number;
  readonly onTool?: (tool: string) => void;
  readonly maxOutputBytes?: number;
  readonly maxPartialLineBytes?: number;
}

const encoder = new TextEncoder();

function parseUsage(line: string): Usage | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type !== "complete") {
      return undefined;
    }

    return {
      totalTokens: Number(value.total_tokens ?? 0),
      inputTokens: Number(value.input_tokens ?? 0),
      outputTokens: Number(value.output_tokens ?? 0),
      cacheReadInputTokens: Number(value.cache_read_input_tokens ?? 0),
    };
  } catch {
    return undefined;
  }
}

function toolName(line: string): string | undefined {
  if (!line.includes('"toolRequest"')) {
    return undefined;
  }

  try {
    const value = JSON.parse(line) as {
      message?: {
        content?: ReadonlyArray<{
          type?: string;
          toolCall?: { value?: { name?: string } };
        }>;
      };
    };
    return value.message?.content?.find((item) => item.type === "toolRequest")
      ?.toolCall?.value?.name;
  } catch {
    return "unknown";
  }
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  path: string,
  onLine: (line: string) => void,
  onBytes: (count: number) => void,
  maximum: number,
  partialMaximum: number,
  overflow: () => void,
): Promise<void> {
  const writer = Bun.file(path).writer();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "",
    total = 0,
    limited = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      onBytes(value.byteLength);
      if (total > maximum) {
        if (!limited) {
          limited = true;
          overflow();
        }
        continue;
      }
      writer.write(value);
      pending += decoder.decode(value, { stream: true });
      if (encoder.encode(pending).byteLength > partialMaximum) {
        if (!limited) {
          limited = true;
          overflow();
        }
        pending = "";
        continue;
      }
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    }
    if (!limited) {
      pending += decoder.decode();
      if (pending) onLine(pending);
    }
  } finally {
    await writer.end();
  }
}
async function capture(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  overflow: () => void,
): Promise<string> {
  const r = stream.getReader(),
    chunks: Uint8Array[] = [],
    limit = Math.min(maximum, 64 * 1024);
  let total = 0,
    limited = false;
  while (true) {
    const { done, value } = await r.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      if (!limited) {
        limited = true;
        overflow();
      }
      continue;
    }
    let used = chunks.reduce((n, x) => n + x.byteLength, 0);
    if (used < limit) chunks.push(value.slice(0, limit - used));
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Bun's detached option creates a new POSIX session/process group. Signal the
// group even after its leader exits, since descendants may still own the pipes.
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function groupCleanup(pid: number) {
  let completion: Promise<void> | undefined;
  return {
    request(): void {
      if (completion !== undefined) return;
      completion = (async () => {
        if (!signalGroup(pid, "SIGTERM")) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
        signalGroup(pid, "SIGKILL");
      })();
      // The caller awaits this in finally, including any signaling failure.
      void completion.catch(() => {});
    },
    async finish(): Promise<void> {
      await completion;
    },
  };
}

function assertProcessGroups(): void {
  if (process.platform === "win32") {
    throw new Error("supervised processes require POSIX process-group support");
  }
}

export async function runObservedProcess(
  options: ObservedProcessOptions,
): Promise<ProcessResult> {
  assertProcessGroups();
  await mkdir(dirname(options.stdoutPath), { recursive: true });

  let process: Bun.ReadableSubprocess;
  try {
    process =
      (options.guardedLaunch?.process as Bun.ReadableSubprocess) ??
      Bun.spawn([...options.command], {
        cwd: options.cwd,
        env: options.env,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        stdin: "ignore",
      });
  } catch {
    return { exitCode: 1, terminationReason: "spawn-error" };
  }

  const cleanup =
    options.guardedLaunch === undefined
      ? groupCleanup(process.pid)
      : {
          request(): void {
            void options.guardedLaunch?.cleanup().catch(() => {});
          },
          async finish(): Promise<void> {
            await options.guardedLaunch?.cleanup();
          },
        };
  let terminationReason: TerminationReason | undefined;
  const terminate = (reason: TerminationReason): void => {
    terminationReason ??= reason;
    cleanup.request();
  };
  let lastToolAt = Date.now();
  let bytesSinceTool = 0;
  let usage: Usage | undefined;
  const outputLimit = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const partialLimit = options.maxPartialLineBytes ?? 1024 * 1024;

  const timeout = setTimeout(() => {
    terminate("timeout");
  }, options.timeoutMs);

  const watchdog = setInterval(() => {
    const noToolFor = Date.now() - lastToolAt;
    if (
      noToolFor >= options.noToolTimeoutMs &&
      bytesSinceTool >= options.noToolOutputBytes
    ) {
      terminate("no-tool-progress");
    }
  }, 1_000);

  const stdout = consumeLines(
    process.stdout,
    options.stdoutPath,
    (line) => {
      const currentUsage = parseUsage(line);
      if (currentUsage !== undefined) {
        usage = currentUsage;
      }

      const tool = toolName(line);
      if (tool !== undefined) {
        lastToolAt = Date.now();
        bytesSinceTool = 0;
        options.onTool?.(tool);
      }
    },
    (count) => {
      bytesSinceTool += count;
    },
    outputLimit,
    partialLimit,
    () => terminate("output-limit"),
  );
  const stderr = consumeLines(
    process.stderr,
    options.stderrPath,
    () => undefined,
    () => undefined,
    outputLimit,
    partialLimit,
    () => terminate("output-limit"),
  );

  try {
    // Keep the deadline active until descendants release both output streams.
    let exitCode: number;
    try {
      exitCode =
        options.guardedLaunch === undefined
          ? await process.exited
          : await options.guardedLaunch.childExited;
    } catch (error) {
      if (!(error instanceof MissingGuardedChildResultError)) throw error;
      cleanup.request();
      await cleanup.finish();
      await Promise.all([stdout, stderr]);
      return {
        exitCode: 1,
        terminationReason: "missing-child-result",
        resultUnavailable: true,
        wrapperExitCode: error.wrapperExitCode,
      };
    }
    cleanup.request();
    await cleanup.finish();
    await Promise.all([stdout, stderr]);
    return {
      exitCode,
      ...(terminationReason === undefined ? {} : { terminationReason }),
      ...(usage === undefined ? {} : { usage }),
    };
  } finally {
    clearTimeout(timeout);
    clearInterval(watchdog);
    cleanup.request();
    await cleanup.finish();
  }
}

export async function runVerification(
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  guardedLaunch?: GuardedLaunch,
  maxOutputBytes = 8 * 1024 * 1024,
): Promise<VerificationResult> {
  assertProcessGroups();
  const process =
    (guardedLaunch?.process as Bun.ReadableSubprocess) ??
    Bun.spawn([...command], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      stdin: "ignore",
    });

  const cleanup =
    guardedLaunch === undefined
      ? groupCleanup(process.pid)
      : {
          request(): void {
            void guardedLaunch.cleanup().catch(() => {});
          },
          async finish(): Promise<void> {
            await guardedLaunch.cleanup();
          },
        };
  let timedOut = false,
    outputLimited = false;
  const overflow = () => {
    outputLimited = true;
    cleanup.request();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    cleanup.request();
  }, timeoutMs);

  try {
    const stdout = capture(process.stdout, maxOutputBytes, overflow);
    const stderr = capture(process.stderr, maxOutputBytes, overflow);
    let exitCode: number;
    let missingResult: MissingGuardedChildResultError | undefined;
    try {
      exitCode =
        guardedLaunch === undefined
          ? await process.exited
          : await guardedLaunch.childExited;
    } catch (error) {
      if (!(error instanceof MissingGuardedChildResultError)) throw error;
      missingResult = error;
      exitCode = 1;
    }
    cleanup.request();
    await cleanup.finish();
    return {
      exitCode,
      output: (await stdout) + (await stderr),
      timedOut,
      ...(missingResult === undefined
        ? {}
        : {
            resultUnavailable: true,
            actualExitCode: null,
            wrapperExitCode: missingResult.wrapperExitCode,
          }),
      ...(outputLimited
        ? { outputLimited: true, actualExitCode: exitCode, exitCode: 1 }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
    cleanup.request();
    await cleanup.finish();
  }
}

export function encodedBytes(value: string): number {
  return encoder.encode(value).byteLength;
}
