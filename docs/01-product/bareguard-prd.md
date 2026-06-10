# bareguard — Product Requirements Document (PRD)

**Status:** v0.7 (v0.5 release — ships TypeScript types generated from JSDoc; policy-bypass hardening: type-confusion denies, atomic budget write)
**Owner:** hamr0
**Last updated:** 2026-05-29
**Language:** Node.js (JavaScript), ESM, target Node 20 LTS+. Ships `.d.ts` generated from JSDoc (v0.5) — typed consumption with no `@types` package.
**Sibling spec:** `bareagent-prd.md`
**Implementation status:** v0.5.2 — tests green on Linux/macOS/Windows × Node 20/22 (+ a `strictNullChecks` `tsc` typecheck job)
**Supersedes:** v0.1 (Python draft), v0.2 (orchestration), v0.3 (mid-MCP), v0.4 (post-MCP), v0.5 amendments doc, v0.6 unified

> **For future Claude (implementation note):** This document is the single
> source of truth for bareguard's design. §3/§4 say what bareguard IS / IS
> NOT. §8 is the 12 primitives table with halt-vs-action severity. §9 is
> the architecture and the 6-step evaluation order — that order is
> load-bearing, implement it exactly. §10 is the public API including
> `humanChannel`. §12 is the audit format. §17 is the NO-GO list — point
> at it instead of reopening discussions. §22 is the decisions log; do not
> re-litigate items there unless the user explicitly asks.

---

## 1. One-line summary

`bareguard` is a one-dep, local-first runtime policy library for autonomous
agents. It bounds what the agent can *do*, not what it can *say*.

## 2. Two-paragraph summary

bareguard is the policy layer that bareagent (and any other agent runner)
imports. Every tool call traverses `gate.check(action)`; every result hits
`gate.record(action, result)`. There is one gate, one audit log, one budget
ledger, and twelve primitives — bash, budget, fs, net, limits, approval,
tools, secrets, audit, defer-rate, spawn-rate, content. Each primitive is
~30–180 LOC, composable through the single gate. The library is small enough
that you can read the whole thing in an afternoon and understand exactly what
your agent is allowed to do.

bareguard ships with safe defaults — destructive verbs (delete, drop, revoke,
truncate) trigger ask-human prompts via a single `humanChannel` callback;
explicit dangers (DROP TABLE, rm -rf /) are denied outright. Multi-agent runs
share one budget file (locked via `proper-lockfile`) and one audit JSONL
file (atomic via POSIX `O_APPEND`); audit lines include `parent_run_id` and
`spawn_depth` so a family of agents reconstructs into one timeline with grep.
Run-level limit exhaustion (budget, maxTurns) escalates to the human via the
registered `humanChannel`; never bubbles silently to the LLM.

## 3. What bareguard IS

- A **policy library** — a single `Gate` class with three call sites:
  `gate.redact()`, `gate.check()`, `gate.record()`. Plus convenience methods
  `gate.run()`, `gate.allows()`, `gate.haltContext()`, `gate.terminate()`,
  `gate.raiseCap()`.
- An **action-side guard** — it enforces what the agent does to the world
  (bash commands, fs writes, network calls, MCP invocations, child spawns,
  budget consumption).
- The **single source of truth** for runtime policy decisions in any agent
  runner that uses it. No duplicate policy in the runner, the tools, or
  anywhere else.
- A **structured audit producer** — every gated event is one JSONL line.
  One file across the agent family. The audit log IS the canonical cost
  record (the shared budget file is a derived live counter for cross-process
  speed).
- A **library**. There is no `bareguard serve`, no daemon mode, no network
  endpoint. It runs in-process with the agent runner.

## 4. What bareguard is NOT

- **NOT a content guardrail.** It does not check toxicity, PII, factuality,
  schema, persona, tone, topic blocklists, or hallucinations. That's
  `guardrails-ai`'s job, or a system prompt's job. The action vs content line
  is the single most important boundary — see §6.
- **NOT a sandbox.** It prevents an action from being called; it does not
  contain the action's effects. Containment is Docker, gVisor, Firecracker,
  or OS perms — a different layer.
- **NOT an identity / authn / authz layer.** It sees actions, not principals.
  Per-user policy is the caller's concern (pass a different `Gate` instance
  per user).
- **NOT an external-API rate limiter.** Rate-limiting Stripe or OpenAI is
  the API's job or a separate library's. bareguard rate-limits internal
  actions like `defer` and `spawn` because those are budget vectors.
- **NOT a scheduler.** It does not wake up, fire deferred actions, or run
  cron. It only validates actions when asked.
- **NOT a hosted service.** No SaaS, no telemetry, no phone-home. JSONL to
  a file or a callback; what users do downstream is their problem.
- **NOT a framework.** No plugin system, no hooks, no DSL, no YAML schema,
  no class hierarchies. The 12 primitives are functions; the gate is a
  class with ~10 methods. That's the whole API.
- **NOT MCP-aware.** It glob-matches strings. The `mcp:server/tool` naming
  convention is a *user-facing convention*, not parsing logic in bareguard.
- **NOT a long-running process.** It exits when the agent runner exits.

## 5. Why this exists

Two adjacent things already exist and neither solves this:

- **`guardrails-ai`** is content validation for LLM apps — toxic-language,
  regex match, schema validation, PII detection. It checks what the model
  *says*. Useful, but a different problem.
- **bareagent v0.x** previously shipped bash allowlist, token budget, gov
  layer (per-tool allow/deny/ask) as built-ins. That coupled them to one
  runner. bareguard extracts that policy layer so any runner can use it,
  and policy doesn't drift across the suite.

The gap is a small, runner-agnostic library focused entirely on the *action
side* of the agent loop, with first-class support for multi-agent (siblings
sharing budget), deferred work (rate-limited `defer()`), and MCP governance
through generic name-and-pattern matching. That's bareguard.

## 6. Core thesis: action vs content

**Action-bounding, not content-shaping.** The single test for any candidate
primitive:

> Does it constrain an action against the world (or against a sibling
> process), or constrain words the model produces?

If the latter, refuse — that's a system prompt's job, or `guardrails-ai`'s.
This rule keeps bareguard small forever.

| Layer                  | Concern                                  | Owner                |
| ---------------------- | ---------------------------------------- | -------------------- |
| System prompt          | What the model should be like            | The user's prompt    |
| `guardrails-ai`        | What the model is *allowed to say*       | guardrails-ai        |
| **bareguard**          | **What the agent is *allowed to do***    | **this library**     |
| Sandbox (Docker, etc.) | What the action can *affect*             | OS-level tooling     |
| OS perms / SELinux     | What the process can *touch*             | OS                   |

Five layers. bareguard owns exactly one. Everything else is somebody else's
library or somebody else's problem.

## 7. Positioning

|              | guardrails-ai                      | bareguard                                  |
| ------------ | ---------------------------------- | ------------------------------------------ |
| Concern      | Content (what the model says)      | Actions (what the agent does)              |
| Examples     | Toxicity, PII, schema, regex       | Bash, fs, net, tokens, cost, spawn, defer  |
| Multi-agent  | N/A                                | Shared budget, depth caps, parent stitching|
| MCP gov      | N/A                                | Glob-match `mcp:server/tool`; pattern args |
| Shape        | Framework + Hub + optional server  | Library, one file per primitive            |
| Deps         | Many                               | One (`proper-lockfile`)                    |
| Deployment   | npm/pip + config + sometimes server| `import`                                   |

**They compose, they don't compete.** A user wrapping a chatbot uses
`guardrails-ai`. A user building a coding agent uses bareguard. A user doing
both imports both.

## 8. The twelve primitives

Each is one file, ~30–180 LOC, composes through the single gate. **Severity
column** classifies what happens when the primitive fires (see §11 for the
halt-vs-action distinction).

| #  | Primitive            | Severity | What it checks                                                                                                          |
| -- | -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1  | **bash**             | action   | Command allowlist / denyPatterns when `action.type === "bash"`. With `allow` set, commands containing shell metacharacters (`;` `\|` `&` `$` backtick `()` `<>` newline) are denied (rule `bash.allow.shellMeta`) — a prefix allowlist can't bound a chain/pipe/substitution; use `content.denyPatterns` for chaining-aware screening. Reads `action.cmd`, falling back to `action.args.cmd` / `action.args.command` so wireGate-style `{type, args, _ctx}` adapters compose without translation. A present-but-non-string `cmd` is denied (`bash.invalidCmd`, v0.5) — closes a type-confusion fail-open. |
| 2  | **budget**           | **halt** | Tokens, cost USD, request count, with hard kill. Shared across sibling processes via backing file + `proper-lockfile`. The backing file is written **atomically** (temp file + `rename`, v0.5.1) so a racing reader never observes a truncated/empty file. |
| 3  | **fs**               | action   | Write/read scope; deny paths (`~/.ssh`, `/etc/passwd`). Paths are lexically normalized (`.`/`..` collapsed, and backslashes folded to `/` first so Windows-style traversal can't slip past — v0.5) and matched with segment boundaries before scope/deny — traversal can't escape a scope or deny entry. Symlinks are **not** resolved (canonicalize upstream if needed). Reads `action.path` / `action.args.path`; a present-but-non-string path is denied (`fs.invalidPath`, v0.5). |
| 4  | **net**              | action   | Egress domain allowlist; deny private IP ranges — covers IPv4 (incl. `127/8`, `10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16` / cloud metadata, `0.0.0.0/8`), IPv6 (loopback/ULA/link-local, bracket-stripped) and IPv4-mapped IPv6. Hostname-based, **pre-DNS-resolution** (no DNS-rebinding defense — defense-in-depth, not an SSRF boundary; use `allowDomains` to bound egress). Reads `action.url` / `action.args.url`; a present-but-non-string url is denied (`net.invalidUrl`, v0.5). |
| 5  | **limits**           | mixed    | `maxTurns` (**halt**, ticks on every `gate.record`), `maxToolRounds` (**halt**, ticks only on non-`"llm"` records — v0.4.2), `maxChildren` (action), `maxDepth` (action), `timeoutSeconds` (**halt**, v0.2). |
| 6  | **approval**         | n/a      | Routes ask events to the runner's `humanChannel` callback. No callback storage in v0.6.                                  |
| 7  | **tools**            | action   | Tool name allowlist / denylist (glob-matched) + per-tool `denyArgPatterns` (regex over args). Allowlist is **scope-only** — does NOT silence asks. |
| 8  | **secrets**          | n/a      | Redaction of `action` / `result` / `reason`. Env-var matches → `[REDACTED:VAR_NAME]`. Pattern matches → `[REDACTED:pattern=<short prefix>...]`. When `secrets` is configured the gate auto-redacts every audit line at write time (v0.4.5) — eval runs on the unredacted action so matching is never weakened. `redact()` also exported for ad-hoc use. |
| 9  | **audit**            | n/a      | Append-only JSONL of every gated decision. **One file per agent family** via POSIX `O_APPEND` atomicity (Windows uses lock fallback). Includes `parent_run_id` and `spawn_depth` for multi-agent stitching. |
| 10 | **defer-rate**       | action   | _(v0.2)_ Caps `defer()` calls per minute. Re-validates the deferred action's gate decision on emit AND on fire (defense in depth). |
| 11 | **spawn-rate**       | action   | _(v0.2)_ Caps `spawn()` calls per minute and per parent's lifetime. Composed with `limits.maxChildren` and `limits.maxDepth`. |
| 12 | **content**          | mixed    | Pattern-matches over `JSON.stringify(action)`. `denyPatterns` block (action). `askPatterns` escalate to human (action). Generic mechanism that catches dangerous *shapes* across all tools. **Safe defaults shipped (§11).** |

**Why `content` makes MCP gov work without MCP-specific code:** content patterns
run over the serialized action JSON, so the tool name AND every argument value
are in the haystack. A `bash` call with `cmd: "rm -rf /"` and an
`mcp:db.tool/query` call with `sql: "DROP TABLE users"` are both caught by the
same regex, regardless of which tool was invoked.

## 9. Architecture: one gate, complete mediation

```
agent decides action
   ↓
secrets.redact(action)              ← before anything sees it
   ↓
gate.check(action) → calls humanChannel internally on ask/halt;
                     returns terminal { outcome: "allow"|"deny", severity, rule, reason }
   ↓ (if allow)
execute(action)                     ← caller's runner does this
   ↓
gate.record(action, result)          ← appends audit, updates shared budget
   ↓
result back to agent
```

**Hard rules:**

- Every action traverses exactly one gate. No bypass paths.
- Tools never self-check. The bash tool runs the command, period. If it
  was called, gate already said yes.
- Agent never bypasses. Even scratchpad writes go through `fs` → gate.
- Gate is pure-ish: takes action + state, returns decision. The recorder
  side has audit + budget effects.
- One config object. One audit log per family. One budget ledger (the
  audit log is canonical; the budget file is a derived live counter).
- For multi-agent: parent and all children share the budget file via
  `proper-lockfile` AND share the audit file via `O_APPEND` (no lock).
- **`gate.check` and `gate.record` MUST be called serially per `Gate`
  instance.** Concurrent calls produce undefined `seq` ordering. Multiple
  Gate instances (parent + child processes) MAY run concurrently.

This is the security principle of **complete mediation**.

### 9.1 The 6-step evaluation order (load-bearing)

`gate.check(action)` runs through these checks in this exact order. **First
match wins** for terminal outcomes. The order is `deny > ask > scope >
default`.

```
PRE-EVAL (cross-cutting, all halt severity if triggered):
  P0. secrets.redact(action)        ← mutation, not a decision
  P1. budget.check()                ← halt if exceeded
  P2. limits.maxTurns               ← halt if exceeded
  P3. terminated check              ← halt if previously gate.terminate()'d

THE 6 STEPS (first match wins):
  1. tools.denylist                 → deny (action)
  2. content.denyPatterns           → deny (action)
  3. per-action-type deny rules     → deny (action)
        bash.denyPatterns / bash.allow / bash.invalidCmd (when action.type === "bash")
        fs.deny / fs.readScope / fs.writeScope / fs.invalidPath (when read/write/edit)
        net.allowDomains / net.denyPrivateIps / net.invalidUrl (when fetch)
        limits.maxChildren / limits.maxDepth (when spawn)
        tools.denyArgPatterns (any tool with matching args)
        (*.invalid* — present-but-non-string cmd/path/url is denied, not waved
         through; closes a type-confusion fail-open, v0.5)
  4. content.askPatterns            → askHuman (action; resolved via humanChannel)
  5. tools.allowlist enforcement    → set+match: allow; set+miss: deny (rule: tools.allowlist.exclusive)
  6. default                        → allow (rule: "default")
```

**Order rationale:** universal denies (1-3) catch everything dangerous
regardless of who allowed what. Universal asks (4) are the safety floor —
they fire even on allowlisted tools. Capability scope (5) restricts which
tools the agent can invoke at all. Default allow (6) is the bottom.

### 9.2 `tools.allowlist` is scope-only — NOT a trust shortcut

v0.4 of this PRD made allowlist short-circuit ask ("explicit listing =
explicit consent"). v0.6 reverses that. Allowlist now means **only "which
tools can be invoked at all":**

- **Unset or empty:** no effect; flow continues to step 6 (default allow).
- **Set with one or more entries:**
  - tool name matches → `allow` (rule: `tools.allowlist`).
  - tool name does not match → `deny` (rule: `tools.allowlist.exclusive`).

Both branches happen at step 5, AFTER `content.askPatterns` at step 4.
**Allowlisted tools still get asked** when they match a safe-default
askPattern (e.g., `delete`, `revoke`, `force-push`).

**Why the change** (foot-gun surfaced in POC phase 2): the v0.4 rationale
("explicit allowlist = explicit consent") assumed users allowlist specific
destructive entries like `mcp:linear.app/delete_comment`. In practice, users
allowlist general tools (`bash`, `fetch`, `read`) for everyday capability,
and the short-circuit silently disables the safe-default ask floor. That
conflicts with the §11 promise that safe defaults are the floor, not the
ceiling.

**For the v0.4 use case (silence ask on a specific known-destructive tool):**
- Trim or narrow `content.askPatterns` (caller-side override).
- OR use `tools.denyArgPatterns` for tool-specific rules.
- OR have the runner's `humanChannel` auto-approve known patterns.

The library no longer offers a "trust shortcut" via allowlist — that was the
foot-gun.

## 10. Public API

```js
import {
  Gate,                            // the orchestrator class
  redact,                          // standalone redaction helper
  defaultAuditPath,                // path resolver matching env-var convention
  BudgetUnavailableError,          // thrown on lock failure / corrupt budget file
  SAFE_DEFAULT_DENY_PATTERNS,      // exposed in case you want to extend
  SAFE_DEFAULT_ASK_PATTERNS,       // exposed in case you want to extend
  globToRegex, matchAny,           // glob helpers (v0.1: `*` only)
} from "bareguard";

const gate = new Gate({
  bash:    {
    allow: ["git", "ls", "cat", "rg"],
    denyPatterns: [/rm\s+-rf/, /sudo/, /curl.*\|.*sh/],
  },
  budget:  {
    maxCostUsd: 5.00,
    maxTokens: 100_000,
    sharedFile: process.env.BAREGUARD_BUDGET_FILE || null,  // null = process-local
  },
  fs:      {
    writeScope: ["./", "/tmp/agent"],
    readScope:  ["./", "/tmp/agent", "/etc/hostname"],
    deny:       ["~/.ssh", "/etc/passwd", "/.git/config"],
  },
  net:     {
    allowDomains: ["api.anthropic.com", "github.com"],
    denyPrivateIps: true,
  },
  limits:  {
    maxTurns: 50,
    maxChildren: 4,
    maxDepth: 3,
  },
  tools:   {
    allowlist: ["bash", "read", "write", "fetch", "spawn", "defer",
                "mcp_discover", "mcp_invoke", "mcp:linear.app/*"],
    denylist:  ["mcp:*/admin_*", "mcp:*/delete_*"],
    denyArgPatterns: {
      "mcp:linear.app/update_issue": [/priority.*critical/i],
    },
  },
  secrets: {
    envVars:  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
    patterns: [/sk-[A-Za-z0-9]{40,}/, /ghp_[A-Za-z0-9]{36}/],
  },
  content: {
    // omit to keep safe defaults from §11; or override:
    // denyPatterns: [...],
    // askPatterns:  [...],
  },
  audit:   {
    path: undefined,                 // default: $XDG_STATE_HOME/bareguard/<run-id>.jsonl
    // children inherit via env var BAREGUARD_AUDIT_PATH set by parent
  },
  // ONE callback for all human escalations (ask + halt + topup + terminate)
  humanChannel: async (event) => {
    // event.kind: "ask" | "halt"
    // event.action / event.severity / event.rule / event.reason / event.context
    return { decision: "allow" | "deny" | "topup" | "terminate", newCap?, reason? };
  },
});

// Three call sites, total:
const cleanAction = gate.redact(action);
const decision    = await gate.check(cleanAction);   // returns terminal allow/deny
await gate.record(cleanAction, result);

// Or one composed call:
const result = await gate.run(action, executor);

// Pure-query catalog pre-filter (no audit, no budget delta):
const ok = await gate.allows(action);                 // or gate.allows("tool_name") shorthand

// Halt context — deterministic stats over audit log:
const ctx = await gate.haltContext();

// Explicit (non-human-driven) terminate / cap raise:
await gate.terminate("operator finished cleanly");
await gate.raiseCap("costUsd", 10.00);
```

**That is the entire surface.** No subclassing, no plugin system, no hooks
framework, no DSL. `new Gate(config)` is the only canonical constructor.

### 10.1 The `humanChannel` contract (what bareguard does with each return)

| `decision` | Behavior |
|---|---|
| `"allow"` | Emit `phase: "approval"` audit line; gate.check returns terminal `allow`. |
| `"deny"`  | Emit `phase: "approval"`; gate.check returns terminal `deny` with severity preserved from the original ask/halt. |
| `"topup"` | Only meaningful for halt severity. Validates `newCap`. Calls `gate.raiseCap` internally (audit `phase: "topup"`). Re-evaluates the gate.check; max 5 topup iterations to prevent loops. For ask-severity events, treated as allow. |
| `"terminate"` | Emit `phase: "approval"` + `phase: "terminate"`; gate becomes sticky-terminated. Every subsequent check returns `deny` + halt + `rule: "gate.terminated"`. |

If `humanChannel` is **not registered** and an ask/halt fires:
- One-time stderr `WARN` line on first occurrence.
- Returns `deny` + halt + `rule: "...originalRule..."` + reason `"...originalReason... (no humanChannel registered)"`.
- Behavior is correct for headless / CI runs (deny = safe default when no
  human present).

**bareguard never caches humanChannel returns.** Every ask reaches `humanChannel` fresh — no allowlist of past `yes` answers, no TTL'd decision memo, no "you approved this shape once, don't re-ask." That's a deliberate non-goal (§17): "same action" has no universal definition (same args? same arg shape? same session? what TTL?), and that choice belongs to the runner's UX, not this library. README Recipe 8 ships a ~25-line wrapper that adds sticky approvals on top of the channel without touching the gate.

**Optional `humanChannelTimeoutMs`** (default: unset = wait forever). When set on the Gate config, bareguard races the `humanChannel` promise against a timer. If the timer wins, gate.check resolves to `{ outcome: "deny", severity: "halt", rule: <originalRule>, reason: "humanChannel timeout after Xms" }` and emits a `phase: "approval"` audit line carrying the timeout reason. The timeout always denies — there is no allow-on-timeout default. Callers wanting allow-on-timeout (e.g. autonomous fleets where one stuck branch shouldn't pin a worker) must implement that policy inside their own `humanChannel`, so the choice is explicit in user code, not a bareguard default. The pending channel promise is not cancelled; if it later resolves, the result is dropped (the agent will re-prompt on the next gate.check).

**`event.action` is ALWAYS the action being checked (v0.4 contract).** For ask events this is the action that fired the askPattern / approval rule. For halt events the cap was already exhausted on entry — this specific action did not by itself trip it — but it is the action whose evaluation surfaced the halt, and the right hook for caller-attached routing context (e.g. `action._ctx` in multi-tenant adopters that need to route halt prompts back to the originating principal). bareguard treats `action` as opaque pass-through; whatever the caller attaches survives verbatim into `event.action` and into audit `phase: "gate" | "record"` lines. The dedicated `phase: "halt"` audit line remains action-less by design (operator grep target with `dimension / spent / cap / rule / awaiting`).

### 10.2 `gate.allows(action)` — the catalog pre-filter

Pure query, no audit write, no budget delta, no humanChannel call. Used by
callers (e.g., bareagent's `mcp_discover`) to filter a catalog before showing
it to the LLM.

- Accepts a full action object **OR** a tool-name string (auto-wrapped to
  `{ type: name }`).
- Returns `true` for `allow` AND `askHuman` outcomes; `false` for `deny`.
  Reason: hiding ask-gated tools from the LLM means the agent never tries
  them, never gets the prompt. The whole point of askHuman is "human decides
  at invoke time" — that requires LLM visibility.

```js
const filtered = catalog.filter(t => gate.allows(t.name));
```

## 11. Safe defaults shipped out of the box

bareguard ships with these defaults baked into `content`. Users who want
pure-allow override with `content.askPatterns: []` and `content.denyPatterns:
[]`. Users who want stricter behavior add their own.

```js
// Default content config (overridable):
{
  denyPatterns: [
    /\bDROP\s+TABLE\b/i,
    /\bDELETE\s+FROM\s+\w+(?!\s+WHERE)/i,    // unqualified DELETE
    /\brm\s+-rf\s+\//,                        // rm -rf /
    /:(force|--force|-f)\s/,                  // force flags in serialized args
    /\bTRUNCATE\s+TABLE\b/i,
  ],
  askPatterns: [
    /\b(delete|drop|revoke|truncate|destroy|remove|purge)\b/i,
    /\bforce[- ]push\b/i,
    /"method"\s*:\s*"(DELETE|PUT|PATCH)"/i,   // destructive HTTP in args
  ],
}
```

This is ~10 lines of regex and it covers ~90% of what gets agents in trouble.

**Safe defaults are the FLOOR, not the ceiling.** They fire even on
allowlisted tools — that's the v0.6 reversal of the v0.4 short-circuit. If
they over-match for your use case, narrow them. The trade is intentional:
over-asking is recoverable; under-asking is incidents.

### 11.1 Halt-vs-action severity classification

Every decision carries `severity: "action" | "halt"`.

- **`severity: "action"`** — per-action policy decision. The runner returns
  the result (or structured error) to the LLM and continues the loop.
- **`severity: "halt"`** — run-level limit exhausted. **The runner MUST NOT
  bubble it to the LLM.** bareguard handles halt internally by calling
  `humanChannel`; the runner only sees the post-human terminal allow/deny.

**Halt-severity rules:** `budget.maxCostUsd`, `budget.maxTokens`,
`limits.maxTurns`, `limits.timeoutSeconds` (v0.2), `gate.terminated`. Every
other rule is action severity.

## 12. Audit trail spec

The audit log is bareguard's spine. **One file per agent family** — parent +
children + grandchildren all `appendFile` the same path. POSIX `O_APPEND`
guarantees atomicity for writes < `PIPE_BUF` (4KB on Linux/macOS); same
mechanism nginx access logs use. Windows uses a `proper-lockfile` fallback
(auto-detected via `process.platform`).

**Format:** JSONL, one line per gated event, append-only.

**Default path** (in order, first that resolves):
1. `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl`
2. `$HOME/.local/state/bareguard/<root-run-id>.jsonl`
3. `./bareguard-<root-run-id>.jsonl` (cwd fallback)

Children inherit via env var `BAREGUARD_AUDIT_PATH` set by the parent.

**Required fields on every line:**

```json
{
  "ts": "2026-04-30T14:32:11.482Z",
  "seq": 1247,
  "run_id": "uuid",
  "parent_run_id": "uuid|null",
  "spawn_depth": 1,
  "phase": "gate"
}
```

**Phases:**

| `phase` | When emitted | Phase-specific fields |
|---|---|---|
| `gate` | every `gate.check()` decision | `action`, `decision`, `severity`, `rule`, `reason` |
| `record` | every `gate.record()` after a successful execute | `action`, `result` (incl. `costUsd`, `tokens`) |
| `approval` | `humanChannel` returned a decision | `decision`, `reason`, `newCap` |
| `halt` | dedicated grep target on halt | `dimension`, `spent`, `cap`, `rule`, `awaiting` |
| `topup` | runner / humanChannel raised a cap | `dimension`, `oldCap`, `newCap` |
| `terminate` | gate terminated (graceful) | `reason` |

**Properties:**

- Redaction happens **before** gate sees the action. Audit lines never
  contain action-side secrets.
- **Caller is responsible for redacting tool results** before passing to
  `gate.record`. bareguard ships the `redact()` helper — apply to results too.
- Budget remaining = `initial - sum(record.result.costUsd)` over the log.
  Reconstructable from the audit log on cold start (used when the budget
  file is missing/corrupt).
- Monotonic `seq` per gate instance. Helps detect gaps within a process.
- **Truncation:** lines > 3.5KB (safety margin under PIPE_BUF) get truncated
  with explicit `_truncated: true` boolean at line root for downstream
  consumers, plus inline `[TRUNCATED:n bytes]` markers in the field that
  was cut.

**Output sink:** file path OR callback function. Nothing else. (Datadog,
Loki, S3 are caller-side adapters.)

**Fileless mode (v0.4, test-only):** setting `audit.path: null` explicitly
puts the Audit instance in in-memory mode. `emit` pushes parsed line
objects onto `gate.audit.entries`; no fs writes, no PIPE_BUF truncation.
`audit.readAll()` returns the in-memory entries. Intended for unit tests
that want to assert on the audit stream without stubbing fs. Distinct
from `audit.path: undefined` which falls through to env var / XDG default.

## 13. Shared budget across processes

When a parent spawns a child and both should draw from the same budget
ceiling, configure `budget.sharedFile`. Implementation uses
`proper-lockfile` (the one allowed dep).

**Format of the shared budget file (versioned per amendment §16):**

```json
{
  "version": 1,
  "cap_usd": 5.00,
  "spent_usd": 1.23,
  "cap_tokens": 100000,
  "spent_tokens": 24500,
  "started_at": "2026-04-30T14:00:00Z",
  "updated_at": "2026-04-30T14:32:11Z"
}
```

bareguard reads `version` on init and refuses unknown versions with a
`BudgetUnavailableError`. v0.1 only writes v1.

**Refresh policy (lazy, not per-check):**

- On `init()`: read the file, populate local cache.
- After every `record()`: write under lock; refresh cache from post-write state.
- On lock acquisition (any reason): refresh while holding the lock.
- **NOT on `gate.check()`:** trust the local cache.

**Worst case:** another process's record between two of our checks isn't
visible until our next record or lock. Budget may be exceeded by one
action's spend. Halt fires reliably on the next check after a record.
Caps are soft by design.

**Failure modes addressed:**

- Lock leftover from crashed process → `proper-lockfile` handles stale lock
  detection by default.
- Concurrent writes → serialized.
- **Torn/empty read under contention (v0.5.1)** → writes are atomic (serialize
  to a unique temp file, then `rename` over the target — atomic within a
  filesystem; an atomic replace on Windows via libuv). A plain `writeFile`
  (open `O_TRUNC`, then write) exposed a zero-length window where a racing
  reader could `JSON.parse` an empty string and misfire the corruption path
  below; the atomic write removes that window so a reader always sees a
  complete old-or-new file.
- Budget file corruption → JSON parse error surfaces; rebuild from audit log
  if possible, else surface `BudgetUnavailableError` and terminate cleanly.
  (Distinct from the torn-read case above, which is now eliminated — a parse
  error now means genuine corruption, not a transient truncation.)
- Cross-machine → NOT supported in v1. Single-machine only. See §17.

Children inherit the path via env var `BAREGUARD_BUDGET_FILE`, set by the
parent's `spawn` tool.

### 13.1 Strict mode (v0.4, opt-in)

Default budget behavior is soft per §13: caps are tripped on the first
check AFTER `spent >= cap`. The previous action's spend is the slack —
unavoidable when cost is only known post-execute.

`budget.strict: true` adds a pre-flight projection. The Budget instance
maintains a rolling buffer of the last 5 `record.result.{costUsd,tokens}`.
On every `gate.check` (PRE-EVAL halt phase), if the buffer has **≥3
samples**, bareguard halts when:

```
spent + last5Avg > cap
```

per dimension. The halt fires BEFORE the action executes, eliminating
the soft-cap slack at the cost of one "false halt" worth of variance
(when an unusually cheap action would have fit but the average wouldn't).

- Rule name unchanged: `budget.maxCostUsd` / `budget.maxTokens` (so
  existing humanChannel routing keeps working).
- Reason string is distinct: `strict: spent $X + est $Y > cap $Z`.
- Cold start: <3 samples → behaves as soft (no projection halt).
- `humanChannel` `topup` re-evaluates as usual; once `cap > spent + avg`,
  the next check passes.
- **Per-instance, local-only.** The buffer is in-memory on each Gate.
  In shared-file multi-process setups, each Budget sees only its own
  deltas. Strict's intended use is tight-cap single-agent loops with
  variable per-turn cost, not cross-process consensus.

`budget.strict` defaults to `false`; existing adopters see no behavior
change.

## 14. Spawn and defer guards

These primitives exist because of bareagent's `spawn` and `defer` tools.

### 14.1 `limits.maxChildren` and `limits.maxDepth`

- **Per-parent:** a parent agent can spawn at most `maxChildren` children
  concurrently and over its lifetime.
- **Per-tree:** total depth from root cannot exceed `maxDepth`.

Tracked in the audit log; reconstructed on startup from the log if needed.
Without these, one bug spawns 10K agents and burns the budget in 30 seconds.

### 14.2 `defer.ratePerMinute` (v0.2)

Caps how many `defer` actions a single agent run can pass through the
gate per minute. Default: **15** (down from the v0.4 baseline of 30 — easier
to relax than tighten). Prevents a confused agent from emitting 1000 jobs
into the queue.

Counted from the audit log, not a separate counter file. Per-family
(across the spawn-tree rooted at the topmost `run_id`), not per-process —
otherwise children spawned by a fork-bomb-shaped agent each reset to
`0/cap`. Per-family scope is automatic: the audit file is keyed by
`root_run_id` and inherited by spawned processes via
`BAREGUARD_AUDIT_PATH`.

### 14.3 `spawn.ratePerMinute` (v0.2)

Same idea for `spawn`. Default: 10. Prevents fork-bomb shapes even if
`maxChildren` is set generously. Composes with `limits.maxChildren`
(concurrency cap) and `limits.maxDepth` (depth cap) — this is rate, not
concurrency.

Counted from the audit log, per-family — same mechanism as
`defer.ratePerMinute` (§14.2).

### 14.4 Defense in depth: re-validate deferred actions on fire

A defer is **two separate `gate.check` calls against two distinct actions** —
the `defer` action at emit (which the rate cap counts), and the inner
action at fire (which goes through the gate independently). Each call
produces its own audit record.

When the wake script reads a deferred action and invokes bareagent to fire
it, the fired action passes through the gate as its own type (`bash`,
`fetch`, etc.) — not as `defer`. A defer whose inner action would be
denied at fire time (budget exhausted, target file no longer in fs scope,
new content rule added) is denied at fire time. The audit log records
both the emit decision and the fire decision.

### 14.5 Audit log as the rate counter

Both rate caps count records in the audit log within a trailing 60s
window. **No separate counter file.** Eliminates a second source of truth
and keeps cross-process correctness automatic via the existing single-file
audit (POSIX `O_APPEND`, family-scoped path, inherited across spawned
processes). One source of truth — the audit log — for both spend (`record`
phase) and rate (`gate` phase, type-filtered).

## 15. The `tools` vs `content` distinction (frequently confused)

| Rule                       | Looks at                  | Match type | Outcome     | Example                                                |
| -------------------------- | ------------------------- | ---------- | ----------- | ------------------------------------------------------ |
| `tools.allowlist`          | tool name                 | glob       | allow (scope) | `"mcp:linear.app/*"`                                   |
| `tools.denylist`           | tool name                 | glob       | deny        | `"mcp:*/delete_*"`                                     |
| `tools.denyArgPatterns`    | action.args (per tool)    | regex      | deny        | `{ "update_issue": [/priority.*critical/] }`           |
| `content.denyPatterns`     | full serialized action    | regex      | deny        | `/DROP\s+TABLE/i`                                      |
| `content.askPatterns`      | full serialized action    | regex      | ask human   | `/\b(delete\|drop\|revoke)\b/i`                        |

**When to use which:**

- **`tools` rules** when the dangerous thing is identifiable by tool name.
  Cheap to express, zero false positives.
- **`content.denyPatterns`** for dangerous payload shapes that show up
  across many tools — SQL injection patterns, force flags, destructive HTTP
  methods.
- **`content.askPatterns`** for "probably fine but worth confirming."
  Prompts the human; doesn't block.
- **`tools.denyArgPatterns`** when you trust a tool generally but want to
  block specific argument shapes.

## 16. MCP governance (Path A)

bareguard governs MCP tools through the same primitives that govern bash
and fetch. There is no MCP-specific code in bareguard.

### 16.1 The flow

1. `bareagent.mcp_discover()` — bareagent reads MCP server catalogs, caches
   for 30 days. **bareguard is not consulted.** Discovery is metadata
   access, not an action.
2. `bareagent.mcp_invoke(toolName, args)` — bareagent invokes the MCP tool.
   **bareguard's `tools` and `content` primitives check it** as it would
   any other action. Tool name (e.g., `mcp:linear.app/list_issues`) is
   glob-matched; args are regex-matched.

### 16.2 Why "Path A"

Path A is sufficient: same machinery as bash gov, just with longer tool
names. bareguard stays catalog-blind, which is a feature:

- The policy library doesn't grow MCP-shaped knowledge.
- It doesn't break when the catalog refreshes.
- Users can change MCP servers without touching bareguard config.

### 16.3 `gate.allows()` as an ergonomic, not a gov mechanism

bareagent can call `gate.allows(toolName)` during `mcp_discover` to filter
the catalog before showing it to the LLM. Pure context optimization. Gov
decisions still happen at invoke time via `gate.check()`.

### 16.4 Tool name convention and glob semantics

`mcp:<server-host>/<tool-name>` — string convention bareguard glob-matches.

**Glob in v0.1: `*` only, matches any character including `/`.** No `?`,
no `[abc]`, no escapes. Trade-offs:

- For denylists: safe (denies more, never less). `mcp:*/admin_*` catches
  `mcp:foo/admin_baz` AND `mcp:foo/admin_baz/sub/path`.
- **For allowlists: can over-grant.** `mcp:linear.app/*` matches
  `mcp:linear.app/list_issues` AND `mcp:linear.app/sub/foo`. Err narrow on
  allowlists; list specific tools when possible.

v0.2 may add shell-style `**` so `*` becomes "anything except `/`". Not
v0.1.

## 17. NO-GO list

Recorded explicitly so future contributors and future-you don't re-litigate.
Each entry was discussed during design and consciously excluded.

| Out                                                  | Why                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Topic blocklists ("don't discuss politics")          | System prompt's job, or guardrails-ai. Content, not action.                      |
| Persona / tone constraints                           | System prompt.                                                                   |
| Output schema validation (JSON, Zod)                 | guardrails-ai already does this well. Or Zod, in the caller's code.              |
| Hallucination / factuality detection                 | Model-side problem. Hard. Not our fight.                                         |
| "Constitutional AI" rule sets                        | That's a *training* method, not a runtime library.                               |
| PII / toxicity classifiers                           | guardrails-ai Hub has many of these. Don't reimplement.                          |
| Telemetry of any kind                                | Bare suite philosophy. No phone-home, ever.                                      |
| Remote audit sinks (Datadog, S3, Loki)               | That's an adapter the user writes. We produce JSONL; they pipe it.               |
| Hosted / SaaS version                                | Bare suite philosophy.                                                           |
| Dashboards / alerting / SIEM integration             | Downstream of the JSONL. Not core.                                               |
| Anomaly detection on audit log                       | Same — downstream.                                                               |
| Log rotation                                         | `logrotate` exists. README documents the pattern.                                |
| Hash-chain tamper-evidence                           | Opt-in flag in v0.x at earliest, or sibling library. Not v1 default.             |
| Plugin system / hooks framework                      | Composition is via importing primitives. No framework.                           |
| Config DSL or YAML schema                            | Plain object. If users want YAML, `js-yaml` is one line in their code.           |
| Multi-language SDK in v1                             | Node-first. Port later if there's pull.                                          |
| Hosted policy distribution                           | No.                                                                              |
| ML-based action classifiers                          | No. Rules are explicit, auditable, deterministic. That's a feature.              |
| Per-user / per-tenant policy management              | Caller's concern. Pass a different `Gate` instance per config.                   |
| Approval UI                                          | `humanChannel` callback only. Caller wires it to TUI / Slack / web / PIN.        |
| Sandboxing (Docker, gVisor, Firecracker)             | Different layer. bareguard prevents the call; sandboxing contains effects.       |
| Cross-machine distributed budget                     | Single-machine `proper-lockfile` is v1. Cross-machine = future sibling library.  |
| Identity / authn / authz                             | Caller's concern. bareguard sees actions, not principals.                        |
| **PIN / biometric / second-factor for approvals**    | Authentication is the runner's UX. bareguard says "ask the human"; how the human is verified is the runner's choice. |
| Rate limiting against external APIs                  | The API does this; or use a separate rate-limit library. Not bareguard's role.   |
| Built-in scheduler                                   | bareagent's `defer` tool emits records; cron / `wake.sh` / future `barejob` runs them. |
| Long-running daemon mode                             | bareguard is a library, not a service. No `bareguard serve`.                     |
| MCP-specific parsing / awareness                     | bareguard glob-matches strings.                                                  |
| MCP server registry or aggregator                    | Different layer. bareguard doesn't connect to MCP servers; bareagent does.       |
| **LLM-self-estimate of remaining work at halt**      | Speculative; costs tokens at the worst time; LLMs are bad self-estimators. bareguard provides deterministic stats only. |
| **Concurrent gate.check (within one Gate instance)** | Agent loops are naturally serial. Documented contract is "one in flight."        |
| **Allowlist as a "trust shortcut" silencing asks**   | Was a foot-gun in practice. Allowlist is scope-only; askPatterns always fire.    |
| **Stateful rate counter file**                       | Audit log already has every `phase: "gate"` record with timestamp + `run_id`; counting it is deterministic and correct across processes for free. |
| **Sticky / cached approvals (memoized `humanChannel` returns)** | Each `gate.check` ask reaches `humanChannel` fresh. Caching past `yes`es belongs in the runner's `humanChannel`, not the gate. "Same action" has no universal definition (same args? same arg shape? same session? what TTL?) and freezing one inside bareguard freezes it for everyone. README Recipe 8 is a ~25-line `humanChannel` wrapper covering the common shape. Audit log records every `phase: "approval"` line so external memoizers can warm from it. |

**Adding any of these dilutes the one thing this library does.** Point users
at this list when they ask.

## 18. Language & runtime

**Node.js 20 LTS+, ESM only.**

- **Stdlib:** `fs/promises`, `path`, `crypto`, `process`, `events`, `os`.
- **One allowed production dep: `proper-lockfile`** for the shared budget
  file (and Windows audit fallback). Justification: file locking with
  stale-lock detection is genuinely hard cross-platform. Inline
  implementations fail on NFS, Windows, and crashed processes.
- **No** `commander`/`yargs` — bareguard has no CLI of its own.
- **No** test framework in the package; tests use Node's built-in test
  runner (`node:test`).

**Production deps target: 1.** Hard target. Any deviation requires explicit
justification in the PRD.

**TypeScript types (v0.5).** bareguard stays plain ESM JS — but the public API
carries full JSDoc, and `.d.ts` is generated from it (`tsc --emitDeclarationOnly
--allowJs`) into `types/`, built by the `prepublishOnly` script and shipped via
the `files` allowlist (not committed). JSDoc is the single source of truth; named
config types are importable from the root or the `bareguard/types` subpath.
`typescript` is a **dev** dependency only — the production-dep target of 1 is
unchanged. The `tsc` typecheck job runs `tsconfig.json` with `strictNullChecks`
enabled (v0.5.2), which gates the sources for null safety as well as validating
the JSDoc behind the emitted declarations. (Full `strict` stays off: the
hand-written JS trips ~130 unrelated strict errors that don't affect the public
types.) v0.5.0's separate strict consumer-resolution fixture was dropped in
v0.5.2 — it checked a stub while missing the real null hazards in the source, so
`strictNullChecks` on the source itself is both simpler and more thorough.

## 19. Migration plan (post-v0.1.1)

Three releases.

### bareguard 0.1 — extraction baseline (SHIPPED 2026-04-30)

Released on npm as `bareguard@0.1.0`, patched to `0.1.1` same day with
pre-publish review fixes. Includes:

- All primitives 1–9 + 12 (every primitive except `defer-rate` and `spawn-rate`).
- Shared budget file with `proper-lockfile` (originally scheduled for 0.2;
  brought forward).
- Halt-vs-action severity classification.
- `humanChannel` callback consolidating all human escalations.
- Single-file audit via POSIX `O_APPEND` (Windows lock fallback).
- Multi-agent stitching via env vars (`parent_run_id`, `spawn_depth`).
- `gate.allows(action | string)` catalog pre-filter.
- `gate.haltContext()`, `gate.terminate()`, `gate.raiseCap()`.
- Safe defaults shipped per §11.

bareagent v(next) imports `bareguard ^0.1`. Removes its built-in policy code
(see bareagent PRD §9.1 for the concrete removal list).

### bareguard 0.2 — rate limits + bareagent-driven additions

- `defer-rate` (#10) and `spawn-rate` (#11) primitives. They land alongside
  bareagent v(next+1)'s `defer` and `spawn` tools that exercise them.
- `**` glob support if bareagent integration surfaces real allowlist
  over-grant pain (deferred per §16.4 / v0.6 §9).
- Sliding-window rate (if fixed-window proves insufficient).

### bareguard 0.4 — multis-driven adoption tweaks (SHIPPED)

Halt-event action contract, fileless audit (test-only), strict budget mode,
flat/nested action-shape acceptance, secrets auto-redaction at the audit
boundary, and shared-budget lock hardening (fail-loud on corrupt read).

### bareguard 0.5 — TypeScript types + policy-bypass hardening (SHIPPED 2026-05-29)

- **Ships `.d.ts` generated from JSDoc** (`0.5.0`) — typed consumption with no
  `@types` package; `typescript` is a dev dep only (prod-dep target stays 1).
- **Type-confusion fail-open closed** (`0.5.0`): a present-but-non-string
  `cmd` / `path` / `url` is denied (`bash.invalidCmd` / `fs.invalidPath` /
  `net.invalidUrl`) instead of waved through to the allowlist.
- **Windows scope escape closed** (`0.5.0`): `fs` folds `\` → `/` before
  lexical normalization.
- **Glob `*` matches line terminators** (`0.5.0`, dotAll) — closes a
  `tools.denylist` bypass.
- **Atomic shared-budget write** (`0.5.1`, temp file + `rename`) — removes the
  torn/empty-read window that intermittently misfired the corruption path.
- Documented (not changed): `denyPrivateIps` is literal-host/pre-DNS;
  `secrets.envVars` skips values < 8 chars.

### bareguard 1.0 — stabilize

- Lock the API. SemVer commitments.
- Walk-away: maintenance only after this point.

**DECISION (2026-06-09): HOLD at 0.5.x.** Version numbers are decisions, not counters —
1.0 can cut from 0.5.x any day; the question is only readiness to make the promise.
Holding because the first real external consumer (litectx via the Software Factory —
harness-prd §9.3.4) has not yet exercised the seam: locking before the swap-point test
and integration bench run is the one scenario that risks an early 2.0.

**Gate to cut 1.0 (all three):**
1. The seam exercised by a real consumer (harness-prd §9.3.4 items 1–2: swap-point
   confirmation + integration bench) with no API regret surfaced.
2. The **last-call breaking-change review** below resolved (each item changed or
   explicitly kept — breaking changes are cheap at 0.x, expensive forever after).
3. The §21 unchecked box decided: do the bareagent deprecation re-exports first, or
   amend the criterion and ship without (defensible — it gates bareagent's cleanliness,
   not this API).

**Last-call breaking-change review (open items, decide before lock):**
- **Empty `tools.allowlist` fails OPEN** — `[]` is treated as not-configured → step 5
  skipped → default allow (verified vs `src/primitives/tools.js`; documented as the
  cookbook's headline foot-gun). Flip to fail-closed / throw-on-construct, or keep and
  lock the documented behavior?
- **`budget.strict` default for money caps** — `check()` halts post-fact (`spent ≥ cap`
  = cap + one action overshoot); decide if `strict` projection becomes the default for
  `maxCostUsd` (the §19 Budget candidate's semantics flag).
- **Confirm-and-lock** (intentional, just ratify): `allows()` returns true for
  ask-gated tools; no-`humanChannel` ask/halt → deny with severity halt; topup-on-ask
  treated as allow.

**What the 1.0 promise covers when cut** (the SemVer surface): exports (`Gate`,
`redact`, `Budget` errors, `defaultAuditPath`, `globToRegex`/`matchAny`), config keys,
**rule strings** (adopters and the seam contract test match on them), the audit JSONL
line format, the budget file format, and the `humanChannel` event/decision contract.

**Pending/future work index while holding** (so nothing lives only in chat): this
section (1.0 gate) · §19 future candidates above (Budget, Audit, tamper-evident — all
demand-gated) · harness-prd §0.1.1 (pre-litectx backlog: EMPTY except the optional
Axis-B detect-and-feed-A recipe) · harness-prd §9.3.4 (waits-on-litectx) · harness-prd
§10 OQ1 (declaration format only; skeleton settled per §6.5) / OQ2 (likely never).

### Future features (candidates — not committed)

Ideas that cleared "interesting" but not the §17 / Appendix C bar yet. Parked here
so they're not re-litigated from scratch.

**Tamper-evident audit (hash-chained / signed log).** Optionally chain each audit
entry (`sha256` over the previous hash + the entry) so post-hoc edits, deletions,
or reorders become detectable — and, as a later step, sign the chain head for
non-repudiation. Currently a NO-GO *default* (§17: "opt-in flag at earliest, or
sibling library").

- *Status:* **needs more design time before it ships, even as a flag.** A throwaway
  POC proved the mechanism works in ~40 LOC with zero new deps, but surfaced the
  load-bearing constraint: bareguard's audit is **multi-writer and lock-free**
  (parent + children all `O_APPEND` one file with no coordination). A *global*
  chain across writers is impossible without taking a lock on every `emit`, which
  would undo the design the whole audit primitive rests on. A **per-`run_id`** chain
  is feasible (each `Audit` instance is a serial writer for its own run) but only
  detects tampering *within* a run — not global cross-run ordering, and not whole-run
  deletion. And a hash chain is **integrity, not authorship**: anyone who can rewrite
  the file can recompute a valid chain unless the head is signed.
- *Why parked:* a naive `audit.hashChain` flag oversells "tamper-proof" given the
  per-run caveat. The per-run-vs-global boundary and the signing/non-repudiation
  story need to be designed and documented *before* exposing anything, or it becomes
  a footgun. Likely lands as a clearly-scoped opt-in flag or a sibling library
  (`bareseal`-style), never a v1 default.
- *Origin / relation:* prompted by [bindu](https://github.com/GetBindu/bindu)'s
  Ed25519-signed A2A records, but this is integrity of bareguard's **own log**, not
  agent authentication — bareguard authorizes the action, not the actor. See
  [identity-and-the-gate.md](../02-features/identity-and-the-gate.md).

**Budget: generalized cumulative dimensions + soft/hard split (PROPOSED 2026-06-09;
harness-prd OQ3).** Two additive extensions to the shipped `Budget`, *not* a rewrite:
(1) generalize the cumulative counter beyond `costUsd`/`tokens` to arbitrary countable
resources (sends, rows, bytes) via a cap-map over the same mechanism; (2) a
soft-threshold `warn` decision (e.g. at 80% of cap) ahead of the existing hard halt.

- *Status:* **PROPOSED — earned by POC evidence, gated on a real driver.** The harness
  POC gate E3 (`harness-code-mode/run-e3.mjs`) proved empirically that the cumulative
  tier is the real wall (a per-action regex is decomposable: €200+€200 walked past a
  `>€300` ask; `budget.maxCostUsd: 300` halted the same split) — but E3 had to model €
  charges *as* `costUsd` because no other dimension exists. A real non-money resource
  (sends, rows) needs the generalization. E3 also surfaced a semantics question to
  settle at build time: `check()` halts POST-FACT (`spent ≥ cap` — exposure bounds to
  cap + one action); decide whether `strict` projection becomes the default for
  hard-money caps.
- *Why parked:* no adopter counts a non-money resource yet, and the soft/hard tier
  prior comes from a design that was never built (aurora's tiered cost model —
  design-only, an unvalidated prior). Appendix E says prefer-extend over new primitive;
  a separate `limits.cumulative` is justified only if the data model genuinely
  diverges. Build + integrate + validate in one motion when a driver appears.
- *Origin / relation:* harness-prd §10 **OQ3** (decision recorded there 2026-06-04:
  hard-cap-first; tiered is an extension). Candidate first user: a memory-engine
  adopter bounding `memory.write` counts per run (harness-prd §9.3.2 scenario 3).

**Audit: request + return on one line (PROPOSED 2026-06-09; harness-prd OQ4).** Log
the gated request and its result together (or deterministically joinable) so
ask-vs-outcome reconciliation is reconstructable from the log without re-stitching
JSONL phases.

- *Status:* **PROPOSED — mechanic shown, shape undecided.** The harness POC gate E2
  proved the value of an independent return-side fact at the approval moment
  (detect-and-feed-A); a2a §12.2 is the evidentiary base ("log the request alongside
  the response so ask-vs-response is reconstructable"). Today `phase:"gate"` and
  `phase:"record"` lines both carry the full `action` but share **no per-action id** —
  joinable by content match or proximity, which goes **ambiguous exactly when the same
  action repeats** (the E3 decomposition case: N identical `pay €200` lines).
- *Why parked:* the cheap version (echo an action id on the `record` line) is small,
  but the line-bloat and truncation interaction (`_truncated`) need a look, and no
  consumer reconciles today. If Axis-B reconciliation (harness-prd §8) ever builds,
  this is the audit shape it feeds — but it must not wait for, or assume, Axis B.
- *Origin / relation:* harness-prd §10 **OQ4**; a2a-intent-drift §12.2.

## 20. POC retrospective (what we built, why)

bareguard v0.1 was developed via three POC phases (per the original v0.4
§20). All three passed; total source 931 LOC; 33 tests pass on the CI matrix
(Linux/macOS/Windows × Node 20/22). The POC files were deleted before v0.1.0
publish (git history retains them).

- Phase 1 — single gate with bash + budget + audit, 6-step eval order: 8/8.
- Phase 2 — fs + net + secrets + content + safe defaults + JSONL audit +
  severity field + halt flow + shared budget + audit reconstruction: 13/13.
- Phase 3 — multi-process (parent + 2 children + grandchild), shared budget
  under real lock contention, halt cascade across processes,
  `limits.maxChildren`, `limits.maxDepth` in a 3-deep tree, audit stitching:
  12/12.

## 21. Success criteria for v1.0.0

- [x] Twelve primitives implemented (10 in v0.1, 2 in v0.2).
- [x] Total source ≤ 1000 LOC excluding tests and docs (931 LOC in v0.1.1).
- [x] One production dep (`proper-lockfile`); no others.
- [x] Single gate is the only decision path. No tool self-checks.
- [x] Single JSONL audit file per agent family. Budget reconstructable from log on startup.
- [x] 6-step evaluation order implemented exactly per §9.1; verified by table-driven test.
- [x] Safe defaults shipped per §11; verified by test (no user config, agent attempts `rm -rf /` → denied; `delete X` → asks human via humanChannel).
- [x] Shared budget across sibling processes verified by integration test (parent + 2 children sharing $5 cap, audit shows correct total).
- [x] `parent_run_id` and `spawn_depth` correctly threaded through 3-deep spawn tree.
- [x] Secrets redaction runs before gate sees action; verified by test.
- [x] `defer.ratePerMinute` and `spawn.ratePerMinute` actually fire (verified by test) — **shipped in v0.2**.
- [x] `gate.allows()` is pure-query (no audit write, no budget change); verified by test.
- [x] MCP tool names glob-matched correctly with `mcp:server/tool` convention.
- [x] README integration example works copy-pasted into a fresh repo.
- [ ] bareagent migrated; old paths re-exported with deprecation warnings — **v(next)**.
- [x] NO-GO list (§17) included verbatim.
- [x] Decisions log (§22) included verbatim.
- [x] Published to npm as `bareguard`.
- [x] Cross-linked from bareagent's README.

## 22. Decisions log (for future Claude)

These were resolved across the design conversations and should not be
re-litigated unless the user explicitly asks.

### Original v0.4 decisions

- **bareguard owns all policy.** Bash, budget, fs, net, secrets, approval,
  tools, content, audit, defer-rate, spawn-rate, limits — all live here.
  bareagent has no `if allowed:` checks.
- **Single gate, complete mediation.** Every action goes through one
  `gate.check`. Tools never self-check.
- **6-step evaluation order is load-bearing.** Implement exactly. (Note:
  the v0.4 short-circuit was reversed — see "v0.5 reversals" below.)
- **Audit log is canonical; budget file is derived.** One source of truth
  for history; one fast counter for cross-process. Reconstruct file from
  audit on startup if missing/corrupt.
- **No content guardrails.** Toxicity, PII, schema — `guardrails-ai`'s job.
- **`content` primitive is action-side, not content-side.** It pattern-
  matches the SERIALIZED ACTION JSON.
- **MCP gov is invocation-level, not catalog-level (Path A).** bareguard
  never sees the MCP catalog.
- **Tool name convention `mcp:server/tool`.** String convention for
  glob-matching.
- **`gate.allows()` is ergonomic, not gov.** Pre-filter only.
- **Safe defaults ship.** Default-allow + opt-in safety produces incidents.
- **One allowed production dep: `proper-lockfile`.**
- **No telemetry, ever.**
- **Walk-away after v1.0.** New features = new sibling repos.
- **JavaScript is the language.** Bare suite consistency.

### v0.5 reversals and additions

- **Halt is a separate severity from deny.** Run-level limit exhaustion
  (budget, maxTurns) MUST go to a human, MUST NOT bubble to the LLM.
  Per-action denies do bubble.
- **Shared budget file is v0.1, not v0.2.** Pre-allocation alternatives are
  too rigid; the bespoke extension protocol is more complex than the dep.
- **Allowlist is scope-only, not a trust shortcut.** v0.4's short-circuit
  rationale was a foot-gun: allowlisting general tools silently disabled the
  safe-default ask floor. Allowlist now only enforces capability scope;
  askPatterns always fire.
- **Per-action-type primitives sit at step 3 (universal-deny phase).**
  Deny > ask > scope.
- **No LLM speculation on halt.** bareguard provides deterministic stats only.
- **Glob `*` matches `/` in v0.1.** Layered defense covers over-match risk.
  v0.2 may introduce `**` if real pain emerges.
- **Result redaction is the caller's responsibility.**
- **`gate.allows(action)` returns true for askHuman.** Catalog pre-filter
  must show ask-gated tools.
- **`humanChannel` consolidates ALL human escalations.** One runner-supplied
  function; bareguard calls it; applies decisions atomically; returns
  terminal allow/deny.
- **Single audit file with `O_APPEND` atomicity.** No per-process files;
  Linux/macOS primary; Windows uses lock fallback.
- **Budget file format is versioned.**
- **Budget cross-process refresh is lazy.** Refresh post-record and on-lock.
- **gate.check / record are serial per gate instance.**
- **v0.1 scope: everything except rate limits.**

### v0.1.1 review fixes

- **`gate.allows(string)` shorthand.** Object form still works; string is
  for catalog pre-filters that only have the name.
- **`_truncated: true` boolean at audit line root** when truncation happens.
- **One-time stderr WARN when `humanChannel` is unset** and an ask/halt
  fires. Behavior unchanged (still denies with severity:halt).
- **`Gate.fromConfig` removed.** `new Gate(config)` is the only canonical
  constructor.

### v0.4 additions (multis-driven adoption tweaks)

- **Halt events carry `event.action`.** v0.1's `event.action = null for halt`
  was a design choice that turned out to block multi-tenant halt routing.
  At halt time we DO know the action being checked; passing it through
  is cleaner than the alternative (instance-state `lastAction`) and works
  for any Gate shape. Halt audit lines (`phase: "halt"`) remain action-
  less — they're the operator grep target, not the routing hook.
- **Fileless audit (`audit.path: null`).** Opt-in in-memory entries for
  tests. Explicit null (not undefined) — undefined still falls through
  to env / default. `humanChannel: async () => ({decision: "deny"})` is
  the documented test idiom; rejected magic-string shorthands like
  `'deny-all'` (overloaded function args are a smell).
- **Strict budget (`budget.strict: true`).** Per-dimension trailing-avg
  pre-flight halt. Requires ≥3 samples; defaults off. Per-instance
  buffer; not shared across processes.
- **Recipes section added to README.** Multi-tenant Gate-per-principal,
  content screening on inbound + outbound text, in-process concurrent
  Gates, fileless test idiom, halt routing via `event.action._ctx`,
  log rotation via `logrotate`. Each is a usage pattern the spec
  already supports — making them discoverable is the v0.4 ask.

### v0.4.x patch retro (2026-05-12)

Three patches followed v0.4.0 driven by multis' adoption via bareagent.
Honest calibration of which landed at the right bar (so future
contributors don't drift the same way; see Appendix E):

- **0.4.1 nested `action.args` fallback (bash/fs/net)** — at the bar.
  `bash.allow` silently denied everything for wireGate's `{type, args}`
  shape; "every adopter writes `translateAction`" met the non-trivial-
  wrapper test.
- **0.4.2 `limits.maxToolRounds`** — **below the bar.** The docs already
  said "use `maxTurns = rounds * 2`," which works. The primitive added
  a config key, a rule string, a cold-start audit-rebuild branch, and
  six tests to absorb one line of caller-side arithmetic. Two adopters
  surfacing it was signal, but not enough — the docs covered it.
  Recorded here as the calibration anchor for "drift to satisfy" and
  the trigger for Appendix E. The primitive remains shipped (can't
  unship without breaking adopters), but the bar going forward is
  higher.

### v0.2 additions (defer-rate + spawn-rate)

- **Rate caps count audit records in a trailing window, not a separate
  file.** One source of truth (the audit log) for both spend and rate.
  Eliminates a second consistency surface across processes; cross-family
  isolation is automatic because the audit file is keyed by `root_run_id`.
- **Rate caps are per-family (root run_id), not per-process.** Otherwise
  children spawned by a fork-bomb-shaped agent each reset to `0/cap` and
  the family blasts past the intended cap. Children inherit the parent's
  audit path via `BAREGUARD_AUDIT_PATH`; counting that one file = the
  family's rate.
- **Default `defer.ratePerMinute` is 15** (originally 30). Easier to
  relax than tighten. `spawn.ratePerMinute` default stays at 10.

---

## Appendix A: relationship to other agent-tooling layers

```
┌─────────────────────────────────────────────────────────────┐
│  System prompt           ← what the model should be like    │
│  guardrails-ai           ← what the model is allowed to say │
│  bareguard               ← what the agent is allowed to do  │
│  Sandbox (Docker/etc.)   ← what the action can affect       │
│  OS perms / SELinux      ← what the process can touch       │
└─────────────────────────────────────────────────────────────┘
```

Five layers. bareguard owns exactly one.

## Appendix B: relationship inside the bare suite

```
        bareagent  ← agent loop runner
            │
            ↓ depends on
        bareguard  ← policy + audit (this doc)
            ↑
            │ may also be used directly by
        any other agent runner
```

bareguard is a leaf dependency. It does not depend on bareagent or any
other suite member.

## Appendix C: the test for any new primitive

Before adding anything to bareguard:

1. Does it constrain an **action against the world** (or against a sibling
   process), not words the model produces?
2. Can it be expressed as a **rule over action shape**, not over action
   *content semantics*?
3. Does it work **without network, without infrastructure, without a server**?
4. Can it be implemented in **≤ 150 LOC** with at most the one allowed dep?
5. Is it **opt-in via config** with a sensible safe default?

Five yeses or it doesn't ship. **All five are necessary; none are
sufficient on their own.** See Appendix E for the additional gate
introduced in v0.4.x.

## Appendix D: file layout (as shipped in v0.1.1)

```
bareguard/
├── package.json                  # one prod dep: proper-lockfile
├── README.md
├── CHANGELOG.md
├── bareguard.context.md          # LLM integration guide
├── LICENSE                        # Apache-2.0
├── NOTICE
├── docs/
│   ├── 01-product/
│   │   └── bareguard-prd.md       # this document
│   ├── non-roadmap.md             # §17 NO-GO list verbatim
│   └── decisions-log.md           # §22 decisions log verbatim
├── src/
│   ├── index.js                   # public API
│   ├── gate.js                    # Gate class, full eval flow + humanChannel
│   ├── glob.js                    # *-only globToRegex
│   └── primitives/
│       ├── audit.js               # single-file JSONL with O_APPEND
│       ├── budget.js              # shared file + proper-lockfile + halt
│       ├── secrets.js             # env-var + pattern redaction
│       ├── bash.js                # cmd allow + denyPatterns
│       ├── fs.js                  # writeScope / readScope / deny
│       ├── net.js                 # allowDomains / denyPrivateIps
│       ├── limits.js              # maxTurns (halt) + maxChildren/maxDepth (action)
│       ├── tools.js               # denylist / allowlist (scope) / denyArgPatterns
│       └── content.js             # safe defaults + denyPatterns / askPatterns
├── test/
│   ├── eval-order.test.js
│   ├── safe-defaults.test.js
│   ├── shared-budget.test.js      # subprocesses
│   ├── audit-stitching.test.js    # subprocesses
│   ├── secrets-redaction.test.js
│   ├── halt-flow.test.js
│   ├── integration.test.js
│   ├── _helpers.js
│   └── _worker.mjs
└── .github/
    └── workflows/
        └── test.yml               # matrix: ubuntu/macos/windows × Node 20/22
```

## Appendix E: evaluating inbound adopter feedback (added v0.4.x)

Appendix C is necessary but not sufficient. The 0.4.x adoption arc with
multis (via bareagent) showed that first-adopter feedback always pulls
toward accommodation: every request can be made to pass the five yeses,
because the requestor genuinely needs it solved. The drift risk is
real, and the calibration anchor in §22 ("v0.4.x patch retro") shows
where one landing (0.4.2 `limits.maxToolRounds`) crossed the line —
the docs already addressed the harm; the primitive only absorbed one
line of caller-side arithmetic into the library surface.

The bar going forward for any inbound feedback that touches the API:

**Response order (try each before the next):**

1. **Point at an existing primitive or recipe.** If the request is
   already supported, the seam is a docs problem, not a code one.
2. **Add or improve a recipe.** Copy-pasteable patterns absorb most
   "every adopter writes this" complaints without growing the surface.
3. **Clarify the PRD contract.** If the request reflects a real
   ambiguity (e.g., v0.4 halt-event-carries-action), document it
   sharply. Often the contract is fine; only the explanation was off.
4. **Extend an existing primitive.** Defensive additions (e.g., v0.4.1
   `bash`/`fs`/`net` accept nested `args`) close real silent-failure
   seams without new keys.
5. **Add a new primitive.** Last resort. Requires:
   - Appendix C five yeses, AND
   - The harm persists with docs/recipes alone, AND
   - The wrapper every adopter would write is non-trivial (not just
     arithmetic, formatting, or naming), AND
   - At least two unrelated adopters have surfaced it.

**Smell tests for "below the bar" requests:**

- The proposed primitive is one line of caller-side math → recipe.
- The proposed primitive renames or aliases something that already
  exists → docs.
- The proposed primitive moves work the runner is naturally positioned
  to do (e.g., wireGate-style adapter concerns, formatting, identity
  routing) into bareguard → reject; document the wrapper pattern.
- The proposed primitive is "opt-in and small, why not?" → that's not
  a reason. Each opt-in key still grows the surface area future-Claude
  has to defend in the next adoption round.

**The point of this gate:** bareguard's value is that it's *small enough
to read in an afternoon* (§2). Every accommodation that doesn't clear
this bar erodes that property by one config key, one rule string, one
audit branch, and a handful of tests. The first round of adoption
biases toward yes; subsequent rounds need to bias toward no, or the
library drifts to "framework with twelve primitives" — which is what
§4 and §17 exist to prevent.

