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

It owns exactly one layer. Not a content guardrail (use `guardrails-ai` for toxicity / PII / schema). Not a sandbox (Docker / gVisor for containment). Not authn (caller's concern — see [Identity and the gate](docs/02-features/identity-and-the-gate.md)). The five-layer split: system prompt → guardrails-ai → **bareguard** → sandbox → OS perms.

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
| **budget** | Tokens + cost USD, **halt severity** (escalates to human). Shared across processes via `proper-lockfile`. |
| **limits** | `maxTurns` (halt), `maxToolRounds` (halt), `maxChildren` / `maxDepth` (action), `timeoutSeconds` (halt). |
| **tools** | Tool-name `allowlist` / `denylist` (glob-matched) + per-tool `denyArgPatterns`. Allowlist is **scope-only** — does not silence asks. |
| **content** | Pattern matches over the serialized action. Universal `denyPatterns` + `askPatterns`. **Safe defaults shipped.** |
| **flags** | Gates on a **structured field's value** read directly off the action (`provenance`, `injectionRisk`), not a regex over the serialized form: `flags: { provenance: { web: "ask" }, injectionRisk: { high: "deny" } }`. Deny/ask only, both **before** the allowlist (floor supremacy). Lets a memory adopter pass a structured verdict without encoding it as text. |
| **secrets** | Redacts known env-var values + cred patterns. When configured, the gate auto-redacts `action` / `result` / `reason` on every audit line (eval still sees the real action). Tags with name (`[REDACTED:ANTHROPIC_API_KEY]`). |
| **audit** | One JSONL file per family. Phases: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`. |
| **approval** | Routes ask / halt events to the runner-supplied `humanChannel` callback. |
| **defer-rate** | Caps `defer` actions per minute (default 15). Counted from the audit log; per-family. |
| **spawn-rate** | Caps `spawn` actions per minute (default 10). Composes with `maxChildren` / `maxDepth`. |

**Safe defaults** ship in `content`: `rm -rf /`, `DROP TABLE`, `TRUNCATE` denied outright; destructive verbs (`delete`, `revoke`, `force-push`, destructive HTTP methods) escalate to the human. Override with empty arrays for pure-allow.

140 tests pass on the CI matrix: **Linux + macOS + Windows × Node 20 + 22** — including real-subprocess shared-budget contention, halt cascades, single-file audit atomicity, and `parent_run_id` / `spawn_depth` stitching across a 3-deep tree.

## Docs

| | |
|---|---|
| **[Integration Guide](bareguard.context.md)** | LLM-optimized wiring — hand it to your AI assistant. |
| **[Usage Guide](docs/02-features/usage-guide.md)** | Eval order, common gotchas, and 8 deployment recipes. |
| **[Harness cookbook](docs/02-features/harness-cookbook.md)** | Vetted capability bundles — tighten-only presets over one floor. |
| **[PRD](docs/01-product/bareguard-prd.md)** | Unified design spec + future-feature candidates. |
| **[Identity and the gate](docs/02-features/identity-and-the-gate.md)** | Why auth is upstream; per-principal policy via `_ctx`. |
| **[NO-GO list](docs/04-process/non-roadmap.md)** | What bareguard deliberately won't do. |
| **[Decisions log](docs/04-process/decisions-log.md)** · **[CHANGELOG](CHANGELOG.md)** | Design calls and release history. |

## The bare ecosystem

Four vanilla JS modules. Zero deps where possible (bareguard has one). Same API patterns.

| | [**bareagent**](https://npmjs.com/package/bare-agent) | [**barebrowse**](https://npmjs.com/package/barebrowse) | [**baremobile**](https://npmjs.com/package/baremobile) | [**bareguard**](https://npmjs.com/package/bareguard) |
|---|---|---|---|---|
| **Does** | Gives agents a think→act loop | Gives agents a real browser | Gives agents Android + iOS devices | Gates everything an agent does |
| **How** | Goal in → coordinated actions out | URL in → pruned snapshot out | Screen in → pruned snapshot out | Action in → allow / deny / human-asked out |
| **Replaces** | LangChain, CrewAI, AutoGen | Playwright, Selenium, Puppeteer | Appium, Espresso, XCUITest | Hand-rolled allowlists, scattered policy |
| **Interfaces** | Library · CLI · subprocess | Library · CLI · MCP | Library · CLI · MCP | Library |
| **Solo or together** | Orchestrates the others as tools | Works standalone | Works standalone | Embedded in bareagent's loop; usable by any runner |

> **Reach 50+ messengers with one Docker container via [beeperbox](https://github.com/hamr0/beeperbox)** — a headless Beeper Desktop that exposes WhatsApp, iMessage, Signal, Telegram, Slack, Discord, RCS, SMS and more as a single MCP server. Wire it through bareagent's MCP bridge; bareguard policies the invocations like any other tool.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
