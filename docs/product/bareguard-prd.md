---
type: reference
title: bareguard — Product Requirements Document (PRD)
status: stable
sources: [docs/archive/bareguard-prd.md]
---

# bareguard — Product Requirements Document (PRD)

> A one-dependency, local-first **runtime policy library** for autonomous agents: it
> bounds what an agent can *do*, not what it can *say*. This PRD is the single
> authority for **all of bareguard**, organized as **two parts**:
>
> - **Part 1 — Core bareguard (the shipped library).** The `Gate`, the thirteen
>   primitives, the complete-mediation architecture, the 6-step eval order, the audit
>   and budget specs, the public API, the NO-GO list, the release/migration history,
>   and the future-feature candidates. This is what ships on npm today.
> - **Part 2 — The harness (Axis A/B; floor + harness).** The design frame the a2a
>   experiment forced into focus: gate-the-action (**Axis A** ≈ Part 1, sharpened) +
>   reconcile-the-return (**Axis B**, the one genuinely new surface), the
>   floor-vs-harness authorship split, the POC graduation gates (E1–E6), and the
>   litectx integration bench. More conceptual and faster-moving than Part 1.
>
> **Owner:** hamr0 · **Language:** Node.js (ESM, Node 20 LTS+); ships `.d.ts`
> generated from JSDoc. **One production dep:** `proper-lockfile`.
> **Implementation status:** released on npm through 0.8.0; pre-1.0 on a deliberate
> HOLD (Part 1 §19). **Supersedes** the separate `harness-prd.md` (folded in as
> Part 2, 2026-06-23) and the v0.1–v0.6 PRD lineage.
>
> **Single source of truth.** This PRD is the one authority for both parts. Companion
> docs are subordinate, never competing authorities:
>
> | Doc | Role |
> |---|---|
> | **`bareguard-prd.md`** (this) | the authority — both parts: primitives, architecture, eval order, audit/budget, releases, and the harness design |
> | [`harness-research.md`](../wiki/harness-research.md) | the evidentiary base (Part I problem space · Part II a2a intent-drift experiment · Part III identity & the gate) — referenced, not duplicated |
> | [`harness-cookbook.md`](../wiki/harness-cookbook.md) | operator-vetted capability bundles (the Part 2 §5.2 recipe tier) |
> | [`usage-guide.md`](../wiki/usage-guide.md), [`../../bareguard.context.md`](../../bareguard.context.md) | human / LLM wiring guides |
> | `harness-code-mode/` | the POC seam + E1–E6 gates (never shipped; Part 2 §9) |
> | `.claude/stash/*`, `CLAUDE.md` | session history / doctrine — never source of truth |
>
> When this PRD and a companion disagree, **this PRD wins**; fix the companion.
>
> **Reading the two parts.** Each part keeps its own section numbering. **Within a
> part, a bare "§N" means *that part's* section N; cross-part references are written
> "Part 1 §N" / "Part 2 §N".** (The two parts were authored as two PRDs and merged
> 2026-06-23 into this one authority; the seam is the part boundary, not a content cut
> — every decision, POC finding, and validation from both is preserved.)
>
> Status legend (used throughout Part 2): **LOCKED** (settled in design),
> **PROPOSED** (stated, not settled), **OPEN** (unresolved), **DEFERRED** (gated on a
> real external signal).

(bareguard-prd.md:1-46)

## Where the rest lives

This page carries Part 1 (Core bareguard) §§0–16 and §18. The rest of the authority
lives in sibling pages:

- [Releases & roadmap](../wiki/releases-roadmap.md) — Part 1 §19 (release/migration history, the 1.0 HOLD + SemVer surface, future-feature candidates), §20 POC retrospective, §21 success criteria for v1.0.0
- [Design governance](../wiki/design-governance.md) — Part 1 §17 NO-GO list, §22 decisions log, Appendix C (the test for any new primitive), Appendix E (evaluating adopter feedback)
- [Harness design](../wiki/harness-design.md) — Part 2 §0–5, §7, §11–12 (build state, locked spine, the two axes, floor, harness, mapping onto primitives incl. `bash.classify`, bounds, relationships)
- [Axis B](../wiki/axis-b.md) — Part 2 §6 return reconciliation, §8 / 8.1 / 8.2 (`gate.annotate` build spec)
- [POC validation](../wiki/poc-validation.md) — Part 2 §9 POC plan + graduation gates (E1–E6), 9.3 litectx integration bench, §10 open questions
- [Relationships](../wiki/relationships.md) — Part 1 Appendix A (other agent-tooling layers), Appendix B (inside the bare suite), Appendix D (v0.1.1 file layout)
- [Harness research](../wiki/harness-research.md) — the evidentiary base

The full pre-split original is archived at `../archive/bareguard-prd.md`.

---

## 0. TL;DR

- **What:** `bareguard` is the policy layer an agent runner imports. Every tool call
  traverses `gate.check(action)`; every result hits `gate.record(action, result)`.
  One gate, one audit log, one budget ledger, thirteen primitives. Small enough to
  read in an afternoon.
- **The one boundary:** it constrains **actions against the world**, never **words
  the model produces** (Part 1 §6). Content/toxicity/PII is somebody else's layer.
- **Part 1 (core, shipped):** start at §1–§2 for the summary, §8 for the primitive
  table, §9 for the load-bearing 6-step eval order, §10 for the API, §17 for the
  NO-GO list, §19 for the release history + the 1.0 HOLD.
- **Part 2 (the harness, design):** start at §0/§3 for the two-axis frame. Axis A is
  Part 1 sharpened (**built & released**); Axis B (`gate.annotate`, §8.2) is the one
  genuinely new surface (**built & released — 0.7.0**); the floor is user-authored and the
  agent never re-authors it (the security boundary). §9 is the POC evidence.

(bareguard-prd.md:49-64)

---

# Part 1 — Core bareguard (the policy library)

> **For future Claude (implementation note):** This part is the single
> source of truth for the core bareguard library. §3/§4 say what bareguard IS / IS
> NOT. §8 is the 12 primitives table with halt-vs-action severity. §9 is
> the architecture and the 6-step evaluation order — that order is
> load-bearing, implement it exactly. §10 is the public API including
> `humanChannel`. §12 is the audit format. §17 is the NO-GO list — point
> at it instead of reopening discussions. §22 is the decisions log; do not
> re-litigate items there unless the user explicitly asks.

(bareguard-prd.md:69-76)

---

## 1. One-line summary

`bareguard` is a one-dep, local-first runtime policy library for autonomous
agents. It bounds what the agent can *do*, not what it can *say*. (bareguard-prd.md:82-83)

## 2. Two-paragraph summary

bareguard is the policy layer that bareagent (and any other agent runner)
imports. Every tool call traverses `gate.check(action)`; every result hits
`gate.record(action, result)`. There is one gate, one audit log, one budget
ledger, and thirteen primitives — bash, budget, fs, net, limits, approval,
tools, secrets, audit, defer-rate, spawn-rate, content, flags. Each primitive is
~30–180 LOC, composable through the single gate. The library is small enough
that you can read the whole thing in an afternoon and understand exactly what
your agent is allowed to do. (bareguard-prd.md:87-94)

bareguard ships with safe defaults — destructive verbs (delete, drop, revoke,
truncate) trigger ask-human prompts via a single `humanChannel` callback;
explicit dangers (DROP TABLE, rm -rf /) are denied outright. Multi-agent runs
share one budget file (locked via `proper-lockfile`) and one audit JSONL
file (atomic via POSIX `O_APPEND`); audit lines include `parent_run_id` and
`spawn_depth` so a family of agents reconstructs into one timeline with grep.
Run-level limit exhaustion (budget, maxTurns) escalates to the human via the
registered `humanChannel`; never bubbles silently to the LLM. (bareguard-prd.md:96-103)

## 3. What bareguard IS

- A **policy library** — a single `Gate` class with three call sites:
  `gate.redact()`, `gate.check()`, `gate.record()`. Plus convenience methods
  `gate.run()`, `gate.allows()`, `gate.haltContext()`, `gate.terminate()`,
  `gate.raiseCap()`. (bareguard-prd.md:107-110)
- An **action-side guard** — it enforces what the agent does to the world
  (bash commands, fs writes, network calls, MCP invocations, child spawns,
  budget consumption). (bareguard-prd.md:111-113)
- The **single source of truth** for runtime policy decisions in any agent
  runner that uses it. No duplicate policy in the runner, the tools, or
  anywhere else. (bareguard-prd.md:114-116)
- A **structured audit producer** — every gated event is one JSONL line.
  One file across the agent family. The audit log IS the canonical cost
  record (the shared budget file is a derived live counter for cross-process
  speed). (bareguard-prd.md:117-120)
- A **library**. There is no `bareguard serve`, no daemon mode, no network
  endpoint. It runs in-process with the agent runner. (bareguard-prd.md:121-122)

## 4. What bareguard is NOT

- **NOT a content guardrail.** It does not check toxicity, PII, factuality,
  schema, persona, tone, topic blocklists, or hallucinations. That's
  `guardrails-ai`'s job, or a system prompt's job. The action vs content line
  is the single most important boundary — see §6. (bareguard-prd.md:126-129)
- **NOT a sandbox.** It prevents an action from being called; it does not
  contain the action's effects. Containment is Docker, gVisor, Firecracker,
  or OS perms — a different layer. (bareguard-prd.md:130-132)
- **NOT an identity / authn / authz layer.** It sees actions, not principals.
  Per-user policy is the caller's concern (pass a different `Gate` instance
  per user). (bareguard-prd.md:133-135)
- **NOT an external-API rate limiter.** Rate-limiting Stripe or OpenAI is
  the API's job or a separate library's. bareguard rate-limits internal
  actions like `defer` and `spawn` because those are budget vectors. (bareguard-prd.md:136-138)
- **NOT a scheduler.** It does not wake up, fire deferred actions, or run
  cron. It only validates actions when asked. (bareguard-prd.md:139-140)
- **NOT a hosted service.** No SaaS, no telemetry, no phone-home. JSONL to
  a file or a callback; what users do downstream is their problem. (bareguard-prd.md:141-142)
- **NOT a framework.** No plugin system, no hooks, no DSL, no YAML schema,
  no class hierarchies. The 12 primitives are functions; the gate is a
  class with ~10 methods. That's the whole API. (bareguard-prd.md:143-145)
- **NOT MCP-aware.** It glob-matches strings. The `mcp:server/tool` naming
  convention is a *user-facing convention*, not parsing logic in bareguard. (bareguard-prd.md:146-147)
- **NOT a long-running process.** It exits when the agent runner exits. (bareguard-prd.md:148)

## 5. Why this exists

Two adjacent things already exist and neither solves this:

- **`guardrails-ai`** is content validation for LLM apps — toxic-language,
  regex match, schema validation, PII detection. It checks what the model
  *says*. Useful, but a different problem.
- **bareagent v0.x** previously shipped bash allowlist, token budget, gov
  layer (per-tool allow/deny/ask) as built-ins. That coupled them to one
  runner. bareguard extracts that policy layer so any runner can use it,
  and policy doesn't drift across the suite.

(bareguard-prd.md:152-160)

The gap is a small, runner-agnostic library focused entirely on the *action
side* of the agent loop, with first-class support for multi-agent (siblings
sharing budget), deferred work (rate-limited `defer()`), and MCP governance
through generic name-and-pattern matching. That's bareguard. (bareguard-prd.md:162-165)

## 6. Core thesis: action vs content

**Action-bounding, not content-shaping.** The single test for any candidate
primitive:

> Does it constrain an action against the world (or against a sibling
> process), or constrain words the model produces?

If the latter, refuse — that's a system prompt's job, or `guardrails-ai`'s.
This rule keeps bareguard small forever. (bareguard-prd.md:169-176)

| Layer                  | Concern                                  | Owner                |
| ---------------------- | ----------------------------------------- | -------------------- |
| System prompt          | What the model should be like            | The user's prompt    |
| `guardrails-ai`        | What the model is *allowed to say*       | guardrails-ai        |
| **bareguard**          | **What the agent is *allowed to do***    | **this library**     |
| Sandbox (Docker, etc.) | What the action can *affect*             | OS-level tooling     |
| OS perms / SELinux     | What the process can *touch*             | OS                   |

Five layers. bareguard owns exactly one. Everything else is somebody else's
library or somebody else's problem. (bareguard-prd.md:178-187)

## 7. Positioning

|              | guardrails-ai                      | bareguard                                  |
| ------------ | ------------------------------------ | -------------------------------------------- |
| Concern      | Content (what the model says)      | Actions (what the agent does)              |
| Examples     | Toxicity, PII, schema, regex       | Bash, fs, net, tokens, cost, spawn, defer  |
| Multi-agent  | N/A                                 | Shared budget, depth caps, parent stitching|
| MCP gov      | N/A                                 | Glob-match `mcp:server/tool`; pattern args |
| Shape        | Framework + Hub + optional server  | Library, one file per primitive            |
| Deps         | Many                                | One (`proper-lockfile`)                    |
| Deployment   | npm/pip + config + sometimes server| `import`                                    |

**They compose, they don't compete.** A user wrapping a chatbot uses
`guardrails-ai`. A user building a coding agent uses bareguard. A user doing
both imports both. (bareguard-prd.md:191-203)

## 8. The thirteen primitives

Each is one file, ~30–180 LOC, composes through the single gate. **Severity
column** classifies what happens when the primitive fires (see §11 for the
halt-vs-action distinction). (bareguard-prd.md:207-209)

| #  | Primitive            | Severity | What it checks                                                                                                          |
| -- | --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1  | **bash**             | action   | Command allowlist / denyPatterns when `action.type === "bash"`. With `allow` set, commands containing shell metacharacters (`;` `\|` `&` `$` backtick `()` `<>` newline) are denied (rule `bash.allow.shellMeta`) — a prefix allowlist can't bound a chain/pipe/substitution; use `content.denyPatterns` for chaining-aware screening. Reads `action.cmd`, falling back to `action.args.cmd` / `action.args.command` so wireGate-style `{type, args, _ctx}` adapters compose without translation. A present-but-non-string `cmd` is denied (`bash.invalidCmd`, v0.5) — closes a type-confusion fail-open. |
| 2  | **budget**           | **halt** | Tokens, cost USD, request count, with hard kill. Shared across sibling processes via backing file + `proper-lockfile`. The backing file is written **atomically** (temp file + `rename`, v0.5.1) so a racing reader never observes a truncated/empty file. |
| 3  | **fs**               | action   | Write/read scope; deny paths (`~/.ssh`, `/etc/passwd`). Paths are lexically normalized (`.`/`..` collapsed, and backslashes folded to `/` first so Windows-style traversal can't slip past — v0.5) and matched with segment boundaries before scope/deny — traversal can't escape a scope or deny entry. Symlinks are **not** resolved (canonicalize upstream if needed). Reads `action.path` / `action.args.path`; a present-but-non-string path is denied (`fs.invalidPath`, v0.5). |
| 4  | **net**              | action   | Egress domain allowlist; deny private IP ranges — covers IPv4 (incl. `127/8`, `10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16` / cloud metadata, `0.0.0.0/8`), IPv6 (loopback/ULA/link-local, bracket-stripped) and IPv4-mapped IPv6. Hostname-based, **pre-DNS-resolution** (no DNS-rebinding defense — defense-in-depth, not an SSRF boundary; use `allowDomains` to bound egress). Reads `action.url` / `action.args.url`; a present-but-non-string url is denied (`net.invalidUrl`, v0.5). |
| 5  | **limits**           | mixed    | `maxTurns` (**halt**, ticks on every `gate.record`), `maxToolRounds` (**halt**, ticks only on non-`"llm"` records — v0.4.2), `maxChildren` (action), `maxDepth` (action), `timeoutSeconds` (**halt**, v0.2). |
| 6  | **approval**         | n/a      | Routes ask events to the runner's `humanChannel` callback. No callback storage in v0.6. |
| 7  | **tools**            | action   | Tool name allowlist / denylist (glob-matched) + per-tool `denyArgPatterns` (regex over args). Allowlist is **scope-only** — does NOT silence asks. |
| 8  | **secrets**          | n/a      | Redaction of `action` / `result` / `reason` on every audit line at write time — eval runs on the *unredacted* action so matching is never weakened; redaction is non-mutating (the caller's object is untouched). Three layers: **key-aware** (BG-1, **default-on**) blanks a field by *name* → `[REDACTED:key=<name>]` (narrow default `apiKey`/`api_key`/`authorization` + value patterns `Bearer …`/`sk-…`; extend via `secrets.keys`, disable via `secrets.redactKeys:false`); **env-var** values → `[REDACTED:VAR_NAME]`; **pattern** matches → `[REDACTED:pattern=<short prefix>...]` (both opt-in via `secrets.envVars`/`secrets.patterns`, v0.4.5). `redact()` also exported for ad-hoc use. |
| 9  | **audit**            | n/a      | Append-only JSONL of every gated decision. **One file per agent family** via POSIX `O_APPEND` atomicity (Windows uses lock fallback). Includes `parent_run_id` and `spawn_depth` for multi-agent stitching. |
| 10 | **defer-rate**       | action   | _(v0.2)_ Caps `defer()` calls per minute. Re-validates the deferred action's gate decision on emit AND on fire (defense in depth). |
| 11 | **spawn-rate**       | action   | _(v0.2)_ Caps `spawn()` calls per minute and per parent's lifetime. Composed with `limits.maxChildren` and `limits.maxDepth`. |
| 12 | **content**          | mixed    | Pattern-matches over `JSON.stringify(action)`. `denyPatterns` block (action). `askPatterns` escalate to human (action). Generic mechanism that catches dangerous *shapes* across all tools. **Safe defaults shipped (§11).** |
| 13 | **flags**            | mixed    | _(0.6 / litectx seam — baresuite-litectx-prd §5B)_ Gates on a named action **field's value** read directly (`action.provenance`, `action.injectionRisk`), never `JSON.stringify` — the structured complement to `content`. Config `{ <field>: { <value>: "deny" \| "ask" } }`. Deny arm at step 2b, ask arm at step 4b, **both before the allowlist** (floor supremacy). Restricts only (never grants); absent/unmapped field = no-op. Lets a memory adopter pass a structured verdict (source label + optional `injectionRisk`) without encoding it as matchable text; bareguard renders the deny/ask, the content judgment stays the adopter's (the §6 line). Generic — **no `memory.*` type recognition** (the floor is already type-generic). Because `type` is itself a field, `flags: { type: { bash: "ask" } }` yields **blanket per-action-type confirmation** — ask the human before *every* `bash`, even an allowlisted one — so one `humanChannel` owns confirmation instead of a separate per-tool approval channel. |

(bareguard-prd.md:211-225)

**Why `content` makes MCP gov work without MCP-specific code:** content patterns
run over the serialized action JSON, so the tool name AND every argument value
are in the haystack. A `bash` call with `cmd: "rm -rf /"` and an
`mcp:db.tool/query` call with `sql: "DROP TABLE users"` are both caught by the
same regex, regardless of which tool was invoked. (bareguard-prd.md:227-231)

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

**Hard rules** (bareguard-prd.md:250-266):

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
default`. (bareguard-prd.md:270-272)

```
PRE-EVAL (cross-cutting, all halt severity if triggered):
  P-1. safeAction(action)           ← normalize to own-props-only (null-proto +
                                      null-proto args); no inherited field off a
                                      polluted Object.prototype can flip a
                                      decision. run() also executes this copy so
                                      decision == execution (no TOCTOU).
  P0. secrets.redact(action)        ← mutation, not a decision
  P1. budget.check()                ← halt if exceeded
  P2. limits.maxTurns               ← halt if exceeded
  P3. terminated check              ← halt if previously gate.terminate()'d

THE 6 STEPS (first match wins; 2b/4b are co-located arms of step 13 `flags`):
  1. tools.denylist                 → deny (action)
  2. content.denyPatterns           → deny (action)
        (content.unserializable — an action that cannot be serialized for
         pattern matching (cycle, BigInt, throwing toJSON/getter) fails CLOSED
         here rather than being waved through unmatched; also reachable on its
         own from step 4's ask check if content.denyPatterns is configured [])
  2b. flags deny                    → deny (action; action[field] value maps to "deny")
  3. per-action-type deny rules     → deny (action)
        bash.denyPatterns / bash.allow / bash.invalidCmd (when action.type === "bash")
        fs.deny / fs.readScope / fs.writeScope / fs.invalidPath (when read/write/edit)
        net.allowDomains / net.denyPrivateIps / net.invalidUrl (when fetch)
        limits.maxChildren / limits.maxDepth (when spawn)
        tools.denyArgPatterns (any tool with matching args)
        (*.invalid* — present-but-non-string cmd/path/url is denied, not waved
         through; closes a type-confusion fail-open, v0.5)
  4. content.askPatterns            → askHuman (action; resolved via humanChannel)
  4b. flags ask                     → askHuman (action; action[field] value maps to "ask")
  5. tools.allowlist enforcement    → set+match: allow; set+miss: deny (rule: tools.allowlist.exclusive)
     (set to [] = scope of nothing = deny all; a non-array denies via tools.allowlist.invalid;
      only an ABSENT/null key skips this step)
  6. default                        → allow (rule: "default")
```

**Order rationale:** universal denies (1-2b-3) catch everything dangerous
regardless of who allowed what. Universal asks (4-4b) are the safety floor —
they fire even on allowlisted tools. Capability scope (5) restricts which
tools the agent can invoke at all. Default allow (6) is the bottom. **`flags`
(2b/4b) gates a structured field's value rather than a serialized-text match —
it is the deny/ask floor's structured complement to `content`, and sits before
the allowlist for the same reason `content` does: a flag may never be relaxed
by allowlisting the action's `type`.** Rule id `flags.<field>`. (bareguard-prd.md:310-317)

### 9.2 `tools.allowlist` is scope-only — NOT a trust shortcut

v0.4 of this PRD made allowlist short-circuit ask ("explicit listing =
explicit consent"). v0.6 reverses that. Allowlist now means **only "which
tools can be invoked at all":** (bareguard-prd.md:321-323)

- **Unset (`undefined`/`null`):** no effect; flow continues to step 6 (default allow).
- **Empty (`[]`):** a configured scope of *nothing* — every action is denied
  (rule: `tools.allowlist.exclusive`). `[]` is NOT "unset". (Changed — breaking,
  v0.14; previously `[]` was folded into unset and fell through to allow.)
- **Present but not an array** (`""`, `0`, `false`, `NaN`, a string, an object):
  denied (rule: `tools.allowlist.invalid`), same as `fs.invalidPath` /
  `net.invalidUrl` / `bash.invalidCmd`. `tools.denyArgPatterns.<tool>` is guarded
  the same way (rule: `tools.denyArgPatterns.invalid`) — a deny rule the gate
  cannot evaluate fails closed. Both are reachable only by mutating the config
  after construction; the constructor rejects these shapes outright. Previously the falsy ones read as unset
  and fell through to allow, and the truthy ones threw out of the gate.
- **Set with one or more entries:**
  - tool name matches → `allow` (rule: `tools.allowlist`).
  - tool name does not match → `deny` (rule: `tools.allowlist.exclusive`).

(bareguard-prd.md:325-338)

Both branches happen at step 5, AFTER `content.askPatterns` at step 4.
**Allowlisted tools still get asked** when they match a safe-default
askPattern (e.g., `delete`, `revoke`, `force-push`). (bareguard-prd.md:340-342)

**Why the change** (foot-gun surfaced in POC phase 2): the v0.4 rationale
("explicit allowlist = explicit consent") assumed users allowlist specific
destructive entries like `mcp:linear.app/delete_comment`. In practice, users
allowlist general tools (`bash`, `fetch`, `read`) for everyday capability,
and the short-circuit silently disables the safe-default ask floor. That
conflicts with the §11 promise that safe defaults are the floor, not the
ceiling. (bareguard-prd.md:344-350)

**For the v0.4 use case (silence ask on a specific known-destructive tool):**
- Trim or narrow `content.askPatterns` (caller-side override).
- OR use `tools.denyArgPatterns` for tool-specific rules.
- OR have the runner's `humanChannel` auto-approve known patterns.

The library no longer offers a "trust shortcut" via allowlist — that was the
foot-gun. (bareguard-prd.md:352-358)

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
    // Key-aware redaction is DEFAULT-ON (BG-1) even with no `secrets` block:
    // case-insensitive keys apiKey / api_key / authorization + value patterns
    // `Bearer …` / `sk-…` are blanked on every audit line. These layer on top:
    envVars:  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
    patterns: [/sk-[A-Za-z0-9]{40,}/, /ghp_[A-Za-z0-9]{36}/],
    keys:     ["X-Api-Key", "*_token"], // extend the default key set (suffix glob ok)
    // redactKeys: false,               // opt out of the default-on backstop entirely
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
framework, no DSL. `new Gate(config)` is the only canonical constructor. (bareguard-prd.md:450-451)

### 10.1 The `humanChannel` contract (what bareguard does with each return)

| `decision` | Behavior |
|---|---|
| `"allow"` | Emit `phase: "approval"` audit line; gate.check returns terminal `allow`. |
| `"deny"`  | Emit `phase: "approval"`; gate.check returns terminal `deny` with severity preserved from the original ask/halt. |
| `"topup"` | Only meaningful for halt severity. Validates `newCap`. Calls `gate.raiseCap` internally (audit `phase: "topup"`). Re-evaluates the gate.check; max 5 topup iterations to prevent loops. For ask-severity events, treated as allow. |
| `"terminate"` | Emit `phase: "approval"` + `phase: "terminate"`; gate becomes sticky-terminated. Every subsequent check returns `deny` + halt + `rule: "gate.terminated"`. |

(bareguard-prd.md:455-460)

If `humanChannel` is **not registered** and an ask/halt fires:
- One-time stderr `WARN` line on first occurrence.
- Returns `deny` + halt + `rule: "...originalRule..."` + reason `"...originalReason... (no humanChannel registered)"`.
- Behavior is correct for headless / CI runs (deny = safe default when no
  human present).

(bareguard-prd.md:462-466)

**bareguard never caches humanChannel returns.** Every ask reaches `humanChannel` fresh — no allowlist of past `yes` answers, no TTL'd decision memo, no "you approved this shape once, don't re-ask." That's a deliberate non-goal (§17): "same action" has no universal definition (same args? same arg shape? same session? what TTL?), and that choice belongs to the runner's UX, not this library. README Recipe 8 ships a ~25-line wrapper that adds sticky approvals on top of the channel without touching the gate. (bareguard-prd.md:468)

**Optional `humanChannelTimeoutMs`** (default: unset = wait forever). When set on the Gate config, bareguard races the `humanChannel` promise against a timer. If the timer wins, gate.check resolves to `{ outcome: "deny", severity: "halt", rule: <originalRule>, reason: "humanChannel timeout after Xms" }` and emits a `phase: "approval"` audit line carrying the timeout reason. The timeout always denies — there is no allow-on-timeout default. Callers wanting allow-on-timeout (e.g. autonomous fleets where one stuck branch shouldn't pin a worker) must implement that policy inside their own `humanChannel`, so the choice is explicit in user code, not a bareguard default. The pending channel promise is not cancelled; if it later resolves, the result is dropped (the agent will re-prompt on the next gate.check). (bareguard-prd.md:470)

**`event.action` is ALWAYS the action being checked (v0.4 contract).** For ask events this is the action that fired the askPattern / approval rule. For halt events the cap was already exhausted on entry — this specific action did not by itself trip it — but it is the action whose evaluation surfaced the halt, and the right hook for caller-attached routing context (e.g. `action._ctx` in multi-tenant adopters that need to route halt prompts back to the originating principal). bareguard treats `action` as opaque pass-through; whatever the caller attaches survives verbatim into `event.action` and into audit `phase: "gate" | "record"` lines. The dedicated `phase: "halt"` audit line remains action-less by design (operator grep target with `dimension / spent / cap / rule / awaiting`). (bareguard-prd.md:472)

### 10.2 `gate.allows(action)` — the catalog pre-filter

Pure query, no audit write, no budget delta, no humanChannel call. Used by
callers (e.g., bareagent's `mcp_discover`) to filter a catalog before showing
it to the LLM. (bareguard-prd.md:476-477)

- Accepts a full action object **OR** a tool-name string (auto-wrapped to
  `{ type: name }`).
- Returns `true` for `allow` AND `askHuman` outcomes; `false` for `deny`.
  Reason: hiding ask-gated tools from the LLM means the agent never tries
  them, never gets the prompt. The whole point of askHuman is "human decides
  at invoke time" — that requires LLM visibility.

(bareguard-prd.md:480-485)

```js
const filtered = catalog.filter(t => gate.allows(t.name));
```

### 10.3 Primitives manifest (`primitives.json`)

Author-time discovery, not a runtime tool surface — nothing in `src/` reads
this file. An agent that has just `npm install`ed bareguard can read
`primitives.json` to learn what the package offers and how to call it,
without parsing prose. (bareguard-prd.md:493-496)

A primitive is any exported symbol whose JSDoc block carries an `@when` tag —
the tag is the inclusion marker, so there is no separate target list that can
drift from the source. `@when` / `@fails` / `@example` are the only
hand-authored fields on each entry; `name` / `import` / `signature` /
`category` are derived from the source. As of this manifest, 13 of the
package's 14 public exports are manifested; `BudgetUnavailableError` is
deliberately excluded (a bare error class — you catch it, you don't reach
for it as a capability). (bareguard-prd.md:498-505)

The manifest carries **no `version` field**: `package.json` ships in the
same tarball and is the single authority, so a version stamped in
`primitives.json` would be a fourth pin that could only ever go stale — and
stale in a believable way, reading as authoritative while lying. (bareguard-prd.md:507-510)

```js
import primitives from "bareguard/primitives.json" with { type: "json" };
// primitives.primitives: [{ name, category, when, import, signature, fails, example }, ...]
```

Shipped via the `"./primitives.json"` exports subpath and `pkg.primitives`.
Generated by `scripts/gen-primitives.mjs` (`npm run build:primitives`);
`npm run check:primitives` (wired into CI) exits non-zero if the committed
file has drifted from source. `test/primitives-completeness.test.js` fails
if a new public export is neither manifested nor added to that test's
deliberate-exclusion allow-list, so a new export can't silently miss the
manifest. (bareguard-prd.md:518-523)

## 11. Safe defaults shipped out of the box

bareguard ships with these defaults baked into `content`. Users who want
pure-allow override with `content.askPatterns: []` and `content.denyPatterns:
[]`. Users who want stricter behavior add their own. (bareguard-prd.md:527-529)

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

This is ~10 lines of regex and it covers ~90% of what gets agents in trouble. (bareguard-prd.md:549)

**Safe defaults are the FLOOR, not the ceiling.** They fire even on
allowlisted tools — that's the v0.6 reversal of the v0.4 short-circuit. If
they over-match for your use case, narrow them. The trade is intentional:
over-asking is recoverable; under-asking is incidents. (bareguard-prd.md:551-554)

### 11.1 Halt-vs-action severity classification

Every decision carries `severity: "action" | "halt"`.

- **`severity: "action"`** — per-action policy decision. The runner returns
  the result (or structured error) to the LLM and continues the loop.
- **`severity: "halt"`** — run-level limit exhausted. **The runner MUST NOT
  bubble it to the LLM.** bareguard handles halt internally by calling
  `humanChannel`; the runner only sees the post-human terminal allow/deny.

(bareguard-prd.md:558-564)

**Halt-severity rules:** `budget.maxCostUsd`, `budget.maxTokens`,
`budget.resource.<name>` (OQ3), `budget.unpriced` (v0.9, only when
`budget.failClosedOnUnpriced` is set and a finite `maxCostUsd` cap is active),
`limits.maxTurns`, `limits.timeoutSeconds` (v0.2), `gate.terminated`. Every
other rule is action severity. (bareguard-prd.md:566-570)

## 12. Audit trail spec

The audit log is bareguard's spine. **One file per agent family** — parent +
children + grandchildren all `appendFile` the same path. POSIX `O_APPEND`
guarantees atomicity for writes < `PIPE_BUF` (4KB on Linux/macOS); same
mechanism nginx access logs use. Windows uses a `proper-lockfile` fallback
(auto-detected via `process.platform`). (bareguard-prd.md:574-578)

**Format:** JSONL, one line per gated event, append-only.

**Default path** (in order, first that resolves):
1. `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl`
2. `$HOME/.local/state/bareguard/<root-run-id>.jsonl`
3. `./bareguard-<root-run-id>.jsonl` (cwd fallback)

Children inherit via env var `BAREGUARD_AUDIT_PATH` set by the parent. (bareguard-prd.md:582-587)

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
| `record` | every `gate.record()` after a successful execute | `action`, `result` (incl. `costUsd`, `tokens`, optional `pricing`) |
| `unpriced` | (v0.9) a `record()` whose cost could not be priced (`result.pricing === "unpriced"`, or a present-but-non-finite `costUsd`) | `action`, `aid`, `reason` |
| `approval` | `humanChannel` returned a decision | `decision`, `reason`, `newCap` |
| `halt` | dedicated grep target on halt | `dimension`, `spent`, `cap`, `rule`, `awaiting` |
| `topup` | runner / humanChannel raised a cap | `dimension`, `oldCap`, `newCap` |
| `terminate` | gate terminated (graceful) | `reason` |
| `annotate` | (v0.7) every well-formed `gate.annotate()` fact (Part 2 §8.2) | `surface`, `verdict`, `where`, `meta` |
| `annotate_malformed` | (v0.13) a `gate.annotate()` call whose fact could not be read — no `surface` boolean, or the read itself threw (Part 2 §8.2.1). Nothing buffered; no decision changed | `reason` (`not-an-object` \| `array` \| `missing-surface` \| `unreadable`) |

(bareguard-prd.md:589-614)

**Properties:**

- Redaction happens **before** gate sees the action. Audit lines never
  contain action-side secrets. (bareguard-prd.md:618-619)
- **Caller is responsible for redacting tool results** before passing to
  `gate.record`. bareguard ships the `redact()` helper — apply to results too. (bareguard-prd.md:620-621)
- Budget remaining = `initial - accrued(record lines)` over the log.
  Reconstructable from the audit log on cold start (used when the budget
  file is missing/corrupt). **(v0.9)** The reconstruction accrues each
  `record` line through the *same* sanitizer as live accrual (`sanitizeSpend`:
  clamp negative deltas, skip unpriced/non-finite costs) — so a cold-start
  rebuild can never diverge from live spend (a raw sum would re-apply negatives
  the live path rejects and under-enforce the cap after a restart). (bareguard-prd.md:622-628)
- Monotonic `seq` per gate instance. Helps detect gaps within a process. (bareguard-prd.md:629)
- **Truncation:** lines > 3.5KB (safety margin under PIPE_BUF) get truncated
  with explicit `_truncated: true` boolean at line root for downstream
  consumers, plus inline `[TRUNCATED:n bytes]` markers in the field that
  was cut. (bareguard-prd.md:630-633)
- **Unserializable payload:** if the line cannot be `JSON.stringify`d at all
  (a cyclic `action`/`result`, a `BigInt`, a throwing `toJSON`/getter), it
  degrades to a scalars-only line tagged `_dropped: "payload not
  serializable"` instead of throwing out of the gate and losing the line —
  the decision, rule, correlation ids, and the round's spend (re-derived
  `result.costUsd`/`.tokens`/`.pricing` and `action.type`) still survive.
  If even that re-derivation throws (a throwing getter on those fields), the
  line is tagged `_dropped_carriers: true` instead of losing the whole line. (bareguard-prd.md:634-641)
- **Key-count bound (the scalars-only backstop's own bound):** the two
  backstops above (oversize-line, unserializable-payload) both reduce to a
  scalars-only line whose per-field VALUES are clipped but whose top-level
  KEY COUNT was, until this fix, unbounded — many caller-supplied top-level
  scalar keys could still push the reduced line back over 3.5KB. `boundKeyCount`
  now drops the largest droppable keys first, re-measuring after each, stamping
  `_dropped_keys`/`_dropped_bytes` so the loss is loud and countable. A frozen
  `MUST_KEEP_KEYS` table protects the routing/correlation fields the line
  format depends on plus the budget-rebuild carriers (`dimension`/`newCap` on
  a `phase:"topup"` line; `action.type`/`result.costUsd`/`.tokens`/`.pricing`
  are re-derived separately and never top-level scalar keys here). A
  genuinely-final guard covers the case where even that must-keep core does
  not fit `MAX_LINE_BYTES` — not reachable with today's fixed key set and byte
  caps, but present so the "never over the cap" invariant holds with no
  exception: it falls back to `{ts, seq, run_id, _dropped_keys,
  _dropped_bytes, _dropped_core: true}`, or a bare `{_dropped_core: true}` if
  even that doesn't fit. On a `_dropped_core` line, `phase`/`decision`/
  `dimension`/`newCap` and the re-derived spend carriers are NOT preserved —
  a cold-start budget rebuild would not see that round at all. (bareguard-prd.md:642-660)

**Output sink:** file path OR callback function. Nothing else. (Datadog,
Loki, S3 are caller-side adapters.) (bareguard-prd.md:662-663)

**Fileless mode (v0.4, test-only):** setting `audit.path: null` explicitly
puts the Audit instance in in-memory mode. `emit` pushes parsed line
objects onto `gate.audit.entries`; no fs writes, no PIPE_BUF truncation.
`audit.readAll()` returns the in-memory entries. Intended for unit tests
that want to assert on the audit stream without stubbing fs. Distinct
from `audit.path: undefined` which falls through to env var / XDG default. (bareguard-prd.md:665-670)

## 13. Shared budget across processes

When a parent spawns a child and both should draw from the same budget
ceiling, configure `budget.sharedFile`. Implementation uses
`proper-lockfile` (the one allowed dep). (bareguard-prd.md:674-676)

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
`BudgetUnavailableError`. v0.1 only writes v1. (bareguard-prd.md:692-693)

**Refresh policy (lazy, not per-check):**

- On `init()`: read the file, populate local cache.
- After every `record()`: write under lock; refresh cache from post-write state.
- On lock acquisition (any reason): refresh while holding the lock.
- **NOT on `gate.check()`:** trust the local cache.

(bareguard-prd.md:697-700)

**Worst case:** another process's record between two of our checks isn't
visible until our next record or lock. Budget may be exceeded by one
action's spend. Halt fires reliably on the next check after a record.
Caps are soft by design. (bareguard-prd.md:702-705)

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

(bareguard-prd.md:707-723)

Children inherit the path via env var `BAREGUARD_BUDGET_FILE`, set by the
parent's `spawn` tool. (bareguard-prd.md:725-726)

### 13.1 Strict mode (v0.4, opt-in)

Default budget behavior is soft per §13: caps are tripped on the first
check AFTER `spent >= cap`. The previous action's spend is the slack —
unavoidable when cost is only known post-execute. (bareguard-prd.md:730-732)

`budget.strict: true` adds a pre-flight projection. The Budget instance
maintains a rolling buffer of the last 5 `record.result.{costUsd,tokens}`.
On every `gate.check` (PRE-EVAL halt phase), if the buffer has **≥3
samples**, bareguard halts when:

```
spent + last5Avg > cap
```

per dimension. The halt fires BEFORE the action executes, eliminating
the soft-cap slack at the cost of one "false halt" worth of variance
(when an unusually cheap action would have fit but the average wouldn't). (bareguard-prd.md:734-745)

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

(bareguard-prd.md:747-756)

`budget.strict` defaults to `false`; existing adopters see no behavior
change. (bareguard-prd.md:758-759)

## 14. Spawn and defer guards

These primitives exist because of bareagent's `spawn` and `defer` tools. (bareguard-prd.md:763)

### 14.1 `limits.maxChildren` and `limits.maxDepth`

- **Per-parent:** a parent agent can spawn at most `maxChildren` children
  concurrently and over its lifetime.
- **Per-tree:** total depth from root cannot exceed `maxDepth`.

Tracked in the audit log; reconstructed on startup from the log if needed.
Without these, one bug spawns 10K agents and burns the budget in 30 seconds. (bareguard-prd.md:767-772)

### 14.2 `defer.ratePerMinute` (v0.2)

Caps how many `defer` actions a single agent run can pass through the
gate per minute. Default: **15** (down from the v0.4 baseline of 30 — easier
to relax than tighten). Prevents a confused agent from emitting 1000 jobs
into the queue. (bareguard-prd.md:776-779)

Counted from the audit log, not a separate counter file. Per-family
(across the spawn-tree rooted at the topmost `run_id`), not per-process —
otherwise children spawned by a fork-bomb-shaped agent each reset to
`0/cap`. Per-family scope is automatic: the audit file is keyed by
`root_run_id` and inherited by spawned processes via
`BAREGUARD_AUDIT_PATH`. (bareguard-prd.md:781-786)

### 14.3 `spawn.ratePerMinute` (v0.2)

Same idea for `spawn`. Default: 10. Prevents fork-bomb shapes even if
`maxChildren` is set generously. Composes with `limits.maxChildren`
(concurrency cap) and `limits.maxDepth` (depth cap) — this is rate, not
concurrency. (bareguard-prd.md:790-793)

Counted from the audit log, per-family — same mechanism as
`defer.ratePerMinute` (§14.2). (bareguard-prd.md:795-796)

### 14.4 Defense in depth: re-validate deferred actions on fire

A defer is **two separate `gate.check` calls against two distinct actions** —
the `defer` action at emit (which the rate cap counts), and the inner
action at fire (which goes through the gate independently). Each call
produces its own audit record. (bareguard-prd.md:800-803)

When the wake script reads a deferred action and invokes bareagent to fire
it, the fired action passes through the gate as its own type (`bash`,
`fetch`, etc.) — not as `defer`. A defer whose inner action would be
denied at fire time (budget exhausted, target file no longer in fs scope,
new content rule added) is denied at fire time. The audit log records
both the emit decision and the fire decision. (bareguard-prd.md:805-810)

### 14.5 Audit log as the rate counter

Both rate caps count records in the audit log within a trailing 60s
window. **No separate counter file.** Eliminates a second source of truth
and keeps cross-process correctness automatic via the existing single-file
audit (POSIX `O_APPEND`, family-scoped path, inherited across spawned
processes). One source of truth — the audit log — for both spend (`record`
phase) and rate (`gate` phase, type-filtered). (bareguard-prd.md:814-819)

## 15. The `tools` vs `content` distinction (frequently confused)

| Rule                       | Looks at                  | Match type | Outcome     | Example                                                |
| -------------------------- | ------------------------- | ---------- | ----------- | ------------------------------------------------------ |
| `tools.allowlist`          | tool name                 | glob       | allow (scope) | `"mcp:linear.app/*"`                                   |
| `tools.denylist`           | tool name                 | glob       | deny        | `"mcp:*/delete_*"`                                     |
| `tools.denyArgPatterns`    | action.args (per tool)    | regex      | deny        | `{ "update_issue": [/priority.*critical/] }`           |
| `content.denyPatterns`     | full serialized action    | regex      | deny        | `/DROP\s+TABLE/i`                                      |
| `content.askPatterns`      | full serialized action    | regex      | ask human   | `/\b(delete\|drop\|revoke)\b/i`                        |

(bareguard-prd.md:823-829)

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

(bareguard-prd.md:833-841)

## 16. MCP governance (Path A)

bareguard governs MCP tools through the same primitives that govern bash
and fetch. There is no MCP-specific code in bareguard. (bareguard-prd.md:845-846)

### 16.1 The flow

1. `bareagent.mcp_discover()` — bareagent reads MCP server catalogs, caches
   for 30 days. **bareguard is not consulted.** Discovery is metadata
   access, not an action.
2. `bareagent.mcp_invoke(toolName, args)` — bareagent invokes the MCP tool.
   **bareguard's `tools` and `content` primitives check it** as it would
   any other action. Tool name (e.g., `mcp:linear.app/list_issues`) is
   glob-matched; args are regex-matched.

(bareguard-prd.md:850-856)

### 16.2 Why "Path A"

Path A is sufficient: same machinery as bash gov, just with longer tool
names. bareguard stays catalog-blind, which is a feature:

- The policy library doesn't grow MCP-shaped knowledge.
- It doesn't break when the catalog refreshes.
- Users can change MCP servers without touching bareguard config.

(bareguard-prd.md:860-865)

### 16.3 `gate.allows()` as an ergonomic, not a gov mechanism

bareagent can call `gate.allows(toolName)` during `mcp_discover` to filter
the catalog before showing it to the LLM. Pure context optimization. Gov
decisions still happen at invoke time via `gate.check()`. (bareguard-prd.md:869-871)

### 16.4 Tool name convention and glob semantics

`mcp:<server-host>/<tool-name>` — string convention bareguard glob-matches. (bareguard-prd.md:875)

**Glob in v0.1: `*` only, matches any character including `/`.** No `?`,
no `[abc]`, no escapes. Trade-offs:

- For denylists: safe (denies more, never less). `mcp:*/admin_*` catches
  `mcp:foo/admin_baz` AND `mcp:foo/admin_baz/sub/path`.
- **For allowlists: can over-grant.** `mcp:linear.app/*` matches
  `mcp:linear.app/list_issues` AND `mcp:linear.app/sub/foo`. Err narrow on
  allowlists; list specific tools when possible.

v0.2 may add shell-style `**` so `*` becomes "anything except `/`". Not
v0.1. (bareguard-prd.md:877-887)

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

(bareguard-prd.md:936-945)

**Production deps target: 1.** Hard target. Any deviation requires explicit
justification in the PRD. (bareguard-prd.md:947-948)

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
`strictNullChecks` on the source itself is both simpler and more thorough. (bareguard-prd.md:950-962)
