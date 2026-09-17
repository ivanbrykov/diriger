import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunManifest } from "../src/chain.js";

const base = {
  version: 2,
  repository: "repo",
  evidence: "evidence",
  worker: { command: ["worker", "acp"] },
  stages: [{ id: "s1", plan: "plan.md", verifier: "verify.sh" }],
};

async function writeManifest(
  body: unknown,
  inputs: ReadonlyArray<string> = ["plan.md", "verify.sh"],
): Promise<{ dir: string; manifest: string }> {
  const dir = await mkdtemp(join(tmpdir(), "diriger-manifest-"));
  for (const file of inputs) await writeFile(join(dir, file), "x");
  const manifest = join(dir, "manifest.json");
  await writeFile(manifest, JSON.stringify(body));
  return { dir, manifest };
}

describe("parseRunManifest", () => {
  test("a one-stage manifest resolves paths and applies budget defaults", async () => {
    const { dir, manifest } = await writeManifest(base);
    try {
      const parsed = await parseRunManifest(manifest);
      expect(parsed.version).toBe(2);
      expect(parsed.chainId).toBe("manifest");
      expect(parsed.repositoryPath).toBe(join(dir, "repo"));
      expect(parsed.evidencePath).toBe(join(dir, "evidence"));
      expect(parsed.workerCommand).toEqual(["worker", "acp"]);
      expect(parsed.workerReportRequired).toBeTrue();
      expect(parsed.progressEvaluator).toBeUndefined();
      expect(parsed.budgets).toEqual({
        maxAttempts: 2,
        workerTimeoutSeconds: 1_800,
        maxToolCalls: 100,
        toolCallCushion: 15,
        maxToolRepetitions: 8,
        noToolTimeoutSeconds: 90,
        noToolOutputBytes: 262_144,
      });
      expect(parsed.stages).toHaveLength(1);
      expect(parsed.stages[0]!.planPath).toBe(join(dir, "plan.md"));
      expect(parsed.stages[0]!.verifierPath).toBe(join(dir, "verify.sh"));
      expect(parsed.stages[0]!.after).toBeUndefined();
      expect(parsed.promptPath).toBe(
        join(import.meta.dir, "..", "prompts", "worker.md"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges defaults with stage overrides and chains later stages", async () => {
    const { dir, manifest } = await writeManifest(
      {
        ...base,
        runId: "cld-invites",
        prompt: "worker.md",
        worker: { command: ["worker"], report: "optional" },
        evaluator: { command: ["evaluator"], timeoutSeconds: 30 },
        defaults: { maxAttempts: 3, maxToolCalls: 120 },
        stages: [
          { id: "s1", plan: "plan.md", verifier: "verify.sh" },
          {
            id: "s2",
            plan: "plan.md",
            verifier: "verify.sh",
            maxToolCalls: 40,
            toolCallCushion: 0,
          },
        ],
      },
      ["plan.md", "verify.sh", "worker.md"],
    );
    try {
      const parsed = await parseRunManifest(manifest);
      expect(parsed.chainId).toBe("cld-invites");
      expect(parsed.workerReportRequired).toBeFalse();
      expect(parsed.progressEvaluator).toEqual({
        command: ["evaluator"],
        timeoutMs: 30_000,
      });
      expect(parsed.promptPath).toBe(join(dir, "worker.md"));
      expect(parsed.budgets.maxAttempts).toBe(3);
      expect(parsed.budgets.maxToolCalls).toBe(120);
      expect(parsed.stages[0]!.after).toBeUndefined();
      expect(parsed.stages[1]!.after).toBe("s1");
      expect(parsed.stages[1]!.budgets).toEqual({
        maxToolCalls: 40,
        toolCallCushion: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an unknown top-level key", async () => {
    const { dir, manifest } = await writeManifest({ ...base, extra: 1 });
    try {
      await expect(parseRunManifest(manifest)).rejects.toThrow(
        "unknown manifest key: extra",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a non-version-2 manifest", async () => {
    const { dir, manifest } = await writeManifest({ ...base, version: 1 });
    try {
      await expect(parseRunManifest(manifest)).rejects.toThrow(
        "manifest version must be 2",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a missing or malformed worker command", async () => {
    for (const worker of [undefined, {}, { command: [] }, { command: [" "] }]) {
      const { dir, manifest } = await writeManifest({ ...base, worker });
      try {
        await expect(parseRunManifest(manifest)).rejects.toThrow(
          /worker must be an object|worker.command/,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("rejects an invalid report mode and evaluator budget", async () => {
    const bad = await writeManifest({
      ...base,
      worker: { command: ["worker"], report: "maybe" },
    });
    try {
      await expect(parseRunManifest(bad.manifest)).rejects.toThrow(
        "worker.report must be required or optional",
      );
    } finally {
      await rm(bad.dir, { recursive: true, force: true });
    }
    const zero = await writeManifest({
      ...base,
      evaluator: { command: ["evaluator"], timeoutSeconds: 0 },
    });
    try {
      await expect(parseRunManifest(zero.manifest)).rejects.toThrow(
        "evaluator.timeoutSeconds must be a positive integer",
      );
    } finally {
      await rm(zero.dir, { recursive: true, force: true });
    }
  });

  test("rejects a negative cushion and unknown stage budget keys", async () => {
    const negative = await writeManifest({
      ...base,
      defaults: { toolCallCushion: -1 },
    });
    try {
      await expect(parseRunManifest(negative.manifest)).rejects.toThrow(
        "defaults.toolCallCushion must be a non-negative integer",
      );
    } finally {
      await rm(negative.dir, { recursive: true, force: true });
    }
    const unknown = await writeManifest({
      ...base,
      stages: [{ ...base.stages[0], maxTurns: 1 }],
    });
    try {
      await expect(parseRunManifest(unknown.manifest)).rejects.toThrow(
        "unknown manifest key: stages[0].maxTurns",
      );
    } finally {
      await rm(unknown.dir, { recursive: true, force: true });
    }
  });

  test("rejects duplicate ids and a forward after reference", async () => {
    const duplicate = await writeManifest({
      ...base,
      stages: [base.stages[0], base.stages[0]],
    });
    try {
      await expect(parseRunManifest(duplicate.manifest)).rejects.toThrow(
        "duplicate stage id: s1",
      );
    } finally {
      await rm(duplicate.dir, { recursive: true, force: true });
    }
    const forward = await writeManifest({
      ...base,
      stages: [
        { id: "s1", plan: "plan.md", verifier: "verify.sh", after: "s2" },
        { id: "s2", plan: "plan.md", verifier: "verify.sh" },
      ],
    });
    try {
      await expect(parseRunManifest(forward.manifest)).rejects.toThrow(
        "after must name an earlier stage: s2",
      );
    } finally {
      await rm(forward.dir, { recursive: true, force: true });
    }
  });

  test("rejects an unreadable stage input before a worker starts", async () => {
    const { dir, manifest } = await writeManifest(base, ["verify.sh"]);
    try {
      await expect(parseRunManifest(manifest)).rejects.toThrow(
        /stage s1 plan is unreadable/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
