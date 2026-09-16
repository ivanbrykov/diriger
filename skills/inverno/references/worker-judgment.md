# Judgment in coding handoffs

## Prepare the plan

First follow [caller-owned decomposition](decomposition.md). The caller supplies
one execution-ready stage and owns foundational choices and cross-stage contracts;
the worker owns detailed implementation. Do not use this judgment guidance as a
substitute for decomposition or as permission to send an entire broad feature.

State the required behavior, hard constraints, and independent acceptance checks
separately from implementation suggestions. Label a proposed method as a suggestion
unless it is a genuine constraint; explain why a required low-level mechanism is
necessary. Do not make the worker reverse-engineer which parts it may challenge.

Keep transport/resource handling in established platform or library facilities
where they fit. Check the actual deployment adapter/runtime, not just an API name.
A new dependency or framework rewrite has costs too: prefer an existing dependency
or a focused maintained library over adding a second stack for one feature.

Give a bounded investigation allowance within the task's total budget and state
what the worker may change autonomously (including dependencies). If a foundational
choice is unresolved, resolve it with an investigation task before coding. Supply
available documentation/source references so checking alternatives is practical.

Copy the guidance below into each coding plan, adapting only task-specific limits
and authority. Do not replace it with a link the remote worker cannot access.

## Worker-facing guidance

> Deliver the required behavior with the least justified custom machinery. Prefer
> existing platform/framework capabilities, then focused maintained libraries;
> write low-level mechanisms only when evidence shows the available options do not
> meet this task's requirements. Verify support in the target runtime. Using a
> library does not remove the need to check its behavior and integration.
>
> Treat the proposed implementation as a hypothesis. Challenge a step that
> duplicates established functionality, conflicts with another requirement, relies
> on unsupported behavior, or creates disproportionate complexity. Cite the
> concrete evidence and a simpler alternative. Within the plan's permitted scope,
> choose the better method and explain the deviation. Do not override explicit
> constraints, change public contracts, replace the stack, or add unapproved
> dependencies to make a preferred approach fit.
>
> Resolve routine uncertainty with a small source/doc check or focused experiment
> inside the allotted budget. If a foundational question remains unresolved, the
> required solution appears unsafe or infeasible, or the fix requires a decision
> outside your authority, stop the affected work and return BLOCKED. Do not stack
> speculative workarounds, weaken the requirement, or spend the remaining budget
> making an unsupported approach look complete. Preserve useful work and evidence.
>
> A BLOCKED report must name the questionable assumption or conflicting constraint,
> show what you checked and observed, describe the smallest viable alternative,
> and state the decision needed from the caller. Include changed files and test
> state. An evidence-backed stop is preferable to a guessed solution; do not
> fabricate a success commit. If an automatic repair attempt provides no new
> evidence or authority, restate the blocker instead of resuming the same dead end.
>
> A green verifier is necessary, not sufficient. Check interactions it may omit,
> especially framework defaults, resource ownership/cleanup, error paths, and test
> isolation. Report known gaps even when the prescribed checks pass. End with the
> key decisions, relevant framework/library evidence, validation, and limitations.

## Handle the result

The caller reviews justified deviations and blocker reports before any new job or
scope expansion. Separate a useful design challenge from a broken implementation;
do not automatically respond with another identical brief or a larger budget.

Diriger now supports structured worker outcomes for new CLI runs. Its ACP brief
and bundled Goose recipe include the core judgment guidance and a unique JSON
report path. Keep task-specific authority and investigation limits in the plan.
The worker must write the supplied report schema and finish its session normally;
the word BLOCKED in prose alone is not a machine-readable outcome.

An evidence-backed blocked report produces `task-blocked` (exit 4), preserves useful
work, and stops automatic retries. A completed report's known gaps withhold acceptance
even when the verifier passes. Process, history, cleanup, and verifier-integrity
failures retain priority. Recovery may safety-block (exit 3) when a pending report
exists but normal worker completion is unproven; do not bypass that check.

Pueue may display Failed(4): interpret this as a return to the caller, not a request
to restart. Inspect the immutable report and resolve the decision before authorizing
new work. Existing frozen runs retain their original reporting policy; do not edit
old inputs or verifiers to retrofit the feature. See execution.md for compatibility
with custom recipes and programmatic callers.
