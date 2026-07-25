export interface SupervisorConfig {
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly stage: string;
  readonly verifierPath: string;
  readonly workerRecipePath: string;
  readonly evidencePath: string;
  readonly gooseBin: string;
  readonly maxAttempts: number;
  readonly workerTimeoutMs: number;
  readonly noToolTimeoutMs: number;
  readonly noToolOutputBytes: number;
  readonly runId: string;
}

export type TerminationReason =
  | "timeout"
  | "no-tool-progress"
  | "spawn-error";

export interface Usage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly terminationReason?: TerminationReason;
  readonly usage?: Usage;
}

export interface VerificationResult {
  readonly exitCode: number;
  readonly output: string;
  readonly timedOut: boolean;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly preHead: string;
  readonly postHead: string;
  readonly postStatus: string;
  readonly worker: ProcessResult;
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

