import { describe, expect, test } from "bun:test";
import {
  attemptBudget,
  classifyFailure,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  INITIAL_RETRY_STATE,
  needsEvaluator,
  type RetryPolicy,
  type RetryState,
} from "../src/retry.js";

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  ...DEFAULT_RETRY_POLICY,
  hard: 2,
  soft: 3,
  ...over,
});
const base = { toolCalls: 100, workerTimeoutMs: 1_000 };
const state = (over: Partial<RetryState> = {}): RetryState => ({
  ...INITIAL_RETRY_STATE,
  ...over,
});
const decide = (
  over: Partial<Parameters<typeof decideRetry>[0]> = {},
) =>
  decideRetry({
    policy: policy(),
    state: state(),
    failure: "recoverable",
    base,
    evaluatorConfigured: true,
    madeProgress: false,
    ...over,
  });

describe("attemptBudget", () => {
  test("no extensions returns the stage base", () => {
    expect(attemptBudget(base, 0, policy())).toEqual(base);
  });

  test("each extension adds its fraction of the base", () => {
    expect(attemptBudget(base, 1, policy())).toEqual({
      toolCalls: 150,
      workerTimeoutMs: 1_500,
    });
    expect(attemptBudget(base, 2, policy())).toEqual({
      toolCalls: 200,
      workerTimeoutMs: 2_000,
    });
  });

  test("the ceiling caps the total budget", () => {
    const capped = attemptBudget(base, 10, policy());
    expect(capped).toEqual({ toolCalls: 300, workerTimeoutMs: 3_000 });
  });
});

describe("decideRetry", () => {
  test("never retries an unsafe failure", () => {
    for (const failure of ["unsafe", "blocked"] as const) {
      const decision = decide({ failure });
      expect(decision.action).toBe("stop");
    }
    expect(decide({ failure: "blocked" })).toMatchObject({ blocked: true });
    expect(decide({ failure: "unsafe" })).toMatchObject({ blocked: false });
  });

  test("a recoverable failure takes an unconditional hard retry", () => {
    const decision = decide({ failure: "recoverable" });
    expect(decision).toMatchObject({
      action: "retry",
      tier: "hard",
      extension: false,
    });
  });

  test("budget exhaustion goes to the evaluator instead of burning a hard retry", () => {
    const decision = decide({
      failure: "budget-exhaustion",
      evaluatorConfigured: true,
      evaluatorVerdict: { status: "extend" },
      madeProgress: true,
    });
    expect(decision).toMatchObject({
      action: "retry",
      tier: "soft",
      extension: true,
    });
    expect(decision).toMatchObject({
      nextBudget: { toolCalls: 150, workerTimeoutMs: 1_500 },
    });
  });

  test("budget exhaustion without an evaluator falls back to a hard retry", () => {
    const decision = decide({
      failure: "budget-exhaustion",
      evaluatorConfigured: false,
    });
    expect(decision).toMatchObject({
      action: "retry",
      tier: "hard",
      extension: false,
      nextBudget: base,
    });
  });

  test("extend requires a progress delta", () => {
    const decision = decide({
      failure: "budget-exhaustion",
      evaluatorVerdict: { status: "extend" },
      madeProgress: false,
    });
    expect(decision).toMatchObject({ action: "stop" });
    expect((decision as { reason: string }).reason).toContain("no progress");
  });

  test("extend stops at the ceiling", () => {
    const decision = decide({
      policy: policy({ soft: 10 }),
      state: state({ softUsed: 4, extensions: 4 }),
      failure: "budget-exhaustion",
      evaluatorVerdict: { status: "extend" },
      madeProgress: true,
    });
    expect(decision).toMatchObject({ action: "stop" });
    expect((decision as { reason: string }).reason).toContain("ceiling");
  });

  test("new-approach retries at base budget only with a distinct hypothesis", () => {
    const distinct = decide({
      failure: "recoverable",
      state: state({ hardUsed: 2 }),
      evaluatorVerdict: { status: "new-approach", distinct: true },
    });
    expect(distinct).toMatchObject({
      action: "retry",
      tier: "soft",
      extension: false,
      nextBudget: base,
    });
    const duplicate = decide({
      failure: "recoverable",
      state: state({ hardUsed: 2 }),
      evaluatorVerdict: { status: "new-approach", distinct: false },
    });
    expect(duplicate).toMatchObject({ action: "stop", blocked: true });
  });

  test("stuck and escalate stop with a caller decision", () => {
    for (const status of ["stuck", "escalate-infrastructure"] as const) {
      const decision = decide({
        failure: "recoverable",
        state: state({ hardUsed: 2 }),
        evaluatorVerdict: { status },
      });
      expect(decision).toMatchObject({ action: "stop", blocked: true });
    }
  });

  test("a soft retry without a verdict stops rather than retrying blind", () => {
    const decision = decide({
      failure: "recoverable",
      state: state({ hardUsed: 2 }),
    });
    expect(decision).toMatchObject({ action: "stop" });
    expect((decision as { reason: string }).reason).toContain("evaluator verdict");
  });

  test("stops when the retry budget is exhausted", () => {
    const decision = decide({
      state: state({ hardUsed: 2, softUsed: 3, extensions: 1 }),
    });
    expect(decision).toMatchObject({ action: "stop" });
    expect((decision as { reason: string }).reason).toContain("exhausted");
  });

  test("hard retries are spent before soft ones", () => {
    const decision = decide({
      state: state({ hardUsed: 1, softUsed: 0 }),
      failure: "recoverable",
    });
    expect(decision).toMatchObject({
      action: "retry",
      tier: "hard",
      nextState: { hardUsed: 2, softUsed: 0, extensions: 0 },
    });
  });
});

describe("needsEvaluator", () => {
  const needs = (over: Partial<Parameters<typeof needsEvaluator>[0]> = {}) =>
    needsEvaluator({
      policy: policy(),
      state: state(),
      failure: "recoverable",
      base,
      evaluatorConfigured: true,
      madeProgress: false,
      ...over,
    });

  test("a hard retry needs no evaluator", () => {
    expect(needs({ failure: "recoverable" })).toBeFalse();
  });

  test("budget exhaustion consults the evaluator rather than a hard retry", () => {
    expect(needs({ failure: "budget-exhaustion" })).toBeTrue();
  });

  test("the soft tier needs the evaluator once hard retries are spent", () => {
    expect(needs({ state: state({ hardUsed: 2 }) })).toBeTrue();
  });

  test("never asks without a configured evaluator", () => {
    expect(needs({ evaluatorConfigured: false })).toBeFalse();
    expect(
      needs({ failure: "budget-exhaustion", evaluatorConfigured: false }),
    ).toBeFalse();
  });

  test("never asks when no retry is available or the failure is unsafe", () => {
    expect(needs({ state: state({ hardUsed: 2, softUsed: 3 }) })).toBeFalse();
    expect(needs({ failure: "unsafe" })).toBeFalse();
    expect(needs({ failure: "blocked" })).toBeFalse();
  });
});

describe("classifyFailure", () => {
  test("maps termination reasons to failure classes", () => {
    expect(
      classifyFailure({ failed: true, terminationReason: "tool-call-limit" }),
    ).toBe("budget-exhaustion");
    expect(classifyFailure({ failed: true, terminationReason: "timeout" })).toBe(
      "budget-exhaustion",
    );
    expect(
      classifyFailure({ failed: true, terminationReason: "protocol-error" }),
    ).toBe("recoverable");
    expect(classifyFailure({ failed: false })).toBe("recoverable");
  });

  test("safety flags override the termination reason", () => {
    expect(
      classifyFailure({
        failed: true,
        terminationReason: "timeout",
        historyFailure: true,
      }),
    ).toBe("unsafe");
    expect(
      classifyFailure({
        failed: true,
        terminationReason: "timeout",
        verifierIntegrityFailure: true,
      }),
    ).toBe("unsafe");
    expect(classifyFailure({ failed: true, workerBlocked: true })).toBe(
      "blocked",
    );
  });
});
