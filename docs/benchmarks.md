# Local workspace runtime benchmarks

Run:

```bash
pnpm --filter @parallel/workspace-runtime benchmark
```

The harness uses real temporary Git repositories, Node processes, filesystem
operations, commits, clones, and artifact writes. Results are wall-clock
latencies and include runtime event production and stream consumption.

## 2026-07-27 baseline

Environment: Apple Silicon macOS (`darwin-arm64`), Node.js 24.7.0. Values are
milliseconds. These are engineering baselines, not cross-platform service-level
objectives.

| Operation | Iterations | Median | p95 | Min | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Create empty Git workspace | 10 | 104.03 | 190.91 | 100.85 | 190.91 |
| Clean command round trip | 20 | 38.18 | 38.57 | 36.71 | 39.71 |
| Create commit-backed checkpoint | 10 | 116.84 | 122.36 | 114.99 | 122.36 |
| Fork workspace at checkpoint | 8 | 76.24 | 85.62 | 75.37 | 85.62 |
| Store versioned 4 KiB artifact | 20 | 0.34 | 0.53 | 0.31 | 1.33 |

Eight workspaces executing a real file-writing Node command concurrently
completed in 105.09 ms wall-clock.

Clone performance for remote repositories is intentionally not included because
network and repository size dominate the local runtime cost. CI should retain
the benchmark harness but should not use these machine-specific values as hard
pass/fail thresholds.

## Real Codex collaboration run

The opt-in ledger demonstration on the same Apple Silicon development host used
Codex CLI `0.146.0-alpha.3.1`. This is one local observation, not a provider or
service-level claim. The inspectable source is
`reports/real-agent-demo.latest.json`.

| Measurement | Result |
| --- | ---: |
| Accepted execution to provider process start | 180 ms |
| Accepted execution to first provider output | 5,242 ms |
| Steering approval to continuation delivery | 81,989 ms |
| Last observed provider event persistence | 14 ms |
| Durable event to WebSocket receipt, median / p95 | 161 / 271 ms |
| Emergency pause to provider interruption | 272 ms |
| Replay reconstruction | 6 ms |
| Complete two-user demo | 206,386 ms |
| Parent event count / encoded size | 128 / 129,417 bytes |
| Artifact count / total size | 6 / 16,046 bytes |

The steering latency is intentionally provider-dominated: approval occurred
during a turn and continuation delivery waited for that 82-second turn to end.
The 180 ms process-start measurement covers Parallel's durable outbox,
workspace binding, adapter dispatch, and spawn. WebSocket measurements start at
the durable event timestamp and therefore include outbox publication rather
than claiming pure socket transport time.
