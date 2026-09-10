import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { readonly [k: string]: Json };
export type Phase =
  | "prepared"
  | "worker_starting"
  | "worker_running"
  | "worker_finished"
  | "verifying"
  | "verified"
  | "accepted"
  | "task_blocked"
  | "failed";
const phases: Phase[] = [
  "prepared",
  "worker_starting",
  "worker_running",
  "worker_finished",
  "verifying",
  "verified",
  "accepted",
  "task_blocked",
  "failed",
];
export interface Fingerprint {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly sourceSha256?: string;
}
export interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface CompletedAttempt {
  readonly attempt: number;
  readonly artifacts: readonly ArtifactRef[];
  readonly result?: Readonly<Record<string, Json>>;
}
export interface VerifierManifest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly entry: Fingerprint;
  readonly dependencies: readonly Fingerprint[];
  readonly selfContained: boolean;
}
export interface State {
  readonly version: 1;
  readonly runId: string;
  readonly phase: Phase;
  readonly initial: {
    readonly head: string;
    readonly ref: string;
    readonly worktree: string;
  };
  readonly inputs: {
    readonly fingerprint: string;
    readonly config: Fingerprint;
    readonly plan: Fingerprint;
    readonly recipe?: Fingerprint;
    readonly profile?: Fingerprint;
    readonly verifier: VerifierManifest;
    readonly executable?: string;
  };
  readonly reservedAttempts: number;
  readonly candidateHead?: string;
  readonly attempt?: Readonly<Record<string, Json>>;
  readonly protocol?: Readonly<Record<string, Json>>;
  readonly verification?: Readonly<Record<string, Json>>;
  readonly completedAttempts?: readonly CompletedAttempt[];
  readonly summaryArtifact?: ArtifactRef;
  readonly startedAt: string;
  readonly updatedAt: string;
}
export class StateError extends Error {}
const hash = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");
const rec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const json = (v: unknown): v is Json =>
  v === null ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every(json)) ||
  (rec(v) && Object.values(v).every(json));
const canon = (v: Json): string =>
  Array.isArray(v)
    ? `[${v.map(canon)}]`
    : rec(v)
      ? `{${Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canon(v[k] as Json))
          .join(",")}}`
      : JSON.stringify(v);
async function present(p: string) {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function atomic(p: string, s: string | Uint8Array) {
  const t = join(dirname(p), `.${crypto.randomUUID()}.tmp`);
  const f = await open(t, "wx", 0o600);
  try {
    await f.writeFile(s);
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(t, p);
  const d = await open(dirname(p), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
async function snap(
  root: string,
  src: string,
  name: string,
): Promise<Fingerprint> {
  const b = await readFile(src),
    dest = join(root, "inputs", name);
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await atomic(dest, b);
  const source = await stat(src);
  await chmod(dest, source.mode & 0o777);
  return {
    path: `inputs/${name}`,
    sha256: hash(b),
    sourceSha256: hash(b),
    bytes: b.byteLength,
  };
}
async function exclusiveBytes(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function safeRelativePath(path: string): boolean {
  return (
    !isAbsolute(path) && path.length > 0 && !path.split(/[\\/]/).includes("..")
  );
}
function fp(v: unknown): v is Fingerprint {
  return (
    rec(v) &&
    typeof v.path === "string" &&
    safeRelativePath(v.path) &&
    typeof v.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    typeof v.bytes === "number" &&
    Number.isInteger(v.bytes) &&
    v.bytes >= 0 &&
    (v.sourceSha256 === undefined ||
      (typeof v.sourceSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(v.sourceSha256)))
  );
}
function artifact(v: unknown): v is ArtifactRef {
  return (
    rec(v) &&
    typeof v.path === "string" &&
    safeRelativePath(v.path) &&
    v.path.startsWith("attempts/") &&
    typeof v.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    typeof v.bytes === "number" &&
    Number.isInteger(v.bytes) &&
    v.bytes >= 0
  );
}
function jsonRecord(v: unknown): v is Readonly<Record<string, Json>> {
  return rec(v) && json(v);
}
function assertState(v: unknown): asserts v is State {
  if (
    !rec(v) ||
    v.version !== 1 ||
    typeof v.runId !== "string" ||
    !phases.includes(v.phase as Phase) ||
    !rec(v.initial) ||
    typeof v.initial.head !== "string" ||
    typeof v.initial.ref !== "string" ||
    typeof v.initial.worktree !== "string" ||
    !rec(v.inputs) ||
    typeof v.inputs.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.inputs.fingerprint) ||
    !fp(v.inputs.config) ||
    !fp(v.inputs.plan) ||
    (v.inputs.recipe !== undefined && !fp(v.inputs.recipe)) ||
    (v.inputs.profile !== undefined && !fp(v.inputs.profile)) ||
    !rec(v.inputs.verifier) ||
    !fp(v.inputs.verifier.entry) ||
    !Array.isArray(v.inputs.verifier.dependencies) ||
    !v.inputs.verifier.dependencies.every(fp) ||
    typeof v.inputs.verifier.selfContained !== "boolean" ||
    typeof v.inputs.verifier.cwd !== "string" ||
    !Array.isArray(v.inputs.verifier.argv) ||
    v.inputs.verifier.argv.length === 0 ||
    !v.inputs.verifier.argv.every(
      (x) => typeof x === "string" && x.length > 0,
    ) ||
    typeof v.reservedAttempts !== "number" ||
    !Number.isInteger(v.reservedAttempts) ||
    v.reservedAttempts < 0 ||
    typeof v.startedAt !== "string" ||
    Number.isNaN(Date.parse(v.startedAt)) ||
    typeof v.updatedAt !== "string" ||
    Number.isNaN(Date.parse(v.updatedAt)) ||
    (v.candidateHead !== undefined && typeof v.candidateHead !== "string") ||
    (v.attempt !== undefined && !jsonRecord(v.attempt)) ||
    (v.protocol !== undefined && !jsonRecord(v.protocol)) ||
    (v.verification !== undefined && !jsonRecord(v.verification)) ||
    (v.summaryArtifact !== undefined && !artifact(v.summaryArtifact)) ||
    (v.completedAttempts !== undefined &&
      (!Array.isArray(v.completedAttempts) ||
        !v.completedAttempts.every(
          (item) =>
            rec(item) &&
            typeof item.attempt === "number" &&
            Number.isInteger(item.attempt) &&
            item.attempt > 0 &&
            Array.isArray(item.artifacts) &&
            item.artifacts.every(artifact) &&
            (item.result === undefined || jsonRecord(item.result)),
        )))
  )
    throw new StateError("invalid durable state schema");
}
export async function resolveExecutable(
  command: string,
  pathValue = process.env.PATH ?? "",
  base = process.cwd(),
) {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes("/")
      ? [join(base, command)]
      : pathValue
          .split(delimiter)
          .filter(Boolean)
          .map((x) => join(x, command));
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (!details.isFile() || (details.mode & 0o111) === 0) continue;
      return await realpath(candidate);
    } catch {}
  }
  throw new StateError(`executable not found or not executable: ${command}`);
}
function verifierSnapshotName(
  root: string | undefined,
  source: string,
  fallback: string,
): string {
  if (!root) return fallback;
  const name = relative(root, source);
  if (!name || name.startsWith("..") || isAbsolute(name))
    throw new StateError("verifier dependency is outside snapshot root");
  return join("verifier", name);
}
export interface CreateOptions {
  evidencePath: string;
  runId: string;
  resolvedConfig: Json;
  initial: State["initial"];
  planPath: string;
  verifier: {
    argv: readonly string[];
    cwd: string;
    entryPath: string;
    dependencies?: readonly string[];
    selfContained?: boolean;
    snapshotRoot?: string;
  };
  recipePath?: string;
  profilePath?: string;
  profile?: Json;
  executable?: string;
}
export async function createFrozenRun(o: CreateOptions): Promise<State> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.runId))
    throw new StateError("invalid run id");
  if (!json(o.resolvedConfig))
    throw new StateError("resolved config must be JSON-safe");
  await mkdir(dirname(o.evidencePath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(o.evidencePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new StateError("evidence directory already exists");
    throw error;
  }
  if (o.verifier.selfContained === undefined)
    throw new StateError("verifier selfContained declaration is required");
  if (!o.verifier.selfContained && o.verifier.dependencies === undefined)
    throw new StateError("external verifier requires explicit dependency list");
  await mkdir(join(o.evidencePath, "inputs"), { mode: 0o700 });
  const configPath = join(o.evidencePath, "inputs", "config.json");
  await atomic(configPath, JSON.stringify(o.resolvedConfig, null, 2) + "\n");
  const config = await snap(o.evidencePath, configPath, "config.frozen.json"),
    plan = await snap(o.evidencePath, o.planPath, "plan.md"),
    recipe = o.recipePath
      ? await snap(o.evidencePath, o.recipePath, "worker.yaml")
      : undefined,
    profile = o.profilePath
      ? await snap(o.evidencePath, o.profilePath, "worker-profile.json")
      : o.profile === undefined
        ? undefined
        : await (async () => {
            if (!json(o.profile))
              throw new StateError("worker profile must be JSON-safe");
            const bytes = new TextEncoder().encode(
              JSON.stringify(o.profile, null, 2) + "\n",
            );
            const path = join(o.evidencePath, "inputs", "worker-profile.json");
            await atomic(path, bytes);
            return {
              path: "inputs/worker-profile.json",
              sha256: hash(bytes),
              sourceSha256: hash(bytes),
              bytes: bytes.byteLength,
            };
          })(),
    entry = await snap(
      o.evidencePath,
      o.verifier.entryPath,
      verifierSnapshotName(
        o.verifier.snapshotRoot,
        o.verifier.entryPath,
        "verifier-entry",
      ),
    ),
    dependencies = await Promise.all(
      (o.verifier.dependencies ?? []).map((x, i) =>
        snap(
          o.evidencePath,
          x,
          verifierSnapshotName(
            o.verifier.snapshotRoot,
            x,
            `verifier-dependency-${i}`,
          ),
        ),
      ),
    );
  const verifier = {
      argv: o.verifier.argv.map((arg) =>
        arg === o.verifier.entryPath ||
        (o.verifier.snapshotRoot !== undefined &&
          arg === relative(o.verifier.snapshotRoot, o.verifier.entryPath))
          ? join(o.evidencePath, entry.path)
          : arg,
      ),
      cwd: o.verifier.cwd,
      entry,
      dependencies,
      selfContained: o.verifier.selfContained,
    },
    bare = {
      config,
      plan,
      ...(recipe ? { recipe } : {}),
      ...(profile ? { profile } : {}),
      verifier,
      ...(o.executable
        ? { executable: await resolveExecutable(o.executable) }
        : {}),
    },
    inputs = { ...bare, fingerprint: hash(canon(bare as unknown as Json)) };
  await atomic(
    join(o.evidencePath, "inputs", "verification-manifest.json"),
    JSON.stringify(verifier, null, 2) + "\n",
  );
  const s: State = {
    version: 1,
    runId: o.runId,
    phase: "prepared",
    initial: o.initial,
    inputs,
    reservedAttempts: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await atomic(
    join(o.evidencePath, "state.json"),
    JSON.stringify(s, null, 2) + "\n",
  );
  return s;
}
export async function readState(root: string): Promise<State> {
  try {
    const s: unknown = JSON.parse(
      await readFile(join(root, "state.json"), "utf8"),
    );
    assertState(s);
    return s;
  } catch (e) {
    if (e instanceof StateError) throw e;
    throw new StateError(`cannot read durable state: ${(e as Error).message}`);
  }
}
export async function validateFrozenInputs(
  root: string,
  expected?: Pick<State, "runId" | "initial">,
): Promise<State> {
  const s = await readState(root);
  if (
    expected &&
    (expected.runId !== s.runId ||
      canon(expected.initial as unknown as Json) !==
        canon(s.initial as unknown as Json))
  )
    throw new StateError("frozen identity drift");
  const files = [
    s.inputs.config,
    s.inputs.plan,
    ...(s.inputs.recipe ? [s.inputs.recipe] : []),
    ...(s.inputs.profile ? [s.inputs.profile] : []),
    s.inputs.verifier.entry,
    ...s.inputs.verifier.dependencies,
  ];
  for (const f of files) {
    const b = await readFile(join(root, f.path));
    if (hash(b) !== f.sha256 || b.byteLength !== f.bytes)
      throw new StateError(`frozen input drift: ${f.path}`);
  }
  const { fingerprint, ...bare } = s.inputs;
  if (hash(canon(bare as unknown as Json)) !== fingerprint)
    throw new StateError("frozen manifest drift");
  for (const completed of s.completedAttempts ?? [])
    for (const reference of completed.artifacts) {
      const bytes = await readFile(join(root, reference.path));
      if (
        bytes.byteLength !== reference.bytes ||
        hash(bytes) !== reference.sha256
      )
        throw new StateError(`attempt artifact drift: ${reference.path}`);
    }
  if (s.summaryArtifact !== undefined) {
    const bytes = await readFile(join(root, s.summaryArtifact.path));
    if (
      bytes.byteLength !== s.summaryArtifact.bytes ||
      hash(bytes) !== s.summaryArtifact.sha256
    )
      throw new StateError("summary artifact drift");
  }
  return s;
}
const allowed: Record<Phase, readonly Phase[]> = {
  prepared: ["worker_starting", "failed"],
  worker_starting: ["worker_running", "failed"],
  worker_running: ["worker_finished", "failed"],
  worker_finished: ["verifying", "worker_starting", "task_blocked", "failed"],
  verifying: ["verified", "worker_starting", "task_blocked", "failed"],
  verified: ["accepted", "worker_starting", "task_blocked", "failed"],
  accepted: [],
  task_blocked: [],
  failed: [],
};
export async function checkpoint(
  root: string,
  u: Omit<
    Partial<State>,
    | "version"
    | "runId"
    | "initial"
    | "inputs"
    | "reservedAttempts"
    | "startedAt"
    | "updatedAt"
  >,
): Promise<State> {
  const s = await readState(root),
    phase = u.phase ?? s.phase;
  if (phase !== s.phase && !allowed[s.phase].includes(phase))
    throw new StateError(`invalid phase transition: ${s.phase} -> ${phase}`);
  const n = { ...s, ...u, phase, updatedAt: new Date().toISOString() } as State;
  assertState(n);
  await atomic(join(root, "state.json"), JSON.stringify(n, null, 2) + "\n");
  return n;
}
export async function reserveAttempt(
  root: string,
  record: Readonly<Record<string, Json>> = {},
): Promise<State> {
  const s = await readState(root);
  if (s.phase === "accepted" || s.phase === "task_blocked" || s.phase === "failed")
    throw new StateError("cannot reserve attempt from terminal state");
  if (
    !["prepared", "worker_finished", "verifying", "verified"].includes(s.phase)
  )
    throw new StateError(`cannot reserve attempt from ${s.phase}`);
  const attempt = s.reservedAttempts + 1,
    n = {
      ...s,
      phase: "worker_starting" as const,
      reservedAttempts: attempt,
      attempt: { ...record, attempt },
      updatedAt: new Date().toISOString(),
    };
  assertState(n);
  await atomic(join(root, "state.json"), JSON.stringify(n, null, 2) + "\n");
  return n;
}
export async function writeAttemptArtifact(
  root: string,
  attemptNumber: number,
  safeName: string,
  value: Json | Uint8Array,
): Promise<ArtifactRef> {
  if (
    !Number.isInteger(attemptNumber) ||
    attemptNumber < 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safeName)
  )
    throw new StateError("invalid attempt artifact path");
  if (!(value instanceof Uint8Array) && !json(value))
    throw new StateError("artifact must be JSON-safe or bytes");
  const bytes =
    value instanceof Uint8Array
      ? value
      : new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  const path = join(
    root,
    "attempts",
    String(attemptNumber).padStart(3, "0"),
    safeName,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await exclusiveBytes(path, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (
      hash(existing) !== hash(bytes) ||
      existing.byteLength !== bytes.byteLength
    )
      throw new StateError(`attempt artifact already differs: ${safeName}`);
  }
  return {
    path: `attempts/${String(attemptNumber).padStart(3, "0")}/${safeName}`,
    sha256: hash(bytes),
    bytes: bytes.byteLength,
  };
}
export async function checkpointCompletedAttempt(
  root: string,
  completed: CompletedAttempt,
): Promise<State> {
  const state = await readState(root);
  for (const reference of completed.artifacts) {
    const bytes = await readFile(join(root, reference.path));
    if (
      hash(bytes) !== reference.sha256 ||
      bytes.byteLength !== reference.bytes
    )
      throw new StateError(`attempt artifact drift: ${reference.path}`);
  }
  const previous = state.completedAttempts ?? [];
  if (previous.some((item) => item.attempt === completed.attempt))
    throw new StateError("completed attempt already checkpointed");
  return checkpoint(root, {
    completedAttempts: [...previous, completed],
  } as never);
}
export async function writeRunSummary(root: string, summary: Json) {
  if (!json(summary)) throw new StateError("summary must be JSON-safe");
  await atomic(join(root, "run.json"), JSON.stringify(summary, null, 2) + "\n");
}
