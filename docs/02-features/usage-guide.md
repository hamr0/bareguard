# bareguard — Usage Guide

The human-facing companion to the [Integration Guide](../../bareguard.context.md)
(LLM-optimized). This is where the deployment patterns, foot-guns, and recipes
live so the README can stay an overview. For the runtime contract and full eval
order see the [PRD §9](../01-product/bareguard-prd.md); for what bareguard will
never do, the [NO-GO list](../non-roadmap.md).

## How it works

Every action traverses one gate. The eval order is `deny > ask > scope > default`,
**first match wins**:

1. `tools.denylist` → deny
2. `content.denyPatterns` → deny (universal — catches `DROP TABLE`, `rm -rf /` on any tool)
3. per-action-type rules → deny (`bash` / `fs` / `net` / `limits.maxChildren` / `tools.denyArgPatterns`)
4. `content.askPatterns` → ask the human (universal — fires even on allowlisted tools)
5. `tools.allowlist` enforcement → allow if listed, deny if set+miss
6. default → allow

Pre-eval halt checks (`budget`, `maxTurns`, `gate.terminated`) run before step 1.
Halt-severity events MUST escalate to a human via `humanChannel`; they NEVER bubble
to the LLM.

One JSONL audit file per agent family. POSIX `O_APPEND` guarantees atomicity for
writes < 4KB — same mechanism nginx access logs use. Parent + children +
grandchildren all append the same file; `grep parent_run_id` reconstructs the tree.
Windows uses a `proper-lockfile` fallback (auto-detected).

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

See also [identity-and-the-gate.md](../identity-and-the-gate.md) for using this with a runner-verified agent identity (DID / token) on `_ctx`.

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

### 8. Sticky approvals — humanChannel wrapper

bareguard does not cache approvals. Every ask reaches `humanChannel` fresh, every time — that's a deliberate non-goal (PRD §17). "Ask once, remember the answer" is the runner's UX: building it into the gate would freeze one definition of "same action" for everyone (same args? same arg shape? same session? what TTL?). Wrap your channel in ~25 lines instead:

```js
import crypto from "node:crypto";

function stickyApprovals(humanChannel, {
  ttlMs = 60 * 60 * 1000,                                          // 1h default
  maxEntries = 1000,
  keyFn = (a) => { const { _ctx, ...shape } = a; return JSON.stringify(shape); },
  cacheableDecisions = ["allow"],                                  // never sticky-cache "deny" by default
} = {}) {
  const cache = new Map();                                          // key -> { decision, expiresAt, cachedAt }
  return async (event) => {
    if (event.kind !== "ask") return humanChannel(event);           // never cache halts / topups / terminates
    const key = crypto.createHash("sha256").update(keyFn(event.action)).digest("hex").slice(0, 16);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return { decision: hit.decision, reason: `sticky: prior ${hit.decision} at ${new Date(hit.cachedAt).toISOString()}` };
    }
    const result = await humanChannel(event);
    if (cacheableDecisions.includes(result.decision)) {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);  // drop oldest
      cache.set(key, { decision: result.decision, expiresAt: Date.now() + ttlMs, cachedAt: Date.now() });
    }
    return result;
  };
}

const gate = new Gate({
  humanChannel: stickyApprovals(myActualHumanChannel, { ttlMs: 30 * 60 * 1000 }),
});
```

**What's cached:** ask events whose action serializes to the same key, until TTL expires. The `reason` field tags the cached return so it shows up on the `phase: "approval"` audit line — every approval (cached or fresh) is still in the log.

**What's NOT cached (intentionally):** halts (`event.kind === "halt"`), `topup` and `terminate` returns, and (by default) `deny` returns. Halts gate budget — fresh human eye every time. Deny-caching can be enabled (`cacheableDecisions: ["allow", "deny"]`) if your UX wants it, but the safer default is to re-ask on a denied shape because the user may have meant only "deny *this* one."

**Define "same action" to taste:** the default `keyFn` hashes the full action minus `_ctx` (which is per-principal routing, not action shape). For a noisy field like an ID or timestamp, narrow it (`keyFn: (a) => JSON.stringify({type: a.type, cmd: a.cmd?.split(' ')[0]})`). The library does not pick a definition — that's why this is a recipe, not a primitive (§17).

**Scope:** per-Gate-instance, in-memory. In Recipe 2's Gate-per-principal model the cache is per-principal automatically. For cross-process or cross-restart sticky approvals, persist `cache` to a file your runner owns; the audit log already carries every prior `phase: "approval"` line, so a cold start can warm the Map from `tail audit.jsonl | jq 'select(.phase=="approval")'`.

---

> The [Integration Guide](../../bareguard.context.md) has further wiring recipes
> aimed at AI assistants (terminal / Slack / PIN `humanChannel`, MCP `denyArgPatterns`,
> spawn/defer rate caps, the beeperbox 50-messenger wiring).
