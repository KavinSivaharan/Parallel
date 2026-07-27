# Provider protocol

Adapters implement a capability-negotiated port. The runtime never imports provider SDK types.

Lifecycle:

1. `createExecution` binds a provider execution to a branch.
2. `start` yields normalized observations through an async stream.
3. `steer` accepts only approved steering with a runtime idempotency key.
4. `pause` requests immediate interruption and returns a provider cursor.
5. `resume` continues from the cursor or declares that a replacement execution is required.
6. `executeCommand` accepts an argument vector and returns after durable dispatch;
   stdout, stderr, files, diffs, and completion arrive as observations.
7. `checkpoint` and `restore` enqueue provider operations and confirm completion
   through ordered checkpoint observations.
8. `dispose` interrupts work, drains operations, and releases resources without
   deleting Parallel history.

Capabilities declare support for pause, resumable execution, checkpointing,
shell execution, filesystem artifacts, and tool approval. Unsupported
capabilities are visible product state, never silently emulated. The
`local-workspace` adapter implements the same port a Claude Code or Codex adapter
will use; it is runtime infrastructure, not a coding agent.
