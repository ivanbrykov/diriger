# Goose Supervisor

A small deterministic controller for bounded coding work executed by fresh
Goose sessions.

The supervisor:

1. validates the repository, plan, recipe, and verifier;
2. launches a fresh Goose worker;
3. requires a new commit and clean worktree;
4. runs the verifier independently;
5. writes a bounded failure report and launches a fresh repair worker;
6. exits nonzero when attempts are exhausted.

It does not parse the worker's final response or use a model as the acceptance
authority.

```bash
bun src/cli.ts run \
  --repo /absolute/path/to/repository \
  --plan /absolute/path/to/plan.md \
  --stage 1 \
  --verifier /absolute/path/to/verify-stage.sh \
  --worker-recipe /absolute/path/to/worker.yaml \
  --evidence /absolute/path/to/evidence
```

The verifier is invoked as:

```text
SAMOVAR_BENCH_REPO=<repo> <verifier> <stage>
```

The current worker recipe accepts `repository_path`, `plan_path`, `stage`,
`attempt`, and `failure_report_path`.

