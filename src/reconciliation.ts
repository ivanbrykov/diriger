import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { State } from "./state.js";

export type ReconciliationAction =
  | "reuse-accepted"
  | "finalize-verified"
  | "rerun-verifier"
  | "verify-candidate"
  | "fresh-repair"
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
  const target = state.candidateHead ?? state.initial.head;
  if (ref !== state.initial.ref)
    return { action: "blocked", reason: "branch drift" };
  if (!descendant(w, state.initial.head, target))
    return { action: "terminal", reason: "worker history violation" };
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
      (await verificationProof(evidencePath, state, target, ref))
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
      (await verificationProof(evidencePath, state, target, ref))
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
    if (head !== state.initial.head && descendant(w, state.initial.head, head))
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
