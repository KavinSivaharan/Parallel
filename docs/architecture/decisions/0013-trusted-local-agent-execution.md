# ADR 0013: Trusted local boundary for the first agent adapter

Status: accepted for development only

## Context

A real coding agent can run commands and modify files. A directory boundary and
provider `workspace-write` mode do not isolate the host kernel, network, CPU,
memory, or credentials available to the API user.

## Decision

Milestone 4 permits only trusted local repositories and users. The adapter:

- accepts workspaces only from `WorkspaceManager`, under the configured root;
- uses argument-vector spawning with no shell;
- forwards an explicit environment allowlist and never browser-supplied secrets;
- relies on the provider's standard host authentication without persisting it;
- redacts authorization, token, password, secret, and common API-key forms;
- enforces instruction, event, output, artifact, queue, and duration limits;
- kills the complete process group with TERM then KILL escalation; and
- starts Codex with approval disabled and workspace-write scope.

## Consequences

This is not a sandbox and must not run untrusted repositories or expose
development identity on the internet. The adapter depends on a workspace
contract so a future container or microVM backend can replace local execution
without changing collaboration or provider semantics. Hardened isolation is a
future milestone, not a documentation claim.
