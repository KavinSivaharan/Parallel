# ADR 0010: Versioned and validated provider capability negotiation

Status: accepted

## Context

Agent providers differ in steering, process control, reconnect, tool visibility,
usage, workspace ownership, and checkpoint semantics. A boolean such as
`supportsSteering` cannot distinguish immediate interactive input from a
continuation after the current turn.

## Decision

Every adapter publishes a strict capability document with
`schemaVersion: 1`. The provider SDK validates it with Zod at adapter
construction. Multi-mode features use explicit enums, including `steering`,
`pause`, `resume`, `reconnect`, `checkpointAwareness`, `toolCallVisibility`,
and `workspaceOwnership`.

The authenticated provider catalog returns metadata, capabilities, and a fresh
readiness diagnostic. UI controls derive availability and explanatory copy from
the declaration. The reusable certification harness checks capability schema
honesty and skips unsupported behavior rather than recording false failures or
passes.

## Consequences

Provider differences are product state. Adding capability fields requires a new
schema version and compatibility policy. A declaration still cannot prove
behavior by itself, so certification reports remain necessary.
