# addypin v2 documentation

Location sharing, simplified. Drop a pin → get a short link and an
email address that both resolve to coordinates. No accounts, no
tracking.

## Structure

| Tier | Path | What lives here |
|------|------|-----------------|
| **Context** | [`00-context/`](00-context/) | Why we built it, current running state, constraints we committed to |
| **Product** | [`01-product/`](01-product/) | The spec — PRD, data model, threat model |
| **Features** | [`02-features/`](02-features/) | Per-feature specs (empty — PRD covers v2.0) |
| **Logs** | [`03-logs/`](03-logs/) | Decisions, deploy journals, incident notes |
| **Process** | [`04-process/`](04-process/) | How to work with the code (dev + deploy) |

## v1 archive

Original codebase lives on the `v1` branch. Reference only — don't
merge from it. Data is not migrated to v2 (deliberate clean-slate
cutover).

## Start here

1. **New to the project?** → [`00-context/vision.md`](00-context/vision.md)
   — what addypin is, who it's for, what it deliberately isn't.
2. **Need the technical spec?** → [`01-product/prd.md`](01-product/prd.md)
   — source of truth for scope, data model, endpoints, threat model.
3. **Deploying/operating?** → [`00-context/system-state.md`](00-context/system-state.md)
   — what's running right now. [`04-process/dev-workflow.md`](04-process/dev-workflow.md)
   — how to ship a change.
4. **Why did we do X?** → [`03-logs/decisions-log.md`](03-logs/decisions-log.md).
5. **What happened during cutover?** →
   [`03-logs/m10-deploy-log.md`](03-logs/m10-deploy-log.md).
