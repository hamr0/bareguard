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

**What it isn't** — bareguard owns one layer and is honest about the rest. It's not a content filter (toxicity / PII / schema → `guardrails-ai`), not a sandbox (containment → Docker / gVisor), and not auth (who the actor *is* → upstream; per-principal policy rides `action._ctx`). It decides the action; it never runs it. It's also not an LLM judge — a judge runs on your side, and bareguard takes its answer as a fact (via `annotate`, or a caller-measured number in the rubric).

## Install

```
npm install bareguard
```

Requires Node.js >= 20. One production dep: `proper-lockfile`. Ships with TypeScript types (generated from JSDoc) — `import { Gate, type GateConfig } from "bareguard"` works out of the box, no `@types` package needed.

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

`fs.readScope` and `fs.writeScope` are separate, deny-by-default lists — a folder listed only in `writeScope` isn't readable, and file actions with neither list configured are denied outright, not left "no opinion." `fs.deny` is an optional extra layer *inside* whatever the scopes already allow, never a substitute for one. Deny-by-default here for the same reason the rest of this file's structure does: an allow-list mistake (a scope you forgot to add) fails **closed**, not open. Scope roots must be real paths: a root that is (or sits under) a symlink throws at construct and denies `fs.<scope>.symlinkRoot` at check time, since resolving it would silently move the scope to the link's target. On macOS `os.tmpdir()`, `/tmp` and `/etc` are symlinks — pass `fs.realpathSync(...)` of them.

## The primitives

Small files, each readable in a sitting. The gate runs them in a fixed order (**deny → ask → scope → default**, first match wins). Building tool-calling automation? Read **`primitives.json`** first — a compact, machine-readable menu of every verb (27 entries across gate · classify · matching · content · secrets · audit · axis-b · rwx · rubric), each carrying `when`, `import`, `signature`, `fails`, and a runnable `example`, generated from the source so it never drifts. Browse it on unpkg (`unpkg.com/bareguard/primitives.json`), or `import menu from 'bareguard/primitives.json' with { type: 'json' }`.

- **Scope what runs** — `bash` / `fs` / `net` bound which commands, paths, and domains are reachable. `net` gates on **any action carrying a `url`/`args.url` field**, not on `action.type === "fetch"`.
- **Tier what's dangerous** — `bash.classify` ranks a command **safe → destructive → super-destructive**; `content` denies `rm -rf /` / `DROP TABLE` outright.
- **Bound what accumulates** — `budget` caps spend, tokens, or any countable resource; `limits` caps turns / children / depth — both **halt with a human in the loop**, shared across processes.
- **Gate on meaning, not text** — `flags` reads a structured field's value (e.g. a memory engine's `provenance`) straight off the action, no regex.
- **Grade the work** — `rubric` checks word counts, headings, required phrases, quotes found in a frozen source, and caller-measured numbers, then gates the next step on green.
- **Prove what happened** — `secrets` auto-redacts every audit line **by default**; one `audit` JSONL joins each request to its outcome and its approval.

Full per-primitive reference lives in the **[Usage Guide](docs/product/usage-guide.md)** and **[Integration Guide](bareguard.context.md)**. Tested across Linux + macOS + Windows × Node 20 + 22.

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

An unlisted tool, command, or agent is **denied, never asked** (`rwx.unlisted`) — the fix is to add a row, not widen a letter. A starter file ships at [`bareguard.rwx.json`](bareguard.rwx.json). For a spec-less site met mid-run, `gate.add(entries)` tightens the running gate's own tools map (tighten-only); `addToGates(gates, entries)` fans one batch out to a fleet. Full contract: [`bareguard.context.md`](bareguard.context.md#runtime-growth-for-spec-less-sites--gateadd-gaterwxtools-addtogates-2321).

Hand-labeling a fleet's tools doesn't scale — **[rwxmap](https://github.com/hamr0/rwxmap)** [WIP] labels every OpenAPI operation r/w/x as a mechanical starting point, marking rows it's unsure of (`tight`/`loose`) for a human to review. Its exporter (`exportGate`) writes those labels straight into a bareguard `rwx` config, and `askOn: "loose"` routes an unreviewed row to a human instead of allowing it silently; a site met mid-run goes through `gate.add()`/`addToGates()` instead — bareguard never imports rwxmap. rwxmap's labels are suggestions, not verdicts: it never refuses, it just labels. Unlike a bare MCP hint that nothing enforces, here the gate enforces every row, and the review markers say which ones still need a human.

## Rubric (checks the agent must green)

A **rubric** is a signed list of deterministic checks bound to a goal. bareguard never runs an LLM; it checks deterministic facts against declared, enumerated rules: word counts, headings present and in order, phrases carried, quotes found in a frozen source, and numbers a caller measured. It mints a verdict (`green` / `red` / `stopped`) and, at a checkpoint the operator marks **gating**, denies the advance action unless the verdict is green. The Axis A floor always runs first and a green verdict never turns a floor deny into an allow.

Three roles:
- **The runner** (your harness) drafts the rubric from `rubricVocabulary`, drives the agent, takes any measurements and calls `gate.checkStep`.
- **The human** signs the rubric before the work (`rubricSha`) and accepts the result after (`requiresHuman`).
- **bareguard** grades and gates. It never sees the agent's reasoning, and the agent never sees the rubric: a retry is fed only the gap (`gate.drainGaps()`).

```js
import { Gate, createRubric, rubricSha, renderGaps, quoteIn, numbersInQuote } from "bareguard";

// 1. The runner drafts the spec from `rubricVocabulary`; the human signs `rubricSha(spec)`.
const spec = {
  schema: 1, goal: "Write the status report", inputs: [],
  checkpoints: {
    draft: { gating: true, checks: [
      { id: "short",  rule: "maxWords", field: "text", value: 120 },
      { id: "heads",  rule: "sectionOrder", field: "text", names: ["Summary", "Risks"] },
    ] },
    send: { gating: true, requiresHuman: true, checks: [   // accept: "live" is the default
      { id: "has-ref", rule: "mustCarry", field: "text", phrases: ["PROJ-42"] },
    ] },
  },
  maxReds: 3,
};
createRubric(spec);                                   // throws on an unknown check type or bad shape
const signed = rubricSha(spec);                       // the human signs this fingerprint

// 2. The gate holds the signed rubric. Stable runId = counts survive a restart.
const gate = new Gate({
  rubric: { spec, sha256: signed, advanceOn: ["step.done"] },
  runId: "report-2026-10-08",
  audit: { path: null },   // no audit file, so every run starts clean; with a real audit path a stable runId RESUMES state (reds, ACCEPTs) across runs
  humanChannel: async (event) => ({ decision: "allow" }),   // event.rubric = { rubricSha, checkpoint, outputSha, verdict, gaps }
});
await gate.init();

// 3. Grade at the checkpoint. A red returns a gap (no rule text) for the retry.
let r = await gate.checkStep("draft", "Summary\nall good");        // no Risks heading
console.log(r.verdict, renderGaps(gate.drainGaps()));              // red + a one-string gap render (stable, for stuck-detection)
const advance = (r) => ({ type: "step.done", checkpoint: "draft", outputSha: r.outputSha });
console.log((await gate.check(advance(r))).rule);                  // rubric.red

// 4. Fixed -> green -> the advance is allowed (the Axis A floor ran first).
r = await gate.checkStep("draft", "Summary\nall good\nRisks\nnone");
console.log(r.verdict, (await gate.check(advance(r))).outcome);    // green allow

// 5. requiresHuman: a green advance asks humanChannel once per outputSha.
const out = "Report for PROJ-42";
const s = await gate.checkStep("send", out);
const d = await gate.check({ type: "step.done", checkpoint: "send", outputSha: s.outputSha });
console.log(s.verdict, d.outcome, d.rule);                          // green allow humanChannel.allow

// Gate-less agents: the pure helpers.
console.log(quoteIn("lead time", "The **lead  time** fell"));      // { ok: true }  (** and whitespace forgiven)
console.log(quoteIn("time", " * lead time", { wholeLines: true }));   // { ok: false, why: "not-found" }  (opt-in: whole lines only)
console.log(numbersInQuote("4 hours", "2 weeks"));                 // { ok: false, missing: ["4"] }
```

`advanceOn` matches an action's `type` or its `tool`; give the advance a reserved name no real tool uses (e.g. `fwdloop.advance`), or the rubric would run on that tool's ordinary calls. Denies on the advance: `rubric.unminted`, `rubric.exhausted`, `rubric.stopped`, `rubric.red`, `rubric.output-mismatch`, `rubric.needs-accept`, and `rubric.invalid` (the config was swapped after construct). `accept: "later"` is for a harness that parks and resumes in another process: it records the answer with `gate.recordAccept(...)`, which is **harness-only**. Pass a stable `runId` (and audit path) on resume, or red counts start fresh. Full contract: [`docs/product/rubric-prd.md`](docs/product/rubric-prd.md); harness guide: [`bareguard.context.md`](bareguard.context.md#rubric-signed-checks-that-gate-an-advance).

## Facts you computed: `annotate`

bareguard never runs an LLM; it checks deterministic facts against declared, enumerated rules. `annotate` is transport for a fact you computed; for checks bareguard grades itself, see [Rubric](#rubric-checks-the-agent-must-green). To grade the agent's work, the rubric is now the way.

```js
// a fact you computed (a deterministic check); bareguard buffers it and rides the next ask
await gate.annotate({ surface: true, verdict: "broke", where: "you said under €300; the booking is €400" });
const facts = gate.drainAnnotations(); // feed them back to the agent, or read them off the audit line
```

Reversibility is read from the **gated action's type** via `axisB: { reversible: [...] }` — never from the fact, the agent, or the model. Full contract: [`bareguard.context.md`](bareguard.context.md#recipe-11-axis-b--surface-a-return-time-judge-fact-on-the-next-approval).

## The bare ecosystem

Local-first, composable agent infrastructure — mix and match, each module works standalone. **Core:**

```js
const ctx      = await memory.recall(goal);    // litectx   → ranked context
const action   = await agent.next(goal, ctx);  // bareagent → a proposed action
const decision = await gate.check(action);     // bareguard → allow / deny / ask-a-human
if (decision.outcome === "allow") await run(action);
```

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out. Work in → green / red.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*
- **[rwxmap](https://github.com/hamr0/rwxmap)** [WIP] — labels every OpenAPI operation r/w/x as a starting point, marked for review. *API spec in → per-operation letter out.* Exports straight into bareguard's `rwx` mode.

**Optional reach** — give the agent hands: **[barebrowse](https://npmjs.com/package/barebrowse)** (a real browser, replaces Playwright/Selenium/Puppeteer), **[baremobile](https://npmjs.com/package/baremobile)** (Android + iOS control, replaces Appium/Espresso/XCUITest), **[beeperbox](https://github.com/hamr0/beeperbox)** (50+ messaging networks via one MCP server, replaces Twilio/per-platform bot APIs).

**Wiring it into a real agent?** Hand your AI assistant `bareguard.context.md` (from `node_modules/bareguard/`) and describe your setup — it has the `humanChannel` patterns, shared-budget-across-processes setup, eval order, audit format, and 10+ wiring recipes.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
