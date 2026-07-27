# ADR 0009: Codex CLI as the first real coding-agent provider

Status: accepted

## Context

Milestone 4 needs one genuine coding agent behind the provider-neutral boundary.
The development host has Codex CLI and Claude Code installed; OpenHands is not
installed. Codex exposes newline-delimited structured execution events, stable
thread IDs, non-interactive workspace execution, explicit cancellation through
its process, and `exec resume` for conversation continuation.

## Decision

Integrate Codex CLI as the only real agent provider in this milestone. Invoke it
through `@parallel/codex-provider` with `exec --json`, ignore host rules and user
configuration, bind its working directory to a Parallel-owned workspace, and
continue a thread with `exec resume <thread-id>`.

Keep the simulator and local workspace infrastructure provider. They are test
and runtime infrastructure, not additional real coding-agent integrations.

Claude Code was rejected for this milestone because the preferred provider
already exposed the structured process protocol and persistent continuation
identity required by the product proof. OpenHands was rejected because it was
unavailable locally and would add deployment surface unrelated to proving the
adapter boundary.

## Consequences

Parallel gets structured tool, output, lifecycle, and usage observations without
parsing terminal decoration. Codex-specific flags and JSON shapes remain inside
one package. The selected CLI build is alpha software, and its current interface
does not expose safe mid-turn instruction injection or process reattachment
after an API-host crash. Those limitations are capabilities, not hidden adapter
emulation.
