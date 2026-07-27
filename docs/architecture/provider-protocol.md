# Provider protocol

Adapters implement a capability-negotiated port. The runtime never imports provider SDK types.

Lifecycle:

1. `createExecution` binds a provider execution to a branch.
2. `start` yields normalized observations through an async stream.
3. `steer` accepts only approved steering with a runtime idempotency key.
4. `pause` requests immediate interruption and returns a provider cursor.
5. `resume` continues from the cursor or declares that a replacement execution is required.
6. `checkpoint` returns opaque provider state safe for a later fork.
7. `dispose` releases resources without deleting Parallel history.

Capabilities declare support for pause, resumable execution, checkpointing, filesystem artifacts, and tool approval. Unsupported capabilities are visible product state, never silently emulated.

