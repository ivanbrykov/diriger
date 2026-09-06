import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runObservedProcess, runVerification } from "../src/process.js";

async function assertStopped(path: string): Promise<void> {
  const pid = Number(await readFile(path, "utf8"));
  const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  const state = result.stdout.toString().trim();
  // An orphan can briefly remain a zombie until the host's init reaps it.
  expect(state === "" || state.startsWith("Z")).toBe(true);
}

async function cleanupFixture(root: string): Promise<void> {
  for (const name of ["parent", "child"]) {
    try {
      const pid = Number(await readFile(join(root, `${name}.pid`), "utf8"));
      process.kill(name === "parent" ? -pid : pid, "SIGKILL");
    } catch (error) {
      if (
        !["ESRCH", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  await rm(root, { recursive: true, force: true });
}

describe("process group deadlines", () => {
  for (const kind of ["worker", "watchdog", "verifier"] as const) {
    for (const parentExits of [false, true]) {
      test(`${kind} kills TERM-resistant children when parent ${parentExits ? "already exited" : "ignores TERM"}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "supervisor-group-"));
        try {
          await writeFile(
            join(root, "child.sh"),
            `#!/usr/bin/env bash
trap '' TERM
echo $$ > child.pid
printf 'child-ready\\n'
while :; do sleep 0.1; done
`,
          );
          const script = `echo $$ > parent.pid
trap '' TERM
bash child.sh &
while ! test -s child.pid; do sleep 0.01; done
${parentExits ? "exit 0" : "wait"}`;
          const command = ["bash", "-c", script];
          const started = Date.now();
          if (kind !== "verifier") {
            const result = await runObservedProcess({
              command,
              cwd: root,
              env: process.env,
              stdoutPath: join(root, "stdout.jsonl"),
              stderrPath: join(root, "stderr.log"),
              timeoutMs: kind === "watchdog" ? 10_000 : 300,
              noToolTimeoutMs: kind === "watchdog" ? 10 : 10_000,
              noToolOutputBytes: kind === "watchdog" ? 1 : 1_000_000,
            });
            expect(result.terminationReason).toBe(
              kind === "watchdog" ? "no-tool-progress" : "timeout",
            );
            expect(
              await readFile(join(root, "stdout.jsonl"), "utf8"),
            ).toContain("child-ready");
          } else {
            const result = await runVerification(
              command,
              root,
              process.env,
              300,
            );
            expect(result.timedOut).toBe(true);
            expect(result.output).toContain("child-ready");
          }
          expect(Date.now() - started).toBeLessThan(4_500);
          await assertStopped(join(root, "parent.pid"));
          await assertStopped(join(root, "child.pid"));
        } finally {
          await cleanupFixture(root);
        }
      }, 7_000);
    }
  }

  for (const kind of ["worker", "verifier"] as const) {
    test(`${kind} cleans up silent children after a successful parent exit`, async () => {
      const root = await mkdtemp(join(tmpdir(), "supervisor-silent-child-"));
      try {
        const command = [
          "bash",
          "-c",
          `echo $$ > parent.pid
bash -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 0.1; done' >/dev/null 2>&1 &
while ! test -s child.pid; do sleep 0.01; done
exit 0`,
        ];
        if (kind === "worker") {
          const result = await runObservedProcess({
            command,
            cwd: root,
            env: process.env,
            stdoutPath: join(root, "stdout.jsonl"),
            stderrPath: join(root, "stderr.log"),
            timeoutMs: 5_000,
            noToolTimeoutMs: 5_000,
            noToolOutputBytes: 1_000_000,
          });
          expect(result.exitCode).toBe(0);
          expect(result.terminationReason).toBeUndefined();
        } else {
          const result = await runVerification(
            command,
            root,
            process.env,
            5_000,
          );
          expect(result.exitCode).toBe(0);
          expect(result.timedOut).toBe(false);
        }
        await assertStopped(join(root, "child.pid"));
      } finally {
        await cleanupFixture(root);
      }
    }, 7_000);
  }

  test("a successful verifier preserves output and has no timeout", async () => {
    const result = await runVerification(
      ["bash", "-c", "printf out; printf err >&2"],
      "/tmp",
      process.env,
      1_000,
    );
    expect(result).toEqual({ exitCode: 0, output: "outerr", timedOut: false });
  });
});
