import { describe, test, expect } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFrozenRun,
  readState,
  validateFrozenInputs,
  reserveAttempt,
  writeRunSummary,
  StateError,
  resolveExecutable,
  writeAttemptArtifact,
  checkpointCompletedAttempt,
} from "../src/state.js";
async function f() {
  const r = await mkdtemp(join(tmpdir(), "state-"));
  await writeFile(join(r, "p"), "plan");
  await writeFile(join(r, "v"), "verify");
  return r;
}
async function c(r: string) {
  return createFrozenRun({
    evidencePath: join(r, "e"),
    runId: "r1",
    resolvedConfig: { x: 1 },
    initial: { head: "a", ref: "main", worktree: "/w" },
    planPath: join(r, "p"),
    verifier: {
      argv: ["sh", "v"],
      cwd: "/w",
      entryPath: join(r, "v"),
      selfContained: true,
    },
  });
}
describe("state", () => {
  test("roundtrip exclusive", async () => {
    const r = await f();
    try {
      await c(r);
      expect((await readState(join(r, "e"))).phase).toBe("prepared");
      await expect(c(r)).rejects.toBeInstanceOf(StateError);
    } finally {
      await rm(r, { recursive: true, force: true });
    }
  });
  test("corrupt and stale temp", async () => {
    const r = await f();
    try {
      await c(r);
      await writeFile(join(r, "e", ".x.tmp"), "bad");
      await readState(join(r, "e"));
      await writeFile(join(r, "e", "state.json"), "{");
      await expect(readState(join(r, "e"))).rejects.toBeInstanceOf(StateError);
    } finally {
      await rm(r, { recursive: true, force: true });
    }
  });
  test("drift and monotonic attempts", async () => {
    const r = await f();
    try {
      const s = await c(r),
        e = join(r, "e");
      await validateFrozenInputs(e, { runId: s.runId, initial: s.initial });
      await writeFile(join(e, "inputs", "plan.md"), "drift");
      await expect(validateFrozenInputs(e)).rejects.toBeInstanceOf(StateError);
      await writeFile(join(e, "inputs", "plan.md"), "plan");
      const startedAt = (await readState(e)).startedAt;
      expect((await reserveAttempt(e)).reservedAttempts).toBe(1);
      const { checkpoint } = await import("../src/state.js");
      await checkpoint(e, { phase: "worker_running" });
      await checkpoint(e, { phase: "worker_finished" });
      expect((await readState(e)).startedAt).toBe(startedAt);
      expect((await reserveAttempt(e)).reservedAttempts).toBe(2);
      await writeRunSummary(e, { ok: true });
      expect(JSON.parse(await readFile(join(e, "run.json"), "utf8"))).toEqual({
        ok: true,
      });
    } finally {
      await rm(r, { recursive: true, force: true });
    }
  });
});

test("preserves verifier snapshot relative layout", async () => {
  const r = await f();
  try {
    const b = join(r, "bench");
    await Bun.write(join(b, "scripts", "verify-stage.sh"), "x");
    await Bun.write(join(b, "oracle", "01-domain.test.ts"), "y");
    const s = await createFrozenRun({
      evidencePath: join(r, "layout"),
      runId: "layout",
      resolvedConfig: {},
      initial: { head: "a", ref: "main", worktree: "/target" },
      planPath: join(r, "p"),
      verifier: {
        argv: ["bash", "scripts/verify-stage.sh", "1"],
        cwd: "/target",
        entryPath: join(b, "scripts", "verify-stage.sh"),
        dependencies: [join(b, "oracle", "01-domain.test.ts")],
        snapshotRoot: b,
        selfContained: false,
      },
    });
    expect(s.inputs.verifier.entry.path).toBe(
      "inputs/verifier/scripts/verify-stage.sh",
    );
    expect(s.inputs.verifier.dependencies[0]?.path).toBe(
      "inputs/verifier/oracle/01-domain.test.ts",
    );
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});

test("creation is exclusive under a race", async () => {
  const r = await f();
  try {
    const xs = await Promise.allSettled([c(r), c(r)]);
    expect(xs.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});
test("retry reservation is atomic and terminal states reject it", async () => {
  const r = await f();
  try {
    const e = join(r, "e");
    await c(r);
    await reserveAttempt(e);
    const { checkpoint } = await import("../src/state.js");
    await checkpoint(e, { phase: "worker_running" });
    await checkpoint(e, { phase: "worker_finished" });
    const two = await reserveAttempt(e);
    expect(two.reservedAttempts).toBe(2);
    expect(two.attempt?.attempt).toBe(2);
    await checkpoint(e, { phase: "failed" });
    await expect(reserveAttempt(e)).rejects.toBeInstanceOf(StateError);
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});

test("rejects malformed metadata, traversal, and unsafe config", async () => {
  const r = await f();
  try {
    const e = join(r, "e");
    await c(r);
    const raw = JSON.parse(await readFile(join(e, "state.json"), "utf8"));
    raw.initial.worktree = 3;
    await writeFile(join(e, "state.json"), JSON.stringify(raw));
    await expect(readState(e)).rejects.toBeInstanceOf(StateError);
    await rm(e, { recursive: true, force: true });
    await expect(
      createFrozenRun({
        evidencePath: e,
        runId: "bad",
        resolvedConfig: { bad: Infinity } as never,
        initial: { head: "a", ref: "main", worktree: "/w" },
        planPath: join(r, "p"),
        verifier: {
          argv: ["sh"],
          cwd: "/w",
          entryPath: join(r, "v"),
          selfContained: true,
        },
      }),
    ).rejects.toBeInstanceOf(StateError);
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});
test("requires executable regular files and preserves binary snapshot bytes and executable mode", async () => {
  const r = await f();
  try {
    const x = join(r, "x");
    await writeFile(x, "x");
    await expect(resolveExecutable(x)).rejects.toBeInstanceOf(StateError);
    await chmod(x, 0o700);
    expect(await resolveExecutable("./x", "", r)).toBe(
      await import("node:fs/promises").then((m) => m.realpath(x)),
    );
    const binary = join(r, "binary");
    await writeFile(binary, new Uint8Array([0, 255, 10]));
    await chmod(binary, 0o701);
    const s = await createFrozenRun({
      evidencePath: join(r, "binary-e"),
      runId: "binary",
      resolvedConfig: {},
      initial: { head: "a", ref: "main", worktree: "/w" },
      planPath: binary,
      verifier: {
        argv: ["sh"],
        cwd: "/w",
        entryPath: join(r, "v"),
        selfContained: true,
      },
    });
    const frozen = join(r, "binary-e", s.inputs.plan.path);
    expect(Array.from(await readFile(frozen))).toEqual([0, 255, 10]);
    expect((await stat(frozen)).mode & 0o001).toBe(1);
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});
test("snapshot argv executes ledger-style verifier with relative oracle layout", async () => {
  const r = await f();
  try {
    const b = join(r, "bench");
    await mkdir(join(b, "scripts"), { recursive: true });
    await mkdir(join(b, "oracle"), { recursive: true });
    await writeFile(join(b, "oracle", "check"), "ok\n");
    await writeFile(
      join(b, "scripts", "verify.ts"),
      'import { readFileSync } from "node:fs"; import { dirname, join } from "node:path"; if (readFileSync(join(dirname(import.meta.path), "..", "oracle", "check"), "utf8").trim() !== "ok") process.exit(1);',
    );
    await chmod(join(b, "scripts", "verify.ts"), 0o700);
    const s = await createFrozenRun({
      evidencePath: join(r, "snap"),
      runId: "snap",
      resolvedConfig: {},
      initial: { head: "a", ref: "main", worktree: "/w" },
      planPath: join(r, "p"),
      verifier: {
        argv: [process.execPath, "scripts/verify.ts"],
        cwd: "/w",
        entryPath: join(b, "scripts", "verify.ts"),
        dependencies: [join(b, "oracle", "check")],
        snapshotRoot: b,
        selfContained: false,
      },
    });
    expect(s.inputs.verifier.argv[1]).toBe(
      join(r, "snap", "inputs", "verifier", "scripts", "verify.ts"),
    );
    await import(s.inputs.verifier.argv[1]!);
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});

test("attempt artifacts are immutable, validated, and retained across retry", async () => {
  const r = await f();
  try {
    const e = join(r, "e");
    await c(r);
    const first = await reserveAttempt(e);
    const ref = await writeAttemptArtifact(e, 1, "verification.json", {
      ok: true,
    });
    expect(
      await writeAttemptArtifact(e, 1, "verification.json", { ok: true }),
    ).toEqual(ref);
    await expect(
      writeAttemptArtifact(e, 1, "verification.json", { ok: false }),
    ).rejects.toBeInstanceOf(StateError);
    await checkpointCompletedAttempt(e, {
      attempt: 1,
      artifacts: [ref],
      result: { accepted: false },
    });
    const { checkpoint } = await import("../src/state.js");
    await checkpoint(e, { phase: "worker_running" });
    await checkpoint(e, { phase: "worker_finished" });
    const second = await reserveAttempt(e);
    expect(second.completedAttempts?.[0]?.artifacts[0]).toEqual(ref);
    await writeFile(join(e, ref.path), "corrupt");
    await expect(validateFrozenInputs(e)).rejects.toBeInstanceOf(StateError);
    await expect(
      writeAttemptArtifact(e, 2, "../bad", new Uint8Array()),
    ).rejects.toBeInstanceOf(StateError);
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});

test("requires an immutable valid startedAt", async () => {
  const r = await f();
  try {
    await c(r);
    const e = join(r, "e"),
      raw = JSON.parse(await readFile(join(e, "state.json"), "utf8"));
    raw.startedAt = "not-a-time";
    await writeFile(join(e, "state.json"), JSON.stringify(raw));
    await expect(readState(e)).rejects.toBeInstanceOf(StateError);
    delete raw.startedAt;
    await writeFile(join(e, "state.json"), JSON.stringify(raw));
    await expect(readState(e)).rejects.toBeInstanceOf(StateError);
  } finally {
    await rm(r, { recursive: true, force: true });
  }
});
