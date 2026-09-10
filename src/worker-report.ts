import { constants } from "node:fs";
import { open } from "node:fs/promises";

export interface WorkerReport {
  readonly version: 1;
  readonly status: "complete" | "blocked";
  readonly summary: string;
  readonly knownGaps: readonly string[];
  readonly decisions: readonly string[];
  readonly validation: readonly string[];
  readonly blocker?: {
    readonly assumption: string;
    readonly evidence: readonly string[];
    readonly attemptedApproaches: readonly string[];
    readonly smallestAlternative: string;
    readonly decisionNeeded: string;
  };
}

const MAX_REPORT_BYTES = 64 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 8192;
const list = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 100 && value.every(text);
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseWorkerReport(value: unknown): WorkerReport {
  if (
    !object(value) || !keys(value, ["version", "status", "summary", "knownGaps", "decisions", "validation", "blocker"]) ||
    value.version !== 1 || (value.status !== "complete" && value.status !== "blocked") ||
    !text(value.summary) || !list(value.knownGaps) || !list(value.decisions) || !list(value.validation)
  ) throw new Error("invalid structured worker report");
  if (value.status === "blocked") {
    const b = value.blocker;
    if (!object(b) || !keys(b, ["assumption", "evidence", "attemptedApproaches", "smallestAlternative", "decisionNeeded"]) ||
      !text(b.assumption) || !list(b.evidence) || b.evidence.length === 0 ||
      !list(b.attemptedApproaches) || b.attemptedApproaches.length === 0 ||
      !text(b.smallestAlternative) || !text(b.decisionNeeded))
      throw new Error("blocked worker report requires supported blocker details");
  } else if (Object.hasOwn(value, "blocker")) {
    throw new Error("complete worker report cannot contain a blocker");
  }
  return value as unknown as WorkerReport;
}

/** Read only a bounded regular file after all worker writers have stopped. */
export async function readWorkerReportBytes(path: string): Promise<{ report: WorkerReport; bytes: Uint8Array }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_REPORT_BYTES)
      throw new Error("worker report must be a regular file of at most 64 KiB");
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_REPORT_BYTES) throw new Error("worker report exceeds 64 KiB");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    } catch {
      throw new Error("worker report is not valid UTF-8 JSON");
    }
    return { report: parseWorkerReport(parsed), bytes: buffer.subarray(0, length) };
  } finally {
    await file.close();
  }
}

export async function readWorkerReport(path: string): Promise<WorkerReport> {
  return (await readWorkerReportBytes(path)).report;
}

export function investigationSeconds(workerTimeoutMs: number): number {
  return Math.max(0, Math.min(300, workerTimeoutMs / 4000));
}

export function workerJudgmentInstructions(reportPath: string, allowanceSeconds: number): string {
  return [
    "Prefer established platform/framework capabilities, then focused maintained libraries. Verify support in the target runtime before writing custom mechanisms.",
    "Treat suggested implementations as hypotheses. Challenge them with concrete evidence; distinguish suggestions from hard constraints. Choose justified alternatives within your authority and report deviations.",
    `Investigate uncertainty for at most ${allowanceSeconds} seconds in total within this attempt, or the plan's smaller allowance. This is part of the existing worker deadline, not extra time.`,
    "When a foundational decision remains unresolved, the solution seems unsafe/infeasible, or a required change exceeds your authority, stop and report blocked. Preserve useful work; do not fabricate a success commit or repeat the same investigation without new evidence.",
    "Report known gaps even if all prescribed tests pass. Inspect omitted interactions, framework defaults, cleanup, errors, and test isolation.",
    `Before ending the session, write one UTF-8 JSON object (not Markdown) to ${JSON.stringify(reportPath)}. This is the sole allowed report output outside the supplied repository. Do not modify any other supervisor evidence or verifier inputs. Maximum report size: 64 KiB.`,
    'Report schema: {"version":1,"status":"complete"|"blocked","summary":"...","knownGaps":["..."],"decisions":["..."],"validation":["..."]}. Use empty arrays when none; do not omit fields.',
    'For status "blocked", also include "blocker":{"assumption":"questionable assumption or conflicting constraint","evidence":["what was checked and observed"],"attemptedApproaches":["bounded checks attempted"],"smallestAlternative":"smallest viable alternative, or why none is known","decisionNeeded":"specific caller decision or missing authority"}. Describe changed files and test state in summary/validation. No blocker field for status "complete".',
    "After writing either report, finish the session normally (ACP end_turn). Do not signal task blockage by crashing, timing out, or returning a protocol error.",
    "For complete work, leave a clean new descendant commit on the original branch. Blocked work may remain uncommitted. Never use completion status to conceal known gaps. The supervisor parses this file, not your prose; a complete report cannot replace independent verification.",
  ].join("\n");
}
