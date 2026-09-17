/**
 * Retry policy: hard retries (unconditional) and soft retries (evaluator-gated).
 *
 * This module is pure. It answers two questions and nothing else:
 *
 *   1. Given a failed attempt, may another be started, and under which tier?
 *   2. What budget does the next attempt get?
 *
 * It deliberately knows nothing about git, ACP, evidence, or the evaluator
 * transport. The caller supplies a classified failure, the retry state so far,
 * the budget the attempt ran with, and — when a soft retry is in play — the
 * evaluator's verdict. Everything here is deterministic and unit-testable.
 */

export interface ExtendPolicy {
  /** Fraction of the stage base added to the tool-call budget per extension. */
  readonly toolCalls: number;
  /** Fraction of the stage base added to the wall-clock budget per extension. */
  readonly timeout: number;
  /** Hard cap on the total budget, as a multiple of the stage base. */
  readonly ceiling: number;
}

export interface RetryPolicy {
  /** Unconditional retries. No evaluator call, no budget change. */
  readonly hard: number;
  /** Evaluator-gated retries. `extend` grants budget; `new-approach` does not. */
  readonly soft: number;
  readonly extend: ExtendPolicy;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  // One unconditional retry preserves the historical `maxAttempts: 2` default.
  hard: 1,
  soft: 0,
  extend: { toolCalls: 0.5, timeout: 0.5, ceiling: 3 },
};

export interface AttemptBudget {
  readonly toolCalls: number;
  readonly workerTimeoutMs: number;
}

export interface RetryState {
  readonly hardUsed: number;
  readonly softUsed: number;
  /** Granted `extend` retries; drives the budget multiplier. */
  readonly extensions: number;
}

export const INITIAL_RETRY_STATE: RetryState = {
  hardUsed: 0,
  softUsed: 0,
  extensions: 0,
};

/**
 * A failure is retryable only if another attempt could plausibly change the
 * outcome. History rewrites and frozen-input drift are never retried; an explicit
 * worker `blocked` report needs a caller decision.
 */
export type FailureClass =
  | "budget-exhaustion"
  | "recoverable"
  | "blocked"
  | "unsafe";

/** Evaluator verdict reduced to the fields the policy needs. */
export type SoftVerdict =
  | { readonly status: "extend"; readonly reason?: string }
  | {
      readonly status: "new-approach";
      readonly reason?: string;
      /** The hypothesis differs from every previous one (normalized). */
      readonly distinct: boolean;
    }
  | { readonly status: "stuck"; readonly reason?: string }
  | { readonly status: "escalate-infrastructure"; readonly reason?: string };

export interface RetryInput {
  readonly policy: RetryPolicy;
  readonly state: RetryState;
  readonly failure: FailureClass;
  /** Budget the failed attempt ran with; extensions are measured from the base. */
  readonly base: AttemptBudget;
  readonly evaluatorConfigured: boolean;
  readonly evaluatorVerdict?: SoftVerdict;
  /**
   * Whether this attempt added commits, diffstat, or satisfied DoD items versus
   * its predecessor. Computed by the caller from retained evidence, never asked
   * of the model. Required for `extend`.
   */
  readonly madeProgress: boolean;
}

export type RetryDecision =
  | { readonly action: "stop"; readonly reason: string; readonly blocked: boolean }
  | {
      readonly action: "retry";
      readonly tier: "hard" | "soft";
      readonly extension: boolean;
      readonly nextState: RetryState;
      readonly nextBudget: AttemptBudget;
      readonly reason: string;
    };

/** Apply `extensions` granted extensions to a stage base budget. */
export function attemptBudget(
  base: AttemptBudget,
  extensions: number,
  policy: RetryPolicy,
): AttemptBudget {
  const factor = Math.min(
    1 + Math.max(0, extensions) * policy.extend.toolCalls,
    policy.extend.ceiling,
  );
  const timeFactor = Math.min(
    1 + Math.max(0, extensions) * policy.extend.timeout,
    policy.extend.ceiling,
  );
  return {
    toolCalls: Math.ceil(base.toolCalls * factor),
    workerTimeoutMs: Math.ceil(base.workerTimeoutMs * timeFactor),
  };
}

function budgetGrows(
  base: AttemptBudget,
  extensions: number,
  policy: RetryPolicy,
): boolean {
  const current = attemptBudget(base, extensions, policy);
  const next = attemptBudget(base, extensions + 1, policy);
  return (
    next.toolCalls > current.toolCalls ||
    next.workerTimeoutMs > current.workerTimeoutMs
  );
}

const retryable = (failure: FailureClass): boolean =>
  failure === "budget-exhaustion" || failure === "recoverable";

/**
 * Decide whether to start another attempt.
 *
 * Routing: a budget-exhaustion failure is not helped by an unconditional retry
 * at the same budget, so when an evaluator is configured it goes straight to the
 * soft tier. Every other retryable failure takes an unconditional hard retry
 * first. With no evaluator configured, hard retries cover everything retryable.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  const { policy, state, failure, base } = input;
  const stop = (reason: string, blocked = false): RetryDecision => ({
    action: "stop",
    reason,
    blocked,
  });

  if (!retryable(failure))
    return stop(
      failure === "blocked"
        ? "worker stopped for a caller decision"
        : "attempt is not safely retryable",
      failure === "blocked",
    );

  const total = policy.hard + policy.soft;
  if (state.hardUsed + state.softUsed >= total)
    return stop("retry budget exhausted");

  const hardRemaining = policy.hard - state.hardUsed;
  const softRemaining = policy.soft - state.softUsed;
  const wantsSoft = failure === "budget-exhaustion" && input.evaluatorConfigured;

  if (!wantsSoft && hardRemaining > 0) {
    const nextState: RetryState = {
      ...state,
      hardUsed: state.hardUsed + 1,
    };
    return {
      action: "retry",
      tier: "hard",
      extension: false,
      nextState,
      nextBudget: attemptBudget(base, nextState.extensions, policy),
      reason: "unconditional retry",
    };
  }

  if (softRemaining > 0 && input.evaluatorConfigured) {
    const verdict = input.evaluatorVerdict;
    if (verdict === undefined)
      return stop("soft retry requires an evaluator verdict");
    const detail = verdict.reason === undefined ? "" : `: ${verdict.reason}`;
    if (verdict.status === "escalate-infrastructure")
      return stop("evaluator reported an infrastructure problem" + detail, true);
    if (verdict.status === "stuck")
      return stop("evaluator found no viable next step" + detail, true);
    if (verdict.status === "extend") {
      if (!input.madeProgress)
        return stop("extend refused: no progress over the previous attempt");
      if (!budgetGrows(base, state.extensions, policy))
        return stop("extension ceiling reached");
      const nextState: RetryState = {
        ...state,
        softUsed: state.softUsed + 1,
        extensions: state.extensions + 1,
      };
      return {
        action: "retry",
        tier: "soft",
        extension: true,
        nextState,
        nextBudget: attemptBudget(base, nextState.extensions, policy),
        reason: "evaluator granted an extension" + detail,
      };
    }
    if (!verdict.distinct)
      return stop("evaluator's approach duplicates a previous one" + detail, true);
    const nextState: RetryState = {
      ...state,
      softUsed: state.softUsed + 1,
    };
    return {
      action: "retry",
      tier: "soft",
      extension: false,
      nextState,
      nextBudget: attemptBudget(base, nextState.extensions, policy),
      reason: "evaluator proposed a distinct approach" + detail,
    };
  }

  // Budget exhaustion with hard retries left but no evaluator to ask: an
  // unconditional retry is still the only option available.
  if (hardRemaining > 0) {
    const nextState: RetryState = { ...state, hardUsed: state.hardUsed + 1 };
    return {
      action: "retry",
      tier: "hard",
      extension: false,
      nextState,
      nextBudget: attemptBudget(base, nextState.extensions, policy),
      reason: "unconditional retry",
    };
  }

  return stop("no retry tier available");
}

/**
 * Whether the next decision requires an evaluator verdict. True only when the
 * hard tier cannot answer and a soft retry is still available, so the caller
 * can skip the evaluator call entirely for hard retries.
 */
export function needsEvaluator(input: RetryInput): boolean {
  const { policy, state, failure } = input;
  if (!retryable(failure)) return false;
  if (state.hardUsed + state.softUsed >= policy.hard + policy.soft) return false;
  const hardRemaining = policy.hard - state.hardUsed;
  const softRemaining = policy.soft - state.softUsed;
  const wantsSoft = failure === "budget-exhaustion" && input.evaluatorConfigured;
  if (!wantsSoft && hardRemaining > 0) return false;
  return softRemaining > 0 && input.evaluatorConfigured;
}

/** Classify a failed attempt from its termination reason and safety flags. */
export function classifyFailure(input: {
  readonly terminationReason?: string;
  readonly historyFailure?: boolean;
  readonly verifierIntegrityFailure?: boolean;
  readonly workerBlocked?: boolean;
  readonly failed: boolean;
}): FailureClass {
  if (input.historyFailure || input.verifierIntegrityFailure) return "unsafe";
  if (input.workerBlocked) return "blocked";
  if (!input.failed) return "recoverable";
  switch (input.terminationReason) {
    case "tool-call-limit":
    case "timeout":
    case "no-tool-progress":
    case "generation-limit":
      return "budget-exhaustion";
    default:
      return "recoverable";
  }
}
