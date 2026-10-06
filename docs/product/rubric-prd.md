---
type: product
title: "rubric — signed, deterministic checks that gate an advance (DRAFT)"
status: draft
---

# rubric — DRAFT design

*2026-10-06. Designed over four rounds by guard (bareguard) and tree-ab (bareloop), with live
evidence from fwd (fwdloop) and loop (bareloop runtime). Replaces this file's first draft
(9a3996f). Nothing is built. Every point once left undecided was ruled by hamr on 2026-10-06 and
is marked RULED in place (summary in §12). No versions picked.
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

## 1. How it works

*For a reader who forgot everything. Detail lives in the sections named below.*

**Three roles.**
- The **runner** (bareloop, fwdloop, any harness) writes the rubric draft, drives the agent and calls bareguard.
- The **human** signs the rubric before the work and accepts the result after.
- **bareguard** grades and gates. It never runs a model.

**The flow.**
1. A drafting LLM (the caller's) reads `rubricVocabulary` and drafts a rubric spec from the goal,
   using only the listed check types.
2. `createRubric(spec)` validates it. An unknown check type, or a line that maps to no check, is
   refused at draft time — never bent onto the nearest rule (bareloop F159).
3. The human signs. `rubricSha(spec)` is the fingerprint both sides compute. A model or cutoff
   change means re-sign.
4. The agent works. It never sees the rubric.
5. The runner calls `checkStep(rubric, checkpoint, output, { judge?, deadlineMs })`: the fixed
   checks run, then the judge if any. It mints green / soft-green / red plus a structured gap.
6. The agent or runner sends the advance action `{ type: <advanceOn>, checkpoint, outputSha }`
   through `gate.check`. The Axis A floor runs first (Law 9); then the advance is denied if there
   is no minted verdict, the verdict is red, or the sha does not match.
7. On red, the loop retries and is fed ONLY the gap (`gate.drainGaps()`). After `maxReds` the
   `onExhausted: "fail"` rule applies.
8. At the end the human ACCEPTs. A soft-green is only final after ACCEPT; with no accept moment
   configured it fails closed.

```
goal -> drafter reads rubricVocabulary -> spec -> createRubric -> human signs (rubricSha)
agent works -> output -> checkStep -> green | soft-green | red + gap
   advance action -> gate.check: floor -> verdict lookup -> allow | deny
   red -> retry with gap only (drainGaps) ... maxReds -> onExhausted
end -> human ACCEPT
```

**The parts.**

| Part | What it is |
|---|---|
| `createRubric(spec)` | validates a spec; throws on an unknown check type or bad shape (§3, §4) |
| `rubricSha(spec)` | sha256 over the canonical spec; the signed fingerprint (§3) |
| `checkStep(rubric, checkpoint, output, opts)` | runs the checks (and the judge), mints the verdict and gap (§7) |
| `quoteIn(quote, source)` | pure: is the quote in the source, whitespace and `**` forgiven (§4) |
| `numbersInQuote(claim, quote)` | pure: does every number in the claim appear in the quote (§4) |
| `rubricVocabulary` | frozen, machine-readable list of every check type, its fields and meaning — what a drafter reads (§9) |
| `gate.drainGaps()` | read-and-clear the gap view for the retry (§7) |
| config `rubric` | `{ spec, sha256 }` — the signed rubric the gate holds (§9) |
| config `advanceOn` | the action type(s) that count as "advance" (`rubric.advanceOn`, §7) |
| config `onExhausted` | `"fail"` (default) or `"ask"` when reds run out (§6) |
| config `maxReds` | gate-side cap on reds per `(rubricSha, checkpoint)` (§6) |

**The check shapes.** Every type, one line; exact rules in §4 and §4a.

*Foundational (always on, cannot be switched off):*
- `happened` — the output exists and is readable.
- `clean` — no judge crash, timeout, malformed reply or unpriced call; a `locate` judge returned quotes.
- `quoteIn` on every judge quote — the quote is really in the frozen input.
- `numbersInQuote` on every claim–quote pair — the claim's numbers are in its quote.
- `agree` — when `reads > 1`, every read decided the same.
- `signed` — at load, the rubric is signed and its sha matches.

*Opt-in (only when listed):*
- `nonEmpty` — field has content.
- `maxWords` / `minWords` — word count bound.
- `maxLines` — non-empty line count bound.
- `sections` — each named heading is present.
- `sectionOrder` — those headings appear in order.
- `mustCarry` — an exact substring is present.
- `in` / `notIn` — value is / is not one of a list.
- `atMost` — ordered-enum rank at or below a value.
- `max` / `min` — number bound.
- `notWorse` — caller-measured count not worse than a signed baseline.
- `cited` — every claim's quote is in the frozen input with its numbers.
- `complete` — every item of a signed list is covered by a claim.
- `judged` — `locate` or `verdict` judge question (§5).

**Worked example.** A résumé step: at most 600 words, two headings, one judged question.

```js
// signed spec (hash covers all of it, judge identity included)
const spec = { schema: 1, goal: "Write the résumé", inputs: [],
  judge: { provider: "jev", model: "jev-1.13.0", cutoff: 0.5, band: 0.1 },
  checkpoints: { resume: { gating: true, checks: [
    { rule: "maxWords", field: "text", value: 600 },
    { rule: "sections", field: "text", names: ["Summary", "Skills"] },
    { rule: "judged", kind: "verdict", ask: "Does the skills section list only skills?" } ] } },
  onExhausted: "fail", maxReds: 3 };
const rubric = createRubric(spec);          // human signs rubricSha(spec)
const r = await checkStep(rubric, "resume", output,
  { judge: jevVerdictJudge({ jev }), deadlineMs: 20000 });
// 633 words -> { verdict: "red",
//   gaps: [{ checkpoint: "resume", check: "maxWords", field: "text", measured: 633, limit: 600 }] }
// trimmed to 580 words, jev says "honored" -> { verdict: "soft-green" }  (final only after ACCEPT)
```

## 2. Boundary and laws

**Boundary (RULED — hamr, 2026-10-06).** Old: "bareguard never runs an LLM and never judges: you
compute the fact." New: **"bareguard never runs an LLM; it checks deterministic facts against
declared, enumerated rules."**

**Red denies "done" — RULED (hamr, 2026-10-06): YES.** Any red, deterministic or judge, denies
the advance at a gating checkpoint, bounded by Law 9 (it only ever adds a deny). It narrows the stated law "a guess never
drives a deny". Argument: denying an *advance* is not an action on the world; a false red costs a
retry, a false green ships a wrong result. So at a gating checkpoint any red denies the advance,
deterministic or judge.

**Laws the design keeps (each from evidence):**
1. **Unsure = red.** A missing field, wrong type, throwing getter, judge crash, malformed judge
   reply, timeout or unknown price is red, never green.
2. **Checks sit outside the agent.** The worker never sees its rubric; a retry gets only the gap
   (fwd; loop). Enforced by construction (§7).
3. **Checks are derived from the signed rubric, never hand-authored beside it** (F58: a
   separately written check drifted lenient).
4. **Never widen a check to turn red green** (fwd). Exact headings are case-sensitive;
   `mustCarry` is exact.
5. **Typed fields only, no free text decides, no user regex** (fwd; F198: a gap parsed out of
   prose broke).
6. **Text explains a red, never decides one.** Every check's `text` is the signer's words.
7. **Tamper = deny.** An unsigned or hash-mismatched rubric is refused at load (F132).
8. **Decisive binary, never a score.** Every answer that decides is binary: a `verdict` judge
   returns `honored` / `broke`; a `locate` judge's quotes feed a deterministic decide that is also
   binary. No confidence, no 1–10, no probability anywhere in the rubric contract — models hedge
   near a threshold, and over-surfacing is fixed with stronger decisive buckets, never carve-outs.
   A judge reply that carries a score instead of the verb is **malformed = red** (`clean`).
9. **The floor is the ceiling.** The rubric can only ADD a deny. It never allows what Axis A
   (deny / ask / allowlist / rwx / budget / fs / net) denies or asks: a green or soft-green verdict
   never turns an Axis A deny or ask into an allow. Order at `gate.check` on an advance action:
   the Axis A floor runs first; the rubric verdict runs after it and can only deny. The same holds
   for config: a rubric cannot widen an fs/net scope, raise a budget, or add an allowlist entry.

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

**Part 1 §6 amendment (bareguard-prd) — RULED (hamr, 2026-10-06): A.** Part 1 §6 said bareguard never constrains words
the model produces, but shape checks (`maxWords`, `sections`) and `quoteIn` read output text. §6
is amended to: **"bareguard may measure declared, deterministic properties of an output; it never
interprets meaning."** The rubric code lives in its own module, and the Axis A floor never
imports judge code. (Rejected: B, keeping §6 and fencing rubric behind a separate entry point —
the same code with a fence of words.)

## 3. The rubric object

```js
{
  schema: 1,
  goal: "<the signed goal line, verbatim>",          // set by the machine from the signed text (fwd F50)
  inputs: [{ name: "resume", sha256: "…" }, …],       // frozen sources the checks may cite
  judge: { provider, model, cutoff?, band? } | null,   // identity; any change forces a re-sign
  checkpoints: {
    "<id>": { gating: true|false, checks: [ Check, … ] },
  },
  onExhausted: "fail" | "ask",                        // default "fail"
  maxReds: <int>,                                     // gate-side backstop count (§6)
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

## 4. Checks — the v1 vocabulary

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
| `judged` | `kind: "locate"|"verdict"`, `ask` | see §5 | — |

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
Known false red: `1,200` vs `1200`. **Thousands separators — RULED (hamr, 2026-10-06): not
stripped.** The false red stays as a documented gap (Law 4: never widen to turn red green).

**`notWorse` baseline — RULED (hamr, 2026-10-06): A + B; C rejected.** bareguard never runs the command and never parses its output; the
caller measures and passes an integer. The baseline is either **A.** a literal in the signed
rubric (`baseline: 0`) or **B.** `"seed"` — the caller measures once before signing and the seed
value is written into the rubric, so it is hashed. Both are signed. **C.** (passed per call) is
rejected: an unsigned baseline is a tamper path. `direction` (`lower-is-better` / `higher-is-better`) is
a signed field, never inferred (bareloop v1.82).

**Unknown rule** — construct-time throw naming the key; a post-construction swap to an invalid
shape denies at the gate with `rubric.invalid` (the `<key>.invalid` family).

**Which checks are always on** — see §4a.

**Code-job checks — RULED (hamr, 2026-10-06): A.** loop's other repeat winner is
`no-suppressions` (F87/F81/F99/F134: added `any`/casts/disables caught after the step was green).
It is language-specific pattern matching over a diff, so the caller computes it and passes a
count: it is `notWorse` with baseline 0. This keeps bareguard out of language syntax and free of
user regex. (Rejected: B, a built-in rule with a signed, enumerated pattern set.)

## 4a. Foundational vs opt-in checks (V2)

**Foundational — run at EVERY checkpoint, whether or not the rubric lists them:**

| Check | Red when |
|---|---|
| `happened` | the output is missing, `null`, empty, or unreadable (throwing getter / Proxy) |
| `clean` | a judge call threw, timed out, returned a malformed reply (after its one retry), or was unpriced; a `locate` judge returned no quotes; a `verdict` judge returned no verb or no raw answer |
| `quoteIn` on every judge quote | a quote the judge returned is not in the frozen input it names (a verdict judge may return none; a locate judge may not) |
| `numbersInQuote` on every claim–quote pair | a number in a claim is missing from the quote cited for it (applies only where the judge pairs a quote with a claim, e.g. not to a bare doc-comment locate) |
| `agree` | `reads > 1` and the reads' decided outcomes differ (§5) |
| `signed` | (at load) the rubric is unsigned or its sha mismatches |

**Opt-in — run only when listed:** the shape set (`maxWords`, `minWords`, `maxLines`,
`sections`, `sectionOrder`, `mustCarry`), `notWorse`, `in` / `notIn` / `atMost`, `max` / `min`,
`complete`, `judged`.

**A signed rubric cannot switch a foundational check off — tighten-only.** A rubric may add
checks, never remove these. A checkpoint whose legitimate output is "nothing found" must still
return a non-empty, declared shape (e.g. `{ found: [] }` with `nonEmpty` read on the object, not
the list) — "empty because done" and "empty because it never ran" must not look the same.

## 5. Judges

bareguard owns no model. The caller passes `judge` per call. Two kinds:

**Quote rule (RULED, hamr, 2026-10-06).** A `locate` judge MUST return quotes; none = red. A
`verdict` judge's quote is OPTIONAL (a classifier such as jev cannot quote), but it must return a
decisive verb and its raw answer; no verb, or a score instead of a verb, is malformed = red. A quote a
verdict judge does return is still checked with `quoteIn`.

| Kind | Contract | Who decides | Its green |
|---|---|---|---|
| `locate` (default) | `judge(input, check, { signal, identity }) → { quotes:[…], facts:{…} }` | bareguard's deterministic rule over the quotes (`quoteIn`, `numbersInQuote`, `complete`) | counts as **soft-green** |
| `verdict` (escape hatch) | `judge(input, check, { signal, identity }) → { verdict: "honored"|"broke", raw, quote?, why? }` (`identity` = the signed `{ provider, model, cutoff?, band? }`, handed in by `checkStep`) | the judge | **never green alone** — at best soft-green, and its red denies |

Why locate is the default: bareguard's own A/B (quoted in bareloop `src/judged.js`'s header) —
"`judgeVerdict` is injectable, `judgeLocate` is not". A model asked "did it pass?" can be argued
with; one asked "quote me the line" cannot.

**Call hygiene (loop, F148/F152/F154; ~1 in 6 malformed on haiku):**
- `deadlineMs` is **required** whenever a judge is passed; missing → `checkStep` throws (a
  programming error, not a red). bareguard passes an `AbortSignal`. **RULED (hamr, 2026-10-06):**
  required, no default — missing = throw; at the gate, unset = deny.
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
- **Default N — RULED (hamr, 2026-10-06): 2 at gating checkpoints with a judge, 1 elsewhere.**
  It doubles cents-level cost only where a wrong green would ship, and 2 is the smallest N that
  can disagree at all.

**Repetition vs calibration.** They measure different failures and neither replaces the other.
Calibration = **accuracy** against known answers, once, before signing — it catches a judge that
is *consistently* wrong, which repetition cannot (N wrong reads agree). Repetition = **stability**
on *this* live input, every run — it catches a judge that is right on the calibration set but
flaky here, which calibration cannot. When calibration lands, it should grade each case `reads`
times and require all N correct, so the signed set certifies the same configuration that runs.

**Calibration — later (bareguard's own).** It has never passed live (F159 1/10, F192 6/10). The judge identity is in
the hash now, so a model bump forces a re-sign. The one already-calibrated judge is jev, admitted by
bareagent's `calibrateJev` (below). Consequence: an uncalibrated judge's soft-green is
acceptable only because the final ACCEPT exists (§6).

### Using bareagent's jev as a verdict judge

*RULED (hamr, 2026-10-06): jev is a real, already-calibrated user, so the `verdict` judge moves to
Next.*

- **Structural only.** bareguard never names or calls jev; the caller passes a judge function.
  bareguard does not import bareagent and bareagent does not require bareguard.
- **The adapter lives in bareagent.** A small adapter, named here as an example only:
  `jevVerdictJudge({ jev })`. It takes `cutoff` and `band` from the `identity` that `checkStep`
  passes in the call (the SIGNED values), never from its own arguments. It asks jev a `noul` question about the output and
  maps the probability: `>= cutoff + band` -> `"honored"`, `<= cutoff - band` -> `"broke"`, inside
  the band -> unsure -> red. It returns the raw jev answer for the record (F192 lesson). The
  probability is **never** part of the decision contract (Law 8): only the verb decides.
- **Identity in the hash.** The signed judge identity includes provider, model, cutoff and band;
  any change forces a re-sign. The signed model must be a pinned version (e.g. `jev-1.13.0`),
  never a moving alias like `jev-latest` / `jev-preview`.
- **Signed = running.** `checkStep` hands the judge the signed identity in every call. The adapter
  refuses (red, `clean`) if `identity.model` differs from the jev model it is actually configured
  with, so the cutoff that runs is always the signed one.
- **Admission before signing.** bareagent's `calibrateJev` must have admitted that jev model tier
  (bareagent's job). bareguard's own calibration stays Later and should borrow `calibrateJev`'s
  design: frozen known-answer cases, an injection battery, and a negative control that must fail.
- **Deadline.** `JevProvider` has no AbortSignal and its own timeout option. bareguard enforces
  `deadlineMs` by no longer waiting (a race) and records a timeout red; jev's own timeout is a
  second backstop.
- **Cost** flows through bareagent's existing `onLlmResult` / budget path.
- **Who builds what.** bareguard = the verdict-judge slot in `checkStep`; bareagent = the adapter
  (about 30 lines).

## 6. Verdicts, the advance and the two human moments

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

## 7. Mechanics

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
propagates. `quoteIn` is linear in source size with a size cap: **5 MB** (RULED, hamr, 2026-10-06); over it = red "source too large".

## 8. Axis B cleanup (U5)

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

## 9. Exports and SemVer surface

| Kind | Added |
|---|---|
| exports | `createRubric(spec)`, `rubricSha(spec)`, `checkStep(rubric, checkpointId, output, opts)`, `quoteIn(quote, source)`, `numbersInQuote(claim, quote)`, `rubricVocabulary` (frozen, machine-readable: every check type with its fields, field types and a one-line meaning; a drafting LLM reads it to draft only real checks — same idea as `primitives.json` for the gate) |
| gate methods | `drainGaps()` |
| config keys | `rubric: { spec, sha256 }`, `rubric.advanceOn`, `onExhausted`, `maxReds` |
| rule strings | the §4 table; deny rules `rubric.invalid`, `rubric.red`, `rubric.unminted`, `rubric.output-mismatch`, `rubric.exhausted` (names RULED, hamr, 2026-10-06) |
| audit | a `rubric` phase carrying `rubricSha`, `checkpoint`, `verdict`, `outputSha`, bounded `gaps` |
| types | `Rubric`, `Check`, `Gap`, `LocateJudge`, `VerdictJudge` (JSDoc typedefs) |
| primitives.json | entries for the six exports + `drainGaps` |

Name: **rubric** (avoids bareloop's "close").

## 10. Test plan

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
- Floor is the ceiling: an advance action the Axis A floor denies (and one it asks on) stays
  denied / asked with a green verdict minted for it — falsify-by-revert (let the verdict run
  first, the test must fail). A rubric config that tries to widen fs/net, raise a budget or add an
  allowlist entry is refused.
- A judge reply carrying a score (`{score: 8}`, `{confidence: 0.9}`) in place of the verb → red
  (`clean`), never mapped to a verdict.
- `rubricVocabulary`: frozen (mutation throws or is a no-op); every check type `createRubric`
  implements appears in it and every entry in it is implemented (both directions, so a new rule
  cannot ship undocumented and the list cannot name a rule that does not exist).
- Quote rule: `locate` judge returning no quotes -> red; `verdict` judge returning a verb and raw
  answer but no quote -> accepted; `verdict` judge returning no verb, or a score -> red.
- An adapter whose model != the signed identity's model -> red (`clean`); cutoff/band come from the
  signed identity, not the adapter's own configuration.
- Verdict judge past `deadlineMs` (never settles, no AbortSignal) -> timeout red without waiting.
- Byte-identical decision path when `rubric` is unset.

## 11. Day 1 vs later

| | What |
|---|---|
| **Day 1** | `quoteIn`, `numbersInQuote` (pure; agents use them now) · shape rules + `nonEmpty` + `notWorse` in `checkStep` · `createRubric` / `rubricSha` · `rubricVocabulary` · gating checkpoint + `outputSha` match · gap view · `onExhausted: "fail"` |
| Next | `locate` judge in `checkStep` (deadline, one retry, clipped quote) · foundational `clean` / `quoteIn` / `numbersInQuote` on judge quotes · `cited` / `complete` · soft-green + ACCEPT fail-closed · `reads: N` + `agree` · `verdict` judge in `checkStep` (jev, via a caller-passed adapter; quote optional) |
| Later | bareguard's own judge calibration (in the hash) · `onExhausted: "ask"` |

## 12. Rulings (hamr, 2026-10-06)

Nothing in this design is undecided.

1. bareguard-prd Part 1 §6 → **A**: amended to "bareguard may measure declared, deterministic properties of an output;
   it never interprets meaning". Rubric code in its own module; the Axis A floor never imports
   judge code.
2. Red denies done → **YES**: any red (deterministic or judge) denies the advance at a gating
   checkpoint, bounded by Law 9.
3. `notWorse` baseline → **A + B** (literal or seed, both signed); C rejected.
4. `no-suppressions` → **A** (caller-computed count → `notWorse` baseline 0).
5. Judge deadline → **required**; missing = throw; no default (unset = deny).
6. Thousands separators → **not stripped**; "1,200" vs "1200" stays a documented gap (Law 4).
7. `quoteIn` source cap → **5 MB**; over = red "source too large".
8. Deny rule names → as proposed: `rubric.invalid`, `rubric.red`, `rubric.unminted`,
   `rubric.output-mismatch`, `rubric.exhausted`.
9. `judge.reads` default → **2** at gating checkpoints with a judge, **1** elsewhere.
10. `verdict` judge (jev) → moved from Later to **Next**; bareguard's own calibration stays Later;
    `agree` is in Next only.
11. Quote rule → a `locate` judge must return quotes (none = red); a `verdict` judge's quote is
    **optional**, but it must return a decisive verb and its raw answer.
12. `rubricVocabulary` → a new frozen, machine-readable export listing every check type.

Also ruled the same day: soft-green with no ACCEPT moment fails closed; `onExhausted` defaults to
`"fail"`; Laws 8 (decisive binary) and 9 (floor is the ceiling) kept from Axis B.
