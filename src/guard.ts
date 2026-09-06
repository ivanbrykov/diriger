import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  currentProcessIdentity,
  type OwnershipLock,
  type ProcessIdentity,
  processIdentityExists,
  processIdentityMatches,
} from "./ownership.js";

export interface GuardedLaunch {
  readonly process: Bun.Subprocess;
  readonly guard: ProcessIdentity;
  readonly authorizationPath: string;
  readonly launchPath: string;
  readonly childExited: Promise<number>;
  readonly waitForChild: () => Promise<number>;
  readonly cleanup: () => Promise<void>;
}

/** The wrapper was reaped before it durably recorded the target's exit. */
export class MissingGuardedChildResultError extends Error {
  constructor(readonly wrapperExitCode: number) {
    super("guarded wrapper exited before its child reported an exit");
    this.name = "MissingGuardedChildResultError";
  }
}

export interface GuardedLaunchOptions {
  readonly lock: OwnershipLock;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  // This directory is deliberately outside stdin/stdout: ACP frames remain
  // byte-for-byte on the child pipes while the guard uses file handshakes.
  readonly controlPath: string;
  readonly terminationGraceMs?: number;
  // Test and integration barrier: runs after durable intent and identities are
  // synced, immediately before the controller may make authorization visible.
  readonly beforeAuthorize?: () => Promise<void> | void;
}

interface LaunchRecord {
  readonly version: 1;
  readonly controller: ProcessIdentity;
  readonly group: ProcessIdentity;
  readonly authorizationPath: string;
  readonly graceMs: number;
  readonly readyPath: string;
  readonly cleanupPath: string;
  readonly resultPath: string;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const parent = await open(join(path, ".."), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

function signalOwnedGroup(groupPid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupPid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function groupHasLiveMembers(groupPid: number): Promise<boolean> {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const match = /^\d+ \(.*\) (\S) \d+ (\d+)/.exec(stat);
      if (match?.[1] !== "Z" && Number(match?.[2]) === groupPid) return true;
    } catch {
      /* process disappeared during scan */
    }
  }
  return false;
}

async function proveGroupQuiescent(groupPid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (await groupHasLiveMembers(groupPid)) {
    if (Date.now() >= deadline)
      throw new Error(
        `owned process group ${groupPid} remains live after cleanup`,
      );
    await sleep(20);
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await Bun.file(path).exists()) return true;
    await sleep(5);
  }
  return false;
}

// The wrapper is the detached process-group leader. It cannot exec the target
// until the guard has persisted authorization. Thus a controller death between
// spawn and authorization has no model/tool side effect.
async function workerMain(
  recordPath: string,
  command: ReadonlyArray<string>,
  cwd: string,
): Promise<never> {
  // The wrapper anchors the group through TERM-to-KILL escalation.
  process.on("SIGTERM", () => {});
  // A missing intent means the controller died during bootstrap. Do not leave a
  // detached, unauthorised wrapper around for the normal handshake timeout.
  if (!(await waitForFile(recordPath, 2_000))) process.exit(125);
  const record = JSON.parse(await readFile(recordPath, "utf8")) as LaunchRecord;
  const deadline = Date.now() + 30_000;
  while (!(await Bun.file(record.authorizationPath).exists())) {
    if (
      !(await processIdentityMatches(record.controller)) ||
      Date.now() >= deadline
    )
      process.exit(125);
    await sleep(5);
  }
  const child = Bun.spawn([...command], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Do not await an unbounded target while the controller/handshake disappears:
  // this wrapper is the last containment authority after guardian loss.
  while (child.exitCode === null) {
    if (
      !(await processIdentityMatches(record.controller)) ||
      !(await Bun.file(recordPath).exists())
    ) {
      await terminateAnchoredGroup(record);
      process.exit(125);
    }
    await sleep(10);
  }
  const exitCode = await child.exited;
  // Control storage may disappear with a crashed controller. That failure is
  // not permission to leave a detached group alive after its target completed.
  try {
    await writeFile(record.resultPath, `${exitCode}\n`, { mode: 0o600 });
  } catch {}
  // Stay group leader after the child exits while the controller is healthy.
  // If both controller and guard/control channel are gone, self-contain the
  // fallback: TERM descendants, then KILL the anchored group (including us).
  while (!(await Bun.file(record.cleanupPath).exists())) {
    if (!(await processIdentityMatches(record.controller))) {
      if (await processIdentityExists(record.group))
        signalOwnedGroup(record.group.pid, "SIGTERM");
      await sleep(record.graceMs);
      if (await processIdentityExists(record.group))
        signalOwnedGroup(record.group.pid, "SIGKILL");
      process.exit(125);
    }
    await sleep(10);
  }
  process.exit(0);
}

async function terminateAnchoredGroup(record: LaunchRecord): Promise<void> {
  if (!(await processIdentityExists(record.group))) return;
  if (signalOwnedGroup(record.group.pid, "SIGTERM")) {
    await sleep(record.graceMs);
    if (await processIdentityExists(record.group))
      signalOwnedGroup(record.group.pid, "SIGKILL");
  }
}

async function guardMain(recordPath: string): Promise<never> {
  const record = JSON.parse(await readFile(recordPath, "utf8")) as LaunchRecord;
  // A guard may authorize only after the controller persisted its identity in the lock.
  // Do not retain a live guard through the ready timeout if its controller died.
  const readyDeadline = Date.now() + 30_000;
  while (!(await Bun.file(record.readyPath).exists())) {
    if (
      !(await processIdentityMatches(record.controller)) ||
      Date.now() >= readyDeadline
    )
      process.exit(0);
    await sleep(5);
  }
  if (!(await processIdentityMatches(record.controller))) process.exit(0);
  await writeFile(record.authorizationPath, "authorized\n", { mode: 0o600 });
  while (await processIdentityMatches(record.controller)) {
    if (await Bun.file(record.cleanupPath).exists()) process.exit(0);
    await sleep(20);
  }
  await terminateAnchoredGroup(record);
  process.exit(0);
}

export async function launchGuarded(
  options: GuardedLaunchOptions,
): Promise<GuardedLaunch> {
  if (process.platform === "win32")
    throw new Error("guarded launch requires POSIX process groups");
  if (options.command.length === 0)
    throw new Error("guarded launch needs a command");
  await mkdir(options.controlPath, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID();
  const recordPath = join(options.controlPath, `launch-${nonce}.json`);
  const authorizationPath = join(options.controlPath, `authorize-${nonce}`);
  const readyPath = join(options.controlPath, `ready-${nonce}`);
  const cleanupPath = join(options.controlPath, `cleanup-${nonce}`);
  const resultPath = join(options.controlPath, `result-${nonce}`);
  // The wrapper retains the caller's stdin/stdout/stderr. Its detached group is
  // independent of the guard, so killing the guard cannot kill the controller.
  const wrapper = Bun.spawn(
    [
      process.execPath,
      new URL(import.meta.url).pathname,
      "--worker",
      recordPath,
      options.cwd,
      JSON.stringify(options.command),
    ],
    {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    },
  );
  const record: LaunchRecord = {
    version: 1,
    controller: await currentProcessIdentity(),
    group: await currentProcessIdentity(wrapper.pid),
    authorizationPath,
    readyPath,
    cleanupPath,
    resultPath,
    graceMs: options.terminationGraceMs ?? 2_000,
  };
  // Durable launch intent precedes guard authorization and target execution.
  await writeJson(recordPath, record);
  const guardProcess = Bun.spawn(
    [
      process.execPath,
      new URL(import.meta.url).pathname,
      "--guard",
      recordPath,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
  );
  const guard = await currentProcessIdentity(guardProcess.pid);
  await options.lock.recordGuard(guard, record.group);
  try {
    await options.beforeAuthorize?.();
  } catch (error) {
    // Authorization never became visible. Reap both detached helpers, retain
    // the unproven lock, and let recovery treat this as a conservative crash.
    await terminateAnchoredGroup(record);
    try {
      process.kill(-guard.pid, "SIGTERM");
    } catch {}
    await Promise.allSettled([wrapper.exited, guardProcess.exited]);
    await proveGroupQuiescent(record.group.pid);
    throw error;
  }
  await writeFile(readyPath, "ready\n", { mode: 0o600 });
  if (!(await waitForFile(authorizationPath, 2_000))) {
    if (await processIdentityExists(record.group))
      signalOwnedGroup(record.group.pid, "SIGKILL");
    throw new Error("guard did not authorize launch");
  }
  let settledWrapperExitCode: number | undefined;
  // Bun can leave exitCode null after this promise settles. Observe it once,
  // rather than adding a new reaction for every result-file polling interval.
  void wrapper.exited.then((exitCode) => {
    settledWrapperExitCode = exitCode;
  });
  const childExited = (async (): Promise<number> => {
    // The target has the caller's own deadline; this layer must not invent a
    // shorter wall clock. If cleanup kills the wrapper before it writes a
    // result, report that absence instead of manufacturing an exit code.
    while (true) {
      if (await Bun.file(resultPath).exists()) {
        const code = Number((await readFile(resultPath, "utf8")).trim());
        if (!Number.isInteger(code))
          throw new Error("guarded child reported an invalid exit code");
        return code;
      }
      if (settledWrapperExitCode !== undefined) {
        // A concurrent final write wins over the wrapper's exit observation.
        if (await Bun.file(resultPath).exists()) continue;
        throw new MissingGuardedChildResultError(settledWrapperExitCode);
      }
      await sleep(10);
    }
  })();
  // Cleanup may make the result unavailable; prevent an unobserved rejection
  // while preserving the same rejected promise for callers that await it.
  void childExited.catch(() => {});
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (cleanupPromise ??= (async () => {
      // Keep the wrapper alive as the verified group anchor through escalation.
      if (await processIdentityExists(record.group))
        signalOwnedGroup(record.group.pid, "SIGTERM");
      await sleep(record.graceMs);
      if (await processIdentityExists(record.group))
        signalOwnedGroup(record.group.pid, "SIGKILL");
      await writeFile(cleanupPath, "cleanup\n", { mode: 0o600 });
      await wrapper.exited;
      try {
        process.kill(-guard.pid, "SIGTERM");
      } catch {}
      await guardProcess.exited;
      await proveGroupQuiescent(record.group.pid);
      await options.lock.proveCleanup(record.group.pid, record.group);
    })());
  return {
    process: wrapper,
    guard,
    authorizationPath,
    launchPath: recordPath,
    childExited,
    waitForChild: () => childExited,
    cleanup,
  };
}

if (import.meta.main) {
  const [mode, recordPath, cwd, encodedCommand] = Bun.argv.slice(2);
  if (mode === "--guard" && recordPath !== undefined)
    await guardMain(recordPath);
  if (
    mode === "--worker" &&
    recordPath !== undefined &&
    cwd !== undefined &&
    encodedCommand !== undefined
  )
    await workerMain(recordPath, JSON.parse(encodedCommand) as string[], cwd);
  process.exitCode = 64;
}
