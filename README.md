```
  ┌──────────────────────┐
  │   action ─────┐      │
  │               ▼      │
  │  ╭─────────────╮     │
  │  │   ▓ gate ▓  │     │
  │  ╰─────────────╯     │
  │   ╱     │     ╲      │
  │  ✓     ?     ✗       │
  │ allow  ask  deny     │
  └──────────────────────┘

  bareguard
```

> One chokepoint between your agent and the world. Bounds what the agent **does**, not what it **says**.
> Single audit log. Hard caps that halt with a human in the loop. ~1,000 lines, one production dep.

<p align="center">
  <a href="https://github.com/hamr0/bareguard/actions/workflows/ci.yml"><img src="https://github.com/hamr0/bareguard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/bareguard?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

---

## What this is

bareguard is a runtime policy library every agent action passes through. One `Gate` class, three call sites (`redact`, `check`, `record`), thirteen primitives — each a small file you can read in a sitting.

Same patterns as [bareagent](https://www.npmjs.com/package/bare-agent), [barebrowse](https://www.npmjs.com/package/barebrowse), and [baremobile](https://www.npmjs.com/package/baremobile) — embed it, don't run it. No daemon, no SaaS, no telemetry.

It owns exactly one layer. Not a content guardrail (use `guardrails-ai` for toxicity / PII / schema). Not a sandbox (Docker / gVisor for containment). Not authn (caller's concern — see [Identity and the gate](docs/00-context/harness-research.md#identity-and-the-gate) — Part III of the harness research). The five-layer split: system prompt → guardrails-ai → **bareguard** → sandbox → OS perms.

## Install

```
npm install bareguard
```

Requires Node.js >= 20. One production dep: `proper-lockfile`. Ships with TypeScript types (generated from JSDoc) — `import { Gate, type GateConfig } from "bareguard"` works out of the box, no `@types` package needed.

## Quick start

```js
import { Gate } from "bareguard";

const gate = new Gate({
  tools:  { allowlist: ["bash", "read", "write", "fetch"] },
  bash:   { allow: ["git", "ls"], denyPatterns: [/sudo/, /rm\s+-rf/] },
  fs:     { writeScope: ["/tmp/agent"], readScope: ["/tmp"], deny: ["~/.ssh"] },
  budget: { maxCostUsd: 5.00, maxTokens: 100_000 },
  limits: { maxTurns: 50 },
  humanChannel: async (event) => {
    // event.kind: "ask" | "halt" — your UX decides (TUI, Slack, web, PIN)
    return { decision: "allow" };  // or "deny" / "topup" / "terminate"
  },
});
await gate.init();

// In your agent loop:
const decision = await gate.check(action);   // audit auto-redacts if `secrets` is set
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);
  await gate.record(action, result);  // result.costUsd / result.tokens
}
// gate.check never returns "askHuman" — bareguard resolves that internally
// via humanChannel and gives you a terminal allow/deny.
```

**Wiring it into a real agent?** Hand your AI assistant the integration guide and describe what you want:

```
Read bareguard.context.md from node_modules/bareguard/bareguard.context.md,
then wire a Gate into my agent. Here's my setup: <describe loop, tools, budget>.
```

That file has the `humanChannel` patterns, shared-budget-across-processes setup, eval order, audit format, and 10 wiring recipes.

## The thirteen primitives

Every primitive is one file (~30–180 LOC). The gate evaluates them in a fixed order (`deny > ask > scope > default`, first match wins — see the [Usage Guide](docs/02-features/usage-guide.md#how-it-works)).

| Primitive | What it does |
|---|---|
| **bash** | Command allowlist + `denyPatterns` when `action.type === "bash"`. With `allow` set, shell metacharacters (`;` `\|` `&` `$` `` ` `` `()` `<>`) are denied — a prefix allowlist can't bound chaining. |
| **fs** | `writeScope` / `readScope` / `deny` for `read` / `write` / `edit`. Paths normalized (`.`/`..` collapsed) + segment-boundary matched — no traversal escapes. |
| **net** | Egress domain allowlist + private-IP deny for `fetch` (IPv4/IPv6, link-local incl. cloud metadata). `denyPrivateIps` matches the **literal host** — it doesn't resolve DNS, so it's defense-in-depth, not an SSRF boundary; use `allowDomains` (fail-closed) to bound egress. |
| **budget** | Tokens + cost USD, **halt severity** (escalates to human). Shared across processes via `proper-lockfile`. Also caps **arbitrary countable resources** — `resources: { writes: 100, rows: 10000 }`, accrued from `result.counts`, same cumulative halt (rule `budget.resource.<name>`); optional `softRatio` emits a non-blocking `budget_warn` before the cap. |
| **limits** | `maxTurns` (halt), `maxToolRounds` (halt), `maxChildren` / `maxDepth` (action), `timeoutSeconds` (halt). |
| **tools** | Tool-name `allowlist` / `denylist` (glob-matched) + per-tool `denyArgPatterns`. Allowlist is **scope-only** — does not silence asks. |
| **content** | Pattern matches over the serialized action. Universal `denyPatterns` + `askPatterns`. **Safe defaults shipped.** |
| **flags** | Gates on a **structured field's value** read directly off the action (`provenance`, `injectionRisk`), not a regex over the serialized form: `flags: { provenance: { web: "ask" }, injectionRisk: { high: "deny" } }`. Deny/ask only, both **before** the allowlist (floor supremacy). Lets a memory adopter pass a structured verdict without encoding it as text. |
| **secrets** | Redacts known env-var values + cred patterns. When configured, the gate auto-redacts `action` / `result` / `reason` on every audit line (eval still sees the real action). Tags with name (`[REDACTED:ANTHROPIC_API_KEY]`). |
| **audit** | One JSONL file per family. Phases: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`, `budget_warn`. Every line of one eval shares a correlation id (`aid`) so a request joins to its outcome even when two actions are identical. |
| **approval** | Routes ask / halt events to the runner-supplied `humanChannel` callback. |
| **defer-rate** | Caps `defer` actions per minute (default 15). Counted from the audit log; per-family. |
| **spawn-rate** | Caps `spawn` actions per minute (default 10). Composes with `maxChildren` / `maxDepth`. |

**Safe defaults** ship in `content`: `rm -rf /`, `DROP TABLE`, `TRUNCATE` denied outright; destructive verbs (`delete`, `revoke`, `force-push`, destructive HTTP methods) escalate to the human. Override with empty arrays for pure-allow.

177 tests pass on the CI matrix: **Linux + macOS + Windows × Node 20 + 22** — including real-subprocess shared-budget contention, halt cascades, single-file audit atomicity, and `parent_run_id` / `spawn_depth` stitching across a 3-deep tree.

## Axis B — return-time annotations (opt-in)

The primitives above gate the **action** (what the agent is about to *do*). `gate.annotate` is the complementary surface: it carries a return-time **fact** about whether a result **honored** the user's request, so a human approval shows independent facts, not the agent's spin. bareguard **never runs an LLM and never decides** — you compute the fact (a deterministic check, or your own caller-side judge); bareguard buffers it, audits it, and lets it **ride the next human ask**. It never blocks alone.

```js
const gate = new Gate({
  flags: { needsReview: { yes: "ask" } },
  axisB: { reversibleEscalation: "strict", reversible: ["recall", "search"] }, // operator declares undoable TYPES
  humanChannel: async (event) => {
    if (event.annotations) console.log("Heads up:", event.annotations); // facts ride the ask
    return { decision: "allow" };
  },
});
await gate.init();

// after a result comes back, your judge returns honored/broke:
await gate.annotate({ surface: true, verdict: "broke", where: "you said under €300; the booking is €400" });
await gate.check({ type: "book", needsReview: "yes" }); // the buffered fact rides this ask
const facts = gate.drainAnnotations(); // and/or feed them back to the agent
```

Reversibility is read from the **gated action's type** (your `axisB.reversible` list) — never the fact, the agent, or the model. The knob (`strict` default | `relaxed`) is pure noise control on the reversible path, never safety.

## Docs

| | |
|---|---|
| **[Integration Guide](bareguard.context.md)** | LLM-optimized wiring — hand it to your AI assistant. |
| **[Usage Guide](docs/02-features/usage-guide.md)** | Eval order, common gotchas, and 8 deployment recipes. |
| **[Harness cookbook](docs/02-features/harness-cookbook.md)** | Vetted capability bundles — tighten-only presets over one floor. |
| **[PRD](docs/01-product/bareguard-prd.md)** | Unified design spec + future-feature candidates. |
| **[Harness research](docs/00-context/harness-research.md)** | Problem space, the A2A intent-drift experiment, and identity/the gate (auth is upstream; per-principal policy via `_ctx`) — three merged. |
| **[NO-GO list](docs/04-process/non-roadmap.md)** | What bareguard deliberately won't do. |
| **[Decisions log](docs/04-process/decisions-log.md)** · **[CHANGELOG](CHANGELOG.md)** | Design calls and release history. |

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
