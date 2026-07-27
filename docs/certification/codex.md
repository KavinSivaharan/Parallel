# OpenAI Codex CLI certification

Result: **19 passed, 0 failed, 0 skipped**

- Provider version: `codex-cli 0.146.0-alpha.3.1`
- Adapter version: `1.0.0`
- Capability schema: `1`

## Evidence

The adapter's deterministic protocol suite covers invocation, stable identity,
workspace targeting, continuation semantics at every lifecycle point, duplicate
messages and commands, malformed JSONL, redaction, non-zero exit, timeout,
output limits, and process-group interruption. Default CI runs these checks
without provider software or credentials.

The opt-in real-provider run adds evidence that Codex genuinely inspected the
offline ledger repository, executed shell tools and tests, modified multiple
files, consumed approved steering in the same thread, completed after a driver
handoff, created a real Git checkpoint, ran independently in a fork, and was
emergency-interrupted. It produced 128 contiguous parent events and six durable
artifacts. See the [machine-readable certification](codex.json) and
[`reports/real-agent-demo.latest.json`](../../reports/real-agent-demo.latest.json).

## Truthful limitations

- Steering is queued continuation, never claimed as mid-turn injection.
- Command output is aggregated by Codex, so Parallel does not invent stdout and
  stderr attribution.
- Reconnect restores durable Parallel history and workspace/conversation
  identity; it does not reattach a vanished active process.
- Workspace checkpoints and forks do not clone hidden provider state.
- The local process boundary is for trusted development only, not untrusted
  isolation.
