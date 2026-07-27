# Provider protocol

Adapters implement a capability-negotiated port. Provider-specific types never
enter the collaboration domain or workspace runtime.

Lifecycle:

1. `createExecution` binds a provider execution to a branch.
2. `start` yields normalized observations through an async stream.
3. `steer` accepts only approved steering with a runtime idempotency key and
   returns an accepted, queued, or rejected receipt plus delivery model.
4. `pause` requests immediate interruption and returns a provider cursor.
5. `resume` continues from the cursor or declares that a replacement execution is required.
6. `executeCommand` accepts an argument vector and returns after durable dispatch;
   stdout, stderr, files, diffs, and completion arrive as observations.
7. `checkpoint` and `restore` enqueue provider operations and confirm completion
   through ordered checkpoint observations.
8. `cancel` terminates the active process and makes future steering invalid.
9. `dispose` interrupts work, drains operations, and releases resources without
   deleting Parallel history.

Capability schema v1 declares start, steering and input model, pause, resume,
cancel, persistent conversation, reconnect, checkpoint awareness, shell and
filesystem observation, artifacts, tool visibility, structured events, usage,
workspace ownership, and concurrency. The SDK validates the strict document.
Unsupported capabilities are visible product state, never silently emulated.

Codex declares continuation steering: approved instructions queue while a turn
runs and are delivered with `exec resume` under the same provider thread ID.
The `local-workspace` adapter remains runtime infrastructure, not a coding
agent.
