# bareguard — PRD v0.5 amendments to v0.4

**Status:** Draft v0.5 (amendments only — implementation-ready alongside v0.4)
**Owner:** hamr0
**Last updated:** 2026-04-29
**Supersedes:** v0.4 sections cited per item below
**Sibling spec:** `bareagent-prd.md`

> **For future Claude:** Read `bareguard-prd.md` (v0.4) FIRST. This document
> overrides specific parts of v0.4 based on the 2026-04-29 design discussion.
> Where this doc conflicts with v0.4, **this doc wins**. Where it is silent,
> v0.4 stands. The numbered amendments below are listed in execution order
> for the implementer; cross-references show which v0.4 section each affects.

---

## Summary of changes

| # | Change                                                            | Affects v0.4 §  |
| - | ----------------------------------------------------------------- | --------------- |
| 1 | Decision shape gains `severity: "action" \| "halt"` field         | §3, §10         |
| 2 | Run-level limit exhaustion halts-with-human, never bubbles to LLM | new behavior    |
| 3 | Per-action-type primitives placement in eval order specified      | §9.1            |
| 4 | `tools.allowlist` made **exclusive** when non-empty               | §9.1            |
| 5 | Shared budget file (`proper-lockfile`) is **v0.1**, not v0.2      | §13, §19        |
| 6 | `approval.callback` removed from bareguard config (runner-owned)  | §8 row 6, §10   |
| 7 | Audit log gains `halt`, `topup`, `terminate`, `approval` phases   | §12             |
| 8 | New gate methods: `raiseCap`, `terminate`, `haltContext`, `recordApproval` | §10     |
| 9 | Glob `*` matches anything including `/` (v0.1)                    | §16.4 clarified |
| 10| Result redaction format and caller-responsibility documented      | §8 row 8        |
| 11| `gate.allows()` signature and askHuman behavior pinned            | §10.1           |
| 12| Halt vs deny classification per primitive                         | §8              |

---

## 1. Decision shape (supersedes §3, §10)

`gate.check(action)` now returns:

```js
{
  outcome:  "allow" | "deny" | "askHuman",
  severity: "action" | "halt",
  rule:     "string identifier of the matched rule",
  reason:   "string | null",
}
```

`severity` is **required** on every decision.

- `severity: "action"` — per-action policy decision. The runner returns the result (or error) to the LLM and continues the loop.
- `severity: "halt"` — run-level limit exhausted. **The runner MUST escalate to a human and pause the loop.** It MUST NOT pass a halt back to the LLM as a normal error. See §2.

For deny/ask outcomes, the runner receives a structured error to surface:

```js
{ error: { type: "policy_denied", rule, reason, action_summary } }
```

`action_summary` is bareguard's redacted, single-line representation of the action (≤ 200 chars). Used so the LLM and operator can see what was blocked without leaking secrets or full payloads.

## 2. Halt semantics (new behavior, no v0.4 equivalent)

### 2.1 What triggers a halt

Halt is reserved for **run-level** limits where continuing makes no sense:

- `budget.maxCostUsd` exhausted
- `budget.maxTokens` exhausted
- `limits.maxTurns` reached

Everything else is `severity: "action"` deny:

- `tools.denylist`, `tools.denyArgPatterns`, `content.denyPatterns`
- `bash.*`, `fs.*`, `net.*` rules
- `limits.maxChildren`, `limits.maxDepth`
- `spawn.ratePerMinute`, `defer.ratePerMinute`

### 2.2 Runner contract on halt

When the runner sees `severity: "halt"`:

1. **MUST** pause the agent loop.
2. **MUST** invoke its human-approval channel, framed as a run-level pause (not an inline confirm).
3. **MUST NOT** return the decision to the LLM as a normal error.
4. **MUST NOT** silently terminate.
5. If no human channel is wired (e.g., CI, overnight): terminate with structured non-zero exit and a final `phase: "halt"` audit line. **Never** fall back to "pass to LLM."

### 2.3 Audit lines for a halt

Three lines minimum (more if the human takes time to respond):

```jsonl
{"phase":"gate","decision":"askHuman","severity":"halt","rule":"budget.maxCostUsd","reason":"spent $5.20, cap $5.00",...}
{"phase":"halt","run_id":"...","dimension":"costUsd","spent":5.20,"cap":5.00,"awaiting":"human","ts":"..."}
{"phase":"approval","decision":"topup","newCap":10.00,"ts":"..."}    // OR "terminate"
```

The dedicated `phase: "halt"` line is the operator grep target ("what stopped the run last night").

### 2.4 No speculation on remaining work

bareguard provides only deterministic, audit-derived stats at halt time. It does not call the LLM to ask "how much more do you need." That hook, if a runner wants it, is the runner's concern with explicit caveats — see `gate.haltContext()` in §8 below.

## 3. Per-action-type primitives placement in eval order (supersedes §9.1)

The 6-step `tools.*` / `content.*` order from v0.4 §9.1 stands. The placement of all other primitives is now specified:

```
PRE-EVAL (cross-cutting, before the 6 steps):
  P0. secrets.redact(action)        ← already specified in v0.4 §9
  P1. budget.check()                ← halt if exceeded
  P2. limits.maxTurns                ← halt if exceeded

THE 6 STEPS:
  1. tools.denylist match           → deny (action)
  2. content.denyPatterns match     → deny (action)
  3a. tools.allowlist match         → allow (terminal, short-circuits ask)
  3b. tools.allowlist set AND no match → deny (action)        ← NEW (see §4)
  4. content.askPatterns match      → askHuman (action)
  5. PER-ACTION-TYPE deny primitives → deny (action)          ← MOVED HERE
       — bash.denyPatterns, bash.allow (when action.type === "bash")
       — fs.deny, fs.writeScope, fs.readScope (when action is fs op)
       — net.allowDomains, net.denyPrivateIps (when action is net op)
       — limits.maxChildren, limits.maxDepth (when action.type === "spawn")
       — spawn.ratePerMinute, defer.ratePerMinute (per action type)
       — tools.denyArgPatterns (already specified)
  6. default                        → allow
```

**Why step 5 for action-type primitives:** they enforce specifics that even an
allowlisted tool should not bypass. A user writing `tools.allowlist: ["bash"]`
still wants `bash.denyPatterns: [/sudo/]` and `fs.deny: ["~/.ssh"]` to apply.
Same logic as `tools.denyArgPatterns` (v0.4 §9.2).

**First match wins** still holds within step 5 across primitives.

## 4. `tools.allowlist` is exclusive when non-empty (supersedes §9.1, §9.2)

v0.4 left this ambiguous. v0.5 pins it:

- If `tools.allowlist` is **unset or empty**: behaves as before (no effect; flow falls through).
- If `tools.allowlist` is **set with one or more entries**: tools not on the list are denied at step 3b (action-level deny). Listed tools still short-circuit ask at step 3a.

This matches user-instinct allowlist semantics ("only these are allowed") while preserving the §9.2 short-circuit reasoning ("explicit listing = explicit consent, no need to ask again").

## 5. Shared budget file is v0.1 (supersedes §13, §19)

The §13 shared-budget file with `proper-lockfile` is brought forward into v0.1 (was originally scheduled for v0.2). Reasons:

- Pre-allocation alternatives (parent gives child a fixed slice at spawn) are too rigid in practice — children hit the cap close to the finish line and waste in-flight work.
- The PRD already approved `proper-lockfile` as the one allowed dep specifically for this case (§18); deferring it earned nothing.
- A bespoke parent↔child budget-extension protocol over JSONL is more complex than the dep itself.

### 5.1 Audit-vs-file relationship (clarifies §12)

v0.4 §12 said "the audit log IS the budget ledger." This is partially true and was confusing. v0.5 pins it:

- The **audit log is the canonical cost record.** Every `phase: "record"` line carries the cost delta. Reconstruct any historical state from it.
- The **shared budget file is a derived live counter** for cross-process speed. Updated under `proper-lockfile` on every `record()`. On parent startup with a missing/corrupt budget file, scan the audit log(s) under `parent_run_id` and rebuild the counter from history.
- One canonical source (audit), one fast counter (file). Not two sources of truth.

### 5.2 Migration plan update (supersedes §19)

bareguard 0.1 — extraction baseline now includes:
- All primitives 1, 2, 3, 4, 5, 6, 7, 8, 9 from §8.
- **Plus shared budget file (`budget.sharedFile` + `proper-lockfile`).**
- **Plus halt vs action severity classification.**
- Excludes still: `defer-rate`, `spawn-rate`, `content`, `tools.denyArgPatterns`, `gate.allows()`, multi-agent audit stitching (`parent_run_id`, `spawn_depth`). Those stay in 0.2.

## 6. `approval.callback` removed from bareguard config (supersedes §8 row 6, §10)

v0.4 §10 showed `approval: { callback: myApprovalFn }` in the bareguard config. v0.5 removes this. Reasons:

- bareguard is a pure policy library — invoking I/O callbacks (TUI, Slack, web) belongs to the runner.
- Different runners need different UX (inline TUI prompt, Slack reaction, CI auto-deny, PIN). bareguard should not encode any.
- Cleaner separation: bareguard returns the decision; runner decides what to do with `outcome: "askHuman"`.

The `approval` primitive (v0.4 §8 row 6) remains, but its scope is **only** "which patterns/conditions trigger askHuman." The actual human invocation is the runner's responsibility.

The bareguard config block becomes:

```js
approval: {
  // (intentionally empty in v0.1 — approval triggers come from
  //  content.askPatterns and severity:halt classification)
}
```

If `approval` config is unused in v0.1, the key may be omitted from the PRD example in §10. Removed from the public API.

## 7. Audit log additions (supersedes §12)

New phase values join `gate` and `record`:

| phase       | When emitted                                                              |
| ----------- | ------------------------------------------------------------------------- |
| `gate`      | every `gate.check()` decision (existing)                                  |
| `record`    | every `gate.record()` after a successful execute (existing)               |
| `approval`  | runner reports back the human's choice on askHuman (`allow` / `deny`)     |
| `halt`      | dedicated grep target on run-level limit exhaustion (see §2.3)            |
| `topup`     | runner raised a cap via `gate.raiseCap()` after human approved a top-up   |
| `terminate` | runner ended the run via `gate.terminate()` (graceful, not crash)         |

Each phase line keeps the v0.4 required fields (`ts`, `seq`, `run_id`, `parent_run_id`, `spawn_depth`, `phase`, `action`, `decision`, `rule`, `reason`, `result`) plus phase-specific fields:

- `halt`: `dimension` ("costUsd" / "tokens" / "turns"), `spent`, `cap`, `awaiting`
- `topup`: `dimension`, `oldCap`, `newCap`
- `approval`: `decision` ("allow" / "deny" / "topup" / "terminate"), and for topup also `newCap`
- `terminate`: `reason`

## 8. New gate methods (supersedes §10)

```js
// HALT-FLOW (new)
gate.haltContext()                           → { spent, cap, turns, timeElapsed,
                                                  spendRate: { avgPerTurn, last5Avg, last5 },
                                                  breakdown: { llmTokensUsd, toolCallsUsd } }
                                              // Pure query over audit log. No side effects.
                                              // Returned object is what the runner formats for the human.

await gate.raiseCap(dimension, newCap)        → { ok: true }
                                              // Updates the budget file under lock.
                                              // Emits phase:"topup" audit line.
                                              // dimension: "costUsd" | "tokens" | "turns"

await gate.terminate(reason)                  → { ok: true, exitCode: 0 }
                                              // Emits final phase:"terminate" audit line.
                                              // Idempotent. Does not exit the process — caller does.

// APPROVAL-FLOW (new)
await gate.recordApproval(action, humanDecision)  → void
                                              // humanDecision: { decision: "allow" | "deny" | "topup" | "terminate", newCap?, reason? }
                                              // Emits phase:"approval" audit line.
                                              // For decision: "topup", caller should also call gate.raiseCap().
```

`gate.run(action, executor)` (v0.4 §10) behavior on non-allow outcomes:

- `outcome: "deny", severity: "action"` → returns the structured error (see §1) as the result. Does NOT throw.
- `outcome: "askHuman", severity: "action"` → throws `RunnerMustHandleAsk` (caller did not register a runner-level approval handler). Runners using `gate.run` must catch this OR pre-handle ask flow.
- `severity: "halt"` (any outcome) → throws `RunnerMustHandleHalt`. Runners using `gate.run` must catch this and invoke the human channel + `recordApproval` + optional `raiseCap`.

Throwing on halt ensures `gate.run` cannot silently fall through to "pass to LLM."

## 9. Glob semantics for v0.1 (clarifies §16.4)

In v0.1, `*` matches **any character including `/`**.

- `mcp:*/admin_*` matches `mcp:linear.app/admin_revoke` AND `mcp:foo/bar/admin_baz`.
- `mcp:linear.app/*` matches `mcp:linear.app/list_issues` AND `mcp:linear.app/sub/path`.

Rationale: simple, permissive on denylist (catches more), narrowable on allowlist via more specific patterns. Layered defense (denylist + content + per-action-type) means an over-broad `*` is caught downstream.

If real use exposes pain (users wanting "match this level only"), v0.2 adds shell-style `**` with `*` then meaning "anything except `/`". Not v0.1.

## 10. Secrets redaction format (clarifies §8 row 8)

Caller is responsible for redacting tool **results** before passing them to `gate.record()`. v0.4 only specified action-side redaction.

Redaction format bareguard ships in its `secrets` primitive helpers (caller may use or ignore):

- **Env-var match (we know the source):** `[REDACTED:ANTHROPIC_API_KEY]`
- **Pattern match (we don't know the source):** `[REDACTED:pattern=sk-...]` — keeps a short prefix indicator only, not enough entropy to be useful to an attacker, enough to disambiguate "which kind of secret."

Why not show the suffix: leaking the suffix of a key gives an attacker a target ("which key ends in ...XYZ"). Industry standard is full redaction with a name tag.

## 11. `gate.allows()` pinned (clarifies §10.1)

- **Signature:** `gate.allows(action) → boolean`. Takes the full action shape, identical to `gate.check`. (Earlier inline note `gate.allows(name)` in v0.4 §10 was a typo — disregard.)
- **Pure query:** no audit write, no budget delta, no side effects.
- **Return value:** `true` for both `allow` AND `askHuman` outcomes; `false` for `deny`.
- **Reason askHuman returns true:** the catalog pre-filter is for the LLM. Tools that would prompt a human at invoke time should still be visible — that's the whole point of askHuman ("human decides at invoke time"). Hiding them means the agent never tries them, never gets the prompt.

## 12. Halt vs deny classification (extends §8 table)

| #  | Primitive            | Severity if triggered |
| -- | -------------------- | --------------------- |
| 1  | bash                 | action                |
| 2  | budget               | **halt**              |
| 3  | fs                   | action                |
| 4  | net                  | action                |
| 5  | limits.maxTurns      | **halt**              |
| 5  | limits.maxChildren   | action                |
| 5  | limits.maxDepth      | action                |
| 5  | limits.timeoutSeconds| **halt**              |
| 6  | approval (askPatterns→ask) | action          |
| 7  | tools                | action                |
| 8  | secrets              | n/a (pre-eval mutation, not a deny) |
| 9  | audit                | n/a (emitter)         |
| 10 | defer-rate           | action                |
| 11 | spawn-rate           | action                |
| 12 | content              | action                |

`limits.timeoutSeconds` is included as halt for completeness — wall-clock exhaustion is also "this run is over, ask the human." Implementation may defer to v0.2.

---

## Implementation order for Phase 2 of the POC (per v0.4 §20)

POC §20 phase 2 deliverables, updated:

1. fs primitive at step 5
2. net primitive at step 5
3. secrets primitive (redaction on action-side) pre-eval
4. content primitive (denyPatterns, askPatterns) at steps 2 and 4
5. Safe defaults from §11 baked into content
6. JSONL audit to disk (existing `Audit.lines` becomes file-write)
7. `severity` field threaded through every decision and audit line
8. Halt classification (budget halt, maxTurns halt) wired
9. **Bring forward from phase 3:** shared budget file with `proper-lockfile`
10. Reconstruct budget counter from audit log on startup
11. `gate.haltContext()`, `gate.raiseCap()`, `gate.terminate()`, `gate.recordApproval()` minimal stubs

Phase 2 budget per v0.4 §20: 90 min target, 2 hours stretch, 3 hours stop. Items 7–11 push the upper bound — explicit budget update: **2 hours target, 3 hours stretch, 4 hours stop.** If we hit the stop, the design is exposing a problem the POC is correctly catching; pause and discuss.

Phase 2 anti-goals from §20 still hold: no API polish, no error handling polish, no cross-platform, no docs, no tests, single file. Make it crude. Do not graduate to nice code.

---

## Items NOT changed by these amendments (re-affirming v0.4)

- 12 primitives list (§8) — no additions, no deletions, only severity classification added.
- Action vs content thesis (§6) — unchanged. Still the single most important boundary.
- NO-GO list (§17) — unchanged. PIN authentication explicitly stays NO-GO (under "Identity / authn / authz" line); approval UX in any form is runner-side.
- Walk-away after v1.0 (§19) — unchanged. New features = new sibling repos.
- Single allowed dep `proper-lockfile` (§18) — unchanged. v0.5 brings it forward to v0.1, doesn't add others.
- Bare suite philosophy: no telemetry, no SaaS, no daemon mode, no plugin framework.

---

## Decisions log appended to v0.4 §22

These are resolved and should not be re-litigated unless the user explicitly asks.

- **Halt is a separate severity from deny.** Run-level limit exhaustion (budget, maxTurns) MUST go to a human, MUST NOT bubble to the LLM. Per-action denies do bubble. (v0.5 §1, §2.)
- **Shared budget file is v0.1, not v0.2.** Pre-allocation alternatives are too rigid; the bespoke extension protocol is more complex than the dep. (v0.5 §5.)
- **Audit is canonical, budget file is derived.** One source of truth for history; one fast counter for cross-process. Reconstruct file from audit on startup if missing/corrupt. (v0.5 §5.1.)
- **`approval.callback` config does not exist in bareguard.** Runner owns all human I/O. (v0.5 §6.)
- **Allowlist is exclusive when set.** v0.4 §9.2 short-circuit reasoning still applies for tools that ARE listed. (v0.5 §4.)
- **Per-action-type primitives sit at step 5.** Even allowlisted tools must respect bash/fs/net deny rules. (v0.5 §3.)
- **No LLM speculation on halt.** bareguard provides deterministic stats only. LLM self-estimate is a runner concern, opt-in, with caveats. (v0.5 §2.4.)
- **Glob `*` matches `/` in v0.1.** Layered defense covers over-match risk. v0.2 may introduce `**` if real pain emerges. (v0.5 §9.)
- **Result redaction is the caller's responsibility.** bareguard ships format helpers (`[REDACTED:ENV_VAR_NAME]`, `[REDACTED:pattern=...]`). (v0.5 §10.)
- **`gate.allows(action)` returns true for askHuman.** Catalog pre-filter must show ask-gated tools so LLM can attempt them. (v0.5 §11.)
