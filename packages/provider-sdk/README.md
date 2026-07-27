# Parallel Provider SDK

`@parallel/provider-sdk` is the stable provider boundary for making one coding
agent execution collaborative. It contains no collaboration-domain,
database, WebSocket, or UI dependencies.

## Public surface

- `AgentProvider` and `ProviderExecution`: lifecycle ports implemented by every
  adapter.
- capability schema v1: strict, versioned declarations used for negotiation.
- normalized observations: ordered status, output, tool, terminal, filesystem,
  diff, artifact, checkpoint, steering, usage, warning, and error facts.
- `BufferedProviderExecution`: an ordered async observation queue for adapter
  authors.
- normalization helpers: bounded text, errors, tool payloads, usage, and stable
  provider event keys.
- generic agent protocol v1: a transport-neutral HTTP contract for proprietary
  or internal agents.
- certification harness: capability-aware behavioral checks and
  machine-readable reports.
- `ExampleAgentProvider`: a complete in-process reference adapter, exported as
  `@parallel/provider-sdk/example`.

## Integration choices

First-party adapters can implement `AgentProvider` directly. External companies
should normally implement the generic HTTP protocol and register a manifest at
deployment time. That path does not require modifying or linking Parallel
application code and avoids loading untrusted plugins inside the control plane.

```ts
import {
  BufferedProviderExecution,
  defineCapabilities,
  type AgentProvider,
} from "@parallel/provider-sdk";
```

An adapter must keep one stable execution ID for a given branch and creation
idempotency key, emit monotonically ordered observations, make lifecycle
commands idempotent, and declare unsupported behavior as `none` or `false`.
Provider-specific session IDs may be persisted as opaque values but must never
enter collaboration-domain events as provider-specific types.

## Certification

```ts
import { certifyProvider } from "@parallel/provider-sdk/certification";

const report = await certifyProvider({
  provider,
  createRequest,
});
```

The report is JSON serializable. Unsupported checks are skipped and never
reported as passes. Run Parallel's complete adapter matrix with:

```bash
pnpm --filter @parallel/provider-certification certify:providers
```

See [adding a provider](../../docs/providers/adding-a-provider.md),
[lifecycle](../../docs/architecture/provider-lifecycle.md), and the
[migration guide](../../docs/providers/migration-guide.md).
