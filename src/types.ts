export interface SupervisorConfig {
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly stage: string;
  readonly verifierPath: string;
  /** Legacy verifier defaults to self-contained. Declare closure for helpers/oracles. */
  readonly verifierSelfContained?: boolean;
  readonly verifierDependencies?: ReadonlyArray<string>;
  readonly verifierSnapshotRoot?: string;
  readonly workerRecipePath?: string;
  readonly evidencePath: string;
  readonly gooseBin: string;
  readonly workerKind?: "goose" | "acp";
  readonly acpCommand?: ReadonlyArray<string>;
  /** Runtime settings selected at run creation; supplied by the supervisor only. */
  readonly workerEnvironment?: NodeJS.ProcessEnv;
  readonly maxAttempts: number;
  readonly workerTimeoutMs: number;
  readonly noToolTimeoutMs: number;
  readonly noToolOutputBytes: number;
  readonly runId: string;
}

export type TerminationReason =
  | "timeout"
  | "no-tool-progress"
  | "spawn-error"
  | "protocol-error"
  | "permission-denied"
  | "output-limit"
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

export interface AttemptRecord {
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
  };
  readonly verification?: VerificationResult;
  readonly failureReportPath?: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly stage: string;
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "accepted" | "failed";
  readonly acceptedHead?: string;
  readonly attempts: ReadonlyArray<AttemptRecord>;
}
