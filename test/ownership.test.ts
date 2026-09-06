import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  OwnershipLock,
  OwnershipError,
  currentProcessIdentity,
  diagnoseOwnership,
  resolveWorktreeIdentity,
} from "../src/ownership.js";

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "owner-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.email", "a@b"]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.name", "a"]);
  return dir;
}
describe("worktree ownership", () => {
  test("canonicalizes a subdirectory and symlink to one per-worktree lock", async () => {
    const dir = await repo();
    const link = join(dirname(dir), "owner-link-" + crypto.randomUUID());
    try {
      await mkdir(join(dir, "nested"));
      await symlink(dir, link);
      const a = await resolveWorktreeIdentity(join(dir, "nested"));
      expect(a.worktree).toBe(dir);
      const lock = await OwnershipLock.acquire(dir, join(dir, "evidence"));
      await expect(
        OwnershipLock.acquire(link, join(dir, "other")),
      ).rejects.toBeInstanceOf(OwnershipError);
      expect(
        await readFile(join(a.lockPath, "metadata.json"), "utf8"),
      ).toContain(lock.token);
      await lock.release();
      expect((await diagnoseOwnership(dir)).state).toBe("free");
    } finally {
      await rm(link, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("does not release a group-bearing lock without cleanup proof", async () => {
    const dir = await repo();
    try {
      const lock = await OwnershipLock.acquire(dir, join(dir, "e"));
      const leader = await currentProcessIdentity();
      await lock.recordGuard(
        { pid: 999999, bootId: "old", startTicks: "0" },
        leader,
      );
      await expect(lock.release()).rejects.toBeInstanceOf(OwnershipError);
      expect((await diagnoseOwnership(dir)).state).toBe("blocked");
      await lock.proveCleanup(leader.pid, leader);
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("stale token cannot release a later lock", async () => {
    const dir = await repo();
    try {
      const a = await OwnershipLock.acquire(dir, join(dir, "e"));
      await a.release();
      const b = await OwnershipLock.acquire(dir, join(dir, "e"));
      await expect(a.release()).rejects.toBeInstanceOf(OwnershipError);
      await b.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("linked worktrees have independent ownership locks", async () => {
    const dir = await repo();
    const linked = join(tmpdir(), "owner-linked-" + crypto.randomUUID());
    try {
      await writeFile(join(dir, "seed"), "x");
      Bun.spawnSync(["git", "-C", dir, "add", "seed"]);
      Bun.spawnSync(["git", "-C", dir, "commit", "-qm", "seed"]);
      expect(
        Bun.spawnSync([
          "git",
          "-C",
          dir,
          "worktree",
          "add",
          "-q",
          "-b",
          "linked",
          linked,
        ]).exitCode,
      ).toBe(0);
      const a = await OwnershipLock.acquire(dir, join(dir, "e"));
      const b = await OwnershipLock.acquire(linked, join(linked, "e"));
      expect(a.identity.lockPath).not.toBe(b.identity.lockPath);
      await a.release();
      await b.release();
    } finally {
      Bun.spawnSync([
        "git",
        "-C",
        dir,
        "worktree",
        "remove",
        "--force",
        linked,
      ]);
      await rm(linked, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("concurrent acquisition has exactly one owner", async () => {
    const dir = await repo();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          OwnershipLock.acquire(dir, join(dir, "e")),
        ),
      );
      const wins = results.filter(
        (r): r is PromiseFulfilledResult<OwnershipLock> =>
          r.status === "fulfilled",
      );
      expect(wins).toHaveLength(1);
      await wins[0]!.value.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
