/**
 * Build the deliberately small, data-only input for a between-attempt progress
 * evaluator.  ACP transcripts are untrusted: agent messages and tool titles
 * are never carried forward, and only selected structured tool input fields
 * become command evidence.
 */
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  CommandEvidence,
  ProgressEvidence,
} from "./progress-evaluator.js";

const MAX_PROTOCOL_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
// These independent caps keep the complete JSON envelope below the evaluator's
// 64 KiB transport limit even when every optional field is present.
const MAX_HEAD_EVENTS = 8;
const MAX_TAIL_EVENTS = 52;
const MAX_TIMELINE_BYTES = 18 * 1024;
const MAX_COMMAND_BYTES = 512;
const MAX_PATH_BYTES = 256;
const MAX_VERIFIER_BYTES = 10 * 1024;
const MAX_STATUS_BYTES = 10 * 1024;
const MAX_DIFF_SUMMARY_BYTES = 10 * 1024;
const MAX_HYPOTHESIS_BYTES = 1024;
const MAX_FAILURE_REASON_BYTES = 2 * 1024;
const MAX_TASK_BRIEF_BYTES = 4 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ProgressEvidenceInput {
  /** ACP JSONL written by the completed worker, read after its cleanup. */
  readonly protocolPath: string;
  readonly repositoryPath: string;
  /** HEAD recorded immediately before this attempt started. */
  readonly preHead: string;
  readonly lastVerifier?: {
    readonly exitCode: number;
    readonly output: string;
    readonly timedOut?: boolean;
    readonly outputLimited?: boolean;
  } | null;
  readonly previousHypotheses?: ReadonlyArray<string>;
  readonly failureReason?: string;
  readonly taskBrief?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: string, maximum: number): string {
  const bytes = encoder.encode(value);
  const suffix = "\n[truncated]";
  return bytes.byteLength <= maximum
    ? value
    : decoder.decode(bytes.slice(0, maximum - encoder.encode(suffix).byteLength)) + suffix;
}

function headAndTail(value: string, maximum: number): string {
  const bytes = encoder.encode(value);
  const marker = "…[truncated]…";
  const markerBytes = encoder.encode(marker).byteLength;
  if (bytes.byteLength <= maximum) return value;
  const side = Math.floor((maximum - markerBytes) / 2);
  return decoder.decode(bytes.slice(0, side)) + marker +
    decoder.decode(bytes.slice(bytes.byteLength - side));
}

function displayPath(value: string, repositoryPath: string): string {
  return headAndTail(value.replaceAll(repositoryPath, "<repo>"), MAX_PATH_BYTES);
}

function displayCommand(value: string, repositoryPath: string): string {
  return headAndTail(value.replaceAll(repositoryPath, "<repo>"), MAX_COMMAND_BYTES);
}

function git(repositoryPath: string, args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync(
    ["git", "--no-replace-objects", "-C", repositoryPath, ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${decoder.decode(result.stderr).trim()}`,
    );
  return decoder.decode(result.stdout).trim();
}

function timestamp(frame: Record<string, unknown>, sequence: number): string {
  const params = record(frame.params) ? frame.params : undefined;
  const update = params !== undefined && record(params.update) ? params.update : undefined;
  for (const value of [frame.at, frame.timestamp, frame.createdAt, params?.at, update?.at]) {
    if (typeof value === "string" && value.trim() !== "") return bounded(value, 128);
  }
  // ACP itself does not require a timestamp. Make that absence visible rather
  // than manufacturing wall-clock time after the worker has finished.
  return `event:${sequence}`;
}

function exitCode(value: unknown): number | null | undefined {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
    ? (value as number | null)
    : undefined;
}

function patchPaths(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "string") return [];
  const paths: string[] = [];
  for (const line of value.split("\n")) {
    const match = /^(?:\*\*\* (?:Update|Add|Delete) File: |(?:---|\+\+\+) [ab]\/)(.+)$/.exec(line);
    if (match?.[1] && match[1] !== "/dev/null") paths.push(match[1]);
  }
  return [...new Set(paths)].slice(0, 4);
}

interface ToolCandidate {
  readonly at: string;
  readonly sequence: number;
  readonly identity: string;
  readonly argv: ReadonlyArray<string>;
  readonly exitCode?: number | null;
}

/**
 * Extract only structured command fields. A title and edit body are prose and
 * cannot become evaluator input. Identity hashes use the full structured
 * values before the display copy is shortened, avoiding false merges of long
 * common-prefix shell commands.
 */
function toolCall(
  frame: unknown,
  sequence: number,
  repositoryPath: string,
): ToolCandidate | undefined {
  if (!record(frame) || frame.method !== "session/update" || !record(frame.params))
    return undefined;
  const update = frame.params.update;
  if (!record(update) || update.sessionUpdate !== "tool_call") return undefined;
  if (!record(update.rawInput)) return undefined;
  const raw = update.rawInput;
  const argv: string[] = [];
  const identity: Record<string, unknown> = {};
  const direct = Array.isArray(raw.argv) ? raw.argv : Array.isArray(raw.command) ? raw.command : undefined;
  if (direct !== undefined && direct.length > 0) {
    if (direct.some((part) => typeof part !== "string" || part.trim() === "")) return undefined;
    identity.argv = direct;
    argv.push(...direct.slice(0, 6).map((part) => displayCommand(part as string, repositoryPath)));
  } else if (typeof raw.command === "string" && raw.command.trim() !== "") {
    identity.command = raw.command;
    argv.push("command", displayCommand(raw.command, repositoryPath));
  }
  const operation = typeof raw.operation === "string" && raw.operation.trim() !== ""
    ? raw.operation
    : undefined;
  if (operation !== undefined) {
    identity.operation = operation;
    argv.push("operation", headAndTail(operation, 128));
  }
  if (typeof raw.path === "string" && raw.path.trim() !== "") {
    identity.path = raw.path;
    argv.push("path", displayPath(raw.path, repositoryPath));
  }
  const editedPaths = patchPaths(raw.input);
  if (editedPaths.length > 0) {
    identity.editKind = typeof update.kind === "string" ? update.kind : "edit";
    identity.patchPaths = editedPaths;
    argv.push("operation", headAndTail(String(identity.editKind), 128));
    for (const path of editedPaths) argv.push("path", displayPath(path, repositoryPath));
  }
  if (argv.length === 0) return undefined;
  const code = exitCode(update.exitCode) ?? exitCode(record(update.rawInput) ? update.rawInput.exitCode : undefined);
  return {
    at: timestamp(frame, sequence),
    sequence,
    identity: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    argv: argv.slice(0, 8),
    ...(code === undefined ? {} : { exitCode: code }),
  };
}

async function streamToolCalls(
  protocolPath: string,
  repositoryPath: string,
  visitor: (candidate: ToolCandidate) => void,
): Promise<void> {
  const file = await open(protocolPath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("ACP protocol log is not a regular file");
    if (info.size > MAX_PROTOCOL_BYTES)
      throw new Error(`ACP protocol log exceeds ${MAX_PROTOCOL_BYTES} bytes`);
    const buffer = new Uint8Array(64 * 1024);
    let pending = "";
    let bytes = 0;
    let sequence = 0;
    const processLine = (line: string): void => {
      if (encoder.encode(line).byteLength > MAX_FRAME_BYTES)
        throw new Error(`ACP protocol frame exceeds ${MAX_FRAME_BYTES} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Worker protocol validation already treats this as terminal. Evidence
        // collection ignores unrelated malformed log material after cleanup.
        return;
      }
      sequence += 1;
      const call = toolCall(parsed, sequence, repositoryPath);
      if (call !== undefined) visitor(call);
    };
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_PROTOCOL_BYTES)
        throw new Error(`ACP protocol log exceeds ${MAX_PROTOCOL_BYTES} bytes`);
      pending += decoder.decode(buffer.slice(0, bytesRead), { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        processLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (encoder.encode(pending).byteLength > MAX_FRAME_BYTES)
        throw new Error(`ACP protocol partial frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    pending += decoder.decode();
    if (pending !== "") processLine(pending);
  } finally {
    await file.close();
  }
}

function bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

async function collectCommandTimeline(
  protocolPath: string,
  repositoryPath: string,
): Promise<ReadonlyArray<CommandEvidence>> {
  const head: ToolCandidate[] = [];
  const tail: ToolCandidate[] = [];
  await streamToolCalls(protocolPath, repositoryPath, (candidate) => {
    if (head.length < MAX_HEAD_EVENTS) head.push(candidate);
    else {
      tail.push(candidate);
      if (tail.length > MAX_TAIL_EVENTS) tail.shift();
    }
  });
  // A tail observation replaces the same early identity so the timeline shows
  // the latest action while its count still covers the complete transcript.
  const selected = new Map<string, ToolCandidate>();
  for (const candidate of [...head, ...tail]) selected.set(candidate.identity, candidate);
  const counts = new Map<string, { count: number; exitCode?: number | null; mixed: boolean }>();
  for (const [identity, candidate] of selected)
    counts.set(identity, {
      count: 0,
      ...(candidate.exitCode === undefined ? {} : { exitCode: candidate.exitCode }),
      mixed: false,
    });
  await streamToolCalls(protocolPath, repositoryPath, (candidate) => {
    const current = counts.get(candidate.identity);
    if (current === undefined) return;
    current.count += 1;
    if (current.exitCode !== candidate.exitCode) current.mixed = true;
  });
  const candidates = [...selected.values()].sort((left, right) => left.sequence - right.sequence)
    .map((candidate) => {
      const count = counts.get(candidate.identity)!;
      return {
        sequence: candidate.sequence,
        evidence: {
          at: candidate.at,
          argv: candidate.argv,
          repeatCount: count.count,
          ...(count.mixed || candidate.exitCode === undefined ? {} : { exitCode: candidate.exitCode }),
        } satisfies CommandEvidence,
      };
    });
  // Retain a small beginning first, then spend the rest of the budget from the
  // end backwards. A long early command therefore cannot hide the last edit or
  // verifier command that explains the current repository state.
  const kept: typeof candidates = [];
  let used = 2;
  for (const candidate of candidates.slice(0, MAX_HEAD_EVENTS)) {
    const size = bytes(candidate.evidence) + 1;
    if (used + size <= 2 * 1024) { kept.push(candidate); used += size; }
  }
  for (const candidate of candidates.slice(MAX_HEAD_EVENTS).reverse()) {
    const size = bytes(candidate.evidence) + 1;
    if (used + size <= MAX_TIMELINE_BYTES) { kept.push(candidate); used += size; }
  }
  return kept.sort((left, right) => left.sequence - right.sequence)
    .map((candidate) => candidate.evidence);
}

/**
 * Build one bounded evidence snapshot after worker cleanup. Git commands read
 * the repository at call time, so the result reflects the actual post-attempt
 * worktree rather than ACP claims about modifications.
 */
export async function buildProgressEvidence(
  input: ProgressEvidenceInput,
): Promise<ProgressEvidence> {
  const [timeline, currentHead, currentStatus, commitCount, workingDiff, stagedDiff] = await Promise.all([
    collectCommandTimeline(input.protocolPath, input.repositoryPath),
    Promise.resolve(git(input.repositoryPath, ["rev-parse", "HEAD"])),
    Promise.resolve(git(input.repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"])),
    Promise.resolve(git(input.repositoryPath, ["rev-list", "--count", `${input.preHead}..HEAD`])),
    Promise.resolve(git(input.repositoryPath, ["diff", "--no-ext-diff", "--stat"])),
    Promise.resolve(git(input.repositoryPath, ["diff", "--cached", "--no-ext-diff", "--stat"])),
  ]);
  const commitsSinceAttemptStart = Number(commitCount);
  if (!Number.isSafeInteger(commitsSinceAttemptStart) || commitsSinceAttemptStart < 0)
    throw new Error("git rev-list returned an invalid commit count");
  const verifier = input.lastVerifier;
  if (verifier !== undefined && verifier !== null &&
    (!Number.isSafeInteger(verifier.exitCode) || verifier.exitCode < 0))
    throw new Error("last verifier exit code must be a non-negative integer");
  const hypotheses = (input.previousHypotheses ?? []).map((hypothesis) => {
    if (typeof hypothesis !== "string")
      throw new Error("previous hypotheses must be strings");
    return bounded(hypothesis, MAX_HYPOTHESIS_BYTES);
  }).slice(0, 4);
  return {
    version: 1,
    commandTimeline: timeline,
    lastVerifier: verifier === undefined || verifier === null
      ? null
      : {
          exitCode: verifier.exitCode,
          output: bounded(verifier.output, MAX_VERIFIER_BYTES),
          ...(verifier.timedOut === undefined ? {} : { timedOut: verifier.timedOut }),
          ...(verifier.outputLimited === undefined
            ? {}
            : { outputLimited: verifier.outputLimited }),
        },
    git: {
      head: currentHead,
      status: bounded(currentStatus, MAX_STATUS_BYTES),
      commitsSinceAttemptStart,
      diffSummary: bounded(
        [
          "working tree diffstat:",
          workingDiff || "(none)",
          "staged diffstat:",
          stagedDiff || "(none)",
        ].join("\n"),
        MAX_DIFF_SUMMARY_BYTES,
      ),
    },
    previousHypotheses: hypotheses,
    ...(input.failureReason === undefined
      ? {}
      : { failureReason: bounded(input.failureReason, MAX_FAILURE_REASON_BYTES) }),
    ...(input.taskBrief === undefined
      ? {}
      : { taskBrief: bounded(input.taskBrief, MAX_TASK_BRIEF_BYTES) }),
  };
}
