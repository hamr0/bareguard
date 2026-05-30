# A2A Intent-Drift — Experiment PRD & Findings (living)

> Companion to [`agentic-web-problem-space.md`](agentic-web-problem-space.md).
> That doc reasons about whether an intent-integrity gate is worth building.
> This doc records what the **bench** actually measured, so the build/no-build
> call rests on data, not argument. The bench code lives in the gitignored
> `experiments/a2a-intent/` (throwaway, per AGENT_RULES — never shipped).
>
> Status legend: OBSERVED (measured), HYPOTHESIS (stated, not yet tested),
> OPEN (unresolved). Findings carry an **F-id**; reference them in later runs.

---

## 0. TL;DR

We built a spec-shaped A2A flight-agent stub + an orchestrating client to measure
**intent atrophy at the narrowing hop** (full human intent → the agent's
`{from,to,date}` input shape). Three things are now measured, not assumed:

1. **Structural drift is real and deterministic.** Constraints with no field in
   the agent's input schema (price ceiling, max stops, departure window) are
   dropped *before the request leaves*, every time.
2. **Whether that drop changes the outcome depends entirely on who selects** from
   what the agent returns. A dumb "pick cheapest" stand-in drifted 6/10. A real
   LLM holding the full intent in context recovered **9/9** satisfiable cases.
3. **Sending constraints as JSON doesn't save you** — only the receiver honoring
   them does, and you don't control the receiver.

**Net so far:** the case for an external intent gate is *narrower* than the
problem-space doc assumed — but it is real and now located. On the single-hop
happy path *with the full option list returned*, the LLM is its own faithful
local-hold (drift 0/10, both models). The moment the agent returns **only its own
pick** — the shipping "agents-as-tools" reality — self-recovery collapses (drift
6/10, both models) **and the loss is invisible to the client** (it reads as "no
match"). That is the gate's lane, and model strength does not close it: the small
model fails identically because the deciding variable is *information
availability, not capability* (§6, F5–F7).

---

## 1. What we're measuring (and why)

The problem-space doc's open question (its "decision rule"): when intent degrades
at hop 1, is the loss in **encodable** clauses (`price<=300` — a deterministic
gate could catch it) or **unencodable residue** ("no miserable 5am start" — no
gate can)? And separately: does the loss actually **change the result**, or is it
cosmetic? The bench exists to answer both with numbers.

**Clause taxonomy** (used throughout):
- **declared** — maps to a card input field (`from/to/date`). Always carried.
- **soft-encodable** — deterministic but *no* card field (`maxPrice`, `maxStops`,
  `departBefore`). Dropped at the wire; locally checkable.
- **residue** — not expressible as a constraint at all ("window seat"). Lost
  regardless; invisible even to a local check.

---

## 2. The bench (architecture)

Two stdlib-only Node processes, zero deps in core (Phase 1 adds `bare-agent`):

- **`server.mjs`** — spec-shaped A2A agent. `GET /.well-known/agent-card.json`
  (skill input shape `{from,to,date}` — the lossy surface) + `POST /` JSON-RPC
  `message/send` returning a fixed flight catalog. Catalog is *seeded* so the
  answer depends on whether dropped clauses survived (separates drift from
  honest no-match).
- **`client.mjs`** (Phase 0) — hardcoded narrowing + naive "pick cheapest"
  stand-in. Measures **structural** drift.
- **`phase1.mjs`** (Phase 1) — real LLM brain via `bare-agent`'s `Loop`, given
  the full intent in context + a tool whose schema carries only `{from,to,date}`.
  Measures **interpretive** drift.
- **`wire-test.mjs`** — sends identical constrained JSON to three receiver
  behaviors. Isolates "who decides whether intent holds."

Each run emits **one JSONL line** (ts, runId, intent, dropped clauses, verdict,
pick, ground-truth match, cost). The JSONL *is* the dataset.

---

## 3. Findings to date

### F1 · OBSERVED · Structural drift is real and total
At the narrowing hop, every soft-encodable clause and all residue is dropped
before the request leaves — `toolArgsSent` is always bare `{from,to,date}`. Not
probabilistic; a property of the card's input shape. Independent of any LLM.

### F2 · OBSERVED · Naive selection drifts badly (Phase 0)
Hardcoded narrow + "pick cheapest" over 10 intents, against a catalog where
matches exist:

| verdict | count |
|---|---|
| pass (naive pick happened to satisfy) | 3 |
| **drift-miss** (a match existed; naive path missed it) | **6** |
| true-no-match (honestly unsatisfiable) | 1 |

Of the 6 drift-misses, **5 were lost on purely encodable clauses** (`maxPrice`,
`maxStops`, `departBefore/After`) — a deterministic gate catches all five. Only
1 carried residue ("window seat"), and even there the *encodable* part (direct)
was what a local check used to recover; the residue stayed invisible (confirms
problem-space §198, the "unencoded miss").

### F3 · OBSERVED · A competent LLM self-recovers (Phase 1)
Same 10 intents, same catalog, real `bare-agent` Loop on **gpt-4o** (temp 0,
$0.016 total):

| verdict | count |
|---|---|
| **intent-held** (LLM picked a satisfying flight) | **9** |
| true-no-match | 1 |
| drift-miss | **0** |

Structural drift *still happened* (F1 holds — bare tool args, `extraFieldsTried`
empty: gpt-4o didn't even try to stuff extra fields). But the LLM held the full
intent in context and **filtered the returned options itself**. Discriminating
evidence: for "≤€300, stops fine" it picked Ryanair €275/2-stop (cheapest legal);
for "≤€300 *and* direct" on the same route it picked TAP €295/direct, *skipping*
the cheaper Ryanair. It read the constraint; it didn't pattern-match cheapest.

**Implication:** the Phase-0 drift was an artifact of the dumb stand-in, **not**
an inherent property of A2A narrowing. This pushes the *need* for an external
gate outward on the happy path.

### F4 · OBSERVED · The wire doesn't hold intent — the receiver does
`wire-test.mjs`: identical fully-constrained JSON (`{from,to,date,maxPrice:300,
maxStops:0}`) sent to three receivers, with a satisfying flight (TAP €295/direct)
in the catalog:

| receiver behavior | HTTP | outcome |
|---|---|---|
| ignore-unknown | 200 | **intent LOST** — picked Ryanair €275/2-stop (silent, looks fine) |
| reject-unknown | 400 | request FAILED (`unknown fields`) |
| honor | 200 | intent HELD — TAP €295/direct |

Same bytes sent; outcome decided entirely by the other side. `ignore-unknown` is
the dangerous case: it doesn't prevent drift, it **relocates it server-side where
you can't see it** (200 OK, quietly wrong). This is the empirical argument for the
problem-space doc's **local-hold + return-boundary check** — the only half of the
wire you control.

---

## 4. What this means for the build decision

- The intent gate's value proposition **narrows** from "catch drift in A2A
  handoffs" to "catch drift **where the LLM cannot self-recover**." On the
  single-hop happy path with a good model, it's redundant.
- Candidate regions where self-recovery should fail (the gate's real lane):
  - **No-full-list return** — the remote agent returns only *its own pick*, not
    the option set. The LLM never sees alternatives → can't recover. (This is the
    shipping "agents-as-tools" reality, problem-space §249.)
  - **Multi-hop** — intent degrades across orchestrator → sub-agent → sub-sub.
  - **Weaker model** — a smaller model may not filter faithfully.
  - **Degraded/long context** — the in-context hold weakens over a long run.
  - **Irreversible-before-selection** — the action fires before any return exists
    to check (problem-space §302 — the irreversibility knife).
- This is a *better* hypothesis than we started with because it's data-driven and
  falsifiable: each region above is a runnable experiment.

---

## 5. Caveats (do not over-read F3)

- Toy scale: 4-option lists, one hop, clean catalog, temp 0, single model, one run.
- **Residue stays invisible** — `lis-residue` is logged `intent-held` only because
  its *encodable* part was satisfiable; the bench cannot see if the window seat was
  honored. "intent-held" overstates it there.
- 10 hand-picked intents ≠ a distribution. The encodable:residue ratio reflects
  the authored table, not the world.
- gpt-4o stands in for the chosen "Sonnet 4.6" (only an OpenAI key was available).
  Model-family effects unmeasured.

---

## 6. Phase-1(b) findings — the drift frontier (OBSERVED)

2×2 sweep: {gpt-4o, gpt-4o-mini} × {full-list return, pick-only return}, 10
intents/cell. Verdicts recomputed against **full-catalog ground truth** via
`analyze.mjs` (independent of what the agent returned — see F7, that gap is the
point). Numbers reproduced identically across two runs.

| cell | intent-held | drift-miss | true-no-match | drift invisible to client |
|---|---|---|---|---|
| gpt-4o / full | 9 | 0 | 1 | 0 |
| **gpt-4o / pick** | **3** | **6** | 1 | **6** |
| gpt-4o-mini / full | 9 | 0 | 1 | 0 |
| **gpt-4o-mini / pick** | **3** | **6** | 1 | **6** |

### F5 · OBSERVED · No-full-list return is the gate's lane (E-B1 confirmed)
When the agent returns **only its own pick** (cheapest) instead of the option
list, intent-held drops **9 → 3** and drift-miss rises **0 → 6** — for *both*
models. The LLM cannot recover constraints when it never sees the alternatives.
This is the shipping "agents-as-tools" reality (problem-space §249), and it is
exactly where an external intent gate has value: the self-recovery that saved the
happy path (F3) is structurally unavailable here.

### F6 · OBSERVED · Model strength does NOT help when the list is withheld (E-B2)
gpt-4o-mini matched gpt-4o **cell-for-cell** (9/0/1 full; 3/6/1 pick). On the
full-list happy path the small model self-recovers just as well; in pick mode it
fails just as hard. **The deciding variable is information availability, not model
capability** — a better model doesn't see what it isn't shown, so it is not a
substitute for the gate. (Cost aside: mini ran each cell for ~$0.001 vs gpt-4o's
~$0.015.)

### F7 · OBSERVED · In the shipping pattern, drift is INVISIBLE to the client
The sharpest result. The client computes "did a match exist?" from **what the
agent returned**. In pick-mode the agent returns one (constraint-violating)
option, so the client logs those 6 real drift-misses as **`true-no-match`** — it
cannot tell "no flight matched" from "a match existed but was withheld." Only the
ground-truth recompute (which knows the whole catalog) recovers the true 6. **The
orchestrator has no local signal that intent was lost.** This is the strongest
argument yet for holding intent on *your* side and checking at the return
boundary: the wire hands you nothing to catch it with (problem-space §272,
"valid ≠ faithful," now measured).

> **Process note:** an earlier draft of F5–F7 stated 2/8 from a recompute script
> that had crashed mid-run; the numbers were not real and were not committed. The
> table above is from `analyze.mjs`, which completes cleanly and reproduces. Flag
> kept as a reminder: never quote a number a script didn't actually print.

---

## 8. Remaining experiments

### E-B3 · LATER · Multi-hop
Add a second sub-agent (hotel) and chain. Measure intent degradation per hop.

### E-B4 · LATER · Un-rigged, scaled intent table (25–30)
Honest encodable:residue ratio on non-cherry-picked asks.

---

## 7. bareagent DX gaps found (report, don't patch)

Surfaced while wiring Phase 1. Neither is a bug; both are onboarding footguns.

- **G1 · Provider export naming.** `bare-agent/providers` exports `OpenAI`,
  `Anthropic`, … but the classes/JSDoc are `OpenAIProvider`, etc. The natural
  `const { OpenAIProvider } = require('bare-agent/providers')` returns `undefined`
  → fails late at `new` with "is not a constructor." Fix: export `*Provider`
  aliases, or make the docs show the exact destructure.
- **G2 · `bareagent.context.md` not in the npm tarball.** The README's quick-start
  says "Read bareagent.context.md from node_modules/bare-agent/…" but the file
  isn't shipped. The advertised onboarding path is broken. Fix: add it to the
  `files` array in bare-agent's `package.json`. (Priority over G1.)
