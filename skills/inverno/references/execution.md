# Current execution tools

Last checked 2026-09-15. Pueue 4.0.4 supplies a queue; Diriger supplies bounded
coding attempts and independent verification. These are replaceable tools.

## Pueue

```sh
pueue-inverno add --group diriger --label UNIQUE_TASK_LABEL --print-task-id \
  'cd /absolute/remote/task-directory && exec /bin/sh ./run.sh'
pueue-inverno status --json
pueue-inverno log JOB_ID
pueue-inverno follow JOB_ID
pueue-inverno wait JOB_ID
```

Create `run.sh` and its inputs on inverno before submitting. Give each submission
(including recovery) a UUID, used in its label and immutable launcher path. Record
that UUID, the exact command/path and evidence directory in a local receipt before
submitting; add the returned queue ID afterward. Quote shell strings
correctly, or generate the submission argv with a language API and shell-quote
the embedded remote path. Keep logs bounded in the launcher for ordinary long
commands. Inspect command-specific `--help` for flags rather than guessing.

The `diriger` group has concurrency one. All model-backed work uses this group;
other groups are independent and do not share its limit. Do not bypass it with
`--immediate`. No automatic retry policy is configured. Choose a finite timeout
for ordinary command jobs as well as supervised work.

The wrapper starts at `/` because Pueue resolves `--working-directory` locally;
remote-only paths fail that check. Use `cd` inside the command. The wrapper
sends only LANG from a clean environment; the remote shell supplies HOME, USER,
LOGNAME, and PATH. Ambient local model/API settings are deliberately not forwarded.
Set required non-secret model settings in the remote task launcher. Actual secrets
must come from appropriate remote credential configuration, not command text.

Pueue JSON status is `tasks[ID].status`; examples in 4.0.4 are `Queued`, `Running`,
and `Done` objects with timestamps. Successful completion is
`status.Done.result == "Success"`. Avoid dumping the entire status object into
chat: it includes submitted commands and environments. Report selected fields.
A lost add response may still mean accepted submission; reconcile the unique label
and task/evidence paths before submitting again. Pueue labels are not uniqueness
constraints, and there is no end-to-end submission deduplication wrapper yet.
Match the UUID plus exact command/path, not the label alone. If the response was
lost and no match or multiple matches leave acceptance uncertain, report the
ambiguity and do not blindly retry. Apply the same rule to recovery submissions.

## Diriger coding jobs

Before queueing implementation, complete the caller readiness gate in
[decomposition.md](decomposition.md). Submit one ready stage with its concrete
brief and independent checks. Review its exact result before starting dependent
stages; ordinary whole-task authorization does not require asking again for each
stage. This workflow is caller-driven; Diriger does not schedule the stage graph.

Prepare a clean dedicated Git tree, a clear plan, and an executable independent
verifier outside the tree. Diriger requires a new descendant commit on the same
branch and a clean tree. The verifier must leave the exact HEAD/ref and tree
unchanged. It receives `SAMOVAR_BENCH_REPO` and the stage as its first argument.
Include all verifier dependencies with `--verifier-manifest` if it is not
self-contained; inspect the installed release README for that manifest schema.

Example remote launcher after replacing task paths and selecting finite limits:

```sh
#!/bin/sh
set -eu
export PATH=/home/ivan/.bun/bin:/home/ivan/.local/bin:/usr/local/bin:/usr/bin:/bin
export OMP_PROFILE=diriger-omp182
exec /home/ivan/.local/bin/diriger run \
  --repo /absolute/remote/worktree \
  --plan /absolute/remote/inputs/plan.md \
  --stage 1 \
  --verifier /absolute/remote/inputs/verify.sh \
  --max-attempts 2 --worker-timeout-seconds 1800 \
  --no-tool-timeout-seconds 90 --no-tool-output-bytes 262144 \
  --evidence /absolute/remote/new-evidence
```

The inverno launcher defaults new runs to OMP18.2.0 when `--acp-command` is
omitted; an explicit option overrides it. Direct repository CLI use still requires
that option. See [OMP configuration](omp.md). The bundled worker prompt
template is used unless `--prompt /absolute/path.md` overrides it (placeholders
like `{{ stage }}`; unknown tokens fail the run). Runaway control is
deterministic: `--max-tool-calls` (default 100) and `--max-tool-repetitions`
(default 8) bound the ACP session independent of the agent's own limits.

Those limits are explicit example defaults, not a requirement for every task.
In the 2026-09-08 watchdog correction and later releases, the ACP no-tool byte
budget counts decoded UTF-8 thought/message text, not JSON framing. It requires
both the configured tool-free duration and text-byte threshold; it is not an idle
timeout. Thought activity is recorded separately but does not reset that budget.
The hard wall timeout still bounds silence and ongoing generation. Earlier
releases can stop legitimate thought streams because token-sized framing inflates
the byte count; use the corrected installed release for new tasks.
Diriger is single-stage and does not create worktrees or manage the model server.
Preserve its evidence directory and the task launcher for recovery. The machine launcher is in a versioned configuration directory; inspect its
`exec` target to find the pinned engine source/README. The CLI has no `--help` option
in the installed version; running without arguments prints usage with exit 2.

## Structured worker outcome (release 533b348, 2026-09-10)

New CLI runs require a version-1 JSON worker report by default. The supervisor
provides the attempt-specific output path and schema in the ACP prompt or bundled
recipe. The report includes status complete/blocked, summary, knownGaps, decisions,
and validation; blocked also requires assumption, evidence, attempted approaches,
smallest alternative, and needed caller decision. Report generation is part of the
worker's normal completion, not a replacement for the independent verifier.

`task-blocked` (exit 4) stops automatic retries and remains terminal on resume.
A complete report with known gaps cannot receive automatic acceptance even with
green checks. Read the report in run.json/immutable attempt artifacts and return the
unresolved decision/gaps to the caller. Pueue may label this Failed(4); do not restart
it blindly. Ownership/recovery safety blockage remains exit 3. A crash with a pending
veto report and unproven completion safety-blocks for inspection instead of starting
a new worker. Missing/invalid required reports cannot be accepted.

Custom legacy recipes can explicitly select `--worker-report optional`; that retains
legacy acceptance without the report gate. Programmatic callers opt in through
workerReportRequired:true. Existing frozen runs keep their original policy.

## Between-attempt assessment

The inverno default launcher supplies a tool-free Qwen evaluator for new runs.
It runs after failed-attempt cleanup, only if another attempt remains; a concrete
new approach is required before retry. Its evidence/verdict are retained in attempt
artifacts, and the repair report carries the proposed approach. It cannot approve
work or bypass independent checks. Malformed/timeout/infrastructure outcomes stop
for review without starting another worker. No periodic mid-attempt evaluation is
enabled; the first attempt still relies on existing wall/tool limits.

An interrupted assessment without durable retry permission remains safety-blocked
on resume. Do not bypass this by changing frozen config or starting an unapproved
fresh run. Direct engine use is opt-in via --progress-evaluator-command JSON_ARGV;
normal machine launch supplies the local adapter automatically. Explicit command
overrides are respected.

## Monitoring and recovery

Run these on inverno, addressing the existing evidence:

```sh
diriger status --evidence /absolute/remote/evidence --json
diriger recover --evidence /absolute/remote/evidence --json
```

Read-only inspection need not enter the model queue. For a crashed run, review
recovery preview and ownership; use `recover --apply` only for this task's
reclaimable stale owner. Confirm the original queue job/controller is no longer
active and use Diriger's recorded ownership/cleanup checks to establish that no
guarded writer remains; a queue terminal state alone is insufficient. Then enqueue `resume --evidence ... --json` through the
same serial group and frozen model environment. Existing task authorization
covers routine safe recovery within the original budget. Never delete locks to
force progress, kill another task, reset the worktree, or rerun `run` into a new
evidence directory just to reset attempts. Terminal failure is a reportable
outcome; expanding scope/budgets requires the user's direction.

Diriger exits: 0 accepted/ready/preview, 1 terminal failure, 2 invalid input/state,
3 active or safety-blocked, 4 task-blocked. An accepted resume reuses proof; other resumes can verify
or consume a remaining repair attempt. Pueue's generic `restart` is not Diriger
recovery. A queue failure may mean blocked ownership rather than failed code.

For cancellation, target only the requested job. Supervised workers use detached
guards/process groups, so a queue kill alone is not proof all writers are gone.
Inspect the recorded run's cleanup/ownership before reuse. Do not restart the
whole queue daemon to cancel a task.

## Qualification boundary

OMP18.2.0 is the user-approved experimental default (2026-09-15). Supervised
coding through Pueue, revised exact retention, native ACP cancellation and genuine
provider context-error recovery passed. These checks do not establish arbitrary
workload reliability or guarded cancellation through every queue path. Retain
exact-commit verification and cleanup evidence. The caller still stages, submits,
monitors and retrieves results; there is no autonomous handoff API.
