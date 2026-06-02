# Harness — Product Requirements Document (PRD, living)

> Companion to [`bareguard-prd.md`](bareguard-prd.md) (the stable spec) and
> [`../00-context/a2a-intent-drift-prd.md`](../00-context/a2a-intent-drift-prd.md)
> (the experiment this grew out of). **Separate doc on purpose:** the harness is a
> big job that will *reshape* overlapping bareguard primitives. Keeping it apart
> stops a moving spec from tangling a stable one.
>
> **Governing rules:** follows `.claude/memory/AGENT_RULES.md` — POC-first, never
> ship the POC, dependency hierarchy, safe defaults. **No bareguard primitive
> changes until the POC graduates** (§9). This doc *proposes* the overlaps; it does
> not pre-commit them. Subject to `bareguard-prd.md` Appendix C (five yeses) and
> Appendix E (the feedback-drift gate).
>
> Status legend: **LOCKED** (settled in design), **PROPOSED** (stated, not
> settled), **OPEN** (unresolved), **DEFERRED** (gated on a real external signal).

---

## 0. TL;DR

A talk on agent harnesses (and our own a2a experiment) converged on one fact:
**you cannot make a probabilistic agent deterministic.** Agents handwave; that's
the substrate, not a bug (a2a §11). So the harness's job is not to *correct* the
agent — it's to **fence where the dice can do damage**.

The whole design reduces to two axes and one rule:

- **Axis A — gate the outgoing action by its shape** (≈ bareguard today). The
  *floor*: irreversible shapes → human; closed allowlist; cumulative limits.
- **Axis B — reconcile the return against a declared constraint** (the new part).
  A *detector*, never an enforcer: it annotates A's stop with independent facts.
- **Floor + harness.** The floor is the guard. A "harness" is *ergonomics on top* —
  capability scoping the agent picks at runtime, **tighten-only, never
  load-bearing for safety.** If the agent picks the wrong harness, the floor still
  holds.

This maps cleanly onto bareguard's existing thesis (§6: "what the agent is allowed
to *do*"). **Axis A is bareguard, sharpened. Axis B is the only genuinely new
surface — and it is the a2a §12.4 deferred candidate, gated on a real user.**

---

## 1. Why this exists

`bareguard-prd.md` §5 already argues the action-bounding case. The harness adds the
piece the a2a experiment forced into focus:

- **F7** — in the shipping "agents-as-tools" pattern, intent loss is *invisible to
  the client*: a withheld/violating return reads as "no match." The orchestrator
  has no local signal it was drifted.
- **§11 (corrected thesis)** — the risk isn't the agent *lying*; a capable agent
  *curates*, staying honestly compliant on every stated box while the harm hides in
  what it omits. You can't verify your way out of that.
- **M1** — the most dangerous drift comes from the *trusted* party. A harness the
  agent writes for itself is M1 as architecture.

The harness is the structured answer: an externally-authored floor the agent can't
re-author, plus a return-boundary detector that makes F7's invisible loss visible
*at the human-approval moment*.

---

## 2. Locked design decisions (the spine)

| # | Decision | Status |
|---|---|---|
| D1 | **A/B split.** A = gate outgoing action by shape. B = reconcile return vs declared constraint. Different mechanisms, different triggers. | **LOCKED** |
| D2 | **Floor + harness.** Floor = the guard. Harness = ergonomics (capability scoping) on top; tighten-only; not load-bearing for safety. | **LOCKED** |
| D3 | **Constitution = the floor** = a flat list of `action-shape → deny \| ask`, standing + user-authored. Axis-B constraints ride in *per-request*, not in the floor. | **LOCKED** |
| D4 | **Refusal = structured in-band error**, same envelope as a normal return, doubles as agent feedback. `deny` → agent + audit (no live human). `ask` → live human; agent gets the error only on refusal. | **LOCKED** |
| D5 | **Two-tier floor.** Aggregate/closed (cumulative limits + closed allowlist) = the real wall. Per-action regex = HITL *trigger* only (decomposable → never a security boundary alone). Quantitative things go cumulative. | **LOCKED** |
| D6 | **Closed allowlist:** deny-by-default, tuneable-to-loosen (never the reverse), fail-closed, safe defaults. | **LOCKED** |
| D7 | **Axis B = detect-and-feed-A, never blocks alone.** Annotates A's stop with independent facts; B changes *what the human sees*, not *whether* you stop. Reversible-path violation → feedback + audit (B always surfaces; only A halts). | **LOCKED** |
| D8 | **Harness selection** is the agent's *proposal*, made at runtime, always (no ungoverned path). A probabilistic match-validator may *advise*; it is never the floor. | **PoC-VALIDATED (E5)** — mechanism shown; the *advisory* layer earns nothing yet (OQ2). Lives in the runner, not bareguard. |

---

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

**Mapping to `bareguard-prd.md` §6.** The §6 test ("constrain an action against the
world, not words the model produces") is satisfied by Axis A natively. Axis B is the
strain (§8 below): it compares a *returned value*, which edges toward "content." It
stays on the right side of §6 **only because it never shapes output and never blocks
— it produces a fact that an Axis-A action decision consumes.** A B that started
denying on its own would become a second, weaker enforcement path and a content-judge
— exactly what §6 forbids.

---

## 4. The floor (constitution) — LOCKED

A flat list of `action-shape → deny | ask` rules. Standing, global, **user-authored
(never agent-authored — D3, M1)**. The agent's two worked examples define the shape:

- `sendEmail → ask` (gate the outgoing email action)
- `spend > 300 → ask` (gate the outgoing spend action above a threshold)

### 4.1 Two tiers (D5) — be honest about which one actually holds

| Tier | Mechanism | Routability | Role |
|---|---|---|---|
| **1 — aggregate/closed** | cumulative limits (running total across the run) + closed allowlist | **cannot** be routed around | the real wall |
| **2 — per-action shape** | regex over `JSON.stringify(action)` | decomposable (€400 → €200+€200) / reshapeable | HITL *trigger* only |

> A per-action rule is fine for "this *looks* like it needs a human, ask." It is
> **not** a security boundary by itself. Anything quantitative (spend, sends, data
> volume) MUST live in tier 1 (cumulative). Anything dangerous MUST be a closed
> allowlist entry (the capability simply isn't reachable).

**Ceiling (M3/M4):** a deterministic floor catches the shapes you anticipated; a
creative agent finds the one you didn't. The floor *raises the cost* of evasion and
closes the obvious vectors — it is not complete. The backstops for the unanticipated
are tier 1 + the audit trail, **not** more tier-2 regexes.

### 4.2 Safe defaults (D6)
- Closed allowlist = **deny-by-default**; absence of config is the *safe* state.
- Tuneable params **loosen from a closed baseline** — every tune (add a tool, raise
  a cap) is an explicit, visible, auditable step toward permissive.
- **Fail-closed** — misconfig / missing param errs toward *blocked* (same stance as
  bareguard 0.4.5 shell-meta).

---

## 5. The harness — ergonomics, not a guard — D2 (LOCKED), D8 (PROPOSED)

A "harness" = a named preset of **{ tool menu + extra restrictions }** for a
situation. It does two ergonomic things and **no safety thing**:
1. **Tool menu** — which capabilities are in scope for this task.
2. **Extra restrictions** layered on the floor.

**Invariant: a harness can only TIGHTEN.** Smaller menu, more asks — never below the
floor. ⇒ *if the agent picks the wrong harness, nothing unsafe happens* — the floor
catches the irreversible action regardless. **The harness pick is not load-bearing
for safety.** This is what keeps agent self-selection safe despite M1: selecting a
*tighter* environment is harmless; the floor is the part the agent can't author.

### 5.1 Selection (D8 · PROPOSED)
- The agent picks a harness **at runtime, always** (default = most-permissive
  reversible, so there's never an unwrapped path). Same gesture as code mode picking
  *tools* from a list — the design north star is **tools-as-a-list → harnesses-as-a-
  list.**
- The pick is a **proposal**. An optional **match-validator** ("this fits / doesn't")
  may *advise* the agent — and it **may be probabilistic**, because it's advisory.
  The **floor stays deterministic** (a2a §11: you can't verify your way out of a
  probabilistic agent, so the binding layer must not depend on one).

### 5.2 Library of harnesses (DEFERRED — only the safe shape)
- ✅ A **cookbook** of operator-vetted capability bundles (tools + gate config),
  e.g. `read-only-research`, `book-with-approval`, `send-comms-HITL`, plus a
  "roll-your-own" skeleton. This is the Appendix-E **(b)-tier (recipe)** — encouraged.
- ❌ A library of **agent-authored harnesses promoted to reusable** without a vetting
  step. That's M1 with extra steps — a fence no operator vetted. Never.

---

## 6. Axis B — return reconciliation — D7 (LOCKED)

### 6.1 What it does
On a return, compare the **returned value** against the **per-request constraint**
(e.g. chosen flight €400 vs stated €300). On violation, **annotate** — never act.

### 6.2 Detect-and-feed-A (the whole model)
B runs *after* the trip; the request already left, so there's nothing for B to
prevent. The only thing left to stop is the *next action* (booking the €400) — which
is already an Axis-A action. So:

> **B never changes *whether* you stop — A's shape rules decide that. B changes
> *what the human sees* when A stops.**

- Agent says: "found you a great flight, booking it."
- B annotates: "note — €400, exceeds your stated €300."
- A's HITL prompt now carries B's *independent fact*, not the agent's spin.

This is `bareguard-prd.md` §12.1's design note made literal — *show the human
independent facts, not the agent's claim* — and it is the concrete cure for F7
(invisible loss → visible on the approval screen).

### 6.3 The reversible-path edge (D7)
If a B-violation sits on a path where **nothing irreversible happens** (e.g. reading
drifted data), there is no A-stop to ride into. B's finding then goes to two sinks:
1. **agent feedback** (in-band) → agent re-plans, and
2. **audit trail** → reconstructable later.

No forced human interrupt (reversible = undoable = low-stakes; interrupting on every
reversible drift is noise and violates D2's "reversible → HITL optional"). **B always
surfaces; only A halts.** B has *no enforcement logic of its own* — one detector,
facts to two sinks, riding into A when an A-stop already exists.

### 6.4 Hard ceiling — do NOT overclaim (bounds the whole PRD)
B checks the **returned value** against a **stated** constraint. Therefore it
**cannot**:
- catch an **in-spec lie** (claims €199, books €450 — a2a **F8**); the liar reports a
  compliant number. Needs an *independent oracle* (payment pre-auth) — out of scope.
- catch an **omission** (hides the better option you didn't think to constrain — a2a
  **§11**). You can't reconcile against listings you don't know exist.

> Scope B as **"reconciles honest violations of stated constraints — NOT lies, NOT
> omissions."** Calling it "validate everything that comes back" would be F7
> repackaged (§12.3 already killed the "drift meter" for the same reason).

---

## 7. Mapping onto existing bareguard primitives

The point of the separate doc: most of the spine **already exists** in bareguard;
the harness *reshapes overlaps* rather than inventing wholesale.

| Spine piece | bareguard today | Verdict |
|---|---|---|
| Floor: irreversible → ask | `content.askPatterns` (§8 #12) + `approval`/`humanChannel` (#6) | **reuse** |
| Floor: closed allowlist, deny-by-default | `tools.allowlist` (scope-only, §9.2) | **reuse** |
| Floor: cumulative limits | `budget` (#2, cumulative + shared-file) + `limits` (#5) | **reuse / extend** (generalize "cumulative spend" to other countable resources) |
| Floor: deny/ask refusal as structured error | `gate.run()` returns `{error:{type:"policy_denied",…}}` | **reuse** |
| Floor: fail-closed safe defaults | §11 + 0.4.5 stance | **reuse** |
| Audit of ask-vs-return | `audit` JSONL (#9) | **reuse / extend** (log request + return so reconcile is reconstructable — a2a §12.2) |
| Harness selection + code-mode execution | — (runner concern) | **NOT bareguard** → harness/runner layer (bareagent `Loop`); bareguard stays the chokepoint it calls |
| **Axis B: return reconciliation** | — (a2a **§12.4 DEFERRED**) | **NEW SURFACE** → §8 |

**Where it lives:** selection + code-mode execution belong to the **runner**
(bareagent), which *uses* bareguard. bareguard never runs code — it decides. The only
net-new bareguard surface this PRD introduces is Axis-B reconciliation.

---

## 8. The new surface: Axis-B constraint reconciliation — DEFERRED

This is the a2a §12.4 candidate ("satisfaction contract"). Appendix-C self-assessment,
honestly:

| Appendix C test | Axis B | Note |
|---|---|---|
| 1. Constrains action against the world? | **borderline** | It detects on a return and *feeds* A; it doesn't act. Defensible only as "produces a fact A consumes." |
| 2. Rule over action *shape*, not content semantics? | **strain** | `price ≤ 300` is a value comparison over the return — the edge of §6. Needs a declared-constraint contract to stay shape-like. |
| 3. Works without network/infra/server? | **yes** | pure local comparison |
| 4. ≤150 LOC + one dep? | **at risk** | the *check* is tiny; a constraint **contract format/DSL** could blow the budget |
| 5. Opt-in, safe default? | **yes** | no declared constraint → no check |

**Conclusion:** Axis B does NOT clear the bar today (tests 1, 2, 4 strain). Per
Appendix E and the a2a close ("next signal comes from a person who isn't us"), it
**stays DEFERRED** until: (a) a real external user needs it, AND (b) we can express
the constraint contract within the §6 thesis and the LOC budget. Until then this PRD
*specifies* it; it does not build it.

**Open sub-question (blocks any build):** who authors the per-request constraint? The
*request/user* — never the agent checking itself (that's M1 again). The contract
format must make user-authored constraints the only input B reconciles against.

---

## 9. POC plan & what's already validated (AGENT_RULES: POC-first)

### 9.1 Already built — `harness-code-mode/` (the seam PoC)
Validates the *plumbing*: an agent-written code body in a sandbox, every tool call
routed through `gate.run()`, against an operator-authored gate. Demonstrated L1 ask
(→ humanChannel), L2 deny (off-allowlist), L3 confinement (`fetch` absent).

**Honest accounting (what the *seam* alone did NOT prove, and where each gap was
since closed):** one party wrote the agent body, the gate, *and* the deny — M5.
Taken alone it is a **plumbing smoke test of existing primitives**. The follow-on
gates close the gaps: real LLM generation → **E1**; `node:vm` is not a hardened
sandbox → **E4**; harness *selection* (D8) → **E5**; Axis-B reconciliation (§8) →
**E2** (mechanic only; the `src/` surface stays DEFERRED). All gates E1–E5 are now
**DONE** (§9.2); the full locked spine D1–D8 is exercised.

### 9.2 POC graduation gates (before ANY primitive change)
1. **E1 · real generation** — **DONE** (`harness-code-mode/run-e1.mjs`). A real LLM
   (via bareagent's `CLIPipe` → the `claude` CLI) emits the body from the typed menu;
   the *generated* body runs through the unchanged seam gate, and instrumented tools
   prove the gate *held* (no irreversible/off-menu action actually executed), not just
   that it looked blocked. Results: (a) **L1 confirmed** — a cooperative generated body
   books → gate intercepts `bookFlight` (passed back, never executed). (b) **L2
   confirmed** — a *benign-drift* generated body (told to also book a hotel / add
   insurance / check weather) reached for three plausible-but-unlisted tools via
   `tools.call`; the closed allowlist **denied all three** (deny, no human needed) —
   drift as *helpfulness reaching past the fence*, not malice (a2a §11), made literal.
   **Three findings worth keeping:** (i) when asked to emit *malicious/bypass* code the
   model **refused** — its own alignment is a soft, non-deterministic pre-filter, NOT
   the gate's guarantee, so the deterministic L2/L3 proof rightly stays in the
   hand-written seam PoC (model-independent); (ii) in true code-mode L2 and L3
   collapse — off-menu capability isn't in scope; (iii) **re-running E1 emits a
   *different body* each time (the agent authoring the probabilistic harness *body* —
   D2/M1 split made literal), while the fences stay byte-identical.** This validates
   "agent writes the body, operator owns the chokepoint" — it does **NOT** validate
   **D8 (harness *selection*)**: the capability menu + gate config were operator-fixed,
   not agent-proposed. *D8 is exercised separately by E5 (§9.2.5).*
   *Caveat C2 (hand-written body) closed; C1 closed by E4.*
2. **E2 · Axis-B reconcile, end-to-end** — **DONE** (`harness-code-mode/run-e2.mjs`).
   The €300→€410 drift trace (§6.2) runs for real: same Axis-A stop in both runs,
   B annotates A's HITL with an independent fact drawn from the tool *return* (not
   the agent's spin) → violation DENIED, clean APPROVED. Proves the **detect-and-
   feed-A mechanic** (D7) and cures F7. **Scope honesty:** uses one inline constraint
   shape, *not* OQ1's contract format/DSL (which is what strains §8 tests 1/2/4);
   catches an honest over-cap only — not F8 lies, not §11 omissions (§6.4); lives in
   the runner layer, `src/` untouched. *First test exercising the new surface.*
3. **E3 · decomposition attack** — **DONE** (`harness-code-mode/run-e3.mjs`). Three
   traces against the operator intent "no >€300 of charges without a human": (T1) the
   un-decomposed €400 trips the per-action regex (ask) — the trigger works on the
   obvious shape; (T2) €200+€200 walks straight past the regex — €400 charged, human
   never asked, *the trigger bounds nothing*; (T3) the same split under
   `budget.maxCostUsd=300` **halts** (the 3rd charge denied, `budget.maxCostUsd`) —
   exposure bounded regardless of how finely the agent splits. **D5 proven
   empirically.** *Semantics note (feeds OQ3):* `budget.check()` halts POST-FACT
   (`spent >= cap`), so the crossing charge completes and the NEXT action halts —
   exposure bounded to cap + one action; `budget.strict` adds a trailing-avg
   pre-flight projection to tighten this. Uses shipped primitives only; `src/`
   untouched.
4. **E4 · hardened sandbox** — **DONE** (`harness-code-mode/run-e4.mjs`). Swaps
   `node:vm` for a real boundary: the agent body runs in a separate process locked
   with Node 22's `--permission` model, with capability available ONLY via gated RPC
   to the parent (gate + tools live in the parent, physically unreachable). Same L1
   ask / L2 allowlist-deny as the seam, and a runtime-enforced L3: a `constructor.
   constructor` escape *does* reach `require`, but `fs`/`child_process` are denied
   (`ERR_ACCESS_DENIED`) — escape buys nothing, vs `node:vm` which merely hid symbols.
   **Closes §9.1 caveat C1.** Honest remaining gap: `--permission` does not gate
   network egress (separate OS-sandbox concern: netns/seccomp); the RPC design gives
   the body no legitimate network tool regardless. `src/` untouched.
5. **E5 · harness selection (D8)** — **DONE** (`harness-code-mode/run-e5.mjs`). The
   agent PROPOSES which operator-vetted capability *bundle* governs it; we check the
   D2 safety claim that selection is tighten-only ergonomics. Results: (a) the FLOOR
   is selection-independent — under any bundle, irreversible→ask (`sendEmail`,
   `bookFlight`) and the universal hard-deny (`wireMoney`) fire regardless; (b)
   **tighten-only** — a bundle only scopes capability DOWN (an off-bundle reversible
   tool is allowlist-denied), never up (intersected with the floor set); (c) **wrong
   pick ≠ unsafe (D2)** — a too-narrow "research" bundle on a booking task did NOT let
   the booking slip; the floor stopped it anyway; (d) **no ungoverned path** — an
   off-catalog / self-authored bundle proposal *refuses to run* (fail closed; note an
   *empty* allowlist would fail OPEN in bareguard, so selection is gated at resolve
   time, not by an empty scope); (e) the **match-validator advised only** (flagged the
   T2 mismatch) and changed no decision — **OQ2 evidence that the deterministic floor
   does all the safety work and the advisory layer is, so far, unearned.** Runner-layer;
   reuses the seam `node:vm` sandbox (confinement is E4's concern); `src/` untouched.

POC validates → design properly → only then propose concrete primitive reshapes (§7
"extend" rows) back into `bareguard-prd.md`. **Never ship the POC** (AGENT_RULES).

---

## 10. Open questions

- **OQ1** — Constraint contract format (§8). The §12.4 "satisfaction contract." Must
  fit §6 + ≤150 LOC, and accept *only* user/request-authored constraints.
- **OQ2** — Does the match-validator (D8) earn its keep, or is the deterministic floor
  enough on its own? (Advisory-only either way.) *Status: **E5 (§9.2.5) exercised D8.**
  The mechanism holds — agent proposes, floor is selection-independent, tighten-only,
  no ungoverned path. The match-validator **advised but changed no decision**: the
  deterministic floor did all the safety work. **Leaning answer: the floor is enough;
  the advisory layer has not yet earned its keep.** Keep it advisory-only and build a
  real validator only on a concrete need — not speculatively. D8 is ergonomics (D2).*
- **OQ3** — Generalize `budget`'s cumulative model to arbitrary countable resources
  (sends, rows, bytes) — extend the primitive, or a new `limits.cumulative`? (Appendix
  E bar applies — prefer extend.) *E3 evidence:* the cumulative tier already enforces
  the aggregate bound (proves the mechanism), but it counts only `costUsd`/`tokens` —
  E3 had to model € charges *as* `costUsd`. A real non-money resource (sends, rows)
  would need this generalization. Also surfaced: the POST-FACT halt semantics (cap +
  one action overshoot) — decide whether `strict` projection should be the default for
  hard-money caps.
- **OQ4** — Audit shape for reconciliation: log request + return together so
  ask-vs-response is reconstructable (a2a §12.2) without bloating the JSONL line.

---

## 11. What this does NOT solve (bounds, stated up front)

- **In-spec lies** (F8) — needs an independent oracle (payment pre-auth); not B's job.
- **Omissions / curation** (§11) — invisible to any constraint-checker; countered only
  by pre-existing diversity (independent research, multiple agents, a human asked
  "what's *not* here?"), not by this harness.
- **Making a probabilistic agent deterministic** — out of scope by thesis. The harness
  bounds blast radius; it does not remove variance.
- **Completeness of the floor** (M3/M4) — it raises evasion cost; it is not a proof.

---

## 12. Relationships

- **`bareguard-prd.md`** — the stable spec the harness *uses* and proposes to extend
  (§7). Subject to its Appendix C + E. No change to it until POC graduation (§9.2).
- **`a2a-intent-drift-prd.md`** — the experiment that produced F7, F8, §11, M1, §12.4
  — the evidentiary base for every "ceiling" claim here.
- **`harness-code-mode/`** — the seam PoC (§9.1) and home for E1–E4.

### Status: design grounded, build DEFERRED
The spine is LOCKED (§2); the only net-new surface (Axis B, §8) is DEFERRED on a real
external signal, consistent with the a2a close and Appendix E. **All five POC gates
(E1–E5) are DONE** (§9.2): E1 — the externally-authored gate holds against a real
*generated* body (L1 + L2, benign drift); E2 — the Axis-B detect-and-feed-A mechanic;
E3 — D5 (per-action regex = trigger, defeated by decomposition; cumulative `budget` =
the real wall); E4 — the hardened sandbox (process isolation + `--permission` + gated
RPC), closing caveat C1; E5 — D8 harness selection (tighten-only; floor
selection-independent; no ungoverned path; the match-validator earned nothing — OQ2).
Every gate is a runner-layer POC; **`src/` is untouched and no bareguard primitive
changed.** The whole locked spine (D1–D8) is now exercised. Per §9.2, the §7 "extend"
rows (cumulative generalization for OQ3, audit shape for OQ4) become fair to *propose*
back into `bareguard-prd.md`, but the `src/` Axis-B surface stays DEFERRED behind OQ1 +
a real external user, and the POC itself is never shipped (AGENT_RULES).
