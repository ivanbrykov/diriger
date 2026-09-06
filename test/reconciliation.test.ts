import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFrozenRun,
  checkpoint,
  checkpointCompletedAttempt,
  writeAttemptArtifact,
  readState,
} from "../src/state.js";
import { reconcileRun } from "../src/reconciliation.js";
async function f() {
  const d = await mkdtemp(join(tmpdir(), "rec-"));
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
    e = join(tmpdir(), "rec-e-" + crypto.randomUUID());
  let s = await createFrozenRun({
    evidencePath: e,
    runId: "r",
    resolvedConfig: {},
    initial: { head: h, ref, worktree: d },
    planPath: join(d, "p"),
    verifier: {
      argv: ["sh"],
      cwd: d,
      entryPath: join(d, "v"),
      selfContained: true,
    },
  });
  return { d, e, s };
}
test("prepared requires exact clean initial", async () => {
  const { d, e, s } = await f();
  try {
    expect((await reconcileRun(e, s, 2)).action).toBe("fresh-repair");
    await writeFile(join(d, "dirty"), "x");
    expect((await reconcileRun(e, s, 2)).action).toBe("blocked");
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});
test("clean unrecorded descendant is verification-only", async () => {
  const { d, e, s } = await f();
  try {
    await checkpoint(e, { phase: "worker_starting" });
    await checkpoint(e, { phase: "worker_running" });
    await writeFile(join(d, "x"), "x");
    Bun.spawnSync(["git", "-C", d, "add", "x"]);
    Bun.spawnSync(["git", "-C", d, "commit", "-qm", "x"]);
    expect(
      (
        await reconcileRun(
          e,
          await import("../src/state.js").then((x) => x.readState(e)),
          2,
        )
      ).action,
    ).toBe("verify-candidate");
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});

async function verified(
  d: string,
  e: string,
  kind: "ok" | "nonzero" | "timeout" = "ok",
) {
  let s = await readState(e);
  const head = Bun.spawnSync(["git", "-C", d, "rev-parse", "HEAD"])
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
      .trim();
  await checkpoint(e, { phase: "worker_starting", candidateHead: head });
  await checkpoint(e, { phase: "worker_running" });
  await checkpoint(e, { phase: "worker_finished" });
  await checkpoint(e, { phase: "verifying" });
  const a = await writeAttemptArtifact(e, 1, "verification.json", {
    version: 1,
    candidateHead: head,
    headAfter: head,
    refAfter: ref,
    statusAfter: "",
    exitCode: kind === "nonzero" ? 1 : 0,
    timedOut: kind === "timeout",
    command: ["x"],
    startedAt: "a",
    finishedAt: "b",
  });
  await checkpointCompletedAttempt(e, { attempt: 1, artifacts: [a] });
  return checkpoint(e, {
    phase: "verified",
    verification: {
      artifact: { path: a.path, sha256: a.sha256, bytes: a.bytes },
    },
  });
}
test("verified proof finalizes and accepted proof reuses", async () => {
  const { d, e } = await f();
  try {
    await verified(d, e);
    expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
      "finalize-verified",
    );
    await checkpoint(e, { phase: "accepted" });
    expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
      "reuse-accepted",
    );
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});
test("nonzero timeout or corrupt proof blocks acceptance", async () => {
  for (const kind of ["nonzero", "timeout"] as const) {
    const { d, e } = await f();
    try {
      await verified(d, e, kind);
      expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
        "blocked",
      );
    } finally {
      await rm(e, { recursive: true, force: true });
      await rm(d, { recursive: true, force: true });
    }
  }
});
test("accepted dirty or changed HEAD blocks reuse", async () => {
  const { d, e } = await f();
  try {
    await verified(d, e);
    await checkpoint(e, { phase: "accepted" });
    await writeFile(join(d, "dirty"), "x");
    expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
      "blocked",
    );
    await rm(join(d, "dirty"));
    await writeFile(join(d, "new"), "x");
    Bun.spawnSync(["git", "-C", d, "add", "new"]);
    Bun.spawnSync(["git", "-C", d, "commit", "-qm", "new"]);
    expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
      "blocked",
    );
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});

test("durable failed verifier repairs once; missing verifier reruns", async () => {
  const { d, e } = await f();
  try {
    await verified(d, e, "nonzero");
    const raw = JSON.parse(await readFile(join(e, "state.json"), "utf8"));
    raw.phase = "verifying";
    await writeFile(join(e, "state.json"), JSON.stringify(raw));
    expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
      "fresh-repair",
    );
    delete raw.verification;
    await writeFile(join(e, "state.json"), JSON.stringify(raw));
    expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
      "rerun-verifier",
    );
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});
test("recorded worker timeout cannot verify a clean descendant", async () => {
  const { d, e } = await f();
  try {
    await checkpoint(e, {
      phase: "worker_starting",
      attempt: { timeout: true },
    });
    await checkpoint(e, { phase: "worker_running" });
    await writeFile(join(d, "x"), "x");
    Bun.spawnSync(["git", "-C", d, "add", "x"]);
    Bun.spawnSync(["git", "-C", d, "commit", "-qm", "x"]);
    expect((await reconcileRun(e, await readState(e), 2)).action).toBe(
      "fresh-repair",
    );
  } finally {
    await rm(e, { recursive: true, force: true });
    await rm(d, { recursive: true, force: true });
  }
});
