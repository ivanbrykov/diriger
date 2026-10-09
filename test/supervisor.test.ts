import { describe, expect, test } from "bun:test";
import { encodedBytes, runObservedProcess } from "../src/process.js";
import { boundedFailureOutput } from "../src/supervisor.js";

describe("boundedFailureOutput", () => {
  test("preserves short verifier output", () => {
    expect(boundedFailureOutput("failed assertion")).toBe("failed assertion");
  });

  test("keeps both ends of large verifier output", () => {
    const output = `BEGIN-${"x".repeat(30_000)}-END`;
    const bounded = boundedFailureOutput(output);

    expect(bounded.startsWith("BEGIN-")).toBe(true);
    expect(bounded.endsWith("-END")).toBe(true);
    expect(bounded).toContain("truncated by supervisor");
    expect(encodedBytes(bounded)).toBeLessThan(25_000);
  });
});

describe("runObservedProcess", () => {
  test("captures a nonzero process exit", async () => {
    const root = `/tmp/diriger-test-${crypto.randomUUID()}`;
    const result = await runObservedProcess({
      command: [
        "bash",
        "-lc",
        'printf \'{"type":"complete","total_tokens":7}\\n\'; exit 7',
      ],
      cwd: "/tmp",
      env: process.env,
      stdoutPath: `${root}/stdout.jsonl`,
      stderrPath: `${root}/stderr.log`,
      timeoutMs: 5_000,
      noToolTimeoutMs: 5_000,
      noToolOutputBytes: 1_000_000,
    });

    expect(result.exitCode).toBe(7);
    expect(result.terminationReason).toBeUndefined();
    expect(result.usage?.totalTokens).toBe(7);
  });

  test("terminates a process at its wall timeout", async () => {
    const root = `/tmp/diriger-test-${crypto.randomUUID()}`;
    const result = await runObservedProcess({
      command: ["bash", "-lc", "sleep 5"],
      cwd: "/tmp",
      env: process.env,
      stdoutPath: `${root}/stdout.jsonl`,
      stderrPath: `${root}/stderr.log`,
      timeoutMs: 50,
      noToolTimeoutMs: 5_000,
      noToolOutputBytes: 1_000_000,
    });

    expect(result.terminationReason).toBe("timeout");
    expect(result.exitCode).not.toBe(0);
  });

  test("terminates sustained output without tool progress", async () => {
    const root = `/tmp/diriger-test-${crypto.randomUUID()}`;
    const result = await runObservedProcess({
      command: ["bash", "-lc", "printf '%01000d' 0; sleep 5"],
      cwd: "/tmp",
      env: process.env,
      stdoutPath: `${root}/stdout.jsonl`,
      stderrPath: `${root}/stderr.log`,
      timeoutMs: 5_000,
      noToolTimeoutMs: 10,
      noToolOutputBytes: 100,
    });

    expect(result.terminationReason).toBe("no-tool-progress");
    expect(result.exitCode).not.toBe(0);
  });
});
