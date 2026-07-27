# Provider certification contract

`@parallel/provider-sdk/certification` runs reusable behavioral checks and
emits a versioned JSON report plus Markdown rendering.
`@parallel/provider-certification` is a compatibility re-export and owns the
repository-wide test matrix. All adapters are checked for:

- valid and honest capabilities;
- readiness shape;
- stable execution identity;
- startup and lifecycle ordering;
- steering receipt and duplicate-command behavior where supported;
- pause, resume, and cancellation where supported; and
- contiguous observation sequences.

Adapter-specific probes cover workspace targeting, stdout/stderr or equivalent
observable output, file modification, success and failure, callback replay,
malformed output, crash, and timeout. Missing probes are `skipped`, never
silently passed. The simulator runs in normal CI. Codex unit certification uses
a protocol fixture so CI needs no proprietary executable or credentials; the
real installed provider is exercised only by the explicit local demonstration.

The committed reports under `docs/certification` identify whether a result came
from deterministic protocol tests or a real local provider run.

```bash
pnpm --filter @parallel/provider-certification certify:providers
```

That command regenerates the common-contract reports and combined
`providers.json` for all five coding-agent providers. The real adapter classes
run against deterministic executable or HTTP transports. This validates
production normalization and lifecycle code without service credentials. Codex
also retains its broader provider-specific 19-check report.
