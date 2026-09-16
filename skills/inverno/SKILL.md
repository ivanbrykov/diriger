---
name: inverno
description: Run or offload a bounded task on the user's inverno machine when the user explicitly requests it. Requires caller-owned decomposition and detailed stage briefs before coding offloads; covers staging, execution, recovery, and verified results. Do not choose inverno proactively for general delegation.
---

# Inverno

Use the user's remote compute machine to execute the requested work. Inverno is
the capability; the execution tools and model may change. Keep task framing,
architecture, ambiguous decisions, and final integration with the calling agent.

## Activation

Load this skill for an explicit request such as “run this on inverno”, “offload
the implementation to inverno”, or `$inverno`. A mention of the machine or a
general request to delegate does not authorize offloading. Existing authorization
for the same task persists; do not ask again for routine steps within that scope.
A status-only request authorizes inspection, not a new execution.

## New-work tooling

For new JavaScript/TypeScript projects and standalone tools, use Node.js and
pnpm. Check availability on inverno before submission; an absent installation
is a setup dependency, not a reason to silently fall back to Bun. Preserve existing
projects' tooling unless the user requests migration. The current Diriger
installation still depends on Bun; invoking that existing supervisor does not
require the target project to use Bun. Carry this distinction into worker briefs.

## Default worker: OMP

OMP18.2.0 is the user-approved experimental default on inverno as of2026-09-15.
Read [OMP configuration](references/omp.md) for launch settings and known gaps.
The user accepts experimental adoption; do not reintroduce an approval gate based
on the earlier trial-only status. Keep independent report/Git/verifier checks. The deployed worker uses our bounded
system prompt while OMP retains compaction. Qwen assesses failed attempts before
a retry; periodic mid-attempt evaluation remains deferred.
Third-party runtime dependencies do not change the Node/pnpm project-code policy.

## Required caller decomposition

Before offloading implementation, read and follow
[decomposition and stage handoffs](references/decomposition.md). The calling agent
owns architecture and the dependency-ordered plan. Resolve foundational decisions,
map requirements to independently testable stages, and prepare a detailed brief
with atomic implementation steps, exact interfaces, evidence, checks and budgets.
Do not send the entire large request to Qwen to both plan and implement. A task
already small enough may remain one stage; bounded investigation can be a separate
stage with an explicit question and proceed/BLOCKED gate.

Review each stage's result before launching dependent work and carry verified
findings forward. This is an internal readiness gate, not a new user-approval
step. Continue within existing authorization. Read
[worker judgment](references/worker-judgment.md) and include its worker-facing
instructions in the handoff. The worker does not automatically inherit this skill.

## Workflow

1. Read the calling project's policy and current gig notes when present. For implementation,
   complete the decomposition/readiness gate above and select the next ready stage.
   Record its exact baseline, scope, ordered steps and independent acceptance checks.
   Transfer established findings; let the worker own implementation details within
   the settled contracts.
2. Read [machine and access](references/machine.md). Confirm access and current
   tools without changing services, models, or machine configuration as a side
   effect of an ordinary task. Read the remote `/data/work/AGENTS.md` and any
   applicable repository policy before staging work.
3. For implementation, prepare a dedicated remote local-disk checkout/worktree from an
   exact base commit. Keep task inputs, verifier, and evidence outside its mutable
   tree. Transfer only task-relevant material. Use Git fetch/bundles for commits;
   handle required uncommitted inputs explicitly instead of silently omitting
   them. Never sync a live `.git` directory or let two agents write the same tree.
4. For implementation, preflight the stage inputs and verifier before submission. Read
   [current execution tools](references/execution.md). Use the selected
   execution tool appropriate to the task: ordinary commands for a test/build,
   the supervised coding worker for implementation. Set finite time/attempt limits.
   Submit model jobs to the shared serial queue. Record the unique task label,
   remote paths, base SHA, queue ID, and evidence path in local gig notes.
5. Monitor compact structured status and fetch bounded logs when needed. An
   uncertain submission response is not proof the job was rejected: look up its
   unique label before retrying. Preserve interrupted evidence and remaining
   budgets; recovery must not become a fresh unlimited run.
6. Retrieve the result and decisive validation evidence. For code, fetch accepted
   commits into a local review ref/worktree, compare against the recorded base,
   and review the changes before integrating within the user's authorization.
   Preserve the calling project's unrelated changes. Report accepted/failed/blocked
   status, commit IDs, verification outcome, and any remaining limitation.

Queue completion alone does not establish task acceptance. For supervised code,
use the supervisor's verified exact-commit result. For other work, use the
independent acceptance check defined for that task. Keep bulky logs remotely and
retain a concise local receipt.

If access or required credentials are unavailable, report the concrete blocker;
do not fabricate access or silently move the requested execution elsewhere.
