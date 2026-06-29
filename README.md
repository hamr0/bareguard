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

## What it is

One chokepoint between your agent and the world. Every action the agent takes — a shell command, a file write, a network call, a spend — passes through one `Gate` and comes back **allow**, **deny**, or **ask a human**. You get a hard floor under a probabilistic agent, and a single audit log of everything it tried.

That floor is **Axis A** of a [floor + harness](docs/01-product/bareguard-prd.md) model: you can't make a probabilistic agent deterministic, so you fence where the dice can do damage. **Axis B** (opt-in) is the complement — it reconciles what came *back* against what you asked for. Both are shown below.

Small on purpose: one `Gate`, three call sites (`redact` · `check` · `record`), thirteen primitives you can each read in a sitting. Embed it like the rest of the [bare suite](#the-bare-ecosystem) — no daemon, no SaaS, no telemetry.

**What it isn't** — bareguard owns one layer and is honest about the rest. It's not a content filter (toxicity / PII / schema → `guardrails-ai`), not a sandbox (containment → Docker / gVisor), and not auth (who the actor *is* → upstream; per-principal policy rides `action._ctx`). It decides the action; it never runs it. The deliberate non-goals are listed once in the [NO-GO list](docs/04-process/non-roadmap.md).

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
const decision = await gate.check(action);   // audit auto-redacts secrets (default-on)
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);
  await gate.record(action, result);  // result.costUsd / result.tokens
}
// gate.check never returns "askHuman" — bareguard resolves that internally
// via humanChannel and gives you a terminal allow/deny.
```

## The trio in one loop

The [Core](#the-bare-ecosystem) is three modules: **bareagent** drives the think→act loop, **litectx** supplies ranked context, and **bareguard** gates every action between them. A loop looks like:

```js
const ctx      = await memory.recall(goal);    // litectx   → ranked context
const action   = await agent.next(goal, ctx);  // bareagent → a proposed action
const decision = await gate.check(action);     // bareguard → allow / deny / ask-a-human
if (decision.outcome === "allow") await run(action);
```

And it gates on *meaning*, not text: when the agent writes a memory, litectx emits the fact's **source** and bareguard's `flags` primitive decides on that field directly — `flags: { provenance: { web: "ask" }, injectionRisk: { high: "deny" } }` — no brittle regex over a serialized blob.

**Wiring it into a real agent?** Hand your AI assistant the integration guide and describe what you want:

```
Read bareguard.context.md from node_modules/bareguard/bareguard.context.md,
then wire a Gate into my agent. Here's my setup: <describe loop, tools, budget>.
```

That file has the `humanChannel` patterns, shared-budget-across-processes setup, eval order, audit format, and 10 wiring recipes.

## The primitives

Thirteen small files — each ~30–180 lines. The gate runs them in a fixed order (**deny → ask → scope → default**, first match wins) and they compose into [harness bundles](docs/02-features/harness-cookbook.md): tighten-only capability presets an agent picks at runtime, never load-bearing for safety — pick the wrong one and the floor still holds. (In *code-mode*, the agent writes a code body over a typed tool menu and the gate stays in the parent process; the agent never holds a raw tool.)

- **Scope what runs** — `tools` is a closed allowlist (deny-by-default); `bash` / `fs` / `net` bound which commands, paths, and domains are even reachable.
- **Tier what's dangerous** — `bash.classify` ranks a command **safe → destructive → super-destructive** across Linux / macOS / Windows and routes the severity to your human channel; `content` ships safe defaults (`rm -rf /`, `DROP TABLE` denied outright; destructive verbs ask).
- **Bound what accumulates** — `budget` caps spend, tokens, *or any countable resource*, and `limits` caps turns / children / depth — both **halt with a human in the loop**, not silently, and the cap is shared across processes.
- **Gate on meaning, not text** — `flags` reads a structured field's value (a memory engine's `provenance` / `injectionRisk`) straight off the action, no regex; the same channel can also confirm before *every* call of a tool.
- **Prove what happened** — `secrets` auto-redacts every audit line **by default** (API keys / `Bearer …` tokens never hit disk, even with no config), and one `audit` JSONL joins each request to its outcome and its approval, even when two actions look identical.

Full per-primitive reference lives in the **[Usage Guide](docs/02-features/usage-guide.md)** and **[Integration Guide](bareguard.context.md)** — not here.

Tested across **Linux + macOS + Windows × Node 20 + 22**: real-subprocess shared-budget contention, halt cascades, single-file audit atomicity, and family-tree stitching across a 3-deep spawn tree.

## Axis B — reconcile the return (facts, never spin)

Axis A (everything above) gates what the agent is about to *do*. **Axis B** is the complement: after a result comes back, it carries a **fact** about whether that result *honored* the request, so a human approval shows independent facts instead of the agent's own summary. It's a detector, never an enforcer — it annotates an Axis-A stop, it never blocks alone.

The line bareguard holds is **facts, not judgments**. A *fact* is something you computed deterministically — a membership test, a number comparison (`booking €400 > your €300 cap`; `this memory is agent-authored, you asked for human-only`). bareguard carries facts; it **never runs an LLM and never decides**. A soft "this feels off-topic" is a *non-fact* — a judgment — and stays on your side of the line, because a model's guess must never auto-pass or auto-block an action.

```js
// you compute the fact (a deterministic check); bareguard buffers it and rides the next ask
await gate.annotate({ surface: true, verdict: "broke", where: "you said under €300; the booking is €400" });
await gate.check({ type: "book", needsReview: "yes" }); // the fact surfaces as event.annotations
const facts = gate.drainAnnotations();                  // and/or feed them back to the agent
```

You declare undoable action types via `axisB: { reversible: [...] }`; reversibility is read from the **gated action's type**, never the fact, the agent, or the model. The knob (`strict` default | `relaxed`) is pure noise control on the reversible path, never safety.

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
