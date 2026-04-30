# bareguard — Product Requirements Document (PRD)

**Status:** Draft v0.4 (implementation-ready, post-MCP design conversation)
**Owner:** hamr0
**Last updated:** 2026-04-25
**Language:** Node.js (JavaScript), ESM, target Node 20 LTS+
**Sibling spec:** `bareagent-prd.md`
**Supersedes:** v0.1 (Python draft), v0.2 (orchestration additions), v0.3 (mid-MCP)
**Amended by:** `bareguard-prd-v0.5-amendments.md` (read alongside; amendments win on conflict)

> **For future Claude (implementation note):** This document is written as an
> implementation-ready spec. §3 says what bareguard IS. §4 says what bareguard
> is NOT — read both before implementing anything. §8 is the 12 primitives
> table. §9 is the architecture and the 6-step evaluation order; that order
> is load-bearing — implement it exactly. §11 lists the safe defaults that
> ship out of the box. §16 explains the MCP gov approach (Path A) and is the
> answer to most MCP-related design questions. §17 is the NO-GO list — point
> at it instead of reopening discussions. §22 is the decisions log.

---

## 1. One-line summary

`bareguard` is a zero-dep (one allowed dep), local-first runtime policy
library for autonomous agents. It bounds what the agent can *do*, not what it
can *say*.

## 2. Two-paragraph summary

bareguard is the policy layer that bareagent (and any other agent runner)
imports. Every tool call traverses `gate.check(action)`; every result hits
`gate.record(action, result)`. There is one gate, one audit log, one budget
ledger, and twelve primitives — bash, budget, fs, net, limits, approval,
tools, secrets, audit, defer-rate, spawn-rate, content. Each primitive is
~50–150 LOC, composable through the single gate. The library is small enough
that you can read the whole thing in an afternoon and understand exactly what
your agent is allowed to do.

bareguard ships with safe defaults — destructive verbs (delete, drop, revoke,
truncate) trigger ask-human prompts; explicit dangers (DROP TABLE, rm -rf /)
are denied outright — so a user with no policy config still gets meaningful
protection. Multi-agent runs share a budget file (locked via
`proper-lockfile`); audit lines include `parent_run_id` and `spawn_depth`
so a family of agents reconstructs into one timeline. MCP governance is
handled by the same primitives that govern bash and fetch — bareguard glob-
matches the `mcp:server/tool` name string and pattern-matches serialized
arguments. It has no MCP-specific code.

## 3. What bareguard IS

- A **policy library** — a single `Gate` class with three call sites:
  `gate.redact()`, `gate.check()`, `gate.record()`.
- An **action-side guard** — it enforces what the agent does to the world
  (bash commands, fs writes, network calls, MCP invocations, child spawns,
  budget consumption).
- The **single source of truth** for runtime policy decisions in any agent
  runner that uses it. No duplicate policy in the runner, the tools, or
  anywhere else.
- A **structured audit producer** — every gated event is one JSONL line.
  The audit log IS the budget ledger. There is no second source of truth.
- A **library**. There is no `bareguard serve`, no daemon mode, no network
  endpoint. It runs in-process with the agent runner.

## 4. What bareguard is NOT

- **NOT a content guardrail.** It does not check toxicity, PII, factuality,
  schema, persona, tone, topic blocklists, or hallucinations. That's
  guardrails-ai's job, or a system prompt's job. The action vs content line
  is the single most important boundary in this library — see §6.
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
  class with 3 methods. That's the whole API.
- **NOT MCP-aware.** It glob-matches strings. The `mcp:server/tool` naming
  convention is a *user-facing convention*, not parsing logic in bareguard.
- **NOT a long-running process.** It exits when the agent runner exits.

## 5. Why this exists

Two adjacent things already exist and neither solves this:

- **`guardrails-ai`** is content validation for LLM apps — toxic-language,
  regex match, schema validation, PII detection. It checks what the model
  *says*. Heavy framework, Hub of validators, optional Flask server. Useful,
  but a different problem.
- **`bareagent` v0.x** ships bash allowlist, token budget, gov layer (per-tool
  allow/deny/ask) as built-ins. That's the seed. But coupling them to one
  runner means other runners can't reuse them, and policy drifts from the
  suite.

The gap is a small, runner-agnostic library focused entirely on the *action
side* of the agent loop, with first-class support for multi-agent (siblings
sharing budget), deferred work (rate-limited `defer()`), and MCP governance
through generic name-and-pattern matching. That's bareguard.

## 6. Core thesis: action vs content

**Action-bounding, not content-shaping.** The single test for any candidate
primitive:

> Does it constrain an action against the world (or against a sibling
> process), or constrain words the model produces?

If the latter, refuse — that's a system prompt's job, or guardrails-ai's.
This rule keeps bareguard small forever.

| Layer                  | Concern                                  | Owner                |
| ---------------------- | ---------------------------------------- | -------------------- |
| System prompt          | What the model should be like            | The user's prompt    |
| guardrails-ai          | What the model is *allowed to say*       | guardrails-ai        |
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
guardrails-ai. A user building a coding agent uses bareguard. A user doing
both imports both.

## 8. The twelve primitives (v1 scope)

Each is one file, ~50–150 LOC, composes through the single gate.

| #  | Primitive            | What it checks                                                                                                          | Source                          |
| -- | -------------------- | -----------------------------------------------------------------------------------------------------------------------| ------------------------------- |
| 1  | **bash**             | Command allowlist / denylist / regex patterns                                                                           | Extracted from bareagent        |
| 2  | **budget**           | Tokens, cost USD, request count, with hard kill. Shared across sibling processes via backing file + `proper-lockfile`.  | Extracted from bareagent        |
| 3  | **fs**               | Write/read scope; deny paths (`~/.ssh`, `/etc`, `..`)                                                                   | New                             |
| 4  | **net**              | Egress domain allowlist; deny private IP ranges                                                                         | New                             |
| 5  | **limits**           | `maxTurns`, `timeoutSeconds`, `maxChildren` (siblings per parent), `maxDepth` (spawn-tree depth)                        | Partly extracted, mostly new    |
| 6  | **approval**         | Pause-and-ask hook for destructive patterns (callback-based; caller wires their TUI/Slack/web)                          | Extracted from bareagent (gov)  |
| 7  | **tools**            | Tool name allowlist / denylist (glob-matched) + per-tool `denyArgPatterns` (regex over args)                            | Extracted from bareagent (gov)  |
| 8  | **secrets**          | Redact known env-var values + cred patterns from anything entering LLM context                                          | New                             |
| 9  | **audit**            | Append-only JSONL of every gated decision. Includes `parent_run_id` and `spawn_depth` for multi-agent stitching.        | New                             |
| 10 | **defer-rate**       | Caps `defer()` calls per minute. Re-validates the deferred action's gate decision on emit AND on fire (defense in depth)| New                             |
| 11 | **spawn-rate**       | Caps `spawn()` calls per minute and per parent's lifetime. Composed with `limits.maxChildren` and `limits.maxDepth`     | New                             |
| 12 | **content**          | Pattern-matches over `JSON.stringify(action)`. `denyPatterns` block; `askPatterns` escalate to human. Generic mechanism that catches dangerous *shapes* across all tools. | New (this conversation)         |

**The 12th primitive (`content`) is what makes MCP gov work without
MCP-specific code.** Content patterns run over the serialized action JSON, so
the tool name AND every argument value are in the haystack. A `bash` call
with `cmd: "rm -rf /"` and an `mcp:db.tool/query` call with `sql: "DROP TABLE
users"` are both caught by the same regex, regardless of which tool was
invoked.

## 9. Architecture: one gate, complete mediation

```
agent decides action
   ↓
secrets.redact(action)              ← before anything sees it
   ↓
gate.check(action) → { allow | deny(reason) | askHuman(prompt) }
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
- Gate is pure-ish: takes action + state, returns decision. No side effects.
  Recorder is separate.
- One config object. One audit log. One budget ledger (which IS the audit
  log on the cost dimension).
- For multi-agent: parent and all children share the budget file via
  `proper-lockfile`. One $5 cap for the whole family.

This is the security principle of **complete mediation**. The reason the
multis duplication bug happened was two reference monitors. Don't ship that
again.

### 9.1 The 6-step evaluation order

`gate.check(action)` runs through these checks in this exact order. **First
match wins** for terminal outcomes (deny / allow); ask-human is also
terminal. Allowlist match short-circuits past the ask layer (an explicit
allowlist entry IS the consent).

```
1. tools.denylist match           → deny (terminal)
2. content.denyPatterns match     → deny (terminal)
3. tools.allowlist match          → allow (terminal — short-circuits ask)
4. content.askPatterns match      → askHuman (terminal — caller's callback decides)
5. tools.denyArgPatterns match    → deny (terminal — runs after name allow)
6. default                        → allow
```

**Why this order:**

- Explicit deny (1) is the strongest signal — no other check can override.
- Content deny (2) catches universal dangers (DROP TABLE, rm -rf) that no
  user wants regardless of trust.
- Allowlist (3) is "I trust this tool — don't bother asking." Without this
  short-circuit, allowlisting a destructive tool would still prompt forever.
- Ask (4) is the safety floor: destructive verbs prompt unless explicitly
  allowed.
- ArgPatterns (5) is fine-grained — even a trusted tool (allowlisted) gets
  arg-checked. "Allow `update_issue` but not with `priority: critical`"
  needs this slot AFTER the allow short-circuit, by design.
- Default allow (6) keeps the library usable — users with no config still
  get safe defaults via shipped `content.askPatterns`.

### 9.2 Why allowlist short-circuits ask (worth explaining in code comments)

If a user goes to the trouble of writing
`tools.allowlist: ["mcp:linear.app/delete_comment"]`, they have made an
explicit decision. Prompting them every time would defeat their config and
train them to click-through reflexively (which destroys the value of the
prompt for things they DIDN'T allowlist).

`tools.denyArgPatterns` runs after the allow specifically so users can say
"I trust this tool generally, but block these specific args." Two different
concerns, two different slots.

## 10. Public API

```js
import { Gate } from "bareguard";

const gate = Gate.fromConfig({
  bash:     {
    allow: ["git", "ls", "cat", "rg"],
    denyPatterns: [/rm\s+-rf/, /sudo/, /curl.*\|.*sh/],
  },
  budget:   {
    maxTokens: 100_000,
    maxCostUsd: 5.00,
    sharedFile: process.env.BAREGUARD_BUDGET_FILE || null,  // null = process-local
  },
  fs:       {
    writeScope: ["./", "/tmp/agent"],
    readScope:  ["./", "/tmp/agent", "/etc/hostname"],
    deny:       ["~/.ssh", "/etc/passwd", "/.git/config"],
  },
  net:      {
    allowDomains: ["api.anthropic.com", "github.com"],
    denyPrivateIps: true,
  },
  limits:   {
    maxTurns: 50,
    timeoutSeconds: 300,
    maxChildren: 4,        // per parent
    maxDepth: 3,           // total spawn-tree depth
  },
  approval: {
    callback: myApprovalFn,    // async (action, prompt) => "allow" | "deny"
  },
  tools:    {
    allowlist: ["bash", "read", "write", "fetch", "spawn", "defer",
                "mcp_discover", "mcp_invoke", "mcp:linear.app/*"],
    denylist:  ["mcp:*/admin_*", "mcp:*/delete_*"],
    denyArgPatterns: {
      "mcp:linear.app/update_issue": [/priority.*critical/i],
    },
  },
  secrets:  {
    envVars:  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
    patterns: [/sk-[A-Za-z0-9]{40,}/, /ghp_[A-Za-z0-9]{36}/],
  },
  defer:    { ratePerMinute: 30 },
  spawn:    { ratePerMinute: 10 },
  content:  {                 // can be omitted; safe defaults ship — see §11
    denyPatterns: [...],
    askPatterns:  [...],
  },
  audit:    {
    path:          "./bareguard.jsonl",   // or null for callback-only
    callback:      null,                  // optional fn(line) called per emit
    parentRunId:   process.env.BAREGUARD_PARENT_RUN_ID || null,
    runId:         undefined,             // auto-gen ULID if absent
    spawnDepth:    Number(process.env.BAREGUARD_SPAWN_DEPTH || 0),
  },
});

// Three call sites, total:
const cleanAction = gate.redact(action);
const decision    = await gate.check(cleanAction);   // or: gate.allows(name) for pure-query
await gate.record(cleanAction, result);

// Or one composed call for runners that want it:
const result = await gate.run(action, executor);
```

**That is the entire surface.** No subclassing, no plugin system, no hooks
framework, no DSL.

### 10.1 `gate.allows(action) → boolean` — the discovery pre-filter

Pure query, no audit write, no budget delta. Used by callers (e.g.,
bareagent's `mcp_discover`) to filter a catalog before showing it to the LLM.

```js
const filtered = catalog.filter(t => gate.allows({ type: "mcp_invoke", name: t.name }));
```

This is an *ergonomic*, not a gov mechanism. The actual gov decision is made
by `gate.check()` at invoke time. Pre-filtering is purely about not wasting
LLM context on tools the agent can't invoke anyway.

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

This is ~10 lines of regex and it covers ~90% of what gets agents in
trouble. The shipped defaults are the *floor*, not the ceiling.

**Why ship safe defaults instead of allow-by-default:**

1. The ask-human callback is opt-in (caller wires it). With no callback,
   ask falls back to deny — strict default.
2. "Default allow + opt-in safety" is the pattern that produces incidents.
   Users don't read README sections about hardening.
3. Bare suite philosophy isn't "no policy by default" — it's "minimum viable
   policy by default, easy to override." Match Claude Code's posture: writes
   prompt, reads pass, user can disable.

## 12. Audit trail spec

The audit log is bareguard's spine. It is also the budget ledger. There is
no second source of truth.

**Format:** JSONL, one line per gated event, append-only.

**Required fields:**

```json
{
  "ts": "2026-04-25T14:32:11.482Z",
  "seq": 1247,
  "run_id": "run_01J...",
  "parent_run_id": "run_01J...",
  "spawn_depth": 1,
  "phase": "gate",
  "action": { "type": "bash", "cmd": "git status" },
  "decision": "allow",
  "rule": "tools.allowlist",
  "reason": null,
  "result": null
}
```

For `phase: "record"` lines, `result` is populated and `decision` is null:

```json
{
  "ts": "2026-04-25T14:32:11.531Z",
  "seq": 1248,
  "run_id": "run_01J...",
  "parent_run_id": "run_01J...",
  "spawn_depth": 1,
  "phase": "record",
  "action": { "type": "bash", "cmd": "git status" },
  "decision": null,
  "rule": null,
  "reason": null,
  "result": { "exitCode": 0, "tokens": 142, "costUsd": 0.003 }
}
```

`parent_run_id` is `null` for the root agent; set by the parent's `spawn`
tool when forking a child (via env var). `spawn_depth` is `0` at root,
incremented per level. Together they make the full family tree
reconstructable from grep.

**Properties:**

- Redaction happens **before** gate sees the action. Audit lines never
  contain secrets — there is nothing to scrub.
- Budget remaining = `initial - sum(record.result.costUsd)` over the log.
  Reconstruct on startup. No separate ledger file.
- Monotonic `seq` per gate instance. Helps detect gaps.
- One log per agent run by default. Caller decides path. Children write to
  separate files (linked by `parent_run_id`); cheaper than contending on
  one file.

**Output sink:** file path OR callback function. Nothing else. (Datadog,
Loki, S3 are caller-side adapters.)

## 13. Shared budget across processes

When a parent spawns a child and both should draw from the same budget
ceiling, configure `budget.sharedFile`. Implementation uses
`proper-lockfile` (the one allowed dep) to coordinate writes.

**Pseudocode:**

```js
import lockfile from "proper-lockfile";

async function recordCost(deltaUsd, deltaTokens) {
  if (!config.budget.sharedFile) {
    return process_local_update(deltaUsd, deltaTokens);
  }
  const release = await lockfile.lock(config.budget.sharedFile, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
  });
  try {
    const state = JSON.parse(await fs.readFile(config.budget.sharedFile));
    state.spent_usd    += deltaUsd;
    state.spent_tokens += deltaTokens;
    if (state.spent_usd >= state.cap_usd) throw new BudgetExceeded(state);
    if (state.spent_tokens >= state.cap_tokens) throw new BudgetExceeded(state);
    await fs.writeFile(config.budget.sharedFile, JSON.stringify(state));
  } finally {
    await release();
  }
}
```

**Format of the shared budget file:**

```json
{
  "cap_usd": 5.00,
  "spent_usd": 1.23,
  "cap_tokens": 100000,
  "spent_tokens": 24500,
  "started_at": "2026-04-25T14:00:00Z",
  "owners": ["run_01JABC...", "run_01JDEF..."]
}
```

Children inherit the path via env var `BAREGUARD_BUDGET_FILE`, set by the
parent's `spawn` tool (see bareagent PRD §10.6). Lock contention is rare
in practice (sub-second LLM turn cadence). On contention, retry with
backoff; on persistent failure, surface BudgetUnavailable to the agent loop
which terminates cleanly.

**Failure modes addressed:**

- Lock leftover from crashed process → `proper-lockfile` handles stale lock
  detection by default.
- Concurrent writes → serialized.
- Lost updates → impossible while lock is held.
- Budget file corruption → JSON parse error surfaces; agent terminates with
  clear error. Recovery is manual (delete file, restart).
- Cross-machine → NOT supported in v1. Single-machine only. See §17.

## 14. Spawn and defer guards

These primitives exist because of bareagent's `spawn` and `defer` tools (see
bareagent PRD §10.6, §10.7). They're listed in §8 as primitives 10 and 11
and detailed here.

### 14.1 `limits.maxChildren` and `limits.maxDepth`

- **Per-parent:** a parent agent can spawn at most `maxChildren` children
  concurrently and over its lifetime.
- **Per-tree:** total depth from root cannot exceed `maxDepth`.

Tracked in the audit log: every `spawn` action's gate-decision line includes
the current child count and depth. Reconstructed on startup from the log.
Without these, one bug spawns 10K agents and burns the budget in 30 seconds.

### 14.2 `defer.ratePerMinute`

Caps how many `defer()` calls a single agent run can emit per minute.
Default: 30. Prevents a confused agent from emitting 1000 jobs into the
queue.

### 14.3 `spawn.ratePerMinute`

Same idea for `spawn`. Default: 10. Prevents fork-bomb shapes even if
`maxChildren` is set generously.

### 14.4 Defense in depth: re-validate deferred actions on fire

When the wake script reads a deferred action and invokes bareagent to fire
it, the *fired* action passes through the gate again. A `defer` whose
action would be denied at fire time (e.g., budget exceeded, target file no
longer in fs scope) is denied at fire time. The audit log records both the
emit decision and the fire decision.

## 15. The `tools` vs `content` distinction (frequently confused)

These are two different primitives that look at two different things. They
compose, they don't overlap.

| Rule                       | Looks at                  | Match type | Outcome     | Example                                                |
| -------------------------- | ------------------------- | ---------- | ----------- | ------------------------------------------------------ |
| `tools.allowlist`          | tool name                 | glob       | allow       | `"mcp:linear.app/*"`                                   |
| `tools.denylist`           | tool name                 | glob       | deny        | `"mcp:*/delete_*"`                                     |
| `tools.denyArgPatterns`    | action.args (per tool)    | regex      | deny        | `{ "update_issue": [/priority.*critical/] }`           |
| `content.denyPatterns`     | full serialized action    | regex      | deny        | `/DROP\s+TABLE/i`                                      |
| `content.askPatterns`      | full serialized action    | regex      | ask human   | `/\b(delete|drop|revoke)\b/i`                          |

**When to use which:**

- **`tools` rules** when the dangerous thing is identifiable by tool name.
  Cheap to express, zero false positives. Good for "trust this whole MCP
  server" or "never invoke this specific tool."
- **`content.denyPatterns`** for dangerous payload shapes that show up
  across many tools — SQL injection patterns, force flags, destructive HTTP
  methods. One regex catches it whether the agent uses `bash`,
  `mcp:db.tool/query`, or `fetch`.
- **`content.askPatterns`** for "probably fine but worth confirming." The
  words `delete`, `drop`, `revoke` in any action. Prompts the human;
  doesn't block.
- **`tools.denyArgPatterns`** when you trust a tool generally but want to
  block specific argument shapes. More targeted than `content` because it's
  scoped to one tool.

## 16. MCP governance (Path A)

bareguard governs MCP tools through the same primitives that govern bash
and fetch. There is no MCP-specific code in bareguard.

### 16.1 The flow

1. `bareagent.mcp_discover()` — bareagent reads MCP server catalogs, caches
   for 30 days. **bareguard is not consulted.** Discovery is metadata
   access, not an action against the world. (See bareagent PRD §10.8.)
2. `bareagent.mcp_invoke(toolName, args)` — bareagent invokes the MCP tool.
   **bareguard's `tools` and `content` primitives check it** as it would
   any other action. Tool name (e.g., `mcp:linear.app/list_issues`) is
   glob-matched; args are regex-matched.

### 16.2 Why "Path A" (gov via invocation, not via catalog)

Path A is sufficient: same machinery as bash gov, just with longer tool
names. bareguard stays catalog-blind, which is a feature:

- The policy library doesn't grow MCP-shaped knowledge.
- It doesn't break when the catalog refreshes.
- Users can change MCP servers without touching bareguard config.
- New MCP versions or protocol changes are absorbed by bareagent's
  discovery; bareguard sees the same string convention either way.

The alternative (Path B — bareguard knows the catalog) is more powerful
ergonomically but couples policy to discovery. Rejected for v1.

### 16.3 `gate.allows()` as an ergonomic, not a gov mechanism

bareagent can call `gate.allows(action)` during `mcp_discover` to filter
the catalog before showing it to the LLM (don't waste context on tools the
agent can't invoke). This is purely a context optimization. Gov decisions
still happen at invoke time via `gate.check()`. (See §10.1.)

### 16.4 Tool name convention

`mcp:<server-host>/<tool-name>` — string convention bareguard glob-matches.
Examples:

- `mcp:linear.app/list_issues`
- `mcp:github.com/create_pull_request`
- `mcp:internal.company.com/admin_revoke_token`

bareguard does no parsing. It splits on `/` only when the user writes a
glob like `mcp:linear.app/*`. Otherwise the whole name is a string.

## 17. NO-GO list

Recorded explicitly so future contributors and future-you don't re-litigate.
Each entry was discussed during design and consciously excluded.

| Out                                                  | Why                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Topic blocklists ("don't discuss politics")          | System prompt's job, or guardrails-ai. Content, not action.                      |
| Persona / tone constraints                           | System prompt.                                                                   |
| Output schema validation (JSON, Zod)                 | guardrails-ai already does this well. Or Zod, in the caller's code.              |
| Hallucination / factuality detection                 | Model-side problem. Hard. Not our fight.                                         |
| "Constitutional AI" rule sets                        | That's a *training* method, not a runtime library. Confusing branding aside, not bareguard. |
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
| Approval UI                                          | Callback only. Caller wires it to their TUI / Slack / web.                       |
| Sandboxing (Docker, gVisor, Firecracker)             | Different layer. bareguard prevents the call; sandboxing contains effects.        |
| Cross-machine distributed budget                     | Single-machine `proper-lockfile` is v1. Cross-machine = future sibling library.  |
| Identity / authn / authz                             | Caller's concern. bareguard sees actions, not principals.                        |
| Rate limiting against external APIs                  | The API does this; or use a separate rate-limit library. Not bareguard's role.   |
| Built-in scheduler                                   | bareagent's `defer` tool emits records; cron / `wake.sh` / future `barejob` runs them. |
| Long-running daemon mode                             | bareguard is a library, not a service. No `bareguard serve`.                     |
| MCP-specific parsing / awareness                     | bareguard glob-matches strings. The `mcp:server/tool` convention is the user's, not parsed by us. |
| MCP server registry or aggregator                    | Different layer. bareguard doesn't connect to MCP servers; bareagent does.       |

**Adding any of these dilutes the one thing this library does.** When users
ask for them, point at this list.

## 18. Language & runtime

**Node.js 20 LTS+, ESM only.**

- **Stdlib:** `fs/promises`, `path`, `crypto`, `process`, `events`,
  `worker_threads` (if needed for callback isolation).
- **One allowed production dep: `proper-lockfile`** for the shared budget
  file. Justification: file locking with stale-lock detection is genuinely
  hard to get right cross-platform. `proper-lockfile` is widely used,
  narrow scope, no transitive deps of consequence. Inline implementations
  fail on NFS, on Windows, and on stale locks from crashed processes.
- **No** `commander`/`yargs` — bareguard has no CLI of its own.
- **No** test framework in the package; tests use Node's built-in test
  runner (`node:test`).

**Production deps target: 1.** Hard target. Any deviation requires explicit
justification in the PRD.

## 19. Migration plan

Three releases, each independently shippable.

### bareguard 0.1 — extraction baseline

- Implement primitives 1, 2 (process-local budget only), 3, 4, 5 (excluding
  `maxChildren`/`maxDepth`), 6, 7 (excluding `denyArgPatterns`), 8, 9.
- Re-export old paths from bareagent under `bareagent/guards/*` as proxies
  to bareguard with `DeprecationWarning`. Removed in bareagent v(next+2).
- bareagent v(next) depends on bareguard 0.1.
- README cross-links.

### bareguard 0.2 — multi-agent + scheduling + MCP gov

- Add `limits.maxChildren`, `limits.maxDepth`.
- Add `budget.sharedFile` with `proper-lockfile`.
- Add `parent_run_id`, `spawn_depth`, `run_id` to the audit schema.
- Add primitives 10 (`defer-rate`), 11 (`spawn-rate`), 12 (`content`).
- Add `tools.denyArgPatterns`.
- Add `gate.allows()` for discovery pre-filter.
- Ship safe defaults in `content` (see §11).
- bareagent v(next+2) depends on bareguard 0.2 and ships the
  `spawn`/`defer`/`mcp_discover`/`mcp_invoke` tools.

### bareguard 1.0 — stabilize

- Lock the API. SemVer commitments.
- Walk-away: maintenance only after this point. See §16 of bareagent PRD.

## 20. POC plan

Three phases, time-boxed. If a "stop if exceeded" mark is hit, the design
has a problem the POC is exposing — that's the POC working correctly.

| Phase | Goal                                                                                                                | Budget   | Stretch | Stop    |
| ----- | ------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------- |
| 1     | Single gate with bash + budget + audit, in-memory state, 6-step eval order                                          | 60 min   | 90 min  | 2 hours |
| 2     | Add fs + net + secrets redaction + content (with safe defaults), JSONL audit, reconstruct budget from log           | 90 min   | 2 hours | 3 hours |
| 3     | Wire bareguard into bareagent's loop; add `maxChildren`/`maxDepth`/shared budget; spawn child; verify gov over MCP   | 2 hours  | 3 hours | 4 hours |
| **Total** |                                                                                                                 | **4.5h** | **6.5h**| **9h**  |

**POC anti-goals:** no proper API surface, no error handling polish, no
cross-platform, no docs, no tests, single file. If you find yourself making
it nice, you've drifted. Delete the polish, return to crude.

**POC success = "I'm ready to delete all this code and start fresh."**

## 21. Success criteria for v1.0.0

- [ ] Twelve primitives implemented; each ≤ 150 LOC.
- [ ] Total source ≤ 1000 LOC excluding tests and docs.
- [ ] One production dep (`proper-lockfile`); no others.
- [ ] Single gate is the only decision path. No tool self-checks.
- [ ] Single JSONL audit log. Budget reconstructed from log on startup.
- [ ] 6-step evaluation order implemented exactly per §9.1; verified by
      table-driven test covering all 6 outcomes.
- [ ] Safe defaults shipped per §11; verified by integration test (no
      user config, agent attempts `rm -rf /` → denied; agent attempts
      `delete user X` → asks human).
- [ ] Shared budget across sibling processes verified by integration test
      (parent + 2 children sharing $5 cap, audit shows correct total).
- [ ] `parent_run_id` and `spawn_depth` correctly threaded through 3-deep
      spawn tree (verified by test).
- [ ] Secrets redaction runs before gate sees action; verified by test.
- [ ] `defer.ratePerMinute` and `spawn.ratePerMinute` actually fire
      (verified by test).
- [ ] `gate.allows()` is pure-query (no audit write, no budget change);
      verified by test.
- [ ] MCP tool names glob-matched correctly with `mcp:server/tool`
      convention (verified by test covering wildcards).
- [ ] README integration example works copy-pasted into a fresh repo.
- [ ] bareagent migrated; old paths re-exported with deprecation warnings.
- [ ] NO-GO list (this doc, §17) included verbatim in `docs/non-roadmap.md`.
- [ ] Decisions log (§22) included verbatim in `docs/decisions-log.md`.
- [ ] Published to npm as `bareguard`.
- [ ] Cross-linked from bareagent's README.

## 22. Decisions log (for future Claude)

These were resolved across the design conversations and should not be
re-litigated unless the user explicitly asks.

- **bareguard owns all policy.** Bash, budget, fs, net, secrets, approval,
  tools (with arg patterns), content, audit, defer-rate, spawn-rate,
  limits — all live here. bareagent has no `if allowed:` checks. (§8.)
- **Single gate, complete mediation.** Every action goes through one
  `gate.check`. Tools never self-check. Two reference monitors is the bug
  shipped in `multis`; do not ship it again. (§9.)
- **6-step evaluation order is load-bearing.** Implement exactly. Allowlist
  short-circuits the ask layer; `denyArgPatterns` runs after allow so users
  can express "trust this tool, but not with these args." (§9.1, §9.2.)
- **Audit log is the budget ledger.** Don't keep two sources of truth.
  Reconstruct budget from audit on startup. (§12.)
- **Shared budget across siblings is a file with `proper-lockfile`.**
  Single-machine only in v1. Cross-machine is a future sibling library. (§13.)
- **`maxChildren` and `maxDepth` are essential, not nice-to-have.** Without
  them, one bug spawns 10K agents and burns the budget in 30 seconds. (§14.)
- **Defer-rate and spawn-rate guards are essential.** Same reason — confused
  agents emit thousands of jobs without these. (§14.)
- **Defer actions are validated twice:** once on emit, once on fire.
  Defense in depth. (§14.4.)
- **No content guardrails.** Toxicity, PII, schema, persona, topic — all
  guardrails-ai's job or system-prompt's job. The action vs content line is
  the single most important boundary in this library. (§6, §17.)
- **`content` primitive is action-side, not content-side.** It pattern-
  matches the SERIALIZED ACTION JSON — tool name + args. That's still
  "what the agent does," just more flexibly expressed than per-tool rules.
  Distinguishing this from content guardrails is critical. (§8, §15.)
- **MCP gov is invocation-level, not catalog-level (Path A).** bareguard
  never sees the MCP catalog. It glob-matches tool name strings on
  invocation. The catalog lives in bareagent's 30-day cache. (§16.)
- **Tool name convention `mcp:server/tool`.** String convention for
  glob-matching. bareguard does no MCP-specific parsing. (§16.4.)
- **`gate.allows()` is ergonomic, not gov.** Pre-filter only; gov happens
  at invoke time via `gate.check()`. (§10.1, §16.3.)
- **Safe defaults ship.** Default-allow + opt-in safety produces incidents.
  bareguard ships ~10 lines of regex catching the obvious dangers. Users
  override with empty arrays if they want pure-allow. (§11.)
- **One allowed production dep: `proper-lockfile`.** File locking with stale
  detection is genuinely hard. Inline implementations fail on NFS, Windows,
  and crashed processes. Worth the dep. Nothing else gets a free pass. (§18.)
- **No telemetry, ever.** JSONL to a file or a callback. What users do
  downstream is their problem. (§17.)
- **Walk-away after v1.0.** New features = new sibling repos. (§19.)
- **JavaScript is the language.** Bare suite consistency overrides
  Python-ecosystem-density. (§18.)

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

Five layers. bareguard owns exactly one. Everything else is somebody else's
library or somebody else's problem.

## Appendix B: relationship inside the bare suite

```
        bareagent  ← agent loop runner
            │
            ↓ depends on
        bareguard  ← policy + audit (this doc)
            ↑
            │ also used by
        multis     ← consumer multi-agent product
```

bareguard is a leaf dependency. It does not depend on bareagent or any
other suite member. This is deliberate: the suite's strength is
composability of single-purpose libraries.

## Appendix C: the test for any new primitive

Before adding anything to bareguard, answer:

1. Does it constrain an **action against the world** (or against a sibling
   process), not words the model produces? *(If no → not bareguard.)*
2. Can it be expressed as a **rule over action shape**, not over action
   *content semantics*? *(If no → probably guardrails-ai or sandbox.)*
3. Does it work **without network, without infrastructure, without a
   server**? *(If no → not bare.)*
4. Can it be implemented in **≤ 150 LOC, with at most the one allowed dep
   (`proper-lockfile`)**? *(If no → it's a sibling library, not a primitive.)*
5. Is it **opt-in via config** with a sensible safe default? *(If no → it's
   policy without a safety floor. Reconsider.)*

Five yeses or it doesn't ship. Tape this above the desk.

## Appendix D: file layout for the repo

```
bareguard/
├── package.json                  # one prod dep: proper-lockfile
├── README.md
├── docs/
│   ├── non-roadmap.md            # the §17 NO-GO list verbatim
│   └── decisions-log.md          # the §22 decisions log verbatim
├── src/
│   ├── index.js                  # exports Gate
│   ├── gate.js                   # the gate class, 6-step eval order
│   ├── primitives/
│   │   ├── bash.js               # #1
│   │   ├── budget.js             # #2 (incl. shared-file lock)
│   │   ├── fs.js                 # #3
│   │   ├── net.js                # #4
│   │   ├── limits.js             # #5
│   │   ├── approval.js           # #6
│   │   ├── tools.js              # #7
│   │   ├── secrets.js            # #8
│   │   ├── audit.js              # #9
│   │   ├── defer-rate.js         # #10
│   │   ├── spawn-rate.js         # #11
│   │   └── content.js            # #12 (incl. safe defaults)
│   └── glob.js                   # the 30-line glob-to-regex helper
└── test/
    ├── eval-order.test.js        # table-driven 6-step coverage
    ├── safe-defaults.test.js     # rm -rf /, DROP TABLE, "delete X"
    ├── shared-budget.test.js     # parent + 2 children, lock contention
    ├── audit-stitching.test.js   # parent_run_id, spawn_depth, 3-deep tree
    ├── secrets-redaction.test.js
    ├── content.test.js
    ├── tools-globs.test.js       # mcp:server/* matches, denyArgPatterns
    ├── defer-rate.test.js
    ├── spawn-rate.test.js
    └── integration.test.js       # full bareagent loop end-to-end
```

This is a suggested layout, not mandatory. Implementation can move files
around as needed; the `eval-order.test.js` and `safe-defaults.test.js`
tests should exist as listed because they're the most direct verification
that the load-bearing decisions are implemented correctly.
