import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkerReport, readWorkerReport, investigationSeconds } from "../src/worker-report.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const complete = { version: 1 as const, status: "complete" as const, summary: "Implemented the requested change", knownGaps: [], decisions: [], validation: ["targeted tests pass"] };
async function fixture(contents: string | Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "diriger-report-")); roots.push(root);
  const path = join(root, "report.json"); await writeFile(path, contents); return { root, path };
}
test("reads complete and evidence-backed blocked reports without interpreting prose", async () => {
  const { path } = await fixture(JSON.stringify(complete)); expect(await readWorkerReport(path)).toEqual(complete);
  const blocked = { ...complete, status: "blocked" as const, summary: "BLOCKED: runtime capability unresolved", blocker: { assumption: "runtime supports this API", evidence: ["minimal fixture failed"], attemptedApproaches: ["checked installed version and minimal fixture"], smallestAlternative: "use the native platform API", decisionNeeded: "approve contract change" } };
  expect(parseWorkerReport(blocked)).toEqual(blocked);
  expect(() => parseWorkerReport("BLOCKED")).toThrow();
});
test("requires explicit gap disclosure and supported blockers", () => {
  expect(() => parseWorkerReport({ ...complete, knownGaps: undefined })).toThrow();
  expect(() => parseWorkerReport({ ...complete, status: "blocked" })).toThrow();
  expect(() => parseWorkerReport({ ...complete, blocker: {} })).toThrow();
  expect(() => parseWorkerReport({ ...complete, accepted: true })).toThrow();
  expect(() => parseWorkerReport({ ...complete, knownGaps: [""] })).toThrow();
  expect(parseWorkerReport({ ...complete, knownGaps: ["Real runtime smoke not completed"] }).knownGaps).toHaveLength(1);
});
test("rejects missing, malformed, oversized and non-UTF8 reports", async () => {
  const { path, root } = await fixture("not JSON"); await expect(readWorkerReport(path)).rejects.toThrow("UTF-8 JSON");
  await expect(readWorkerReport(join(root, "missing"))).rejects.toThrow();
  await writeFile(path, JSON.stringify(complete) + " ".repeat(65536)); await expect(readWorkerReport(path)).rejects.toThrow("64 KiB");
  await writeFile(path, new Uint8Array([0xff, 0xfe])); await expect(readWorkerReport(path)).rejects.toThrow("UTF-8 JSON");
});
test("rejects symlinks, directories and FIFOs without blocking", async () => {
  const { root, path } = await fixture(JSON.stringify(complete)); const link = join(root, "link"); await symlink(path, link);
  await expect(readWorkerReport(link)).rejects.toThrow(); await expect(readWorkerReport(root)).rejects.toThrow("regular file");
  const fifo = join(root, "fifo"); expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0); await expect(readWorkerReport(fifo)).rejects.toThrow("regular file");
});
test("investigation allowance remains within the worker deadline", () => {
  expect(investigationSeconds(1800000)).toBe(300);
  expect(investigationSeconds(60000)).toBe(15);
  expect(investigationSeconds(200)).toBe(0.05);
});
