# Goose Supervisor Evolution Plan

## Purpose

Evolve `goose-supervisor` from a reliable single-stage experiment into a small,
durable SDLC runner without losing the property that made the experiment work:
models propose changes, while deterministic code owns scheduling, Git state,
verification, retry limits, evidence, and exit status.

The target is not a general multi-agent platform. It is a serial sprint runner
for local coding agents:

```text
approved sprint manifest
  -> isolated run branch and worktree
  -> fresh worker for one bounded stage
  -> controller-owned verification
  -> fresh repair worker with exact failure evidence, if needed
  -> cumulative final verification
  -> human review/approval when configured
  -> retrospective evidence and proposed lessons
```

## Lessons to preserve

### From the successful supervisor experiment

- A fresh, single-purpose worker is easier to bound and recover than a
  persistent agent with a growing conversation.
- A worker's prose is advisory. Success is a clean, new Git commit followed by
  controller-owned verification.
- Retry workers should receive exact, bounded failure evidence from the prior
  attempt instead of conversational history.
- One local GPU means serial execution is a feature: it gives the active worker
  the full inference slot and makes evidence and Git ownership unambiguous.
- The supervisor should remain dependency-light TypeScript running on Bun.

### From Samovar

- Durable state must live outside model context and be sufficient to resume
  after either the controller or model process dies.
- Work should happen in an isolated, persistent run worktree, never in the
  user's main checkout.
- Inputs should be snapshotted and hashed so a resumed run has a stable
  contract.
- Atomic state writes, explicit ownership, bounded retries, and process
  telemetry matter more than elaborate agent protocols.
- Do not carry forward Samovar's dynamic Mayor protocol, recursive
  decomposition, transactional agent commands, or large state vocabulary.

### From SwarmForge and Uncle Bob's role pipeline

- Specification, implementation, cleanup, architecture, hardening, and QA are
  useful concerns, but they should be optional stage templates rather than a
  permanently running cast of agents.
- Dedicated worktrees and explicit handoffs are useful. tmux windows, daemons,
  agent-to-agent messaging, and a persistent leader are not required for this
  single-GPU workflow.
- TDD, property tests, mutation tests, scope checks, and end-to-end acceptance
  tests belong in executable verifier commands, not only in role prompts.
- Small work should be allowed to use a short pipeline; the six-role workflow
  must not become a tax on every change.

### From claude-booping

- One plan should form one durable sprint, split into named, sequential
  milestones with resumable state.
- Markdown plan and milestone artifacts, frontmatter-like status, feedback
  sidecars, execution statistics, retrospectives, and human-approved lessons
  are worth adopting.
- Fresh implementation and repair sessions are good boundaries.
- Do not adopt its trust boundary: the controller must rerun every declared
  verifier and must not accept a worker's report that verification passed.
- A final independent pass is valuable, but model review cannot silently become
  acceptance authority. It must produce an advisory artifact or stop at an
  explicit human gate.
- A green declared suite can still miss user-visible behavior. Preserve room
  for frozen/hidden acceptance tests, mutation tests, and independent review.

### From Goose, Pi, and local llama.cpp operation

- Keep Goose as the first and default worker because the current end-to-end path
  is proven, but separate the worker adapter from the controller.
- A later Pi adapter should use headless, single-task operation. It must not
  introduce a nested `/orchestrate` workflow or gain acceptance authority.
- Record the actual adapter, model, context limit, reasoning effort, timing,
  token usage, and retry count when available. Do not record API keys or other
  secrets.
- Optimize models by verified completion time and rejected attempts, not raw
  decode speed. The same sprint benchmark should compare model, quantization,
  MTP, context, and reasoning settings.
- The supervisor should observe inference configuration but should not start,
  stop, download, or select llama.cpp models.

## Non-negotiable invariants

1. Deterministic TypeScript is the only component allowed to advance run state.
2. A model's final response is never parsed as a success or routing contract.
3. Every implementation or repair attempt uses a new agent process/session.
4. At most one mutating worker owns a run worktree at a time.
5. Every accepted attempt advances from the recorded pre-attempt commit to a
   clean descendant commit without rewriting prior history.
6. Every declared verifier is executed by the controller and recorded with its
   exact command, exit code, timing, timeout state, and bounded output.
7. A stage is accepted only when its Git invariants, scope policy, and stage
   verifier all pass.
8. A sprint is machine-verified only when all stages and the cumulative final
   verifier pass at the same recorded HEAD.
9. Human approval, when enabled, is a separate recorded transition. It is not
   inferred from model prose.
10. Restarting the controller must reconstruct state from disk and Git, not
    from an old model conversation.

## Deliberate non-goals

- No persistent coordinator model.
- No parallel workers in the first complete version.
- No recursive or model-directed task decomposition during execution.
- No agent-to-agent messaging, daemon, tmux, Zellij, database, or web UI.
- No automatic merge into the user's base branch.
- No automatic editing of `AGENTS.md`, recipes, or project policy from a
  retrospective.
- No model lifecycle management for llama.cpp.
- No generalized project-management replacement.

## User-facing artifact model

Keep authored intent readable and execution state machine-readable. Use JSON
for controller-owned schemas so the project stays dependency-free; use Markdown
for plans, stage briefs, feedback, reviews, and retrospectives.

An input sprint directory should look like:

```text
sprint/
  sprint.json
  plan.md
  stages/
    01-specify.md
    02-implement.md
    03-harden.md
```

`sprint.json` should contain a versioned, closed schema:

```json
{
  "schemaVersion": 1,
  "name": "task-ledger",
  "repository": "/data/work/repos/task-ledger",
  "base": "main",
  "plan": "plan.md",
  "stages": [
    {
      "id": "01-implement",
      "brief": "stages/01-implement.md",
      "dependsOn": [],
      "allowedPaths": ["src/**", "test/**"],
      "verifier": ["./verification/verify-stage", "01-implement"],
      "worker": "goose"
    }
  ],
  "finalVerifier": ["./verification/verify-final"],
  "approval": "human"
}
```

Command arrays are argv, not shell strings. Paths referenced by the manifest
are resolved relative to the manifest, validated before work begins, copied
into the run directory, and SHA-256 hashed. Environment-specific values such
as the repository and evidence roots may be supplied by CLI flags rather than
committed into a reusable manifest.

The durable run directory should look like:

```text
runs/<run-id>/
  inputs/
    sprint.json
    plan.md
    stages/
  state.json
  events.jsonl
  worktree.json
  stages/<stage-id>/
    stage.md
    attempts/001/
      worker.stream.jsonl
      worker.stderr.log
      git.json
      verification.json
      verification.log
      failure.md
  final/
    verification.json
    verification.log
    review.md
  retro/
    metrics.json
    retrospective.md
    proposed-lessons.md
```

`state.json` is the current materialized state and is replaced atomically.
`events.jsonl` is an append-only diagnostic history. Attempt directories are
immutable after their final transition. Absolute source paths may be retained
for diagnosis, but input hashes define the resumable contract.

## State model

Keep the vocabulary intentionally small.

Sprint states:

```text
planned -> running -> verified -> completed
                    -> failed
                    -> awaiting-approval -> completed
                    -> rejected
```

Stage states:

```text
pending -> running -> accepted
                   -> failed
                   -> blocked
```

The scheduler validates a cycle-free dependency graph and chooses one ready
stage deterministically by manifest order. Version 1 should support a DAG in
the schema but execute it serially. No model may add, remove, reorder, or split
stages after the manifest is approved. A future groom command may draft a new
manifest, but execution begins only from a validated frozen snapshot.

## Git and worktree contract

- Create one run branch and persistent worktree from an explicit base commit.
- Never change the branch or files in the main repository checkout.
- Store the base commit, run branch, worktree path, and accepted HEAD after each
  stage.
- Use a run-owned lock/lease containing run id, hostname, PID, and timestamps.
  Refuse concurrent ownership; require an explicit recovery command for a stale
  lease.
- Before an attempt, require that HEAD equals the recorded stage head and that
  the worktree is clean, except when deliberately resuming an interrupted
  attempt.
- After an attempt, require a clean worktree, require the pre-attempt HEAD to be
  an ancestor of the post-attempt HEAD, reject merges and history rewrites, and
  enforce the configured commit-count policy. Default to exactly one new commit
  per attempt.
- Evaluate `allowedPaths` from the complete pre/post diff. Scope violations
  become deterministic failure evidence.
- Preserve failed commits and repair them with later commits for auditability.
  Do not reset or amend them automatically.
- Leave the completed branch/worktree available for human inspection. Cleanup
  is an explicit command and must refuse active or unapproved runs.

## Execution and verification contract

For each stage:

1. Materialize a bounded worker brief from the frozen plan, frozen stage brief,
   repository instructions, attempt number, and prior failure artifact.
2. Launch a fresh worker through the selected adapter.
3. Capture stdout, stderr, tool events, wall time, termination reason, and usage
   without treating any of them as proof of correctness.
4. Reconcile Git and apply descendant, cleanliness, commit-count, and path-scope
   checks.
5. Run the exact stage verifier from the manifest at the resulting HEAD.
6. If any gate fails, persist a bounded `failure.md` and launch a fresh repair
   attempt, up to the configured limit.
7. Atomically persist the accepted stage HEAD before scheduling its dependent.

After all stages:

1. Run the exact cumulative final verifier at the final stage HEAD.
2. Optionally run frozen or hidden oracle commands that were never shown to the
   worker. Their raw evidence remains controller-owned.
3. Optionally launch a fresh read-only reviewer to produce `review.md`. The
   review is advisory and cannot mark the sprint complete.
4. If approval is `human`, stop in `awaiting-approval`; `approve` records the
   approver, timestamp, reviewed HEAD, and optional note. If approval is
   `machine`, transition from `verified` to `completed` without pretending a
   semantic model review was deterministic.

Verifiers should be capable of composing formatting, lint, typecheck, unit,
integration, end-to-end, property, mutation, and scope-specific checks. The
manifest declares policy; the controller only executes it faithfully. Model
workers may run visible tests while developing, but those runs never replace
the controller's run.

## Failure and repair evidence

Improve the current failure sidecar while keeping it bounded. It should include:

- run, stage, attempt, adapter, and model identifiers;
- failure category and exact reproduction command;
- verifier exit code, timeout state, duration, and bounded beginning/end output;
- pre/post HEAD, commit list, dirty status, changed paths, and diff stat;
- a bounded patch when Git invariants failed before verification;
- previous accepted stage HEAD and current cumulative status;
- an instruction to reproduce, repair, add a regression test, commit once, and
  leave the worktree clean.

Bound output by encoded bytes rather than JavaScript character count. Redact
configured secret environment variables before persisting process metadata.

## Worker adapter boundary

Extract process invocation behind a small interface:

```ts
interface WorkerAdapter {
  readonly name: string;
  preflight(context: WorkerContext): Promise<AdapterMetadata>;
  run(context: WorkerContext): Promise<ProcessResult>;
}
```

The adapter may translate the frozen brief into a CLI invocation and normalize
telemetry. It may not inspect verifier results to decide acceptance, mutate run
state, schedule another worker, or delegate to its own orchestration hierarchy.

Implement adapters in this order:

1. `GooseAdapter`, preserving the current recipe invocation and stream parser.
2. `FakeAdapter` used by deterministic end-to-end tests.
3. `PiAdapter` using headless single-task mode, only after the controller is
   stable enough to run the same benchmark with either adapter.

Adapter selection can be sprint-wide initially. Per-stage adapter selection is
useful for experiments but should not imply parallel execution.

## Planning, review, and learning boundaries

These are separate from the execution core and should arrive last.

### Groom

An optional fresh planning worker may turn a request into `plan.md`, stage
briefs, and a draft `sprint.json`. Deterministic validation checks schema,
paths, dependency cycles, size limits, and presence of verifiers. A human
reviews and freezes the draft; the planning model cannot start execution.

Stage templates may express Uncle Bob-style concerns such as `specify`,
`implement`, `refactor`, `architect`, `harden`, and `qa`, but the manifest uses
only the stages the work needs. Templates supply prompts and suggested gates;
the committed manifest supplies the actual contract.

### Review

A reviewer receives the frozen requirements, final diff, accepted verifier
summary, and read-only repository access. Findings are written as Markdown.
They may inform a human rejection or a new explicitly approved repair stage,
but the controller must not infer a pass/fail decision from review prose.

### Retro and learn

The controller always emits deterministic `metrics.json`: wall time, attempts,
rejected commits, verification time, tokens, cache reads, changed paths, and
final outcome. An optional fresh retro worker may draft a retrospective and
proposed lessons from those metrics and artifacts.

Lessons never modify recipes or repository instructions automatically. A human
must promote a proposed lesson through an explicit command that shows the exact
target and diff. Record the source run and evidence with every promoted lesson
to limit cumulative prompt drift.

## CLI evolution

Preserve the current command until the manifest path proves itself.

```text
goose-supervisor run-stage ...       # current compatible single-stage path
goose-supervisor validate --sprint PATH
goose-supervisor start --sprint PATH --runs PATH [--run-id ID]
goose-supervisor resume --run PATH
goose-supervisor status --run PATH [--json]
goose-supervisor approve --run PATH [--note TEXT]
goose-supervisor reject --run PATH --reason TEXT
goose-supervisor recover --run PATH  # explicit stale lease/interruption path
goose-supervisor cleanup --run PATH  # explicit safe worktree cleanup
goose-supervisor report --run PATH [--json]
```

Stable JSON output and exit codes should exist for scripting. Human-readable
progress can remain the default. Do not require an interactive terminal; Zellij
is an observation surface, not part of the protocol.

## Delivery phases

Each phase should be independently releasable and retain the current end-to-end
test. Do not start optional model-authored planning or retrospectives until the
execution core survives interruption and recovery tests.

### Phase 0: Freeze the current contract

- Rename the existing path internally to `runStage` without changing behavior.
- Add tests for worker exit, no commit, dirty tree, rewritten history, verifier
  timeout, truncated output, and malformed stream events.
- Replace the benchmark-specific `SAMOVAR_BENCH_REPO` variable with a neutral
  documented variable while temporarily emitting the old variable for
  compatibility.
- Document current evidence schema and exit codes.

Exit criterion: the existing task-ledger recovery case still passes and every
current invariant has an explicit test.

### Phase 1: Versioned sprint manifest and serial scheduler

- Add closed-schema parsing and validation for `sprint.json`.
- Validate stage ids, referenced files, argv verifier commands, allowed paths,
  and dependency cycles before launching a model.
- Execute ready stages serially in deterministic manifest order.
- Run a cumulative final verifier after all stage verifiers pass.
- Keep the existing direct single-stage CLI as a compatibility wrapper that
  creates an in-memory one-stage manifest.

Exit criterion: the four-stage task-ledger plan completes from one command, and
a dependency, schema, or verifier-path error spends zero model tokens.

### Phase 2: Durable journal and resume

- Snapshot and hash all manifest inputs.
- Add atomic `state.json`, append-only events, and immutable attempt artifacts.
- Persist before and after every external process and state transition.
- Implement `status` and `resume` with reconciliation among disk state, process
  evidence, Git HEAD, and worktree status.
- Add crash injection tests at every transition boundary.

Exit criterion: killing the controller during a worker, verifier, or stage
transition can be recovered without repeating an accepted stage or trusting a
partial record.

### Phase 3: Isolated worktree, branch ownership, and Git hardening

- Create the run branch/worktree without touching the main checkout.
- Add lease acquisition, stale-owner detection, explicit recovery, and safe
  cleanup.
- Enforce descendant history, no merges, commit-count policy, cleanliness, and
  allowed paths.
- Capture bounded Git evidence for every failed invariant.

Exit criterion: concurrent supervisors cannot mutate the same worktree; main
checkout state is unchanged; rewrite, merge, scope, and dirty-tree fixtures are
rejected deterministically.

### Phase 4: Verification and approval layers

- Record exact stage and final verification commands as structured evidence.
- Support optional hidden oracle commands supplied outside the worker-visible
  snapshot.
- Add machine-only and human-approval completion policies.
- Add an optional read-only reviewer that can write findings but cannot change
  state.
- Support explicit rejection followed by a newly approved repair stage rather
  than interpreting reviewer prose automatically.

Exit criterion: a deliberately under-specified green test suite reaches
`awaiting-approval`, while a hidden semantic regression prevents `verified`.

### Phase 5: Worker adapters and comparable telemetry

- Extract and preserve `GooseAdapter`.
- Normalize optional model/context/reasoning/token/timing metadata.
- Add a headless `PiAdapter` without Pi orchestration or delegation.
- Ensure missing telemetry never changes the correctness result.
- Add secret-redaction tests and adapter contract fixtures.

Exit criterion: Goose and Pi can independently run the same frozen sprint; the
result records make verified wall time, attempts, rejected commits, and token
usage comparable without changing controller semantics.

### Phase 6: Groom, review, retro, and lesson promotion

- Add model-free `init` scaffolding for plan, stages, and manifest.
- Add optional draft-only groom and retro recipes using fresh sessions.
- Add reusable, optional role/stage templates for specify, implement, refactor,
  architect, harden, and QA.
- Add explicit manifest freeze and lesson-promotion operations with provenance.
- Keep all generated artifacts reviewable Markdown and all authoritative state
  deterministic JSON.

Exit criterion: a request can become a human-approved sprint, execute, stop for
review, and produce a retrospective without any model being able to approve its
own artifact or silently modify future policy.

### Phase 7: Local-model benchmark and tuning

- Run the four-stage task-ledger sprint as the permanent regression benchmark.
- Add frozen semantic cases and mutation fixtures that catch green-but-missing
  behavior.
- Compare Tess, Qwen3.8, and Muse Glimmer only when they can use the same
  manifest, verifier, limits, and adapter semantics.
- For Qwen3.8, compare baseline versus MTP and `medium` versus `xhigh` reasoning
  using repeated, warmed runs. Record prompt/decode timing when llama.cpp makes
  it available, but rank configurations by verified completion time, attempt
  count, semantic pass rate, and resource stability.
- Keep llama.cpp server profiles and model installation outside this repository;
  record their identifiers in benchmark metadata.

Exit criterion: at least three reproducible runs per configuration produce one
machine-readable comparison report, and performance tuning never weakens the
verification oracle.

## Suggested source layout

Grow by responsibility while keeping files small:

```text
src/
  cli.ts
  manifest.ts
  scheduler.ts
  state.ts
  evidence.ts
  git.ts
  worktree.ts
  verification.ts
  process.ts
  adapters/
    worker.ts
    goose.ts
    fake.ts
    pi.ts
  commands/
    run-stage.ts
    validate.ts
    start.ts
    resume.ts
    status.ts
    approve.ts
    recover.ts
    cleanup.ts
```

Do not create this structure pre-emptively. Extract a module only in the phase
that gives it a concrete contract and tests.

## Decision gates

Before moving past each phase, answer with evidence:

1. Did deterministic code remain the sole state-transition authority?
2. Can an interrupted run resume without conversation history?
3. Can a worker or reviewer claim success without the controller reproducing
   the required evidence?
4. Did the change add a protocol, role, service, or dependency that the serial
   local-GPU workflow does not yet need?
5. Does the task-ledger benchmark catch the failure this phase is intended to
   prevent?
6. Are human review and machine verification represented as different states?

If a feature cannot pass those gates, leave it outside `goose-supervisor`.

## First implementation slice

Start with Phase 0 and the smallest part of Phase 1:

1. Specify the manifest and evidence schemas in tests.
2. Make the current CLI an in-memory one-stage manifest adapter.
3. Add deterministic manifest validation with no model calls.
4. Run two sequential fake-worker stages plus a final verifier in an end-to-end
   fixture.
5. Only then connect the scheduler to real Goose and rerun the four-stage
   task-ledger benchmark.

This slice adds the missing multi-stage backbone while preserving every proven
property of the current supervisor. Worktrees, resume, alternate adapters, and
learning then attach to a stable execution contract instead of forcing another
rewrite.
