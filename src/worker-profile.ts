import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { resolveExecutable } from "./state.js";
import type { SupervisorConfig } from "./types.js";

interface FileIdentity {
  readonly path: string;
  readonly exists: boolean;
  readonly sha256?: string;
  readonly bytes?: number;
}
export interface WorkerProfile {
  readonly version: 2;
  readonly kind: "acp";
  readonly argv: readonly string[];
  readonly executable: FileIdentity & {
    readonly exists: true;
    readonly sha256: string;
    readonly bytes: number;
  };
  /** Deliberately small, non-secret model/runtime settings. */
  readonly environment: Readonly<Record<string, string>>;
  /** Route controls are recorded including absence, so resume cannot inherit a different endpoint. */
  readonly openaiRoute: Readonly<Record<OpenAiRouteKey, string | null>>;
  /** Explicit and default-discovered configuration paths, including absent files. */
  readonly configFiles: readonly FileIdentity[];
  /** ACP argv entries that name files, so changing an adapter script cannot switch harnesses. */
  readonly argvFiles: readonly FileIdentity[];
}

const ENVIRONMENT_KEYS = [
  "GOOSE_MODEL",
  "GOOSE_PROVIDER",
  "GOOSE_MODE",
  "GOOSE_CONTEXT_LIMIT",
  "GOOSE_CONFIG_DIR",
  "OMP_MODEL",
  "OMP_PROVIDER",
  "OMP_HOST",
  "OMP_MODE",
  "OMP_CONTEXT_LIMIT",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "HOME",
  "XDG_CONFIG_HOME",
] as const;
const OPENAI_ROUTE_KEYS = [
  "OPENAI_HOST",
  "OPENAI_BASE_PATH",
  "OPENAI_BASE_URL",
  "API_VERSION",
  "OPENAI_API_VERSION",
] as const;
type OpenAiRouteKey = (typeof OPENAI_ROUTE_KEYS)[number];
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function commandFor(config: SupervisorConfig): readonly string[] {
  return config.acpCommand ?? [];
}
async function fileIdentity(path: string): Promise<FileIdentity> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return { path: resolve(path), exists: false };
    const bytes = await readFile(path);
    return {
      path: await realpath(path),
      exists: true,
      sha256: hash(bytes),
      bytes: bytes.byteLength,
    };
  } catch {
    return { path: resolve(path), exists: false };
  }
}
function selectedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}
function openaiRoute(
  env: NodeJS.ProcessEnv,
): Record<OpenAiRouteKey, string | null> {
  return Object.fromEntries(
    OPENAI_ROUTE_KEYS.map((key) => [key, env[key] ?? null]),
  ) as Record<OpenAiRouteKey, string | null>;
}
function defaultGooseConfig(
  env: Readonly<Record<string, string>>,
): string | undefined {
  if (env.GOOSE_CONFIG_DIR) return join(env.GOOSE_CONFIG_DIR, "config.yaml");
  const base =
    env.XDG_CONFIG_HOME ?? (env.HOME ? join(env.HOME, ".config") : undefined);
  return base ? join(base, "goose", "config.yaml") : undefined;
}
function ompAgentDirectory(
  env: Readonly<Record<string, string>>,
): string | undefined {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  if (!env.HOME) return undefined;
  const root = join(env.HOME, env.PI_CONFIG_DIR ?? ".omp");
  const profile = env.OMP_PROFILE ?? env.PI_PROFILE;
  return profile
    ? join(root, "profiles", profile, "agent")
    : join(root, "agent");
}
async function configurationFiles(
  environment: Readonly<Record<string, string>>,
) {
  const candidates = [defaultGooseConfig(environment)];
  const agent = ompAgentDirectory(environment);
  if (agent)
    candidates.push(
      join(agent, "config.yml"),
      join(agent, "models.yml"),
      join(agent, "models.json"),
      join(agent, "settings.json"),
    );
  return (
    await Promise.all(
      candidates.filter((x): x is string => x !== undefined).map(fileIdentity),
    )
  ).sort((a, b) => a.path.localeCompare(b.path));
}
async function argvFiles(argv: readonly string[], base: string) {
  const candidates = argv
    .slice(1)
    .map((arg) => (isAbsolute(arg) ? arg : resolve(base, arg)));
  return (await Promise.all(candidates.map(fileIdentity)))
    .filter((file) => file.exists)
    .sort((a, b) => a.path.localeCompare(b.path));
}
export async function captureWorkerProfile(
  config: SupervisorConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerProfile> {
  const argv = commandFor(config);
  if (argv.length === 0 || argv[0] === undefined)
    throw new Error("ACP worker requires --acp-command");
  const executablePath = await resolveExecutable(
    argv[0],
    env.PATH,
    config.repositoryPath,
  );
  const executable = await fileIdentity(executablePath);
  if (
    !executable.exists ||
    executable.sha256 === undefined ||
    executable.bytes === undefined
  )
    throw new Error("worker executable disappeared during profiling");
  const environment = selectedEnvironment(env);
  return {
    version: 2,
    kind: "acp",
    argv: [...argv],
    executable: executable as WorkerProfile["executable"],
    environment,
    openaiRoute: openaiRoute(env),
    configFiles: await configurationFiles(environment),
    argvFiles: await argvFiles(argv, config.repositoryPath),
  };
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function supportsFreshWorker(
  profile: unknown,
): profile is WorkerProfile {
  if (
    typeof profile !== "object" ||
    profile === null ||
    (profile as { version?: unknown }).version !== 2
  )
    return false;
  const route = (profile as { openaiRoute?: unknown }).openaiRoute;
  return (
    typeof route === "object" &&
    route !== null &&
    OPENAI_ROUTE_KEYS.every(
      (key) =>
        Object.hasOwn(route, key) &&
        (typeof (route as Record<string, unknown>)[key] === "string" ||
          (route as Record<string, unknown>)[key] === null),
    )
  );
}
export async function validateWorkerProfile(
  profile: WorkerProfile,
  config: SupervisorConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!supportsFreshWorker(profile))
    throw new Error(
      "worker runtime profile version does not support fresh workers",
    );
  const current = await captureWorkerProfile(config, env);
  if (!same(current, profile))
    throw new Error(
      "worker runtime profile drift: executable, argv script, model settings, or config changed",
    );
}
/** Preserve ordinary inherited process settings while pinning the captured model settings. */
export function frozenWorkerEnvironment(
  profile: WorkerProfile,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (supportsFreshWorker(profile)) {
    for (const key of OPENAI_ROUTE_KEYS) delete environment[key];
  }
  const route = supportsFreshWorker(profile)
    ? Object.fromEntries(
        OPENAI_ROUTE_KEYS.flatMap((key) =>
          profile.openaiRoute[key] === null
            ? []
            : [[key, profile.openaiRoute[key]]],
        ),
      )
    : {};
  return { ...environment, ...profile.environment, ...route };
}
