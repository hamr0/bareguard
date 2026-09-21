---
type: reference
title: Harness design — Part 2 frame
status: stable
sources: [docs/archive/bareguard-prd.md]
---

# Harness design — Part 2 frame

> **Companion within the PRD to Part 1** (the stable spec the harness *uses* and proposes to extend) and to [`harness-research.md`](harness-research.md) (Part II — the experiment this grew out of). Part 2 is **living**: it *reshapes* overlapping Part-1 primitives, so it is kept as its own part to stop a moving spec from tangling the stable one. **Governing rules:** `.claude/memory/AGENT_RULES.md` — POC-first, never ship the POC, dependency hierarchy, safe defaults. **No Part-1 primitive changes until the POC graduates** (§9); this part *proposes* the overlaps, it does not pre-commit them. Subject to Part 1 Appendix C (five yeses) and Appendix E (the feedback-drift gate) (bareguard-prd.md:1731-1743).

## 0. TL;DR

A talk on agent harnesses (and the a2a experiment) converged on one fact: **you cannot make a probabilistic agent deterministic.** Agents handwave; that's the substrate, not a bug (a2a §11). The harness's job is not to *correct* the agent — it's to **fence where the dice can do damage** (bareguard-prd.md:1746-1749).

The whole design reduces to two axes and one rule (bareguard-prd.md:1751-1760):
- **Axis A — gate the outgoing action by its shape** (≈ bareguard today). The *floor*: irreversible shapes → human; closed allowlist; cumulative limits.
- **Axis B — reconcile the return against a declared constraint** (the new part). A *detector*, never an enforcer: it annotates A's stop with independent facts.
- **Floor + harness.** The floor is the guard. A "harness" is *ergonomics on top* — capability scoping the agent picks at runtime, **tighten-only, never load-bearing for safety.** If the agent picks the wrong harness, the floor still holds.

This maps onto bareguard's existing thesis (Part 1 §6: "what the agent is allowed to *do*"). **Axis A is bareguard, sharpened. Axis B is the only genuinely new surface — and it is the a2a §12.4 deferred candidate, gated on a real user** (bareguard-prd.md:1762-1764).

> **Status pointer (reconciled 2026-06-09).** **Axis A is built and released** (bareguard 0.6.0 on npm); **Axis B is the one deferred new surface (= OQ1).** The intended first external user is `litectx` via the **Software Factory**, but the seam is **specced, not wired** (litectx has no bareguard dep yet) — §9.3 is authoritative and supersedes any "litectx actively consumes bareguard" wording. Nothing in bareguard `src/` builds ahead of proven need (bareguard-prd.md:1766-1772).

## 0.1 Where we are now (build/release state) — read this first

The PRD describes a design; most of it already ships (bareguard-prd.md:1778). Map of every surface to its real state (bareguard-prd.md:1780-1787):

| Surface | What it is | State |
|---|---|---|
| **Axis A** | gate the action by shape — the floor: `Gate` (deny/ask + closed allowlist), cumulative `Budget`, `audit`, `redact` | **BUILT & RELEASED — bareguard 0.6.0 (npm).** The harness POC (E1/E3/E4/E5, §9.2) proved these existing primitives *compose* into the harness pattern with `src/` untouched. |
| **Write-gate seam / `flags`** | structured field-value gate for a memory adopter's verdict (`provenance`/`injectionRisk`) — the litectx write-gate seam (§5B) | **BUILT & SEAM CLOSED (2026-06-13/14).** First `src/` change since the HOLD: the `flags` primitive (deny@2b / ask@4b, floor supremacy). `seam-contract.test.js` runs against litectx's real published emitter (`litectx@^0.13.0` devDependency). Additive/backward-compatible; HOLD at 0.5.x unaffected. |
| **Axis B** | reconcile the return vs a per-request declared constraint | **BUILT 2026-06-15, RELEASED in 0.7.0 — the only genuinely-new bareguard surface (§8).** #2 resolved = thin primitive `gate.annotate` (§8.2); routing §6.6; boundary §6.8. E2 proved the runner mechanic; E6 (§9.2.6) validated the return-time judge end-to-end under drift (decisive `honored`/`broke`, E6i 7/7). `gate.annotate` ships buffer + route + sinks in `src/` (11 tests, mutation-verified, suite 178); the judge stays caller-side, bareguard never runs an LLM. OQ1 (the operator set) freezes on the first real consumer; injection on a sub-haiku model is the one deferred pre-deploy gate. |
| **OQ3** | generalize `Budget`'s cumulative count to sends/rows/bytes + soft/hard tiers | **BUILT 2026-06-14, RELEASED in 0.7.0.** `budget.resources` cap-map (halt `budget.resource.<name>`, accrued from `result.counts`) + `budget.softRatio` non-blocking `budget_warn`; v2 file w/ v1 read-compat. Operator is the adopter. Part 1 §19 status → IMPLEMENTED. |
| **OQ4** | audit shape: log request + return together | **EXTENSION, demand-gated (§10). PROPOSED into Part 1 §19 (2026-06-09)** — gate/record lines share no per-action id; content-join goes ambiguous under repetition. |
| **SF-9** | destructive-action classifier for the Software Factory's Ship gate | **A Factory-driven Axis-A *config* (a `shape → ask` rule), not a new axis.** Built when the Factory needs it (§9.3.0). |

**So, plainly: Axis A is built and shipped; Axis B is what's missing.** Everything else is either an extension to Axis A (OQ3/OQ4) or a Factory config (SF-9) (bareguard-prd.md:1789-1791).

### 0.1.1 What is buildable WITHOUT litectx (the litectx-independent workstream)

litectx is not yet runnable, but bareguard is not blocked on it for everything. Ordered by discipline-fit (bareguard-prd.md:1795-1816):

1. **Gate-zero contract test — now closed against the REAL emitter** — ✅ **DONE (2026-06-09), SEAM CLOSED (2026-06-14):** `test/seam-contract.test.js` (10 tests, adversarially reviewed). Closed the §9.3.1 ⚠️ row: write **shape** gated zero-change; secret/injection **content** out by Part 1 §6 design; redact ≠ gate; plus the `flags` structured-field rows. Originally synthetic with a SWAP POINT — now repinned to litectx's published `toWriteAction` (`litectx@^0.13.0`); the standing seam regression test runs against the real producer every release.
2. **Axis B (OQ1) itself** — litectx-independent by nature (the Factory likely never exercises it, §9.3.0). To advance the *new surface* without waiting on litectx: needs (a) a real constraint-**authoring** use-case (need not be litectx) and (b) a contract format that fits Part 1 §6 + the ≤150-LOC budget (§8 tests 1/2/4). Pick a non-litectx driver, or it is a speculative build. *The E2 detect-and-feed-A mechanic ✅ **SHIPPED as cookbook sample 8 (2026-06-09)** — runner-layer, no OQ1 touched; the recipe is now the live demand sensor for the declaration format.*
3. **OQ3/OQ4 extensions** — ✅ **PROPOSED into Part 1 §19 (2026-06-09)** as future-feature candidates with the POC evidence attached. Proposing ≠ building: both stay demand-gated; implementation still waits on a real driver.
4. **The harness cookbook (§5.2)** — ✅ **DONE (2026-06-09):** [`docs/product/harness-cookbook.md`](../product/harness-cookbook.md).

With 1, 3, and 4 delivered, **the pre-litectx sanctioned backlog is empty** — what remains either waits on litectx (§9.3.4) or on its own demand trigger (Axis B / OQ1, item 2) (bareguard-prd.md:1817-1818).

## 0.2 Round update — 2026-06-14 (litectx 0.16.1): the deferrals reassessed

A design round (no `src/` change) walked the deferred surface against **litectx 0.16.1**. Five realizations, net: **0.16.1 unblocks no bareguard build; it removes two waits and reclassifies one demand-sensor** (bareguard-prd.md:1824-1826):

1. **`memory.inject` is dead by design, not "pending."** litectx mints `memory.write` ONLY; `writegate.js:14` states the inject type is reserved with **no producer** (SELECT was POC-killed upstream). Stop waiting on it.
2. **The Software Factory is gone — replaced by litectx-internal benches** (`litectx/docs/01-product/benches-prd.md`: Part A validation = `bench:recall/impact/memory/assemble/summary`, **DONE**; Part B factory app **PARKED**). Those benches are **CE-value gates that never route an action through a gate**, so they are **NOT** a vehicle for the §9.3.2 integration bench. That bench's purpose — guarding the write-gate seam — is already met by the standing `test/seam-contract.test.js`. §9.3.2 collapses to "already covered."
3. **SF-8 / SF-9 are moot** — their trigger (a running Factory) no longer exists.
4. **`recordUseful()` is still unbuilt** in litectx (R-W7), so the full `assemble→…→recordUseful` loop stays un-runnable — but per (2) that loop is no longer a bareguard deliverable.
5. **Axis B / OQ1: `assemble` is NOT a demand source.** It fits-to-budget and returns within budget (`{units,dropped,tokens}`) — no honest violation to reconcile. The §9.3.2-scenario-2 sensor is **retired**, replaced by the concrete `recall`/`impact` spec in §8.1 (design-only; still no real demand → still unbuilt) (bareguard-prd.md:1828-1844).

The only item that became genuinely *buildable* (not yet demanded) is **OQ3** (cumulative budget → write-count, now that litectx's emitter is published) — assessed in §10 OQ3 (bareguard-prd.md:1846-1847).

### Build-round decisions (2026-06-14) — what we AGREED, in order

Item-by-item walk of the deferred surface, with the user's call recorded (bareguard-prd.md:1851-1859):

| Item | Decision | Note |
|---|---|---|
| **Axis B / OQ1** | **Spec'd, stays DEFERRED** | concrete `recall`/`impact` spec written (§8.1); no consumer has asked — not in the build set. |
| **OQ3** (budget beyond money) | **AGREED — BUILD this round** | the demand gate is now MET: the *operator* is the adopter. User's rationale: *"user can set/monitor budget when overdone — memory writes, a 10k-row export might be uncalled-for; ways of auditing and setting limits for agents beyond money."* |
| **OQ4** (joinable audit line) | **AGREED — BUILD this round** | same operator-auditing motivation; pairs with OQ3 (show what was *requested* vs what *counted*). Additive; must not assume Axis B. |
| **OQ2** (match-validator) | **RESOLVED — no build** | E5 showed the deterministic floor does all the safety work; advisory layer unearned. Closed. |
| **SF-8 / SF-9** | **MOOT** | trigger (a running Factory) gone (§0.2 #3). |

**Build order:** OQ3 (additive `Budget` extension: named-resource cumulative counter + soft/`warn` tier) → OQ4 (per-action correlation id threading `check → record` on the audit line). Both additive, `Budget`/`audit` only, HOLD-at-0.5.x-safe. **Per AGENT_RULES:** floor-touching → POC the riskiest assumption + checkpoint the load-bearing design before code; prove-don't-assert; never ship the POC (bareguard-prd.md:1861-1864).

## 1. Why this exists

Part 1 §5 already argues the action-bounding case. The harness adds the piece the a2a experiment forced into focus (bareguard-prd.md:1870-1878):

- **F7** — in the shipping "agents-as-tools" pattern, intent loss is *invisible to the client*: a withheld/violating return reads as "no match." The orchestrator has no local signal it was drifted.
- **§11 (corrected thesis)** — the risk isn't the agent *lying*; a capable agent *curates*, staying honestly compliant on every stated box while the harm hides in what it omits. You can't verify your way out of that.
- **M1** — the most dangerous drift comes from the *trusted* party. A harness the agent writes for itself is M1 as architecture.

The harness is the structured answer: an externally-authored floor the agent can't re-author, plus a return-boundary detector that makes F7's invisible loss visible *at the human-approval moment* (bareguard-prd.md:1882-1884).

## 2. Locked design decisions (the spine)

(bareguard-prd.md:1888-1899)

| # | Decision | Status |
|---|---|---|
| D1 | **A/B split.** A = gate outgoing action by shape. B = reconcile return vs declared constraint. Different mechanisms, different triggers. | **LOCKED** |
| D2 | **Floor + harness.** Floor = the guard. Harness = ergonomics (capability scoping) on top; tighten-only; not load-bearing for safety. | **LOCKED** |
| D3 | **Constitution = the floor** = a flat list of `action-shape → deny \| ask`, standing + user-authored. Axis-B constraints ride in *per-request*, not in the floor. | **LOCKED** |
| D4 | **Refusal = structured in-band error**, same envelope as a normal return, doubles as agent feedback. `deny` → agent + audit (no live human). `ask` → live human; agent gets the error only on refusal. | **LOCKED** |
| D5 | **Two-tier floor.** Aggregate/closed (cumulative limits + closed allowlist) = the real wall. Per-action regex = HITL *trigger* only (decomposable → never a security boundary alone). Quantitative things go cumulative. | **LOCKED** |
| D6 | **Closed allowlist:** deny-by-default, tuneable-to-loosen (never the reverse), fail-closed, safe defaults. | **LOCKED** |
| D7 | **Axis B = detect-and-feed-A, never blocks alone.** Annotates A's stop with independent facts; B changes *what the human sees*, not *whether* you stop. Routing (§6.6, decisive 2026-06-15): the judge returns a decisive verdict (`honored`/`broke`), NOT a confidence scale (E6g showed the confidence framing hedges clean cases — a compliant €280 drew `unsure` and surfaced) and NOT violation/deviation (E6e showed `kind` unreliable). bareguard routes surface-vs-pass × reversibility: irreversible → the floor's HITL (B annotates); reversible → the escalation knob (strict default = surface anything not `honored`). B never auto-rejects; the LLM is caller-side only (§6.7). See [`axis-b.md`](axis-b.md) for the full spec. | **LOCKED** |
| D8 | **Harness selection** is the agent's *proposal*, made at runtime, always (no ungoverned path). A probabilistic match-validator may *advise*; it is never the floor. | **PoC-VALIDATED (E5)** — mechanism shown; the *advisory* layer earns nothing yet (OQ2). Lives in the runner, not bareguard. |

## 3. Core architecture: the two axes

```
                 ┌──────────────── floor (constitution, user-authored) ──────────────┐
request ──▶ agent picks harness (tighten-only) ──▶ writes code over the menu          │
   │                                                     │                            │
   │            ┌───────────── AXIS A (gate the action going OUT) ───────────────┐    │
   │            │  shape rule:  reversible → run   |   irreversible → HITL        │    │
   └─ constraint│  closed allowlist (deny-by-default) + cumulative limits         │    │
      (per-req) │  refusal = structured in-band error (deny→agent | ask→human)    │    │
                └──────────────────────────────────┬─────────────────────────────┘    │
                                                    ▼                                  │
                              action leaves; result comes back                        │
                                                    │                                  │
                ┌───────────── AXIS B (reconcile the return) ──────────┐              │
                │  compare returned value vs the per-request constraint │              │
                │  violation → annotate (feeds the NEXT A-stop)         │──────────────┘
                │  detect only — NEVER blocks on its own               │
                └──────────────────────────────────────────────────────┘
```
(bareguard-prd.md:1905-1922)

**Mapping to Part 1 §6.** The Part 1 §6 test ("constrain an action against the world, not words the model produces") is satisfied by Axis A natively. Axis B is the strain (see [`axis-b.md`](axis-b.md)): it compares a *returned value*, which edges toward "content." It stays on the right side of Part 1 §6 **only because it never shapes output and never blocks — it produces a fact that an Axis-A action decision consumes.** A B that started denying on its own would become a second, weaker enforcement path and a content-judge — exactly what Part 1 §6 forbids (bareguard-prd.md:1924-1930).

## 4. The floor (constitution) — LOCKED

A flat list of `action-shape → deny | ask` rules. Standing, global, **user-authored (never agent-authored — D3, M1)**. The agent's two worked examples define the shape (bareguard-prd.md:1936-1940):

- `sendEmail → ask` (gate the outgoing email action)
- `spend > 300 → ask` (gate the outgoing spend action above a threshold)

### 4.1 Two tiers (D5) — be honest about which one actually holds

(bareguard-prd.md:1944-1957)

| Tier | Mechanism | Routability | Role |
|---|---|---|---|
| **1 — aggregate/closed** | cumulative limits (running total across the run) + closed allowlist | **cannot** be routed around | the real wall |
| **2 — per-action shape** | regex over `JSON.stringify(action)` | decomposable (€400 → €200+€200) / reshapeable | HITL *trigger* only |

> A per-action rule is fine for "this *looks* like it needs a human, ask." It is **not** a security boundary by itself. Anything quantitative (spend, sends, data volume) MUST live in tier 1 (cumulative). Anything dangerous MUST be a closed allowlist entry (the capability simply isn't reachable).

**Ceiling (M3/M4):** a deterministic floor catches the shapes you anticipated; a creative agent finds the one you didn't. The floor *raises the cost* of evasion and closes the obvious vectors — it is not complete. The backstops for the unanticipated are tier 1 + the audit trail, **not** more tier-2 regexes.

### 4.2 Safe defaults (D6)

(bareguard-prd.md:1959-1964)
- Closed allowlist = **deny-by-default**; absence of config is the *safe* state.
- Tuneable params **loosen from a closed baseline** — every tune (add a tool, raise a cap) is an explicit, visible, auditable step toward permissive.
- **Fail-closed** — misconfig / missing param errs toward *blocked* (same stance as bareguard 0.4.5 shell-meta).

## 5. The harness — ergonomics, not a guard — D2 (LOCKED), D8 (PROPOSED)

A "harness" = a named preset of **{ tool menu + extra restrictions }** for a situation. It does two ergonomic things and **no safety thing** (bareguard-prd.md:1970-1973):
1. **Tool menu** — which capabilities are in scope for this task.
2. **Extra restrictions** layered on the floor.

**Invariant: a harness can only TIGHTEN.** Smaller menu, more asks — never below the floor. ⇒ *if the agent picks the wrong harness, nothing unsafe happens* — the floor catches the irreversible action regardless. **The harness pick is not load-bearing for safety.** This is what keeps agent self-selection safe despite M1: selecting a *tighter* environment is harmless; the floor is the part the agent can't author (bareguard-prd.md:1975-1979).

### 5.1 Selection (D8 · PROPOSED)

(bareguard-prd.md:1981-1989)
- The agent picks a harness **at runtime, always** (default = most-permissive reversible, so there's never an unwrapped path). Same gesture as code mode picking *tools* from a list — the design north star is **tools-as-a-list → harnesses-as-a-list.**
- The pick is a **proposal**. An optional **match-validator** ("this fits / doesn't") may *advise* the agent — and it **may be probabilistic**, because it's advisory. The **floor stays deterministic** (a2a §11: you can't verify your way out of a probabilistic agent, so the binding layer must not depend on one).

### 5.2 Library of harnesses (cookbook SHIPPED as recipe; agent-authored library still never)

(bareguard-prd.md:1992-2008)
- ✅ A **cookbook** of operator-vetted capability bundles (tools + gate config), e.g. `read-only-research`, `book-with-approval`, `send-comms-HITL`, plus a "roll-your-own" skeleton. This is the Appendix-E **(b)-tier (recipe)** — encouraged. **SHIPPED (2026-06-09): [`docs/product/harness-cookbook.md`](../product/harness-cookbook.md)** — the E5-validated floor+catalog+resolver pattern, **8 samples**: research / book-with-approval / comms-HITL / contract-tested `memory-adopter` / `code-mode-sandbox` (E1+E4) / `repo-maintainer` (the SF-9 ship-gate as a recipe) / `delegation` (spawn/defer containment) / **`detect-and-feed-A` (Axis B as a recipe — the OQ1 demand sensor)** — plus the roll-your-own skeleton and the note that off-catalog refusal is a resolver concern, not a scope trick (the resolver refuses to BUILD a gate, which is louder than one denying every action in turn). The empty-allowlist foot-gun this bullet originally cited is gone — `[]` fails CLOSED as of the v0.14 empty-allowlist fix. **All samples verified by execution** against the shipped `Gate` (2026-06-09: E4 re-run + 9 assertions — rules fire exactly as documented; the Axis-B fact reaches the human event verbatim).
- ❌ A library of **agent-authored harnesses promoted to reusable** without a vetting step. That's M1 with extra steps — a fence no operator vetted. Never.

## 7. Mapping onto existing bareguard primitives

The point of the separate doc: most of the spine **already exists** in bareguard; the harness *reshapes overlaps* rather than inventing wholesale (bareguard-prd.md:2309-2310).

(bareguard-prd.md:2312-2322)

| Spine piece | bareguard today | Verdict |
|---|---|---|
| Floor: irreversible → ask | `content.askPatterns` (Part 1 §8 #12) + `approval`/`humanChannel` (Part 1 §8 #6) | **reuse** |
| Floor: **command severity tiering** (multis) | `content.askPatterns` exists but single-axis (ask/no-ask), sparse, SQL-heavy, Linux-thin | **reuse + extend** → §7.1 (`bash.classify`: tier the ask floor with a full cross-platform list, best-effort) |
| Floor: closed allowlist, deny-by-default | `tools.allowlist` (scope-only, Part 1 §9.2) | **reuse** |
| Floor: cumulative limits | `budget` (Part 1 §8 #2, cumulative + shared-file) + `limits` (Part 1 §8 #5) | **reuse / extend** (generalize "cumulative spend" to other countable resources) |
| Floor: deny/ask refusal as structured error | `gate.run()` returns `{error:{type:"policy_denied",…}}` | **reuse** |
| Floor: fail-closed safe defaults | Part 1 §11 + 0.4.5 stance | **reuse** |
| Audit of ask-vs-return | `audit` JSONL (Part 1 §8 #9) | **reuse / extend** (log request + return so reconcile is reconstructable — a2a §12.2) |
| Harness selection + code-mode execution | — (runner concern) | **NOT bareguard** → harness/runner layer (bareagent `Loop`); bareguard stays the chokepoint it calls |
| **Axis B: return reconciliation** | — (a2a **§12.4 DEFERRED**) | **NEW SURFACE** — see [`axis-b.md`](axis-b.md) |

**Where it lives:** selection + code-mode execution belong to the **runner** (bareagent), which *uses* bareguard. bareguard never runs code — it decides. The only net-new bareguard *surface* this PRD introduces is Axis-B reconciliation (see [`axis-b.md`](axis-b.md)); the `bash.classify` severity tiering (§7.1) is an **extension of the existing ask floor**, not a new surface (bareguard-prd.md:2324-2328).

### 7.1 Command severity classification — `bash.classify` (multis-driven, settled 2026-06-17)

**Problem (multis).** Every shell-capable consumer hand-rolls a danger list (`rm -rf /`, `dd`-to-device, `mkfs`, fork bomb, `shutdown`, …) and inevitably gets macOS/Windows coverage wrong. Today's `SAFE_DEFAULT_ASK/DENY_PATTERNS` are sparse, SQL-heavy, **single-axis** (ask *or* deny), and Linux-thin. Drift across consumers is guaranteed — the opposite of "governance = bareguard" (bareguard-prd.md:2334-2338).

**Decision.** bareguard owns the **classification mechanism** + a **full cross-platform tiered pattern list**, shipped **in-lib**, framed **best-effort** (not "authoritative"). The consumer owns the ceremony. This *extends the existing irreversible→ask floor* (table row 1) with a severity axis; it is not a new auth surface (bareguard-prd.md:2340-2343).

Two axes were teased apart at sign-off — **coverage** (skimpy ↔ full) and **framing** (best-effort ↔ authoritative). The chosen cell is **full + best-effort** (bareguard-prd.md:2345-2365):
- **Coverage = full.** A thin seed leaves every consumer extending differently → no drift reduction; a shared *full* list is the only thing that kills drift. A regex table is **data, not logic** — Appendix-C #4 bounds *behavioral* complexity, and Part 1 §11 already ships `SAFE_DEFAULT_*` in-lib, so a bigger table is an extension of what bareguard already does, not a new category.
- **Framing = best-effort.** "Authoritative" buys **zero** extra drift reduction and costs two things: (a) **false confidence** — an authoritative label suppresses the consumer's review reflex, so the guaranteed miss (`base64 -d | sh`, a renamed binary, a novel subcommand) lands as a breach *with bareguard's label on it*; and (b) an **SLA bareguard can't staff** — the OS surface is unbounded and moving. Ship the full list, decline the word (~95% of the ask; only the word is declined).
- **In-lib, not a separate data package.** A package boundary only earns itself with a *different maintainer or cadence*. Same maintainer + same cadence + **coupled tier semantics** ⇒ one auditable home alongside `SAFE_DEFAULT_*`.

**Mechanism (no auth in the lib).** With `bash.classify` on, the Gate classifies each `bash` action at the **ask step** (step 4, beside `content.askPatterns`). Tiers 2–3 raise the *existing* askHuman event with the tier attached — **`event.classification: 'destructive' | 'super_destructive'`** and **`event.tier: 2 | 3`**, with `event.action`/`_ctx` intact. bareguard never bakes in PIN/CONFIRM/2FA and never hard-denies tiers 2–3; the `humanChannel` reads the tier, applies its ceremony, and returns allow/deny. A consumer wanting "never" auto-denies that tier in its own channel (bareguard-prd.md:2367-2372).

> **Naming note (load-bearing).** The event's existing `severity` field is the internal `halt | action` control axis — branched on throughout `gate.js`. The consumer-facing tier rides a **new** `classification`/`tier` field; it does **not** overload `severity` (bareguard-prd.md:2374-2377).

**API shape** (bareguard-prd.md:2379-2386):
- `classifyCommand(command, { platform }) → 'safe' | 'destructive' | 'super_destructive'` — pure, exported, unit-testable. `platform` is a hint; auto-detect via `process.platform` when omitted.
- `bash: { classify: true, extraDestructive?, extraSuperDestructive?, reclassify? }` — the consumer *tunes*, never reimplements. `reclassify(command, tier) → tier` handles app-specific overrides.
- Exported per-tier-per-platform pattern sets (`DESTRUCTIVE_PATTERNS`, `SUPER_DESTRUCTIVE_PATTERNS`, keyed by platform) **supersede** — but do not remove — the single-axis `SAFE_DEFAULT_*` (kept for back-compat).

**Honest scope (in-contract consumption).** Best-effort pattern matching, defense-in-depth — **defeatable by obfuscation; NOT a sandbox.** The classification is **UX tiering, not enforcement** (same status as injection-detection being log-only): the fs/exec scope stays the hard boundary, and `event.tier` is never treated as a security guarantee (bareguard-prd.md:2388-2391).

**Appendix-C self-assessment** (bareguard-prd.md:2393-2401):

| Appendix C test | `bash.classify` | Note |
|---|---|---|
| 1. Constrains action against the world? | **yes** | bash commands; tiers the irreversible→ask floor |
| 2. Rule over action *shape*? | **yes** | regex over the command string — same shape as `content` / `bash.denyPatterns` |
| 3. Works without network/infra/server? | **yes** | pure local match |
| 4. ≤150 LOC + one dep? | **yes** | the *mechanism* is ~60–80 LOC; the pattern list is **data**, not logic |
| 5. Opt-in, safe default? | **yes** | off unless `bash.classify` is set; ships a safe default list when on |

**Acceptance.** With `bash.classify` on: `rm -rf /` (Linux), `dd of=/dev/sda`, macOS `diskutil eraseDisk`, Windows `format C:` → tier-3 askHuman event with `classification:'super_destructive'`, `tier:3`, `_ctx` intact; `rm file.txt`, `sudo apt update` → tier-2; `ls`, `git status` → no event. The `humanChannel` decides allow/deny; bareguard holds **zero** auth logic; a consumer reclassifies without forking (bareguard-prd.md:2403-2407).

**Status: SHIPPED 0.8.0** (2026-06-17; Part 1 §19 "0.8" milestone) — `src/primitives/classify.js` (`classifyCommand` + the cross-platform corpus + `bashClassifyCheck`), wired at gate step 4, `classification`/`tier` on the event, exports + types, `test/classify.test.js` (+16, suite → 196, typecheck clean). This section remains the spec of record (bareguard-prd.md:2409-2412).

## 11. What this does NOT solve (bounds, stated up front)

(bareguard-prd.md:3009-3017)
- **In-spec lies** (F8) — needs an independent oracle (payment pre-auth); not B's job.
- **Omissions / curation** (§11) — invisible to any constraint-checker; countered only by pre-existing diversity (independent research, multiple agents, a human asked "what's *not* here?"), not by this harness.
- **Making a probabilistic agent deterministic** — out of scope by thesis. The harness bounds blast radius; it does not remove variance.
- **Completeness of the floor** (M3/M4) — it raises evasion cost; it is not a proof.
- **Context economy** (pollution, staleness, memory hygiene) — a *different axis*; a future `barecontext` concern (§10.1), not the floor's job.

## 12. Relationships

(bareguard-prd.md:3023-3033)
- **Part 1** — the stable spec the harness *uses* and proposes to extend (§7). Subject to its Appendix C + E. No change to it until POC graduation (§9.2).
- **[`harness-research.md`](harness-research.md)** (Part II — A2A experiment) — produced F7, F8, §11, M1, §12.4 — the evidentiary base for every "ceiling" claim here. Part I (problem space) frames the #1–#4 layering; Part III (identity) the actor/action boundary.
- **`harness-code-mode/`** — the seam PoC (§9.1) and home for E1–E4.
- **`litectx`** (`~/PycharmProjects/litectx`) — the intended first real external consumer (§9.3); its CE-PRD §10 specs the bareguard seam. Wired via the Software Factory, not directly.
- **`software-factory-prd.md`** (in litectx's repo) — litectx's first adopter and the *system-level proving bench* (§9.3.0); §9.3.2 is its bareguard-coverage slice. It surfaces the demand-gated bareguard extensions (OQ1, OQ3, SF-9 ship-gate classifier).

### Status: spine validated & shipped (waits on nothing); only un-agreed deltas wait — and not all on the Factory

The spine is LOCKED (§2) and the synthetic POC is COMPLETE — **all five gates E1–E5 DONE** (§9.2): E1 generated-body gate holds (L1+L2); E2 Axis-B detect-and-feed-A; E3 D5 (regex=trigger, cumulative `budget`=wall); E4 hardened sandbox (closes C1); E5 D8 selection (tighten-only; validator earned nothing — OQ2). Every gate is runner-layer; **`src/` untouched, no bareguard primitive changed** (bareguard-prd.md:3036-3040).

**What changed (2026-06-04):** `litectx` is the first **real external user** the deferrals were waiting for (§9.3). The coverage verdict: the bareguard **spine covers litectx with zero change** (floor, audit, redact, compose, Part 1 §6 exclusion); the **`memory.write` gating claim is now PROVEN against litectx's real published emitter** (seam closed 2026-06-14, `litectx@^0.13.0`), so the only item remaining is the **budget cost-gate** (OQ3, now decided **hard-cap-first / extend-not-rebuild**) (bareguard-prd.md:3042-3047).

**What's next (reconciled 2026-06-09).** Net: Axis A is built & released (0.6.0); the seam contract test is **done and CLOSED against litectx's real published emitter** (`test/seam-contract.test.js` vs `litectx@^0.13.0`, 10 tests, suite green) — it proves write *shape* is gated with zero change and that secret/injection *content* is out by Part 1 §6 design. Only the Factory's own needs (SF-8/SF-9) sit on the build order; OQ1/OQ3 are demand-gated off the Factory's path. No `src/` change, no build-ahead; build + integrate + validate are one motion. POC is never shipped (AGENT_RULES) (bareguard-prd.md:3049-3057).
