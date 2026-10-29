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

> One chokepoint between your agent and the world. Gates what the agent **does** — and whether its **work** is done — with deterministic checks only; it never runs an LLM.
> Single audit log. Hard caps that halt with a human in the loop. Small, one production dep.

<p align="center">
  <a href="https://github.com/hamr0/bareguard/actions/workflows/ci.yml"><img src="https://github.com/hamr0/bareguard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/bareguard?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

## What it is

**One gate, two jobs.**

**1. Gate the action** (Axis A) — every shell command, file write, network call, and spend passes through one `Gate` and comes back **allow**, **deny**, or **ask a human**. You scope it **one of two mutually exclusive ways**:

- **`tools.allowlist`** (+ `bash`/`fs`/`net`) — a closed allowlist naming exactly what's reachable. Simplest, built for one agent.
- **`rwx` letters** — tag every tool `r` (read — changes nothing), `w` (write — can be set back), or `x` (execute — can't be undone), borrowed straight from Unix `chmod`. Built for a *fleet* of agents: a human reviews by scanning for `x` instead of reading N separate allowlists. See [rwx + rwxmap](#rwx-and-rwxmap) below.

**2. Gate the advance** (rubric) — a human signs a list of checks before the work; the next step is denied until the agent's output is green. See [Rubric](#rubric-checks-the-agent-must-green).

Both share one audit log of everything the agent tried, and the same hard caps (budget, limits) that halt with a human in the loop instead of silently.

**What it isn't** — not a content filter, not a sandbox, not auth, and it never runs an LLM. It decides the action; it never runs it. A judge runs on your side and bareguard takes its answer as a fact (via `annotate`, or a caller-measured number in the rubric).

## Install

```
npm install bareguard
```

Requires Node.js >= 22. One production dep: `proper-lockfile`. Ships with TypeScript types (generated from JSDoc) — `import { Gate, type GateConfig } from "bareguard"` works out of the box, no `@types` package needed.

## Quick start

Pick ONE of `tools.allowlist` or `rwx` — never both on the same gate. (`rwx` mode replaces the `tools`/`bash`/`fs`/`net` block below with one `rwx: {...}` config — see [rwx + rwxmap](#rwx-and-rwxmap).)

```js
import { Gate } from "bareguard";

const gate = new Gate({
  tools:  { allowlist: ["bash", "read", "write", "fetch"] },
  bash:   { allow: ["git", "ls"], denyPatterns: [/sudo/, /rm\s+-rf/] },
  fs:     { readScope: ["/srv/agent"], writeScope: ["/srv/agent/out"], deny: ["~/.ssh"] },
  budget: { maxCostUsd: 5.00, maxTokens: 100_000 },
  limits: { maxTurns: 50 },
  // event.kind: "ask" | "halt" — your UX decides (TUI, Slack, web, PIN)
  humanChannel: async (event) => ({ decision: "allow" }),  // or "deny" / "topup" / "terminate"
});
await gate.init();

// gate.check never returns "askHuman" — it resolves that via humanChannel first.
const decision = await gate.check(action);   // audit auto-redacts secrets (default-on)
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);
  await gate.record(action, result);  // result.costUsd / result.tokens
}
```

`fs.readScope` and `fs.writeScope` are separate and deny-by-default (unset or `[]` = nothing allowed). Scope roots must be real paths, not symlinks. Detail: [`bareguard.context.md`](bareguard.context.md#gotchas).

A tool that walks a directory (a grep/glob over a root) is gated as one action, so it must check each directory and file it touches with `await gate.allows({ type: "read", tool, path })` and prune/skip on `false`; otherwise it can read under `fs.deny`. See gotcha 22 in [`bareguard.context.md`](bareguard.context.md#gotchas).

## The primitives

Small files, each readable in a sitting. The gate runs them in a fixed order (**deny → ask → scope → default**, first match wins). Building tool-calling automation? Read **`primitives.json`** first, a machine-readable menu of every verb (`when`, `import`, `signature`, `fails`, `example`), generated from source. Also on unpkg: `unpkg.com/bareguard/primitives.json`.

- **Scope what runs** — `bash` / `fs` / `net` bound which commands, paths, and domains are reachable. `net` gates on **any action carrying a `url`/`args.url` field**, not on `action.type === "fetch"`.
- **Tier what's dangerous** — `bash.classify` ranks a command **safe → destructive → super-destructive**; `content` denies `rm -rf /` / `DROP TABLE` outright.
- **Bound what accumulates** — `budget` caps spend, tokens, or any countable resource; `limits` caps turns / children / depth — both **halt with a human in the loop**, shared across processes.
- **Gate on meaning, not text** — `flags` reads a structured field's value (e.g. a memory engine's `provenance`) straight off the action, no regex.
- **Grade the work** — `rubric`: signed checks on the work (words, headings, phrases, quoted proof, table math, caller-measured numbers); the next step is gated on green. See [Rubric](#rubric-checks-the-agent-must-green).
- **Prove what happened** — `secrets` auto-redacts every audit line **by default**; one `audit` JSONL joins each request to its outcome and its approval.

Full per-primitive reference lives in the **[Usage Guide](https://github.com/hamr0/bareguard/blob/main/docs/product/usage-guide.md)** and **[Integration Guide](bareguard.context.md)**. Tested across Linux + macOS + Windows × Node 22 + 24.

## rwx and rwxmap

Borrowed from Unix file permissions (`chmod`). Tag every tool and bash command once with **one** letter:

| Letter | Means | Examples |
|---|---|---|
| `r` — read | Looks, changes nothing | `read`, `git status`, a search, an HTTP GET |
| `w` — write | Changes something, but a later write can set it back | `write` a file, `git commit`, update a record |
| `x` — execute | Cannot be undone — **unsure? tag it `x`** | `deploy`, `git push`, send an email, make a payment |

Then give each agent a three-letter ceiling, read like `chmod`: a dash means "not allowed". `"r--"` = read only, `"rw-"` = read + write, `"rwx"` = everything. An agent can run a tool only if its ceiling holds that tool's letter. A human reviews the whole fleet by scanning for `x` instead of reading per-agent allowlists:

```js
const gate = new Gate({
  rwx: {
    agent: "fixer",
    agents: { researcher: "r--", fixer: "rw-", deployer: "rwx" },
    tools:  { read: "r", write: "w", deploy: "x" },
    bash:   { "git status": "r", "git commit": "w", "git push": "x" },
  },
});
```

An unlisted tool, command, or agent is **denied, never asked**; add a row, don't widen a letter. To have a human decide instead of a flat deny when an agent lacks a *listed* letter, name that letter in `rwx.askUnheld` (e.g. `askUnheld: ["x"]`; default `[]` = deny); unlisted, joined and malformed cases still deny. See [`rwx.askUnheld`](bareguard.context.md#asking-for-an-unheld-letter--rwxaskunheld-ruling-70). A starter file ships at [`bareguard.rwx.json`](bareguard.rwx.json); `gate.add(entries)` / `addToGates(gates, entries)` grow a running gate tighten-only. Full contract: [`bareguard.context.md`](bareguard.context.md#runtime-growth-for-spec-less-sites--gateadd-gaterwxtools-addtogates-2321).

**[rwxmap](https://github.com/hamr0/rwxmap)** [WIP] labels every OpenAPI operation r/w/x as a starting point and marks unsure rows (`tight`/`loose`) for human review; its exporter writes a bareguard `rwx` config, and `askOn: "loose"` sends unreviewed rows to a human. bareguard never imports it. See [marker-carrying entries](bareguard.context.md#marker-carrying-entries--rwxaskon-d103-settled-with-rwxmap-2026-09-24).

## Rubric (checks the agent must green)

A **rubric** is a signed list of deterministic checks bound to a goal. bareguard mints a verdict (`green` / `red` / `stopped`) and, at a checkpoint marked **gating**, denies the advance action unless it is green. The Axis A floor runs first; a green verdict never turns a floor deny into an allow.

Three roles:
- **The runner** (your harness) drafts the rubric from `rubricVocabulary`, drives the agent, takes any measurements and calls `gate.checkStep`.
- **The human** signs the rubric before the work (`rubricSha`) and accepts the result after (`requiresHuman`).
- **bareguard** grades and gates. It never sees the agent's reasoning, and the agent never sees the rubric: a retry is fed only the gap (`gate.drainGaps()`).

**The rules at a glance**

| Kind | Rule | Checks |
|---|---|---|
| Always on | `happened` | The output exists: non-empty text, or an object with a key. |
| Size | `nonEmpty`, `maxWords`/`minWords`, `maxLines` | Field has content; word count or line count within a bound. |
| Shape | `sections`, `sectionOrder`, `sectionWords`, `allowedKeys` | Headings present and in order; words per section; no unlisted object keys. |
| Words | `mustCarry`, `carriesAny`, `blockLines`, `in`/`notIn`, `atMost` | All phrases carried; at least one phrase on word edges; per-block phrases; value in or out of a list; rank cap. |
| Numbers | `max`/`min` | A number field is at most, or at least, a bound. |
| Proof | `cited`, `complete` | Each claim's quote is in the frozen input; every listed item is covered. |
| Tables | `cells`, `table`, `diff` | Recompute counts, sums and lookups over rows; table shape; before/after changes. |
| Measured by your harness | `notWorse`, `commandExit`, `patternAbsent`, `filesChanged` | Your measurements: score not worse, exit code, no bad pattern, only allowed files. |

Per-rule detail (fields, examples, what turns red): [rubric-rules.md](https://github.com/hamr0/bareguard/blob/main/docs/product/rubric-rules.md). Exact field shapes: `rubricVocabulary`.

```js
import { Gate, createRubric, rubricSha } from "bareguard";

const spec = { schema: 1, goal: "Write the status report", inputs: [],
  checkpoints: { draft: { gating: true, checks: [
    { id: "short", rule: "maxWords", field: "text", value: 120 },
    { id: "heads", rule: "sectionOrder", field: "text", names: ["Summary", "Risks"] },
  ] } }, maxReds: 3 };
createRubric(spec);                                    // throws on a bad shape
const gate = new Gate({
  rubric: { spec, sha256: rubricSha(spec), advanceOn: ["step.done"] },   // the human signs rubricSha(spec)
  audit: { path: null }, humanChannel: async () => ({ decision: "allow" }),
});
await gate.init();
const advance = (r) => ({ type: "step.done", checkpoint: "draft", outputSha: r.outputSha });

let r = await gate.checkStep("draft", "Summary\nall good");   // no Risks heading
console.log(r.verdict, (await gate.check(advance(r))).rule);   // red rubric.red
r = await gate.checkStep("draft", "Summary\nall good\nRisks\nnone");
console.log(r.verdict, (await gate.check(advance(r))).outcome); // green allow
```

`advanceOn` matches an action's `type` or `tool`: give the advance a reserved name no real tool uses (e.g. `fwdloop.advance`), or the rubric would run on that tool's ordinary calls. Deny rules, `accept: "later"` / `gate.recordAccept`, and resuming with a stable `runId`: [`bareguard.context.md`](bareguard.context.md#rubric-signed-checks-that-gate-an-advance), [`rubric-prd.md`](https://github.com/hamr0/bareguard/blob/main/docs/product/rubric-prd.md).

## Facts you computed: `annotate`

`annotate` is transport for a fact you computed (bareguard never decides it): `await gate.annotate({ surface: true, verdict: "broke", where: "..." })`, then `gate.drainAnnotations()`. Reversibility is read from the gated action's type via `axisB.reversible`, never from the fact. Contract: [`bareguard.context.md`](bareguard.context.md#recipe-11-axis-b--surface-a-return-time-judge-fact-on-the-next-approval).

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out. Work in → green / red.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Add-on for bareguard** — labels API operations for the gate.

- **[rwxmap](https://github.com/hamr0/rwxmap)** [WIP] — labels every OpenAPI operation r/w/x as a starting point, marked for review. *API spec in → per-operation letter out.* The harness runs it offline; the file it writes goes straight into bareguard's `rwx` mode. bareguard never runs or depends on it.

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

**Wiring it into a real agent?** Hand your AI assistant `bareguard.context.md` (from `node_modules/bareguard/`) and describe your setup — it has the `humanChannel` patterns, shared-budget-across-processes setup, eval order, audit format, and 10+ wiring recipes.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
