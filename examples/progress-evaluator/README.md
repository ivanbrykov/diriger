# Assessment between attempts

Diriger can run a fresh, tool-free model assessment after an unsuccessful attempt
and completed worker/verifier cleanup, before consuming another attempt. Add an
`evaluator` object to the run manifest:

```json
{
  "worker": { "command": ["/absolute/path/to/omp", "acp"] },
  "evaluator": {
    "command": ["/absolute/node", "/absolute/openai.mjs", "http://127.0.0.1:8080/v1", "qwen3.8-27b", "/absolute/progress-evaluator.md", "4096"],
    "timeoutSeconds": 120
  },
  "stages": [{ "id": "s1", "plan": "stages/s1.md", "verifier": "stages/s1.verify.sh" }]
}
```

Omitting `evaluator` disables the gate for that run.

The adapter uses Node 24 and has no dependencies. Its endpoint, model, prompt and
output cap are explicit argv. The supervisor fingerprints the executable and
file arguments, including the adapter and prompt. This adapter targets the unauthenticated local inverno endpoint. Authenticated
external services need a separately reviewed adapter and credential boundary;
workers with shell access share the operating-system user. Never put credentials
in argv.

The evaluator sees bounded tool-call inputs, actual Git status/diffstat, the last
independent verifier result when available, the caller's task brief, deterministic
failure reason, and prior retry hypotheses. It does not receive worker thoughts,
chat claims, or unrestricted repository/tool access. Tool data remains untrusted.
ACP logs without timestamps use explicit event sequence markers. Bounded command
summaries retain early and recent actions and repeat counts; truncated fields are
marked. Unknown tool schemas may yield less evidence. No verifier result means
no independent validation, not a passing check.

A `progress` or `stuck` verdict permits another attempt only when it supplies a
concrete new hypothesis. The model must assess substantive novelty; the controller
also rejects whitespace/case-normalized duplicates. `stuck` with a distinct,
supported approach can seed a fresh attempt; it cannot revive the old attempt.
Missing hypotheses, malformed output, timeouts and evaluator failures block for
caller review. `escalate-infrastructure` stops without spending another worker
attempt. Evaluation never increases the configured attempt budget and is skipped
when no attempt remains, work is accepted, a worker has already reported a valid
blocker, or history/verifier/cleanup safety prevents retry.

Evidence and verdict are immutable attempt artifacts. The next failure report
includes the permitted approach. Evaluator processes use the same ownership guard
after worker cleanup. Controller-loss recovery cannot launch a fresh repair
without a durably recorded retry decision; an interrupted assessment remains
safety-blocked for review. Incomplete guard authorization/cleanup also retains the
existing ownership safety block rather than claiming clean completion.

**This is not the periodic progress evaluator.** It cannot interrupt an
unproductive first attempt early; the worker wall/tool limits still apply. The
user selected between-attempt Qwen evaluation because inverno has one inference
slot. Periodic evaluation is deferred until separate capacity or a qualified
pause/resume protocol exists.
