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
| 3 | Eval order fully pinned across all primitives                     | §9.1            |
| 4 | `tools.allowlist` is scope-only — no longer short-circuits ask    | §9.1, §9.2      |
| 5 | Shared budget file (`proper-lockfile`) is **v0.1**, not v0.2      | §13, §19        |
| 6 | `approval.callback` removed from bareguard config (runner-owned)  | §8 row 6, §10   |
| 7 | Audit log gains `halt`, `topup`, `terminate`, `approval` phases   | §12             |
| 8 | New gate methods: `raiseCap`, `terminate`, `haltContext`, `recordApproval` | §10     |
| 9 | Glob `*` matches anything including `/` (v0.1)                    | §16.4 clarified |
| 10| Result redaction format and caller-responsibility documented      | §8 row 8        |
| 11| `gate.allows()` signature and askHuman behavior pinned            | §10.1           |
| 12| Halt vs deny classification per primitive                         | §8              |
| 13| `humanChannel` callback consolidates ALL ask/halt/topup/terminate | §6 supersedes; §10 |
| 14| Single audit file with O_APPEND atomicity (no per-process files)  | §12 supersedes  |
| 15| Glob: `*`-only, no `?`/`[abc]`/escapes (v0.1)                      | §9 clarified    |
| 16| Budget file format gains `version: 1`                              | §13             |
| 17| Budget cross-process refresh: lazy (post-record + on-lock)         | §13             |
| 18| Concurrency contract: gate.check/record serial per gate instance   | new behavior    |
| 19| Default audit path: `$XDG_STATE_HOME/bareguard/<run-id>.jsonl`     | §12             |
| 20| v0.1 scope: everything except rate limits (defer-rate, spawn-rate) | §19             |

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

## 3. Eval order — full pin (supersedes §9.1 entirely)

v0.4 §9.1 had 6 steps over `tools.*` and `content.*` only, with placement of
the other primitives unspecified, and allowlist short-circuited ask. v0.5 pins
the **complete** eval order across all primitives, and **removes the
allowlist→ask short-circuit** so safe-default asks always fire.

```
PRE-EVAL (cross-cutting):
  P0. secrets.redact(action)        ← mutates action; not a decision step
  P1. budget.check()                ← halt if exceeded
  P2. limits.maxTurns                ← halt if exceeded

THE 6 STEPS (first terminal wins):
  1. tools.denylist                 → deny (action)
  2. content.denyPatterns           → deny (action)
  3. PER-ACTION-TYPE deny primitives → deny (action)
       — bash.denyPatterns, bash.allow (action.type === "bash")
       — fs.deny, fs.writeScope, fs.readScope
       — net.allowDomains, net.denyPrivateIps
       — limits.maxChildren, limits.maxDepth (action.type === "spawn")
       — spawn.ratePerMinute, defer.ratePerMinute (per action type)
       — tools.denyArgPatterns
  4. content.askPatterns            → askHuman (action)
  5. tools.allowlist enforcement    → see §4 below
  6. default                        → allow (rule: "default")
```

**Order rationale:** deny > ask > capability-scope > default.
- Universal denies (1-2-3) catch everything dangerous, regardless of who allowed what.
- Universal asks (4) are the safety floor — they fire even on allowlisted tools.
- Capability scope (5) restricts which tools the agent can invoke at all.
- Default allow (6) is the bottom.

**First match wins** still holds within step 3 across action-type primitives.

## 4. `tools.allowlist` is a scope check, not a trust short-circuit (supersedes §9.2)

v0.4 §9.2 made allowlist short-circuit ask ("explicit listing = explicit consent").
v0.5 removes that. Allowlist now means **only "which tools can be invoked at all":**

- **Unset or empty:** no effect; flow continues to step 6 (default allow).
- **Set with one or more entries:**
  - tool name matches → `allow` (rule: `tools.allowlist`).
  - tool name does not match → `deny` (rule: `tools.allowlist.exclusive`).

Both branches happen at step 5, AFTER content.askPatterns at step 4.
**Allowlisted tools still get asked** when they match a safe-default askPattern
(e.g., `delete`, `revoke`, `force-push`).

**Why this change (the design tension surfaced in POC phase 2):** the v0.4 §9.2
rationale ("explicit allowlist = explicit consent") assumed users allowlist
specific destructive entries like `mcp:linear.app/delete_comment`. In practice,
users allowlist general tools (`bash`, `fetch`, `read`) for everyday capability,
and the short-circuit silently disables the safe-default ask floor. That conflicts
with the v0.4 §11 promise that safe defaults are the floor, not the ceiling.

**For the §9.2 use case (silence ask on a specific known-destructive tool):**
- Trim or narrow `content.askPatterns` (caller-side override).
- OR use `tools.denyArgPatterns` for tool-specific rules.
- OR have the runner's approval handler auto-approve known patterns.

The library no longer offers a "trust shortcut" via allowlist — that was the
foot-gun.

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

## 13. `humanChannel` callback consolidates ask/halt/topup/terminate (supersedes §6, §8 above)

§6 above said "bareguard returns askHuman; runner handles all I/O" — three gate methods (`recordApproval`, `raiseCap`, `terminate`). In practice that's three separate runner round-trips per human decision and easy to misuse. v0.5.2 collapses this to **one runner-supplied callback** that bareguard invokes whenever a human is needed.

```js
const gate = new Gate({
  // ...other config...
  humanChannel: async (event) => {
    // event.kind:    "ask" | "halt"
    // event.action:  redacted action that triggered (null for halt)
    // event.severity: "action" | "halt"
    // event.rule:    e.g., "content.askPatterns" | "budget.maxCostUsd"
    // event.reason:  human-readable string
    // event.context: deterministic stats (only on halt — same shape as haltContext())
    //
    // Runner displays UX (TUI prompt, Slack reaction, PIN, web button — bareguard knows none of it)
    // Runner returns the decision:
    return {
      decision: "allow" | "deny" | "topup" | "terminate",
      newCap?:  number,    // when decision === "topup"
      reason?:  string,    // optional, recorded in audit
    };
  },
});
```

**Behavioral contract:**

- bareguard **calls** the registered `humanChannel` from inside `gate.check()` whenever the eval would return `askHuman` OR `severity: "halt"`. The runner doesn't see a separate askHuman step.
- bareguard **applies** the human's decision atomically: emits the `phase: "approval"` audit line, plus `phase: "topup"` (and updates the budget file under lock) if topup, plus `phase: "terminate"` if terminate.
- `gate.check()` returns the **post-human** terminal decision (`allow` / `deny`). The runner's loop only ever branches on those two outcomes.
- If `humanChannel` is **not registered** and the eval returns askHuman/halt: `gate.check` returns `{ outcome: "deny", severity: "halt", rule: "...original rule...", reason: "no humanChannel registered" }`. **Never silently allow.** The agent loop terminates cleanly via the runner's deny-handling.

**This isn't bareguard "doing I/O"** — bareguard calls a function the runner gave it. Same separation as `gate.run(action, executor)`: bareguard knows nothing about TUIs, Slack, PINs, or auth. It just invokes the callback and applies the structured result.

**Methods removed by this consolidation:**

- ~~`gate.recordApproval(action, humanDecision)`~~ — no longer needed; bareguard records internally.
- ~~`gate.raiseCap(dimension, newCap)`~~ — no longer public; called internally on `topup`. Still exposed for non-human-driven cap changes (e.g., scripted reset).
- ~~`gate.terminate(reason)`~~ — no longer public from human flow; still exposed for runner-initiated terminate (e.g., agent finished cleanly).

`gate.haltContext()` stays public — the runner may want to format halt info for a UI before invoking the channel, OR `humanChannel` may inspect `event.context` directly (we ship it on every halt event).

## 14. Single audit file with O_APPEND atomicity (supersedes §12 and §7 above)

v0.4 §12 said "Children write to separate files (linked by `parent_run_id`); cheaper than contending on one file." That assumed lock contention on a shared file. **POSIX `O_APPEND` writes < `PIPE_BUF` (4KB on Linux/macOS) are atomic** — multiple processes append to the same file without locking and the kernel guarantees no interleaving. This is how nginx access logs, syslog, and similar production systems work.

v0.5.2 changes the model:

- **One audit file per agent family**, identified by the root run id. Default path: `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl` (cwd fallback).
- All processes (parent + children + grandchildren) `appendFile` the same file. Each line tagged with `run_id`, `parent_run_id`, `spawn_depth` so the writer is identifiable.
- **No lock on audit appends.** (proper-lockfile remains, but only for the budget file — read-modify-write needs serialization.)
- Audit line size cap: **3.5KB** (safety margin under PIPE_BUF). Larger `action.args` are truncated with `[TRUNCATED:n bytes]` markers.

**Stitching becomes trivial:** the audit IS one file. `grep run_id=X` shows that process. `parent_run_id` lookup gives the family tree directly. No multi-file find/grep needed.

**Spawn record carries `child_run_id`:**

```jsonl
{"phase":"record","action":{"type":"spawn",...},"result":{"child_run_id":"...","exitCode":0,...},...}
```

Combined with each child's audit lines being in the same file, the family tree reconstructs from one file with grep alone.

**Caveats documented in README:**
- `O_APPEND` atomicity NOT guaranteed on NFS or Windows. Linux + macOS local FS is the supported target for v0.1.
- On filesystems where atomicity isn't guaranteed, fall back to the budget-file-style lock on audit emit (slow but safe). v0.1 ships Linux/macOS as primary; Windows users get the lock fallback automatically.

## 15. Glob `*`-only confirmed for v0.1 (clarifies §9 above)

v0.1 ships exactly one wildcard, `*`, matching any character including `/`. **No `?`, no `[abc]`, no escapes.** Reasoning (simple > clever):

- Tool names in real usage rarely need character classes or single-char wildcards.
- Smaller surface area to maintain and document.
- Layered defense (denylist + content + per-action-type) covers gaps from over- or under-matching.

If real use exposes pain in v0.1, v0.2 may introduce shell-style `**`. Not before.

## 16. Budget file format gains `version` field (extends §13)

To allow future expansion (memory, GPU, time-elapsed dimensions) without migration headaches, the shared budget file gets a `version` field at root:

```json
{
  "version": 1,
  "cap_usd":      5.00,
  "spent_usd":    1.23,
  "cap_tokens":   100000,
  "spent_tokens": 24500,
  "started_at":   "2026-04-29T14:00:00Z",
  "owners":       ["run_01J...", "run_01J..."]
}
```

bareguard reads `version` on init and either accepts (v1) or refuses with a clear error (future versions). v0.1 only writes v1.

## 17. Budget cross-process refresh: lazy, not per-check (clarifies §13)

The POC refreshed the budget file on every `gate.check()`. That's wasteful — within one process, the budget can only change via that process's own `record()`, OR via another process's write since the last refresh.

v0.5.2 specifies refresh policy:

- **On `init()`:** read the file, populate local cache.
- **After every `record()`:** write under lock (this happens anyway), refresh local cache from the post-write file state.
- **On lock acquisition** for any reason: refresh while holding the lock (we've paid the I/O already).
- **NOT on `gate.check()`:** trust the local cache.

**Worst case:** another process's record between two of our checks isn't visible until our next record or lock. Cap may be exceeded by one action's worth of spend (~$0.01-0.10). Acceptable — caps are soft, halt fires on the very next check after the next refresh.

## 18. Concurrency contract: gate.check/record serial per gate instance (new behavior)

bareguard's `seq` counter, local budget cache, and audit emit ordering all assume **one in-flight `gate.check` or `gate.record` call per gate instance at a time.** This matches how an agent loop works in practice (one action at a time, awaited).

**Documented contract:**

> `gate.check()` and `gate.record()` MUST be called serially per `Gate` instance. Concurrent calls produce undefined `seq` values and may interleave audit lines incorrectly. Multiple `Gate` instances (e.g., parent + child processes) MAY run concurrently — they are independent.

If a runner needs concurrent action evaluation in v0.2+, we'd add `gate.checkBatch(actions)` that internally serializes. Not for v0.1.

## 19. Default audit path (clarifies §12)

If the caller does not specify `audit.path`, default to (in order):

1. `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl`
2. `$HOME/.local/state/bareguard/<root-run-id>.jsonl` (XDG fallback)
3. `./bareguard-<root-run-id>.jsonl` (last-resort cwd)

Children inherit the path via env var `BAREGUARD_AUDIT_PATH` set by the parent on spawn. Same for budget file via `BAREGUARD_BUDGET_FILE`.

## 20. v0.1 scope: everything except rate limits (supersedes §5.2 above)

The POC validated more of the design than the original v0.1 baseline (§5.2) included. Pulling more into v0.1 since it's shown to work; v0.2 becomes the rate-limits release.

**v0.1 includes:**
- All 12 primitives EXCEPT `defer-rate` (#10) and `spawn-rate` (#11).
- `tools.denyArgPatterns` (already in `tools` primitive).
- `gate.allows()` (catalog pre-filter).
- Multi-agent audit stitching (`parent_run_id`, `spawn_depth`) — required by single-audit-file model anyway.
- Shared budget file with `proper-lockfile`.
- Halt severity, `humanChannel`, single audit file with O_APPEND.
- All safe defaults from v0.4 §11.

**v0.2 adds:**
- `defer-rate` and `spawn-rate` primitives (and the corresponding bareagent `defer`/`spawn` tools that exercise them).
- `**` glob wildcard if v0.1 use exposes need.
- Sliding-window rate (if fixed-window proves insufficient).

**v1.0 stabilizes** — API freeze, SemVer commitments. Then walk-away.

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
- **Allowlist is scope-only, not a trust shortcut.** v0.4 §9.2's short-circuit rationale was a foot-gun in practice: allowlisting general tools silently disabled the safe-default ask floor. Allowlist now only enforces capability scope; askPatterns always fire. (v0.5 §4.)
- **Per-action-type primitives sit at step 3 (universal-deny phase).** Deny > ask > scope. (v0.5 §3.)
- **No LLM speculation on halt.** bareguard provides deterministic stats only. LLM self-estimate is a runner concern, opt-in, with caveats. (v0.5 §2.4.)
- **Glob `*` matches `/` in v0.1.** Layered defense covers over-match risk. v0.2 may introduce `**` if real pain emerges. (v0.5 §9.)
- **Result redaction is the caller's responsibility.** bareguard ships format helpers (`[REDACTED:ENV_VAR_NAME]`, `[REDACTED:pattern=...]`). (v0.5 §10.)
- **`gate.allows(action)` returns true for askHuman.** Catalog pre-filter must show ask-gated tools so LLM can attempt them. (v0.5 §11.)
- **All human escalations go through one `humanChannel` callback.** bareguard calls a runner-supplied function whenever ask/halt is triggered; applies the human's decision atomically (audit, topup, terminate). The runner branches on `allow`/`deny` only — askHuman is never a separate runner step. (v0.5 §13.)
- **Single audit file with `O_APPEND` atomicity.** No per-process files, no audit lock; relies on POSIX guarantees < PIPE_BUF. Family tree reconstructable from one file with grep. Linux/macOS primary; Windows uses lock fallback. (v0.5 §14.)
- **Budget file format is versioned.** `version: 1` at root; future-proofs schema growth. (v0.5 §16.)
- **Budget cross-process refresh is lazy.** Refresh post-record and on-lock, not per-check. Soft caps acceptable. (v0.5 §17.)
- **gate.check/record are serial per gate instance.** Documented contract; matches real agent-loop usage. (v0.5 §18.)
- **v0.1 scope: everything except rate limits.** POC validated more than original baseline; defer/spawn-rate stay v0.2 since they require bareagent's not-yet-existing tools. (v0.5 §20.)
