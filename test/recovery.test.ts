import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFrozenRun } from "../src/state.js";
import { OwnershipLock, RecoveryClaim } from "../src/ownership.js";
import { inspectRun, recoverRun } from "../src/recovery.js";
async function fixture() {
  const d = await mkdtemp(join(tmpdir(), "recover-"));
  Bun.spawnSync(["git", "init", "-q", d]);
  Bun.spawnSync(["git", "-C", d, "config", "user.email", "a@b"]);
  Bun.spawnSync(["git", "-C", d, "config", "user.name", "a"]);
  await writeFile(join(d, "p"), "p");
  await writeFile(join(d, "v"), "v");
  Bun.spawnSync(["git", "-C", d, "add", "."]);
  Bun.spawnSync(["git", "-C", d, "commit", "-qm", "initial"]);
  const e = join(tmpdir(), "recover-e-" + crypto.randomUUID());
  await createFrozenRun({
    evidencePath: e,
    runId: "r",
    resolvedConfig: {},
    initial: {
      head: Bun.spawnSync(["git", "-C", d, "rev-parse", "HEAD"])
        .stdout.toString()
        .trim(),
      ref: Bun.spawnSync([
        "git",
        "-C",
        d,
        "rev-parse",
        "--symbolic-full-name",
        "HEAD",
      ])
        .stdout.toString()
        .trim(),
      worktree: d,
    },
    planPath: join(d, "p"),
    verifier: {
      argv: ["sh"],
      cwd: d,
      entryPath: join(d, "v"),
      selfContained: true,
    },
  });
  return { d, e };
}
test("inspect blocks corrupt frozen state", async () => {
  const { d, e } = await fixture();
  try {
    await writeFile(join(e, "state.json"), "{");
    expect((await inspectRun(e)).blocked.join()).toContain(
      "cannot read durable state",
    );
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});
test("live controller recovery is read-only and refused", async () => {
  const { d, e } = await fixture();
  try {
    const lock = await OwnershipLock.acquire(d, e);
    const r = await recoverRun({ evidencePath: e, apply: true });
    expect(r.blocked.join()).toContain("live controller");
    await lock.release();
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});
test("live controller with dead guard is never reclaimed", async () => {
  const { d, e } = await fixture();
  try {
    const lock = await OwnershipLock.acquire(d, e);
    await lock.recordGuard({ pid: 999999, bootId: "old", startTicks: "0" });
    const r = await recoverRun({ evidencePath: e, apply: true });
    expect(r.ownership?.state).toBe("blocked");
    expect((await inspectRun(e)).ownership?.state).toBe("blocked");
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});
test("concurrent recovery claims permit one reclaim", async () => {
  const { d, e } = await fixture();
  try {
    const lock = await OwnershipLock.acquire(d, e);
    await lock.recordGuard({ pid: 999999, bootId: "old", startTicks: "0" });
    const mp = join(lock.identity.lockPath, "metadata.json");
    const raw = JSON.parse(await readFile(mp, "utf8"));
    raw.controller = { pid: 999998, bootId: "old", startTicks: "0" };
    await writeFile(mp, JSON.stringify(raw));
    const claim = await RecoveryClaim.acquire(d);
    await expect(
      recoverRun({ evidencePath: e, apply: true }),
    ).rejects.toBeInstanceOf(Error);
    expect((await inspectRun(e)).ownership?.state).toBe("blocked");
    await claim.release();
    await recoverRun({ evidencePath: e, apply: true });
    expect((await inspectRun(e)).ownership?.state).toBe("free");
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});

test("legacy accepted summary is readable but never resumable", async () => {
  const d = await mkdtemp(join(tmpdir(), "legacy-"));
  try {
    const e = join(d, "e");
    await Bun.write(
      join(d, "run.json"),
      JSON.stringify({
        runId: "legacy",
        status: "accepted",
        repositoryPath: d,
        planPath: join(d, "p"),
        startedAt: "2020-01-01T00:00:00.000Z",
        finishedAt: "2020-01-01T00:01:00.000Z",
        attempts: [],
      }),
    );
    const before = await readFile(join(d, "run.json"));
    const inspected = await inspectRun(d);
    expect(inspected.legacySummary?.status).toBe("accepted");
    expect(inspected.resumable).toBeFalse();
    await recoverRun({ evidencePath: d, apply: true });
    expect(await readFile(join(d, "run.json"))).toEqual(before);
    expect(await Bun.file(join(d, "state.json")).exists()).toBeFalse();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("corrupt state never falls back to legacy summary", async () => {
  const d = await mkdtemp(join(tmpdir(), "legacy-corrupt-"));
  try {
    await writeFile(join(d, "state.json"), "{");
    await Bun.write(
      join(d, "run.json"),
      JSON.stringify({
        runId: "legacy",
        status: "failed",
        repositoryPath: d,
        planPath: "p",
        startedAt: "2020-01-01T00:00:00.000Z",
        finishedAt: "2020-01-01T00:01:00.000Z",
        attempts: [],
      }),
    );
    const inspected = await inspectRun(d);
    expect(inspected.legacySummary).toBeUndefined();
    expect(inspected.blocked.join()).toContain("cannot read durable state");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
