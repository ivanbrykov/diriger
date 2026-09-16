# Machine and access

Last checked 2026-09-07. These are operational coordinates, not a requirement to
keep the same tools or model forever. Verify relevant facts when resuming work.

- Host: `inverno`, SSH user `ivan`; Linux x86_64, RTX 3090 with 24 GB VRAM.
- From this box, SSH: `ssh -o BatchMode=yes -o ConnectTimeout=10 ivan@inverno`.
  SSH currently uses a session-unlocked agent. File staging may need that agent
  even when native queue access works. Do not inspect/export private keys.
- Remote policy: `/data/work/AGENTS.md`. Canonical repos: `/data/work/repos/`.
  Discover the target repository and follow its worktree/session conventions;
  do not turn the canonical checkout into the remote worker's scratch tree.
- Store new task artifacts in a task-specific directory on inverno local disk,
  for example under `/data/work/experiments/`. Record the chosen paths locally.
- Remote noninteractive PATH may omit user binaries. Known executables:
  `/home/ivan/.bun/bin/bun`, `/home/ivan/.local/bin/goose`,
  `/home/ivan/.local/bin/diriger`, `/home/ivan/.local/bin/pueue`.

## Queue access from this box

`/home/ubuntu/.local/bin/pueue-inverno` is a local native client wrapper. It talks
TLS over Tailscale to `100.106.204.124:6924`, without an SSH tunnel. Authentication
uses a pinned server certificate and shared secret in restricted files under
`/home/ubuntu/.config/pueue/inverno/`; config is
`/home/ubuntu/.config/pueue/inverno.yml`. Do not print these credentials or copy
them into task bundles, logs, or skill files.

```sh
/home/ubuntu/.local/bin/pueue-inverno status --json
```

On inverno, the user service is `pueued.service` (enabled; user linger enabled).
Its state/logs are in `/home/ivan/.local/share/pueue/`, config in
`/home/ivan/.config/pueue/pueue.yml`. Routine jobs should not restart this service.

## Model execution

The user-approved experimental default is OMP18.2.0 with profile
`diriger-omp182`, Qwen3.8-27b and native endpoint `http://127.0.0.1:8080/v1`.
See [OMP configuration](omp.md). Goose ACP1.46 remains installed for explicit
selection and old frozen runs. There is one inference slot; serialize model jobs
across projects and check both the queue and actual model activity before launch.

Do not change the model service, GPU settings, context/KV configuration, or
providers as part of an ordinary delegated task. Use the user's current selected
profile; if it differs from this reference, inspect the current machine/project
instructions rather than silently restoring these historical values.

## Transfer and return

Use Git's transport or `git bundle` to transfer an exact committed baseline and
return result commits. A bundle contains Git objects/refs, not dirty/untracked
files, submodule repositories, or external LFS content; stage any needed extras
explicitly. Do not include unrelated credentials or ignored machine state.
Use scp/rsync for separate task instructions/verifier files, not a live Git store.
Avoid shared mounts and bidirectional sync for active execution/evidence because
the qualified supervisor relies on local filesystem/process ownership semantics.

If the task depends on local uncommitted changes, record the selected patch and
untracked-file list with content hashes. Apply them only in an isolated staging
checkout and commit a task-input snapshot based on the original commit. Record
both the original SHA and snapshot SHA; use the clean snapshot as Diriger's
execution baseline. Preserve the user's local index/tree. Review returned worker
commits against that snapshot and integrate only the intended new changes, without
reapplying the user's input changes.

## Wrangler runtime finding (2026-09-09)

Default Bun on inverno is now1.4.2; Diriger's113 deterministic tests and typecheck
passed under it. Previous1.3.14 binary is preserved at
`/home/ivan/.bun/bin/bun.before-1.4.2`. Real model qualification predates this
runtime upgrade. Wrangler4.129.1 hosted by either Bun1.3.14 or1.4.2 reports Ready
but hangs on HTTP requests. The same minimal Worker and Windy candidate serve
correctly with Node22.23.2. For new work use pnpm and Node; existing Bun projects can keep their package
manager until migrated. Execute Wrangler under supported Node. `bunx --bun wrangler dev` forces the failing Bun path;
plain `bunx wrangler dev` honors the Node shebang when Node is available.
Node is not yet installed in the normal job PATH; a verified diagnostic copy
is at `/data/work/experiments/wrangler-diagnosis-20260909/node-v22.23.2-linux-x64/bin/node`.
A Ready log alone is insufficient: use a bounded HTTP response preflight.

## Tooling policy (2026-09-09)

New JS/TS projects, scaffolds and standalone tools use Node.js and pnpm. Use
`pnpm exec wrangler dev` with a supported Node runtime for new projects. Verify
Node/pnpm availability before launching a new task; this policy update does not
install them. Existing Diriger remains Bun-dependent until separately migrated.
