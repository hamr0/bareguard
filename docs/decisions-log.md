# bareguard — decisions log

Resolved during design; should not be re-litigated unless explicitly asked.

## v0.4 (original PRD)

- **bareguard owns all policy.** Bash, budget, fs, net, secrets, approval,
  tools (with arg patterns), content, audit, defer-rate, spawn-rate, limits —
  all live here. bareagent has no `if allowed:` checks.
- **Single gate, complete mediation.** Every action goes through one
  `gate.check`. Tools never self-check. Two reference monitors is the bug
  shipped in `multis`; do not ship it again.
- **Audit log is the budget ledger.** Don't keep two sources of truth.
  Reconstruct budget from audit on startup. (Refined in v0.5 §5.1: audit is
  canonical history; budget file is a derived live counter.)
- **Shared budget across siblings is a file with `proper-lockfile`.**
  Single-machine only in v1. Cross-machine is a future sibling library.
- **`maxChildren` and `maxDepth` are essential, not nice-to-have.** Without
  them, one bug spawns 10K agents and burns the budget in 30 seconds.
- **Defer-rate and spawn-rate guards are essential.** Same reason — confused
  agents emit thousands of jobs without these. (Deferred to v0.2 since the
  bareagent `defer`/`spawn` tools that exercise them don't exist yet.)
- **Defer actions are validated twice:** once on emit, once on fire.
  Defense in depth.
- **No content guardrails.** Toxicity, PII, schema, persona, topic — all
  guardrails-ai's job or system-prompt's job. The action-vs-content line is
  the single most important boundary in this library.
- **`content` primitive is action-side, not content-side.** It pattern-matches
  the SERIALIZED ACTION JSON — tool name + args. That's still "what the agent
  does," just more flexibly expressed than per-tool rules.
- **MCP gov is invocation-level, not catalog-level (Path A).** bareguard
  never sees the MCP catalog. It glob-matches tool name strings on
  invocation. The catalog lives in bareagent's 30-day cache.
- **Tool name convention `mcp:server/tool`.** String convention for
  glob-matching. bareguard does no MCP-specific parsing.
- **`gate.allows()` is ergonomic, not gov.** Pre-filter only; gov happens
  at invoke time via `gate.check()`.
- **Safe defaults ship.** Default-allow + opt-in safety produces incidents.
  bareguard ships ~10 lines of regex catching the obvious dangers. Users
  override with empty arrays if they want pure-allow.
- **One allowed production dep: `proper-lockfile`.** File locking with stale
  detection is genuinely hard. Inline implementations fail on NFS, Windows,
  and crashed processes. Worth the dep. Nothing else gets a free pass.
- **No telemetry, ever.** JSONL to a file. What users do downstream is their
  problem.
- **Walk-away after v1.0.** New features = new sibling repos.
- **JavaScript is the language.** Bare suite consistency overrides
  Python-ecosystem-density.

## v0.5 amendments

- **Halt is a separate severity from deny.** Run-level limit exhaustion
  (budget, maxTurns) MUST go to a human, MUST NOT bubble to the LLM.
  Per-action denies do bubble.
- **Shared budget file is v0.1, not v0.2.** Pre-allocation alternatives are
  too rigid; the bespoke extension protocol is more complex than the dep.
- **Audit is canonical, budget file is derived.** One source of truth for
  history; one fast counter for cross-process. Reconstruct file from audit
  on startup if missing/corrupt.
- **`approval.callback` config does not exist in bareguard.** Runner owns all
  human I/O. (Superseded by v0.5.2 humanChannel — see below.)
- **Allowlist is scope-only, not a trust shortcut.** v0.4 §9.2's short-circuit
  rationale was a foot-gun in practice: allowlisting general tools silently
  disabled the safe-default ask floor. Allowlist now only enforces capability
  scope; askPatterns always fire.
- **Per-action-type primitives sit at step 3 (universal-deny phase).**
  Deny > ask > scope.
- **No LLM speculation on halt.** bareguard provides deterministic stats only.
  LLM self-estimate is a runner concern, opt-in, with caveats.
- **Glob `*` matches `/` in v0.1.** Layered defense covers over-match risk.
  v0.2 may introduce `**` if real pain emerges.
- **Result redaction is the caller's responsibility.** bareguard ships format
  helpers (`[REDACTED:ENV_VAR_NAME]`, `[REDACTED:pattern=...]`).
- **`gate.allows(action)` returns true for askHuman.** Catalog pre-filter must
  show ask-gated tools so the LLM can attempt them.

## v0.5.2 amendments (humanChannel + single audit file pivot)

- **All human escalations go through one `humanChannel` callback.** bareguard
  calls a runner-supplied function whenever ask/halt is triggered; applies the
  human's decision atomically (audit + topup + terminate). The runner branches
  on `allow`/`deny` only — askHuman is never a separate runner step.
- **Single audit file with `O_APPEND` atomicity.** No per-process files, no
  audit lock; relies on POSIX guarantees < PIPE_BUF (4KB). Family tree
  reconstructable from one file with grep. Linux/macOS primary; Windows uses
  lock fallback.
- **Budget file format is versioned.** `version: 1` at root; future-proofs
  schema growth (memory, GPU, time-elapsed).
- **Budget cross-process refresh is lazy.** Refresh post-record and on-lock,
  not per-check. Soft caps acceptable.
- **gate.check / record are serial per gate instance.** Documented contract;
  matches real agent-loop usage.
- **v0.1 scope: everything except rate limits.** POC validated more than
  original baseline; defer/spawn-rate stay v0.2 since they require bareagent's
  not-yet-existing tools.

## v0.1.1 review fixes (post-publish, same day)

- **`gate.allows(string)` shorthand.** Object form still works; string is
  for catalog pre-filters that only have the name. Auto-wraps to `{ type: name }`.
- **`_truncated: true` boolean at audit line root** when truncation happens.
  Saves downstream consumers from regex-on-string-contents.
- **One-time stderr WARN when `humanChannel` is unset** and an ask/halt event
  fires. Behavior unchanged (still denies with `severity: "halt"`); the WARN
  surfaces the misconfiguration during development. Headless / CI runs that
  intentionally have no human channel see the WARN once and continue with
  safe-default deny.
- **`Gate.fromConfig` removed.** `new Gate(config)` is the only canonical
  constructor.
- **PRD consolidation.** v0.5 amendments folded into the main `bareguard-prd.md`
  as v0.6 unified. Amendments doc deleted (git history retains it). One PRD
  going forward.
