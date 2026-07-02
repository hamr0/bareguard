# Changelog

All notable changes to bareguard are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Docs
- **PRD §19 — new future-feature candidate: "Trial-first" (dry-run routing for uncertain / irreversible actions).** Captured, not built. A third lane beside allow/deny/ask: an action whose type is uncertain *and* whose effect is contained/diffable routes to a try-first pass — the harness runs the action's dry-run form (`terraform plan`, `kubectl --dry-run`, SQL `BEGIN…ROLLBACK`, `git apply --check`, `rsync -n`), and the result rides Axis B as a deterministic fact the gate decides on (measure the consequence, don't predict it). bareguard **routes and reads back, never runs the dry-run** (preserves the §4 "not a sandbox" non-goal). Parked: no adopter ask; scope is narrow (external side-effects still `ask-human`); mostly a cookbook recipe over `flags` + `annotate`, with a first-class `trial` outcome demand-gated (1.0-SemVer surface) and a predefined dry-run table kept out of core (best-effort reference list in the cookbook instead — the `bash.classify` framing lesson).
- **README — corrected stale line-count claims.** The library is ~2,900 lines (was stated as "~1,000 lines"); the per-file "~30–180 lines" claim (`budget.js` is 501) is now "most under ~200 lines." Copy-only, no code change.

## [0.10.1] — 2026-06-29

### Docs
- **Trimmed the README to value-over-internals.** Removed the `## Docs` table and the inline links to repo-internal planning docs (PRD, NO-GO list, decisions log, harness research, harness cookbook) from the public README — these leaked internal process docs onto the npm package page. Kept the value content (what it is / what it isn't, install, quick start, the trio-in-one-loop, the primitives overview, Axis B) and the bare-ecosystem skeleton; the user-facing Usage Guide / Integration Guide pointers remain. No code, config, type, or API change — published package contents are byte-identical apart from `README.md`.

## [0.10.0] — 2026-06-29

### Added
- **BG-1 — key-aware secret redaction in the audit, DEFAULT-ON (F16; relayfact upstream ask; pairs with bareagent BA-1).** The `secrets` redactor previously matched only **values** (`envVars` from `process.env`, `patterns` RegExp) and ran **only when `secrets` was configured** — so an adopter who never set `secrets` and threaded a live provider into `_ctx` wrote `action._ctx.provider.apiKey` (the full `sk-ant-…`) verbatim to the audit JSONL (relayfact F16, probe-03). BG-1 adds a complementary **key-aware object walk** that blanks a field by *name* regardless of value → `[REDACTED:key=<name>]`, and makes redaction **default-on**: it now runs even with no `secrets` config, because a backstop that requires opt-in only protects adopters who already know they have a secret in ctx — not the unknowing adopter the backstop exists for. The default set is deliberately **narrow** to avoid corrupting the audit / breaking policy-reproduction: case-insensitive keys `apiKey` / `api_key` / `authorization`, plus default **value**-patterns `Bearer …` and `sk-…` (the literal F16 leak shapes). It **excludes** `*_token` / `*_secret` globs from the default — those false-positive on `page_token` / `csrf_token`. **Caller-configurable:** `secrets.keys: string[]` extends the default key set (case-insensitive; a `*suffix` spec like `*_token` matches any key ending in `suffix`), and `secrets.redactKeys: false` (default `true`) disables the entire default-on backstop while still honoring explicitly-configured `envVars` / `patterns` / `keys`. Redaction stays **audit-only and non-mutating** — eval/execute see the real action, so policy matching is never weakened and the caller's object is untouched. Safe for policy-reproduction because true secrets are never policy-load-bearing. **1.0-surface additions** (logged, not yet released): `SecretsConfig.keys`, `SecretsConfig.redactKeys`, the default-on audit behavior (a change to the audit-line content surface — the SemVer-cheap pre-1.0 moment to make it), and the `[REDACTED:key=<name>]` tag.

### Security
- **Greedy default `Bearer` pattern would leak the secret it was meant to redact — caught and fixed by the BG-1 test before any release.** The first-cut default value-pattern `Bearer\s+\S+` is greedy over the **serialized JSON** the redactor operates on: `\S+` swallows the closing `"` and `}`, corrupting the line so `JSON.parse` fails and `redact()` **bails to the un-redacted original** — the raw key lands on disk. Same class as the 0.8.0 `bash.classify` ReDoS (a default pattern that's unsafe against the data shape it runs on). Fixed to a charset-bounded `Bearer\s+[A-Za-z0-9._\-+/=]+` that stops at the JSON string terminator. Verified: the redactor is ReDoS-linear (50k-char / 2000×-repeat adversarial inputs ≤ 1 ms), builds redacted nodes with `Object.create(null)` so an own `__proto__` input key can't pollute `Object.prototype`, is non-mutating (eval sees the real action), and the default-on expansion is re-bounded by the existing unconditional `MAX_LINE_BYTES` truncation net (a file-backed near-boundary line stays ≤ 3500 B, valid JSON, `_truncated:true`) — so PIPE_BUF audit-line atomicity holds.

### Tests
- **+9 (suite 215 → 224; typecheck clean):** `test/secrets-redaction.test.js` — default-on `apiKey` blanked at zero config; nested `_ctx.provider.apiKey` (the F16 leak shape); case-insensitive `Authorization` / `api_key`; default-on `Bearer …` and bare `sk-…` value patterns; the narrow default **excludes** `*_token` / `*_secret` (no `page_token` FP, same-ref); caller extends with `keys: ["*_token"]`; `redactKeys: false` opt-out (same-ref) still honoring explicit `keys`. Each new behavior verified red-without-fix. End-to-end proof through `gate.record()` with no `secrets` config (raw key absent, `apiKey → [REDACTED:key=apiKey]`, caller object untouched) and the file-backed atomicity-under-expansion path were exercised out-of-band.

## [0.9.0] — 2026-06-24

### Added
- **Cost contract — `pricing` signal: an unpriced round must never masquerade as free (bareagent eval-assist PRD §3.7/§3.8; the gate half of the meter↔gate split).** `Result` gains an optional **`pricing: "priced" | "unpriced"`** field. The meter (bareagent) sets `"unpriced"` when a round's cost could not be computed (no model / no rate-table entry — the #3 silent-zero class). On bareguard's side: an unpriced round **accrues NO cost** (unknown ≠ 0 — `costUsd ?? 0` would silently treat it as free, the exact footgun) but **still accrues `tokens`/`counts`** (provider-exact even when cost can't be priced — the token wall is unaffected), and emits a loud **`unpriced`** audit phase. New opt-in **`budget.failClosedOnUnpriced`** (default off): with a *finite* `maxCostUsd` cap, an unpriced round makes `gate.check()` return a **halt** (`rule: "budget.unpriced"`) instead of silently passing — fail-closed because the cost axis is unenforceable. The flag is **per-round** (tracks the latest round's pricing; a subsequent priced round clears it — a transient unpriced round never wedges the run into per-action HITL) and **per-instance/sticky in memory** — it never touches the shared budget-file format (v2 unchanged). **Fully additive & back-compat:** `pricing` absent ⇒ priced, so the existing accrual path and every audit line are byte-identical without the new signal. **1.0-surface additions** (logged, not yet released): `Result.pricing` field, `budget.failClosedOnUnpriced` config key, `budget.unpriced` rule string, `unpriced` audit phase. Items 1 (emitted cost is authoritative) and 4 (no counting engine in the gate) of PRD §3.8 were already satisfied; item 3 is intentionally scoped to the `pricing` field (Q3 = "pricing contract only") — the triggers it names (HITL at N turns, halt at budget, per-tool) are already expressible via `limits`/`budget`/`action.type`, while the `durationMs`/`usage` data fields are deliberately not consumed. **Pairs with the bareagent adapter change** (the meter emits `costUsd: null`, `pricing: "unpriced"` instead of coercing to 0; `estimateCost` returns `null` for any non-finite result) — shipped as a coordinated pair. The cross-repo meter→gate round-trip test follows this release + a devDep bump.

### Fixed
- **Cumulative-cap input hardening — three `record()` bypass classes closed (the floor must not trust the meter's numbers).** Surfaced while security-reviewing the pricing contract. (1) **Silent-zero via null cost without the flag:** a `costUsd: null` lacking `pricing: "unpriced"` previously did `?? 0` and accrued a silent 0 — the residual #3-shape. The gate now **derives `unpriced` from the value** (`costUsd` present but not a finite number → couldn't-price), not just the flag, so a dropped/typo'd flag still fails safe. (2) **Cap-poison via non-finite cost:** a `NaN`/`±Infinity` `costUsd` set `spentUsd` to `NaN`, and `NaN >= cap` is `false` — which doesn't under-count, it **disables the cap entirely**; now treated as unpriced (accrues 0, never poisons). (3) **Refund evasion via negatives:** negative `costUsd`/`tokens` deltas *lowered* cumulative spend (spend `$0.80`, "refund" `-$0.50`, spend more under a `$0.80` cap) — the `counts` axis already rejected negatives (`budget.js` "monotonic … refund evasion"); cost and tokens now get the same clamp. Absent `costUsd` (a non-cost action) is unchanged — *not* flagged unpriced. **(4) Cold-start rebuild divergence:** `_rebuildBudgetFromAudit` summed audit-line costs raw, so after a budget-file loss it re-applied negatives the live path clamps (cap **under-counted** — a post-restart bypass) and ignored the pricing flag (over-counted). Root cause was two copies of the accrual logic; both now call one shared **`sanitizeSpend`** (the single source of truth for what the cap counts), so live and rebuild cannot diverge. Pairs with bareagent's source fix (`estimateCost` returns `null` for any non-finite result) — defense-in-depth on both sides of the contract. Guarded by `test/budget-input-hardening.test.js` (all four bypasses + the non-cost-action regression + live/rebuild parity, each red-without-fix). *(The rebuild divergence was caught by an actual `/security` pass on this branch — not by the initial review.)*
- **Float-drift cap bypass in budget accrual (surfaced by the pricing-contract POC).** Raw IEEE-754 addition grows a ~1e-16 tail — `0.7 + 0.1 = 0.7999999999999999` — so accrued spend could land *just under* a cap, making `spent >= cap` false and silently skipping the halt. Demonstrated: a `$0.80` cap with spends of `$0.70 + $0.10` did **not** halt. This is the cap-bypass-via-numeric-error class that got the 0.5.0 rate-window optimization reverted ("faster under-counted under reordered timestamps"). Fixed by quantizing the running USD total to **nanodollar (1e-9) precision** (`roundUsd`, `Number(x.toFixed(9))` — magnitude-safe, far below any real per-round cost so no genuine spend is lost) at **both** accrual choke points: live `record()` and the cold-start `rebuildFromAudit` reconstruction. Token/resource counts are integers and unaffected; `haltContext()`'s displayed total is observability (not the hard cap) and deliberately left as-is. Guarded by `test/budget-float-accrual.test.js` (the `0.7+0.1` bypass, small-cost preservation, boundary exactness, and the cold-start path — each verified red-without-fix).

### Tests
- **+18 (suite 197 → 215; typecheck clean):** `test/budget-pricing-contract.test.js` (+7) — unpriced accrues no cost but still accrues tokens; priced/absent rounds accrue normally (back-compat); default-off emits the loud `unpriced` phase and never halts; `failClosedOnUnpriced` + finite cap halts at `check()` with `rule: "budget.unpriced"`; no-cost-cap makes it a pure audit signal (no halt); per-round clearing (a later priced round lifts the halt); the token cap still enforces across all-unpriced rounds. `test/budget-float-accrual.test.js` (+4) — the float-drift cap-bypass guards. `test/budget-input-hardening.test.js` (+7) — null-without-flag, NaN/±Inf cap-poison, negative cost/token refund evasion, the non-cost-action regression, and live/rebuild parity (negative clamp + pricing flag).

### Documentation
- **PRD consolidation — `harness-prd.md` folded into `bareguard-prd.md` as Part 2; `litectx`/`barecontext` PRDs removed (docs-only, no library change).** `docs/01-product/` was four PRDs; it is now one authority, `bareguard-prd.md`, organized as **two parts** (mirroring litectx's same-day merge): **Part 1 — Core bareguard** (the thirteen primitives, complete-mediation architecture, the 6-step eval order, audit/budget specs, release history + 1.0 HOLD + future-feature candidates) and **Part 2 — The harness** (the floor+harness / Axis-A-B design, POC gates E1–E6, the seam contract test, the litectx integration bench — the former `harness-prd.md`, verbatim). Each part keeps its own section numbering; a bare `§N` is that part's section, cross-part refs are written `Part 1 §N` / `Part 2 §N`. The overlapping top-level framing was de-duplicated, but every decision, POC finding, and validation from both docs is preserved. `litectx-prd.md` (canonical now in the litectx repo) and `barecontext-prd.md` (archived in the litectx repo; its load-bearing boundary↔economy sorting rule survives in Part 2 §10.1) were deleted. All cross-references repointed across the doc set (`README.md`, `docs/README.md`, `harness-research.md`, `harness-cookbook.md`, `decisions-log.md`, `seam-contract.test.js` comment); the never-shipped `harness-code-mode/*.mjs` POC comments and the CHANGELOG/`.claude/` history keep their original `harness-prd` references as the record.

## [0.8.0] — 2026-06-17

### Added
- **`bash.classify` — cross-platform command severity classification (harness-prd §7.1, multis-driven).** bareguard owns the **mechanism + a full cross-platform tiered pattern list**, shipped **in-lib**, framed **best-effort** (not "authoritative"); the consumer owns the ceremony. With `bash: { classify: true }`, each `bash` action is classified at the **ask step** (step 4, before `content.askPatterns`) into `safe` / `destructive` / `super_destructive` across Linux / macOS / Windows (platform auto-detected, overridable via `bash.platform`). Tiers 2–3 raise the **existing** askHuman event with **`event.classification`** + **`event.tier`** (2/3) attached — `event.action` / `_ctx` intact — so the `humanChannel` maps severity → ceremony (PIN, 2-key, auto-deny). bareguard holds **zero auth logic** and **never hard-denies** tiers 2–3; a consumer wanting "never" auto-denies that tier in its channel. Consumers **tune, never reimplement**: `bash.extraDestructive` / `bash.extraSuperDestructive` (merged with the baseline) and `bash.reclassify(command, tier) → tier`. New pure export **`classifyCommand(command, { platform, extraDestructive, extraSuperDestructive, reclassify })`** plus the per-tier-per-platform sets **`DESTRUCTIVE_PATTERNS`** / **`SUPER_DESTRUCTIVE_PATTERNS`** (supersede — do not remove — the single-axis `SAFE_DEFAULT_*`). Adds `classify` / `platform` / `extra*` / `reclassify` to `BashConfig` and `classification` / `tier` to `HumanEvent`. **Honest scope:** best-effort pattern matching, defense-in-depth — **defeatable by obfuscation (`base64 -d \| sh`, renamed binaries); NOT a sandbox.** It is **UX tiering, not enforcement** — the fs/exec scope stays the hard boundary and `event.tier` is never a security guarantee. The deny **floor still wins**: `rm -rf /` is denied by the safe-default `content.denyPatterns` at step 2 before classify runs at step 4. **Fully additive — with `classify` off the decision path and every audit/event line are byte-identical.**

### Security
- **ReDoS in the `rm`-root super-destructive patterns — caught and fixed pre-release (`/security` pass on this change).** The two `rm`-root patterns used three consecutive unbounded quantifiers over one class (`[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*`); a flagless run like `rm -rfrfrf…` (no space) made the failing `\s+` tail redistribute the run across all three → **catastrophic backtracking** (measured: n=1000 → 1.6 s, n=2000 → 21 s). Because every action flows through `gate.check()`, a single ~4 KB command string from a confused or prompt-injected agent could hang the whole gate — a runtime-wide DoS. Rewritten to test the `r`/`f` flags with **non-consuming lookaheads** (`-(?=[a-zA-Z]*r)(?=[a-zA-Z]*f)[a-zA-Z]+`), which scan once and don't redistribute. After: the killer input drops 21 s → ~1 ms, a 1 MB worst case → ~16 ms (linear); all classification outcomes preserved. Regression-guarded in `test/classify.test.js` (a flagless 40 KB `rm` run must classify in < 1 s — a ~21 000 ms → ~1 ms margin). **Classify cannot weaken a control either way:** it runs at the ask step (4), only after the deny floor (steps 1–3), so it can only *escalate* to a human ask, never downgrade a deny (`rm -rf /` still denies at step 2 before classify runs).

### Tests
- **+17, suite 180 → 197** (all green; typecheck clean): `test/classify.test.js` — unit coverage of `classifyCommand` (super/destructive/safe across all three platforms, platform isolation, empty/non-string, `extra*` merge, `reclassify` both directions + invalid-return ignore) and gate-integration coverage (tier-3 / tier-2 askHuman event carries `classification` + `tier`; humanChannel maps tier → ceremony; opt-in off-by-default; **deny floor beats classify** with the human never reached; safe command raises no event; a non-classify ask carries no `classification`/`tier`; `extra*` + `reclassify` flow through the gate) — plus a **ReDoS regression** (a flagless 40 KB `rm` run must classify in < 1 s). POC validated the corpus against real command strings, and the "defeatable" honest-scope claim was confirmed true (base64 / backslash-split evasions classify as `safe`).

## [0.7.1] — 2026-06-15

**Docs + tests only — no library change.** Surfaces an existing capability of the `flags` primitive (shipped 0.6.0) that an adopter couldn't find, so they reached for a separate per-tool approval channel instead.

### Documentation
- **Blanket per-tool confirmation is `flags: { type: { bash: "ask" } }` — documented across README, context guide, cookbook, and PRD.** Because `type` is itself an action field, gating it asks the human before *every* action of that type (e.g. every `bash`) — and because the `flags` ask arm sits at step 4b, **before** the allowlist (step 5), it fires even on an allowlisted tool and an `allow` decision never preempts it. This is the consolidation path away from a bolted-on per-tool checkpoint: **one `humanChannel` owns confirmation, no second approval channel, no local drift.** The reframed answer to an adopter's "always-ask" request — **no new primitive needed** (the repro that "didn't fire" was on `bareguard@0.4.2`, which predates `flags`; the config key was silently ignored). README flags row + `bareguard.context.md` "I want to…" row + `harness-cookbook.md` worked example (`humanChannel` with `event.action._ctx` preserved) + `bareguard-prd.md` §13 flags row note.

### Tests
- **+2, suite 178 → 180** (all green; typecheck clean): `flags-security.test.js` pins the always-ask-per-type contract end-to-end through the real `Gate` — (1) an allowlisted `bash` action still routes to `humanChannel` as `kind:"ask"` / `rule:"flags.type"` with `action._ctx` preserved, and an `allow` reply lets it proceed; (2) a `deny` reply blocks, and an unconfigured `type` is a no-op (no over-firing). Both **mutation-confirmed to fail** when the ask arm (step 4b) is neutered.

## [0.7.0] — 2026-06-15

### Added
- **`Budget` beyond money — generic countable-resource dimensions + a soft-warn tier (harness-prd OQ3).** Two additive extensions to the cumulative wall, both opt-in: (1) `budget: { resources: { writes: 100, rows: 10000 } }` caps *arbitrary* countable resources, accrued from `result.counts` (e.g. `{ writes: 1 }`) with the **same post-fact cumulative halt as money** (rule `budget.resource.<name>`) — so a decomposition (1+1+…) can't walk past a write/row/byte cap, not just a dollar cap; (2) `budget: { softRatio: 0.8 }` emits a non-blocking `budget_warn` audit line when **any** dimension (money, tokens, or a resource) crosses `ratio × cap` while still under it — observability for "limit agents beyond money", edge-triggered once per crossing. **The decision path is byte-identical:** a warn never routes through `check()`, never calls `humanChannel`, never halts. `raiseCap()` / `topup` now accept a generic resource name. **File format → v2** (adds `resource_caps` / `resource_spent`): a v1 file is read forward-compatibly (money totals preserved, generic dims default empty, upgraded to v2 on the next write); an older bareguard reading a v2 file fails **safe** (`BudgetUnavailableError` → halt), never corrupts. The first real consumer is the **operator** (cap/monitor runaway `memory.write`s or a 10k-row export) — proven against litectx's published `toWriteAction` emitter by `seam-contract.test.js`'s OQ3 row. Adds `resources`/`softRatio` to `BudgetConfig` and `counts` to `Result` in `types.js`.
- **Joinable audit lines — a per-action correlation id (harness-prd OQ4, a2a §12.2).** Each `check()` eval mints a short `aid` stamped on every audit line it emits and returned on the decision; `record(action, result, { aid })` stamps the same id on the record line, and `run()` threads it automatically — so a request joins to its outcome (and its approval) in one record **even when two actions are byte-identical** (which content-join cannot disambiguate). The compose seam (separate `check`→`record`) joins by reading `decision.aid`; omit it and `record()` mints its own (today's behavior — no regression). Adds optional `aid` to the `Decision` typedef.
- **Axis B return-time judge — `gate.annotate` (harness-prd §8.2, the first Axis-B `src/` surface).** A thin, opt-in primitive: the caller hands the gate a return-time-judge **fact** `{ surface, verdict?, where?, meta? }` (did a returned value *honor* the user's request?); bareguard **buffers** it, **audits** it (`phase:"annotate"`), lets it **ride the next human ask** `check()` raises (the human sees independent facts, not the agent's spin), and exposes it for **agent feedback** via `gate.drainAnnotations()`. bareguard **never runs an LLM and never decides an outcome** — the fact is the caller's, the judge (if any) is caller-side. Routing is the pure exported `routeAnnotation(surface, reversible, knob)` (`surface × reversibility × knob`): **reversibility is read from the GATED ACTION's type** via the operator's `axisB.reversible` list — never the fact, the agent, or the model (a hallucinated "reversible" must not auto-pass a booking); the `axisB.reversibleEscalation` knob (`strict` default | `relaxed`) is pure noise control on the reversible path, never safety. **B never blocks alone** — worst case it annotates an ask Axis A already raised; **with no `annotate()` call the decision path is byte-identical**. Adds `Annotation` / `AxisBConfig` typedefs, `axisB` to `GateConfig`, and `annotations` to `HumanEvent`.

### Security
- **`gate.annotate` audit lines redact secrets and bound their fields (Medium, fixed in the same change — surfaced by the `/security` pass on the Axis-B build).** Two hardenings on the new return-time-judge sink: (1) the audit redactor now also covers the annotate line's reply-derived `where` / `meta` (it previously only touched `action` / `result` / `reason`), so a secret echoed by a judge into `where` is no longer persisted raw when `secrets` is configured — preserving the gate's "audit never carries raw secrets without the caller pre-redacting" guarantee; redaction stays audit-only (the live `humanChannel` event and `drainAnnotations()` keep the real value). (2) `annotate()` bounds `verdict` (≤80 chars), `where` (≤300 chars), and `meta` (≤1000 bytes, else a marker) at the source, **and** the audit's oversized-line truncation now re-bounds `where`/`meta` (it previously only re-bounded `action`/`result`) — because redaction runs *after* the source bound and can *expand* a field (`[REDACTED:…]` per match), an unbounded post-redaction line could still exceed the PIPE_BUF cap and break atomic appends on a shared multi-process audit file. All three regression-guarded in `axis-b-annotate.test.js` (incl. a file-path test asserting the line stays atomic when an expanding redactor is configured), mutation-verified to fail on the un-hardened path. (A third finding — unbounded annotation buffer if `drainAnnotations()` is never called — accepted as Low: in-memory, per-run, caller-driven, with the drain-each-turn pattern documented.)
- **Generic resource counts are monotonic and bounded (Low, fixed in the same change).** `result.counts` accrues only **positive** deltas for **configured** resources: a negative delta is rejected (counts can't be un-spent — closes a "refund" evasion of the cumulative cap) and unconfigured keys don't accrue (bounds the shared budget file against arbitrary count keys; observed-only counts still appear on the record line via `result`). Surfaced and fixed during the `/security` pass on the OQ3 change; regression-guarded by `budget-resources.test.js` ("counts are monotonic …", mutation-verified to fail on the un-hardened path).

### Tests
- **+17, suite 150 → 167** (all green; typecheck clean): `budget-resources.test.js` (12), `audit-correlation.test.js` (4), and a `seam-contract.test.js` OQ3 row (+1) driving litectx's real emitter through a write-count cap. Every delivered path is covered by a test that's been **mutation-confirmed to fail when the code breaks** — resource-halt loop, `aid` thread, counts hardening, soft-tier edge, v1 read-compat (reject-v1 + drop-money), the resource-topup-via-humanChannel flow (`_resourceFromRule`), shared-file resource accrual (ignore-committed → lost updates), and `refresh()` resource sync.
- **+11, suite 167 → 178** (all green; typecheck clean): `test/axis-b-annotate.test.js` covers the §8.2.4 acceptance set — buffer-and-ride, the full `routeAnnotation` matrix, reversibility-read-from-the-action (not the fact), the audit + drain sinks, the no-`annotate()` byte-identical path, knob default `strict` / `relaxed` non-interrupt, and B-never-denies — plus three security regressions (audit-line secrets redaction; source-level field bounding; and post-redaction line atomicity on a real file when an expanding redactor is configured). Each path **mutation-confirmed to fail** when the code breaks (knob flip → matrix + reversibility + knob-default tests fail; drop the attach → ride tests fail; read reversibility from the fact → only the reversibility test fails; drop the redaction → the redaction test fails; drop either field cap or the truncation re-bound → the corresponding size/atomicity test fails).

### Documentation

- **`harness-prd.md` — the deferred surface reassessed against litectx 0.16.1; OQ3/OQ4 moved to BUILT** (§0.2 round-update + build-round decisions, §8.1 the concrete Axis-B `recall`/`impact` spec, OQ-status bumps). Records `memory.inject` as dead-by-design (no producer), the Software Factory as replaced by litectx-internal benches (so the §9.3.2 integration bench collapses to "already covered" by the seam test), and SF-8/9 as moot.
- **README — "The bare ecosystem" section recast from a 4-column table to a Core / Optional-reach list.** Now covers all six modules — core `bareagent` · `bareguard` · `litectx`, optional reach `barebrowse` · `baremobile` · `beeperbox` — in a scannable row form that also renders cleanly on npm. README only; no package change.
- **Three research/context docs merged into `docs/00-context/harness-research.md`** (`agentic-web-problem-space.md` → Part I, `a2a-intent-drift-prd.md` → Part II, `02-features/identity-and-the-gate.md` → Part III) — they were one argument (the agentic-web problem space, the experiment that probed it, and where the gate's authority stops). Bodies unchanged; intra-doc cross-links repointed to Parts; all external links (both READMEs, `non-roadmap.md`, `usage-guide.md`, `bareguard-prd.md`, `harness-code-mode/README.md`, `harness-prd.md`) updated. Originals removed.
- **`harness-prd.md` — Axis-B return-reconciliation spec refined** (design-only, still unbuilt): **#2 resolved = thin primitive** (`gate.annotate` ships the envelope + routing; the check stays the caller's). New **§6.6** (violation vs deviation × reversible/irreversible routing table — `violation` always escalates to HITL, `deviation` only when irreversible; "no pass" = escalate, never auto-reject), **§6.7** (the check is caller-side; the optional return-time LLM judge *locates* the comparison and returns only the "where" — it never decides `kind` or reversibility; bareguard/litectx never call an LLM), and **§6.8** (the #3/#4 boundary — the in-spec lie and the payment-pre-auth oracle are out of scope by construction; cross-links the merged research doc). `kind` added to the fact envelope; D7 row and §8.1 (Case R now escalates as a deterministic violation) updated to match.
- **`harness-prd.md` §9.2 + §6.6/§6.7 — Axis-B return-time judge POC (E6, design-only).** New `harness-code-mode/e6-judge.mjs` + `run-e6{,b,c,d,e}.mjs` probe the judge against the three review holes on a real model (haiku via the E1 CLIPipe), with negative controls. Findings recorded honestly: **end-to-end confirmed** (E6d, a real drifting agent books over the stated cap, the judge flags the actual intercepted booking, 6/6); **B is drift-conditional** (E6c, a cooperative agent self-refuses under a hard cap); **silent mis-locate is real** on sprawling replies (~1/3) but the clean egress action hits 6/6 → judge the authoritative egress, not a free-text listing; **anchor on the verbatim request** (hole 3); **injection didn't bite haiku but isn't disproven** (open pre-deploy test). **E6e** (labeled set incl. the prose/deviation branch): **surfacing reliable (9/9), but `kind` is not (6/9, over-calls `violation`; verifiable/opinion 5/8)** — errs toward surfacing, so route on reversibility and treat `kind` as a hint (§6.6 caveat). §6.7 records the **resolved one-call judge** (`(ask, reply) → verifiable/opinion · violation/deviation/none · where`) + three non-negotiables (anchor on verbatim request, reply-as-data, fail toward surfacing); "locate + math" demoted to optional hardening. POC only, never shipped; `src/` untouched.
- **`harness-prd.md` — Axis-B judge reframed from a confidence scale to a decisive `honored`/`broke` verdict (E6g/E6h/E6i); §8.2 marked IMPLEMENTED.** A clean A/B (E6g) **refuted** the earlier "neutral judge prompt clears the compliant €280" claim — the neutral *confidence* prompt over-flagged it 4/5 (worse than biased). The bug was the **confidence framing itself** (graded scales make the judge hedge `unsure` on a near-limit value); a decisive `honored`/`broke` ask (Aurora's matching-judge pattern, with the floor-raise as a decisive tiebreak not an `unsure` bucket) cleared €280 5/5 while every real drift + the injection case stayed `broke` 5/5 (E6i, 7/7 clear cases). The knob collapses to binary `strict|relaxed` (the decisive verdict left `tuned` nothing to split). Rewrote D7, §6.6 (tables + routing fn), §6.7 (non-negotiable #3), §8.2.0–.3, §9.2.6. The deterministic-calculator detour (E6h) is recorded as confirmed-but-not-taken (long-tail perfection-chasing). New POC runners `run-e6{g,h,i}.mjs`; `judgeDecisive()` added to `e6-judge.mjs` (POC only, never shipped).

## [0.6.0] — 2026-06-14

**Two library changes — the `flags` primitive (additive, opt-in) and a prototype-pollution hardening at the gate (Security, below).** The rest is tests, docs, and CI. No breaking change for plain-dict actions; an unset `flags` config is a no-op. The litectx write-gate **seam is now closed**: `seam-contract.test.js` runs against litectx's published `toWriteAction` emitter (`litectx@^0.13.0`, a **devDependency only** — not shipped to consumers; the production dep tree is unchanged at `proper-lockfile`).

### Security
- **The gate normalizes every action to own-properties-only before evaluating it** (`safeAction` in `gate.js`, applied at `check`/`allows`/`record`/`run`). Surfaced by grounding a `/security` finding: every eval step reads `action.<field>` / `action.args.<field>` directly, so a polluted `Object.prototype` (e.g. `Object.prototype.type = "bash"`) could inject a field the action never declared and flip a decision — **including deny→allow on the allowlist** (a privilege escalation; proven by POC). Pre-existing and Low (requires full `Object.prototype` pollution, itself catastrophic), but real and gate-wide — not flags-specific (`bash`/`fs`/`net`/`flags` all read action fields directly; grounded). Fix is a null-prototype shallow copy (+ null-proto `args`) at the single chokepoint — covers every primitive, touches none; ~0.2µs/call (measured). `run()` evaluates **and executes** the normalized action so the decision and what runs are the same (no TOCTOU). **Behavior note:** `run()`'s executor and the `humanChannel` event now receive a null-prototype shallow copy (own props incl. `_ctx` preserved) — transparent for plain-dict actions, differs only for actions relying on a prototype chain. Regression-guarded by `test/gate-prototype-pollution.test.js` (5, incl. the grant case + a mutation-verified failable guard).

### Added
- **`flags` — a structured field-value gate primitive (`src/primitives/flags.js`).** Gates an action on a **named field's value** read directly off the action — `flags: { provenance: { web: "ask" }, injectionRisk: { high: "deny" } }` — never via `JSON.stringify`. This is the **one net-new primitive litectx's seam needs** (baresuite-litectx-prd §5B): bareguard's existing levers can only key on `action.type` (allowlist) or regex the serialized action (content), so there was no path to gate a *structured* verdict. A memory adopter states the **source** (`provenance:"web"`) plus an optional guardrails `injectionRisk`; the `flags` policy renders the deny/ask — content judgment stays out of bareguard (the §6 line). Outcomes restrict only (`deny`/`ask`, never `allow`); an absent/unmapped field is a no-op. **Floor supremacy preserved:** the deny arm sits at step 2b and the ask arm at step 4b — both *before* the allowlist (step 5), so a flagged `memory.inject` is blocked even when its `type` is allowlisted. Proven against the real `Gate` by a mutation test (misplacing the check below the allowlist flips the floor-supremacy case `deny`→`allow`). **Hardened (`/security` pass, then grounded by an adversarial POC):** two defense-in-depth fixes, both for reading an attacker-influenced value as a map key — (1) a non-primitive (object/array) field value is skipped rather than coerced, so a hostile `toString`/`Symbol.toPrimitive` can't throw out of the eval (matches the `bash.invalidCmd`/`fs.invalidPath` type-confusion guards); (2) the value-map lookup honors **own keys only** (`Object.hasOwn`), so a polluted `Object.prototype` (e.g. `Object.prototype.web = "ask"`) can't make a flag fire on an empty/unconfigured map. The second was *surfaced by grounding the report's prototype-safety claim* — reasoning had it right for inherited functions but missed a polluted string value matching an outcome. Both are fail-closed/Low, fixed before they could matter. +13 tests (`eval-order.test.js` ×5, `seam-contract.test.js` ×3, **`flags-security.test.js` ×5** — no-grant invariant, prototype-key value safety, prototype-pollution resistance, own-key positive control, end-to-end floor supremacy); suite 132→145. Adds `FlagsConfig` to `types.js`. *Generic — no `memory.*` type recognition; the floor was already type-generic.*
- **`test/seam-contract.test.js` — the write-gate seam contract test** (10 tests). Now runs against litectx's **real published emitter** (`toWriteAction` from `litectx@^0.13.0`) — the synthetic stand-in and its marked SWAP POINT are retired (the §5B step-6 release handshake is complete; the seam is live and regression-guarded both sides). Proves a memory adopter's `memory.write` is gated by **shape** (allowlist/denylist) with zero config change, and pins the §6 boundary as tested fact: secret/injection **content** in the write `text` is *not* caught by default (safe-default denyPatterns are SQL/shell only), closes only with an explicit `content.denyPattern`, and `secrets` config **redacts the audit trail but does not deny** (redact ≠ gate; asserted against the audit file). **+3 structured-flag rows** exercise the `flags` gate end-to-end against the real emitter: `provenance:"web"` → ask (`flags.provenance`); `injectionRisk:"high"` → deny even when `memory.write` is allowlisted (floor supremacy); an unset `injectionRisk` is a no-op. (litectx mints `memory.write` only — `memory.inject` has no producer.)
- **`docs/01-product/harness-prd.md` — the harness PRD** (floor+harness / Axis-A-B design, living) plus **`harness-code-mode/`** — the POC gates E1–E5 (real-LLM generated body, Axis-B detect-and-feed-A mechanic, decomposition attack vs cumulative budget, hardened `--permission` sandbox, harness selection / tighten-only). All runner-layer; per the PRD's own discipline the POC is never shipped. §0.1 records the build state: **Axis A = the shipped library; Axis B (OQ1) = the one deferred new surface.**
- **`docs/01-product/barecontext-prd.md`** (SEED / NOT-NOW — the context-economy axis + the bareguard↔barecontext sorting rule) and **`docs/01-product/litectx-prd.md`** (DRAFT — the lite code-aware memory engine; bareguard's intended first external consumer).
- **`bareguard-prd.md` §19: two future-feature candidates PROPOSED from the graduated harness POC** — (1) `Budget`: generalized cumulative dimensions (sends/rows/bytes) + a soft-warn threshold, with the E3 decomposition evidence attached (harness-prd OQ3); (2) `Audit`: request + return joinable on one line for ask-vs-outcome reconciliation (harness-prd OQ4; a2a §12.2). Proposed, not committed — both stay demand-gated. Also fixes a relative link in §19 missed by the docs reorg.
- **`docs/02-features/harness-cookbook.md` — the harness cookbook** (harness-prd §5.2 shipped as recipe): the E5-validated floor + catalog + fail-closed resolver pattern with four operator-vetted bundles (`read-only-research`, `book-with-approval`, `send-comms-HITL`, contract-tested `memory-adopter`) and a roll-your-own skeleton. Documents the verified foot-gun that an **empty `tools.allowlist` fails OPEN** (treated as not-configured → default allow), so off-catalog bundle proposals must be refused at resolve time, never "enforced" via an empty scope. Linked from both doc maps and the npm-shipped `bareguard.context.md`. **Extended to 8 samples:** `code-mode-sandbox` (the E1+E4 pattern — agent-written body in a `--permission` child, gate in the parent via RPC), `repo-maintainer` (git free, push/merge/deploy ask — the SF-9 ship-gate as a recipe), `delegation` (spawn/defer containment — `maxChildren`/`maxDepth` + family-counted rate caps), and `detect-and-feed-A` (Axis B as a runner-layer recipe, ~10 lines of caller-owned check, no new primitive — the live demand sensor for the deferred OQ1 declaration format). All four verified by execution against the shipped `Gate` (E4 re-run + 9 assertions: ask/deny rules fire as documented; `--force` denied at step 2 by safe defaults before the bundle pattern; `maxChildren` halts the 3rd spawn; the Axis-B fact reaches the human's event verbatim).

### Changed
- **Version policy decided: HOLD at 0.5.x; 1.0 is gated, not scheduled.** The 1.0 gate (seam exercised by a real consumer + last-call breaking-change review — notably whether empty-`allowlist`-fails-OPEN survives the lock — + the §21 bareagent box), the SemVer surface it will cover, and the pending-work index are documented in `bareguard-prd.md` §19 and `docs/04-process/decisions-log.md`.
- **Docs reorganized into a numbered hierarchy** (`00-context` … `04-process`): `identity-and-the-gate.md` → `docs/02-features/`; `decisions-log.md` + `non-roadmap.md` → `docs/04-process/` (content unchanged — pure moves). Doc maps in both READMEs updated; root README test count refreshed (132).
- **CI:** the publish workflow now polls the npm registry for ~2 min (was ~15s; `--prefer-online` skips npm's view cache) and accepts an `exit 0` publish even if the registry hasn't reflected it yet, so a successful-but-slow-to-reflect publish no longer reports a false failure.
- **`publish.yml` is now manual-only (`workflow_dispatch`) — npm OIDC trusted publishing with provenance, idempotent, and verifies the registry end-state.**

## [0.5.2] — 2026-05-29

Turns on `strictNullChecks` over the sources — closing the null-safety gap behind the v0.5 types — and simplifies the typecheck setup. Also fixes a Windows-only flake in the v0.5.1 atomic budget write. No public-API change.

### Fixed

- **`defer` / `spawn` rate limiting now enforces in fileless audit mode (was fail-open).** The rate-window counter is fed by the gate's rate context, which carries the in-memory `entries` array (not a file path) when `audit.path` is `null`. `deferRateCheck` / `spawnRateCheck` only forwarded `auditPath`, so in fileless mode the trailing-window count was always `0` and the per-minute cap **silently never fired** — a fail-open in a policy primitive (it previously threw on the null path, which a hardening guard in this release had quieted to a `0`). Both checks now also forward `entries`, so the cap is counted from the in-memory log; file mode is unchanged (`entries` is `null` there and the file is read as before). Fileless mode is documented test-only, but a security control should never silently no-op. Regression tests added for both primitives.
- **Atomic budget write no longer flakes on Windows (`EPERM` on `rename`).** v0.5.1 made `Budget._write()` write to a temp file then `rename` it over the target — atomic on POSIX, but on Windows `rename`-replace (`MoveFileEx`) intermittently throws `EPERM`/`EACCES`/`EBUSY` when the destination is momentarily held by another process (Defender, the search indexer, a lagging handle close), even with the write serialized under the budget lock. That error propagated out of `record()` and crashed the worker — which is what failed the `windows-latest / Node 22` CI leg (a worker exited non-zero in `audit-stitching`). The rename now retries on those transient codes with a short backoff (~550ms worst case, well under the 20s lock `stale`); the retry is win32-only, so the POSIX path and the happy path are unchanged. Same strategy as `write-file-atomic`/`fs-extra`.

### Changed

- **`strictNullChecks` is now enabled on the source typecheck (`tsconfig.json`), and the ~45 findings it surfaced are fixed.** The v0.5.0 type work checked a strict *consumer fixture* but ran the source itself with no null-checking, so genuine null hazards in the `.js` were invisible. The fixes are behaviour-preserving narrowing: `gate.check()` now derives its decision as `this._haltCheck() ?? await this._stepEval(action)` (was a nullable `let` that TypeScript couldn't prove non-null); `Audit` and `Budget` capture the nullable `filePath` / `sharedFile` into locals past their fileless/local-mode guards so the narrowing survives `await` and closure boundaries; and the rate-window helper takes `string | null` / `object[] | null` and returns `0` for "no audit source" instead of throwing a `TypeError`. Full `strict` stays off (the hand-written JS still trips ~130 unrelated strict errors that don't affect the emitted declarations); `strictNullChecks` is the slice that matters for null safety and for the generated `.d.ts`.
- **Typecheck simplified to a single `tsc` project.** The strict consumer-resolution fixture (`tsconfig.consumer.json` + `test/types/consumer.ts`) is removed: it ran full-strict against a stub while missing every real null issue in the actual source, so `strictNullChecks` on the source is both simpler and strictly more thorough. `npm run typecheck` is now just `tsc -p tsconfig.json`.
- **`prepare` → `prepublishOnly` for the `.d.ts` build.** Declarations are still generated into `types/` and shipped via the `files` allowlist; they're now built before publish rather than on every `npm install`. npm consumers are unaffected (the tarball carries pre-built `types/`); a git/`file:` dependency would need `npm run build:types` to populate them.

## [0.5.1] — 2026-05-29

### Fixed

- **Shared budget file is now written atomically (temp file + `rename`).** `Budget._write()` used `fs.writeFile`, which opens the target with `O_TRUNC` and then writes — exposing a zero-length window. Under concurrent multi-process load a reader could hit that window and `JSON.parse` an empty string, throwing `BudgetUnavailableError: …Unexpected end of JSON input` (the v0.4.7 "fail loud on corrupt read" path misclassifying a transient truncation as corruption). This surfaced as an intermittently-flaky `shared-budget` test. Writes now go to a unique temp file and `rename` over the target (atomic within a filesystem; an atomic replace on Windows via libuv), so a reader always sees a complete old-or-new file. Genuine corruption is still detected and still fails loud. Reproduced at ~1/240 concurrent worker runs before the fix; 0/400 after.

## [0.5.0] — 2026-05-29

Ships TypeScript types for the library, plus policy-bypass hardening from a security audit. Minor bump for the new public capability (typed consumption).

### Security

- **Type-confusion fail-open closed in `fs` / `net` / `bash` (H1).** A present-but-non-string `path` / `url` / `cmd` (an array, a `{ toString }` object, a number) previously made the primitive return "no opinion" — the action then fell through to the allowlist and was **allowed**, bypassing `deny` / `writeScope` / `readScope` / `denyPrivateIps` / `allowDomains`, while the executor coerced the value back to a real string (`{ toString: () => "/etc/passwd" }`). The `bash` allow path additionally threw a `TypeError` mid-eval. These now **deny** with `fs.invalidPath` / `net.invalidUrl` / `bash.invalidCmd`. An absent field is still a no-op.
- **Backslash traversal no longer escapes `fs` scope on Windows (M2).** `norm()` used `path.posix.normalize`, which treats `\` as an ordinary character — so `/scope/..\..\etc` left its `..` segments uncollapsed and escaped the scope on win32 (a CI-supported platform). Backslashes are now folded to `/` before normalization.
- **Glob `*` now matches line terminators (L1).** `globToRegex` compiled without the `s` flag, so `.` didn't match `\n` / `\r` — a tool name like `"danger\nous"` slipped past a `tools.denylist` glob (`"danger*"`). The compiled RegExp now uses dotAll. The allowlist direction was already fail-closed and is unaffected.

### Documented (intentional limitations surfaced by the audit)

- **`net.denyPrivateIps` matches the literal host only — it does not resolve DNS (M1),** so a hostname whose record points at a private/metadata address is not caught. It's defense-in-depth, not an SSRF boundary; `allowDomains` (fail-closed) is the control to bound egress. Numeric-encoding vectors (decimal/octal/hex/short-form/mapped-IPv6) are **not** a bypass — the WHATWG URL parser normalizes them before the check. Now noted in the README, the `net` JSDoc, and `NetConfig`.
- **`secrets.envVars` skips values shorter than 8 characters (L2)** to avoid masking incidental short strings (port numbers); use a `patterns` entry for short secrets. Now noted in `SecretsConfig` and the source.

### Not changed

- **`defer`/`spawn` rate window scans the full audit log per check (validated, left as-is).** It's O(n) per check (O(n²) over a long run) on the hot path. An early-stop optimization was implemented and then **reverted**: the audit log is only approximately time-ordered across processes, so any position-based early-stop can under-count in-window records — and for a rate limiter an under-count is a cap **bypass**. A full timestamp scan is the only provably-correct option; bound the cost by keeping runs / audit files reasonably sized. (Equivalence testing under reordered timestamps is what caught the regression.)

### Added

- **Ships with TypeScript types.** The public API is now fully documented with JSDoc, and `.d.ts` declarations are generated from it (`tsc --emitDeclarationOnly --allowJs`) so TypeScript consumers — and JS editors — get full IntelliSense and compile-time checking on the `Gate` config, the decision/event shapes, and every re-exported primitive. JSDoc is the single source of truth; the declarations are generated (into `types/`) by the `prepare` script and shipped in the package, never hand-maintained. Named config types are importable from the root (`import { Gate, type GateConfig } from "bareguard"`) or from the `bareguard/types` subpath. No runtime change — bareguard remains plain ESM JS. A `typecheck` CI job (`tsc`) plus a strict consumer-resolution fixture (`test/types/consumer.ts`) guard the JSDoc and the published types against drift.

### Docs

- **README quick-start no longer pre-redacts before `check()`.** It showed `gate.check(gate.redact(action))`, but since v0.4.5 the gate auto-redacts at the audit boundary when `secrets` is configured, and pre-redacting before `check()` can weaken policy matching (eval should see the real action). Now `gate.check(action)`, matching the Integration Guide. Also refreshed the stale test count (88 → 107) and LOC (~930 → ~1,000).

## [0.4.7] — 2026-05-24

Hardens shared-budget cross-process locking — follow-up to the flaky-test investigation in 0.4.6, validated by a second `/code-review` pass (which empirically tested crash modes and corrected the first cut).

### Changed

- **`budget.record()` now fails loud on an unreadable/corrupt shared budget file.** Previously, if the under-lock read or `JSON.parse` failed, it silently fell back to `spentUsd += dUsd` (stale local state) and wrote that over the committed total — losing spend and risking overspend. It now throws `BudgetUnavailableError` instead, matching the documented PRD §13 contract ("surface `BudgetUnavailableError` and terminate cleanly"). **Migration:** a corrupt budget file that was previously swallowed now propagates out of `gate.record()` / `gate.run()`; wrap those if you want to degrade rather than halt. Normal operation is unaffected — the throw only fires on genuine corruption (a missing file is still re-seeded before the lock, and `init()` keeps its rebuild-from-audit recovery).
- **`proper-lockfile` `stale` raised 10s → 20s** for the budget file. The critical section is sub-millisecond, so a lock steal (which would put two writers in the section and silently lose an update) requires the holder to be frozen that long; 20s shrinks the window while the unchanged ~2.25s retry budget stays well under it (so a process waiting on a live holder always errors before it would steal). Fail-safe tradeoff: a holder hard-killed (SIGKILL) mid-lock makes `record()` throw `BudgetUnavailableError` until the lock ages past `stale` — halting rather than overspending.

### Tests

- **Suite 106 → 107.** New case: `record()` on a corrupt budget file throws `BudgetUnavailableError` and leaves the file untouched (no stale-local clobber). Also folds in 0.4.6's flaky-test fix: `shared-budget.test.js`'s concurrent-spend assertion now checks scheduling-independent invariants (never over-counts; spend accumulates) instead of penny-exact `$0.60`, which contradicted the documented soft-budget contract and flaked CI under lock contention.

## [0.4.6] — 2026-05-23

Fixes from a `/code-review` pass over the 0.4.4/0.4.5 security changes — it caught a fail-open in the `fs` primitive those releases were meant to harden. Suite 100 → 106.

### Security

- **`fs` deny/scope entries written with a trailing slash no longer mishandle the directory node itself.** `path.posix.normalize` keeps one trailing slash, and `within()` only stripped it on the prefix arm — so `deny: ["/etc/secret/"]` did **not** deny `read /etc/secret` (fail-open on the node itself; children were still denied), and `writeScope: ["/app/data/"]` wrongly denied a write to `/app/data` (fail-closed). `within()` now strips a trailing slash from the normalized base before both the exact-match and prefix checks, and special-cases root (`/`).
- **`secrets` redaction now masks every occurrence on a line, even for a non-global pattern.** `redact()` used `String.replace`, which only replaces the *first* match when the pattern lacks the `g` flag — a natural config mistake (e.g. `/sk-[a-z0-9]+/`) that left the second secret on a line in cleartext. Since v0.4.5 routes every audit line through `redact()`, this undercut the audit-safety guarantee. Patterns are now normalized to global at the match site.
- **`net.denyPrivateIps` — defense-in-depth for two deprecated IPv6 forms.** IPv4-compatible IPv6 (`::a.b.c.d`, e.g. `[::127.0.0.1]`) is now decoded and classified like the IPv4-mapped form, and the IPv6 local range is widened to cover deprecated site-local `fec0::/10` (`fe8`–`fef`). Both formats are non-public, so this is a safe tightening; public addresses are unaffected.

### Tests

- **Suite 100 → 106.** New `test/security-review-followup.test.js`: trailing-slash deny/scope (dir node + root + escapes), redaction of multiple secrets via a non-global pattern (direct + through the audit log), and the two net IPv6 forms (with public-address regression guards).

## [0.4.5] — 2026-05-23

Security hardening pass — the follow-up to 0.4.4's audit. Three of the remaining findings fixed (the fourth, `allows()`/askHuman, is documented rather than changed since it's correct for its pre-filter purpose). Suite 93 → 100.

### Security

- **`bash.allow` now fails closed on shell metacharacters.** A prefix allowlist can't bound what runs after a chain/pipe/substitution — `bash.allow: ["git "]` previously permitted `git x; rm -rf ~`. Now, when `allow` is set, any command containing `;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `<`, `>`, or a newline is denied with rule `bash.allow.shellMeta`. This also denies legitimate pipes like `git log | head` — that's the intended trade for making the allowlist a real boundary; use `content.denyPatterns` (whole-command scan) when you need chaining. `denyPatterns` still evaluate first; the metachar guard only applies when `allow` is configured.
- **Audit auto-redacts when `secrets` is configured.** The gate now redacts `action`, `result`, **and** `reason` on every audit line at write time, so raw secrets never reach the JSONL on disk. Redaction happens at the persist boundary only — policy eval still runs on the unredacted action, so matching is never weakened (this is strictly more correct than the old `gate.check(gate.redact(action))` pattern, which redacted *before* eval). `reason` is included because diagnostic strings can echo action data (e.g. `net.invalidUrl` embeds the URL). No behavior change when `secrets` is unset.
- **`budget.raiseCap` / topup reject negative & non-finite caps.** A negative cap silently wedged the run in permanent halt (`spent >= cap` always true). `raiseCap` now throws on a non-finite or negative cap (matching its existing unknown-dimension throw); a `topup` with a negative `newCap` returns a clean deny instead of throwing out of `check()`. Lowering a positive cap is still allowed (tightening a budget is the safe direction).

### Changed

- **`gate.allows()` docs sharpened** (no behavior change). Clarified it is a catalog pre-filter that returns `true` for askHuman actions and must never be used as the authorization decision — always call `gate.check()` before executing. Gotcha #6 in the Integration Guide.
- **Secrets recipe rewritten** in `bareguard.context.md` to show config-only auto-redaction; the manual `gate.redact()` / pre-`record` redaction dance is gone (the export remains for ad-hoc use). README + PRD §8 rows 1/8 updated.

### Tests

- **Suite 93 → 100.** New `test/security-hardening.test.js`: `bash.allow` metachar denial + clean-command/off-list/no-allow cases; audit redaction of action/result/reason with proof that eval saw the unredacted command; `raiseCap`/topup cap-validation.

## [0.4.4] — 2026-05-23

Docs restructure + a new identity boundary doc, plus two security fixes to the `fs` and `net` containment primitives surfaced by a `/security` audit. Suite 88 → 93.

### Security

- **`fs` no longer allows path-traversal or prefix-boundary escapes.** Scope and deny matching previously did raw string `startsWith` with no normalization, so `..`/`.` segments walked straight out of a `readScope`/`writeScope` or past an `fs.deny` entry (e.g. `/app/data/../../etc/passwd` satisfied `readScope: ["/app/data"]`; `/etc/./secrets/key` slipped past `deny: ["/etc/secrets"]`). Scopes also matched on bare prefix, so `/app/data` granted `/app/data-secrets`. Now paths are lexically normalized (`path.posix.normalize`) before matching and scope/deny use boundary-aware containment — closing the gap PRD §8 row 3 already promised (`..` is deny-worthy). Lexical only: symlinks are **not** resolved (would need async `realpath`); callers needing symlink-proofing must canonicalize before the gate.
- **`net.denyPrivateIps` now actually blocks IPv6 and more IPv4 ranges.** `URL.hostname` returns IPv6 literals wrapped in brackets (`[::1]`), so the entire IPv6 branch of `isPrivateIp` was dead code — `[::1]`, `[fd00::1]` (ULA), `[fe80::1]` (link-local), `[::]`, and `[::ffff:127.0.0.1]` all passed despite `denyPrivateIps: true`. Also missing: IPv4 link-local `169.254.0.0/16` (cloud-metadata IMDS `169.254.169.254`) and `0.0.0.0`. Fixed by stripping brackets before matching, decoding hex-compressed IPv4-mapped addresses, and adding `0.0.0.0/8` + `169.254.0.0/16`. Hostname-based (pre-DNS-resolution) — does not defend against DNS rebinding to a private address; resolve-then-check remains the caller's job.

### Tests

- **Suite 88 → 93.** New `test/security-regression.test.js` drives the two fixes through the public `Gate` API: fs deny/`readScope`/`writeScope` traversal + prefix-boundary escapes (with paired legit-still-allowed cases), and `net.denyPrivateIps` IPv6 / IPv4-mapped / link-local / `0.0.0.0` coverage (with public IPv4/IPv6 still allowed).

### Added

- **`docs/identity-and-the-gate.md`** — where agent identity / auth sits relative to bareguard (upstream) and how to policy per-principal via `action._ctx` without any auth code in the gate. Frames the reframe "bareguard authorizes the *action*, not the *actor*," separates the four things bundled as "agent auth," and records why bareguard owns at most *audit* integrity, not agent authn. Prompted by evaluating [bindu](https://github.com/GetBindu/bindu)'s mTLS + Hydra + DID/Ed25519 stack — the conclusion was "borrow the boundary, not the infra."
- **`docs/02-features/usage-guide.md`** — human-facing companion to the LLM `bareguard.context.md`, mirroring the bareagent README/context split. Holds the eval-order walkthrough, the 7 common gotchas, and the 8 deployment recipes (content screening, Gate-per-principal, concurrent Gates, fileless test idiom, halt routing, wireGate, log rotation, sticky approvals) — all moved verbatim out of the README.
- **PRD §19 "Future features (candidates — not committed)"** — parks **tamper-evident audit (hash-chained / signed log)** as a candidate that *needs more design time before it ships even as a flag*. Records the load-bearing constraint a throwaway POC surfaced: the audit is multi-writer and lock-free, so a global chain is impossible without a per-`emit` lock; a per-`run_id` chain is feasible but only detects tampering within a run and isn't a signature. Likely an opt-in flag or `bareseal`-style sibling, never a v1 default.

### Changed

- **README slimmed 343 → 130 lines.** Now an overview: banner → install → quick start (with the "hand your AI assistant `bareguard.context.md`" pattern) → the twelve-primitives feature table → a Docs link table → ecosystem table. Recipes and gotchas relocated to the new Usage Guide; the verbose eval-order section moved there too.
- **`docs/README.md`** rewritten into a real bareguard doc index (table of every doc + "start here"). It previously contained **stale addypin v2 content** — a copy-paste leftover that described location-sharing, not bareguard.
- **`docs/non-roadmap.md`** — the "Identity / authn / authz" NO-GO entry now points at `identity-and-the-gate.md` and clarifies per-principal policy is done via `_ctx`, not gate-side auth; the "Hash-chain tamper-evidence" entry now references the PRD §19 future-feature candidate.

## [0.4.3] — 2026-05-15

Docs-only patch. Sticky-approvals recipe + matching NO-GO entry so future adopter pulls toward "build approval caching into the gate" land on a recipe instead of a primitive.

### Added

- **README Recipe 8: sticky approvals — `humanChannel` wrapper.** ~25-line wrapper that caches `allow` returns from `humanChannel` per action shape, with TTL, max-entries, and a customizable `keyFn`. Halts, topups, terminates, and (by default) denies bypass the cache. The cached return tags its `reason` so `phase: "approval"` audit lines still show every (cached or fresh) decision. Validated against a live `Gate` for: same-shape cache hit, TTL expiry re-prompt, different-shape miss, deny-not-cached default, halts always reach humanChannel.
- **PRD §10.1 callout** that bareguard never caches `humanChannel` returns — points at Recipe 8.
- **PRD §17 + non-roadmap NO-GO entry: "Sticky / cached approvals."** Records why this isn't a primitive — "same action" has no universal definition (args / arg-shape / session / TTL — each runner picks differently), so freezing one inside the gate freezes it for everyone. Adopter pulls toward this should land on Recipe 8.

### No code changes

- Source LOC unchanged. Test suite unchanged at 88.

## [0.4.2] — 2026-05-12

Follow-up to 0.4.1 after bareagent confirmed multis' two seam reports were bareguard's call. Adds the clean semantic for "tool-calling rounds" so adopters stop reaching for the `maxTurns * 2` workaround.

### Added

- **`limits.maxToolRounds: N`** — sibling halt counter that ticks only on `gate.record` calls whose `action.type !== "llm"`. Pairs naturally with bareagent's split `onLlmResult` (records `{type:"llm"}`) and `onToolResult` (records the tool's action). Halt severity, rule `limits.maxToolRounds`, default `Infinity` (opt-in). Rebuilt from audit on cold start alongside `maxTurns`. Reason string: `toolRounds X >= max Y`. Both adopters who hit bareguard so far (multis, bareagent) independently surfaced this — adding the primitive eliminates the per-round-record-ratio mental math (`maxTurns: rounds * 2`).
- **README Recipe 6: bareagent wireGate integration** — copy-pasteable wiring showing `actionTranslator` + `onLlmResult` / `onToolResult` + `maxToolRounds: N` as the canonical pattern. Replaces the previous `Loop({ maxRounds: N })` idiom (now removed from bareagent's API).

### Changed

- `Limits.tick()` now accepts the action being recorded (was no-arg). Internal change — only `gate.js`'s `record()` calls it. Public API unchanged.

### Tests

- Suite 82 → 88. New `test/v042-max-tool-rounds.test.js` covers: halt after N non-llm records, llm records do NOT tick the counter, mixed llm+tool record interleaving, default Infinity opt-in, halt routes through humanChannel, cold-start rebuild from audit.

## [0.4.1] — 2026-05-12

Adopter-feedback patch from multis (first external integrator). One seam fix, one doc clarification. No API additions, no breakage.

### Fixed

- **`bash` / `fs` / `net` primitives now also accept nested `action.args` shape.** wireGate-style adapters that pass `{type, args, _ctx}` (the natural MCP convention used by bareagent's policy hook) previously hit a seam: bareguard's primitives read top-level `action.cmd` / `action.path` / `action.url`, leaving `bash.allow` to silently deny everything because `action.cmd` was `undefined`. Every adopter wrote the same `translateAction()` middleware to hoist fields. Fixed by adding fallback reads: `bash` checks `action.cmd ?? action.args?.cmd ?? action.args?.command`; `fs` checks `action.path ?? action.args?.path`; `net` checks `action.url ?? action.args?.url`. Flat shape is still authoritative when both are present (regression-tested).

### Documented (no code change)

- **`limits.maxTurns` ticks on every `gate.record` — LLM AND tool records.** Counted from the per-Gate `limits.turns` counter, which `gate.record()` increments unconditionally. If your loop records one LLM call AND one tool call per "round", one round consumes two turns. Convert via `maxTurns = rounds * records_per_round`. README "Common gotchas" #6 + PRD §8 row 5. Surfaced by multis after their `max_tool_rounds=N` mental model produced halts at half the expected work.

### Tests

- Suite grows 71 → 82. New `test/v041-action-shape.test.js` covers nested-shape acceptance + flat-shape regression for all three primitives (bash with both `cmd` and `command` spellings; fs scope + deny; net allow + private-IP deny).

## [0.4.0] — 2026-05-11

Multis-driven adoption release: three small primitives that surfaced as blockers when wiring bareguard into a multi-tenant chatbot. No API breakage; one contract clarification on halt events.

### Added

- **`audit.path: null` — fileless in-memory audit mode** for tests. Set explicitly to `null` (not `undefined`) to disable fs writes; `gate.audit.entries` collects parsed line objects for assertions. Distinct from omitting `audit.path`, which still falls through to env / XDG default. Use with `humanChannel: async () => ({ decision: "deny" })` as the documented test idiom — no magic-string shorthands. Recipe 4 in the README.
- **`budget.strict: true` — pre-flight halt via trailing-average projection.** Per-instance rolling buffer of last 5 record costs. With ≥3 samples, halts on the next `gate.check` when `spent + last5Avg > cap` (per dimension, `costUsd` and `tokens` symmetric). Rule names unchanged (`budget.maxCostUsd` / `budget.maxTokens`); reason string distinct (`strict: spent X + est Y > cap Z`). Cold-start with <3 samples falls back to soft semantics. Default `false` — no behavior change for existing adopters. PRD §13.1.
- **README Recipes section** (6 entries): content screening on inbound/outbound text, multi-tenant Gate-per-principal with shared budget/audit, in-process concurrent Gates, test idiom (fileless + deny-lambda), halt routing via `event.action._ctx`, log rotation via `logrotate copytruncate`.

### Changed

- **`event.action` is now ALWAYS the action being checked** — including for halt events (`event.kind === "halt"`). Previously `event.action = null` for halts, which blocked multi-tenant adopters from routing halt prompts back to the originating principal. The cap was already exhausted on entry — this specific action didn't by itself trip it — but it is the action whose evaluation surfaced the halt and carries any caller-attached routing context (e.g. `action._ctx.chatId`). Halt audit lines (`phase: "halt"`) remain action-less by design — they're the operator grep target. **Non-breaking** for the documented usage (`event.kind === "halt"` as the halt discriminator). **Migration note:** if your `humanChannel` used `event.action == null` as a halt sentinel, switch to `event.kind === "halt"` — `event.action` is now non-null on the halt branch. PRD §10.1.

### Tests

- Suite grows 60 → 71. New tests in `test/v04-features.test.js` cover halt-event action contract (including the halt audit line staying action-less), fileless audit collecting entries + readAll, strict budget pre-flight halt + cold-start fallback + token dimension + topup re-evaluation, and `BAREGUARD_AUDIT_PATH` env-var precedence when `audit.path` is undefined.

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
