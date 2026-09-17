# OMP default on inverno

**User-approved experimental default, 2026-09-15.** The user explicitly accepted
remaining uncertainty and requested deployment before rerunning the failed task.
This supersedes the earlier default-promotion hold. Retain Diriger's report,
Git/verifier, time/tool and cleanup gates; experimental adoption does not imply
all failure modes are resolved.

The installed `/home/ivan/.local/bin/diriger` is the pinned release launcher. The
version-2 manifest is the only run configuration, so the pinned OMP argv below
belongs in the manifest's `worker.command` array; there is no launcher-supplied
`--acp-command` default. Export `OMP_PROFILE=diriger-omp182` in task launchers and
preserve it for subsequent resumes. Status/recover/resume do not use the worker
command. Rerunning a failed Goose task under OMP means a **new run/evidence
directory**, preserving old evidence and reviewing partial changes before preparing
the new baseline. Do not restart the old Pueue command (it still selects Goose) or
change its frozen worker in place.

Decision/pinned argv layer: `/data/work/releases/diriger-config/20260917-manifest/`.
Canonical `worker.command`: `acp-command.json`; canonical `evaluator.command`:
`evaluator-command.json` in that directory. Copy those arrays into the run
manifest; the launcher does not supply them.
Previous launcher: `/home/ivan/.local/bin/diriger.before-omp-default-20260915`.

Installed binary: `/data/work/releases/omp/18.2.0/omp`.
Named profile: `diriger-omp182`.
Profile files: `/home/ivan/.omp/profiles/diriger-omp182/agent/`.
Set `OMP_PROFILE=diriger-omp182` in the remote Diriger launcher so its profile
fingerprint covers these exact files. The binary is standalone; do not maintain a
fork or migrate its runtime just because it uses Bun.

ACP argv:

```json
["/data/work/releases/omp/18.2.0/omp", "--system-prompt", "/data/work/releases/diriger/4d5bed0ca3de8321ff7135bbbeed2344dc8262e3/prompts/omp-system.md", "--extension", "/data/work/releases/diriger/4d5bed0ca3de8321ff7135bbbeed2344dc8262e3/examples/omp/diriger-system.mjs","--profile","diriger-omp182","acp","--config","/home/ivan/.omp/profiles/diriger-omp182/agent/config.yml","--model","inverno-local/qwen3.8-27b","--tools","read,edit,write,bash","--approval-mode","yolo","--no-extensions","--no-skills","--no-rules","--no-lsp","--no-pty","--no-title","--no-prewalk"]
```

Use this array as the manifest's `worker.command` with normal task inputs; use the
shared serial Pueue group. The canonical machine copy is
`/data/work/releases/diriger-config/20260917-manifest/acp-command.json`. A bare
`omp acp` without `--system-prompt`/`--extension` reverts to stock OMP guidance
and is not the approved worker. Native server remains127.0.0.1:8080, model context163840,
maxTokens32768. Soft text compaction only; threshold65536, keepRecent20000,
reserve32768. No model promotion/fallback, subagents, or inherited configuration
providers. Do not mutate profile files during an active/frozen run. Read the target
repository's instructions explicitly; automatic rule discovery is disabled.

Evidence:
- Genuine native context rejection recovered successfully:172510>163840 tokens,
  persisted soft compaction, same-model retry at25414 prompt tokens, exact answer
  in4m50s. Isolated test deliberately overstated client capacity to196608; deployed
  profile correctly uses163840. Earlier injected-error failure was not reproduced.
- Real coding task accepted a clean commit with structured report and independent
  18-case verifier; two soft compactions occurred under the earlier24576 threshold.
- Revised65536/20000 profile retained all8 exact markers and an early anchor across
  two compactions. Initial24576/8192 stress profile invented six markers; retained
  as a failed case, not hidden by the revised test.
- Cancellation returned cancelled and prevented an already-started tool's delayed
  write; model and owned processes were idle afterward.
- Injected context error recovery was inconsistent. One probe compacted/continued
  but its long task timed out. A focused probe returned error text plus end_turn,
  no compaction/continuation/result. A normal ACP/Pueue completion is therefore not
  proof of successful work. The injections used a handcrafted HTTP400 envelope, not proof that the real
  server context was exceeded; genuine server response fields differed.
- Diriger now labels ACP max_tokens as generation-limit, preserving failure and
  cleanup; it does not silently accept incomplete output.

Full report and issue draft (not posted):
`/mnt/data/projects/goose-supervisor/gigs/2026-08-22-goose-supervisor-normal-session-telemetry/artifacts/2026-09-15-omp-qualification/`.
Raw remote evidence: `/data/work/experiments/omp-qualification-20260915/`.
Do not treat this trial as qualification of arbitrary OMP features or another model.

Genuine-rejection evidence: `artifacts/2026-09-15-omp-real-overflow/RESULTS.md` in the same local gig. Deployment decision: `artifacts/2026-09-15-omp-deployment/DECISION.md`.

## Owned worker guidance and assessment (2026-09-15)

The deployed engine is122265f. New default runs use Diriger's versioned
`prompts/omp-system.md` plus explicit `examples/omp/diriger-system.mjs` hook.
The hook sets the complete worker-turn system prompt; --system-prompt alone
retains an OMP footer. Discovery stays disabled; tool schemas and OMP compaction
remain. Both files are explicit argv dependencies and fingerprinted. Exact prompt
persistence and early-fact retention through real compaction passed.

The manifest may also carry an optional `evaluator` object for the **between-attempt**
Qwen assessment. It runs after failed worker/verifier cleanup, before spending a
remaining attempt; never alongside the worker. The local adapter command goes in
`evaluator.command` (with optional `evaluator.timeoutSeconds`, default 120); the
canonical machine copy is
`/data/work/releases/diriger-config/20260917-manifest/evaluator-command.json`.
Its Node runtime is the asdf-installed Node 24 at
`/home/ivan/.asdf/installs/nodejs/24.18.0/bin/node`; reference that versioned
binary directly, never the `~/.asdf/shims/node` shim (the shim needs `asdf` on
`PATH`). Do not point it at a per-experiment `tooling/node` copy or at
`/data/work/paseo-tooling/node` (Node 22, too old for the adapter).
Omitting
`evaluator` disables the gate for that run. It receives bounded tool/Git/verifier
evidence, no worker reasoning transcript, and has no model tools. A supported new
approach is required to retry. Missing/repeated hypothesis, malformed output,
evaluator failure, or infrastructure verdict stops for review. Reports/Git/verifier
still decide acceptance. Do not treat an evaluator's proposal as authorization to
restart a terminal/exhausted run.

The user explicitly chose same-Qwen assessment between attempts. **Periodic
mid-attempt evaluation is not implemented/enabled.** An unproductive first attempt
still has its existing wall/tool limits. Do not claim these changes enforce the
prompt's investigation budget by elapsed-time monitoring.

New launch config and implementation record:
`/data/work/releases/diriger-config/20260915-owned-prompt/`.
Rollback launcher: `/home/ivan/.local/bin/diriger.before-owned-prompt-20260915`.
Old frozen runs keep their original prompt/harness/evaluator settings.
