# OMP local ACP trial profile

**Deployment decision (2026-09-15): experimental default on inverno, explicitly
approved by the user.** Supervised coding, revised exact retention, cancellation,
and genuine provider-overflow recovery passed. A real172510-token request exceeded
the163840 limit; OMP compacted, retried and answered correctly. Earlier injected
error recovery was inconsistent; terminal error text plus `end_turn` remains a
known concern. Adoption accepts this uncertainty and retains independent checks.

The inverno machine launcher supplies OMP for new `diriger run` calls without
`--acp-command`; explicit workers are respected. Installed profile: `diriger-omp182`.
Its pinned argv and decision record are in
`/data/work/releases/diriger-config/20260915-omp/`. The repository CLI remains
harness-neutral and requires explicit `--acp-command`. Task launchers should export
`OMP_PROFILE=diriger-omp182` for new runs and their later resumes.

These files target **OMP 18.2.0** and the local `inverno-local/qwen3.8-27b` profile.
They are templates, not credentials or an installer. The example API key `local`
is a placeholder for a local endpoint. Adjust the endpoint/model/context only to
match your actual server. The server used for qualification exposes163840 tokens.

Use a fresh named profile, for example `diriger-omp`, and place models.yml and
config.yml in `~/.omp/profiles/diriger-omp/agent/`. Pass that same config file as an
explicit overlay. Set `OMP_PROFILE` in Diriger's environment so runtime profiling
pins the actual model/settings files; do not rely on an unrecorded profile name.
Keep the profile files unchanged during an active/frozen run.

Example ACP argv (replace the binary/config paths with your installed locations):

```json
[
  "/absolute/versioned/omp",
  "--system-prompt", "/absolute/diriger/prompts/omp-system.md",
  "--extension", "/absolute/diriger/examples/omp/diriger-system.mjs",
  "--profile", "diriger-omp",
  "acp",
  "--config", "/absolute/home/.omp/profiles/diriger-omp/agent/config.yml",
  "--model", "inverno-local/qwen3.8-27b",
  "--tools", "read,edit,write,bash",
  "--approval-mode", "yolo",
  "--no-extensions", "--no-skills", "--no-rules", "--no-lsp",
  "--no-pty", "--no-title", "--no-prewalk"
]
```

Supply this JSON to `diriger run --acp-command ...`, with `OMP_PROFILE=diriger-omp`.
Use a versioned binary rather than an opaque wrapper whose hidden dependencies
cannot be fingerprinted. Diriger freezes the actual executable, argv files, and
profile files for repair validation.

The profile limits tools to native file/shell tools and disables discovery sources,
model promotion/fallback, advisors and learned extensions. A named profile alone
does not suppress project configuration discovery. The complete disabledProviders
array and explicit settings overlay are intentional. `yolo` permits the explicitly
authorized worker to use its own native tools; Diriger still advertises no client
filesystem/terminal capabilities and rejects unexpected client requests.

Only ordinary `soft` text compaction is selected. Bitmap/remote compaction and
automatic model switching are excluded from this profile. The65536-token threshold with20000 recent tokens and32768 reserved tokens
is the revised qualification profile, not an optimal performance setting. The
initial24576/8192 profile failed an exact fact-retention stress test.
Before increasing it, test repeated compaction and provider-overflow recovery with
the actual model. 8192 output tokens proved insufficient for the initial coding
probe; the revised32768 cap completed the task with the same model/server allocation.
Neither cap is a recommendation to enlarge the server context.

Keep existing report, verifier, Git, timeout, tool-call and process-cleanup gates.
A completed ACP prompt or compaction notification alone is not task acceptance.
Older runs keep their frozen worker profile; do not resume a Goose run under OMP.

Qualification evidence lives in the durable gig artifacts, including initial
failures and exact profile versions. Do not infer production readiness just from
these template files or from a successful handshake.

## Diriger-owned worker instructions

Use the bundled `prompts/omp-system.md` and explicit `diriger-system.mjs` extension.
`--system-prompt` alone replaces OMP's main instruction template but retains a
project footer with its own completion rules. The supported `before_agent_start`
hook replaces the worker-turn system blocks with the exact prompt file. Tool
schemas remain supplied by OMP; its independent compaction prompts are unchanged.
Keep both paths explicit in argv so Diriger fingerprints both dependencies.
`--no-extensions` continues to disable discovery while the named extension is
loaded explicitly. No OMP fork is required.

The prompt respects task investigation budgets, supported BLOCKED outcomes,
project conventions, verification and honest gap reporting. It does not enforce
elapsed-time progress by itself. See [between-attempt evaluation](../progress-evaluator/README.md)
for the separate deterministic retry gate and its limits. Qualification must check
the actual wire system prompt and its persistence through compaction, not merely
that OMP accepted the command-line flags.
