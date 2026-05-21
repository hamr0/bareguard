# bareguard documentation

bareguard is a runtime policy library every agent action passes through. One
`Gate`, twelve primitives, one audit log. This is the doc map; start with the
[root README](../README.md) for the overview and feature table.

## Map

| Doc | What's in it |
|---|---|
| [Integration Guide](../bareguard.context.md) | LLM-optimized wiring guide — give this to your AI assistant. Component selection, `humanChannel` patterns, API surface, 10 recipes. |
| [Usage Guide](02-features/usage-guide.md) | Human-facing companion — how the eval order works, the common foot-guns, and 8 deployment recipes (content screening, multi-tenant, halt routing, sticky approvals, log rotation). |
| [PRD](01-product/bareguard-prd.md) | Unified design spec — the twelve primitives, complete-mediation architecture, the 6-step eval order, audit/budget specs, migration plan + future-feature candidates (§19). |
| [Identity and the gate](identity-and-the-gate.md) | Where agent identity / auth sits relative to bareguard (upstream), and how to policy per-principal via `_ctx` without auth code in the gate. |
| [NO-GO list](non-roadmap.md) | What bareguard will deliberately never do, and why. Read before proposing a new primitive. |
| [Decisions log](decisions-log.md) | Design calls resolved across versions. |
| [CHANGELOG](../CHANGELOG.md) | Release-by-release diff. |

## Start here

1. **Using bareguard in an agent?** → hand the [Integration Guide](../bareguard.context.md) to your AI assistant, then skim the [Usage Guide](02-features/usage-guide.md) gotchas.
2. **Want the design rationale?** → [PRD](01-product/bareguard-prd.md).
3. **Asked "can bareguard do X?"** → check the [NO-GO list](non-roadmap.md) first — the answer is often "deliberately no, here's the recipe instead."
