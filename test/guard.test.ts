import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OwnershipLock, diagnoseOwnership } from "../src/ownership.js";
import { launchGuarded, MissingGuardedChildResultError } from "../src/guard.js";
async function repo() {
  const d = await mkdtemp(join(tmpdir(), "guard-"));
  Bun.spawnSync(["git", "init", "-q", d]);
  return d;
}
test("guard keeps wrapper alive for child result then reaps normal launch", async () => {
  const d = await repo();
  try {
    const lock = await OwnershipLock.acquire(d, join(d, "e"));
    const x = await launchGuarded({
      lock,
      command: ["bash", "-c", "printf acp-frame; exit 7"],
      cwd: d,
      controlPath: join(d, "control"),
    });
    expect(await x.waitForChild()).toBe(7);
    expect(x.process.exitCode).toBeNull();
    await x.cleanup();
    expect(await x.process.exited).toBeNumber();
    await lock.release();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("cleanup kills a TERM-resistant background writer after its parent exits", async () => {
  const d = await repo();
  try {
    const marker = join(d, "writer");
    const lock = await OwnershipLock.acquire(d, join(d, "e"));
    const x = await launchGuarded({
      lock,
      command: [
        "bash",
        "-c",
        `trap '' TERM; (trap '' TERM; while :; do echo x >> '${marker}'; sleep .02; done) & exit 0`,
      ],
      cwd: d,
      controlPath: join(d, "control"),
      terminationGraceMs: 50,
    });
    expect(await x.waitForChild()).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    await x.cleanup();
    const afterCleanup = (await Bun.file(marker).text()).length;
    await new Promise((r) => setTimeout(r, 80));
    expect((await Bun.file(marker).text()).length).toBe(afterCleanup);
    await lock.release();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function eventually(path: string) {
  for (let i = 0; i < 100; i++) {
    if (await Bun.file(path).exists()) return;
    await sleep(20);
  }
  throw new Error(`missing ${path}`);
}
async function crashedController(
  dir: string,
  marker: string,
  phase: "before" | "after",
) {
  const fixture = join(dir, "controller.ts");
  const ownership = new URL("../src/ownership.ts", import.meta.url).href;
  const guard = new URL("../src/guard.ts", import.meta.url).href;
  await writeFile(
    fixture,
    `import {OwnershipLock} from ${JSON.stringify(ownership)}; import {launchGuarded} from ${JSON.stringify(guard)}; const d=process.argv[process.argv.length-2] as string,m=process.argv[process.argv.length-1] as string; const lock=await OwnershipLock.acquire(d,d+'/e'); const x=await launchGuarded({lock,cwd:d,controlPath:d+'/control',terminationGraceMs:30,command:['bash','-c',${JSON.stringify(`while :; do echo x >> '${marker}'; sleep .01; done`)}],beforeAuthorize:async()=>{if(${JSON.stringify(phase)}==='before')process.kill(process.pid,'SIGKILL')}}); if(${JSON.stringify(phase)}==='after'){for(let i=0;i<200&&!await Bun.file(m).exists();i++)await new Promise(r=>setTimeout(r,5));process.kill(process.pid,'SIGKILL');}`,
  );
  return Bun.spawn([process.execPath, fixture, dir, marker], {
    stdout: "pipe",
    stderr: "pipe",
  });
}
test("controller SIGKILL before authorization never starts target and leaves fail-closed ownership", async () => {
  const d = await repo();
  try {
    const marker = join(d, "before-writer");
    const c = await crashedController(d, marker, "before");
    const code = await c.exited;
    if (code !== 137)
      throw new Error(
        `controller exit ${code}: ${await new Response(c.stderr).text()}`,
      );
    await sleep(180);
    expect(await Bun.file(marker).exists()).toBeFalse();
    expect((await diagnoseOwnership(d)).state).toBe("blocked");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("controller SIGKILL after authorization stops every surviving writer", async () => {
  const d = await repo();
  try {
    const marker = join(d, "after-writer");
    const c = await crashedController(d, marker, "after");
    await eventually(marker);
    const code = await c.exited;
    if (code !== 137)
      throw new Error(
        `controller exit ${code}: ${await new Response(c.stderr).text()}`,
      );
    await sleep(220);
    const size = (await Bun.file(marker).text()).length;
    await sleep(100);
    expect((await Bun.file(marker).text()).length).toBe(size);
    expect((await diagnoseOwnership(d)).state).toBe("blocked");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("recorded guard death fail-closes the lock", async () => {
  const d = await repo();
  try {
    const lock = await OwnershipLock.acquire(d, join(d, "e"));
    const x = await launchGuarded({
      lock,
      command: ["bash", "-c", "sleep 10"],
      cwd: d,
      controlPath: join(d, "control"),
      terminationGraceMs: 20,
    });
    process.kill(x.guard.pid, "SIGKILL");
    await sleep(40);
    expect((await diagnoseOwnership(d)).state).toBe("blocked");
    await x.cleanup();
    await lock.release();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("beforeAuthorize failure reaps helpers and retains a fail-closed lock", async () => {
  const d = await repo();
  try {
    const lock = await OwnershipLock.acquire(d, join(d, "e"));
    await expect(
      launchGuarded({
        lock,
        command: ["bash", "-c", "echo unsafe > target"],
        cwd: d,
        controlPath: join(d, "control"),
        terminationGraceMs: 20,
        beforeAuthorize: () => {
          throw new Error("checkpoint failed");
        },
      }),
    ).rejects.toThrow("checkpoint failed");
    expect(await Bun.file(join(d, "target")).exists()).toBeFalse();
    expect((await diagnoseOwnership(d)).state).toBe("blocked");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("childExited follows the target result instead of an internal short timeout", async () => {
  const d = await repo();
  try {
    const lock = await OwnershipLock.acquire(d, join(d, "e"));
    const x = await launchGuarded({
      lock,
      command: ["bash", "-c", "sleep .15; exit 9"],
      cwd: d,
      controlPath: join(d, "control"),
      terminationGraceMs: 20,
    });
    const early = await Promise.race([
      x.childExited.then(() => "done"),
      sleep(40).then(() => "waiting"),
    ]);
    expect(early).toBe("waiting");
    expect(await x.childExited).toBe(9);
    await x.cleanup();
    await lock.release();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("wrapper self-reaps TERM-resistant writer when controller guard and control vanish", async () => {
  const d = await repo();
  try {
    const marker = join(d, "orphan-writer"),
      script = join(d, "orphan-controller.ts"),
      own = new URL("../src/ownership.ts", import.meta.url).href,
      guard = new URL("../src/guard.ts", import.meta.url).href;
    await writeFile(
      script,
      `import {rm} from 'node:fs/promises';import {OwnershipLock} from ${JSON.stringify(own)};import {launchGuarded} from ${JSON.stringify(guard)};const d=process.argv[process.argv.length-1] as string;const l=await OwnershipLock.acquire(d,d+'/e');const x=await launchGuarded({lock:l,cwd:d,controlPath:d+'/control',terminationGraceMs:30,command:['bash','-c',${JSON.stringify(`(trap '' TERM; while :; do echo x >> '${marker}'; sleep .01; done) & sleep 10`)}]});await new Promise(r=>setTimeout(r,80));process.kill(x.guard.pid,'SIGKILL');await rm(d+'/control',{recursive:true,force:true});process.kill(process.pid,'SIGKILL');`,
    );
    const c = Bun.spawn([process.execPath, script, d], {
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 100 && !(await Bun.file(marker).exists()); i++)
      await sleep(10);
    expect(await Bun.file(marker).exists()).toBeTrue();
    await c.exited;
    await sleep(180);
    const n = (await Bun.file(marker).text()).length;
    await sleep(100);
    expect((await Bun.file(marker).text()).length).toBe(n);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("childExited rejects after cleanup when the wrapper settles without a child result", async () => {
  const d = await repo();
  try {
    const lock = await OwnershipLock.acquire(d, join(d, "e"));
    const x = await launchGuarded({
      lock,
      command: ["bash", "-c", "trap '' TERM; while :; do sleep .01; done"],
      cwd: d,
      controlPath: join(d, "control"),
      terminationGraceMs: 30,
    });
    await x.cleanup();
    const outcome = await Promise.race([
      x.childExited.then(
        () => "resolved",
        (error) => error,
      ),
      sleep(500).then(() => "timed-out"),
    ]);
    expect(outcome).toBeInstanceOf(MissingGuardedChildResultError);
    expect(
      (outcome as MissingGuardedChildResultError).wrapperExitCode,
    ).toBeNumber();
    await lock.release();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
