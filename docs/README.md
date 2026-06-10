# bareguard documentation

bareguard is a runtime policy library every agent action passes through. One
`Gate`, twelve primitives, one audit log. This is the doc map; start with the
[root README](../README.md) for the overview and feature table.

## Map

| Doc | What's in it |
|---|---|
| [Integration Guide](../bareguard.context.md) | LLM-optimized wiring guide — give this to your AI assistant. Component selection, `humanChannel` patterns, API surface, 10 recipes. |
| [Usage Guide](02-features/usage-guide.md) | Human-facing companion — how the eval order works, the common foot-guns, and 8 deployment recipes (content screening, multi-tenant, halt routing, sticky approvals, log rotation). |
| [Harness cookbook](02-features/harness-cookbook.md) | Operator-vetted capability bundles (floor + catalog + fail-closed resolver, tighten-only): read-only-research, book-with-approval, send-comms-HITL, memory-adopter, roll-your-own skeleton. |
| [PRD](01-product/bareguard-prd.md) | Unified design spec — the twelve primitives, complete-mediation architecture, the 6-step eval order, audit/budget specs, migration plan + future-feature candidates (§19). |
| [Harness PRD](01-product/harness-prd.md) | The floor+harness / Axis-A-B design (living). §0.1 = at-a-glance build state: Axis A built & released, Axis B (OQ1) deferred. POC gates E1–E5; gate-zero seam contract test (`test/seam-contract.test.js`). |
| [barecontext PRD](01-product/barecontext-prd.md) | SEED / NOT-NOW — the context-economy axis (future bare-suite sibling) and the bareguard↔barecontext sorting rule, parked so it never bloats the gate. |
| [litectx PRD](01-product/litectx-prd.md) | DRAFT — the lite code-aware memory engine (recall + impact) realizing the barecontext axis; bareguard's intended first external consumer. Graduates to its own repo. |
| [Identity and the gate](02-features/identity-and-the-gate.md) | Where agent identity / auth sits relative to bareguard (upstream), and how to policy per-principal via `_ctx` without auth code in the gate. |
| [NO-GO list](04-process/non-roadmap.md) | What bareguard will deliberately never do, and why. Read before proposing a new primitive. |
| [Decisions log](04-process/decisions-log.md) | Design calls resolved across versions. |
| [CHANGELOG](../CHANGELOG.md) | Release-by-release diff. |

## Start here

1. **Using bareguard in an agent?** → hand the [Integration Guide](../bareguard.context.md) to your AI assistant, then skim the [Usage Guide](02-features/usage-guide.md) gotchas.
2. **Want the design rationale?** → [PRD](01-product/bareguard-prd.md).
3. **Asked "can bareguard do X?"** → check the [NO-GO list](04-process/non-roadmap.md) first — the answer is often "deliberately no, here's the recipe instead."
