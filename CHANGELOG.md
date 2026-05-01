# Changelog

All notable changes to bareguard are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.3.1] — 2026-05-01

Bug-fix patch. No API changes.

### Fixed

- **[C1] `gate.check()` no longer throws when humanChannel returns `topup` on a `limits.maxTurns` halt.** `_haltDimension` previously returned `"turns"` for that rule, causing `Budget.raiseCap` to throw (it only accepts `"costUsd"` / `"tokens"`). Now returns `null`, which routes through the existing "topup not applicable to this rule" guard.
- **[C2] `SAFE_DEFAULT_DENY_PATTERNS` DELETE regex fixed.** `/\bDELETE\s+FROM\s+\w+(?!\s+WHERE)/i` allowed the regex engine to backtrack to a partial table name, causing `DELETE FROM users WHERE id=1` to be falsely hard-denied. Fixed with `\b` after `\w+` to prevent partial-word backtracking.
- **[I1] `BAREGUARD_ROOT_RUN_ID` env var added.** Deep spawn trees (grandchild+) previously computed `rootRunId` as the child run ID rather than the true root, silently splitting per-family audit files and rate counters. Propagators should now set `BAREGUARD_ROOT_RUN_ID` alongside `BAREGUARD_PARENT_RUN_ID`.
- **[I2] `topup`-on-ask path now emits a terminal `phase:"gate", decision:"allow"` audit line**, matching the behavior of the normal allow path. Previously the line was omitted, leaving the audit without a terminal record for the action.
- **[I3] Audit truncation now bounds all large action fields** (e.g. `cmd`, `path`, `content`), not just `args` and `result`. Previously a 5 KB `action.cmd` produced a line exceeding the 3 500-byte POSIX `PIPE_BUF` safety margin even with `_truncated: true` set.
- **[I4] Rate-window predicates now count only `decision:"allow"` records.** Post-cap deny attempts previously accumulated in the window, making the 60-second ban longer than documented with every retry. Both `defer-rate` and `spawn-rate` affected.
- **[I5] `gate.allows()` returns `false` under halt conditions** (budget exhaustion, maxTurns, terminated). Previously returned `true` because halt outcomes are `"askHuman"`, misleading catalog pre-filter callers that had no path to recovery without an out-of-band topup.
- **[m1] Safe-default force-flag deny pattern** now catches `--force` as a standalone token in serialized action content (e.g. `git push --force origin`). The original `:force` prefix form is preserved.
- **[m2] `fs.deny` entries use path-segment boundary matching** (`p === d || p.startsWith(d + '/')`). The previous `p.includes(d)` caused false positives: `deny: ["/etc"]` denied `/home/user/etc-backup/file`.
- **[m3] Removed no-op leading `args` key** from `tools.denyArgPatterns` serialization (`JSON.stringify({ args: action.args, ...action })` → `JSON.stringify(action)`). The spread always overwrote the leading key; no behavioral change.
- **[m5] `limits.turns` is now restored from the audit log on cold start** (missing/corrupt budget file). Previously `haltContext().turns` returned 0 after a crash-restart while `spent.costUsd` was correctly rebuilt.
- **[m6] Topup loop guard changed from `> MAX_TOPUP_ITERATIONS` to `>=`** so the constant accurately reflects the maximum number of successful topups (5) rather than allowing one extra.
- **[m7] `isPrivateIp()` now detects IPv6 private ranges:** unique local `fc00::/7`, link-local `fe80::/10`, and IPv4-mapped `::ffff:<ipv4>` addresses (the last by recursing on the embedded IPv4).

### Tests

- Suite grows from 48 → 60. New tests cover every fix above.

## [0.3.0] — 2026-05-01

Adds `humanChannelTimeoutMs` — optional deadline so a hung escalation channel
can no longer pin an agent forever.

### Added

- **`humanChannelTimeoutMs` config** — optional deadline on the `humanChannel` callback. When set, bareguard races the channel against a timer; on timeout, gate.check returns `{ outcome: "deny", severity: "halt", reason: "humanChannel timeout after Xms" }` and emits a `phase:"approval"` audit line. Always denies — no allow-on-timeout default (callers wanting that behavior must implement it inside their own channel). Default: unset = wait forever (current behavior). Fixes infinite-hang when a Slack bot / TUI / web channel becomes unreachable mid-prompt. Tests: `test/halt-flow.test.js` (slow-channel-times-out, fast-channel-wins-race). Suite: 46 → 48.

### Compatibility

- Fully backwards-compatible. Configs that don't set `humanChannelTimeoutMs` keep the prior wait-forever semantics. No API breaks. PRD updated (§10.1). bareguard.context.md "Wiring with humanChannel" section updated.

## [0.2.1] — 2026-04-30

Docs-only patch.

### Changed

- **`bareguard.context.md` Recipe 9** — replaced the cross-link TODO placeholder with direct links to bareagent v0.9.0 (`bare-agent@0.9.0` on npm), `examples/wake.sh`, and `examples/orchestrator/`. No code changes.

## [0.2.0] — 2026-04-30

`defer-rate` + `spawn-rate` primitives. Per-family, audit-log-counted.
Pairs with bareagent v0.9's `defer` and `spawn` tools.

### Added

- **`defer-rate` primitive** (`src/primitives/defer-rate.js`) — caps how many `defer` actions can pass through the gate per minute. Default cap: **15/min** (revised from the v0.4 baseline of 30 — easier to relax than tighten). Triggers at step 3 of the eval order (per-action-type denies). Returns `{ outcome: "deny", severity: "action", rule: "defer.ratePerMinute" }` when exceeded.
- **`spawn-rate` primitive** (`src/primitives/spawn-rate.js`) — caps how many `spawn` actions can pass through the gate per minute. Default cap: 10/min. Same eval-order placement. Composes with `limits.maxChildren` (concurrency cap) and `limits.maxDepth` (depth cap) — this is rate, not concurrency.
- **`countAuditWindow` helper** (`src/audit-window.js`) — single source of truth for "count audit records matching predicate in trailing N ms." Used by both rate primitives and available for any future rate-shaped guard.
- **Clock injection on `Gate` and `Audit`** — `new Gate({ _clock: () => ms })` lets tests fast-forward the trailing-window clock without sleeping 60s. Default `Date.now`.
- **Tests** — `test/defer-rate.test.js`, `test/spawn-rate.test.js`, `test/integration-rate-multifamily.test.js`. Bumps the suite from 33 → 46 passing.

### Design

- **Audit log is the rate counter — no separate counter file.** The audit log already records every `phase: "gate"` line with timestamp + `run_id`; counting matching records in a trailing window is deterministic and correct across processes for free. Eliminates a second consistency surface.
- **Per-family scope via the existing per-`root_run_id` audit path.** Children inherit `BAREGUARD_AUDIT_PATH` and append to the same file as the parent, so the family's rate is the file's rate. No per-family bookkeeping; no per-process counters.
- **Two-phase defer remains two distinct `gate.check` calls.** Emit-time check sees `action.type === "defer"` (counts toward defer rate); fire-time check sees the inner action's own type (counts toward whatever rules apply to it). The audit log records both.

### No breaking changes

- v0.1.1 API unchanged. `humanChannel` contract unchanged. Audit format unchanged — the new rate-cap denies are just `phase: "gate"` records that happen to have `action.type` of `defer` or `spawn`.
- `_stepEval` is now `async` internally (it awaits the rate primitives). Public `gate.check` and `gate.allows` were already `async`; no caller-visible change.

## [0.1.1] — 2026-04-30

Patch release addressing pre-publish review feedback. No breaking
runtime changes; one breaking API removal noted below.

### Added

- **`gate.allows(string)` shorthand** — pass a tool-name string instead of constructing `{ type: name }`. Useful for catalog pre-filters where you only have the name. Object form still works (full action shape allows arg-based allows).
- **`_truncated: true` boolean at audit line root** — when an audit line exceeds the 3.5KB POSIX `O_APPEND` safety threshold and is truncated, the line root now carries an explicit `_truncated: true` boolean. Downstream consumers (replayers, log tooling) can filter without regex on string contents.
- **One-time stderr WARN when `humanChannel` is unset** — first time an ask/halt event would call into a missing channel, bareguard prints a WARN to stderr explaining the misconfiguration and pointing at the README. Behavior unchanged: still denies with `severity: "halt"` and structured reason. The warn surfaces the cause early during development without breaking the safe headless / CI default ("no human present = deny").
- **README "Common gotchas" section** — promotes 5 surprises out of the amendments doc into the front-of-house README: allowlist-doesn't-silence-asks, glob `*` over-matching `/`, humanChannel effectively required for safe defaults, soft caps, serial gate calls. These are the "didn't read the spec, hit the foot-gun" issues.

### Removed

- **`Gate.fromConfig(config)`** — was an alias for `new Gate(config)`. `new Gate(config)` is the only canonical form. Anyone who tried `fromConfig` in the ~1 hour between v0.1.0 publish and this patch can switch to the constructor; same shape.

### Docs

- `bareguard.context.md` version line bumped to v0.1.1 (was v0.1.0-pre — leftover from pre-publish state).

## [0.1.0] — 2026-04-29

First release. Action-side runtime policy library for autonomous agents — bounds what the agent does, not what it says.

### Added

- **Single `Gate` class with three call sites** — `gate.redact(action)`, `await gate.check(action)`, `await gate.record(action, result)`. One chokepoint between the agent and the world; tools never self-check. Plus `gate.run(action, executor)` for runners that want check + execute + record in one call, and `await gate.allows(action)` as a pure boolean catalog pre-filter (no audit, no budget delta).
- **Twelve primitives, ten in v0.1** — `bash`, `budget`, `fs`, `net`, `limits`, `approval`, `tools`, `secrets`, `audit`, `content`. Each ~30–180 LOC in its own file. `defer-rate` and `spawn-rate` ship in v0.2 alongside bareagent's `defer` and `spawn` tools that exercise them.
- **Severity-graded decisions** — every `gate.check` returns `{ outcome, severity, rule, reason }`. `severity: "action"` denies bubble to the LLM as structured errors; `severity: "halt"` events (budget exhaustion, maxTurns, terminate) escalate to a human and never bubble. Run-level safety baked in.
- **`humanChannel` callback** — one runner-supplied function consolidates ALL human escalations (ask + halt + topup + terminate). bareguard calls it; applies the human's decision atomically (audit line, optional cap raise, optional terminate); returns terminal allow/deny to the runner. The runner branches on two outcomes only — never sees `askHuman`.
- **Single audit file across the agent family** — POSIX `O_APPEND` atomicity (< PIPE_BUF / 4KB) means parent + children + grandchildren all `appendFile` the same `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl` without locks. Family tree reconstructable from one file with grep on `parent_run_id`. Phases: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`. Windows uses a lock fallback automatically.
- **Shared budget across processes** — `budget.sharedFile` + `proper-lockfile` (the one allowed production dep). Versioned format (`version: 1`). Parent + children draw from one cap. On a missing/corrupt budget file, bareguard rebuilds spent + cap from the audit log on startup.
- **Safe defaults shipped** — `content.denyPatterns` blocks `DROP TABLE`, `rm -rf /`, `TRUNCATE TABLE`, force flags. `content.askPatterns` escalates `delete`, `revoke`, `truncate`, `force-push`, destructive HTTP methods. ~10 lines of regex covering ~90% of dangerous things agents do. Override with empty arrays for pure-allow.
- **Six-step eval order, fully pinned** — pre-eval halt checks (`budget`, `maxTurns`, terminated), then `tools.denylist → content.denyPatterns → per-action-type rules → content.askPatterns → tools.allowlist scope → default allow`. First match wins. Allowlist is **scope-only** — does NOT silence asks (a v0.5 reversal of the v0.4 short-circuit which proved a foot-gun in practice).
- **Secrets redaction with name tagging** — `[REDACTED:ANTHROPIC_API_KEY]` for env-var matches, `[REDACTED:pattern=sk-...]` for unknown-source pattern matches. Never shows full secrets, never shows the suffix. Caller is responsible for redacting tool results before `gate.record`.
- **Multi-agent stitching** — `parent_run_id` and `spawn_depth` threaded via env vars (`BAREGUARD_PARENT_RUN_ID`, `BAREGUARD_SPAWN_DEPTH`, `BAREGUARD_AUDIT_PATH`, `BAREGUARD_BUDGET_FILE`). Children inherit automatically.
- **`gate.haltContext()`** — deterministic stats over the audit log (spend, turns, last-5 spend rate, time elapsed). Exposed for `humanChannel` to render to operators. No LLM speculation on remaining work.
- **Glob `*` only** — minimal wildcard for tool name matching. No `?`, `[abc]`, or escapes in v0.1. v0.2 may add `**` if real use exposes pain.

### Tests

- 30/30 tests passing on Linux. ~700 LOC of tests covering eval order, safe defaults, secrets redaction, halt flow (humanChannel + topup + terminate + audit dedicated halt line + budget reconstruction from audit), shared-budget under real-subprocess contention, single-audit-file atomicity across 3 concurrent processes, and a full agent-loop integration.
- **GitHub Actions matrix CI** — `ubuntu-latest`, `macos-latest`, `windows-latest` × Node 20 / Node 22. Six combinations on every push and PR.

### Constraints

- **One production dep:** `proper-lockfile` (for the shared budget file). Hard target per PRD §18.
- **Source ≤ 1000 LOC:** 931 LOC in `src/`. Per PRD §21 success criterion.
- **Complete mediation:** every action goes through one `gate.check`. No bypass paths. No tool self-checks.

### Philosophy (carried from PRD §17)

bareguard is **action-side** — bounds what the agent does. Not content (use `guardrails-ai`). Not sandboxing (use Docker/gVisor). Not authn (caller's concern). Not a scheduler. Not a daemon. No telemetry, no SaaS. The goal is to be small enough to read in an afternoon and understand exactly what your agent is allowed to do.

### Known limitations

- **Soft cap.** Cross-process budget can be exceeded by one action's spend before next refresh. Halt fires reliably on the next check after a record.
- **Safe-default `askPatterns` over-match.** `/\b(delete|drop|...)/i` fires on innocent strings. Right v1 trade — over-asking is recoverable; under-asking is incidents. Narrow patterns if noisy.
- **Linux/macOS primary.** Windows works via lock fallback but isn't CI-verified yet.
- **No rate limits in v0.1.** `defer-rate` / `spawn-rate` ship in v0.2 with bareagent's `defer` / `spawn` tools.

### bareagent migration note

bareagent v(next) will remove its built-in `bash` allowlist, token/cost budget, per-tool gov layer, max-turns counter, and ad-hoc tool-call logging — all replaced by `import { Gate } from "bareguard"` and one policy adapter on `Loop({ policy })`. See `bareguard.context.md` Recipe 8 (or the bareagent-side recipe in its own context doc when published).
