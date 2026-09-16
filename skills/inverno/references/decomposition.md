# Caller-owned decomposition and stage handoffs

Apply this protocol before offloading implementation to inverno. The calling
agent (Codex, Claude, or another caller) owns architecture, decomposition and
acceptance. Qwen receives one execution-ready stage. Do not default to asking the
remote worker to decompose and implement the whole feature in the same run.
Explicit user instructions take precedence over this skill, including a request
for a planning experiment. Distinguish a whole-task budget from a per-stage budget;
decomposition does not multiply an explicitly limited total allowance.

## 1. Establish the contract and resolve foundations

Inspect the relevant code, runtime and existing checks enough to identify the
load-bearing contracts. Separate required behavior, hard constraints, established
facts, implementation suggestions and unresolved decisions. Check the actual
framework/runtime boundary when correctness depends on it; an API name or an
untested assumption is not evidence.

Resolve foundational decisions before submitting dependent implementation. If
necessary, offload a separate bounded investigation: one explicit question,
allowed inspection/experiment, evidence to return, finite budget, and a clear
proceed/BLOCKED criterion. Review its evidence and choose the approach as caller.
Do not hide architectural discovery inside an implementation stage or require
Qwen to choose between speculative architectures while also delivering code.
The caller need not prewrite the implementation; local implementation choices
remain the worker's responsibility within the agreed contracts.

## 2. Make a stage map

Persist a dependency-ordered stage map in the calling project's gig artifacts.
Map each requirement and important subclause to a stage and observable acceptance
check. Include the final integration/release checks; passing individual stages
must not silently drop cross-stage requirements.

Each stage must deliver one coherent, independently verifiable outcome. Atomic
means implementable and testable as a unit, not necessarily one file, function,
or database transaction. State its inputs, outputs, consumers and the safe,
testable repository state left behind. A small task may already be one stage;
ordinary bounded tests/builds do not need artificial decomposition. An explicitly
requested check in a known existing checkout can run there under its repository
policy; cache writes alone do not make it a new implementation stage. Use existing
gig notes when available; a trivial standalone check need not create a new gig.

Split a stage before submission when it:
- combines several independent features or backend/UI domains;
- requires a major unresolved architecture, dependency or public-contract decision;
- has a vague finish line such as “implement backend” or “finish remaining work”;
- cannot realistically include implementation, tests, repairs, report and commit
  within its worker budget.

For the current Qwen setup, roughly 20 minutes is a useful initial sizing target,
not a universal timeout or promise. Calibrate from observed runs and complexity;
set explicit finite time/tool/attempt limits for each stage within any user-specified
whole-task allowance. An older brief's investigation allowance does not establish
that the foundation is already resolved: normally use it for the prerequisite
investigation before dependent coding, preserving its limit. Do not override an
explicit user-mandated execution sequence or enlarge budgets to follow this skill.
Prefer splitting an
oversized stage to routinely increasing its budget. For example, a verified atomic
redemption primitive is one outcome; combining it with invite management, account
revocation, API-token expiry and their UI is several outcomes.

## 3. Write the execution-ready stage brief

Before queueing, write a self-contained brief using the fields below. Keep the
whole-project stage map with the caller; send the worker only the relevant context
and interfaces so it does not restart broad discovery.

```markdown
# Stage <id>: <one concrete outcome>

Baseline and dependencies:
- Repository, branch and exact base SHA; reviewed prerequisite commits/evidence.

Required outcome and scope:
- Observable behavior, invariants and failure behavior.
- Allowed paths/areas; explicit exclusions and authority limits.

Established decisions and interfaces:
- Exact input/output types, schemas, API/error contracts and downstream consumers.
- What is already verified, where the evidence is, and what remains uncertain.
- Label implementation suggestions separately from required outcomes.

Ordered implementation steps:
1. Inspect the named relevant sections/reference evidence for the specific question.
2. Implement a concrete part of this outcome while preserving named invariants.
3. Add/run the specified behavior and failure checks; repair based on their output.
4. Review the diff, run the final required checks, produce the report and commit.
(Replace these generic descriptions with task-specific actions and checkpoints.)

Acceptance and return:
- Exact commands plus expected behavior, including negative/concurrency cases
  where relevant; independent verifier location and dependencies.
- Required evidence, structured report and clean descendant-commit requirements.
- Explicitly excluded future work and known validation limits.

Budget and stopping:
- Investigation allowance, total wall/tool/attempt budget and what can be decided
  locally. Concrete conditions for a supported BLOCKED report to the caller.
```

Keep individual steps concrete and digestible, but do not mandate incidental
syntax or a speculative implementation. The worker may challenge a suggested
method with evidence; changing a hard contract or dependency requires the caller's
decision. Include the worker-facing guidance from [worker-judgment.md](worker-judgment.md)
in the actual handoff; references to a skill the worker cannot read are insufficient.

Use verified absolute remote paths for supporting material. Stage and identify
all required inputs, including prior probes and framework source availability.
Distinguish missing dependencies from failed code. Preflight the verifier and its
fixtures before spending model time: a failure caused by bad paths, unsupported
runner configuration or broken oracle setup must not be scored as worker failure.
Declare verifier dependencies for freezing as described in [execution.md](execution.md).

## 4. Caller readiness gate, then one stage at a time

Do not submit implementation until the caller can answer:
- Is the foundation supported, with no major decision left to this worker?
- Does the brief have one deliverable, concrete steps/contracts and a feasible budget?
- Are its inputs available and its independent acceptance checks usable?
- Does the stage map preserve all original requirements and safe intermediate states?

This is the caller's review gate, not an extra user-confirmation requirement.
Continue authorized stages autonomously within the original task scope. Planning
permission alone does not authorize implementation, publishing or deployment.

Queue one ready stage through the existing execution workflow. After it ends,
review the exact commit, checks, report and deviations before preparing dependent
work. Carry forward a concise handoff: verified decisions, passing checks, relevant
changes, remaining questions and the next stage's exact baseline. Avoid replaying
whole transcripts or making each stage rediscover the same libraries.

If blocked or unsuccessful, review the evidence and change the hypothesis, scope
or prerequisites before another submission. Preserve the old run and its budget;
do not restart the original large prompt as a “fresh” attempt. Do not automatically
continue dependent stages when the prior stage is unaccepted.

Separate actual unmet stage requirements from deliberately excluded future work
and accepted assumptions. Disclose validation limits in the report's appropriate
fields; never conceal genuine gaps to gain acceptance. If Diriger returns
`task-blocked`, review it and retain its status/evidence—do not rewrite the report
or mark the run accepted merely because tests passed.

This protocol is caller-side guidance. It does not add an automated stage scheduler,
a mid-attempt progress evaluator, or new enforcement to Diriger. OMP still supplies
tools/sessions/compaction; the caller owns the plan and Diriger owns runtime gates.
