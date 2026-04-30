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

> One chokepoint between your agent and the world. Bounds what the agent **does**,
> not what it **says**. Single audit log. Hard caps that halt with a human in
> the loop. ~930 lines, one production dep.

[![test](https://github.com/hamr0/bareguard/actions/workflows/test.yml/badge.svg)](https://github.com/hamr0/bareguard/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/bareguard.svg)](https://www.npmjs.com/package/bareguard)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

---

## What this is

bareguard is a runtime policy library every agent action passes through.
Every `gate.check(action)` is the only place a decision can be made — no
duplicate policy in tools, no bypass paths.

- 12 primitives (bash, fs, net, budget, content, secrets, audit, …) — each
  one is one small file.
- One single-file JSONL audit across the whole agent family (parent +
  children + grandchildren), atomic via POSIX `O_APPEND`.
- Hard caps (budget, maxTurns) **halt** the run and call a human; never
  silently allow.
- One callback for all human escalations (`humanChannel`) — bareguard
  knows nothing about TUIs, Slack, web, or PINs.
- Safe defaults shipped: `rm -rf /` denied, `DROP TABLE` denied, destructive
  verbs (`delete`, `revoke`, `force-push`, …) escalate to human.

## What this isn't

- Not a content guardrail (use `guardrails-ai` for toxicity / PII / schema).
- Not a sandbox (Docker / gVisor contains effects; bareguard prevents calls).
- Not an authn / authz layer (caller's concern; pass a different `Gate`
  instance per user).
- Not a scheduler (cron + bareagent's `defer` tool handles scheduled wakeups).

See [`docs/non-roadmap.md`](docs/non-roadmap.md) for the NO-GO list.

---

## Quick start

```bash
npm install bareguard
```

Requires Node 20 LTS or higher. One production dep: `proper-lockfile`.

```js
import { Gate } from "bareguard";

const gate = new Gate({
  // Capability scope — only listed tool types can be invoked at all.
  tools: { allowlist: ["bash", "read", "write", "fetch"] },

  // Per-tool deny rules.
  bash: { allow: ["git", "ls", "cat"], denyPatterns: [/sudo/, /rm\s+-rf/] },
  fs:   { writeScope: ["/tmp/agent"], readScope: ["/tmp"], deny: ["~/.ssh"] },
  net:  { allowDomains: ["api.example.com"], denyPrivateIps: true },

  // Hard caps — exhaustion halts the run and calls humanChannel.
  budget: { maxCostUsd: 5.00, maxTokens: 100_000, sharedFile: "./.bareguard-budget.json" },
  limits: { maxTurns: 50, maxChildren: 4, maxDepth: 3 },

  // Secrets to redact from actions before audit.
  secrets: { envVars: ["ANTHROPIC_API_KEY"], patterns: [/sk-[A-Za-z0-9]{40,}/] },

  // ONE callback bareguard calls when a human is needed. You decide the UX.
  humanChannel: async (event) => {
    // event.kind: "ask" | "halt"
    // event.action / event.severity / event.rule / event.reason / event.context
    return { decision: "allow" }; // or "deny" / "topup" / "terminate"
  },
});
await gate.init();

// In your loop:
const action = { type: "bash", cmd: "git status" };
const decision = await gate.check(gate.redact(action));
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);
  await gate.record(action, result);  // result.costUsd / result.tokens
}
// bareguard never returns "askHuman" to your code — it resolves that
// internally via humanChannel and gives you a terminal allow/deny.
```

---

## What's inside

Every primitive is one file (~50–150 LOC). They compose through the single gate.

| Primitive | What it does |
|---|---|
| **bash** | Command allowlist + denyPatterns when `action.type === "bash"`. |
| **budget** | Tokens + cost USD with hard kill. **Halt severity** — escalates to human. Shared across processes via `proper-lockfile`. |
| **fs** | `writeScope` / `readScope` / `deny` for `read` / `write` / `edit` actions. Path prefix matching. |
| **net** | Egress domain allowlist + private-IP deny for `fetch`. |
| **limits** | `maxTurns` (halt), `maxChildren` (action), `maxDepth` (action), `timeoutSeconds` (halt, v0.2). |
| **approval** | Triggers `humanChannel` — bareguard never invokes UI itself. |
| **tools** | Tool-name `allowlist` / `denylist` (glob-matched) + per-tool `denyArgPatterns` (regex over args). |
| **secrets** | Redacts known env-var values + cred patterns from actions. Tags with name, never leaks. |
| **audit** | One JSONL file per agent family. Phases: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`. |
| **content** | Pattern matches over serialized action. Universal `denyPatterns` (step 2) + `askPatterns` (step 4). Safe defaults shipped. |
| ~~**defer-rate**~~ | _(v0.2 — needs bareagent's `defer` tool)_ |
| ~~**spawn-rate**~~ | _(v0.2 — needs bareagent's `spawn` tool)_ |

**Eval order** (first match wins): `tools.denylist → content.denyPatterns → per-action-type rules → content.askPatterns → tools.allowlist scope → default allow`. Pre-eval halt checks (`budget`, `maxTurns`) run first. Allowlist is **scope-only** — does not silence asks.

**Halt vs deny:** `budget` and `maxTurns` exhaustion produce `severity: "halt"` decisions. The runner MUST escalate via `humanChannel`, MUST NOT bubble to the LLM. Per-action denies (everything else) bubble normally.

---

## Single-file audit, no contention

bareguard writes one JSONL file per agent family (parent + children +
grandchildren). All processes append to the same path; POSIX `O_APPEND`
guarantees atomicity for writes < 4KB — same mechanism nginx access logs use.

```
$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl   (default; cwd fallback)
```

Every line carries `run_id`, `parent_run_id`, `spawn_depth` so the writer
is identifiable. Reconstruct the family tree with one `grep`.

```bash
# spend dimension snapshot
jq 'select(.phase=="record") | .result.costUsd' run.jsonl | paste -sd+ | bc

# what stopped the run last night?
grep '"phase":"halt"' run.jsonl
```

---

## Safe defaults

bareguard ships ~10 lines of regex covering ~90% of dangerous things
agents do. Not a ceiling — narrow or extend in `content`.

```js
// Denied outright (no human prompt):
"DROP TABLE users"        // SQL
"rm -rf /home/x"          // shell
"TRUNCATE TABLE accounts" // SQL

// Asks the human:
"delete the user account"
"git force-push origin main"
{ method: "DELETE", url: "..." }
```

If noisy, narrow `content.askPatterns`. If you want zero floor:
`content: { askPatterns: [], denyPatterns: [] }`.

---

## Public API

```js
import { Gate, redact, defaultAuditPath, BudgetUnavailableError,
         SAFE_DEFAULT_DENY_PATTERNS, SAFE_DEFAULT_ASK_PATTERNS } from "bareguard";

await gate.init()
gate.redact(action)                  // sync: action-side secrets redaction
await gate.allows(action)             // pure boolean (no audit, no budget delta)
await gate.check(action)              // { outcome, severity, rule, reason }
await gate.record(action, result)     // updates budget + emits record line
await gate.run(action, executor)      // check + execute + record (one call)
await gate.terminate(reason)          // sticky terminate
await gate.raiseCap(dimension, n)     // explicit cap raise
await gate.haltContext()              // deterministic stats over audit
```

**Caller contracts:**
1. `gate.check` and `gate.record` MUST be called **serially** per `Gate`
   instance. (Multiple `Gate` instances, e.g. parent + child processes,
   MAY run concurrently — they're independent.)
2. **Redact tool results** before `gate.record(action, result)` — bareguard
   ships the `redact()` helper for both actions and results.
3. `humanChannel` returns `{ decision: "allow" | "deny" | "topup" | "terminate", newCap?, reason? }` — never `undefined`.

---

## Common gotchas (read these before you wire it up)

These are the design choices that surprise people most often. Calling them out
front-of-house so you don't trip on them later.

**1. `tools.allowlist` does NOT silence safe-default `content.askPatterns`.**
If you set `tools.allowlist: ["bash", "fetch"]` thinking that's a "trust these
tools" shortcut, you'll still get prompted on actions matching the shipped
askPatterns (`delete`, `revoke`, `truncate`, `force-push`, destructive HTTP
methods). This is intentional (PRD v0.5 §4) — allowlist is **scope-only** ("which
tools can be invoked at all"), not a trust shortcut. To silence specific asks:
narrow `content.askPatterns` or use `tools.denyArgPatterns` for tool-specific
denies.

**2. Glob `*` matches anything including `/`.** So `mcp:foo/admin_*` matches
both `mcp:foo/admin_baz` AND `mcp:foo/admin_baz/nested/path`. For denylists
this is safe (denies more, never less); for **allowlists this can over-grant**:

```js
// SURPRISE: this allows mcp:linear.app/foo AND mcp:linear.app/sub/foo/bar
tools: { allowlist: ["mcp:linear.app/*"] }

// SAFER: list specific tools or use a tighter prefix
tools: { allowlist: ["mcp:linear.app/list_issues", "mcp:linear.app/get_issue"] }
```

v0.2 may add shell-style `**` so `*` means "anything except `/`". Until then,
err narrow on allowlists.

**3. `humanChannel` is effectively required for any safety-default-shipped
config.** Out of the box, `content.askPatterns` ships with destructive verbs.
First time one fires, if `humanChannel` is unset, bareguard prints a one-time
WARN to stderr and the action is denied with `severity: "halt"`. This is
correct behavior for headless / CI runs (deny on no human present), but if
you're running interactively and the agent suddenly stops working, **check
your terminal for the WARN line**.

**4. Caps are soft, halts are hard.** Cross-process budget can be exceeded by
one action's spend before the next refresh (~$0.01–0.10 overshoot). The halt
fires reliably on the next check after a record. If you need cents-precision
hard caps, run single-process with `budget.sharedFile: null`.

**5. `gate.check` and `gate.record` MUST be called serially per `Gate`
instance.** Concurrent calls produce undefined `seq` ordering. Multiple Gate
instances (parent + child processes) are independent and run concurrently
fine — each has its own `seq`.

---

## Known limitations (v0.1)

- **Glob:** only `*` (matches anything including `/`). No `?`, `[abc]`, escapes.
- **Safe-default `askPatterns` may over-match** (innocent strings containing
  "delete"). Right v1 trade — over-asking is recoverable; under-asking is
  incidents.
- **Cross-platform:** Linux + macOS are primary (POSIX `O_APPEND`
  atomicity). Windows uses a lock fallback for audit (bareguard auto-detects).
- **Rate limits not in v0.1.** `defer-rate` and `spawn-rate` ship in v0.2
  alongside the bareagent `defer` and `spawn` tools that exercise them.
- **Soft cap.** Cross-process budget can be exceeded by one action's spend
  before next refresh. Halt fires reliably on the next check after a record.

---

## The bare ecosystem

Four vanilla JS modules. Same API patterns. Same philosophy: zero deps where
possible, one allowed dep where necessary, no telemetry, no SaaS.

| | [**bareagent**](https://npmjs.com/package/bare-agent) | [**barebrowse**](https://npmjs.com/package/barebrowse) | [**baremobile**](https://npmjs.com/package/baremobile) | [**bareguard**](https://npmjs.com/package/bareguard) |
|---|---|---|---|---|
| **Does** | Gives agents a think → act loop | Gives agents a real browser | Gives agents Android + iOS devices | Gates everything an agent does |
| **How** | Goal in → coordinated actions out | URL in → pruned snapshot out | Screen in → pruned snapshot out | Action in → allow / deny / human-asked out |
| **Replaces** | LangChain, CrewAI, AutoGen | Playwright, Selenium, Puppeteer | Appium, Espresso, XCUITest | Hand-rolled allowlists, scattered policy |
| **Interfaces** | Library · CLI · subprocess | Library · CLI · MCP | Library · CLI · MCP | Library |
| **Solo or together** | Orchestrates the others as tools | Works standalone | Works standalone | Embedded in bareagent's loop; usable by any runner |

> **Reach 50+ messengers via [beeperbox](https://github.com/hamr0/beeperbox)** — a headless Beeper Desktop in Docker that exposes WhatsApp, iMessage, Signal, Telegram, Slack, Discord, and more as one MCP server. Wire it through bareagent's MCP bridge; bareguard policies the invocations like any other tool (`mcp:beeperbox/send_message`, `mcp:beeperbox/list_chats`, …). Per-chat allowlists and per-tool ask patterns work out of the box.

**What you can build with the suite + beeperbox:**

- Agents that monitor chats across messengers, escalate destructive replies through `humanChannel` (PIN, Slack reaction, web button — your call).
- Headless QA that browses, taps mobile, runs shell — all under one shared budget + audit log.
- Multi-agent pipelines where parent + children share a $5 cap and one JSONL audit.

---

## Spec & history

- [v0.4 PRD](docs/01-product/bareguard-prd.md) — implementation-ready spec.
- [v0.5 amendments](docs/01-product/bareguard-prd-v0.5-amendments.md) — read alongside v0.4; amendments win on conflict.
- [non-roadmap](docs/non-roadmap.md) — the NO-GO list. Point here when asked.
- [decisions log](docs/decisions-log.md) — design calls resolved across versions.

## License

Apache 2.0. See `LICENSE` and `NOTICE`.
