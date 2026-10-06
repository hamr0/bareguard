---
type: product
title: "rubric — signed, deterministic checks that gate an advance (DRAFT)"
status: draft
---

# rubric — DRAFT design

*2026-10-06. Designed over four rounds by guard (bareguard) and tree-ab (bareloop), with live
evidence from fwd (fwdloop) and loop (bareloop runtime). Replaces this file's first draft
(9a3996f). Nothing is built. **OPEN** marks what is undecided, with options. No versions picked.
Evidence references: `F<n>` = bareloop `docs/logs/FINDINGS.md`; "fwd" = fwdloop live runs as
reported by the fwd session; "loop" = bareloop runtime as reported by the loop session.*

## 0. In one paragraph

A **rubric** is a signed list of checks bound to a goal. A runner (or agent) hands bareguard an
output at a named **checkpoint**; bareguard runs the checks, **mints a verdict** (green /
soft-green / red), records it, and hands back a **gap** (what is missing, as structured data). At
a checkpoint the operator marks as **gating**, the advance action is denied while the verdict is
red. bareguard runs no model: deterministic checks are its own code, and a judge is a function
the caller passes in, which may only locate quotes (default) or, as an escape hatch, give a
verdict that can never make the result green alone. The loop (order, retries, replanning,
cadence, caps) stays outside bareguard.

## 1. Boundary and laws

**Boundary (RULED — hamr, 2026-10-06).** Old: "bareguard never runs an LLM and never judges: you
compute the fact." New: **"bareguard never runs an LLM; it checks deterministic facts against
declared, enumerated rules."**

**Red denies "done" (PROPOSED — guard taking to hamr).** It narrows the stated law "a guess never
drives a deny". Argument: denying an *advance* is not an action on the world; a false red costs a
retry, a false green ships a wrong result. So at a gating checkpoint any red denies the advance,
deterministic or judge.

**Laws the design keeps (each from evidence):**
1. **Unsure = red.** A missing field, wrong type, throwing getter, judge crash, malformed judge
   reply, timeout or unknown price is red, never green.
2. **Checks sit outside the agent.** The worker never sees its rubric; a retry gets only the gap
   (fwd; loop). Enforced by construction (§6).
3. **Checks are derived from the signed rubric, never hand-authored beside it** (F58: a
   separately written check drifted lenient).
4. **Never widen a check to turn red green** (fwd). Exact headings are case-sensitive;
   `mustCarry` is exact.
5. **Typed fields only, no free text decides, no user regex** (fwd; F198: a gap parsed out of
   prose broke).
6. **Text explains a red, never decides one.** Every check's `text` is the signer's words.
7. **Tamper = deny.** An unsigned or hash-mismatched rubric is refused at load (F132).

### Where the old line is stated (to update)

| Where | Line | Text |
|---|---|---|
| `README.md` | 115, 118 | "never runs an LLM and never judges: you compute the fact" + code comment |
| `bareguard.context.md` | 1043 | "You compute the fact (a deterministic check, or a caller-side LLM judge …" |
| `src/gate.js` | 1392 | `annotate` JSDoc "bareguard NEVER computes the fact (no LLM)" |
| `src/gate.js` | 189 | `routeAnnotation` "No LLM, no side effects" (still true) |
| `types/gate.d.ts` | 3, 352 | generated from the two above |
| `primitives.json` | `annotate`, `routeAnnotation` entries | generated `when`/`fails` text |
| `docs/product/bareguard-prd.md` | 79–80, 197–217 | §0 "the one boundary", Part 1 §6 action-vs-content |
| `docs/wiki/axis-b.md` | 139, 164–166 | "the check stays the caller's"; "no text scan" |

**§6 tension (OPEN).** Part 1 §6 says bareguard never constrains words the model produces. Shape
checks (`maxWords`, `sections`) and `quoteIn` read output text. Options: **A.** amend §6 to
"bareguard may measure declared, deterministic properties of an output; it never interprets
meaning"; **B.** keep §6 and put rubric in a separate entry point (`bareguard/rubric`) that the
action gate only consumes verdicts from. Lean **A** — B is the same code with a fence of words.

## 2. The rubric object

```js
{
  schema: 1,
  goal: "<the signed goal line, verbatim>",          // set by the machine from the signed text (fwd F50)
  inputs: [{ name: "resume", sha256: "…" }, …],       // frozen sources the checks may cite
  judge: { provider: "…", model: "…" } | null,        // identity; a model bump forces a re-sign
  checkpoints: {
    "<id>": { gating: true|false, checks: [ Check, … ] },
  },
  onExhausted: "fail" | "ask",                        // default "fail"
  maxReds: <int>,                                     // gate-side backstop count (§5)
}
```

`rubricSha(rubric)` = sha256 over a canonical serialization of **everything above**. Signing is
the caller's (bareloop's sign, fwdloop's signed text); bareguard receives `{ rubric, sha256 }`
and refuses a mismatch. bareloop signs its whole job spec; a bareloop rubric is a projection of
that spec and its hash must cover the same fields (goal, checks, judge identity, inputs, schema).

**Drafting.** A caller-supplied model may draft checks from the goal; they bind only once signed.
A drafted line that maps to no owned rule is **red at drafting**, never bent onto the nearest
rule (F159). A check that contradicts its own goal line is red at drafting (fwd amendment 6;
e.g. "under 600 words" with three "250ish" sections).

## 3. Checks — the v1 vocabulary

All deterministic checks are bareguard's own code. Each reads a declared field of the output or a
value the caller passes; none parses prose in general.

| Rule | Params | Green when | Evidence |
|---|---|---|---|
| `nonEmpty` | `field` | non-empty string / array / object with ≥1 own key | fwd happened-check; bareloop base rule 1 |
| `maxWords` / `minWords` | `field`, `value` | word count ≤ / ≥ value. **Word** = non-empty token after splitting the raw text on `/\s+/`, markdown markers included | fwd: "633 words, limit 600" |
| `maxLines` | `field`, `value` | `\n`-separated non-empty lines ≤ value | fwd |
| `sections` | `field`, `names:[…]` | every name is an ATX heading text in the output | fwd; bareloop item 33 |
| `sectionOrder` | `field`, `names:[…]` | those headings appear in that order (by line position) | fwd |
| `mustCarry` | `field`, `text` | exact substring present (no normalization) | fwd |
| `in` / `notIn` | `field`, `values:[…]` | value `===` one of / none of | OQ1 membership (litectx) |
| `atMost` | `field`, `value`, `order:[…]` | ordered-enum rank ≤ value's | OQ1 threshold (litectx) |
| `max` / `min` | `field`, `value` | finite number ≤ / ≥ | bareloop "total under $400" |
| `notWorse` | `value` (caller-measured count), `baseline`, `direction` | not worse than baseline in the signed direction | loop: the repeat live winner (F99 67→8→1→0, F198) |
| `cited` | `claims` field, `source` input name | every claim's quote passes `quoteIn` against the frozen input AND `numbersInQuote` | F161 |
| `complete` | `items` (signed list) or `split` (declared: `"line"` / `"heading"`) | every item is covered by a claim | F155 |
| `judged` | `kind: "locate"|"verdict"`, `ask` | see §4 | — |

**Headings** = ATX only: a line matching `^#{1,6} +(.+?) *#*$`, the capture compared exactly and
case-sensitively. No setext, no HTML, no bold-as-heading. No ATX heading in the output → red "no
headings found".

**`quoteIn(quote, source)`** — collapse whitespace (`\s+` → one space, trim) and strip `**` and
`__` on both sides, then substring containment. That is all F161 needed (a judge dropped `**`);
every further loosening (case-fold, NFC, list markers, single `*`/`_`) is a false-pass risk with no
evidence. Substring, not line-wise: a CV summary is one line. Empty quote = red.

**`numbersInQuote(claim, quote)`** — number tokens are `/\d+(?:\.\d+)?/g`; every token in the claim
must appear as a token in the quote (token match: `8` does not match `2018`). `8x`→8, `1.2k`→1.2,
`50%`→50, `2 weeks`→2. Number words ("three") are deliberately unchecked — a documented gap.
Known false red: `1,200` vs `1200`. **OPEN:** strip thousands separators first (no evidence either
way).

**`notWorse` baseline (OPEN).** bareguard never runs the command and never parses its output; the
caller measures and passes an integer. Options for the baseline: **A.** a literal in the signed
rubric (`baseline: 0`); **B.** `"seed"` — the caller measures once before signing and the seed
value is written into the rubric, so it is hashed; **C.** passed per call. Lean **A + B**; reject C
(an unsigned baseline is a tamper path). `direction` (`lower-is-better` / `higher-is-better`) is
a signed field, never inferred (bareloop v1.82).

**Unknown rule** — construct-time throw naming the key; a post-construction swap to an invalid
shape denies at the gate with `rubric.invalid` (the `<key>.invalid` family).

**Which checks are always on** — see §3a.

**Code-job checks (OPEN).** loop's other repeat winner is `no-suppressions` (F87/F81/F99/F134:
added `any`/casts/disables caught after the step was green). It is language-specific pattern
matching over a diff. Options: **A.** caller computes it and passes a count → it is just
`notWorse` with baseline 0; **B.** a built-in rule with a signed, enumerated pattern set. Lean
**A** — it keeps bareguard out of language syntax and no user regex.

## 3a. Foundational vs opt-in checks (V2)

**Foundational — run at EVERY checkpoint, whether or not the rubric lists them:**

| Check | Red when |
|---|---|
| `happened` | the output is missing, `null`, empty, or unreadable (throwing getter / Proxy) |
| `clean` | a judge call threw, timed out, returned a malformed reply (after its one retry), or was unpriced |
| `quoteIn` on every judge quote | a quote the judge returned is not in the frozen input it names |
| `numbersInQuote` on every claim–quote pair | a number in a claim is missing from the quote cited for it (applies only where the judge pairs a quote with a claim, e.g. not to a bare doc-comment locate) |
| `agree` | `reads > 1` and the reads' decided outcomes differ (§4) |
| `signed` | (at load) the rubric is unsigned or its sha mismatches |

**Opt-in — run only when listed:** the shape set (`maxWords`, `minWords`, `maxLines`,
`sections`, `sectionOrder`, `mustCarry`), `notWorse`, `in` / `notIn` / `atMost`, `max` / `min`,
`complete`, `judged`.

**A signed rubric cannot switch a foundational check off — tighten-only.** A rubric may add
checks, never remove these. A checkpoint whose legitimate output is "nothing found" must still
return a non-empty, declared shape (e.g. `{ found: [] }` with `nonEmpty` read on the object, not
the list) — "empty because done" and "empty because it never ran" must not look the same.

## 4. Judges

bareguard owns no model. The caller passes `judge` per call. Two kinds:

| Kind | Contract | Who decides | Its green |
|---|---|---|---|
| `locate` (default) | `judge(input, check, {signal}) → { quotes:[…], facts:{…} }` | bareguard's deterministic rule over the quotes (`quoteIn`, `numbersInQuote`, `complete`) | counts as **soft-green** |
| `verdict` (escape hatch) | `judge(…) → { verdict: "honored"|"broke", quote, why }` | the judge | **never green alone** — at best soft-green, and its red denies |

Why locate is the default: bareguard's own A/B (quoted in bareloop `src/judged.js`'s header) —
"`judgeVerdict` is injectable, `judgeLocate` is not". A model asked "did it pass?" can be argued
with; one asked "quote me the line" cannot.

**Call hygiene (loop, F148/F152/F154; ~1 in 6 malformed on haiku):**
- `deadlineMs` is **required** whenever a judge is passed; missing → `checkStep` throws (a
  programming error, not a red). bareguard passes an `AbortSignal`. **OPEN:** a default deadline
  instead of a throw.
- Exactly **one retry** on malformed reply or timeout. **Never repair** a reply.
- Unpriced → red, never retried (bareloop's `pricing-red`).
- What the judge said is kept: the quote's start (clipped), its original length and the sha256
  of the full quote — enough to tell a judge error from a rule error (F192's record kept neither
  and the cause stayed unknown).

**Repetition — `judge.reads: N` (V1).** The evidence so far is thin and stated as such: two reads
+ agree is a draft only (bareloop PRD R6, no data); the one measured instability is the POC's
`paramNames` drifting between reps on the same file (bareloop `src/judged.js` header).

- The locate judge is called **N times**, each an independent call (prompt caching is fine;
  replaying a cached *response* is not — N identical replays measure nothing).
- The deterministic decide runs on **each** read's quotes. Each read yields a decided outcome:
  the verdict plus the set of reds keyed `(check, item)` — the same `(rule, fn)` shape bareloop's
  calibration compares.
- **Compare decided outcomes, not raw quotes.** Two honest reads may quote different spans or drop
  a `**` (F161) and still decide the same; comparing text would red honest work. Comparing
  outcomes catches what matters: green vs red, or red for a different reason (a red on `add` vs
  a red on `sub` is a disagreement — "right verdict, wrong reason is luck").
- Any difference → red `agree` ("judges disagree", with each read's outcome in the full view).
  Any read unsure → red. A read's malformed reply gets its own one retry before counting.
- `verdict`-kind judges compare `verdict` only (there is nothing else decided); since their green
  is never green alone, `reads` matters mainly for their reds.
- Cost = N × judge calls, each reported through the existing budget path; the minted record says
  how many reads ran.
- **Default N — OPEN.** Options: **1** (no repetition; cheapest); **2** at gating checkpoints with
  a judge, 1 elsewhere; **3** for majority-free unanimity with more power. **Lean 2 at gating
  checkpoints, 1 elsewhere**: it doubles cents-level cost only where a wrong green would ship, and
  2 is the smallest N that can disagree at all.

**Repetition vs calibration.** They measure different failures and neither replaces the other.
Calibration = **accuracy** against known answers, once, before signing — it catches a judge that
is *consistently* wrong, which repetition cannot (N wrong reads agree). Repetition = **stability**
on *this* live input, every run — it catches a judge that is right on the calibration set but
flaky here, which calibration cannot. When calibration lands, it should grade each case `reads`
times and require all N correct, so the signed set certifies the same configuration that runs.

**Calibration — later.** It has never passed live (F159 1/10, F192 6/10). The judge identity is in
the hash now, so a model bump forces a re-sign. Consequence: an uncalibrated judge's soft-green is
acceptable only because the final ACCEPT exists (§5).

## 5. Verdicts, the advance and the two human moments

**Three verdicts (U2):**
- **green** — every check deterministic and green.
- **soft-green** — every check green, at least one involved a judge. Carries a flag. In bareloop
  terms it mints, and what it withholds is learning credit, not "done" (loop).
- **red** — any check red.

At a **gating** checkpoint the advance is allowed on green and soft-green, denied on red.
Non-gating checkpoints record and return gaps but never deny (loop: red-denies-advance applies to
the close verdict, never to step exits — F87, F212).

**Two human moments, both kept:** **SIGN** the rubric before; **ACCEPT** the result after. A
soft-green result must be confirmed at ACCEPT. **RULED (hamr, 2026-10-06):** with no ACCEPT
moment configured, soft-green cannot be final — **fail closed** (it behaves as red at the last
gating checkpoint).

**Exhaustion.** The loop owns retries and strikes. The gate also counts reds per
`(rubricSha, checkpointId)` as a backstop (`maxReds`), reusing budget's countable resources,
reset on re-sign or ACCEPT. On exhaustion: `onExhausted: "fail"` (default, **RULED by hamr 2026-10-06** — terminal red;
bareloop calls it `escalated`, and the human still sees it at the end door) or `"ask"` (for loops
with no end door). The machine never adds an ask by default (fwd: asks sit only at signed
positions).

## 6. Mechanics

**Checkpoints (U6).** bareguard knows neither "close" nor "step". The operator names checkpoints
and marks which gate the advance; bareloop maps its close → gating, step exits → non-gating.

**Flow (U4 — runner mints, gate reads):**
1. Runner (or agent) calls `checkStep(rubric, checkpointId, output, { judge, deadlineMs })`.
2. bareguard runs the checks, mints `{ verdict, gaps, outputSha }`, records it (audit) keyed by
   `(rubricSha, checkpointId)`.
3. The advance action — an action type the operator lists in `rubric.advanceOn` — carries
   `{ checkpoint, outputSha }`. `gate.check` looks up the minted verdict for that key and
   **denies if** none exists, it is red, or `outputSha` differs from the minted one (stops
   "check output A, advance output B").
Big outputs never enter the action or the audit line. Either an agent or a runner may send the
advance; the gate does not care which.

**Gap view by construction (T3).** Each red produces two views:
- **gap** — `{ checkpoint, check, field, measured, limit }`, e.g. `{check:"maxWords", measured:633,
  limit:600}`. No rule text, no other checks. Read through a new accessor (`gate.drainGaps()`) or
  `checkStep`'s return.
- **full** — everything, for the audit line and the human.
The safe view is the easy one. `drainAnnotations` keeps its shape (SemVer).

**Audit bounds.** Quotes and sources never go on an audit line whole. Gap and full views are
bounded at the source, redacted, then line-capped by the existing `LINE_FIELDS` path
(`MAX_LINE_BYTES` 3500). New rows needed for any new top-level field (e.g. `outputSha`,
`rubricSha` — fixed-length hex, `clip`).

**Interactions.** Independent of `rwx` / `tools.allowlist` mode (`advanceOn` keys on
`action.type`). A check spends no budget; a judge call's cost is the caller's to report through
the existing budget path. `humanChannel` is reached only via `onExhausted: "ask"` or the existing
Axis B routing.

**Security.** No user regex anywhere (no ReDoS). Config read as own keys on a null-prototype copy;
`__proto__`/`constructor`/`prototype` field names refused at construct. Never throws because of
the output (any shape, any getter) — a read failure is a red. An audit write failure still
propagates. `quoteIn` is linear in source size with a size cap (**OPEN:** the cap; over it = red).

## 7. Axis B cleanup (U5)

| Item | Status | Note |
|---|---|---|
| `gate.annotate` | **KEEP** — transport | Live adopter: bareagent `judgeToAnnotation` (`src/bareguard-adapter.js:478`) maps to its envelope; the envelope shape cannot change |
| `drainAnnotations` | **KEEP** | unchanged; gaps get their own accessor |
| `routeAnnotation` | **KEEP**, reword | still routes caller facts; rubric's advance gating is a separate path |
| `axisB.reversible` / `reversibleEscalation` | **KEEP** | apply to annotate routing only; rubric ignores them |
| OQ1 (constraint format) | **REWORDED** | becomes rubric's `in`/`notIn`/`atMost` — the deterministic rule subset |
| OQ3 (budget resources, soft tier) | **KEEP**, re-file | shipped 0.7.0; it is Axis A budget, not Axis B; rubric's red count reuses it |
| Trial-first dry-run lane (releases-roadmap.md:383) | **DROP** | proposed, never built; hamr: will never happen |
| `harness-code-mode/` + code-mode execution | **DROP** from roadmap | archive the POC (E1–E6 evidence), don't delete |
| D8 harness selection (harness-design.md:100, 161) | **DROP** | proposed; a runner concern, never bareguard's |

Unaffected adopters: litectx gates through `flags` (Axis A), not Axis B. bareloop does not call
`annotate` (deliberately unwired, `src/kinds.js:1741`, because it never buys a verdict).

## 8. Exports and SemVer surface

| Kind | Added |
|---|---|
| exports | `createRubric(spec)`, `rubricSha(spec)`, `checkStep(rubric, checkpointId, output, opts)`, `quoteIn(quote, source)`, `numbersInQuote(claim, quote)` |
| gate methods | `drainGaps()` |
| config keys | `rubric: { spec, sha256 }`, `rubric.advanceOn`, `onExhausted`, `maxReds` |
| rule strings | the §3 table; deny rules `rubric.invalid`, `rubric.red`, `rubric.unminted`, `rubric.output-mismatch`, `rubric.exhausted` (names **OPEN**) |
| audit | a `rubric` phase carrying `rubricSha`, `checkpoint`, `verdict`, `outputSha`, bounded `gaps` |
| types | `Rubric`, `Check`, `Gap`, `LocateJudge`, `VerdictJudge` (JSDoc typedefs) |
| primitives.json | entries for the five exports + `drainGaps` |

Name: **rubric** (avoids bareloop's "close").

## 9. Test plan

- Every rule: green, red, and **falsify-by-revert** (flip the comparison, the test must fail).
- Thresholds: AT / UNDER / OVER (`600` words vs `maxWords 600` green; `601` red).
- `sections`: case differs → red; setext heading → not a heading; no headings → red.
- `quoteIn`: F161's `**` case green; reflowed spaces green; a changed word red; empty quote red.
- `numbersInQuote`: the F161 "8x" vs "2 weeks → 4 hours" case red; `2018` does not satisfy `8`.
- `complete`: F155's omitted item red.
- Judge: malformed once then good → green; malformed twice → red; hang → timeout red via
  `AbortSignal`; unpriced → red, no retry; verdict-kind green alone → soft-green, never green.
- Gate: unsigned rubric / tampered sha → refused; advance with no minted verdict → deny;
  `outputSha` mismatch → deny; red → deny; soft-green with no ACCEPT configured → deny at the last
  gating checkpoint; `maxReds` reached → `onExhausted` honored; count resets on re-sign.
- Hostile output: throwing getter, Proxy, `__proto__` keys, 10 MB value → red / bounded line,
  never a throw.
- Byte-identical decision path when `rubric` is unset.

## 10. Day 1 vs later

| | What |
|---|---|
| **Day 1** | `quoteIn`, `numbersInQuote` (pure; agents use them now) · shape rules + `nonEmpty` + `notWorse` in `checkStep` · `createRubric` / `rubricSha` · gating checkpoint + `outputSha` match · gap view · `onExhausted: "fail"` |
| Next | `locate` judge in `checkStep` (deadline, one retry, clipped quote) · foundational `clean` / `quoteIn` / `numbersInQuote` on judge quotes · `cited` / `complete` · soft-green + ACCEPT fail-closed · `reads: N` + `agree` |
| Later | `verdict` judge · `agree` · calibration in the hash · `onExhausted: "ask"` |

## 11. Still OPEN (summary)

1. §6 amendment (A) vs a separate entry point (B).
2. hamr's ruling on "red denies done".
3. `notWorse` baseline: literal + seed (lean) vs per call.
4. `no-suppressions`: caller-computed count (lean) vs built-in pattern set.
5. Judge deadline: required (lean) vs a default.
6. Thousands separators in `numbersInQuote`.
7. `quoteIn` source size cap.
8. Deny rule names.
9. Default `judge.reads` (lean 2 at gating checkpoints with a judge, 1 elsewhere).
