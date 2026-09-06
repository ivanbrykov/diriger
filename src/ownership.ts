import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface ProcessIdentity {
  readonly pid: number;
  readonly bootId: string;
  readonly startTicks: string;
}

export interface OwnershipMetadata {
  readonly version: 1;
  readonly token: string;
  readonly worktree: string;
  readonly evidencePath: string;
  readonly hostname: string;
  readonly controller: ProcessIdentity;
  readonly createdAt: string;
  readonly guard?: ProcessIdentity;
  readonly processGroupId?: number;
  readonly processGroupLeader?: ProcessIdentity;
  readonly cleanupProven?: true;
}

export type OwnershipDiagnosis =
  | { readonly state: "free" }
  | { readonly state: "active"; readonly metadata: OwnershipMetadata }
  | { readonly state: "recoverable"; readonly metadata: OwnershipMetadata }
  | {
      readonly state: "blocked";
      readonly reason: string;
      readonly metadata?: OwnershipMetadata;
    };

export class OwnershipError extends Error {
  constructor(
    message: string,
    readonly diagnosis: OwnershipDiagnosis,
  ) {
    super(message);
  }
}

async function bootId(): Promise<string> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

// Field 22 of proc(5) stat.  The command name may contain spaces and ')', so
// parse only after its final closing parenthesis.
interface ProcessSnapshot {
  readonly state: string;
  readonly startTicks: string;
}

async function processSnapshot(
  pid: number,
): Promise<ProcessSnapshot | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const state = fields[0];
    const startTicks = fields[19];
    if (state === undefined || startTicks === undefined) return undefined;
    return { state, startTicks };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function currentProcessIdentity(
  pid = process.pid,
): Promise<ProcessIdentity> {
  const snapshot = await processSnapshot(pid);
  if (snapshot === undefined)
    throw new Error(`process ${pid} disappeared while identifying it`);
  return { pid, bootId: await bootId(), startTicks: snapshot.startTicks };
}

export async function processIdentityMatches(
  identity: ProcessIdentity,
): Promise<boolean> {
  if (identity.bootId !== (await bootId())) return false;
  const snapshot = await processSnapshot(identity.pid);
  return (
    snapshot !== undefined &&
    snapshot.state !== "Z" &&
    snapshot.startTicks === identity.startTicks
  );
}

// For a process-group leader, a zombie still anchors its PID until reaped, so
// callers may safely use this stronger identity check before addressing -PGID.
export async function processIdentityExists(
  identity: ProcessIdentity,
): Promise<boolean> {
  if (identity.bootId !== (await bootId())) return false;
  return (
    (await processSnapshot(identity.pid))?.startTicks === identity.startTicks
  );
}

async function gitIdentity(
  worktree: string,
): Promise<{ root: string; gitDir: string }> {
  const root = Bun.spawnSync([
    "git",
    "-C",
    worktree,
    "rev-parse",
    "--show-toplevel",
  ]);
  const git = Bun.spawnSync([
    "git",
    "-C",
    worktree,
    "rev-parse",
    "--absolute-git-dir",
  ]);
  if (root.exitCode !== 0 || git.exitCode !== 0)
    throw new Error(`cannot resolve Git identity for ${worktree}`);
  return {
    root: await realpath(root.stdout.toString().trim()),
    gitDir: await realpath(git.stdout.toString().trim()),
  };
}

export interface WorktreeIdentity {
  readonly worktree: string;
  readonly gitDir: string;
  readonly lockPath: string;
}

export async function resolveWorktreeIdentity(
  worktree: string,
): Promise<WorktreeIdentity> {
  const value = await gitIdentity(await realpath(worktree));
  return {
    worktree: value.root,
    gitDir: value.gitDir,
    // Retain the shared lock namespace so pre-rename releases cannot run concurrently.
    lockPath: join(value.gitDir, "goose-supervisor-ownership.lock"),
  };
}

function validIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(item.pid) &&
    (item.pid as number) > 0 &&
    typeof item.bootId === "string" &&
    item.bootId.length > 0 &&
    typeof item.startTicks === "string" &&
    /^\d+$/.test(item.startTicks)
  );
}

function validMetadata(value: unknown): value is OwnershipMetadata {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.token !== "string" ||
    item.token.length < 16 ||
    typeof item.worktree !== "string" ||
    typeof item.evidencePath !== "string" ||
    typeof item.hostname !== "string" ||
    typeof item.createdAt !== "string" ||
    !validIdentity(item.controller)
  )
    return false;
  if (item.guard !== undefined && !validIdentity(item.guard)) return false;
  if (
    item.processGroupId !== undefined &&
    (!Number.isSafeInteger(item.processGroupId) ||
      (item.processGroupId as number) <= 0)
  )
    return false;
  if (
    item.processGroupLeader !== undefined &&
    !validIdentity(item.processGroupLeader)
  )
    return false;
  if (
    item.processGroupId !== undefined &&
    item.processGroupLeader === undefined
  )
    return false;
  return item.cleanupProven === undefined || item.cleanupProven === true;
}

export async function readOwnershipMetadata(
  worktree: string,
): Promise<OwnershipMetadata | undefined> {
  return readMetadata((await resolveWorktreeIdentity(worktree)).lockPath);
}

async function readMetadata(
  lockPath: string,
): Promise<OwnershipMetadata | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(lockPath, "metadata.json"), "utf8"),
    );
    return validMetadata(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function diagnoseOwnership(
  worktree: string,
): Promise<OwnershipDiagnosis> {
  const identity = await resolveWorktreeIdentity(worktree);
  const metadata = await readMetadata(identity.lockPath);
  try {
    await stat(identity.lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "free" };
    throw error;
  }
  if (metadata === undefined)
    return {
      state: "blocked",
      reason: "ownership lock is empty, partial, or malformed",
    };
  const controllerLive = await processIdentityMatches(metadata.controller);
  // A cleanup proof closes the guard lifecycle. A later controller operation
  // may retain that historical identity until it releases the lock.
  if (metadata.cleanupProven === true && controllerLive)
    return { state: "active", metadata };
  if (
    metadata.guard !== undefined &&
    !(await processIdentityMatches(metadata.guard))
  )
    return {
      state: "blocked",
      reason: "recorded guard is dead or a zombie",
      metadata,
    };
  if (controllerLive) return { state: "active", metadata };
  if (
    metadata.guard !== undefined &&
    (await processIdentityMatches(metadata.guard))
  )
    return { state: "active", metadata };
  // A recorded group cannot be safely probed by numeric PGID: its leader may
  // have exited and the number can be reused. Explicit recovery must inspect it.
  if (metadata.processGroupId !== undefined && metadata.cleanupProven !== true)
    return {
      state: "blocked",
      reason: "controller and guard are gone; cleanup was not durably proven",
      metadata,
    };
  return { state: "recoverable", metadata };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const parent = await open(dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export class RecoveryClaim {
  readonly token = crypto.randomUUID();
  private constructor(readonly path: string) {}
  static async acquire(worktree: string): Promise<RecoveryClaim> {
    const identity = await resolveWorktreeIdentity(worktree);
    const path = join(identity.gitDir, "goose-supervisor-recovery.lock");
    // Normal acquisition checks this claim; a recoverer keeps it for all stale
    // lock inspection and mutation.
    await mkdir(path, { mode: 0o700 });
    const claim = new RecoveryClaim(path);
    await atomicJson(join(path, "metadata.json"), {
      token: claim.token,
      controller: await currentProcessIdentity(),
    });
    return claim;
  }
  async release(): Promise<void> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.path, "metadata.json"), "utf8"),
      ) as { token?: unknown };
      if (raw.token !== this.token)
        throw new OwnershipError("recovery claim replaced", {
          state: "blocked",
          reason: "recovery claim token mismatch",
        });
    } catch (error) {
      if (error instanceof OwnershipError) throw error;
      throw new OwnershipError("recovery claim metadata unavailable", {
        state: "blocked",
        reason: "recovery claim invalid",
      });
    }
    await rm(this.path, { recursive: true });
  }
}

export async function reclaimStaleOwnership(
  worktree: string,
  token: string,
): Promise<void> {
  const identity = await resolveWorktreeIdentity(worktree);
  const current = await readMetadata(identity.lockPath);
  if (current?.token !== token)
    throw new OwnershipError("stale ownership token changed", {
      state: "blocked",
      reason: "lock replaced",
    });
  await rm(identity.lockPath, { recursive: true });
}

export class OwnershipLock {
  readonly token: string;
  private constructor(
    readonly identity: WorktreeIdentity,
    readonly metadata: OwnershipMetadata,
  ) {
    this.token = metadata.token;
  }

  static async acquire(
    worktree: string,
    evidencePath: string,
  ): Promise<OwnershipLock> {
    const identity = await resolveWorktreeIdentity(worktree);
    const recoveryPath = join(
      identity.gitDir,
      "goose-supervisor-recovery.lock",
    );
    try {
      await stat(recoveryPath);
      throw new OwnershipError("worktree recovery is in progress", {
        state: "blocked",
        reason: "recovery claim active",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await mkdir(identity.lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const diagnosis = await diagnoseOwnership(worktree);
      throw new OwnershipError(
        `worktree ownership unavailable: ${diagnosis.state === "blocked" ? diagnosis.reason : diagnosis.state}`,
        diagnosis,
      );
    }
    try {
      await stat(recoveryPath);
      await rm(identity.lockPath, { recursive: true, force: true });
      throw new OwnershipError("worktree recovery began during acquisition", {
        state: "blocked",
        reason: "recovery claim active",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const metadata: OwnershipMetadata = {
      version: 1,
      token: crypto.randomUUID(),
      worktree: identity.worktree,
      evidencePath: await realpath(dirname(evidencePath))
        .then(async (parent) => join(parent, basename(evidencePath)))
        .catch(() => evidencePath),
      hostname: process.env.HOSTNAME ?? "unknown",
      controller: await currentProcessIdentity(),
      createdAt: new Date().toISOString(),
    };
    try {
      await atomicJson(join(identity.lockPath, "metadata.json"), metadata);
    } catch (error) {
      throw error;
    } // Leave the empty lock: fail closed after a partial acquire.
    return new OwnershipLock(identity, metadata);
  }

  async recordGuard(
    guard: ProcessIdentity,
    processGroup?: number | ProcessIdentity,
  ): Promise<void> {
    const current = await readMetadata(this.identity.lockPath);
    if (current?.token !== this.token)
      throw new OwnershipError("ownership token no longer matches", {
        state: "blocked",
        reason: "lock replaced",
      });
    const { cleanupProven: _oldProof, ...withoutProof } = current;
    const group = typeof processGroup === "number" ? undefined : processGroup;
    const groupPid =
      typeof processGroup === "number" ? processGroup : group?.pid;
    if (groupPid !== undefined && group === undefined)
      throw new OwnershipError("group leader identity is required", {
        state: "blocked",
        reason: "unanchored group",
      });
    const next: OwnershipMetadata = {
      ...withoutProof,
      guard,
      ...(groupPid === undefined
        ? {}
        : { processGroupId: groupPid, processGroupLeader: group! }),
    };
    await atomicJson(join(this.identity.lockPath, "metadata.json"), next);
    (this as { metadata: OwnershipMetadata }).metadata = next;
  }

  async proveCleanup(
    processGroupId: number,
    leader?: ProcessIdentity,
  ): Promise<void> {
    const current = await readMetadata(this.identity.lockPath);
    if (
      current?.token !== this.token ||
      current.processGroupId !== processGroupId ||
      (leader !== undefined &&
        current.processGroupLeader?.startTicks !== leader.startTicks)
    )
      throw new OwnershipError("cleanup token mismatch", {
        state: "blocked",
        reason: "token or group mismatch",
      });
    const next: OwnershipMetadata = { ...current, cleanupProven: true };
    await atomicJson(join(this.identity.lockPath, "metadata.json"), next);
    (this as { metadata: OwnershipMetadata }).metadata = next;
  }

  async release(): Promise<void> {
    const current = await readMetadata(this.identity.lockPath);
    if (current?.token !== this.token)
      throw new OwnershipError(
        "refusing to release a lock owned by another token",
        { state: "blocked", reason: "token mismatch" },
      );
    if (current.processGroupId !== undefined && current.cleanupProven !== true)
      throw new OwnershipError("refusing to release before cleanup", {
        state: "blocked",
        reason: "cleanup not proven",
        metadata: current,
      });
    await rm(this.identity.lockPath, { recursive: true });
  }
}
