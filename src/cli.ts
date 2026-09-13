#!/usr/bin/env bun

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ResumeBlockedError, supervise } from "./supervisor.js";
import { inspectRun, recoverRun } from "./recovery.js";
import { reconcileRun } from "./reconciliation.js";
import type { SupervisorConfig } from "./types.js";

const USAGE = [
  "Usage:",
  "  diriger run --repo PATH --plan PATH --stage ID --verifier PATH --evidence PATH --acp-command JSON_ARGV",
  "  diriger status --evidence PATH [--json]",
  "  diriger recover --evidence PATH [--apply] [--json]",
  "  diriger resume --evidence PATH [--json]",
  "",
  "Status exits: 0 ready/accepted/preview; 1 terminal; 2 invalid input/state; 3 ownership unsafe; 4 task blocked",
  "",
  "Options:",
  "  --acp-command JSON_ARGV         ACP stdio argv as a nonempty JSON array (required)",
  "  --prompt PATH                   Worker prompt template (default: bundled prompts/worker.md)",
  "  --worker-report required|optional  Structured worker outcome requirement (default: required)",
  "  --max-attempts N                Fresh worker attempts (default: 2)",
  "  --worker-timeout-seconds N      Per-worker wall timeout (default: 1800)",
  "  --no-tool-timeout-seconds N     Tool-free time gate for generation budget (default: 90)",
  "  --no-tool-output-bytes N        ACP text bytes since tool (default: 262144)",
  "  --max-tool-calls N              ACP tool-call budget per attempt (default: 100)",
  "  --max-tool-repetitions N        Consecutive identical tool-call budget (default: 8)",
  "  --run-id ID                     Evidence/session prefix (default: timestamp)",
  "  --verifier-manifest PATH        JSON verifier dependency closure",
].join("\n");

function readFlags(
  args: ReadonlyArray<string>,
  booleanFlags: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; ) {
    const key = args[index];
    if (key === undefined || !key.startsWith("--"))
      throw new Error("invalid arguments\n\n" + USAGE);
    const name = key.slice(2);
    if (values.has(name)) throw new Error(`duplicate --${name}`);
    if (booleanFlags.has(name)) {
      values.set(name, "true");
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error("invalid arguments\n\n" + USAGE);
    values.set(name, value);
    index += 2;
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "") {
    throw new Error("missing --" + key + "\n\n" + USAGE);
  }
  return value;
}

function positiveInteger(
  values: Map<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("--" + key + " must be a positive integer");
  }
  return value;
}

function defaultPromptPath(): string {
  return resolve(import.meta.dir, "..", "prompts", "worker.md");
}

function parseAcpCommand(raw: string): ReadonlyArray<string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "--acp-command must be a JSON array of nonempty argv strings",
    );
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(
      "--acp-command must be a JSON array of nonempty argv strings",
    );
  }
  return value;
}

async function durableStatus(
  command: "status" | "recover",
  args: ReadonlyArray<string>,
): Promise<{ body: unknown; code: number }> {
  const values = readFlags(args, new Set(["json", "apply"]));
  const evidence = resolve(required(values, "evidence"));
  for (const key of values.keys())
    if (!["evidence", "json", "apply"].includes(key))
      throw new Error(`unknown --${key}`);
  if (command === "status" && values.has("apply"))
    throw new Error("--apply requires recover");
  const inspection =
    command === "recover"
      ? await recoverRun({ evidencePath: evidence, apply: values.has("apply") })
      : await inspectRun(evidence);
  if (!inspection.state) {
    if (inspection.legacySummary !== undefined)
      return {
        body: {
          status: "historic",
          legacySummary: inspection.legacySummary,
          resumable: false,
          reasons: inspection.blocked,
          actions: inspection.actions,
        },
        code: 3,
      };
    throw new Error(inspection.blocked.join("; ") || "invalid durable state");
  }
  let max = 2;
  try {
    const raw = JSON.parse(
      await Bun.file(resolve(evidence, "inputs/config.frozen.json")).text(),
    ) as { maxAttempts?: unknown };
    if (
      typeof raw.maxAttempts === "number" &&
      Number.isSafeInteger(raw.maxAttempts)
    )
      max = raw.maxAttempts;
  } catch {}
  const decision = await reconcileRun(evidence, inspection.state, max);
  const status =
    inspection.ownership?.state === "active"
      ? "active"
      : inspection.blocked.length || decision.action === "blocked"
        ? "blocked"
        : decision.action === "task-blocked" ||
            (decision.action === "terminal" &&
              inspection.state.phase === "task_blocked")
          ? "task-blocked"
          : decision.action === "terminal"
          ? "failed"
          : decision.action === "reuse-accepted"
            ? "accepted"
            : "ready";
  return {
    body: {
      status,
      reasons: [...inspection.blocked, decision.reason],
      actions: inspection.actions,
      decision,
      ...(inspection.state.attempt?.blockageReason === undefined
        ? {}
        : { blockageReason: inspection.state.attempt.blockageReason }),
    },
    code:
      status === "task-blocked"
        ? 4
        : status === "active" || status === "blocked"
        ? 3
        : status === "failed"
          ? 1
          : 0,
  };
}

export function parseConfig(args: ReadonlyArray<string>): SupervisorConfig {
  if (args[0] !== "run") throw new Error(USAGE);
  const values = readFlags(args.slice(1));
  const acpCommand = parseAcpCommand(required(values, "acp-command"));
  const reportMode = values.get("worker-report") ?? "required";
  if (reportMode !== "required" && reportMode !== "optional")
    throw new Error("--worker-report must be required or optional");
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return {
    repositoryPath: resolve(required(values, "repo")),
    planPath: resolve(required(values, "plan")),
    stage: required(values, "stage"),
    verifierPath: resolve(required(values, "verifier")),
    promptPath: resolve(values.get("prompt") ?? defaultPromptPath()),
    evidencePath: resolve(required(values, "evidence")),
    acpCommand,
    workerReportRequired: reportMode === "required",
    maxAttempts: positiveInteger(values, "max-attempts", 2),
    workerTimeoutMs:
      positiveInteger(values, "worker-timeout-seconds", 1_800) * 1_000,
    noToolTimeoutMs:
      positiveInteger(values, "no-tool-timeout-seconds", 90) * 1_000,
    noToolOutputBytes: positiveInteger(values, "no-tool-output-bytes", 262_144),
    maxToolCalls: positiveInteger(values, "max-tool-calls", 100),
    maxToolRepetitions: positiveInteger(values, "max-tool-repetitions", 8),
    runId: values.get("run-id") ?? "diriger-" + timestamp,
  };
}

export async function loadRunConfig(
  args: ReadonlyArray<string>,
): Promise<SupervisorConfig> {
  const config = parseConfig(args);
  const values = readFlags(args.slice(1));
  const manifestPath = values.get("verifier-manifest");
  if (manifestPath === undefined) return config;
  let raw: unknown;
  const absolute = resolve(manifestPath);
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"));
  } catch {
    throw new Error("--verifier-manifest must be readable JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid verifier manifest");
  const m = raw as {
    selfContained?: unknown;
    snapshotRoot?: unknown;
    dependencies?: unknown;
  };
  if (
    typeof m.selfContained !== "boolean" ||
    !Array.isArray(m.dependencies) ||
    m.dependencies.some((x) => typeof x !== "string" || x.trim() === "")
  )
    throw new Error("invalid verifier manifest closure");
  if (m.selfContained && m.dependencies.length > 0)
    throw new Error("self-contained verifier cannot declare dependencies");
  if (m.snapshotRoot !== undefined && typeof m.snapshotRoot !== "string")
    throw new Error("invalid verifier manifest snapshotRoot");
  const base = dirname(absolute),
    path = (x: string) => resolve(base, x);
  const root = m.snapshotRoot === undefined ? undefined : path(m.snapshotRoot);
  if (root !== undefined && !isAbsolute(root))
    throw new Error("invalid verifier manifest snapshotRoot");
  const dependencies = m.dependencies.map(path);
  for (const dependency of dependencies) {
    try {
      await access(dependency);
    } catch {
      throw new Error(
        `verifier manifest dependency is unreadable: ${dependency}`,
      );
    }
  }
  return {
    ...config,
    verifierSelfContained: m.selfContained,
    verifierDependencies: dependencies,
    ...(root === undefined ? {} : { verifierSnapshotRoot: root }),
  };
}

async function main(): Promise<void> {
  try {
    const args = Bun.argv.slice(2);
    if (args[0] === "status" || args[0] === "recover") {
      const result = await durableStatus(args[0], args.slice(1));
      const json = args.includes("--json");
      console.log(
        json
          ? JSON.stringify(result.body)
          : JSON.stringify(result.body, null, 2),
      );
      process.exitCode = result.code;
      return;
    }
    if (args[0] === "resume") {
      const values = readFlags(args.slice(1), new Set(["json"]));
      for (const key of values.keys())
        if (!["evidence", "json"].includes(key))
          throw new Error(`unknown --${key}`);
      const { resumeSupervision } = await import("./supervisor.js");
      try {
        const record = await resumeSupervision(
          resolve(required(values, "evidence")),
        );
        console.log(
          values.has("json")
            ? JSON.stringify(record)
            : JSON.stringify(record, null, 2),
        );
        process.exitCode = record.status === "accepted" ? 0 : record.status === "task-blocked" ? 4 : 1;
      } catch (error) {
        if (error instanceof ResumeBlockedError) {
          console.error("Error: " + error.message);
          process.exitCode = 3;
          return;
        }
        throw error;
      }
      return;
    }
    const record = await supervise(await loadRunConfig(args));
    process.exitCode = record.status === "accepted" ? 0 : record.status === "task-blocked" ? 4 : 1;
  } catch (error) {
    console.error(
      "Error: " + (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 2;
  }
}
if (import.meta.main) await main();
