#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  hasChainState,
  parseRunManifest,
  readChainState,
  resumeManifest,
  runManifest,
} from "./chain.js";
import { inspectRun, recoverRun } from "./recovery.js";
import { reconcileRun } from "./reconciliation.js";
import { ResumeBlockedError, resumeSupervision } from "./supervisor.js";

const USAGE = [
  "Usage:",
  "  diriger run <manifest.json>",
  "  diriger status <evidence-directory> [--json]",
  "  diriger recover <evidence-directory> [--apply] [--json]",
  "  diriger resume <evidence-directory> [--json]",
  "",
  "The version-2 manifest is the only run configuration: repository, evidence,",
  "worker command, evaluator, budgets, and one or more sequential stages.",
  "A single-stage run is the one-stage case of the same document.",
  "",
  "Status exits: 0 ready/accepted/preview; 1 terminal; 2 invalid input/state; 3 ownership unsafe; 4 task blocked",
].join("\n");

interface CommandArgs {
  readonly path: string;
  readonly flags: ReadonlySet<string>;
}

/** One positional path plus optional boolean modifiers; no config flags. */
function readCommandArgs(
  args: ReadonlyArray<string>,
  booleans: ReadonlySet<string>,
): CommandArgs {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!booleans.has(name)) throw new Error(`unknown --${name}\n\n${USAGE}`);
      flags.add(name);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1)
    throw new Error("expected exactly one path\n\n" + USAGE);
  return { path: resolve(positionals[0]!), flags };
}

function chainExitCode(outcome: "running" | "accepted" | "failed" | "task-blocked"): number {
  return outcome === "accepted"
    ? 0
    : outcome === "task-blocked"
      ? 4
      : outcome === "failed"
        ? 1
        : 0;
}

/** Chain-level view: the manifest-driven run with per-stage state. */
async function chainStatus(
  evidencePath: string,
): Promise<{ body: unknown; code: number }> {
  const state = await readChainState(evidencePath);
  return {
    body: {
      status:
        state.outcome === "running"
          ? "ready"
          : state.outcome === "accepted"
            ? "accepted"
            : state.outcome === "failed"
              ? "failed"
              : "task-blocked",
      chainId: state.chainId,
      outcome: state.outcome,
      stages: state.stages,
      updatedAt: state.updatedAt,
    },
    code: chainExitCode(state.outcome),
  };
}

async function durableStatus(
  command: "status" | "recover",
  args: ReadonlyArray<string>,
): Promise<{ body: unknown; code: number }> {
  const { path: evidence, flags } = readCommandArgs(
    args,
    new Set(["json", "apply"]),
  );
  if (command === "status" && flags.has("apply"))
    throw new Error("--apply requires recover");
  if (await hasChainState(evidence)) {
    if (command === "recover" && flags.has("apply"))
      throw new Error(
        "recover --apply targets a stage evidence directory; a chain continues through resume",
      );
    return await chainStatus(evidence);
  }
  const inspection =
    command === "recover"
      ? await recoverRun({ evidencePath: evidence, apply: flags.has("apply") })
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

async function runCommand(args: ReadonlyArray<string>): Promise<void> {
  const { path: manifestPath } = readCommandArgs(args, new Set());
  const manifest = await parseRunManifest(manifestPath);
  const state = await runManifest(manifest);
  process.exitCode = chainExitCode(state.outcome);
}

async function resumeCommand(args: ReadonlyArray<string>): Promise<void> {
  const { path: evidence, flags } = readCommandArgs(args, new Set(["json"]));
  const json = flags.has("json");
  const print = (value: unknown): void => {
    console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  };
  if (await hasChainState(evidence)) {
    const state = await resumeManifest(evidence);
    print(state);
    process.exitCode = chainExitCode(state.outcome);
    return;
  }
  const record = await resumeSupervision(evidence);
  print(record);
  process.exitCode =
    record.status === "accepted" ? 0 : record.status === "task-blocked" ? 4 : 1;
}

async function main(): Promise<void> {
  try {
    const args = Bun.argv.slice(2);
    const command = args[0];
    if (command === "run") {
      await runCommand(args.slice(1));
      return;
    }
    if (command === "status" || command === "recover") {
      const result = await durableStatus(command, args.slice(1));
      console.log(
        args.includes("--json")
          ? JSON.stringify(result.body)
          : JSON.stringify(result.body, null, 2),
      );
      process.exitCode = result.code;
      return;
    }
    if (command === "resume") {
      await resumeCommand(args.slice(1));
      return;
    }
    throw new Error(USAGE);
  } catch (error) {
    if (error instanceof ResumeBlockedError) {
      console.error("Error: " + error.message);
      process.exitCode = 3;
      return;
    }
    console.error(
      "Error: " + (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 2;
  }
}
if (import.meta.main) await main();
