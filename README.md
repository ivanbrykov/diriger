# Diriger

Diriger is a deterministic, single-stage controller for bounded coding
work. It runs one fresh ACP worker at a time against a
caller-provided Git worktree, accepts work only through Git invariants and an
independent verifier, and records durable evidence outside that worktree.

It does not interpret model prose as success, run a daemon, manage a model
lifecycle, create a worktree, or sandbox tools. Supply a prepared local Git
worktree and a **new** external evidence directory for each run.

## CLI

The installed command is `diriger`. From a source checkout, use
`bun src/cli.ts` in its place. Existing evidence and internal ownership lock
names remain compatible with earlier releases.

## Run a stage

The evidence path must not already exist. It receives the frozen inputs,
state transitions, attempt artifacts, and final summary.

```bash
diriger run \
  --repo /absolute/path/to/repository \
  --plan /absolute/path/to/plan.md \
  --stage 1 \
  --verifier /absolute/path/to/verify-stage.sh \
  --acp-command '["/absolute/path/to/acp-agent", "serve"]' \
  --evidence /absolute/path/to/new-evidence-directory
```

The worker is any agent speaking ACP over stdio; `--acp-command` is its argv
as a nonempty JSON array and is required.

Also accepted: `--prompt`, `--worker-report`, `--max-attempts`,
`--worker-timeout-seconds`, `--no-tool-timeout-seconds`,
`--no-tool-output-bytes`, `--max-tool-calls`, `--max-tool-repetitions`, and
`--run-id`. The verifier runs as `SAMOVAR_BENCH_REPO=<repo> <verifier> <stage>`.

## Worker prompt template

The worker receives a single prompt rendered from a template. The default is
the bundled `prompts/worker.md`; select another file with `--prompt PATH`.
Templates substitute `{{ name }}` tokens; unknown or leftover tokens are
errors. The variables are:

- `plan`: content of the frozen plan file.
- `repository_path`: absolute path of the implementation repository.
- `plan_path`: absolute path of the frozen plan snapshot.
- `stage`: stage identifier.
- `attempt`: one-based supervisor attempt number.
- `failure_report_path`: the prior durable failure report, or `/dev/null` on
  the first attempt.
- `worker_report_path`: supervisor-owned report output path, or empty when
  structured outcomes are not required.
- `worker_judgment`: the worker judgment and structured-report contract, or
  empty when structured outcomes are not required.

Runaway control is deterministic rather than prompt-based: an attempt ends
with `tool-call-limit` when its ACP tool calls exceed `--max-tool-calls`
(default 100) or when the same tool call (kind, title, and input) repeats
consecutively beyond `--max-tool-repetitions` (default 8).

## Worker judgment and structured outcomes

New CLI runs require a worker report by default. The bundled worker prompt
template instructs the worker to prefer established platform/framework features,
then focused maintained libraries; challenge implementation suggestions with evidence;
and disclose known gaps even when prescribed tests pass. Explicit constraints and
scope still apply. The investigation allowance is at most five minutes or one quarter
of the per-worker wall budget, whichever is smaller (or a smaller plan allowance).
This is guidance to the worker within the enforced wall deadline, not an independently
measured investigation timer.

The supervisor provides a unique report path outside the mutable worktree. Before
ending its session, the worker writes UTF-8 JSON, limited to 64 KiB:

```json
{
  "version": 1,
  "status": "complete",
  "summary": "Implemented the requested behavior",
  "knownGaps": [],
  "decisions": ["Used the framework's native capability after checking its contract"],
  "validation": ["Focused tests passed"]
}
```

For an unresolved foundational decision or insufficient authority, use `"status":
"blocked"` and add:

```json
{
  "blocker": {
    "assumption": "The platform supports the required behavior",
    "evidence": ["The minimal reproduction fails on the installed runtime"],
    "attemptedApproaches": ["Checked platform documentation and tested the minimal case"],
    "smallestAlternative": "Use the supported platform mechanism",
    "decisionNeeded": "Clarify the contract before implementation continues"
  }
}
```

Include the common report fields as well. Describe changed files and test state in
summary/validation. A blocked report may preserve dirty partial work without a
fabricated success commit. A complete report with nonempty `knownGaps` also withholds
acceptance and returns control to the caller. These outcomes are `task-blocked`
(exit 4), distinct from ownership/recovery safety blockage (exit 3). They stop
automatic repair attempts; `resume` reports the same terminal task outcome rather
than silently granting new authority or a fresh budget.

A complete, gap-free report is necessary for report-required acceptance, but does
not replace clean descendant history, successful execution/cleanup, and independent
verification. Process/protocol/history violations remain failures. Reported validation
is advisory; the report can veto acceptance but cannot certify success. The supervisor
cannot detect gaps the worker fails to disclose.

Reports are read after worker cleanup and snapshotted into immutable attempt evidence.
Missing or invalid required reports cannot be accepted. Recovery must preserve this
gate, including when a crash interrupts finalization. Existing frozen runs retain their
original reporting policy; do not edit their inputs to change it.

For an existing custom prompt template that does not support the contract,
explicitly select `--worker-report optional` to retain legacy acceptance. That
mode does not provide the report gate. Custom templates used with required
reporting must consume the `worker_report_path` and `worker_judgment`
variables. Programmatic `supervise()` callers opt in with
`workerReportRequired: true`; omitted fields preserve compatibility with
existing callers and evidence.

## Freeze the verifier closure

By default a verifier is declared self-contained. For a verifier that depends
on files beside it, supply a manifest. Paths are relative to the manifest; the
snapshot root contains the verifier entry and every dependency.

```json
{
  "selfContained": false,
  "snapshotRoot": "../verification",
  "dependencies": [
    "../verification/oracle/check",
    "../verification/lib/rules.js"
  ]
}
```

```bash
diriger run ... \
  --verifier /absolute/path/to/verification/verify-stage.sh \
  --verifier-manifest /absolute/path/to/config/verifier-manifest.json
```

The controller freezes the resolved configuration, plan, worker prompt
template, worker runtime profile, verifier entry, and declared verifier
dependencies. It hashes
all frozen inputs and immutable attempt artifacts before status or resume work.
A changed frozen input, proof, or summary blocks recovery.

The runtime profile is captured automatically for each new run; it is not a
CLI option. `inputs/worker-profile.json` and the state profile fingerprint pin
the resolved ACP executable, full ACP argv, and identities of ACP argv
files such as adapter scripts. It captures selected non-secret model settings
and OpenAI route controls (`OPENAI_HOST`, `OPENAI_BASE_PATH`,
`OPENAI_BASE_URL`, `API_VERSION`, and `OPENAI_API_VERSION`), including whether each route
control was absent, plus `HOME`, `XDG_CONFIG_HOME`, `PI_CONFIG_DIR`, and OMP profile selectors only
for path resolution. The profile records the identity or absence of
`GOOSE_CONFIG_DIR/config.yaml` or the Goose default
`${XDG_CONFIG_HOME:-$HOME/.config}/goose/config.yaml`, and the OMP agent
configuration (`config.yml`, `models.yml`, `models.json`, and `settings.json`)
in either `PI_CODING_AGENT_DIR` or its default
`$HOME/${PI_CONFIG_DIR:-.omp}/[profiles/<profile>/]agent` directory. Resume
rejects changes to those values, the OpenAI route, resolved executable/PATH, binary or adapter
script bytes, and listed files; worker launches overlay captured settings on the
inherited environment. Credentials, agent databases/auth stores, and the whole
inherited environment are never persisted. Legacy evidence without a profile
may reuse an accepted result, finalize a verified result, or finish verifier-only
recovery, but it cannot launch a fresh model repair on resume. Profiles from
before route pinning are also read-only for resume and explicitly block a fresh
repair.

## Inspect, reclaim, and resume

Use the evidence directory to inspect recovery state without starting a worker:

```bash
diriger status --evidence /absolute/path/to/evidence --json
diriger recover --evidence /absolute/path/to/evidence --json
```

`recover` without `--apply` is a preview. If a controller crashed, use the
explicit reclamation step only after reviewing the preview:

```bash
diriger recover --evidence /absolute/path/to/evidence --apply
diriger resume --evidence /absolute/path/to/evidence --json
```

`resume` reuses an accepted exact-head proof without rerunning a worker or
verifier. It can finalize a durable verified proof, rerun a missing verifier at
the exact candidate, or begin one remaining fresh repair. Terminal evidence
returns its recorded failed result without launching another worker. A live or
unsafe stale owner blocks resume; recovery never implicitly takes over an
ownership claim.

Exit codes are consistent across commands:

- `0`: accepted run, ready/accepted status, or recovery preview.
- `1`: terminal failed result.
- `2`: invalid arguments, configuration, or durable state.
- `3`: active ownership or a blocked/unsafe recovery state.
- `4`: worker-reported task blockage or declared known gaps; caller decision required.

## Acceptance, history, and ownership

A worker must leave a clean new descendant commit on the original checked-out
branch. New merge commits, rewritten history, branch changes, no commit, dirty
state, timeouts, protocol failures, and verifier changes to the candidate all
fail the attempt. History violations stop immediately; the controller preserves
the worktree and evidence instead of resetting history. Ordinary verifier and
worker failures may use the remaining attempt budget.

Each worker and verifier has a detached POSIX process group guarded by durable
launch intent and controller identity. The guard refuses to authorize model or
tool execution until the ownership record and phase are durable. Cleanup sends
SIGTERM to the whole group, escalates to SIGKILL after two seconds, proves the
group is quiescent, then releases ownership. If the controller dies, the guard
self-cleans its recorded group; explicit stale recovery is required before a
new controller may proceed.

This requires Linux-style local process and filesystem semantics: `/proc`,
POSIX process groups, local atomic rename/fsync behavior, Bun, and Git. It is
not safe for workers that daemonize, escape their process group with `setsid`
or `setpgid`, or otherwise outlive the controller's group. It also is not a
multi-stage scheduler or a persistent agent/model service.

## Resource limits

Worker wall time and the tool-free generation watchdog are configurable. The
watchdog requires **both** `--no-tool-timeout-seconds` since the last tool event
and `--no-tool-output-bytes` generated since that event. For ACP, the byte budget
counts decoded UTF-8 text in thought/message chunks, excluding JSON framing,
metadata, and tool output. Splitting the same text into many token-sized frames
does not consume extra budget.

This is a generation budget, not a silence timeout: meaningful thought/message
activity is tracked separately from tool progress for diagnostics. It does not
reset the tool-free text budget indefinitely. Silent tools and model prefill
remain bounded by the hard worker wall timeout; no short inactivity cutoff is
introduced. ACP generation-budget failures include a bounded watchdog snapshot to explain
the generated-text count, wire bytes, and elapsed activity/tool times.

Worker ACP streams are capped at 64 MiB each and individual frames at 1 MiB; an
overflow terminates the owned group. Verifier streams are capped at 8 MiB each;
an overflow is drained, recorded as a verifier failure, and only bounded output
is retained. The verifier wall-time limit is ten minutes. Failure reports keep
at most 24,000 characters of verifier output.

## License

Apache-2.0. See [LICENSE](LICENSE).
