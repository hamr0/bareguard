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
> Single audit log. Hard caps that halt with a human in the loop. ~930 lines, one production dep.

<p align="center">
  <a href="https://github.com/hamr0/bareguard/actions/workflows/test.yml"><img src="https://github.com/hamr0/bareguard/actions/workflows/test.yml/badge.svg" alt="test"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/bareguard?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

---

## What this is

bareguard is a runtime policy library every agent action passes through. One `Gate` class, three call sites (`redact`, `check`, `record`), twelve primitives — bash, fs, net, budget, content, secrets, audit, limits, tools, defer-rate, spawn-rate, approval. Each primitive is one small file you can read in a sitting.

Same patterns as [bareagent](https://www.npmjs.com/package/bare-agent), [barebrowse](https://www.npmjs.com/package/barebrowse), and [baremobile](https://www.npmjs.com/package/baremobile) — embed it, don't run it. No daemon, no SaaS, no telemetry.

Not a content guardrail (use `guardrails-ai` for toxicity / PII / schema). Not a sandbox (Docker / gVisor for containment). Not authn (caller's concern). Not a scheduler. The five-layer split: system prompt → guardrails-ai → **bareguard** → sandbox → OS perms. bareguard owns exactly one.

## Install

```
npm install bareguard
```

Requires Node.js >= 20. One production dep: `proper-lockfile`.

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
const decision = await gate.check(gate.redact(action));
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);
  await gate.record(action, result);  // result.costUsd / result.tokens
}
// gate.check never returns "askHuman" — bareguard resolves that internally
// via humanChannel and gives you a terminal allow/deny.
```

Full integration guide for AI assistants and developers: **[bareguard.context.md](bareguard.context.md)** — covers the `humanChannel` patterns (TUI / Slack / PIN), shared budget across processes, eval order, audit format, gotchas, and 8 recipes including the bareagent + beeperbox wiring.

## How it works

Every action traverses one gate. The eval order is `deny > ask > scope > default`, **first match wins**:

1. `tools.denylist` → deny
2. `content.denyPatterns` → deny (universal — catches `DROP TABLE`, `rm -rf /` on any tool)
3. per-action-type rules → deny (`bash` / `fs` / `net` / `limits.maxChildren` / `tools.denyArgPatterns`)
4. `content.askPatterns` → ask the human (universal — fires even on allowlisted tools)
5. `tools.allowlist` enforcement → allow if listed, deny if set+miss
6. default → allow

Pre-eval halt checks (`budget`, `maxTurns`, `gate.terminated`) run before step 1. Halt-severity events MUST escalate to a human via `humanChannel`; they NEVER bubble to the LLM.

One JSONL audit file per agent family. POSIX `O_APPEND` guarantees atomicity for writes < 4KB — same mechanism nginx access logs use. Parent + children + grandchildren all append the same file; `grep parent_run_id` reconstructs the tree. Windows uses a `proper-lockfile` fallback (auto-detected).

## What's inside

Every primitive is one file (~30–180 LOC).

| Primitive | What it does |
|---|---|
| **bash** | Command allowlist + `denyPatterns` when `action.type === "bash"`. |
| **budget** | Tokens + cost USD, **halt severity** (escalates to human). Shared across processes via `proper-lockfile`. |
| **fs** | `writeScope` / `readScope` / `deny` for `read` / `write` / `edit`. Path prefix matching. |
| **net** | Egress domain allowlist + private-IP deny for `fetch`. |
| **limits** | `maxTurns` (halt), `maxChildren` (action), `maxDepth` (action), `timeoutSeconds` (halt, v0.2). |
| **tools** | Tool-name `allowlist` / `denylist` (glob-matched) + per-tool `denyArgPatterns`. Allowlist is **scope-only** — does not silence asks. |
| **content** | Pattern matches over serialized action. Universal `denyPatterns` (step 2) + `askPatterns` (step 4). **Safe defaults shipped.** |
| **secrets** | Redacts known env-var values + cred patterns. Tags with name (`[REDACTED:ANTHROPIC_API_KEY]`); never leaks. |
| **audit** | One JSONL file per family. Phases: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`. |
| **approval** | Routes ask events to the runner-supplied `humanChannel` callback. |
| **defer-rate** | Caps `defer` actions per minute (default 15). Counted from the audit log; per-family. |
| **spawn-rate** | Caps `spawn` actions per minute (default 10). Composes with `maxChildren` / `maxDepth`. |

**Safe defaults** ship in `content`. `rm -rf /`, `DROP TABLE`, `TRUNCATE` denied outright. Destructive verbs (`delete`, `revoke`, `force-push`, destructive HTTP methods) escalate to the human. Override with empty arrays for pure-allow.

## Common gotchas

The design choices that surprise people most often. Read these before wiring it up.

**1. `tools.allowlist` does NOT silence safe-default `content.askPatterns`.** Allowlist is scope-only ("which tools can be invoked at all"), not a trust shortcut. To silence an ask: narrow `content.askPatterns` or use `tools.denyArgPatterns`.

**2. Glob `*` matches anything including `/`.** `mcp:foo/admin_*` catches `mcp:foo/admin_baz` AND `mcp:foo/admin_baz/sub`. Safe for denylists; **can over-grant on allowlists** — list specific tools or use a tighter prefix. v0.2 may add `**` so `*` becomes "anything except `/`".

**3. `humanChannel` is effectively required for safe-default-shipped configs.** First time an ask fires without one wired, bareguard prints a one-time WARN to stderr and denies with `severity: "halt"`. Headless / CI runs that intentionally have no channel see this once and continue.

**4. Caps are soft, halts are hard.** Cross-process budget can be exceeded by one action's spend before next refresh. Halt fires reliably on the next check after a record.

**5. `gate.check` and `gate.record` MUST be called serially per `Gate` instance.** Multiple Gate instances (parent + child processes) run independently and concurrently fine.

**6. `limits.maxTurns` ticks on every `gate.record` — LLM AND tool records.** If your loop records one LLM call and one tool call per round, one "round" consumes two turns. For a "tool-calling-rounds" budget the cleaner option is **`limits.maxToolRounds: N`** (v0.4.2) — sibling halt counter that ticks only on records whose `action.type !== "llm"`. Either pattern works; pick one and document it. (For a record-per-round ratio other than 1:1, stick with `maxTurns = rounds * ratio`.)

**7. bash / fs / net primitives accept either flat or nested action shape.** `{type: "bash", cmd: "..."}` and `{type: "bash", args: {cmd: "..."}}` (or `args.command`) both work. Same for `{type: "read", path: "..."}` vs `{type: "read", args: {path: "..."}}` and `fetch` / `url`. Lets adapters that pass MCP-style `{type, args, _ctx}` compose without a translation layer. (v0.4.1.)

## Recipes

Patterns the spec supports but most adopters re-derive on first contact. Lead with the foot-guns (#1, #2) — the rest are reference when you need them.

### 1. Content screening on text in/out

`content.{deny,ask}Patterns` match `JSON.stringify(action)` — they don't care about `action.type`. Wrap inbound user text AND outbound LLM responses as actions and they flow through the same gate.

```js
// BEFORE invoking your agent loop on a new user message:
const d1 = await gate.check({ type: "user_input", args: { text: message }, _ctx });
if (d1.outcome !== "allow") return refuse(d1.reason);

// AFTER generate, BEFORE displaying to the user:
const d2 = await gate.check({ type: "llm_output", args: { text: response }, _ctx });
if (d2.outcome !== "allow") return refuse(d2.reason);
```

Both calls emit `phase: "gate"` audit lines — unified record across tool calls, user input, and model output.

> bareguard does NOT classify toxicity, PII, or factuality — that's `guardrails-ai`. What you get here is YOUR `content.denyPatterns` / `askPatterns` firing on text the same way they fire on tool calls. The wrapper shape (`type: "user_input"` / `type: "llm_output"`) is yours; bareguard treats it as opaque and pattern-matches the serialization.

bareguard does not auto-scan messages. If you skip these calls on inbound/outbound text, content rules never fire on user content.

### 2. Multi-tenant chatbot (Gate-per-principal)

One process serving many chats. **Recommended pattern: one Gate per principal**, all sharing one audit file and one budget file so cross-chat caps work.

```js
// Per-process, once at boot:
process.env.BAREGUARD_AUDIT_PATH  ??= "/var/lib/myapp/audit.jsonl";
process.env.BAREGUARD_BUDGET_FILE ??= "/var/lib/myapp/budget.json";

// Per chat, on first message:
function gateForChat(chatId, isOwner) {
  return new Gate({
    runId: chatId,
    budget: { maxCostUsd: isOwner ? 50 : 1 },     // per-principal cap
    humanChannel: async (event) => {
      // event.action._ctx routes the prompt to the right user (Recipe 5)
      return await promptUser(event.action._ctx.chatId, event);
    },
  });
}
```

Each Gate attaches `_ctx` by accepting whatever the runner puts on the action — bareguard preserves it verbatim. The shared audit + budget files give you cross-chat spend visibility and family-wide rate caps for free.

> **Scaling caveat:** `proper-lockfile` contention on the shared budget file scales fine to a few hundred concurrent writers. Past ~1K active principals sharing one budget file, drop shared budget and move to per-principal budgets. bareguard does not solve high-fan-out budget consensus, and won't.

### 3. In-process concurrent Gates

Recipe 2 implies N Gates living in the same process. This is safe: each `audit.emit` call does open+append+close, so POSIX `O_APPEND` atomicity applies the same as it does cross-process (writes < 4KB are atomic at the kernel level).

```js
// 50 Gates, one audit file — works.
const gates = chatIds.map(id => new Gate({ runId: id, audit: { path: "/var/log/agent.jsonl" } }));
await Promise.all(gates.map(g => g.init()));
```

`seq` is per-Gate-instance (was never global). For cross-Gate ordering use `ts`.

### 4. Test idiom — fileless audit + deny-lambda humanChannel

Unit tests don't want temp directories or fs mocks. Set `audit.path: null` and pass a one-line `humanChannel`.

```js
import { Gate } from "bareguard";

const gate = new Gate({
  audit: { path: null },                                  // in-memory only
  humanChannel: async () => ({ decision: "deny" }),       // or "allow" for happy-path
});
await gate.init();

const dec = await gate.check({ type: "fetch", url: "https://api/delete-acct" });
assert.equal(dec.outcome, "deny");
assert.equal(gate.audit.entries.length, 3);   // gate-askHuman + approval + gate-deny
```

`gate.audit.entries` is the in-memory replacement for `readFile` + `JSON.parse` per line. No string shorthands like `'deny-all'` — overloaded function args are a smell.

### 5. Halt routing for multi-tenant

Halt events (budget exhausted, maxTurns hit) need to reach the *originating* user, not whoever is logged in to the operator console. Since v0.4, `event.action` carries the action being checked (with any caller-attached `_ctx`) on halts too.

```js
humanChannel: async (event) => {
  if (event.kind === "halt") {
    const chatId = event.action?._ctx?.chatId;
    // Route the halt prompt back to the right chat — not the operator.
    return await promptChat(chatId, `Budget exhausted. Top up?`);
  }
  // ...ask events
}
```

This presumes the Gate-per-principal model from Recipe 2 — `lastAction` from the same Gate is always the same principal. In the (unsupported) one-Gate-many-principals shape, `event.action` is whatever fired most recently and routing is undefined.

### 6. bareagent wireGate integration

`bareagent`'s `wireGate(gate, ...)` hooks up the gate to its Loop. The pieces you wire:

```js
const { HaltError, wireGate, defaultActionTranslator } = require("bare-agent");
const { Gate }                                          = require("bareguard");

const gate = new Gate({
  // Cleaner than maxTurns: rounds * 2 — counts only non-"llm" records (v0.4.2):
  limits: { maxToolRounds: 30 },
  bash:   { allow: ["git", "ls"] },
  fs:     { readScope: ["/tmp"], writeScope: ["/tmp"] },
  humanChannel: yourHumanChannel,
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate, {
  actionTranslator: (toolName, args, ctx) => {
    if (toolName === "shell_exec") return { type: "bash", cmd: args.command, _ctx: ctx };
    if (toolName === "shell_read") return { type: "read", path: args.path,    _ctx: ctx };
    return defaultActionTranslator(toolName, args, ctx);
  },
});

new Loop({ provider, policy, onLlmResult, onToolResult });
// Do NOT pass Loop({ maxRounds: N }) — bind via the Gate's maxToolRounds instead.
```

The `actionTranslator` maps tool names to bareguard's canonical action shape (`bash`/`read`/`write`/`fetch`) so the matching primitives fire. With v0.4.1+, you can leave `args` nested — bareguard reads `action.cmd ?? action.args.cmd`, `action.path ?? action.args.path`, `action.url ?? action.args.url`. `onLlmResult` records LLM cost as `{type:"llm"}`, which is what `maxToolRounds` excludes.

### 7. Log rotation

bareguard does not rotate the audit log — that's `logrotate`'s job. bareguard opens the audit file fresh on every `emit` (open+append+close), so `copytruncate` is the right mode:

```
# /etc/logrotate.d/bareguard
/var/log/bareguard/*.jsonl {
    daily
    rotate 30
    compress
    missingok
    notifempty
    copytruncate
}
```

## Tested against

88 tests pass on the CI matrix: **Linux + macOS + Windows × Node 20 + 22**. Real subprocesses verify shared-budget contention under `proper-lockfile`, halt-cascade across processes, single-audit-file atomicity (3 concurrent writers, no torn lines), `parent_run_id` / `spawn_depth` stitching across a 3-deep tree, and `maxChildren` / `maxDepth` enforcement.

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

## Spec

- [PRD](docs/01-product/bareguard-prd.md) — unified design spec.
- [non-roadmap](docs/non-roadmap.md) — the NO-GO list.
- [decisions log](docs/decisions-log.md) — design calls resolved across versions.
- [CHANGELOG](CHANGELOG.md) — release-by-release diff.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
