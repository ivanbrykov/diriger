# OMP local ACP trial profile

**Qualification status (2026-09-15): not promoted to default.** A supervised coding
task, revised exact-retention test across two compactions, and cancellation passed.
Injected context-error recovery was inconsistent: one probe compacted/continued but
timed out, another returned `end_turn` with no compaction or result. Use explicitly
for bounded trials with independent verification; this is not a proven cure for all
Goose context failures.

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
