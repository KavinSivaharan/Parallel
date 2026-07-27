# Provider compatibility matrix

The Generic row is the reference manifest shipped by Parallel. A configured
generic provider may declare a smaller truthful set.

| Provider | Steering | Interactive | Pause | Resume | Cancel | Reconnect | Checkpoints | Persistent | Tools | Usage |
| --- | --- | ---: | --- | --- | ---: | --- | --- | ---: | --- | ---: |
| Codex CLI | continuation | no | interrupt | continuation | yes | workspace | workspace | yes | structured | yes |
| Claude Code | continuation | no | interrupt | continuation | yes | workspace | workspace | yes | structured | yes |
| OpenHands CLI | continuation | no | interrupt | continuation | yes | workspace | workspace | yes | structured | no |
| Devin API v3 | interactive | yes | none | continuation | yes | cursor replay | none | yes | text only | no |
| Generic Agent SDK | interactive | yes | interrupt | same process | yes | cursor replay | native | yes | structured | yes |

## Certification results

| Provider | Result | Passed | Failed | Skipped | Evidence |
| --- | --- | ---: | ---: | ---: | --- |
| Codex CLI | passed | 19 | 0 | 0 | `docs/certification/codex.json` |
| Claude Code | passed | 11 | 0 | 9 | `docs/certification/claude-code.json` |
| OpenHands | passed | 11 | 0 | 9 | `docs/certification/openhands.json` |
| Devin | passed | 9 | 0 | 11 | `docs/certification/devin.json` |
| Generic Agent SDK | passed | 11 | 0 | 9 | `docs/certification/generic-agent.json` |

Skipped checks are either capabilities the provider declares unsupported or
optional provider-specific probes not supplied to the common harness. They do
not count as passes. Parser, invocation, transport, cancellation, and
normalization behavior is additionally covered by adapter unit tests. The
combined machine-readable matrix is `docs/certification/providers.json`.
Codex's common-harness report is `codex-sdk.json`; `codex.json` is its broader
19-check provider-specific report.

Readiness is deployment-specific and intentionally absent from this static
table. The live catalog reports installed versions, authentication, diagnostics,
and certification independently.
