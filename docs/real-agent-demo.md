# Real Codex collaboration demonstration

The fixture in `demo/fixtures/ledger-service` is an offline Python repository
with a real remainder-allocation defect. It has no generated edit script and no
network dependency.

## Run

1. Install and authenticate Codex using its standard `codex login` flow.
2. Start PostgreSQL and Redis and apply all migrations.
3. Run:

```bash
PARALLEL_RUN_CODEX_E2E=1 \
  pnpm --filter @parallel/api exec vitest run src/real-agent-demo.e2e.test.ts
```

Set `CODEX_EXECUTABLE` if Codex is not on `PATH`. The report is written to
`reports/real-agent-demo.latest.json`.

## Proved flow

The executable test creates Alice and Bob, one organization, one Codex session,
and two authenticated WebSocket clients. Alice starts a natural-language repair
task. Bob joins and proposes legacy request compatibility while the agent runs;
Alice approves it. Codex receives it at the next turn in the same thread. Alice
transfers control to Bob, who requests another test/documentation pass.

Bob checkpoints the passing workspace, forks it with a different objective, and
waits for an independent Codex execution to modify only the fork. Finally Bob
starts another turn and emergency-pauses it. The test reloads deterministic
replay, verifies Git commit identity and fork isolation, checks canonical tool,
terminal, file, diff, artifact, steering, control, and interruption events, and
writes timing and size measurements.

This test is intentionally opt-in: default CI has no dependency on Codex
software, network access, or paid credentials.
