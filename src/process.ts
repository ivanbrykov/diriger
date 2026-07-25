import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ProcessResult,
  TerminationReason,
  Usage,
  VerificationResult,
} from "./types.js";

interface ObservedProcessOptions {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly timeoutMs: number;
  readonly noToolTimeoutMs: number;
  readonly noToolOutputBytes: number;
  readonly onTool?: (tool: string) => void;
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
    return value.message?.content?.find(
      (item) => item.type === "toolRequest",
    )?.toolCall?.value?.name;
  } catch {
    return "unknown";
  }
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  path: string,
  onLine: (line: string) => void,
  onBytes: (count: number) => void,
): Promise<void> {
  const writer = Bun.file(path).writer();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      writer.write(value);
      onBytes(value.byteLength);
      pending += decoder.decode(value, { stream: true });

      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }

    pending += decoder.decode();
    if (pending.length > 0) {
      onLine(pending);
    }
  } finally {
    await writer.end();
  }
}

function terminate(
  process: Bun.ReadableSubprocess,
  reason: TerminationReason,
  current: TerminationReason | undefined,
): TerminationReason {
  if (current !== undefined) {
    return current;
  }

  process.kill("SIGTERM");
  setTimeout(() => {
    if (process.exitCode === null) {
      process.kill("SIGKILL");
    }
  }, 2_000);
  return reason;
}

export async function runObservedProcess(
  options: ObservedProcessOptions,
): Promise<ProcessResult> {
  await mkdir(dirname(options.stdoutPath), { recursive: true });

  let process: Bun.ReadableSubprocess;
  try {
    process = Bun.spawn([...options.command], {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { exitCode: 1, terminationReason: "spawn-error" };
  }

  let terminationReason: TerminationReason | undefined;
  let lastToolAt = Date.now();
  let bytesSinceTool = 0;
  let usage: Usage | undefined;

  const timeout = setTimeout(() => {
    terminationReason = terminate(process, "timeout", terminationReason);
  }, options.timeoutMs);

  const watchdog = setInterval(() => {
    const noToolFor = Date.now() - lastToolAt;
    if (
      noToolFor >= options.noToolTimeoutMs &&
      bytesSinceTool >= options.noToolOutputBytes
    ) {
      terminationReason = terminate(
        process,
        "no-tool-progress",
        terminationReason,
      );
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
  );
  const stderr = consumeLines(
    process.stderr,
    options.stderrPath,
    () => undefined,
    () => undefined,
  );

  const exitCode = await process.exited;
  clearTimeout(timeout);
  clearInterval(watchdog);
  await Promise.all([stdout, stderr]);

  return {
    exitCode,
    ...(terminationReason === undefined ? {} : { terminationReason }),
    ...(usage === undefined ? {} : { usage }),
  };
}

export async function runVerification(
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<VerificationResult> {
  const process = Bun.spawn([...command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill("SIGTERM");
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  clearTimeout(timeout);

  return {
    exitCode,
    output: `${stdout}${stderr}`,
    timedOut,
  };
}

export function encodedBytes(value: string): number {
  return encoder.encode(value).byteLength;
}
