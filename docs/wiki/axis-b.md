---
type: reference
title: Axis B — return reconciliation
status: stable
sources: [docs/archive/bareguard-prd.md]
---

# Axis B — return reconciliation

## 6. Axis B — return reconciliation — D7 (LOCKED)

### 6.1 What it does
On a return, compare the **returned value** against the **per-request constraint** (e.g. chosen flight €400 vs stated €300). On violation, **annotate** — never act (bareguard-prd.md:2014-2016).

### 6.2 Detect-and-feed-A (the whole model)
B runs *after* the trip; the request already left, so there is nothing for B to prevent. The only thing left to stop is the *next action* (booking the €400) — already an Axis-A action. **B never changes *whether* you stop — A's shape rules decide that. B changes *what the human sees* when A stops** (bareguard-prd.md:2018-2024). Example: agent says "found you a great flight, booking it"; B annotates "note — €400, exceeds your stated €300"; A's HITL prompt now carries B's independent fact, not the agent's spin. This is Part 1 §12.1's design note made literal — *show the human independent facts, not the agent's claim* — and is the concrete cure for F7 (invisible loss → visible on the approval screen) (bareguard-prd.md:2026-2032).

### 6.3 The reversible-path edge (D7)
If a B-finding sits on a path where **nothing irreversible happens** (e.g. reading drifted data), there is no A-stop to ride into. B's finding can go to two sinks: (1) **agent feedback** (in-band) → agent re-plans, and (2) **audit trail** → reconstructable later (bareguard-prd.md:2034-2038). Whether B *also* escalates to a human on a reversible path is set by the **reversible-escalation knob** (§6.6, default **strict**) — *not* by classifying the mismatch's kind (E6e showed that unreliable). `strict` surfaces anything not `honored` to A's HITL; `relaxed` sends it to the two sinks above only (no interrupt — D2's "reversible → HITL optional", for high-volume undoable reads). The knob is binary: the decisive `honored`/`broke` verdict left the old `tuned` middle setting with nothing to split (bareguard-prd.md:2040-2045). **B always surfaces *somewhere*; B never auto-rejects — worst case it escalates to A's HITL, where the human decides.** B has *no enforcement logic of its own* (bareguard-prd.md:2046-2047).

### 6.4 Hard ceiling — do NOT overclaim (bounds the whole PRD)
B checks the **returned value** against a **stated** constraint. Therefore it **cannot**: catch an **in-spec lie** (claims €199, books €450 — a2a **F8**); the liar reports a compliant number, needing an *independent oracle* (payment pre-auth) — out of scope; catch an **omission** (hides the better option you didn't think to constrain — a2a **§11**) — you can't reconcile against listings you don't know exist (bareguard-prd.md:2049-2055). Scope B as **"reconciles honest violations of stated constraints — NOT lies, NOT omissions."** Calling it "validate everything that comes back" would be F7 repackaged (§12.3 already killed the "drift meter" for the same reason) (bareguard-prd.md:2057-2059).

### 6.5 What B is made of — variable part vs fixed part (clarifies OQ1)
"B" names two very different things; conflating them makes OQ1 look bigger than it is (bareguard-prd.md:2061-2063).

**The CHECK — variable, customer-owned, cannot be generic.** Which field, what comparison; differs per consumer and always will (bareguard-prd.md:2065-2067):

| Consumer | Tool return | Their constraint | The check |
|---|---|---|---|
| travel agent | `{id, price: 400, stops: 1}` | `{maxPrice: 300}` | `price > maxPrice` |
| memory engine | `{payload, tokens: 12000}` | `{maxTokens: 8000}` | `tokens > maxTokens` |
| data export | `{rows: 50000}` | `{maxRows: 1000}` | `rows > maxRows` |

(bareguard-prd.md:2068-2072) Three consumers, three fields, zero shared check logic — each check is ~1 line of the *caller's* code. This is why OQ1 (the public constraint format) is deferred: shipping "the check" generically means freezing a mini-language before any real consumer has shown which 10% of it they need (bareguard-prd.md:2074-2077).

**The SKELETON — fixed, identical for every consumer; the only thing an Axis-B surface would ever ship** (bareguard-prd.md:2079-2080):
1. **Tap point** — reads the *authoritative tool return*, never the agent's claim.
2. **Timing** — after the return, before the next action.
3. **Fact envelope** — one output shape regardless of domain, **as SHIPPED in 0.7.0**: `{surface, verdict, where, meta}` — `surface` (bool) is the only load-bearing field, `where` is a one-line string, and `{field, stated, returned}` ride under `meta` (e.g. `{surface:true, verdict:"broke", where:"price: stated 300, returned 400", meta:{field:"price", stated:300, returned:400}}`) (bareguard-prd.md:2081-2087).
   > **Superseded shape — do not emit.** This skeleton originally specified `{kind, field, stated, returned, text}` with `kind ∈ violation|deviation`. **`kind` was retired by E6e** (§9.2.6 — the axis measured unreliable, 6/9, every miss an over-call) and the field is **`where`, never `text`**. The retired shape is kept visible because it was cited downstream as if current. It carries no `surface`, so **as of v0.13 it is MALFORMED**: nothing is buffered and an `annotate_malformed` audit row records `reason: "missing-surface"`. Before that rule it normalized into a fact with every key dropped and `surface` defaulting `false`, routing as `honored` — **fail-open and invisible**. The CURRENT state is pinned by `axis-b-annotate.test.js`; the superseded fail-open is described here only, since its tests were replaced by the rejection tests that supersede them (bareguard-prd.md:2088-2098).
4. **Routing** — facts go to the three §6.3 sinks: the human-ask annotation, agent feedback (in-band context), and the audit line.
5. **The prohibition** — never blocks, never modifies, never decides (D7).

(bareguard-prd.md:2099-2101) Same pattern as `humanChannel`: bareguard doesn't know whether the human UI is Slack or a terminal — it ships the *slot and the event shape*, the caller plugs in the rest. An Axis-B surface ships the slot, the envelope, and the sink wiring; the checks stay the caller's (bareguard-prd.md:2103-2106).

**Common misreading, corrected:** B does not "pass the result to A" — **A never sees results at all.** A gates the *next action*, and stops with or without B (an irreversible booking asks regardless). B passes only its *note*, so a stop that was already happening shows independent facts instead of the agent's framing. B changes what the human *knows*, never what the system *does*. The E2 PoC (`harness-code-mode/axis-b.mjs`) implements exactly this split: a domain-specific `reconcile()` (the variable part, 2 hardcoded fields) emitting the fixed envelope into the fixed sinks (bareguard-prd.md:2108-2114).

### 6.6 The routing model — surface-vs-pass × reversibility (decisive 2026-06-15)
**Why this superseded the earlier violation/deviation table.** The first design routed on `kind` (a *deterministic violation* vs an *LLM-judged deviation*). **E6e (§9.2.6) measured that axis as unreliable** — a cheap judge (haiku) decides **surface-or-not** reliably (9/9 clear cases; nothing that drifted slipped to `none`) but **cannot reliably tell violation from deviation** (6/9; it over-called `violation` on every prose drift; verifiable-vs-opinion only 5/8). And `kind` only ever governed *one* cell anyway (reversible + flagged → interrupt vs stay quiet). So `kind` is dropped from routing, keying only on two *reliable* signals (bareguard-prd.md:2116-2124):
- **A decisive verdict** — the judge returns `honored` / `broke` (binary, no confidence scale). An intermediate framing (`clear-problem`/`unsure`/`clear-ok`) was tried and **dropped: E6g (§9.2.6) showed the confidence framing *hedges* — a clearly-compliant €280 drew `unsure` and surfaced**; LLMs are weak at graded confidence, strong at decisive categories. The decisive `honored`/`broke` ask (Aurora's matching-judge pattern) cleared €280 to `honored` 5/5 while every real drift + the injection case still `broke` 5/5 (E6i). `surface = (verdict !== "honored")`. The floor-raise lives in a **decisive tiebreak** — *if you cannot confirm it was honored, return `broke`* — not in an `unsure` hedge bucket (bareguard-prd.md:2126-2133).
- **Reversibility** — a property of the *action B is riding* (booking = irreversible, recall-read = reversible), **read structurally from the floor, never inferred by the model** (a hallucinated "reversible" would silently downgrade a booking to auto-pass) (bareguard-prd.md:2134-2136).

`kind` (violation/deviation, verifiable/opinion) survives **only as descriptive text** in `where` for the human to read — never as a routing input (bareguard-prd.md:2138-2139).

**Routing.** Terms: **pass** = proceed, audit only; **log** = proceed + audit + agent feedback, no human; **HITL** = a human sees it. B never auto-rejects (bareguard-prd.md:2141-2142).

| judge ↓ \ action → | **reversible** (floor doesn't stop) | **irreversible** (floor asks anyway) |
|---|---|---|
| **broke**    | escalate per knob | **HITL** — B annotates the floor's ask |
| **honored**  | pass (audit only) | **HITL (floor)** — B annotates nothing |

(bareguard-prd.md:2144-2147) Two things to read off it: **the irreversible column is uniform HITL — and not because of B.** Axis A stops every irreversible action regardless; B's only move there is whether to *attach a fact*. B never *causes* an irreversible interrupt; it makes the one already happening **informed**. **All of B's actual routing lives in the reversible column** — the only place B decides whether a human is pulled in for something the floor would let through (bareguard-prd.md:2149-2154).

**The reversible-escalation knob (the one tuning control; default strict).** The verdict is binary, so the knob is too — it governs the **entire reversible-`broke` set** (bareguard-prd.md:2156-2159):

| knob | reversible `broke` |
|---|---|
| **strict** (safe default) | HITL |
| **relaxed** | log+feed |

`strict` surfaces anything not `honored` (the §6.3 "reversible → HITL optional" line, dialed to *on*); `relaxed` is that line dialed to *off* (never interrupt for an undoable action — right for high-volume reads like `recall`). The old three-way knob's middle setting (`tuned`) existed only to split `clear-problem` from `unsure`; the decisive verdict removed that split, so the knob is binary. **This knob is purely a noise / attention-budget control, never a safety one** — the floor + reversibility own safety, B owns informedness — which is exactly why it is safe to set per-case. HITL-approve *is* the "accepted delta"; if the same flag keeps being approved, fix the **stated constraint**, not B (bareguard-prd.md:2165-2172).

**Why decisive verbs, not a confidence scale (§9.2.6, E6g/E6i).** The earlier framing asked the judge for *confidence* (`clear-problem`/`unsure`/`clear-ok`). E6f then logged a compliant €280 being surfaced and (wrongly) blamed a surfacing-biased *prompt*. **E6g's clean A/B refuted that**: a *neutral* prompt false-flagged €280 **4/5 — worse than the biased one (1/5)**. The bug was the **confidence framing itself** — €280 is "near the cap," so a graded-confidence judge won't vouch and hedges to `unsure`/`clear-problem`. Switching to a decisive **`honored`/`broke`** ask with sharp definitions + examples (E6i) cleared €280 5/5 and kept every real drift + injection at `broke` 5/5, with none of the hedging variance. **Calibrate the judge as a decisive call (did the answer honor the request? `honored`/`broke`); the knob carries aggressiveness.** The fix was the *wording of the ask*, never a deterministic carve-out for numbers (E6h confirmed a calculator path also works, but adding one is perfection-chasing the long tail — the decisive judge is enough) (bareguard-prd.md:2174-2184).

### 6.7 Who computes the check — and why the LLM is caller-side only
bareguard ships the **skeleton only** (`gate.annotate`, §6.5); the **check is the caller's** (this is the **#2 = thin primitive** resolution, 2026-06-15). For the **deviation** path the caller — the *runner*, **never bareguard, never the tool (litectx)** — makes the LLM call. bareguard making an LLM call would drop a fallible model inside the floor and break its no-content-reasoning guarantee (§6.4) (bareguard-prd.md:2186-2192).

**Judge at return time, against the verbatim request — not an intake checklist.** The reference is the user's **original request, verbatim** (from the transcript), compared to the **returned value** *when the result comes back* — no up-front extraction, no door-step HITL, and crucially nothing the *agent* paraphrased (so it can't launder its own drift; the user's literal words are the immutable anchor). This preserves full automation: the human is pulled in only by §6.6 routing, never to confirm a contract (bareguard-prd.md:2194-2199).

**Resolved design (2026-06-15, decisive) — one open call.** The check is a single LLM call over the open shape: given the **verbatim request** and the **answer**, it returns *(a)* `verdict` — a decisive **`honored` / `broke`** (did the answer honor the request?), **not** a confidence scale (E6g showed graded confidence hedges clean cases — §6.6); *(b)* `where` — the human-readable mismatch (the place the optional `kind`/`checkable` description lives, for the human to read). The runner maps `verdict` to surface-vs-pass (`surface = verdict !== "honored"`); bareguard routes that **× reversibility** per §6.6, deciding **routing, never outcome**. The judge is **not** asked violation-vs-deviation — E6e showed that axis is unreliable (§6.6) (bareguard-prd.md:2201-2208).

```json
{ "verdict": "broke",
  "where": "you said under €300; the booking is €400" }
```
```js
gate.annotate({ surface: verdict !== "honored", verdict, where })
// the field is `where` — an earlier draft of this line said `text`, which annotate()
// silently DROPS (it normalizes and never throws), leaving where:null. Structured
// detail rides `meta: {field, stated, returned}`.
// bareguard reads reversibility from the action it rides, then routes per §6.6 + the knob.
```
(bareguard-prd.md:2210-2220)

**Field bounds are part of this contract, and there are TWO of them** (shipped; the `Annotation` typedef carries the full statement and is the citable authority, because it ships in the `.d.ts` and cannot drift from the code) (bareguard-prd.md:2222-2224):
1. **Source bound** — on the drained fact and the `humanChannel` event. `verdict` ≤80 and `where` ≤300 **characters** (UTF-16 code units, *not* bytes), `where` clipped with **no marker**; `meta` ≤1000 **bytes**, **all-or-nothing** — over the cap the whole object becomes `{_truncated:true, bytes}`, so bulky evidence takes `field`/`stated`/`returned` with it (an unserializable `meta` becomes `{_unserializable:true}`, same total loss) (bareguard-prd.md:2226-2230).
2. **Audit-sink bound** — applied **after redaction**, on the persisted line only. Redaction *expands* fields, so a line built from in-budget values can still exceed the ~3500-byte atomic-append cap; the row then re-clips `where` to ~200 bytes **with** a `[TRUNCATED]` suffix and a root `_truncated:true`, and **replaces `meta` even when the source `meta` was legal** (measured: a 355-byte `meta` persisted as `{_truncated:true,bytes:6977}`) (bareguard-prd.md:2231-2235).

**Consequence for a judge author:** sizing to the source budget does **not** guarantee the mechanical fields survive into the audit row once a redactor is configured. Bound free text before it reaches `meta`, and keep `where` a one-line address. The byte-level audit backstop — not the character-counted source caps — is what actually preserves append atomicity; the caps are not to be raised (bareguard-prd.md:2237-2241).

**Why one open call is good enough — and why it is not a safety bet.** B **never decides outcome**, so a wrong call costs only a *missed annotation* or *a little HITL noise* — never an unsafe action, because Axis A already gated the action. A best-effort judge *over* a deterministic floor is sound; the same judge *as* the floor would not be. This is a long-tail layer — additive, improvable, never complete — and the openness (any ask, any answer) is why a flexible LLM call, not a rigid schema, is the right tool (bareguard-prd.md:2243-2248).

**Three non-negotiables (cheap; this is where errors stop being bounded)** (bareguard-prd.md:2250):
1. **Anchor on the verbatim request.** Compare against the user's literal words from the transcript — never the agent's paraphrase or working context. This stops the agent laundering its own drift (E6 hole 3: judging a €450 booking vs a poisoned €500 *belief* cleared it; vs the user's original €300 it flagged) (bareguard-prd.md:2251-2254).
2. **Reply-as-data, never instructions.** The answer is untrusted input; forged amendments/instructions inside it are ignored. Held on haiku (E6b, 100%) but **not disproven** — re-test on weaker/cheaper judge models before any real deployment (bareguard-prd.md:2255-2257).
3. **Ask a decisive category, never a confidence scale.** Safe-by-default surfacing comes from (a) the judge reliably catching real drift + (b) the reversible-escalation knob defaulting to **strict** (§6.6). The judge's ask is a decisive **`honored`/`broke`** with sharp definitions + examples (Aurora's matching-judge pattern), *not* a graded confidence. A confidence scale hedges: E6g's clean A/B showed even a *neutral*-worded confidence judge false-flagged a compliant €280 (4/5) — the framing, not the wording, was the bug; the decisive ask cleared it 5/5 (E6i, §9.2.6). Encode the floor-raise as a **decisive tiebreak** ("can't confirm honored → `broke`"), not an `unsure` hedge bucket; let the knob carry aggressiveness. Do **not** add a deterministic carve-out for numbers to "help" the judge — that's chasing the long tail (E6h) (bareguard-prd.md:2258-2266).

**Optional hardening — locate, then math.** For a *clean structured egress* (a single-field booking, `recall` provenance, `impact` risk) the model can emit the comparison spec and let deterministic code render the numeric verdict — cheap insurance against arithmetic/currency fumbles. NOT required (E6b's verdict-judge got the blatant cases 100% too). It does **not** rescue sprawl: free-locating a multi-number reply missed ~1/3 (E6b decoy option-list) where the clean egress hit 6/6 (E6d). So the load-bearing rule is **judge the authoritative egress action (§6.2), not a free-text listing** — apply locate+math there if you want extra certainty (bareguard-prd.md:2268-2274).

### 6.8 Where Axis B stops — the #3/#4 boundary (the lie, the payment oracle, the standards)
Axis B owns **#4 — intent fidelity**: *did my agent emit / act on a faithful instruction?* It does **not** own **#3 — identity + authorization + the unforgeable number** (who authorized what; the payment pre-auth that actually moves money). The two **interlock; neither absorbs the other.** Full derivation: [`harness-research.md`](harness-research.md) (Parts I–III) (bareguard-prd.md:2278-2282).

- **The lie is outside B by construction (F8).** B compares request vs return; an in-spec lie lives *inside* a compliant-looking return (`reports 199, books 450`) and defeats a claim-checker 100%. Do **not** grow the judge to chase it — that re-opens the overclaim hole. Scope stays "**catches honest violations, NOT lies or omissions**" (§6.4) (bareguard-prd.md:2284-2287).
- **The lie is caught elsewhere, by a different instrument:** the **payment rail's pre-authorization** — the one independent oracle the agent cannot forge (the number that actually moves money). That is #3 / the payment layer, **never bareguard**. bareguard's only contact with it: at the irreversible **egress** stop, surface *the oracle's number, not the agent's claim*, to the human (Part 1 §12.1 design note; Part III "Identity and the gate") (bareguard-prd.md:2288-2292).
- **The standards cover #3, not #4.** The live IETF drafts (AIP, DAAP, OAuth-OBO, AI-Agent Authn/Authz, **Delegation Receipts**) + the NIST initiative all solve *who + scope*. The Delegation Receipt draft explicitly notes the others **assume the operator faithfully represented the user** — the exact seam B refuses to assume. bareguard sits in the **#4 gap** the standards authors name and leave open: complementary, not redundant (bareguard-prd.md:2293-2297).
- **Deepest mitigation isn't a better gate or oracle** — it's preferring **reversible rails** (escrow, hold-then-capture, confirm-before-final). Where no oracle exists, the honest answer is **reversibility + human escalation**, not a magic check (bareguard-prd.md:2298-2300).

A clean #4 gate establishes *your half of the record* (a faithful instruction at egress) so the counterparty's #3 trace/oracle becomes usable **against them, not against you** (bareguard-prd.md:2302-2303).

## 8. The new surface: Axis-B constraint reconciliation — DEFERRED
This is the a2a §12.4 candidate ("satisfaction contract"). Appendix-C self-assessment, honestly (bareguard-prd.md:2418-2419):

| Appendix C test | Axis B | Note |
|---|---|---|
| 1. Constrains action against the world? | **borderline** | It detects on a return and *feeds* A; it doesn't act. Defensible only as "produces a fact A consumes." |
| 2. Rule over action *shape*, not content semantics? | **strain** | `price ≤ 300` is a value comparison over the return — the edge of §6. Needs a declared-constraint contract to stay shape-like. |
| 3. Works without network/infra/server? | **yes** | pure local comparison |
| 4. ≤150 LOC + one dep? | **at risk** | the *check* is tiny; a constraint **contract format/DSL** could blow the budget |
| 5. Opt-in, safe default? | **yes** | no declared constraint → no check |

(bareguard-prd.md:2421-2427) **Conclusion:** Axis B does NOT clear the bar today (tests 1, 2, 4 strain). Per Appendix E and the a2a close ("next signal comes from a person who isn't us"), it **stays DEFERRED** until: (a) a real external user needs it, AND (b) we can express the constraint contract within the Part 1 §6 thesis and the LOC budget. Until then this PRD *specifies* it; it does not build it (bareguard-prd.md:2429-2433).

**Open sub-question (blocks any build):** who authors the per-request constraint? The *request/user* — never the agent checking itself (that's M1 again). The contract format must make user-authored constraints the only input B reconciles against (bareguard-prd.md:2435-2437).

## 8.1 Concrete spec — `recall`-provenance & `impact`-risk (settled 2026-06-14, design-only)
The §6.5 skeleton (tap → `{surface, verdict, where, meta}` envelope → sinks → never-decide) is fixed. *(The envelopes in this section pre-date E6 and are rewritten to the shipped shape — `kind` was retired by E6e and `text` is not a field; see §6.5.)* This section fills in the **variable check** for litectx's two real return shapes (grounded at file:line, litectx HEAD), and shows the declaration format (OQ1) they imply. **Still unbuilt** — this is the spec for *if* a consumer asks; none has. It replaces the retired `assemble`/scenario-2 sensor (§0.2 #5: `assemble` self-enforces its budget, so there is no honest violation to reconcile) (bareguard-prd.md:2441-2446).

> **#2 RESOLVED (2026-06-15) — thin primitive.** bareguard ships `gate.annotate` (the §6.5 skeleton: envelope + `surface × reversible` routing per §6.6); the **check stays the caller's**, so OQ1's format is not frozen by the surface. Both litectx checks below are **deterministic → `surface:true` (`verdict:"broke"`)**; the soft LLM-judged path is caller/runner-side only (§6.7) and needs no litectx change. Routing is now **surfaced always → HITL** (§6.6), which tightens Case R below. *(Written pre-E6 as `kind:"violation"` vs `deviation`; `kind` was retired by E6e — the shipped envelope routes on `surface`, and the decisive verdict is `honored`/`broke`.)* (bareguard-prd.md:2448-2454)

**Case R — recall provenance** *(deterministic membership → `surface:true`; reversible read)* (bareguard-prd.md:2456):
- **Return:** `recall(q)` → `Hit[]`; memory hits carry `provenance` via `attachMemMeta` (`litectx/src/index.js:332`). Values **today `human | agent`, `null` for indexed files** (`:120`).
- **Constraint:** `{recall:{provenanceIn:["human","doc"]}}` (or `provenanceNotIn:[…]`).
- **Check (caller, ~1 line):** `hits.filter(h => !allowed.has(h.provenance))`.
- **Sink:** a membership breach is a **deterministic `violation`** → under §6.6 **escalates to HITL even though the read is reversible** (certainty earns the glance). *(This is the §6.6 tightening: the earlier draft routed reversible reads to feedback+audit only; a hard provenance breach now asks. A soft "this memory feels off-topic" would be a `deviation` and, being reversible, would pass silently — but that judgment is not what this deterministic check produces.)*
- **Envelope:** `{surface:true, verdict:"broke", where:"provenance: stated human/doc, returned agent", meta:{field:"provenance", stated:["human","doc"], returned:"agent"}}`.
(bareguard-prd.md:2456-2466)

**Case I — impact risk** *(the genuine detect-and-feed-A case — rides the edit's existing A-stop)* (bareguard-prd.md:2468):
- **Return:** `impact(symbol)` → `{usedBy, risk, callers, callees}`, `risk ∈ low|med|high` (`index.js:454` → `impact.js`).
- **Constraint:** `{impact:{maxRisk:"med"}}`.
- **Check (caller, ~1 line):** `RANK[risk] > RANK[maxRisk]`.
- **Sink:** an edit *is* an irreversible A-action; the `violation` rides the edit's existing A-stop, which now carries "editing `foo`, impact=high (12 callers), you capped at med." Human sees blast radius, not spin. (Routing unchanged by §6.6 — irreversible violation was always HITL.)
- **Envelope:** `{surface:true, verdict:"broke", where:"risk: stated med, returned high (foo, 12 callers)", meta:{field:"risk", stated:"med", returned:"high"}}`.
(bareguard-prd.md:2468-2476)

**What this pins about OQ1 — the format is tiny.** The two consumers need exactly two operator kinds (bareguard-prd.md:2478):
```
constraints: {
  recall: { provenanceIn: [...] | provenanceNotIn: [...] },  // set membership
  impact: { maxRisk: "low" | "med" | "high" },               // ordered-enum threshold
}
```
No numeric comparison, no nesting, no expression language. **OQ1 collapses to "freeze {membership, ordered-threshold}, keyed by tool name."** Skeleton untouched; build (if ever) = ~1 envelope + 2 wire-points, runner-layer (bareagent), `src/` untouched — same as E2's `reconcile()` (bareguard-prd.md:2479-2487).

**Part 1 §6 compliance:** both checks read a *structured return field* against a *user-stated* value — no text scan, no content semantics; neither blocks (D7). A B that *filtered* recall hits or *stopped* the edit would cross into enforcement — forbidden. The soft `deviation` path (§6.7) *does* read content, but via an **LLM the runner calls** — bareguard still only receives a fact and routes it, so the floor itself stays content-blind. bareguard never makes the LLM call (bareguard-prd.md:2489-2493).

**Honest ceiling:** (1) recall provenance is **thin today** (`human|agent` only on hits; the richer `web|subagent|doc` enum lives on the *write* action) — Case R can't discriminate web-sourced memory until litectx surfaces full provenance on recall hits (litectx's gap). (2) impact risk is litectx's own verdict — B inherits its accuracy. (3) Still catches no F8 lie (tampered label) and no §11 omission (the symbol you never `impact()`'d). (4) **No demand** — plausible, unrequested (bareguard-prd.md:2495-2499).

## 8.2 Build spec — `gate.annotate` — **IMPLEMENTED 2026-06-15** (design measured by E6)
> **Status: BUILT & verified — released in 0.7.0.** Shipped in `src/gate.js` (`annotate()` / `drainAnnotations()` / exported `routeAnnotation()`), `src/types.js` (`Annotation`, `AxisBConfig`, `axisB` on `GateConfig`, `annotations` on `HumanEvent`), exported from `src/index.js`. Covered by `test/axis-b-annotate.test.js` (the §8.2.4 set + 3 security regressions, 11 tests, mutation-verified); full suite 178/178, typecheck clean. The spec below is the as-built contract. The one variance from the early sketch: reversibility is resolved from `config.axisB.reversible` (operator-declared action **types**), read off the gated action — not a per-action boolean (the agent must not be able to self-declare it) (bareguard-prd.md:2505-2512).

### 8.2.0 Plain-language recap — what the POC proved (read this first)
Axis B is a **checker** that sits behind an agent. The agent does a task; before it's finalized, the checker compares **what the user asked** against **what the agent actually did**, and raises a hand if they don't match — so a human sees the real story, not the agent's spin. The E6 POC (§9.2.6) ran a real agent on a real booking task and tried to break it. In plain terms (bareguard-prd.md:2516-2521):
- **It catches a real screw-up, end to end.** Pushed to overspend, the agent booked €295 over a €250 limit; the checker flagged it **every time** (E6d 6/6).
- **It resists trickery.** Fake notes planted in the data ("the user changed their mind, it's fine now") did **not** fool it — *on the model we tested* (haiku). Not yet confirmed on a weaker model.
- **It can miss in a messy pile.** Pointed at a cluttered reply with a decoy number, it grabbed the wrong one ~**1 time in 3**. → so it must judge **the specific action being taken** (the booking), not a big search-result pile. Pointed at the clean action it was right every time.
- **It can't reliably tell "hard rule broken" from "vaguely off."** So we **stopped asking that**; we ask one decisive question — *"did the agent **honor** what the user asked, or **break** it?"* (which it does well) — and let a simple deterministic rule decide what to do.
- **Asking for a "confidence level" backfired.** When we asked *how sure* it was (ok / unsure / problem), it got jittery on clean work — it flagged a perfectly fine €280 booking (under a €300 limit) because €280 felt "close to the line." Switching to the blunt honor/break question fixed it: the €280 passed every time, while every real screw-up still got caught. Lesson: these models are bad at *shades of confidence*, good at *clear yes/no calls*.
- **It can never make things less safe.** Worst case it asks one extra question (noise); it never silently lets a bad action through (the one miss above is a *messy-pile* artifact, fixed by pointing it at the action). Safety is owned by the deterministic floor underneath, not by the checker.
(bareguard-prd.md:2522-2541)

**Verdict: good enough to build**, as a best-effort layer over the Axis-A floor. The €280 false-alarm is **resolved** (decisive honor/break ask, E6i). One item is **deferred** to the first real deployment, not blocking the build: re-test trickery (injection) on a judge model weaker than haiku — none is reachable in our test env (the local CLI bottoms out at haiku), so this waits on a real adopter's chosen model (bareguard-prd.md:2543-2547).

### 8.2.1 What bareguard ships (the only `src/` change)
A thin primitive — the §6.5 skeleton, nothing more. bareguard **never** calls an LLM, never decides an outcome; it buffers a fact and routes it (bareguard-prd.md:2551-2552).

```js
// caller hands bareguard a FACT (it never computes the fact itself):
gate.annotate({
  surface: true,                 // bool — the one load-bearing field (honored ⇒ false)
  verdict: "broke",              // optional hint: honored | broke (decisive, not a confidence scale)
  where: "you said under €300; the booking is €400",  // human-readable, rides the HITL
  meta: { /* optional: field/stated/returned for a verifiable check */ },
});
```
(bareguard-prd.md:2554-2562)

- **Buffer + ride.** `annotate()` buffers the fact; the **next `check()` that triggers a human approval** carries buffered facts in its event (so the human sees independent facts, not the agent's claim). Facts also go to the **audit line** and are returned for **agent feedback**.
- **Routing is a pure function** of `surface × reversibility × knob` (§6.6) — no LLM in the path. **Reversibility is read from the action bareguard is gating**, never from a param and never from the model.
- **The knob** is config: `axisB: { reversibleEscalation: "strict" | "relaxed" }`, **default `strict`**. Binary (the decisive verdict left no middle to split — §6.6). Governs the whole reversible-`broke` set. Pure noise control, never safety.
- **Safe default / opt-in:** no `annotate()` call ⇒ no facts ⇒ no behavior change. B is additive.
(bareguard-prd.md:2564-2573)

**Malformed is rejected, not normalized (v0.13).** `surface` must be an **explicit boolean** — it is the only load-bearing and only non-optional field, so setting it is what distinguishes a caller speaking the contract from one speaking a different dialect. A non-object, an **array** (`typeof [] === "object"`), an object without a boolean `surface` (the retired sketch, `{}`, a typo, a truthy `"false"`), or a fact that **throws when read** (a getter / Proxy trap → `reason:"unreadable"`, rejected WHOLE even if `surface` itself read fine) buffers **nothing** and emits a distinct `annotate_malformed` audit row carrying `reason` — a **record, not a verdict**: it changes no decision (same class as `unpriced` / `budget_warn`). A distinct *phase* rather than a flag on `annotate`, because a flag would let a parser counting `phase === "annotate"` miscount a rejection as a fact. **The never-throws guarantee, stated precisely:** `annotate()` never throws because of *the fact* — any shape, any hostile getter (every read of a caller-supplied object is inside the guard, the shape check *and* the normalization). An audit **write** failure (disk full, unwritable path) still propagates, deliberately — a silently-dropped audit line is the worse failure, and every other phase behaves the same. Both halves are pinned by test, so the guarantee cannot quietly widen back. Rationale: without the rule every one of those normalized into a fact **byte-identical to a legitimate `honored`** one, so "I could not read what you sent" and "everything was fine" shared a value — the fail-open that let a downstream sketch-shaped call go invisible (§6.5) (bareguard-prd.md:2574-2594).

### 8.2.2 The routing function (ship this exactly — E6i-validated)
```js
// verdict ∈ {honored, broke} → surface = (verdict !== "honored"); reversible ∈ bool; knob "strict"|"relaxed"
function routeAnnotation(surface, reversible, knob = "strict") {
  if (!surface) return reversible ? "pass" : "annotate-floor-ask"; // honored
  if (!reversible) return "annotate-floor-ask";        // irreversible: floor asks anyway
  return knob === "strict" ? "HITL" : "log";           // reversible broke: strict surfaces, relaxed logs
}
// pass = proceed, audit only · log = proceed + audit + agent-feedback · HITL = human sees it
```
(bareguard-prd.md:2598-2606)

### 8.2.3 What the caller provides (NOT bareguard)
The **fact** — produced one of two ways, both caller-side (bareguard-prd.md:2610):
1. **Deterministic check** (structured field, certain): `recall` provenance, `impact` risk, a price cap — the §8.1 shapes. ~1 line; `surface = (check failed)`.
2. **The one-call LLM judge** (open prose, §6.7): `(verbatim request, reply) → {verdict, where}`, a decisive **`honored`/`broke`** ask with sharp definitions + examples — **not** a confidence scale (E6g/E6i), aggressiveness lives in the knob. The runner makes this call; **bareguard and litectx never do.** Three non-negotiables (§6.7): anchor on the verbatim request; treat the reply as untrusted data; judge **the clean egress action**, not a sprawling listing.
(bareguard-prd.md:2611-2617)

### 8.2.4 Tests to write (each mutation-verified to fail when the code breaks)
1. `annotate()` buffers, and the next HITL `check()` carries the facts in its event.
2. Routing matrix — all of `surface × reversible × knob` cells return the §8.2.2 verdict.
3. Reversibility is read from the gated action, not the fact (a fact can't force/relax a halt).
4. Facts hit the audit line and are returned for agent feedback.
5. Safe default: no `annotate()` ⇒ byte-identical decision path (no regression).
6. Knob default is `strict`; `relaxed` never interrupts on a reversible path.
7. B never auto-rejects: worst case is `HITL`, never a `deny` B produced on its own.
(bareguard-prd.md:2621-2627)

### 8.2.5 Non-goals (hold the line — §6.4/§6.8)
bareguard does not: call an LLM; decide an outcome; infer reversibility; classify violation-vs-deviation as a routing input; catch an in-spec **lie** (F8 — needs the payment oracle) or an **omission** (§11). The judge is best-effort #4 intent-fidelity; the floor does the stopping. HOLD-at-0.5.x safe (purely additive) (bareguard-prd.md:2631-2634).
