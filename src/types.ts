import type { RetryPolicy } from "./retry.js";

export interface SupervisorConfig {
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly stage: string;
  readonly verifierPath: string;
  /** Legacy verifier defaults to self-contained. Declare closure for helpers/oracles. */
  readonly verifierSelfContained?: boolean;
  readonly verifierDependencies?: ReadonlyArray<string>;
  readonly verifierSnapshotRoot?: string;
  readonly promptPath: string;
  /** Require a structured worker outcome report before a candidate can be accepted. */
  readonly workerReportRequired?: boolean;
  readonly evidencePath: string;
  readonly acpCommand?: ReadonlyArray<string>;
  /** Runtime settings selected at run creation; supplied by the supervisor only. */
  readonly workerEnvironment?: NodeJS.ProcessEnv;
  /** Fresh model assessment after failed attempt cleanup; never runs alongside the worker. */
  readonly progressEvaluator?: {
    readonly command: ReadonlyArray<string>;
    readonly timeoutMs: number;
  };
  readonly maxAttempts: number;
  readonly workerTimeoutMs: number;
  readonly noToolTimeoutMs: number;
  readonly noToolOutputBytes: number;
  readonly maxToolCalls: number;
  /** One-time finalize-turn tool-call grace after the main budget; 0 disables. */
  readonly toolCallCushion: number;
  readonly maxToolRepetitions: number;
  /** Hard/soft retry policy; absent means a single attempt (legacy behavior). */
  readonly retryPolicy?: RetryPolicy;
  /** Chain handoff: accepted commit of the predecessor stage; empty when absent. */
  readonly previousStageCommit?: string;
  /** Chain handoff: worker report path of the predecessor stage; empty when absent. */
  readonly previousStageReportPath?: string;
  readonly runId: string;
}

/** Budget fields a manifest may set in `defaults` or per stage. */
export interface ManifestBudgets {
  readonly maxAttempts?: number;
  readonly workerTimeoutSeconds?: number;
  readonly maxToolCalls?: number;
  readonly toolCallCushion?: number;
  readonly maxToolRepetitions?: number;
  readonly noToolTimeoutSeconds?: number;
  readonly noToolOutputBytes?: number;
}

export interface ManifestStage {
  readonly id: string;
  /** Absolute path, resolved against the manifest directory. */
  readonly planPath: string;
  /** Absolute path, resolved against the manifest directory. */
  readonly verifierPath: string;
  /** Absolute path, resolved against the manifest directory. */
  readonly verifierManifestPath?: string;
  /** Predecessor stage id; absent on the first stage. */
  readonly after?: string;
  /** Per-stage budget overrides. */
  readonly budgets?: ManifestBudgets;
}

/**
 * A complete run specification parsed from one version-2 JSON document. The
 * same shape describes a single bounded stage and a multi-stage chain; a
 * one-stage manifest is the trivial case.
 */
export interface RunManifest {
  readonly version: 2;
  /** Absolute path of the JSON document; relative paths resolve against it. */
  readonly manifestPath: string;
  readonly chainId: string;
  /** Absolute path of the implementation worktree. */
  readonly repositoryPath: string;
  /** Absolute path of this run's fresh evidence directory. */
  readonly evidencePath: string;
  readonly promptPath: string;
  readonly workerCommand: ReadonlyArray<string>;
  readonly workerReportRequired: boolean;
  readonly progressEvaluator?: SupervisorConfig["progressEvaluator"];
  /** Resolved global budget defaults; stages may override per field. */
  readonly budgets: Required<ManifestBudgets>;
  /** Resolved hard/soft retry policy applied to every stage. */
  readonly retries: RetryPolicy;
  readonly stages: ReadonlyArray<ManifestStage>;
}

export type ChainStageStatus =
  | "pending"
  | "running"
  | "accepted"
  | "failed"
  | "task-blocked";

export interface ChainStageState {
  readonly id: string;
  readonly status: ChainStageStatus;
  readonly commit?: string;
  readonly runEvidence?: string;
}

export type ChainOutcome = "running" | "accepted" | "failed" | "task-blocked";

export interface ChainState {
  readonly version: 1;
  readonly chainId: string;
  readonly manifestSha256: string;
  readonly stages: ReadonlyArray<ChainStageState>;
  readonly outcome: ChainOutcome;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export type TerminationReason =
  | "timeout"
  | "no-tool-progress"
  | "spawn-error"
  | "protocol-error"
  | "generation-limit"
  | "permission-denied"
  | "output-limit"
  | "tool-call-limit"
  | "missing-child-result";

export interface Usage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  /** Recovery evidence can say that no worker result was durably recorded. */
  readonly resultUnavailable?: boolean;
  /** Exit status of the wrapper when the guarded target result was unavailable. */
  readonly wrapperExitCode?: number;
  readonly terminationReason?: TerminationReason;
  readonly usage?: Usage;
}

export interface VerificationResult {
  readonly exitCode: number;
  readonly output: string;
  readonly timedOut: boolean;
  readonly outputLimited?: boolean;
  readonly actualExitCode?: number | null;
  readonly resultUnavailable?: boolean;
  readonly wrapperExitCode?: number;
}

export interface ProgressEvaluationRecord {
  readonly status: "progress" | "extend" | "stuck" | "escalate-infrastructure" | "error";
  readonly reason?: string;
  readonly nextHypothesis?: string;
  readonly evidencePath: string;
  readonly evaluatedAt: string;
  readonly retryAllowed: boolean;
}

export interface AttemptRecord {
  readonly progressEvaluation?: ProgressEvaluationRecord;
  /** Which retry tier admitted this attempt, and the budget it ran with. */
  readonly retry?: {
    readonly tier: "hard" | "soft";
    readonly extension: boolean;
    readonly toolCalls: number;
    readonly workerTimeoutMs: number;
  };
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly preHead: string;
  readonly postHead: string;
  readonly postStatus: string;
  readonly worker: ProcessResult;
  readonly protocol?: {
    readonly protocolVersion?: number;
    readonly sessionId?: string;
    readonly stopReason?: string;
    readonly capabilities?: unknown;
    readonly error?: string;
    /** Target exit code; unavailable when cleanup reaped its wrapper first. */
    readonly processExitCode: number | null;
    readonly processExitUnavailable?: boolean;
    /** Wrapper exit when processExitCode is unavailable. */
    readonly wrapperExitCode?: number;
    readonly cleanupComplete: boolean;
    /** ACP tool-call session updates observed before the attempt ended. */
    readonly toolCalls?: number;
    /** Present when the tool-call cushion granted one finalize turn. */
    readonly cushionUsed?: true;
    /** Tool calls observed after the main tool-call budget was exhausted. */
    readonly finalizeToolCalls?: number;
    /** Present only when ACP ended for excessive tool-free generated text. */
    readonly watchdog?: {
      readonly toolProgressAgeMs: number;
      readonly meaningfulActivityAgeMs: number;
      readonly toolFreeTextBytes: number;
      readonly toolFreeWireBytes: number;
    };
  };
  readonly verification?: VerificationResult;
  readonly failureReportPath?: string;
  readonly workerReport?: import("./worker-report.js").WorkerReport;
}

export interface RunRecord {
  readonly runId: string;
  readonly stage: string;
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "accepted" | "failed" | "task-blocked";
  readonly acceptedHead?: string;
  /** Present when the worker explicitly stopped for a decision or known gap. */
  readonly blockageReason?: string;
  readonly attempts: ReadonlyArray<AttemptRecord>;
}
