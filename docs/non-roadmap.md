# bareguard — NO-GO list

Recorded so future contributors and future-you don't re-litigate. Each entry
was discussed during design and consciously excluded.

When users ask for these, point them here.

## Out of scope — content / model layer

| Out                                                  | Why                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Topic blocklists ("don't discuss politics")          | System prompt's job, or `guardrails-ai`. Content, not action.                    |
| Persona / tone constraints                           | System prompt.                                                                   |
| Output schema validation (JSON, Zod)                 | `guardrails-ai` already does this well. Or Zod, in the caller's code.            |
| Hallucination / factuality detection                 | Model-side problem. Hard. Not our fight.                                         |
| "Constitutional AI" rule sets                        | Training method, not a runtime library.                                          |
| PII / toxicity classifiers                           | `guardrails-ai` Hub has many of these. Don't reimplement.                        |
| ML-based action classifiers                          | Rules are explicit, auditable, deterministic. That's a feature.                  |

## Out of scope — service / deployment

| Out                                                  | Why                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Telemetry of any kind                                | Bare suite philosophy. No phone-home, ever.                                      |
| Hosted / SaaS version                                | Bare suite philosophy.                                                           |
| Long-running daemon mode                             | bareguard is a library, not a service. No `bareguard serve`.                     |
| Hosted policy distribution                           | No.                                                                              |
| Remote audit sinks (Datadog, S3, Loki)               | That's an adapter the caller writes. We produce JSONL; they pipe it.             |
| Dashboards / alerting / SIEM integration             | Downstream of the JSONL. Not core.                                               |
| Web UI for the audit log                             | JSONL is grep-able. UIs are downstream of the file.                              |
| Anomaly detection on audit log                       | Same — downstream.                                                               |
| Log rotation                                         | `logrotate` exists. README documents the pattern.                                |
| Hash-chain tamper-evidence                           | Opt-in flag in v0.x at earliest, or sibling library. Not v1 default.             |

## Out of scope — framework features

| Out                                                  | Why                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Plugin system / hooks framework                      | Composition is via importing primitives. No framework.                           |
| Config DSL or YAML schema                            | Plain object. If users want YAML, `js-yaml` is one line in their code.           |
| Multi-language SDK in v1                             | Node-first. Port later if there's pull.                                          |

## Out of scope — different layer

| Out                                                  | Why                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Sandboxing (Docker, gVisor, Firecracker)             | Different layer. bareguard prevents the call; sandboxing contains effects.       |
| Cross-machine distributed budget                     | Single-machine `proper-lockfile` is v1. Cross-machine = future sibling library.  |
| Identity / authn / authz                             | Caller's concern. bareguard sees actions, not principals.                        |
| **PIN / biometric / second-factor for approvals**    | Authentication is the runner's UX. bareguard says "ask the human"; how the      |
|                                                      | human is verified (PIN, button, Slack reaction) is the runner's choice.          |
| Rate limiting against external APIs                  | The API does this; or use a separate rate-limit library. Not bareguard's role.   |
| Built-in scheduler                                   | bareagent's `defer` tool emits records; cron / `wake.sh` / future `barejob` runs them. |
| Approval UX of any kind                              | `humanChannel` callback only. Caller wires it to TUI / Slack / web / PIN.        |
| MCP-specific parsing / awareness                     | bareguard glob-matches strings. The `mcp:server/tool` convention is a string.    |
| MCP server registry or aggregator                    | Different layer. bareguard doesn't connect to MCP servers; bareagent does.       |
| Per-user / per-tenant policy management              | Caller's concern. Pass a different `Gate` instance per config.                   |

## Out of scope — premature optimization

| Out                                                  | Why                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| LLM-self-estimate of remaining work at halt          | Speculative; costs tokens at the worst time; LLMs are bad self-estimators.       |
|                                                      | bareguard provides deterministic stats only. Runner may layer this if it wants.  |
| Concurrent gate.check (within one Gate instance)     | Agent loops are naturally serial. Documented contract is "one in flight."        |
| Allowlist as a "trust shortcut" silencing asks       | Was a foot-gun in practice. Allowlist is scope-only; askPatterns always fire.    |
| Stateful rate counter file (for defer / spawn rate)  | Audit log already has every `phase: "gate"` record with timestamp + `run_id`;   |
|                                                      | counting it is deterministic and correct across processes for free. One source   |
|                                                      | of truth — the audit log — for both spend and rate.                              |

## How to know if something belongs in bareguard

Before adding anything, all of these must be true:

1. Does it constrain an **action against the world** (or against a sibling
   process), not words the model produces?
2. Can it be expressed as a **rule over action shape**, not over action
   *content semantics*?
3. Does it work **without network, without infrastructure, without a server**?
4. Can it be implemented in **≤ 150 LOC** with at most the one allowed dep?
5. Is it **opt-in via config** with a sensible safe default?

Five yeses or it doesn't ship.

**Adding anything from this list dilutes the one thing this library does.**
