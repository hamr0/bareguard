---
type: reference
title: Releases & roadmap
status: stable
sources: [docs/archive/bareguard-prd.md]
---

# Releases & roadmap

Covers the migration plan (release history + the 1.0 HOLD and SemVer surface), the POC
retrospective, and the v1.0.0 success-criteria checklist (bareguard-prd.md:964-1421) (bareguard-prd.md:1422-1436) (bareguard-prd.md:1437-1458).

## §19 Migration plan (post-v0.1.1)

Three releases (bareguard-prd.md:966).

### bareguard 0.1 — extraction baseline (SHIPPED 2026-04-30)

Released on npm as `bareguard@0.1.0`, patched to `0.1.1` same day with pre-publish review
fixes (bareguard-prd.md:968-971). Includes (bareguard-prd.md:973-982):

- All primitives 1–9 + 12 (every primitive except `defer-rate` and `spawn-rate`).
- Shared budget file with `proper-lockfile` (originally scheduled for 0.2; brought forward).
- Halt-vs-action severity classification.
- `humanChannel` callback consolidating all human escalations.
- Single-file audit via POSIX `O_APPEND` (Windows lock fallback).
- Multi-agent stitching via env vars (`parent_run_id`, `spawn_depth`).
- `gate.allows(action | string)` catalog pre-filter.
- `gate.haltContext()`, `gate.terminate()`, `gate.raiseCap()`.
- Safe defaults shipped per §11.

bareagent v(next) imports `bareguard ^0.1` and removes its built-in policy code (see bareagent
PRD §9.1 for the concrete removal list) (bareguard-prd.md:984-985).

### bareguard 0.2 — rate limits + bareagent-driven additions

- `defer-rate` (#10) and `spawn-rate` (#11) primitives, landing alongside bareagent
  v(next+1)'s `defer` and `spawn` tools that exercise them.
- `**` glob support if bareagent integration surfaces real allowlist over-grant pain
  (deferred per §16.4 / v0.6 §9).
- Sliding-window rate (if fixed-window proves insufficient).

(bareguard-prd.md:987-993)

### bareguard 0.4 — multis-driven adoption tweaks (SHIPPED)

Halt-event action contract, fileless audit (test-only), strict budget mode, flat/nested
action-shape acceptance, secrets auto-redaction at the audit boundary, and shared-budget lock
hardening (fail-loud on corrupt read) (bareguard-prd.md:995-999).

### bareguard 0.5 — TypeScript types + policy-bypass hardening (SHIPPED 2026-05-29)

- **Ships `.d.ts` generated from JSDoc** (`0.5.0`) — typed consumption with no `@types`
  package; `typescript` is a dev dep only (prod-dep target stays 1).
- **Type-confusion fail-open closed** (`0.5.0`): a present-but-non-string `cmd`/`path`/`url`
  is denied (`bash.invalidCmd` / `fs.invalidPath` / `net.invalidUrl`) instead of waved through
  to the allowlist.
- **Windows scope escape closed** (`0.5.0`): `fs` folds `\` → `/` before lexical normalization.
- **Glob `*` matches line terminators** (`0.5.0`, dotAll) — closes a `tools.denylist` bypass.
- **Atomic shared-budget write** (`0.5.1`, temp file + `rename`) — removes the torn/empty-read
  window that intermittently misfired the corruption path.
- Documented (not changed): `denyPrivateIps` is literal-host/pre-DNS; `secrets.envVars` skips
  values < 8 chars.

(bareguard-prd.md:1001-1015)

### bareguard 0.6 — `flags` primitive + litectx write-gate seam (SHIPPED 2026-06-14)

- **`flags` — structured field-value gate (13th primitive)** (`0.6.0`): gates on a named
  action field's value (`provenance`, `injectionRisk`) read directly, deny/ask arms at steps
  2b/4b before the allowlist (floor supremacy). The one net-new primitive the litectx
  write-gate seam needed (§5B); generic, no `memory.*` recognition.
- **litectx write-gate seam CLOSED** (`0.6.0`): `seam-contract.test.js` runs against litectx's
  published `toWriteAction` (`litectx@^0.13.0`, devDependency only — not shipped).
- **Prototype-pollution hardening at the gate** (`0.6.0`, Security): every action is
  normalized to own-properties-only (`safeAction`, null-proto + null-proto `args`) at
  `check`/`allows`/`record`/`run` entry, closing a gate-wide vector where a polluted
  `Object.prototype` could inject a field and flip a decision (incl. deny→allow). `run()`
  executes the normalized action (no TOCTOU). Behavior note: `run()`'s executor + the
  `humanChannel` event receive a null-proto shallow copy (own props incl. `_ctx` preserved).
- **Still pre-1.0 — the §19 HOLD stands** (1.0 is gated on the integration bench + last-call
  review; the write-gate seam half is now done).

(bareguard-prd.md:1017-1032)

### bareguard 0.8 — command severity classification (`bash.classify`) (SHIPPED 2026-06-17)

- **`bash.classify` — cross-platform command severity tiering** (Part 2 §7.1, multis-driven):
  bareguard owns the **mechanism + a full cross-platform tiered pattern list**
  (Linux/macOS/Windows), shipped **in-lib**, framed **best-effort** (not "authoritative"); the
  consumer owns the ceremony. Classifies each `bash` command `safe`/`destructive`/
  `super_destructive` at the ask step (step 4, before `content.askPatterns`); tiers 2–3 raise
  the **existing** ask with `event.classification` + `event.tier`, so the `humanChannel` maps
  severity → ceremony. Zero auth logic in the lib; never hard-denies 2–3. Exports
  `classifyCommand` (pure) + `DESTRUCTIVE_PATTERNS`/`SUPER_DESTRUCTIVE_PATTERNS`; adds
  `classify`/`platform`/`extra*`/`reclassify` to `BashConfig` and `classification`/`tier` to
  `HumanEvent`. **Additive — `classify` off ⇒ decision path + every audit/event line
  byte-identical.**
- **Honest scope / boundary:** best-effort, **defeatable by obfuscation, NOT a sandbox** — UX
  tiering, not enforcement; the fs/exec scope stays the hard boundary. The deny floor still
  wins (`rm -rf /` → `content.denyPatterns` deny at step 2, before classify). *Disagreement of
  record:* the build recommendation was "best-effort" framing over "authoritative", and the
  adopter agreed (coverage = full, framing = best-effort) — the word "authoritative" was
  declined because it suppresses the consumer's review reflex on a defeatable mechanism and
  implies an SLA the lib can't staff.
- **ReDoS hardening (Security, fixed in the same change — `/security` pass).** The two
  `rm`-root super-destructive patterns used three consecutive unbounded quantifiers
  (`[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*`); a flagless run (`rm -rfrfrf…`) with a failing `\s+` tail
  backtracked catastrophically (n=2000 → 21 s) — a single agent-emitted string could hang the
  gate (runtime-wide DoS, since every action passes through `check()`). Rewritten with
  **non-consuming lookaheads** (`-(?=[a-z]*r)(?=[a-z]*f)[a-z]+`) → linear (21 s → ~1 ms; 1 MB →
  ~16 ms), outcomes preserved, regression-guarded. Defense-in-depth shape: classify runs at the
  ask step (4) **after** the deny floor (1–3), so it can only escalate to an ask, never
  downgrade a deny.
- **Still pre-1.0 — the §19 HOLD stands.** Additive; lands clean on the SemVer surface (new
  exports + `bash.*` keys + event fields below), no API regret.
- **Coverage widening (BG-1/BG-2/BG-3, 0.12, multis ask 2026-07-07):** additive to the same
  mechanism, no design change. **BG-1** — `rm -rf` of a whole system root (`/etc`…`/root` + any
  descendant) or home/mount account (`/home/<user>`, `/var`, `/Users/<user>`, quoted/braced
  `$HOME`) now tiers `super_destructive`; a path one level deeper stays `destructive`
  (build-clean stays runnable). **BG-2** — `find … -delete`/`-exec`/`-execdir` now tier
  `destructive`. **BG-3** — new frozen `INTERPRETER_PATTERNS` export: OPT-IN tier-2 escalation
  for inline interpreter code (`python -c`/`node -e`/…), *never* a default (inline code is
  unreadable by regex and equally reachable via `script.py`/heredoc/`base64|sh`, so a default
  escalation is a false-positive flip that buys ~no safety) — the honest-scope boundary made
  explicit at the call site. The new super patterns compose onto the **same
  non-consuming-lookahead** `rm` anchors, so the ReDoS-safe shape is preserved (re-timed
  linear, worst ~2 ms at 50 KB).

(bareguard-prd.md:1034-1076)

### bareguard 1.0 — stabilize

- Lock the API. SemVer commitments.
- Walk-away: maintenance only after this point.

(bareguard-prd.md:1078-1081)

### The 1.0 HOLD

**DECISION (2026-06-09): HOLD at 0.5.x.** Version numbers are decisions, not counters — 1.0
can cut from 0.5.x any day; the question is only readiness to make the promise.
**Update 2026-06-14:** the first real consumer (litectx) has now exercised the
**write-gate seam** — the `flags` field-gate is live and the swap-point test is repinned to
litectx's published emitter (`litectx@^0.13.0`), gate item 1's first half met with **no API
regret** (flags landed additive; the `flags.<field>` rule strings held). Still holding because
the **integration bench** (gate item 1's second half) and the last-call review are not yet
done — locking before the bench run is the one scenario that risks an early 2.0.
(bareguard-prd.md:1083-1090)

**Gate to cut 1.0 (all three)** (bareguard-prd.md:1092-1101):

1. The seam exercised by a real consumer — **(a) swap-point confirmation ✅ DONE 2026-06-14**
   (write-gate seam closed vs `litectx@^0.13.0`, `seam-contract.test.js`, no API regret);
   **(b) integration bench ⏳ still pending** (Part 2 §9.3.4 item 2 — needs litectx's
   `assemble()`/`recordUseful()`). Both halves green with no API regret before this gate
   clears.
2. The **last-call breaking-change review** below resolved (each item changed or explicitly
   kept — breaking changes are cheap at 0.x, expensive forever after).
3. The §21 unchecked box decided: do the bareagent deprecation re-exports first, or amend the
   criterion and ship without (defensible — it gates bareagent's cleanliness, not this API).

**Last-call breaking-change review (open items, decide before lock)** (bareguard-prd.md:1103-1120):

- ~~**Empty `tools.allowlist` fails OPEN**~~ — **DECIDED: flip to fail-closed (breaking; built
  on `fix/empty-allowlist-fails-closed`, v0.14).** `[]` is now a configured scope of nothing →
  step 5 runs → `tools.allowlist.exclusive` deny. Only `undefined`/`null` means not-configured;
  any other non-array value denies via `tools.allowlist.invalid` (a follow-up on
  `fix/audit-reason-rebound`, also v0.14 — the original `!cfg.allowlist` guard still let
  `""`/`0`/`false`/`NaN` read as absent and fail OPEN, and let a truthy non-array throw).
  Rationale: the tightest expressible scope produced the loosest outcome, silently, and every
  sibling scope primitive (`net.allowDomains`, `fs.readScope`/`writeScope`, `bash.allow`)
  already denied on `[]` — `tools` was the sole outlier (measured). Throw-on-construct was
  rejected: a deny is in-band agent feedback, a throw is not. 3 regression tests, both
  mutations verified.
- **`budget.strict` default for money caps** — `check()` halts post-fact (`spent ≥ cap` = cap +
  one action overshoot); decide if `strict` projection becomes the default for `maxCostUsd`
  (the §19 Budget candidate's semantics flag).
- **Confirm-and-lock** (intentional, just ratify): `allows()` returns true for ask-gated tools;
  no-`humanChannel` ask/halt → deny with severity halt; topup-on-ask treated as allow.

### The 1.0 SemVer surface

**What the 1.0 promise covers when cut** (bareguard-prd.md:1122-1157): exports (`Gate`,
`redact`, `Budget` errors, `defaultAuditPath`, `globToRegex`/`matchAny`, `classifyCommand`,
`DESTRUCTIVE_PATTERNS`/`SUPER_DESTRUCTIVE_PATTERNS`) and the `"./primitives.json"` exports
subpath (v0.16 — the PATH is promised, not the shape of each manifest entry; §10.3), config
keys (incl. `flags`, `bash.classify`/`bash.extraDestructive`/`bash.extraSuperDestructive`/
`bash.reclassify`/`bash.platform`, and `budget.failClosedOnUnpriced` (v0.9)), the
`Result.pricing` field (v0.9), **rule strings** (adopters and the seam contract test match on
them — incl. `flags.<field>`, now live in litectx's write-gate seam, `bash.classify`,
`budget.unpriced` (v0.9), `tools.allowlist.invalid`/`tools.denyArgPatterns.invalid` (built
v0.14, reached npm in v0.15 — 0.14.0 was never published), and the ten runtime `<key>.invalid`
deny rules extending the same fail-closed-on-mutation pattern to the rest of the array/map-shaped
config surface — `tools.denylist.invalid`, `content.denyPatterns.invalid`/`askPatterns.invalid`,
`fs.deny.invalid`/`readScope.invalid`/`writeScope.invalid`, `net.allowDomains.invalid`,
`bash.allow.invalid`/`denyPatterns.invalid`, `flags.invalid` (v0.15), and
`content.unserializable` — an action that cannot be serialized for content matching now fails
closed here instead of throwing out of the gate (v0.16)), the audit JSONL line format (incl. the
`unpriced` phase, v0.9, the `annotate_malformed` phase, v0.13, `aid` now redacted/byte-bounded
like `reason`/`where`/`verdict` — v0.15, and the `_dropped: "payload not serializable"`/
`_dropped_carriers` markers on a line whose payload could not be serialized at all — v0.16), the
`_dropped_keys`/`_dropped_bytes` markers and the genuinely-final guard's `_dropped_core` marker
plus its reduced `{ts, seq, run_id, _dropped_keys, _dropped_bytes, _dropped_core}` line shape
(with a bare `{_dropped_core: true}` as its own last-resort fallback on the scalars-only
backstop's own key-count bound — v0.16), the redacted-copy markers `[UNREADABLE]` (an own-props
copy that could not read one of the action's fields), `[REDACTED:circular]`, and
`[REDACTED:depth]` (v0.16), the `gate.annotate` fact contract (`surface` must be an explicit
boolean — v0.13), the budget file format, and the `humanChannel` event/decision contract (incl.
the `event.classification`/`event.tier` fields the classifier attaches).

**Pending/future work index while holding** (so nothing lives only in chat): this section (1.0
gate) · §19 future candidates above (Budget, Audit, tamper-evident — all demand-gated) ·
Part 2 §0.1.1 (pre-litectx backlog: EMPTY except the optional Axis-B detect-and-feed-A recipe) ·
Part 2 §9.3.4 (waits-on-litectx) · Part 2 §10 OQ1 (declaration format only; skeleton settled
per §6.5) / OQ2 (likely never). (bareguard-prd.md:1159-1163)

### Future features (candidates — not committed)

Ideas that cleared "interesting" but not the §17/Appendix C bar yet, parked here so they're not
re-litigated from scratch (bareguard-prd.md:1165).

#### Tamper-evident audit (hash-chained / signed log)

Optionally chain each audit entry (`sha256` over the previous hash + the entry) so post-hoc
edits, deletions, or reorders become detectable — and, as a later step, sign the chain head for
non-repudiation. Currently a NO-GO *default* (§17: "opt-in flag at earliest, or sibling
library").

- *Status:* **needs more design time before it ships, even as a flag.** A throwaway POC proved
  the mechanism works in ~40 LOC with zero new deps, but surfaced the load-bearing constraint:
  bareguard's audit is **multi-writer and lock-free** (parent + children all `O_APPEND` one
  file with no coordination). A *global* chain across writers is impossible without taking a
  lock on every `emit`, which would undo the design the whole audit primitive rests on. A
  **per-`run_id`** chain is feasible (each `Audit` instance is a serial writer for its own run)
  but only detects tampering *within* a run — not global cross-run ordering, and not whole-run
  deletion. And a hash chain is **integrity, not authorship**: anyone who can rewrite the file
  can recompute a valid chain unless the head is signed.
- *Why parked:* a naive `audit.hashChain` flag oversells "tamper-proof" given the per-run
  caveat. The per-run-vs-global boundary and the signing/non-repudiation story need to be
  designed and documented *before* exposing anything, or it becomes a footgun. Likely lands as
  a clearly-scoped opt-in flag or a sibling library (`bareseal`-style), never a v1 default.
- *Origin / relation:* prompted by [bindu](https://github.com/GetBindu/bindu)'s Ed25519-signed
  A2A records, but this is integrity of bareguard's **own log**, not agent authentication —
  bareguard authorizes the action, not the actor. See
  [harness-research.md, Part III "Identity and the gate"](harness-research.md#identity-and-the-gate).

(bareguard-prd.md:1170-1194)

#### Budget: generalized cumulative dimensions + soft/hard split (IMPLEMENTED 2026-06-14; PROPOSED 2026-06-09; Part 2 OQ3)

Two additive extensions to the shipped `Budget`, *not* a rewrite: (1) generalize the cumulative
counter beyond `costUsd`/`tokens` to arbitrary countable resources (sends, rows, bytes) via a
cap-map over the same mechanism; (2) a soft-threshold `warn` decision (e.g. at 80% of cap) ahead
of the existing hard halt.

- *Status:* **IMPLEMENTED — released in 0.7.0.** `budget.resources` (cap-map, halt rule
  `budget.resource.<name>`, accrued from `result.counts`) + `budget.softRatio` (non-blocking
  `budget_warn` audit line, never routed through `check()`). File format → v2 with v1
  read-compat; counts hardened to positive-only for configured resources. The **operator** is
  the driver (cap/monitor non-money resources). The settling question below was answered as
  scoped: post-fact halt kept; `strict`-default-for-money stays a separate call. See CHANGELOG
  [0.7.0] + `budget-resources.test.js`. *Originally PROPOSED — earned by POC evidence:* The
  harness POC gate E3 (`harness-code-mode/run-e3.mjs`) proved empirically that the cumulative
  tier is the real wall (a per-action regex is decomposable: €200+€200 walked past a `>€300`
  ask; `budget.maxCostUsd: 300` halted the same split) — but E3 had to model € charges *as*
  `costUsd` because no other dimension exists. A real non-money resource (sends, rows) needs the
  generalization. E3 also surfaced a semantics question to settle at build time: `check()`
  halts POST-FACT (`spent ≥ cap` — exposure bounds to cap + one action); decide whether `strict`
  projection becomes the default for hard-money caps.
- *Why parked:* no adopter counts a non-money resource yet, and the soft/hard tier prior comes
  from a design that was never built (aurora's tiered cost model — design-only, an unvalidated
  prior). Appendix E says prefer-extend over new primitive; a separate `limits.cumulative` is
  justified only if the data model genuinely diverges. Build + integrate + validate in one
  motion when a driver appears.
- *Origin / relation:* Part 2 §10 **OQ3** (decision recorded there 2026-06-04: hard-cap-first;
  tiered is an extension). Candidate first user: a memory-engine adopter bounding `memory.write`
  counts per run (Part 2 §9.3.2 scenario 3).

(bareguard-prd.md:1196-1223)

#### Audit: request + return on one line (IMPLEMENTED 2026-06-14; PROPOSED 2026-06-09; Part 2 OQ4)

Log the gated request and its result together (or deterministically joinable) so
ask-vs-outcome reconciliation is reconstructable from the log without re-stitching JSONL
phases.

- *Status:* **IMPLEMENTED — released in 0.7.0.** A per-eval correlation id (`aid`): minted in
  `check()`, stamped on every audit line of the eval, returned on the decision, and threaded to
  the `record` line by `run()` (or by the compose seam via `decision.aid` → `record(action,
  result, { aid })`). Joins even byte-identical repeats — the ambiguous case below. See
  CHANGELOG [0.7.0] + `audit-correlation.test.js`. *Originally PROPOSED — mechanic shown:* The
  harness POC gate E2 proved the value of an independent return-side fact at the approval
  moment (detect-and-feed-A); a2a §12.2 is the evidentiary base ("log the request alongside the
  response so ask-vs-response is reconstructable"). Today `phase:"gate"` and `phase:"record"`
  lines both carry the full `action` but share **no per-action id** — joinable by content match
  or proximity, which goes **ambiguous exactly when the same action repeats** (the E3
  decomposition case: N identical `pay €200` lines).
- *Why parked:* the cheap version (echo an action id on the `record` line) is small, but the
  line-bloat and truncation interaction (`_truncated`) need a look, and no consumer reconciles
  today. If Axis-B reconciliation (Part 2 §8) ever builds, this is the audit shape it feeds —
  but it must not wait for, or assume, Axis B.
- *Origin / relation:* Part 2 §10 **OQ4**; a2a-intent-drift §12.2.

(bareguard-prd.md:1225-1245)

#### Trial-first: dry-run routing for uncertain / irreversible actions (PROPOSED 2026-07-02; not built)

A third lane beside allow/deny/ask: for an action whose type is *uncertain or unclassified*
**and** whose effect is *contained and diffable*, route it to a **try-first** pass — the
harness runs the action's dry-run form, and its result comes back as a deterministic **fact**
the gate then decides on. It is the *empirical* answer to "what happens if I do this":
**measure** the consequence instead of **predicting** it (contrast a learned world-model /
JEPA, whose output is a guess — the model-drives-a-decision case Appendix C bar 2 and §6 rule
out). bareguard **never runs the dry-run** — that would make it the executor/sandbox it
explicitly is NOT (§4); it only (a) routes the type and (b) reads the trial result back.

- *Shape (sketched, not settled):* three pieces, each in its existing home. **Which types need
  a trial** = operator config, per-type (parallel to `axisB.reversible`): `trial: {
  requireBefore: ["terraform.apply", "sql.write", "k8s.apply"] }`. **Running the dry-run** =
  the *harness/adopter* (`terraform plan`, `kubectl --dry-run=server`, `helm --dry-run`, SQL
  `BEGIN…ROLLBACK`, `git apply --check`, `rsync -n`) — bareguard owns no command strings. **The
  trial result as a fact** = reuse **Axis B** (`gate.annotate` carrying the plan-diff), so the
  operator gates deterministically on the *measured* consequence (`allow if plan destroys 0,
  else ask`) — Axis A gating on an Axis-B fact, no model. Handshake: an action of a
  `requireBefore` type arriving *without* an attached trial result fails **closed**
  (deny-to-prod + a "run the trial" signal); the harness runs it, re-submits with the result
  attached, and the gate proceeds on the now-known action.
- *Why parked:* (1) **no adopter ask** — nothing automates infra/DB through the gate yet
  (idle-by-design; Appendix E). (2) **Honest scope is narrow** — it only helps actions with a
  faithful, contained, diffable dry-run (infra `plan`, DB snapshot/rollback, code worktree,
  bulk-FS `-n`); the *external* irreversible band (send email / charge card / third-party POST)
  **cannot** be sandboxed — the trial *is* the side effect — so those stay `ask-human`. It is
  not "sandbox the unknowns," it is "dry-run the diffable slice." (3) **Mostly a recipe, not a
  primitive** — routing (`flags`/a type rule) + fail-closed (deny-to-prod) + result-as-fact
  (`annotate`, Part 2 §8) are all shipped; the only genuinely new surface is a first-class
  **`trial` decision outcome** so the harness gets a clean signal instead of overloading `ask`,
  and a new outcome is 1.0-SemVer surface (§19 bareguard 1.0) — it clears the bar only when a
  real DevOps adopter hits the recipe's clumsiness. (4) A **predefined dry-run table baked into
  the core is a NO** (bareguard claiming it knows your toolchain + owning command strings = the
  "authoritative" overreach declined for `bash.classify`, §19 0.8); a **best-effort,
  override-me reference list in the harness cookbook** is the right home.
- *Origin / relation:* this-session design arc off a JEPA ("predict the future state in latent
  space") read, reframed to **measure, don't predict** — which fits the deterministic floor
  where a learned predictor fights it (§6). Composes Axis B (Part 2 §8; facts-not-judgments +
  reversibility-by-type trust model) and the `bash.classify` best-effort framing (§19 0.8).
  First likely user: an infra/DB automation agent whose tools already ship a native dry-run, so
  "try-first" = route to the tool's own `--dry-run`, no VM. **Cookbook recipe first; `trial`
  outcome on demand.**

(bareguard-prd.md:1247-1284)

#### rwx: operator-tagged capability letters for agent fleets (APPROVED FEATURE — hamr, 2026-09-22; targets 0.17.0)

A second, **mutually exclusive** mode of control beside the closed `tools.allowlist`: the
operator tags every tool and every bash command with a read/write/execute letter, gives every
agent a three-letter ceiling, and the gate hands (and audits) an agent only what its letters
cover — the payoff is fleet-scale review (`researcher r--`, `fixer rw-`, `deployer rwx`, scan
for `x`). No longer a parked candidate with no adopter ask — hamr approved it as a feature on
2026-09-22 on the strength of the `harness-code-mode/rwx-poc.md` POC evidence.

**The PRD is the authority for this feature, not this entry.** The full spec — the letter
definitions (shared verbatim with rwxmap's D87), the `bareguard.rwx.json` file format, deny-by-
absence, enforcement, bash matching, delegation/count-cap rules, the rwxmap alignment, the six
2026-09-22 implementation decisions, the POC evidence, rejected alternatives, known limits, the
1.0-surface status, the two open questions that remain, and the marker-carrying-entries +
`rwx.askOn` extension settled with rwxmap's D103 (2026-09-24) — is Part 1 §23
(`bareguard-prd.md:981-1307`).

## §20 POC retrospective (what we built, why)

bareguard v0.1 was developed via three POC phases (per the original v0.4 §20). All three
passed; total source 931 LOC; 33 tests pass on the CI matrix (Linux/macOS/Windows × Node
20/22). The POC files were deleted before v0.1.0 publish (git history retains them)
(bareguard-prd.md:1424-1427).

- Phase 1 — single gate with bash + budget + audit, 6-step eval order: 8/8.
- Phase 2 — fs + net + secrets + content + safe defaults + JSONL audit + severity field + halt
  flow + shared budget + audit reconstruction: 13/13.
- Phase 3 — multi-process (parent + 2 children + grandchild), shared budget under real lock
  contention, halt cascade across processes, `limits.maxChildren`, `limits.maxDepth` in a
  3-deep tree, audit stitching: 12/12.

(bareguard-prd.md:1429-1435)

## §21 Success criteria for v1.0.0

- [x] Twelve primitives implemented (10 in v0.1, 2 in v0.2).
- [x] Total source ≤ 1000 LOC excluding tests and docs (931 LOC in v0.1.1).
- [x] One production dep (`proper-lockfile`); no others.
- [x] Single gate is the only decision path. No tool self-checks.
- [x] Single JSONL audit file per agent family. Budget reconstructable from log on startup.
- [x] 6-step evaluation order implemented exactly per §9.1; verified by table-driven test.
- [x] Safe defaults shipped per §11; verified by test (no user config, agent attempts `rm -rf /`
  → denied; `delete X` → asks human via humanChannel).
- [x] Shared budget across sibling processes verified by integration test (parent + 2 children
  sharing $5 cap, audit shows correct total).
- [x] `parent_run_id` and `spawn_depth` correctly threaded through 3-deep spawn tree.
- [x] Secrets redaction runs before gate sees action; verified by test.
- [x] `defer.ratePerMinute` and `spawn.ratePerMinute` actually fire (verified by test) —
  **shipped in v0.2**.
- [x] `gate.allows()` is pure-query (no audit write, no budget change); verified by test.
- [x] MCP tool names glob-matched correctly with `mcp:server/tool` convention.
- [x] README integration example works copy-pasted into a fresh repo.
- [ ] bareagent migrated; old paths re-exported with deprecation warnings — **v(next)**.
- [x] NO-GO list (§17) included verbatim.
- [x] Decisions log (§22) included verbatim.
- [x] Published to npm as `bareguard`.
- [x] Cross-linked from bareagent's README.

(bareguard-prd.md:1439-1457)
