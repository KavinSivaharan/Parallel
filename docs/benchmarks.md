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
