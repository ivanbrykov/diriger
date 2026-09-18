import { createHash } from "node:crypto";
import { access, mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.js";
import { resumeSupervision, supervise } from "./supervisor.js";
import type {
  ChainOutcome,
  ChainStageState,
  ChainState,
  ManifestBudgets,
  ManifestStage,
  RunManifest,
  RunRecord,
  SupervisorConfig,
} from "./types.js";

export class ChainError extends Error {}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BUDGET_KEYS = {
  maxAttempts: "positive",
  workerTimeoutSeconds: "positive",
  maxToolCalls: "positive",
  toolCallCushion: "non-negative",
  maxToolRepetitions: "positive",
  noToolTimeoutSeconds: "positive",
  noToolOutputBytes: "positive",
} as const;
const STAGE_KEYS = [
  "id",
  "plan",
  "checks",
  "verifier",
  "verifierManifest",
  "after",
  ...Object.keys(BUDGET_KEYS),
] as const;
const TOP_KEYS = [
  "version",
  "chain",
  "runId",
  "repository",
  "evidence",
  "prompt",
  "worker",
  "evaluator",
  "retries",
  "defaults",
  "stages",
] as const;
const STAGE_STATUSES = [
  "pending",
  "running",
  "accepted",
  "failed",
  "task-blocked",
] as const;
const OUTCOMES = ["running", "accepted", "failed", "task-blocked"] as const;

/** Hard budget defaults, overridden by manifest `defaults` and stage fields. */
export const DEFAULT_BUDGETS: Required<ManifestBudgets> = {
  maxAttempts: 2,
  workerTimeoutSeconds: 1_800,
  maxToolCalls: 100,
  toolCallCushion: 15,
  maxToolRepetitions: 8,
  noToolTimeoutSeconds: 90,
  noToolOutputBytes: 262_144,
};

const rec = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ChainError(`${where} must be a nonempty string`);
  return value;
}

function argv(value: unknown, where: string): ReadonlyArray<string> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  )
    throw new ChainError(
      `${where} must be a JSON array of nonempty argv strings`,
    );
  return value;
}

function budgets(value: unknown, where: string): ManifestBudgets {
  if (value === undefined) return {};
  if (!rec(value)) throw new ChainError(`${where} must be an object`);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rule = (BUDGET_KEYS as Record<string, string>)[key];
    if (rule === undefined)
      throw new ChainError(`unknown manifest key: ${where}.${key}`);
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      (rule === "positive" ? entry < 1 : entry < 0)
    )
      throw new ChainError(`${where}.${key} must be a ${rule} integer`);
    result[key] = entry;
  }
  return result;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ChainError(`${where} must be a non-negative integer`);
  return value;
}

function fraction(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new ChainError(`${where} must be a non-negative number`);
  return value;
}

/**
 * Resolve the retry policy. `defaults.maxAttempts` is the legacy spelling and
 * maps onto unconditional retries; setting both is a manifest error.
 */
function parseRetries(
  value: unknown,
  maxAttempts: number | undefined,
): { readonly policy: RetryPolicy; readonly maxAttempts: number } {
  if (value === undefined) {
    if (maxAttempts === undefined)
      return {
        policy: DEFAULT_RETRY_POLICY,
        maxAttempts: 1 + DEFAULT_RETRY_POLICY.hard + DEFAULT_RETRY_POLICY.soft,
      };
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
      throw new ChainError("defaults.maxAttempts must be a positive integer");
    return {
      policy: { ...DEFAULT_RETRY_POLICY, hard: maxAttempts - 1, soft: 0 },
      maxAttempts,
    };
  }
  if (!rec(value)) throw new ChainError("manifest retries must be an object");
  for (const key of Object.keys(value))
    if (!["hard", "soft", "extend"].includes(key))
      throw new ChainError(`unknown manifest key: retries.${key}`);
  if (maxAttempts !== undefined)
    throw new ChainError(
      "manifest cannot set both retries and defaults.maxAttempts",
    );
  const hard = count(value.hard ?? 0, "retries.hard");
  const soft = count(value.soft ?? 0, "retries.soft");
  let extend = DEFAULT_RETRY_POLICY.extend;
  if (value.extend !== undefined) {
    if (!rec(value.extend))
      throw new ChainError("manifest retries.extend must be an object");
    for (const key of Object.keys(value.extend))
      if (!["toolCalls", "timeout", "ceiling"].includes(key))
        throw new ChainError(`unknown manifest key: retries.extend.${key}`);
    const ceiling = value.extend.ceiling ?? extend.ceiling;
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 1)
      throw new ChainError("retries.extend.ceiling must be a number >= 1");
    extend = {
      toolCalls: fraction(
        value.extend.toolCalls ?? extend.toolCalls,
        "retries.extend.toolCalls",
      ),
      timeout: fraction(
        value.extend.timeout ?? extend.timeout,
        "retries.extend.timeout",
      ),
      ceiling,
    };
  }
  return { policy: { hard, soft, extend }, maxAttempts: 1 + hard + soft };
}

/**
 * Resolve a v3 `checks` path into the frozen closure the supervisor expects.
 * A file is a self-contained entry; a directory must contain `run.sh` or `run`
 * as its entry, and every other file under it becomes a frozen dependency. The
 * caller declares no closure schema — Diriger enumerates and hashes the path.
 */
async function resolveChecks(
  checksPath: string,
  where: string,
  strict: boolean,
): Promise<{
  readonly entryPath: string;
  readonly files: ReadonlyArray<string>;
  readonly closure: ManifestStage["verifier"];
}> {
  let details;
  try {
    details = await stat(checksPath);
  } catch {
    if (strict) throw new ChainError(`${where} is unreadable: ${checksPath}`);
    return { entryPath: checksPath, files: [checksPath], closure: undefined };
  }
  if (details.isFile())
    return {
      entryPath: checksPath,
      files: [checksPath],
      closure: { selfContained: true },
    };
  if (!details.isDirectory())
    throw new ChainError(`${where} must be a file or directory: ${checksPath}`);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(checksPath);
  if (files.length === 0)
    throw new ChainError(`${where} contains no files: ${checksPath}`);
  const entryPath = files.find((file) => {
    const name = basename(file);
    return name === "run.sh" || name === "run";
  });
  if (entryPath === undefined)
    throw new ChainError(
      `${where} must contain run.sh or run as its entry: ${checksPath}`,
    );
  const dependencies = files.filter((file) => file !== entryPath);
  return {
    entryPath,
    files,
    closure: {
      selfContained: false,
      dependencies,
      snapshotRoot: checksPath,
    },
  };
}

async function parseManifestValue(
  raw: unknown,
  manifestPath: string,
  base: string,
  strict: boolean,
): Promise<RunManifest> {
  if (!rec(raw)) throw new ChainError("invalid manifest");
  for (const key of Object.keys(raw))
    if (!(TOP_KEYS as ReadonlyArray<string>).includes(key))
      throw new ChainError(`unknown manifest key: ${key}`);
  if (raw.version !== 2 && raw.version !== 3)
    throw new ChainError("manifest version must be 2 or 3");
  for (const key of ["chain", "runId"] as const)
    if (raw[key] !== undefined) text(raw[key], `manifest ${key}`);

  const pathOf = (value: unknown, label: string): string =>
    resolve(base, text(value, label));

  if (!rec(raw.worker)) throw new ChainError("manifest worker must be an object");
  for (const key of Object.keys(raw.worker))
    if (!["command", "report"].includes(key))
      throw new ChainError(`unknown manifest key: worker.${key}`);
  const workerCommand = argv(raw.worker.command, "worker.command");
  const report = raw.worker.report ?? "required";
  if (report !== "required" && report !== "optional")
    throw new ChainError("worker.report must be required or optional");

  let progressEvaluator: RunManifest["progressEvaluator"];
  if (raw.evaluator !== undefined) {
    if (!rec(raw.evaluator))
      throw new ChainError("manifest evaluator must be an object");
    for (const key of Object.keys(raw.evaluator))
      if (!["command", "timeoutSeconds"].includes(key))
        throw new ChainError(`unknown manifest key: evaluator.${key}`);
    const timeoutSeconds = raw.evaluator.timeoutSeconds ?? 120;
    if (
      typeof timeoutSeconds !== "number" ||
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1
    )
      throw new ChainError("evaluator.timeoutSeconds must be a positive integer");
    progressEvaluator = {
      command: argv(raw.evaluator.command, "evaluator.command"),
      timeoutMs: timeoutSeconds * 1_000,
    };
  }

  const defaults = budgets(raw.defaults, "defaults");
  const { policy: retries, maxAttempts } = parseRetries(
    raw.retries,
    defaults.maxAttempts,
  );
  if (!Array.isArray(raw.stages) || raw.stages.length === 0)
    throw new ChainError("manifest stages must be a nonempty array");

  const stages: ManifestStage[] = [];
  for (let index = 0; index < raw.stages.length; index++) {
    const entry: unknown = raw.stages[index];
    if (!rec(entry)) throw new ChainError(`stages[${index}] must be an object`);
    for (const key of Object.keys(entry))
      if (!(STAGE_KEYS as ReadonlyArray<string>).includes(key))
        throw new ChainError(`unknown manifest key: stages[${index}].${key}`);
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id))
      throw new ChainError(`stages[${index}].id must be a filesystem-safe id`);
    if (stages.some((stage) => stage.id === entry.id))
      throw new ChainError(`duplicate stage id: ${entry.id}`);
    let after: string | undefined;
    if (entry.after !== undefined) {
      after = text(entry.after, `stages[${index}].after`);
      if (!stages.some((stage) => stage.id === after))
        throw new ChainError(
          `stages[${index}].after must name an earlier stage: ${after}`,
        );
    } else if (index > 0) {
      after = stages[index - 1]!.id;
    }
    const stageBudgets = budgets(
      Object.fromEntries(
        Object.entries(entry).filter(([key]) => key in BUDGET_KEYS),
      ),
      `stages[${index}]`,
    );
    let stage: ManifestStage;
    if (entry.checks !== undefined) {
      if (entry.verifier !== undefined || entry.verifierManifest !== undefined)
        throw new ChainError(
          `stages[${index}] cannot set both checks and verifier`,
        );
      const checksPath = pathOf(entry.checks, `stages[${index}].checks`);
      const resolved = await resolveChecks(
        checksPath,
        `stages[${index}].checks`,
        strict,
      );
      stage = {
        id: entry.id,
        planPath: pathOf(entry.plan, `stages[${index}].plan`),
        verifierPath: resolved.entryPath,
        verifierFiles: resolved.files,
        ...(resolved.closure === undefined
          ? {}
          : { verifier: resolved.closure }),
        ...(after === undefined ? {} : { after }),
        ...(Object.keys(stageBudgets).length === 0
          ? {}
          : { budgets: stageBudgets }),
      };
    } else {
      stage = {
        id: entry.id,
        planPath: pathOf(entry.plan, `stages[${index}].plan`),
        verifierPath: pathOf(entry.verifier, `stages[${index}].verifier`),
        ...(entry.verifierManifest === undefined
          ? {}
          : {
              verifierManifestPath: pathOf(
                entry.verifierManifest,
                `stages[${index}].verifierManifest`,
              ),
            }),
        ...(after === undefined ? {} : { after }),
        ...(Object.keys(stageBudgets).length === 0
          ? {}
          : { budgets: stageBudgets }),
      };
    }
    stages.push(stage);
  }

  return {
    version: raw.version === 3 ? 3 : 2,
    manifestPath,
    chainId:
      typeof raw.runId === "string"
        ? raw.runId
        : typeof raw.chain === "string"
          ? raw.chain
          : basename(manifestPath).replace(/\.json$/i, ""),
    repositoryPath: pathOf(raw.repository, "manifest repository"),
    evidencePath: pathOf(raw.evidence, "manifest evidence"),
    promptPath: resolve(base, bundledPromptPath(raw.prompt, base)),
    workerCommand,
    workerReportRequired: report === "required",
    ...(progressEvaluator === undefined ? {} : { progressEvaluator }),
    budgets: { ...DEFAULT_BUDGETS, ...defaults, maxAttempts },
    retries,
    stages,
  };
}

function bundledPromptPath(value: unknown, base: string): string {
  if (value === undefined)
    return resolve(import.meta.dir, "..", "prompts", "worker.md");
  return resolve(base, text(value, "manifest prompt"));
}

/** Parse and validate a version-2 run manifest, resolving paths against it. */
export async function parseRunManifest(path: string): Promise<RunManifest> {
  const manifestPath = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new ChainError(`manifest must be readable JSON: ${manifestPath}`);
  }
  const manifest = await parseManifestValue(
    raw,
    manifestPath,
    dirname(manifestPath),
    true,
  );
  for (const stage of manifest.stages) {
    for (const [label, file] of [
      ["plan", stage.planPath],
      ["verifier", stage.verifierPath],
      ...(stage.verifierManifestPath === undefined
        ? []
        : [["verifierManifest", stage.verifierManifestPath] as const]),
    ] as ReadonlyArray<readonly [string, string]>) {
      try {
        await access(file);
      } catch {
        throw new ChainError(
          `stage ${stage.id} ${label} is unreadable: ${file}`,
        );
      }
    }
  }
  return manifest;
}

/** Rebuild the manifest recorded in a frozen chain without re-reading inputs. */
async function manifestFromFrozen(frozen: FrozenChain): Promise<RunManifest> {
  return await parseManifestValue(
    frozen.manifest,
    frozen.manifestPath,
    dirname(frozen.manifestPath),
    false,
  );
}

export interface VerifierClosure {
  readonly selfContained: boolean;
  readonly dependencies: ReadonlyArray<string>;
  readonly snapshotRoot?: string;
}

/** Load a verifier closure manifest, resolving dependency paths against it. */
export async function loadVerifierManifestClosure(
  manifestPath: string,
): Promise<VerifierClosure> {
  let raw: unknown;
  const absolute = resolve(manifestPath);
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"));
  } catch {
    throw new ChainError("verifier manifest must be readable JSON");
  }
  if (!rec(raw)) throw new ChainError("invalid verifier manifest");
  const m = raw;
  if (
    typeof m.selfContained !== "boolean" ||
    !Array.isArray(m.dependencies) ||
    m.dependencies.some((x) => typeof x !== "string" || x.trim() === "")
  )
    throw new ChainError("invalid verifier manifest closure");
  if (m.selfContained && m.dependencies.length > 0)
    throw new ChainError("self-contained verifier cannot declare dependencies");
  if (m.snapshotRoot !== undefined && typeof m.snapshotRoot !== "string")
    throw new ChainError("invalid verifier manifest snapshotRoot");
  const base = dirname(absolute),
    path = (x: string) => resolve(base, x);
  const snapshotRoot =
    m.snapshotRoot === undefined ? undefined : path(m.snapshotRoot);
  const dependencies = m.dependencies.map(path);
  for (const dependency of dependencies) {
    try {
      await access(dependency);
    } catch {
      throw new ChainError(
        `verifier manifest dependency is unreadable: ${dependency}`,
      );
    }
  }
  return {
    selfContained: m.selfContained,
    dependencies,
    ...(snapshotRoot === undefined ? {} : { snapshotRoot }),
  };
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function assertChainState(value: unknown): asserts value is ChainState {
  if (
    !rec(value) ||
    value.version !== 1 ||
    typeof value.chainId !== "string" ||
    value.chainId.trim() === "" ||
    typeof value.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    !Array.isArray(value.stages) ||
    value.stages.length === 0 ||
    !value.stages.every(
      (stage) =>
        rec(stage) &&
        typeof stage.id === "string" &&
        ID_PATTERN.test(stage.id) &&
        (STAGE_STATUSES as ReadonlyArray<string>).includes(stage.status as string) &&
        (stage.commit === undefined || typeof stage.commit === "string") &&
        (stage.runEvidence === undefined ||
          typeof stage.runEvidence === "string"),
    ) ||
    !(OUTCOMES as ReadonlyArray<string>).includes(value.outcome as string) ||
    typeof value.startedAt !== "string" ||
    Number.isNaN(Date.parse(value.startedAt)) ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  )
    throw new ChainError("invalid chain state schema");
}

/** Read the durable chain state under `<evidence>/chain/state.json`. */
export async function readChainState(evidencePath: string): Promise<ChainState> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(evidencePath, "chain", "state.json"), "utf8"),
    );
  } catch (error) {
    throw new ChainError(
      `cannot read chain state: ${(error as Error).message}`,
    );
  }
  assertChainState(value);
  return value;
}

/** Whether an evidence directory belongs to a manifest-driven chain run. */
export async function hasChainState(evidencePath: string): Promise<boolean> {
  return await Bun.file(join(evidencePath, "chain", "state.json")).exists();
}

async function writeChainState(
  evidencePath: string,
  state: ChainState,
): Promise<ChainState> {
  assertChainState(state);
  await atomicWrite(
    join(evidencePath, "chain", "state.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
  return state;
}

interface FrozenChainFile {
  readonly role: "plan" | "verifier" | "verifierManifest" | "prompt";
  readonly stage?: string;
  /** Relative to the manifest directory; absolute when outside it. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface FrozenChain {
  readonly version: 2;
  readonly chainId: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: unknown;
  readonly files: ReadonlyArray<FrozenChainFile>;
}

async function freezeFile(
  manifestDir: string,
  file: string,
  role: FrozenChainFile["role"],
  stage?: string,
): Promise<FrozenChainFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new ChainError(`manifest input is unreadable: ${file}`);
  }
  return {
    role,
    ...(stage === undefined ? {} : { stage }),
    path: relative(manifestDir, file),
    sha256: hash(bytes),
    bytes: bytes.byteLength,
  };
}

/** Freeze the manifest and every referenced file into `<evidence>/chain/`. */
export async function createFrozenChain(
  manifest: RunManifest,
): Promise<ChainState> {
  try {
    await mkdir(manifest.evidencePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ChainError(
        `evidence directory already exists: ${manifest.evidencePath}`,
      );
    throw error;
  }
  await mkdir(join(manifest.evidencePath, "chain"), { mode: 0o700 });
  const manifestBytes = await readFile(manifest.manifestPath);
  const manifestDir = dirname(manifest.manifestPath);
  const files: FrozenChainFile[] = [];
  for (const stage of manifest.stages) {
    files.push(await freezeFile(manifestDir, stage.planPath, "plan", stage.id));
    for (const file of stage.verifierFiles ?? [stage.verifierPath])
      files.push(await freezeFile(manifestDir, file, "verifier", stage.id));
    if (stage.verifierManifestPath !== undefined)
      files.push(
        await freezeFile(
          manifestDir,
          stage.verifierManifestPath,
          "verifierManifest",
          stage.id,
        ),
      );
  }
  files.push(await freezeFile(manifestDir, manifest.promptPath, "prompt"));
  const frozen: FrozenChain = {
    version: 2,
    chainId: manifest.chainId,
    manifestPath: manifest.manifestPath,
    manifestSha256: hash(manifestBytes),
    manifest: JSON.parse(new TextDecoder().decode(manifestBytes)),
    files,
  };
  await atomicWrite(
    join(manifest.evidencePath, "chain", "chain.json"),
    JSON.stringify(frozen, null, 2) + "\n",
  );
  const startedAt = now();
  return await writeChainState(manifest.evidencePath, {
    version: 1,
    chainId: manifest.chainId,
    manifestSha256: frozen.manifestSha256,
    stages: manifest.stages.map((stage) => ({
      id: stage.id,
      status: "pending" as const,
    })),
    outcome: "running",
    startedAt,
    updatedAt: startedAt,
  });
}

function frozenChain(value: unknown): FrozenChain {
  if (
    !rec(value) ||
    value.version !== 2 ||
    typeof value.chainId !== "string" ||
    typeof value.manifestPath !== "string" ||
    typeof value.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) =>
        rec(file) &&
        typeof file.path === "string" &&
        typeof file.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(file.sha256) &&
        typeof file.bytes === "number" &&
        Number.isInteger(file.bytes) &&
        file.bytes >= 0,
    )
  )
    throw new ChainError("invalid frozen chain manifest");
  return value as unknown as FrozenChain;
}

/**
 * Re-validate the frozen chain inputs; a changed manifest or referenced file
 * blocks the run rather than silently resuming a divergent chain.
 */
export async function validateFrozenChain(
  evidencePath: string,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(evidencePath, "chain", "chain.json"), "utf8"),
    );
  } catch (error) {
    throw new ChainError(
      `cannot read frozen chain manifest: ${(error as Error).message}`,
    );
  }
  const frozen = frozenChain(value);
  const state = await readChainState(evidencePath);
  if (state.manifestSha256 !== frozen.manifestSha256)
    throw new ChainError("frozen manifest drift");
  const manifestDir = dirname(frozen.manifestPath);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(frozen.manifestPath);
  } catch {
    throw new ChainError(
      `frozen manifest is unreadable: ${frozen.manifestPath}`,
    );
  }
  if (hash(manifestBytes) !== frozen.manifestSha256)
    throw new ChainError("frozen manifest drift: " + frozen.manifestPath);
  for (const file of frozen.files) {
    const path = resolve(manifestDir, file.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new ChainError(`frozen input is unreadable: ${path}`);
    }
    if (bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256)
      throw new ChainError(`frozen input drift: ${file.path}`);
  }
}

function gitHead(repositoryPath: string): string {
  const result = Bun.spawnSync(
    ["git", "--no-replace-objects", "-C", repositoryPath, "rev-parse", "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new ChainError(
      "git rev-parse HEAD failed: " +
        new TextDecoder().decode(result.stderr).trim(),
    );
  return new TextDecoder().decode(result.stdout).trim();
}

async function previousReportPath(
  evidencePath: string,
  record: RunRecord,
): Promise<string> {
  const last = record.attempts.at(-1);
  if (last !== undefined) {
    const candidate = join(
      evidencePath,
      "attempts",
      String(last.attempt).padStart(3, "0"),
      "worker-report.json",
    );
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return join(evidencePath, "run.json");
}

function budget(
  manifest: RunManifest,
  stage: ManifestStage,
  key: keyof Required<ManifestBudgets>,
): number {
  return stage.budgets?.[key] ?? manifest.budgets[key];
}

async function stageConfig(
  manifest: RunManifest,
  stage: ManifestStage,
  evidencePath: string,
  previous: StageRun | undefined,
): Promise<SupervisorConfig> {
  const closure =
    stage.verifier ??
    (stage.verifierManifestPath === undefined
      ? undefined
      : await loadVerifierManifestClosure(stage.verifierManifestPath));
  return {
    repositoryPath: manifest.repositoryPath,
    planPath: stage.planPath,
    stage: stage.id,
    verifierPath: stage.verifierPath,
    promptPath: manifest.promptPath,
    evidencePath,
    acpCommand: manifest.workerCommand,
    workerReportRequired: manifest.workerReportRequired,
    ...(manifest.progressEvaluator === undefined
      ? {}
      : { progressEvaluator: manifest.progressEvaluator }),
    maxAttempts: budget(manifest, stage, "maxAttempts"),
    workerTimeoutMs: budget(manifest, stage, "workerTimeoutSeconds") * 1_000,
    noToolTimeoutMs: budget(manifest, stage, "noToolTimeoutSeconds") * 1_000,
    noToolOutputBytes: budget(manifest, stage, "noToolOutputBytes"),
    maxToolCalls: budget(manifest, stage, "maxToolCalls"),
    toolCallCushion: budget(manifest, stage, "toolCallCushion"),
    maxToolRepetitions: budget(manifest, stage, "maxToolRepetitions"),
    retryPolicy: manifest.retries,
    ...(closure === undefined
      ? {}
      : {
          verifierSelfContained: closure.selfContained,
          verifierDependencies: closure.dependencies,
          ...(closure.snapshotRoot === undefined
            ? {}
            : { verifierSnapshotRoot: closure.snapshotRoot }),
        }),
    ...(previous === undefined
      ? {}
      : {
          previousStageCommit: previous.record.acceptedHead ?? "",
          previousStageReportPath: await previousReportPath(
            previous.evidencePath,
            previous.record,
          ),
        }),
    runId: `${manifest.chainId}-${stage.id}`,
  };
}

interface StageRun {
  readonly record: RunRecord;
  readonly evidencePath: string;
}

async function loadAcceptedStage(
  evidencePath: string,
  stage: ChainStageState,
): Promise<StageRun> {
  const stageEvidence = join(evidencePath, "stages", stage.id);
  let record: RunRecord;
  try {
    record = JSON.parse(
      await readFile(join(stageEvidence, "run.json"), "utf8"),
    ) as RunRecord;
  } catch {
    throw new ChainError(
      `accepted stage ${stage.id} is missing its run summary`,
    );
  }
  return { record, evidencePath: stageEvidence };
}

interface ExecuteOptions {
  readonly manifest: RunManifest;
  readonly evidencePath: string;
  readonly stages: ChainStageState[];
  readonly startIndex: number;
  readonly previous: StageRun | undefined;
  readonly save: (
    stages: ReadonlyArray<ChainStageState>,
    outcome: ChainOutcome,
  ) => Promise<ChainState>;
}

/**
 * Run the manifest stages sequentially from `startIndex`. Each stage starts
 * from its predecessor's accepted commit and receives the predecessor's report
 * through the prompt handoff variables. The first non-accepted stage halts the
 * chain; an existing stage evidence directory is resumed instead of restarted.
 */
async function executeStages(options: ExecuteOptions): Promise<ChainState> {
  const { manifest, evidencePath, stages, save } = options;
  let previous = options.previous;
  let state = await save(stages, "running");
  for (let index = options.startIndex; index < manifest.stages.length; index++) {
    const stage = manifest.stages[index]!;
    const stageEvidence = join(evidencePath, "stages", stage.id);
    if (previous !== undefined) {
      const acceptedHead = previous.record.acceptedHead;
      if (previous.record.status !== "accepted" || acceptedHead === undefined)
        throw new ChainError(`stage ${stage.id} predecessor was not accepted`);
      const current = gitHead(manifest.repositoryPath);
      if (current !== acceptedHead)
        throw new ChainError(
          `stage ${stage.id} cannot start: predecessor accepted commit ${acceptedHead} is not the current HEAD ${current}`,
        );
    }
    const config = await stageConfig(manifest, stage, stageEvidence, previous);
    stages[index] = { id: stage.id, status: "running", runEvidence: `stages/${stage.id}` };
    state = await save(stages, "running");
    const resumable = await Bun.file(join(stageEvidence, "state.json")).exists();
    let record: RunRecord;
    try {
      record = resumable
        ? await resumeSupervision(stageEvidence)
        : await supervise(config);
    } catch (error) {
      stages[index] = { id: stage.id, status: "failed", runEvidence: `stages/${stage.id}` };
      await save(stages, "failed");
      throw error;
    }
    stages[index] = {
      id: stage.id,
      status: record.status,
      runEvidence: `stages/${stage.id}`,
      ...(record.acceptedHead === undefined
        ? {}
        : { commit: record.acceptedHead }),
    };
    state = await save(
      stages,
      record.status !== "accepted"
        ? record.status
        : index === manifest.stages.length - 1
          ? "accepted"
          : "running",
    );
    if (record.status !== "accepted") return state;
    previous = { record, evidencePath: stageEvidence };
  }
  return state;
}

/** Create a fresh chain from a manifest and run its stages in order. */
export async function runManifest(manifest: RunManifest): Promise<ChainState> {
  const frozen = await createFrozenChain(manifest);
  const stages = frozen.stages.map((stage) => ({ ...stage }));
  const save = (
    next: ReadonlyArray<ChainStageState>,
    outcome: ChainOutcome,
  ): Promise<ChainState> =>
    writeChainState(manifest.evidencePath, {
      ...frozen,
      stages: [...next],
      outcome,
      updatedAt: now(),
    });
  return await executeStages({
    manifest,
    evidencePath: manifest.evidencePath,
    stages,
    startIndex: 0,
    previous: undefined,
    save,
  });
}

/**
 * Continue a frozen chain: accepted stages are kept, the first non-accepted
 * stage is resumed from its own evidence, and later stages follow on success.
 */
export async function resumeManifest(evidencePath: string): Promise<ChainState> {
  await validateFrozenChain(evidencePath);
  const frozen = frozenChain(
    JSON.parse(
      await readFile(join(evidencePath, "chain", "chain.json"), "utf8"),
    ),
  );
  const manifest = await manifestFromFrozen(frozen);
  const state = await readChainState(evidencePath);
  const stages = state.stages.map((stage) => ({ ...stage }));
  const first = stages.findIndex((stage) => stage.status !== "accepted");
  const save = (
    next: ReadonlyArray<ChainStageState>,
    outcome: ChainOutcome,
  ): Promise<ChainState> =>
    writeChainState(evidencePath, {
      ...state,
      stages: [...next],
      outcome,
      updatedAt: now(),
    });
  if (first === -1) {
    if (state.outcome === "accepted") return state;
    return await save(stages, "accepted");
  }
  const previous =
    first === 0 ? undefined : await loadAcceptedStage(evidencePath, stages[first - 1]!);
  return await executeStages({
    manifest,
    evidencePath,
    stages,
    startIndex: first,
    previous,
    save,
  });
}
