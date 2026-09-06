import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  diagnoseOwnership,
  processIdentityExists,
  processIdentityMatches,
  readOwnershipMetadata,
  reclaimStaleOwnership,
  RecoveryClaim,
  resolveWorktreeIdentity,
  type OwnershipDiagnosis,
  type OwnershipMetadata,
} from "./ownership.js";
import {
  readState,
  StateError,
  validateFrozenInputs,
  type State,
} from "./state.js";

export interface LegacyRunSummary {
  readonly runId: string;
  readonly status: "accepted" | "failed";
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly attempts: readonly unknown[];
}
export interface RecoveryInspection {
  readonly evidencePath: string;
  readonly legacySummary?: LegacyRunSummary;
  readonly resumable?: boolean;
  readonly state?: State;
  readonly ownership?: OwnershipDiagnosis;
  readonly git?: { head: string; ref: string; status: string };
  readonly blocked: readonly string[];
  readonly actions: readonly string[];
}
export interface RecoverOptions {
  readonly evidencePath: string;
  readonly apply?: boolean;
}
async function atomic(path: string, value: unknown) {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const h = await open(tmp, "w", 0o600);
  try {
    await h.writeFile(JSON.stringify(value, null, 2) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(tmp, path);
  const d = await open(dirname(path), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
function git(worktree: string, args: string[]) {
  const r = Bun.spawnSync(["git", "-C", worktree, ...args], {
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (r.exitCode !== 0)
    throw new Error(
      r.stderr.toString().trim() || `git ${args.join(" ")} failed`,
    );
  return r.stdout.toString().trim();
}
async function groupLive(pgid: number) {
  for (const e of await readdir("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = await readFile(`/proc/${e}/stat`, "utf8");
      const m = /^\d+ \(.*\) (\S) \d+ (\d+)/.exec(stat);
      if (m?.[1] !== "Z" && Number(m?.[2]) === pgid) return true;
    } catch {}
  }
  return false;
}

function legacySummary(value: unknown): LegacyRunSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const run = value as Record<string, unknown>;
  if (
    typeof run.runId !== "string" ||
    (run.status !== "accepted" && run.status !== "failed") ||
    typeof run.repositoryPath !== "string" ||
    typeof run.planPath !== "string" ||
    typeof run.startedAt !== "string" ||
    typeof run.finishedAt !== "string" ||
    !Array.isArray(run.attempts)
  )
    return undefined;
  return {
    runId: run.runId,
    status: run.status,
    repositoryPath: run.repositoryPath,
    planPath: run.planPath,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    attempts: run.attempts,
  };
}
async function inspectLegacy(
  evidencePath: string,
): Promise<RecoveryInspection> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(evidencePath, "run.json"), "utf8"),
    );
    const summary = legacySummary(parsed);
    if (!summary)
      return {
        evidencePath,
        blocked: ["invalid legacy run summary"],
        actions: [],
      };
    return {
      evidencePath,
      legacySummary: summary,
      resumable: false,
      blocked: [
        "legacy run summary has no durable state and cannot be resumed",
      ],
      actions: [],
    };
  } catch (error) {
    return {
      evidencePath,
      blocked: ["missing durable state and invalid legacy run summary"],
      actions: [],
    };
  }
}

async function inspect(evidencePath: string): Promise<RecoveryInspection> {
  const blocked: string[] = [];
  const actions: string[] = [];
  let state: State | undefined,
    ownership: OwnershipDiagnosis | undefined,
    g: RecoveryInspection["git"];
  if (!(await Bun.file(join(evidencePath, "state.json")).exists()))
    return inspectLegacy(evidencePath);
  try {
    state = await validateFrozenInputs(evidencePath);
  } catch (e) {
    blocked.push(
      e instanceof StateError
        ? e.message
        : `corrupt state: ${(e as Error).message}`,
    );
    return { evidencePath, blocked, actions };
  }
  try {
    g = {
      head: git(state.initial.worktree, ["rev-parse", "HEAD"]),
      ref: git(state.initial.worktree, [
        "rev-parse",
        "--symbolic-full-name",
        "HEAD",
      ]),
      status: git(state.initial.worktree, ["status", "--porcelain"]),
    };
    if (g.ref !== state.initial.ref) blocked.push("worktree ref drift");
  } catch (e) {
    blocked.push(`Git inspection failed: ${(e as Error).message}`);
  }
  try {
    ownership = await diagnoseOwnership(state.initial.worktree);
    if (ownership.state === "active")
      blocked.push("live controller or guard owns worktree");
    if (ownership.state === "blocked") blocked.push(ownership.reason);
    if (ownership.state === "recoverable")
      actions.push("reclaim stale ownership after group safety check");
  } catch (e) {
    blocked.push(`ownership inspection failed: ${(e as Error).message}`);
  }
  return {
    evidencePath,
    state,
    ...(ownership === undefined ? {} : { ownership }),
    ...(g === undefined ? {} : { git: g }),
    blocked,
    actions,
  };
}
export async function inspectRun(
  evidencePath: string,
): Promise<RecoveryInspection> {
  return inspect(evidencePath);
}
async function cleanRecordedGroup(
  metadata: OwnershipMetadata,
): Promise<string | undefined> {
  if (metadata.processGroupId === undefined) return;
  const leader = metadata.processGroupLeader;
  if (leader === undefined || !(await processIdentityExists(leader)))
    return (await groupLive(metadata.processGroupId))
      ? "group leader is missing or reused while numeric group remains live"
      : undefined;
  try {
    process.kill(-leader.pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  const deadline = Date.now() + 2_000;
  while ((await groupLive(metadata.processGroupId)) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  if (await groupLive(metadata.processGroupId)) {
    try {
      process.kill(-leader.pid, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
  const killDeadline = Date.now() + 2_000;
  while (
    (await groupLive(metadata.processGroupId)) &&
    Date.now() < killDeadline
  )
    await new Promise((r) => setTimeout(r, 20));
  return (await groupLive(metadata.processGroupId))
    ? "owned process group remains live after TERM/KILL"
    : undefined;
}
export async function recoverRun(
  options: RecoverOptions,
): Promise<RecoveryInspection> {
  const preview = await inspect(options.evidencePath);
  if (!options.apply) return preview;
  if (
    !preview.state ||
    !preview.ownership ||
    preview.blocked.some((x) => !x.startsWith("recorded guard is dead"))
  )
    return preview;
  const claim = await RecoveryClaim.acquire(preview.state.initial.worktree);
  try {
    const current = await inspect(options.evidencePath);
    if (
      !current.state ||
      !current.ownership ||
      !(
        current.ownership.state === "recoverable" ||
        (current.ownership.state === "blocked" &&
          current.ownership.reason.startsWith("recorded guard is dead"))
      )
    )
      return current;
    const metadata = await readOwnershipMetadata(
      current.state.initial.worktree,
    );
    if (!metadata) {
      return {
        ...current,
        blocked: [...current.blocked, "ownership metadata vanished"],
      };
    }
    if (await processIdentityMatches(metadata.controller)) {
      return {
        ...current,
        blocked: [...current.blocked, "live controller refuses recovery"],
      };
    }
    const unsafe = await cleanRecordedGroup(metadata);
    if (unsafe) return { ...current, blocked: [...current.blocked, unsafe] };
    await reclaimStaleOwnership(current.state.initial.worktree, metadata.token);
    const report = {
      at: new Date().toISOString(),
      kind: "recovery",
      applied: true,
      runId: current.state.runId,
      actions: ["reclaimed stale ownership"],
      reservedAttempts: current.state.reservedAttempts,
    };
    await atomic(join(options.evidencePath, "recovery.json"), report);
    return await inspect(options.evidencePath);
  } finally {
    await claim.release();
  }
}
