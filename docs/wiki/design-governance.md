---
type: reference
title: Design governance
status: stable
sources: [docs/archive/bareguard-prd.md]
---

# Design governance

This page collects the PRD's scope-control machinery: what bareguard
deliberately does not do, the locked design decisions future contributors
must not re-litigate, and the gates any new primitive or inbound adopter
feature request has to clear before it ships.

## §17 NO-GO list

Recorded explicitly so future contributors and future-you don't re-litigate.
Each entry was discussed during design and consciously excluded
(bareguard-prd.md:889-892).

| Out                                                  | Why                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
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

This full table is copied verbatim (bareguard-prd.md:894-929). **Adding any
of these dilutes the one thing this library does.** Point users at this list
when they ask (bareguard-prd.md:931-932).

## §22 Decisions log (for future Claude)

These were resolved across the design conversations and should not be
re-litigated unless the user explicitly asks (bareguard-prd.md:1461-1462).

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

(bareguard-prd.md:1464-1488)

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

(bareguard-prd.md:1490-1517)

### v0.1.1 review fixes

- **`gate.allows(string)` shorthand.** Object form still works; string is
  for catalog pre-filters that only have the name.
- **`_truncated: true` boolean at audit line root** when truncation happens.
- **One-time stderr WARN when `humanChannel` is unset** and an ask/halt
  fires. Behavior unchanged (still denies with severity:halt).
- **`Gate.fromConfig` removed.** `new Gate(config)` is the only canonical
  constructor.

(bareguard-prd.md:1519-1527)

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

(bareguard-prd.md:1529-1549)

### v0.4.x patch retro (2026-05-12)

Three patches followed v0.4.0 driven by multis' adoption via bareagent.
Honest calibration of which landed at the right bar (so future
contributors don't drift the same way; see Appendix E) (bareguard-prd.md:1551-1555):

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

(bareguard-prd.md:1557-1569)

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

(bareguard-prd.md:1571-1583)

## Appendix C: the test for any new primitive

Before adding anything to bareguard (bareguard-prd.md:1616-1618):

1. Does it constrain an **action against the world** (or against a sibling
   process), not words the model produces?
2. Can it be expressed as a **rule over action shape**, not over action
   *content semantics*?
3. Does it work **without network, without infrastructure, without a server**?
4. Can it be implemented in **≤ 150 LOC** with at most the one allowed dep?
5. Is it **opt-in via config** with a sensible safe default?

Five yeses or it doesn't ship. **All five are necessary; none are
sufficient on their own.** See Appendix E for the additional gate
introduced in v0.4.x (bareguard-prd.md:1628-1630).

## Appendix E: evaluating inbound adopter feedback (added v0.4.x)

Appendix C is necessary but not sufficient. The 0.4.x adoption arc with
multis (via bareagent) showed that first-adopter feedback always pulls
toward accommodation: every request can be made to pass the five yeses,
because the requestor genuinely needs it solved. The drift risk is
real, and the calibration anchor in §22 ("v0.4.x patch retro") shows
where one landing (0.4.2 `limits.maxToolRounds`) crossed the line —
the docs already addressed the harm; the primitive only absorbed one
line of caller-side arithmetic into the library surface
(bareguard-prd.md:1678-1685).

The bar going forward for any inbound feedback that touches the API
(bareguard-prd.md:1687):

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

(bareguard-prd.md:1689-1706)

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

(bareguard-prd.md:1708-1718)

**The point of this gate:** bareguard's value is that it's *small enough
to read in an afternoon* (§2). Every accommodation that doesn't clear
this bar erodes that property by one config key, one rule string, one
audit branch, and a handful of tests. The first round of adoption
biases toward yes; subsequent rounds need to bias toward no, or the
library drifts to "framework with twelve primitives" — which is what
§4 and §17 exist to prevent (bareguard-prd.md:1720-1726).
