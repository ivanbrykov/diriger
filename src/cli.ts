#!/usr/bin/env bun

import { resolve } from "node:path";
import { supervise } from "./supervisor.js";
import type { SupervisorConfig } from "./types.js";

const USAGE = `Usage:
  goose-supervisor run \\
    --repo PATH \\
    --plan PATH \\
    --stage ID \\
    --verifier PATH \\
    --worker-recipe PATH \\
    --evidence PATH

Options:
  --goose PATH                    Goose executable (default: goose)
  --max-attempts N                Fresh worker attempts (default: 2)
  --worker-timeout-seconds N      Per-worker wall timeout (default: 1800)
  --no-tool-timeout-seconds N     Time before output-growth watchdog (default: 90)
  --no-tool-output-bytes N        Output since tool threshold (default: 262144)
  --run-id ID                     Evidence/session prefix (default: timestamp)
`;

function readFlags(args: ReadonlyArray<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error(`invalid arguments\n\n${USAGE}`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing --${key}\n\n${USAGE}`);
  }
  return value;
}

function positiveInteger(
  values: Map<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = values.get(key);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return value;
}

export function parseConfig(args: ReadonlyArray<string>): SupervisorConfig {
  if (args[0] !== "run") {
    throw new Error(USAGE);
  }

  const values = readFlags(args.slice(1));
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  return {
    repositoryPath: resolve(required(values, "repo")),
    planPath: resolve(required(values, "plan")),
    stage: required(values, "stage"),
    verifierPath: resolve(required(values, "verifier")),
    workerRecipePath: resolve(required(values, "worker-recipe")),
    evidencePath: resolve(required(values, "evidence")),
    gooseBin: values.get("goose") ?? "goose",
    maxAttempts: positiveInteger(values, "max-attempts", 2),
    workerTimeoutMs:
      positiveInteger(values, "worker-timeout-seconds", 1_800) * 1_000,
    noToolTimeoutMs:
      positiveInteger(values, "no-tool-timeout-seconds", 90) * 1_000,
    noToolOutputBytes: positiveInteger(
      values,
      "no-tool-output-bytes",
      262_144,
    ),
    runId: values.get("run-id") ?? `goose-supervisor-${timestamp}`,
  };
}

async function main(): Promise<void> {
  try {
    const config = parseConfig(Bun.argv.slice(2));
    const record = await supervise(config);
    process.exitCode = record.status === "accepted" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  await main();
}

