# Goose Supervisor

Goose Supervisor is a deterministic, single-stage controller for bounded coding
work. It runs one fresh legacy Goose or ACP worker at a time against a
caller-provided Git worktree, accepts work only through Git invariants and an
independent verifier, and records durable evidence outside that worktree.

It does not interpret model prose as success, run a daemon, manage a model
lifecycle, create a worktree, or sandbox tools. Supply a prepared local Git
worktree and a **new** external evidence directory for each run.

## Run a stage

The evidence path must not already exist. It receives the frozen inputs,
state transitions, attempt artifacts, and final summary.

```bash
bun src/cli.ts run \
  --repo /absolute/path/to/repository \
  --plan /absolute/path/to/plan.md \
  --stage 1 \
  --verifier /absolute/path/to/verify-stage.sh \
  --worker-recipe /absolute/path/to/worker.yaml \
  --evidence /absolute/path/to/new-evidence-directory
```

Legacy Goose is the default worker. It receives `repository_path`, `plan_path`,
`stage`, `attempt`, and `failure_report_path` parameters. Set `--goose PATH`
to select its executable. A repair receives the prior durable failure report;
the first attempt receives `/dev/null`.

Use ACP with an explicit stdio argv array:

```bash
bun src/cli.ts run \
  --repo /absolute/path/to/repository \
  --plan /absolute/path/to/plan.md \
  --stage 1 \
  --verifier /absolute/path/to/verify-stage.sh \
  --worker-kind acp \
  --acp-command '["/absolute/path/to/acp-agent", "serve"]' \
  --evidence /absolute/path/to/new-evidence-directory
```

Both modes accept `--max-attempts`, `--worker-timeout-seconds`,
`--no-tool-timeout-seconds`, `--no-tool-output-bytes`, and `--run-id`.
The verifier runs as `SAMOVAR_BENCH_REPO=<repo> <verifier> <stage>`.

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
bun src/cli.ts run ... \
  --verifier /absolute/path/to/verification/verify-stage.sh \
  --verifier-manifest /absolute/path/to/config/verifier-manifest.json
```

The controller freezes the resolved configuration, plan, worker recipe, worker
runtime profile, verifier entry, and declared verifier dependencies. It hashes
all frozen inputs and immutable attempt artifacts before status or resume work.
A changed frozen input, proof, or summary blocks recovery.

The runtime profile is captured automatically for each new run; it is not a
CLI option. `inputs/worker-profile.json` and the state profile fingerprint pin
the resolved Goose/ACP executable, full ACP argv, and identities of ACP argv
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
bun src/cli.ts status --evidence /absolute/path/to/evidence --json
bun src/cli.ts recover --evidence /absolute/path/to/evidence --json
```

`recover` without `--apply` is a preview. If a controller crashed, use the
explicit reclamation step only after reviewing the preview:

```bash
bun src/cli.ts recover --evidence /absolute/path/to/evidence --apply
bun src/cli.ts resume --evidence /absolute/path/to/evidence --json
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

Worker wall time and the no-tool output-growth watchdog are configurable. Legacy
worker logs are capped at 64 MiB per stream and incomplete lines at 1 MiB; an
overflow terminates the owned group. Verifier streams are capped at 8 MiB each;
an overflow is drained, recorded as a verifier failure, and only bounded output
is retained. The verifier wall-time limit is ten minutes. Failure reports keep
at most 24,000 characters of verifier output.
