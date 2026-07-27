# Provider SDK migration guide

## From the internal contract

The canonical contract remains source-compatible at
`@parallel/provider-sdk`. Adapter authors should now:

1. import certification from `@parallel/provider-sdk/certification`;
2. use `BufferedProviderExecution` instead of maintaining a private async queue;
3. use normalization helpers before emitting provider-controlled content;
4. expose strict capability schema v1 and sanitized readiness; and
5. keep provider construction outside the orchestrator.

`@parallel/provider-certification` remains a compatibility re-export for
existing code but is no longer the owning package.

## From an embedded adapter to generic protocol

Move provider credentials and upstream calls into an independently deployed
service. Map the old adapter's metadata and capabilities into the discovery
manifest, creation into `POST /executions`, observations into cursor batches,
and lifecycle methods into the command endpoint. Preserve execution IDs,
provider event IDs, and command idempotency keys during the move.

Register the endpoint and manifest through `PARALLEL_GENERIC_PROVIDERS`; no
Parallel source change is needed. Run the same certification harness against
the generic adapter before switching sessions.

## Versioning

Adapter versions follow semantic versioning. Provider versions identify the
upstream CLI or API. Capability schema and generic protocol versions are
independent integers. An incompatible lifecycle or event change requires a new
protocol version; adding a provider-specific upstream version does not.
