import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { State } from "./state.js";
import { readWorkerReportBytes, type WorkerReport } from "./worker-report.js";

export type ReconciliationAction =
  | "reuse-accepted"
  | "finalize-verified"
  | "rerun-verifier"
  | "verify-candidate"
  | "fresh-repair"
  | "task-blocked"
  | "terminal"
  | "blocked";
export interface Reconciliation {
  readonly action: ReconciliationAction;
  readonly reason: string;
  readonly candidateHead?: string;
}
function git(w: string, args: string[]) {
  const r = Bun.spawnSync(["git", "-C", w, ...args], {
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}
const clean = (w: string) => git(w, ["status", "--porcelain"]) === "";
const descendant = (w: string, a: string, b: string) =>
  git(w, ["merge-base", "--is-ancestor", a, b]) !== undefined &&
  git(w, ["rev-list", "--merges", `${a}..${b}`]) === "";
type Ref = { path: string; sha256: string; bytes: number };
type VerificationProof = {
  version: 1;
  candidateHead: string;
  headAfter: string;
  refAfter: string;
  statusAfter: string;
  exitCode: number;
  timedOut: boolean;
  command: readonly string[];
  startedAt: string;
  finishedAt: string;
};
function ref(v: unknown): v is Ref {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Ref).path === "string" &&
    typeof (v as Ref).sha256 === "string" &&
    typeof (v as Ref).bytes === "number"
  );
}
function proof(v: unknown): v is VerificationProof {
  const x = v as Partial<VerificationProof>;
  return (
    !!x &&
    x.version === 1 &&
    typeof x.candidateHead === "string" &&
    typeof x.headAfter === "string" &&
    typeof x.refAfter === "string" &&
    typeof x.statusAfter === "string" &&
    typeof x.exitCode === "number" &&
    typeof x.timedOut === "boolean" &&
    Array.isArray(x.command) &&
    x.command.every((y) => typeof y === "string") &&
    typeof x.startedAt === "string" &&
    typeof x.finishedAt === "string"
  );
}
async function verificationFailure(root: string, s: State): Promise<boolean> {
  const artifact = (s.verification as { artifact?: unknown } | undefined)
    ?.artifact;
  if (!ref(artifact)) return false;
  try {
    const b = await readFile(`${root}/${artifact.path}`);
    if (
      b.byteLength !== artifact.bytes ||
      createHash("sha256").update(b).digest("hex") !== artifact.sha256
    )
      return false;
    const v: unknown = JSON.parse(new TextDecoder().decode(b));
    return (
      proof(v) &&
      ((v as VerificationProof).exitCode !== 0 ||
        (v as VerificationProof).timedOut)
    );
  } catch {
    return false;
  }
}
function attemptFailed(s: State) {
  const a = s.attempt as Record<string, unknown> | undefined;
  return (
    a?.timedOut === true ||
    a?.timeout === true ||
    a?.protocolError === true ||
    a?.deadlineExceeded === true
  );
}
async function verificationProof(
  root: string,
  s: State,
  target: string,
  refname: string,
) {
  const artifact = (s.verification as { artifact?: unknown } | undefined)
    ?.artifact;
  if (!ref(artifact)) return false;
  try {
    const b = await readFile(`${root}/${artifact.path}`);
    if (
      b.byteLength !== artifact.bytes ||
      createHash("sha256").update(b).digest("hex") !== artifact.sha256
    )
      return false;
    const value: unknown = JSON.parse(new TextDecoder().decode(b));
    if (
      !proof(value) ||
      value.exitCode !== 0 ||
      value.timedOut ||
      value.candidateHead !== target ||
      value.headAfter !== target ||
      value.refAfter !== refname ||
      value.statusAfter !== ""
    )
      return false;
    return (s.completedAttempts ?? []).some((a) =>
      a.artifacts.some(
        (x) =>
          x.path === artifact.path &&
          x.sha256 === artifact.sha256 &&
          x.bytes === artifact.bytes,
      ),
    );
  } catch {
    return false;
  }
}

async function requiredWorkerReport(root: string, s: State): Promise<boolean> {
  try {
    const config: unknown = JSON.parse(
      await readFile(join(root, s.inputs.config.path), "utf8"),
    );
    return (
      !!config &&
      typeof config === "object" &&
      (config as { workerReportRequired?: unknown }).workerReportRequired ===
        true
    );
  } catch {
    // Frozen states created before structured outcomes are compatibility mode.
    return false;
  }
}

function reportRef(s: State): Ref | undefined {
  const attempt = s.attempt as { workerReportArtifact?: unknown } | undefined;
  if (ref(attempt?.workerReportArtifact)) return attempt.workerReportArtifact;
  const completed = (s.completedAttempts ?? []).find(
    (entry) => entry.attempt === s.reservedAttempts,
  );
  return completed?.artifacts.find((artifact) =>
    artifact.path.endsWith("/worker-report.json"),
  );
}

/**
 * The deterministic artifact fallback closes the crash window between writing a
 * report snapshot and recording its reference in state.  It is never enough to
 * accept a complete outcome; it only preserves a blocked worker's decision.
 */
async function workerReport(
  root: string,
  s: State,
): Promise<
  | { readonly report: WorkerReport; readonly durable: boolean; readonly pending: boolean }
  | { readonly error: string }
  | undefined
> {
  const reference = reportRef(s);
  const artifactPath = join(
    root,
    "attempts",
    String(s.reservedAttempts).padStart(3, "0"),
    "worker-report.json",
  );
  let path = reference === undefined ? artifactPath : join(root, reference.path);
  try {
    let value: Awaited<ReturnType<typeof readWorkerReportBytes>>;
    try {
      value = await readWorkerReportBytes(path);
    } catch (error) {
      if (reference !== undefined) throw error;
      path = join(root, `attempt-${s.reservedAttempts}-report.json`);
      value = await readWorkerReportBytes(path);
    }
    const { report, bytes } = value;
    if (
      reference !== undefined &&
      (bytes.byteLength !== reference.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
    )
      return { error: "worker report artifact drift" };
    return {
      report,
      durable: reference !== undefined,
      pending: reference === undefined && path !== artifactPath,
    };
  } catch (error) {
    if (reference !== undefined)
      return {
        error:
          "invalid worker report: " +
          (error instanceof Error ? error.message : String(error)),
      };
    return undefined;
  }
}

async function completeReportProof(root: string, s: State): Promise<boolean> {
  const outcome = await workerReport(root, s);
  return (
    outcome !== undefined &&
    "report" in outcome &&
    outcome.durable &&
    outcome.report.status === "complete" &&
    outcome.report.knownGaps.length === 0
  );
}

function normalRecordedWorker(state: State): boolean {
  const attempt = state.attempt as
    | { worker?: { exitCode?: unknown; terminationReason?: unknown; resultUnavailable?: unknown } }
    | undefined;
  const worker = attempt?.worker;
  const protocol = state.protocol as
    | { error?: unknown; cleanupComplete?: unknown }
    | undefined;
  return (
    worker?.exitCode === 0 &&
    worker.terminationReason === undefined &&
    worker.resultUnavailable !== true &&
    (protocol === undefined ||
      (protocol.error === undefined && protocol.cleanupComplete === true))
  );
}
export async function reconcileRun(
  evidencePath: string,
  state: State,
  maxAttempts: number,
): Promise<Reconciliation> {
  const w = state.initial.worktree,
    head = git(w, ["rev-parse", "HEAD"]),
    ref = git(w, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  if (!head || !ref) return { action: "blocked", reason: "cannot inspect Git" };
  if (state.phase === "failed")
    return { action: "terminal", reason: "terminal failure recorded" };
  if (state.phase === "task_blocked")
    return { action: "task-blocked", reason: "task blocked outcome recorded" };
  const reportRequired = await requiredWorkerReport(evidencePath, state);
  const outcome = reportRequired
    ? await workerReport(evidencePath, state)
    : undefined;
  const target = state.candidateHead ?? state.initial.head;
  if (ref !== state.initial.ref)
    return { action: "blocked", reason: "branch drift" };
  if (!descendant(w, state.initial.head, head))
    return { action: "terminal", reason: "current worktree history violation" };
  if (!descendant(w, state.initial.head, target))
    return { action: "terminal", reason: "worker history violation" };
  if (outcome !== undefined && "error" in outcome)
    return { action: "blocked", reason: outcome.error };
  if (
    ["verifying", "verified"].includes(state.phase) &&
    (head !== target || !clean(w))
  )
    return { action: "blocked", reason: "verifier candidate drift" };
  const veto = outcome !== undefined && "report" in outcome &&
    (outcome.report.status === "blocked" || outcome.report.knownGaps.length > 0);
  if (veto && outcome !== undefined && "report" in outcome) {
    if (state.phase === "accepted")
      return { action: "blocked", reason: "accepted checkpoint conflicts with worker report" };
    if (!normalRecordedWorker(state) || attemptFailed(state))
      return { action: "blocked", reason: "worker report veto exists but normal completion is not durably proven" };
    if (outcome.report.status === "complete" && (!clean(w) || head === state.initial.head))
      return { action: "blocked", reason: "complete report conflicts with unfinished candidate" };
    return {
      action: "task-blocked",
      reason: outcome.report.status === "blocked"
        ? outcome.report.blocker!.decisionNeeded
        : "worker reported known gaps: " + outcome.report.knownGaps.join("; "),
    };
  }
  if (state.phase === "prepared") {
    if (head !== state.initial.head || !clean(w))
      return { action: "blocked", reason: "prepared state drift" };
    return state.reservedAttempts >= maxAttempts
      ? { action: "terminal", reason: "attempt budget exhausted" }
      : { action: "fresh-repair", reason: "prepared and clean" };
  }
  if (state.phase === "accepted") {
    return head === target &&
      clean(w) &&
      (await verificationProof(evidencePath, state, target, ref)) &&
      (!reportRequired || (await completeReportProof(evidencePath, state)))
      ? {
          action: "reuse-accepted",
          reason: "accepted exact candidate",
          candidateHead: target,
        }
      : {
          action: "blocked",
          reason: "accepted checkpoint drift or invalid verification proof",
        };
  }
  if (state.phase === "verified") {
    return head === target &&
      clean(w) &&
      (await verificationProof(evidencePath, state, target, ref)) &&
      (!reportRequired || (await completeReportProof(evidencePath, state)))
      ? {
          action: "finalize-verified",
          reason: "verified exact candidate",
          candidateHead: target,
        }
      : {
          action: "blocked",
          reason: "verified checkpoint drift or invalid verification proof",
        };
  }
  if (state.phase === "verifying") {
    if (!head || head !== target || !clean(w))
      return { action: "blocked", reason: "verifier candidate drift" };
    if (reportRequired && !(await completeReportProof(evidencePath, state)))
      return state.reservedAttempts < maxAttempts
        ? { action: "fresh-repair", reason: "missing or invalid worker report" }
        : { action: "terminal", reason: "attempt budget exhausted without valid worker report" };
    if (await verificationFailure(evidencePath, state))
      return state.reservedAttempts < maxAttempts
        ? { action: "fresh-repair", reason: "durable verifier failure" }
        : {
            action: "terminal",
            reason: "attempt budget exhausted after verifier failure",
          };
    return {
      action: "rerun-verifier",
      reason: "missing verifier result at exact candidate",
      candidateHead: target,
    };
  }
  if (
    ["worker_starting", "worker_running", "worker_finished"].includes(
      state.phase,
    )
  ) {
    if (attemptFailed(state))
      return state.reservedAttempts < maxAttempts
        ? {
            action: "fresh-repair",
            reason: "recorded worker timeout or protocol failure",
          }
        : {
            action: "terminal",
            reason: "attempt budget exhausted after worker failure",
          };
    if (!clean(w))
      return state.reservedAttempts < maxAttempts
        ? { action: "fresh-repair", reason: "dirty interrupted work preserved" }
        : { action: "terminal", reason: "attempt budget exhausted" };
    if (
      head !== state.initial.head &&
      descendant(w, state.initial.head, head) &&
      (!reportRequired || (await completeReportProof(evidencePath, state)))
    )
      return {
        action: "verify-candidate",
        reason: "unrecorded clean descendant",
        candidateHead: head,
      };
    return state.reservedAttempts < maxAttempts
      ? { action: "fresh-repair", reason: "no completed worker result" }
      : { action: "terminal", reason: "attempt budget exhausted" };
  }
  return { action: "blocked", reason: "unrecognized recovery state" };
}
