# Milestone 4 engineering report

## Provider selection

Parallel selected Codex CLI `0.146.0-alpha.3.1`. The installed CLI exposes
structured JSONL, stable thread IDs, explicit local process control, and
conversation continuation. Claude Code was installed but not integrated because
Codex satisfied the preferred-order requirements; OpenHands was unavailable.
Exactly one real coding-agent adapter was added.

## Adapter architecture

`@parallel/codex-provider` implements the existing `AgentProvider` port and owns
all invocation flags, authentication environment, parsing, thread mapping,
continuation queue, resource limits, cancellation, failure classification,
workspace inspection, and artifact production. The collaboration domain and
workspace runtime contain no Codex concepts.

Capability schema v1 is strict and validated. The authenticated provider
catalog returns sanitized readiness, metadata, and capability modes. A reusable
certification package produces machine-readable and Markdown results. The
simulator remains the deterministic collaboration provider.

## Demonstrated two-user flow

The opt-in executable demonstration created Alice and Bob, one organization,
two authenticated WebSocket clients, one Git workspace, and one Codex thread.
Codex inspected the ledger fixture, reproduced lost remainder cents, used real
shell tools, edited code, and ran tests.

Bob proposed legacy `account` compatibility while the first turn ran. Alice
approved it. Parallel recorded the instruction as pending, then delivered it
with `codex exec resume` in the same thread. Codex changed service behavior,
tests, and documentation. Alice transferred driver control to Bob, who directed
a third validation/documentation turn.

Bob created a checkpoint backed by Git commit
`fcad089ee394d1f2b08409de803a82657532648e`. He forked it with an alternative
objective; a new Codex execution modified an independent workspace without
changing the parent. Bob then started a deliberate validation turn and emergency
paused it. Process-group interruption reached the durable timeline in 272 ms.
Reloaded replay contained all 128 parent events and six artifacts.

## Steering semantics

Codex is a continuation provider. Approved instructions cannot alter a currently
running turn. They are queued, visibly pending, and delivered at the next valid
boundary to the same Codex thread. The measured approval-to-delivery interval
was 81,989 ms because it included the remainder of an 82-second real provider
turn. Duplicate command IDs are idempotent; steering after cancellation is
rejected.

## Security and credentials

Execution is local and trusted-development only. The adapter accepts only
Parallel-owned workspace paths, uses argument-vector spawning without a shell,
forwards an environment allowlist, redacts known secret forms, ignores host
rules and user configuration, caps instructions/events/output/artifacts/queue
length/duration, and cancels the process group with escalation.

Codex standard host authentication stays outside the browser, database, events,
artifacts, and repository. This boundary is not a sandbox and is unsuitable for
untrusted users or repositories.

## Durability and recovery

The orchestrator owns providers independently of WebSockets. It incrementally
persists canonical observations, last provider sequence, Codex thread ID,
process ownership, lifecycle, and timing before fan-out. Reconnect reads
committed events. Duplicate provider observations resolve by execution,
observation ID, sequence, and canonical causation.

On API startup, an abandoned active row is explicitly failed with
`provider.crashed`; a matching process is terminated when safely identifiable.
Committed history and workspace state remain. Parallel can later continue a
persisted Codex conversation, but does not reattach to a vanished in-flight
process.

## Certification and tests

- Codex: 19 applicable checks passed; see
  `docs/certification/codex.json`.
- Simulator: generated common-contract report at
  `docs/certification/simulator.json`; unsupported real workspace/process probes
  are truthfully skipped.
- Default tests cover capabilities, parsing, redaction, invocation, steering
  lifecycle matrix, duplicate callbacks and commands, workspace targeting,
  modifications, success, crash, malformed output, timeout, output/artifact
  limits, process interruption, API restart, replay, authorization, outbox,
  checkpoints, and forks.
- The real Codex flow passed twice after correcting a reporting assertion and
  percentile pairing bug. Default CI does not require Codex or credentials.

## Local performance observation

This is one Apple Silicon local run, not a universal claim:

| Measurement | Result |
| --- | ---: |
| Command accepted to provider process start | 180 ms |
| Time to first provider output | 5,242 ms |
| Provider event persistence | 14 ms |
| Durable event to WebSocket, median / p95 | 161 / 271 ms |
| Emergency cancellation | 272 ms |
| Replay reconstruction | 6 ms |
| Complete demo | 206,386 ms |
| Parent event count / bytes | 128 / 129,417 |
| Artifact count / bytes | 6 / 16,046 |

## Commits

1. `feat: add certified Codex provider adapter`
2. `feat: operate real providers through durable collaboration`
3. `docs: document real provider guarantees and demo`

## Remaining limitations

- No hardened isolation for untrusted execution.
- No active-process reattachment after host failure.
- Codex exposes aggregated command output, not a reliable stdout/stderr split.
- Continuation steering waits for a turn boundary.
- Workspace forks do not clone hidden provider state.
- Local provider readiness depends on a host-installed, authenticated CLI.

## Recommended Milestone 5

Build the hardened execution plane: an externally supervised container or
microVM backend with attachable event streams, resource and network policy,
scoped credentials, durable process leases, and multi-host scheduling. Preserve
the provider and workspace contracts so the collaboration product does not
change when process ownership leaves the API host.
