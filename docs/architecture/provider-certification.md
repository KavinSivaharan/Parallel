# Provider certification contract

`@parallel/provider-certification` runs reusable behavioral checks and emits a
versioned JSON report plus Markdown rendering. All adapters are checked for:

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
