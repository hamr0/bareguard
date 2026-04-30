# bareguard — Product Requirements Document (PRD)

**Status:** v0.6 (unified — folds v0.5 amendments + v0.1.1 review fixes inline)
**Owner:** hamr0
**Last updated:** 2026-04-30
**Language:** Node.js (JavaScript), ESM, target Node 20 LTS+
**Sibling spec:** `bareagent-prd.md`
**Implementation status:** v0.1.1 published to npm, tests green on Linux/macOS/Windows × Node 20/22
**Supersedes:** v0.1 (Python draft), v0.2 (orchestration), v0.3 (mid-MCP), v0.4 (post-MCP), v0.5 amendments doc

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
| 1  | **bash**             | action   | Command allowlist / denyPatterns when `action.type === "bash"`.                                                         |
| 2  | **budget**           | **halt** | Tokens, cost USD, request count, with hard kill. Shared across sibling processes via backing file + `proper-lockfile`.  |
| 3  | **fs**               | action   | Write/read scope; deny paths (`~/.ssh`, `/etc/passwd`, `..`).                                                            |
| 4  | **net**              | action   | Egress domain allowlist; deny private IP ranges.                                                                        |
| 5  | **limits**           | mixed    | `maxTurns` (**halt**), `maxChildren` (action), `maxDepth` (action), `timeoutSeconds` (**halt**, v0.2).                  |
| 6  | **approval**         | n/a      | Routes ask events to the runner's `humanChannel` callback. No callback storage in v0.6.                                  |
| 7  | **tools**            | action   | Tool name allowlist / denylist (glob-matched) + per-tool `denyArgPatterns` (regex over args). Allowlist is **scope-only** — does NOT silence asks. |
| 8  | **secrets**          | n/a      | Pre-eval action redaction. Env-var matches → `[REDACTED:VAR_NAME]`. Pattern matches → `[REDACTED:pattern=<short prefix>...]`. Caller redacts results. |
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
        bash.denyPatterns / bash.allow (when action.type === "bash")
        fs.deny / fs.readScope / fs.writeScope (when read/write/edit)
        net.allowDomains / net.denyPrivateIps (when fetch)
        limits.maxChildren / limits.maxDepth (when spawn)
        tools.denyArgPatterns (any tool with matching args)
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

**Optional `humanChannelTimeoutMs`** (default: unset = wait forever). When set on the Gate config, bareguard races the `humanChannel` promise against a timer. If the timer wins, gate.check resolves to `{ outcome: "deny", severity: "halt", rule: <originalRule>, reason: "humanChannel timeout after Xms" }` and emits a `phase: "approval"` audit line carrying the timeout reason. The timeout always denies — there is no allow-on-timeout default. Callers wanting allow-on-timeout (e.g. autonomous fleets where one stuck branch shouldn't pin a worker) must implement that policy inside their own `humanChannel`, so the choice is explicit in user code, not a bareguard default. The pending channel promise is not cancelled; if it later resolves, the result is dropped (the agent will re-prompt on the next gate.check).

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
- Budget file corruption → JSON parse error surfaces; rebuild from audit log
  if possible, else surface `BudgetUnavailableError` and terminate cleanly.
- Cross-machine → NOT supported in v1. Single-machine only. See §17.

Children inherit the path via env var `BAREGUARD_BUDGET_FILE`, set by the
parent's `spawn` tool.

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

### bareguard 1.0 — stabilize

- Lock the API. SemVer commitments.
- Walk-away: maintenance only after this point.

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

Five yeses or it doesn't ship.

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
