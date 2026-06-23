# bareguard documentation

bareguard is a runtime policy library every agent action passes through. One
`Gate`, thirteen primitives, one audit log. This is the doc map; start with the
[root README](../README.md) for the overview and feature table.

## Map

| Doc | What's in it |
|---|---|
| [Integration Guide](../bareguard.context.md) | LLM-optimized wiring guide — give this to your AI assistant. Component selection, `humanChannel` patterns, API surface, 10 recipes. |
| [Usage Guide](02-features/usage-guide.md) | Human-facing companion — how the eval order works, the common foot-guns, and 8 deployment recipes (content screening, multi-tenant, halt routing, sticky approvals, log rotation). |
| [Harness cookbook](02-features/harness-cookbook.md) | Operator-vetted capability bundles (floor + catalog + fail-closed resolver, tighten-only). 8 samples: research, book-with-approval, comms-HITL, memory-adopter, code-mode-sandbox, repo-maintainer (ship-gate), delegation (spawn/defer), detect-and-feed-A (Axis B as recipe) + roll-your-own skeleton. |
| [PRD](01-product/bareguard-prd.md) | The single authority — **two parts**. **Part 1 (core):** the thirteen primitives, complete-mediation architecture, the 6-step eval order, audit/budget specs, release history + the 1.0 HOLD + future-feature candidates (§19). **Part 2 (the harness):** the floor+harness / Axis-A-B design (living) — §0.1 at-a-glance build state (Axis A built & released, Axis B (OQ1) deferred), POC gates E1–E6, the seam contract test, and the litectx integration bench. (The former `harness-prd.md` is folded in here as Part 2; `litectx`/`barecontext` PRDs moved to the litectx repo.) |
| [Harness research](00-context/harness-research.md) | Three merged research/context docs: **Part I** the agentic-web problem space (#1–#4 layering, egress gate, IETF/standards landscape); **Part II** the A2A intent-drift experiment (F7/F8, corrected thesis); **Part III** identity and the gate (auth is upstream — bareguard authorizes the *action*, not the *actor*; per-principal policy via `_ctx`). |
| [NO-GO list](04-process/non-roadmap.md) | What bareguard will deliberately never do, and why. Read before proposing a new primitive. |
| [Decisions log](04-process/decisions-log.md) | Design calls resolved across versions. |
| [CHANGELOG](../CHANGELOG.md) | Release-by-release diff. |

## Start here

1. **Using bareguard in an agent?** → hand the [Integration Guide](../bareguard.context.md) to your AI assistant, then skim the [Usage Guide](02-features/usage-guide.md) gotchas.
2. **Want the design rationale?** → [PRD](01-product/bareguard-prd.md).
3. **Asked "can bareguard do X?"** → check the [NO-GO list](04-process/non-roadmap.md) first — the answer is often "deliberately no, here's the recipe instead."
