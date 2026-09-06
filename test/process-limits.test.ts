import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runObservedProcess, runVerification } from "../src/process.js";
test("worker output limit kills an infinite partial line and caps logs", async () => {
  const d = await mkdtemp(join(tmpdir(), "limit-"));
  try {
    const r = await runObservedProcess({
      command: ["bash", "-c", "yes x | tr -d '\\n'"],
      cwd: d,
      env: process.env,
      stdoutPath: join(d, "o"),
      stderrPath: join(d, "e"),
      timeoutMs: 5000,
      noToolTimeoutMs: 5000,
      noToolOutputBytes: 1e9,
      maxOutputBytes: 4096,
      maxPartialLineBytes: 1024,
    });
    expect(r.terminationReason).toBe("output-limit");
    expect((await readFile(join(d, "o"))).byteLength).toBeLessThanOrEqual(4096);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("verifier output overflow normalizes success to failure", async () => {
  const d = await mkdtemp(join(tmpdir(), "limit-"));
  try {
    const r = await runVerification(
      ["bash", "-c", "yes z | head -c 100000; exit 0"],
      d,
      process.env,
      5000,
      undefined,
      4096,
    );
    expect(r.exitCode).toBe(1);
    expect(r.actualExitCode).toBeNumber();
    expect(r.outputLimited).toBeTrue();
    expect(r.output.length).toBeLessThanOrEqual(65536);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("normal verifier output is retained", async () => {
  const d = await mkdtemp(join(tmpdir(), "limit-"));
  try {
    const r = await runVerification(
      ["bash", "-c", "printf normal"],
      d,
      process.env,
      5000,
      undefined,
      4096,
    );
    expect(r).toMatchObject({ exitCode: 0, output: "normal", timedOut: false });
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
