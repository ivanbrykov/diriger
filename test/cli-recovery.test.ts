import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFrozenRun,
  checkpoint,
  checkpointCompletedAttempt,
  writeAttemptArtifact,
} from "../src/state.js";
import { OwnershipLock } from "../src/ownership.js";
async function f() {
  const d = await mkdtemp(join(tmpdir(), "cli-rec-"));
  Bun.spawnSync(["git", "init", "-q", d]);
  Bun.spawnSync(["git", "-C", d, "config", "user.email", "a@b"]);
  Bun.spawnSync(["git", "-C", d, "config", "user.name", "a"]);
  await writeFile(join(d, "p"), "p");
  await writeFile(join(d, "v"), "v");
  Bun.spawnSync(["git", "-C", d, "add", "."]);
  Bun.spawnSync(["git", "-C", d, "commit", "-qm", "i"]);
  const h = Bun.spawnSync(["git", "-C", d, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim(),
    ref = Bun.spawnSync([
      "git",
      "-C",
      d,
      "rev-parse",
      "--symbolic-full-name",
      "HEAD",
    ])
      .stdout.toString()
      .trim(),
    e = join(tmpdir(), "cli-e-" + crypto.randomUUID());
  await createFrozenRun({
    evidencePath: e,
    runId: "r",
    resolvedConfig: { maxAttempts: 2 },
    initial: { head: h, ref, worktree: d },
    planPath: join(d, "p"),
    verifier: {
      argv: ["sh"],
      cwd: d,
      entryPath: join(d, "v"),
      selfContained: true,
    },
  });
  return { d, e, h, ref };
}
function cli(...a: string[]) {
  return Bun.spawnSync([process.execPath, "src/cli.ts", ...a], {
    cwd: process.cwd(),
  });
}
async function accepted(x: Awaited<ReturnType<typeof f>>) {
  await checkpoint(x.e, { phase: "worker_starting", candidateHead: x.h });
  await checkpoint(x.e, { phase: "worker_running" });
  await checkpoint(x.e, { phase: "worker_finished" });
  await checkpoint(x.e, { phase: "verifying" });
  const a = await writeAttemptArtifact(x.e, 1, "verification.json", {
    version: 1,
    candidateHead: x.h,
    headAfter: x.h,
    refAfter: x.ref,
    statusAfter: "",
    exitCode: 0,
    timedOut: false,
    command: ["never"],
    startedAt: "a",
    finishedAt: "b",
  });
  await checkpointCompletedAttempt(x.e, { attempt: 1, artifacts: [a] });
  await checkpoint(x.e, {
    phase: "verified",
    verification: {
      artifact: { path: a.path, sha256: a.sha256, bytes: a.bytes },
    },
  });
  const summary = await writeAttemptArtifact(x.e, 1, "run-summary.json", {
    runId: "r",
    status: "accepted",
    acceptedHead: x.h,
  });
  await checkpoint(x.e, {
    phase: "accepted",
    summaryArtifact: {
      path: summary.path,
      sha256: summary.sha256,
      bytes: summary.bytes,
    },
  } as never);
}
test("status accepted exits zero without worker invocation", async () => {
  const x = await f();
  try {
    await accepted(x);
    const marker = join(x.d, "worker");
    const r = cli("status", "--evidence", x.e, "--json");
    if (r.exitCode !== 0)
      throw new Error(r.stdout.toString() + r.stderr.toString());
    expect(r.stdout.toString()).toContain("accepted");
    expect(await Bun.file(marker).exists()).toBeFalse();
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});
test("malformed state exit2 and flags deterministic", async () => {
  const x = await f();
  try {
    await writeFile(join(x.e, "state.json"), "{");
    expect(cli("status", "--evidence", x.e).exitCode).toBe(2);
    expect(cli("status", "--json", "--evidence", x.e, "--json").exitCode).toBe(
      2,
    );
    expect(cli("status", "--evidence").exitCode).toBe(2);
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});
test("recover preview is read-only and active owner exits3", async () => {
  const x = await f();
  try {
    const before = await readFile(join(x.e, "state.json"));
    const lock = await OwnershipLock.acquire(x.d, x.e);
    const r = cli("recover", "--evidence", x.e, "--json");
    if (r.exitCode !== 3)
      throw new Error(r.stdout.toString() + r.stderr.toString());
    expect(await readFile(join(x.e, "state.json"))).toEqual(before);
    await lock.release();
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});
import { loadRunConfig } from "../src/cli.js";
test("verifier manifest resolves closure paths", async () => {
  const x = await f();
  try {
    const m = join(x.d, "manifest.json"),
      dep = join(x.d, "dep");
    await writeFile(dep, "x");
    await writeFile(
      m,
      JSON.stringify({
        selfContained: false,
        snapshotRoot: ".",
        dependencies: ["dep"],
      }),
    );
    const c = await loadRunConfig([
      "run",
      "--repo",
      x.d,
      "--plan",
      join(x.d, "p"),
      "--stage",
      "s",
      "--verifier",
      join(x.d, "v"),
      "--acp-command",
      '["agent"]',
      "--evidence",
      x.e,
      "--verifier-manifest",
      m,
    ]);
    expect(c.verifierDependencies).toEqual([dep]);
    expect(c.verifierSelfContained).toBeFalse();
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});
test("bad verifier manifest fails before worker", async () => {
  const x = await f();
  try {
    const m = join(x.d, "bad.json");
    await writeFile(
      m,
      JSON.stringify({ selfContained: true, dependencies: ["x"] }),
    );
    await expect(
      loadRunConfig([
        "run",
        "--repo",
        x.d,
        "--plan",
        join(x.d, "p"),
        "--stage",
        "s",
        "--verifier",
        join(x.d, "v"),
        "--acp-command",
        '["agent"]',
        "--evidence",
        x.e,
        "--verifier-manifest",
        m,
      ]),
    ).rejects.toThrow("self-contained");
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});
test("resume malformed args exit2 and active owner refuses takeover", async () => {
  const x = await f();
  try {
    expect(cli("resume", "--evidence").exitCode).toBe(2);
    const lock = await OwnershipLock.acquire(x.d, x.e);
    expect(cli("resume", "--evidence", x.e, "--json").exitCode).toBe(3);
    await lock.release();
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});

test("resume reuses accepted checkpoint without worker", async () => {
  const x = await f();
  try {
    await accepted(x);
    const r = cli("resume", "--evidence", x.e, "--json");
    if (r.exitCode !== 0)
      throw new Error(r.stdout.toString() + r.stderr.toString());
    expect(r.stdout.toString()).toContain("accepted");
    expect(await Bun.file(join(x.d, "worker")).exists()).toBeFalse();
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});
test("resume terminal failure exits1 without worker", async () => {
  const x = await f();
  try {
    await checkpoint(x.e, { phase: "failed" });
    const r = cli("resume", "--evidence", x.e, "--json");
    expect(r.exitCode).toBe(1);
    expect(await Bun.file(join(x.d, "worker")).exists()).toBeFalse();
  } finally {
    await rm(x.e, { recursive: true, force: true });
    await rm(x.d, { recursive: true, force: true });
  }
});
