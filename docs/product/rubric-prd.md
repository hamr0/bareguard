---
type: product
title: "rubric — signed, deterministic checks that gate an advance (DRAFT)"
status: draft
---

# rubric — DRAFT spec

Evidence, rationale and history: docs/logs/rubric-learnings.md.

*Specs only. Nothing is built. No versions picked. Last updated 2026-10-08. Every decision is
RULED by hamr and listed in §12.*

## 0. In one paragraph

A **rubric** is a signed list of checks bound to a goal. A runner (or agent) hands bareguard an
output at a named **checkpoint**; bareguard runs the checks, **mints a verdict** (green / soft-green
/ red / stopped), records it, and hands back a **gap** (what is missing, as structured data) or, for
`stopped`, a **fault**. At a checkpoint the operator marks as **gating**, the advance action is
denied unless the verdict is green (or an accepted soft-green, Next). bareguard runs no model and
runs no command: deterministic checks are its own code, measurements that need a tool are passed in
by the caller, and a judge is a function the caller passes in. The loop (order, retries,
replanning, cadence, spend caps) stays outside bareguard.

## 1. How it works

**Three roles.**
- The **runner** (any harness) writes the rubric draft, drives the agent, takes measurements and calls bareguard.
- The **human** signs the rubric before the work and accepts the result after.
- **bareguard** grades and gates. It never runs a model or a command.

**The flow.**
1. A drafting LLM (the caller's) reads `rubricVocabulary` and drafts a rubric spec from the goal,
   using only the listed check types.
2. `createRubric(spec)` validates it. An unknown check type, or a line that maps to no check, is
   refused at draft time, never bent onto the nearest rule.
3. The human signs. `rubricSha(spec)` is the fingerprint both sides compute. A judge model or
   cutoff change means re-sign.
4. The agent works. It never sees the rubric.
5. The runner takes any caller measurements, then calls `gate.checkStep(checkpoint, output, { measurements?,
   items?, inputs?, outputBytes? })` (§7). The GATE runs the checks with its own verified rubric (the
   exported pure `checkStep(rubric, checkpoint, output, opts)` is for gate-less agents and is what the
   gate calls inside). The deterministic checks run, then the judge if any. The gate mints green /
   soft-green / red / stopped. Nothing a caller says about a verdict is trusted: there is no way to hand
   the gate a verdict, only an output to grade.
6. The agent or runner sends the advance action `{ type: <advanceOn>, checkpoint, outputSha }`
   through `gate.check`. The Axis A floor runs first (Law 9); then the advance is denied if there
   is no minted verdict, the verdict is red or stopped, the sha does not match, or the checkpoint
   is `requiresHuman` and no ACCEPT is recorded for the sha.
7. On red, the loop retries and is fed ONLY the gap (`gate.drainGaps()`). On stopped, the runner
   gets a `fault` and the worker gets nothing. After `maxReds` (if set) `onExhausted: "fail"` applies.
8. At the end the human ACCEPTs. A soft-green is only final after ACCEPT; with no accept moment
   configured it fails closed.

```
goal -> drafter reads rubricVocabulary -> spec -> createRubric -> human signs (rubricSha)
agent works -> output (+ caller measurements) -> checkStep -> green | soft-green | red + gap | stopped + fault
   advance action -> gate.check: floor -> verdict lookup -> [requiresHuman ACCEPT] -> allow | deny
   red -> retry with gap only (drainGaps) ... maxReds (if set) -> onExhausted
end -> human ACCEPT
```

**The parts.**

| Part | What it is |
|---|---|
| `createRubric(spec)` | validates a spec; throws on an unknown check type or bad shape (§3, §4) |
| `rubricSha(spec)` | sha256 over the canonical spec; the signed fingerprint (§3) |
| `checkStep(rubric, checkpoint, output, opts)` | runs the checks (and the judge), mints the verdict, gap or fault (§7) |
| `renderGaps(gaps)` | pure: a deterministic one-string render of a gap list, for stuck-detection (§7) |
| `quoteIn(quote, source)` | pure: is the quote in the source, whitespace and `**` forgiven (§4.2) |
| `numbersInQuote(claim, quote)` | pure: does every number in the claim appear in the quote (§4.2) |
| `rubricVocabulary` | frozen, machine-readable list of every rule: field names, types, required/optional, bounds, defaults; descriptions are generated from it (§9) |
| `gate.checkStep(checkpoint, output, opts)` | the gate runs the checks with its OWN signed rubric, mints the verdict, records it, buffers the worker gaps (§7) |
| `gate.drainGaps()` | read-and-clear the gap view for the retry (§7) |
| `gate.recordAccept({...})` | harness-only: record an ACCEPT answered later, for `accept: "later"` checkpoints (§6) |
| config `rubric` | `{ spec, sha256, advanceOn }`, the signed rubric the gate holds (§9) |
| config `rubric.advanceOn` | the action type(s) that count as "advance", nested in `rubric` (§7) |
| spec `onExhausted` | `"fail"` (default) or `"ask"` (Later) when reds run out; a field of the SIGNED spec, not a gate key (§6) |
| spec `maxReds` | cap on reds per `(rubricSha, checkpoint)`; OFF unless set; a field of the SIGNED spec, not a gate key (§6) |

**The check shapes.** Every type, one line; exact rules in §4.

*Foundational (always on, cannot be switched off):*
- `happened`: the output exists and is readable. It short-circuits: an empty or whitespace-only string (or an object with no own key) is red `happened:empty` and NO other check runs, so `blockLines` never reaches `zero-lines` on it (RULED 2026-10-08 #14).
- `clean`: no malformed judge reply, no unpriced call; a `locate` judge returned quotes.
- `quoteIn` on every judge quote.
- `numbersInQuote` on every claim-quote pair.
- `agree`: when `reads > 1`, every read decided the same.
- `signed`: at load, the rubric is signed and its sha matches.

*Opt-in (only when listed):*
- `nonEmpty`: field has content.
- `maxWords` / `minWords`: word count bound.
- `maxLines`: non-empty line count bound.
- `sections`: each named heading is present. `sectionOrder`: headings present and in order.
- `mustCarry`: every listed phrase is present.
- `blockLines`: output grouped in blocks of N lines; every listed phrase in each block.
- `in` / `notIn`, `atMost`, `max` / `min`: value checks.
- `cited`: every claim's quote is in the frozen input with its numbers.
- `complete`: every item of a list is covered by a claim.
- Caller-measured: `notWorse`, `commandExit`, `patternAbsent`, `filesChanged`.
- `judged`: `locate` or `verdict` judge question (§5).

**Worked example.** A resume step: at most 600 words, two headings, one judged question.

```js
// signed spec (hash covers all of it, judge identity included)
const spec = { schema: 1, goal: "Write the resume", inputs: [],
  judge: { provider: "jev", model: "jev-1.13.0", cutoff: 0.5, band: 0.1 },
  checkpoints: { resume: { gating: true, checks: [
    { id: "words-cap", rule: "maxWords", field: "text", value: 600 },
    { id: "headings", rule: "sections", field: "text", names: ["Summary", "Skills"] },
    { id: "skills-only", rule: "judged", kind: "verdict", ask: "Does the skills section list only skills?" } ] } },
  onExhausted: "fail", maxReds: 3 };
const rubric = createRubric(spec);          // human signs rubricSha(spec)
const r = await checkStep(rubric, "resume", output,
  { judge: jevVerdictJudge({ jev }), deadlineMs: 20000 });
// 633 words (a leading "#" run is not counted) ->
//   { verdict: "red", gaps: [{ key: "resume:words-cap", checkpoint: "resume", check: "maxWords",
//     id: "words-cap", field: "text", measured: 633, limit: 600, direction: "at-most" }] }
// trimmed to 580 words, jev says "honored" -> { verdict: "soft-green" }  (final only after ACCEPT)
```

Self-check under the §4.1 defaults: `maxWords` counts per line after stripping a leading `#` run, so
`## Summary` counts 1 word. `sections` with `Summary` and `Skills` is green for any of `## Summary`,
`# summary`, `Summary:` or a bare `Summary` line (headings are compared trimmed and lowercased), and
red "missing" if either is absent. No `strict` field, so no ATX-only or case rule applies. The
`judged` check is Next; on Day 1 the example runs without it.

## 2. Boundary and laws

**Boundary (RULED).** "bareguard never runs an LLM; it checks deterministic facts against declared,
enumerated rules." It never runs a command, reads git, or evaluates a user regex.

**Red denies "done" (RULED: YES).** Any red, deterministic or judge, denies the advance at a gating
checkpoint, bounded by Law 9 (it only ever adds a deny). `stopped` denies the same way.

**Laws:**
1. **Unsure = red.** A missing field, wrong type, throwing getter, malformed judge reply or unknown price is red, never green.
2. **Checks sit outside the agent.** The worker never sees its rubric; a retry gets only the gap.
3. **Checks are derived from the signed rubric**, never hand-authored beside it; descriptions shown to anyone are generated from `rubricVocabulary`.
4. **Never widen a check at runtime to turn red green.** Defaults are forgiving (§4.1); `strict: true` is signed and only tightens.
5. **Typed fields only, no free text decides, no user regex.**
6. **Text explains a red, never decides one.** Every check's `text` is the signer's words.
7. **Tamper = deny.** An unsigned or hash-mismatched rubric is refused at load.
8. **Decisive binary, never a score.** A `verdict` judge returns `honored` / `broke`; a `locate` judge's quotes feed a binary deterministic decide. A reply carrying a score instead of the verb is malformed = red (`clean`).
9. **The floor is the ceiling.** The rubric only ADDS a deny; a green verdict never turns an Axis A deny or ask into an allow. Order at `gate.check` on an advance: Axis A floor first, rubric verdict after, deny-only. A rubric cannot widen an fs/net scope, raise a budget or add an allowlist entry.
10. **A broken instrument is `stopped`, not red and not zero.** An exception while measuring never becomes an empty set or a zero.
11. **The caller measures, bareguard only compares.**
12. **Every governor and deny rule has its own distinct name.**

### 2.1 Doc sites carrying the old boundary line (to update when built)

| Where | Line | Text |
|---|---|---|
| `README.md` | 115, 118 | "never runs an LLM and never judges: you compute the fact" + code comment |
| `bareguard.context.md` | 1043 | "You compute the fact (a deterministic check, or a caller-side LLM judge ..." |
| `src/gate.js` | 1392 | `annotate` JSDoc "bareguard NEVER computes the fact (no LLM)" |
| `src/gate.js` | 189 | `routeAnnotation` "No LLM, no side effects" (still true) |
| `types/gate.d.ts` | 3, 352 | generated from the two above |
| `primitives.json` | `annotate`, `routeAnnotation` entries | generated `when`/`fails` text |
| `docs/product/bareguard-prd.md` | 79-80, 197-217 | §0 "the one boundary", Part 1 §6 action-vs-content |
| `docs/wiki/axis-b.md` | 139, 164-166 | "the check stays the caller's"; "no text scan" |

**Part 1 §6 amendment (RULED: A).** Part 1 §6 becomes: "bareguard may measure declared,
deterministic properties of an output; it never interprets meaning." The rubric code lives in its
own module; the Axis A floor never imports judge code.

## 3. The rubric object

```js
{
  schema: 1,
  goal: "<the signed goal line, verbatim>",          // set by the machine from the signed text
  inputs: [{ name: "resume", sha256: "..." }, ...],   // frozen sources the checks may cite
  judge: { provider, model, cutoff?, band? } | null,  // identity; any change forces a re-sign
  reads: <int>,                                       // signed; absent = 1 (§5)
  checkpoints: {
    "<id>": { gating: true|false, requiresHuman?: true, accept?: "live"|"later", checks: [ Check, ... ] },
  },
  onExhausted: "fail" | "ask",                        // default "fail"
  maxReds: <int>,                                     // optional; absent = no cap (§6)
}
```

- Every check has a stable `id`, unique within its checkpoint, set in the spec.
- `rubricSha(rubric)` = sha256 over a canonical serialization of **everything above**. Signing is
  the caller's; bareguard receives `{ rubric, sha256 }` and refuses a mismatch. A harness rubric
  that is a projection of a larger signed spec must hash the same fields (goal, checks, judge
  identity, inputs, schema).
- **`requiresHuman`** is set by the signer only, never the drafter, and is tighten-only (§6).
- **Drafting.** A caller-supplied model may draft checks from the goal; they bind only once signed.
  A drafted line that maps to no owned rule is **red at drafting**. A check that contradicts its own
  goal line is red at drafting (e.g. "under 600 words" with three "250ish" sections).

## 4. Checks: the vocabulary

All checks are bareguard's own code. Each reads a declared field of the output or a value the
caller passes; none parses prose in general.

### 4.1 Shape and value rules (read the output)

Text is split into lines on `/\r?\n/`.

**`text` on every check** is the signer's explanation only (Law 6): optional, a string, never
decides, never read by a check. The phrases a check looks for are always in a `phrases` list, never
in `text` (RULED 2026-10-08 #7).

**A plain-string output is the single field `text`** (RULED 2026-10-08 #8): `field: "text"` reads
it; any other field name on a string output is red "missing". An object output is read by its own
keys.

| Rule | Params | Green when |
|---|---|---|
| `nonEmpty` | `field` | non-empty string / array / object with >=1 own key |
| `maxWords` / `minWords` | `field`, `value`, `strict?` | word count <= / >= value |
| `maxLines` | `field`, `value` | non-empty line count <= value |
| `sections` | `field`, `names:[...]`, `strict?` | every name matches some heading line |
| `sectionOrder` | `field`, `names:[...]`, `strict?` | every name matches a heading line, in that order |
| `mustCarry` | `field`, `phrases:[...]`, `strict?` | every listed phrase is present |
| `blockLines` | `field`, `size`, `phrases:[...]`, `strict?` | see below |
| `in` / `notIn` | `field`, `values:[...]` | value `===` one of / none of |
| `atMost` | `field`, `value`, `order:[...]` | ordered-enum rank <= value's |
| `max` / `min` | `field`, `value` | finite number <= / >= |
| `cited` | `claims` field, `source` input name | every claim's quote passes `quoteIn` against the frozen input AND `numbersInQuote` |
| `complete` | `items:[...]` or `itemsFrom:"caller"`, `claims` field | every item is covered by a claim (§4.4) |
| `judged` | `kind:"locate"\|"verdict"`, `ask` | see §5 |

**Forgiving defaults:**
- **Word**: per line, strip a leading `/^#+\s*/`, split on `/\s+/`, count the non-empty tokens; the
  total over all lines.
- **Heading line**: the line with a leading `/^#+\s*/` stripped, a trailing `/:\s*$/` stripped,
  trimmed and lowercased; it must be non-empty. A section name matches a heading line equal to the
  name trimmed and lowercased, so a bare line counts. A `sections`/`sectionOrder` name whose trimmed
  form ends in `:` is REFUSED at `createRubric` (the `:` is stripped from the line, not the name, so
  it could never match; the error names it) (RULED 2026-10-08 #15).
- **`sections`**: each name must match a heading line anywhere; absent = red "missing".
- **`sectionOrder`**: for each name in order, search forward from the position after the previous
  match. Not found anywhere = red "missing"; found only earlier = red "out of order". It implies
  presence, so `sections` and `sectionOrder` on the same names are redundant but allowed; listing
  both reports the union of reds. After a MISSING name, keep checking the later names; the search
  position does NOT move past the missing one. A harness whose "sections" means an ordered map
  maps it to `sectionOrder` (fwdloop does); presence-only `sections` stays available.
- **`mustCarry`**: every phrase in `phrases` is a case-insensitive substring of the field; a red
  gap lists the missing phrases (bounded).
- **`blockLines`**: group the field's non-empty lines into blocks of `size` lines (joined with a
  space); a non-empty line count that is not a multiple of `size` = red; zero non-empty lines =
  red; each listed phrase must appear in EACH block (same case rule as `mustCarry`). `size` AND
  `phrases` are BOTH required; either missing is refused at `createRubric`.

**`strict: true`** (signed, per check; there is no rubric-wide switch). **Strict is ALWAYS the
tighter result: it is never green where forgiving is red, in either direction** (RULED 2026-10-08
#1). The rules:
- **`maxWords`** counts markers (split the raw line on `/\s+/`, no stripping). The raw count is
  never below the forgiving count, so it can only make `maxWords` stricter.
- **`minWords`** under strict counts exactly like forgiving (a leading `#` run is NOT counted):
  counting markers would make `minWords` easier to pass, which strict must never do.
- **Headings** are ATX only: after `#{1,6}` and one or more spaces, the REST of the line is the
  heading text EXACTLY (no closing-`#` stripping, no trimming), compared exactly and
  case-sensitively. So `# Summary ##` is the heading `Summary ##` and does NOT match `Summary`;
  `## C#` is the heading `C#`. No setext, no HTML, no bold-as-heading, no bare line. A heading line
  with nothing after the spaces is not a heading. Parsing is hand-coded and linear (no backtracking
  regex). A strict name matches a heading only if the forgiving rule ALSO matches it, which is what
  makes "never looser" hold by construction (a name ending in `:` therefore matches in neither
  mode). No ATX heading in the output = red "no headings found".
- **`mustCarry` / `blockLines` phrases** are exact substrings AND (by the same conjunction) also
  forgiving matches.

**Bounds** (enforced in `rubricVocabulary` and at `createRubric`): count fields (`value` of the word
and line rules, `size`, `reads`, `maxReds`) are integers >= 1 with no maximum; string lists
(`names`, `values`, `phrases`, `patterns`, `allowPrefixes`, `items`) are non-empty arrays of
non-empty strings; a whitespace-only string is refused.

**Gap fields** (§7): every gap for an ordered rule (`maxWords`, `minWords`, `maxLines`, `max`,
`min`, `atMost`) carries `direction`: `"at-most"` or `"at-least"`. `notWorse` carries its signed
`direction`.

**`cited`: zero claims is RED** (RULED 2026-10-08 #13). A non-empty output whose `claims` list is
empty fails with kind `no-claims`, never a vacuous green, whether or not a `complete` check runs.
The signed input's frozen text comes from `opts.inputs[name]` and must hash to the signed `sha256`,
or the check is `stopped` (RULED 2026-10-08 #8).

### 4.2 Pure helpers

**`quoteIn(quote, source)`**: collapse whitespace (`\s+` to one space, trim) and strip `**` and `__`
on both sides, then substring containment. Substring, not line-wise. Empty quote = red. Source cap
**5 MB**; over it = red "source too large". Linear time.

**`numbersInQuote(claim, quote)`**: number tokens are `/\d+(?:\.\d+)?/g`; every token in the claim
must appear as a token in the quote (`8` does not match `2018`). `8x` is 8, `1.2k` is 1.2, `50%` is
50, `2 weeks` is 2. Number words are unchecked (documented gap). `1,200` vs `1200` is a false red
(thousands separators are not stripped).

### 4.3 Caller-measured rules

bareguard never runs commands, reads git, or evaluates a user regex. The caller measures and
passes the result in `opts.measurements[<checkId>]`; bareguard compares.

**Liveness proof** (applies to `notWorse`, `patternAbsent`, `filesChanged`; for `commandExit` only
the first line applies):
- The caller passes the tool's `exit`. For counts it also passes `matchedPreScope`, the match
  count BEFORE any scope filter. Missing proof = `stopped`.
- Non-zero `exit` AND zero `matchedPreScope` = `stopped` ("crashed tool: unknown, not zero").
- Liveness is read BEFORE any scope filter.
- A tool whose "none found" is a non-zero exit declares a signed `noneExit: <n>` on `notWorse`,
  `patternAbsent` or `filesChanged`; an `exit` equal to `noneExit` with zero matches is a live zero.
  No softened default. **`commandExit` takes NO `noneExit`** (it has no match count, so the param
  would do nothing): `createRubric` refuses it (RULED 2026-10-08 #11).

| Rule | Signed params | Caller passes | Green when |
|---|---|---|---|
| `commandExit` | `expectExit` (default 0) | `{ exit, outputLines? }` | `exit === expectExit`. Red gap: `exit`, `expected`, bounded output lines |
| `notWorse` | `direction` (`"lower-is-better"` \| `"higher-is-better"`, REQUIRED, never inferred), `baseline` (literal \| `"seed"`), `noneExit?`, `terms?:[id]` | `{ value, exit, matchedPreScope, baseline?, baselineSource?:{anchor, route}, terms?:[{id, contributes}] }` | not worse than baseline in `direction`; equal = green. Gap may carry the per-term breakdown |
| `patternAbsent` | `patterns:[id]` (ids only; patterns are the caller's), `noneExit?` | `{ exit, matchedPreScope, hits:[{id, path, line, text}] }` | zero hits. Red iff >=1 hit; gap = bounded hit list. A hit whose `id` is not in the signed list = `stopped` |
| `filesChanged` | `allowPrefixes:[...]`, `requireNonEmpty`, `noneExit?` | `{ exit, matchedPreScope, paths:[...] }` | not empty when required AND every path under some prefix, resolved physically like bareguard's fs scopes. Gap lists offenders |

**`notWorse` baseline.**
- A literal baseline is signed in the spec.
- `"seed"`: the counting RULE is signed, never a number. The runner measures the baseline per run
  at a signed anchor kind (e.g. a commit sha it names in the call) and passes
  `{ baseline, baselineSource: { anchor, route } }`. `checkStep` returns the baselines it measured
  as `baselines` and takes the already-recorded ones as `opts.priorBaselines[checkId]`; a different
  baseline for the same check is refused (`stopped`, fault kind `baseline-conflict`).
  **The gate's job (Module 2):** record each seed baseline by `(rubricSha, runId, checkId)` in the
  audit, feed it back as `priorBaselines`, and rebuild it on resume, so a resume never forgets a
  frozen baseline (RULED 2026-10-08 #10).
- A baseline passed per call without `"seed"` in the spec is refused.
- `notWorse` with literal baseline 0 stays an allowed alternative to `patternAbsent`.

### 4.4 `complete`

Every item must be covered by a claim, where a claim covers an item when `claim.item` equals the
item string exactly. The item list comes from exactly one source:
- **(a)** a signed `items:[...]` list in the spec; or
- **(b)** `itemsFrom: "caller"`: a list measured from the artifact by the caller, passed in
  `opts.items[<checkId>]` and recorded in the audit with the `outputSha`.

Never the judge's own list. There is no built-in sentence splitter. A missing or empty caller list
= `stopped`.

### 4.5 Foundational vs opt-in

**Foundational: run at EVERY checkpoint, whether or not the rubric lists them:**

| Check | Red when |
|---|---|
| `happened` | the output is missing, `null`, empty, or unreadable (throwing getter / Proxy) |
| `clean` | a judge returned a malformed reply (after its one retry), a score instead of a verb, or was unpriced; a `locate` judge returned no quotes; a `verdict` judge returned no verb or no raw answer |
| `quoteIn` on every judge quote | a quote the judge returned is not in the frozen input it names (a verdict judge may return none; a locate judge may not) |
| `numbersInQuote` on every claim-quote pair | a number in a claim is missing from the quote cited for it (only where the judge pairs a quote with a claim) |
| `agree` | `reads > 1` and the reads' decided outcomes differ (§5) |
| `signed` | (at load) the rubric is unsigned or its sha mismatches |

A judge that did not answer at all (transport error, or timeout past the deadline) is `stopped`,
not red.

**A signed rubric cannot switch a foundational check off (tighten-only).** A checkpoint whose
legitimate output is "nothing found" must still return a declared non-empty shape (e.g.
`{ found: [] }` with `nonEmpty` read on the object, not the list).

**Unknown rule**: construct-time throw naming the key; a post-construction swap to an invalid shape
denies at the gate with `rubric.invalid` (the `<key>.invalid` family).

## 5. Judges

bareguard owns no model. The caller passes `judge` per call. Two kinds:

| Kind | Contract | Who decides | Its green |
|---|---|---|---|
| `locate` (default) | `judge(input, check, { signal, identity }) -> { quotes:[...], facts:{...} }` | bareguard's deterministic rule over the quotes (`quoteIn`, `numbersInQuote`, `complete`) | counts as **soft-green** |
| `verdict` (escape hatch) | `judge(input, check, { signal, identity }) -> { verdict: "honored"\|"broke", raw, quote?, why? }` (`identity` = the signed `{ provider, model, cutoff?, band? }`) | the judge | **never green alone**: at best soft-green; its red denies |

**Quote rule.** A `locate` judge MUST return quotes; none = red. A `verdict` judge's quote is
OPTIONAL, but it must return a decisive verb and its raw answer; no verb, or a score instead of a
verb, is malformed = red. A quote a verdict judge does return is checked with `quoteIn`.

**Call hygiene:**
- `deadlineMs` is **required** whenever a judge is passed; missing = `checkStep` throws; at the gate,
  unset = deny. bareguard passes an `AbortSignal`.
- A **timeout** (or transport error) is never retried: it is `stopped`.
- A **malformed reply** gets exactly **one retry**, then red (`clean`). Never repair a reply.
- Unpriced = red, never retried. "estimated" pricing counts as priced; only unpriced is red.
- What the judge said is recorded in bounded form: the quote's start (clipped), its original length
  and the sha256 of the full quote. The full raw judge facts are the caller's to keep.

**Repetition: signed `reads: N`** (per rubric; absent = 1; Next):
- The locate judge is called **N times**, each an independent call (prompt caching fine; replaying
  a cached response is not).
- The deterministic decide runs on **each** read's quotes. A read's decided outcome = the verdict
  plus the set of reds keyed `(check, item)`.
- **Compare decided outcomes, not raw quotes.** Any difference = red `agree` ("judges disagree",
  each read's outcome in the full view). A read's malformed reply gets its own one retry before
  counting. A read that times out makes the whole check `stopped`.
- `verdict`-kind judges compare `verdict` only.
- Cost = N x judge calls, each reported through the existing budget path; the minted record says how
  many reads ran.

**Calibration (Later, bareguard's own).** The judge identity is in the hash now, so a model bump
forces a re-sign. It should grade each case `reads` times and require all N correct. An
uncalibrated judge's soft-green is acceptable only because the final ACCEPT exists (§6).

### 5.1 Using bareagent's jev as a verdict judge (Next)

- **Structural only.** bareguard never names or calls jev; the caller passes a judge function.
  bareguard does not import bareagent and bareagent does not require bareguard.
- **The adapter lives in bareagent** (example name: `jevVerdictJudge({ jev })`). It takes `cutoff`
  and `band` from the `identity` that `checkStep` passes (the SIGNED values), never from its own
  arguments. It asks jev a `noul` question about the output and maps the probability: `>= cutoff +
  band` is `"honored"`, `<= cutoff - band` is `"broke"`, inside the band is unsure = red. It returns
  the raw jev answer. The probability is never part of the decision contract (Law 8).
- **Identity in the hash:** provider, model, cutoff and band. The signed model is a pinned version
  (e.g. `jev-1.13.0`), never a moving alias.
- **Signed = running.** The adapter refuses (red, `clean`) if `identity.model` differs from the jev
  model it is configured with.
- **Admission before signing:** bareagent's `calibrateJev` must have admitted that jev model tier.
- **Deadline:** `JevProvider` has no AbortSignal; bareguard enforces `deadlineMs` by no longer
  waiting (a race) and records `stopped`.
- **Cost** flows through bareagent's `onLlmResult` / budget path.
- **Who builds what:** bareguard = the verdict-judge slot in `checkStep`; bareagent = the adapter.

## 6. Verdicts, the advance and the human moments

**Four verdicts:**

| Verdict | Meaning | Gating checkpoint | Gap / fault | Counts toward `maxReds` |
|---|---|---|---|---|
| **green** | every check deterministic and green | allow | none | no |
| **soft-green** | every check green, at least one involved a judge (carries a flag; Next) | allow only after ACCEPT, else deny | none | no |
| **red** | any check red | deny | gap to the worker | yes |
| **stopped** | the instrument failed, not the work | deny | NO gap to the worker; a structured `fault` to the runner | no |

**`stopped` causes (exhaustive):**
- an exception thrown while measuring or reading;
- a failed liveness proof (§4.3);
- a missing caller measurement or a missing/empty caller item list;
- a patternAbsent hit with an id not in the signed list; a conflicting seed baseline (tamper);
- a judge that did not answer: transport error, or timeout after `deadlineMs`.

A judge that answered badly (malformed after its retry, a score instead of the verb, missing
required quotes) stays **red** (`clean`). Unpriced stays **red**. `stopped` is audited. `fault` =
`{ key, checkpoint, id, kind, detail }` with `kind` one of `exception`, `liveness`,
`missing-measurement`, `unknown-pattern`, `baseline-conflict`, `judge-no-answer`; `detail` is bounded.

**Precedence: stopped > red > green** (RULED 2026-10-08 #12). When a checkpoint has both a fault and
reds, the verdict is `stopped`: `gaps` (the worker's view) is empty and the reds are kept only in the
`full` record, for the audit and the human. A broken instrument is fixed before any red is acted on.

Non-gating checkpoints record and return gaps/faults but never deny.

**Human moments: SIGN and ACCEPT.**
- **SIGN** the rubric before; **ACCEPT** the result after.
- A soft-green result must be confirmed at ACCEPT. With no ACCEPT moment configured, soft-green
  fails closed (it behaves as red at the last gating checkpoint).
- **`requiresHuman` checkpoint** (signer-set only, tighten-only): the advance is denied until a human
  ACCEPT is recorded for that checkpoint's `outputSha`, even when the verdict is green. A red or
  stopped verdict denies before any ask. `outputSha` = sha256 of exactly the bytes bound to the
  advance (see §7 `outputBytes`); bareguard never serializes an object to hash it. How the ACCEPT is
  obtained is a SIGNED per-checkpoint field `accept: "live" | "later"` (default `"live"`; nothing is
  inferred; it is refused on a checkpoint that is not `requiresHuman`, and it is in the hash):
  - **`accept: "live"`** (default). A green advance asks through bareguard's existing `humanChannel`
    at that signed position, with rule `rubric.needs-accept` and an event key `rubric: { rubricSha,
    checkpoint, outputSha, verdict, gaps }` (`gaps` = the worker view, empty on a green). It is asked
    ONCE per `outputSha`: the reply `{ decision: "allow" }` is recorded as an ACCEPT bound to that
    sha; any other reply, a timeout, a throw, or no `humanChannel` denies and records nothing; a
    different `outputSha` asks again. If the Axis A floor also asks on the advance, the floor's ask
    comes first and the rubric ask follows it; no other action ever gets a rubric ask.
  - **`accept: "later"`** for a harness that parks and resumes in another process. There is no live
    ask: an advance without a recorded ACCEPT is denied `rubric.needs-accept`. The harness (never the
    agent, same trust rule as `gate.add`) records the answer with `gate.recordAccept({ checkpoint,
    outputSha, by, at?, askId? })`. It is REFUSED (throws, and a `rubric_accept_refused` audit line
    records why) unless the checkpoint is `requiresHuman` AND `accept: "later"` AND the latest minted
    verdict for it is GREEN for exactly that `outputSha` in this `rubricSha` and `runId`. Audited,
    rebuilt on cold start.

**Exhaustion.** The loop owns retries and strikes. `maxReds` is OFF unless set: when set, the gate
counts reds (not stopped) per `(rubricSha, checkpointId)` as a backstop, rebuilt from the audit like
the budget. The count resets on a re-sign (a new `rubricSha`) or on an ACCEPT at that `requiresHuman`
checkpoint, and on nothing else. `maxReds` and `onExhausted` are fields of the SIGNED spec (one
source); a gate key of either name is refused at construct. Once the count reaches `maxReds` every
advance at that checkpoint is denied `rubric.exhausted` (terminal until a re-sign or ACCEPT), whatever
the latest verdict. On exhaustion `onExhausted: "fail"` (default; terminal red)
or `"ask"` (Later; for loops with no end door). The machine never adds an ask by default.

## 7. Mechanics

**Checkpoints.** bareguard knows neither "close" nor "step". The operator names checkpoints and
marks which gate the advance.

**Flow (runner mints, gate reads):**
1. The runner calls `gate.checkStep(checkpointId, output, opts)` (async). The gate holds the verified
   rubric, so the caller names the checkpoint and supplies the output and measurements, never a verdict.
2. The gate runs the checks, mints `{ verdict, gaps | fault, outputSha }`, records it (audit `rubric`
   line) keyed by `(rubricSha, checkpointId)`, records any new seed baseline, updates the red count and
   buffers the worker gaps for `gate.drainGaps()`. It returns the full StepResult (verdict, worker
   `gaps`, `fault`, `full`, `rubricSha`, `outputSha`) so a harness can render its own page.
   The whole call runs under the gate's ordering lock, so the audit line order is the decision order.
3. The advance action, an action type listed in `rubric.advanceOn`, carries `{ checkpoint,
   outputSha }`. `gate.check` looks up the minted verdict and **denies if** none exists
   (`rubric.unminted`), it is red (`rubric.red`), it is stopped (`rubric.stopped`), `outputSha`
   differs (`rubric.output-mismatch`), or a required ACCEPT is missing (`rubric.needs-accept`).
   The same lookup runs again inside the commit lock, so a mint that lands between the first check and
   the commit is honoured. Deny order: `rubric.invalid`, `rubric.unminted`, `rubric.exhausted`,
   `rubric.stopped`, `rubric.red`, `rubric.output-mismatch`, `rubric.needs-accept`. A non-gating
   checkpoint never denies. `rubric.invalid` (a config swapped to an invalid shape or a different
   signature after construct) denies EVERY action, after the floor.
Big outputs never enter the action or the audit line. Either an agent or a runner may send the
advance.

**`checkStep` signature and `outputSha`.**

```js
checkStep(rubric, checkpoint, output, {
  measurements?,   // { [checkId]: caller-measured proof }              (§4.3)
  items?,          // { [checkId]: caller item list } for itemsFrom      (§4.4)
  inputs?,         // { [inputName]: frozen source text } for `cited`; must hash to the signed sha256, else stopped
  priorBaselines?, // { [checkId]: seed baseline already recorded } ; a different one = stopped baseline-conflict
  outputBytes?,    // string | Buffer | Uint8Array : the exact bytes the advance is bound to
  judge?, deadlineMs?,  // Next
}) -> Promise<{ verdict, checkpoint, rubricSha, outputSha, gaps, fault, full, baselines, callerItems }>
```

- `outputSha` = sha256 of exactly `opts.outputBytes` when given (a string is hashed as UTF-8), for
  ANY output type (RULED 2026-10-08 #9). Otherwise it is the sha256 of the UTF-8 bytes of a string
  output. For an object output with no `outputBytes` it is `null`: bareguard never serializes an
  object itself, so the result cannot be bound to an advance, and **Module 2's gate denies an
  advance that carries no `outputSha` as unbound**. A harness whose artifact bytes are
  `JSON.stringify(artifact, null, 2)` passes exactly that string as `outputBytes`.
- `outputBytes` of any other type is refused (a `TypeError`: caller misuse).

**Gap view by construction.** Each red produces two views:
- **gap**: `{ key, checkpoint, check, id, field, measured, limit, direction? }` per failing check,
  e.g. `{ key:"resume:words-cap", check:"maxWords", measured:633, limit:600, direction:"at-most" }`.
  Offender lists are bounded (20 shown, `itemsTotal` true). No rule text, no other checks.
  **A signed value is never clipped in a gap** (section names, phrases, `in`/`notIn` values, `order`
  entries, `complete` signed items, `notWorse` term ids): the worker must be able to reproduce it.
  They are bounded at `createRubric` instead: any signed name/phrase string over 1000 characters
  is refused (`rubricVocabulary.bounds.stringList.itemMaxLength`, `.signedString.maxLength`).
  Only caller-MEASURED or output-derived strings are clipped to 120 characters (the measured value
  in `in`/`atMost`, output lines, hit text and paths, `complete` items from the caller, `cited`
  claim labels) (RULED 2026-10-08 #16).
- **`renderGaps(gaps) -> string`** (pure, exported): the entries in signed check order (then a
  stable order within a check), each rendered from its gap fields, joined by `"; "`. The same
  failing state always renders the same string, so a harness may detect "stuck" by comparing
  renders across tries. Read through `gate.drainGaps()` or
  `checkStep`'s return.
- **full**: everything, for the audit line and the human.
- **`key`** is `${checkpoint}:${checkId}`: stable across retries for the same failing check so
  harnesses can compare gaps across tries.
`drainAnnotations` keeps its shape (SemVer).

**State rebuilt from the audit.** Gate state that enforces a limit (minted verdicts, red counts,
recorded seed baselines, ACCEPTs) is rebuilt from the audit on cold start/resume, like the budget.
A resume never resets a count. Lines are matched by the audit line's `run_id` (the gate's `runId`,
RULED 2026-10-08 #18: use `config.runId`) and `rubricSha`. **The harness must pass a stable `runId`
(and audit path) on resume; a gate with no stable `runId` gets a fresh random one and starts with
fresh counts. There is no magic that finds the earlier run.** Seed baselines are keyed
`(rubricSha, runId, checkpoint, checkId)` (check ids are only unique within a checkpoint).

**Audit bounds.** Quotes and sources never go on an audit line whole. Gap, fault and full views are
bounded at the source, redacted, then line-capped by the existing `LINE_FIELDS` path
(`MAX_LINE_BYTES` 3500). New rows needed for any new top-level field (e.g. `outputSha`,
`rubricSha`, `baselineSource`; fixed-length hex is `clip`ped). Built: scalar carriers `rubricSha`,
`outputSha`, `checkpoint`, `checkId`, `by`, `askId`, `at` are `clip` rows; `gaps`, `fault`,
`baselineSource`, `callerItems` are `wholesale` rows; `rubricSha`, `checkpoint`, `outputSha`, `checkId`,
`verdict`, `baseline` are also in `MUST_KEEP_KEYS` because the cold-start reader needs them. Audit
phases: `rubric` (one per mint: verdict, bounded gaps with `gapsTotal`, `fault` for stopped, `reds`),
`rubric_baseline`, `rubric_accept` (`source: "live" | "later"`) and `rubric_accept_refused`.

**Interactions.** Independent of `rwx` / `tools.allowlist` mode (`advanceOn` keys on
`action.type`). A check spends no budget; a judge call's cost is the caller's to report through the
budget path. `humanChannel` is reached only via `requiresHuman`, `onExhausted: "ask"` (Later) or the
existing Axis B routing.

**Security.** No user regex anywhere (no ReDoS). Config read as own keys on a null-prototype copy;
`__proto__`/`constructor`/`prototype` field names refused at construct. Never throws because of
the output (any shape, any getter): a read failure is red, a measurement failure is `stopped`. An
audit write failure still propagates.

## 8. Axis B cleanup

| Item | Status | Note |
|---|---|---|
| `gate.annotate` | **KEEP** (transport) | live adopter bareagent `judgeToAnnotation`; the envelope cannot change |
| `drainAnnotations` | **KEEP** | unchanged; gaps get their own accessor |
| `routeAnnotation` | **KEEP**, reword | still routes caller facts; rubric advance gating is a separate path |
| `axisB.reversible` / `reversibleEscalation` | **KEEP** | apply to annotate routing only; rubric ignores them |
| OQ1 (constraint format) | **REWORDED** | becomes rubric's `in`/`notIn`/`atMost` |
| OQ3 (budget resources, soft tier) | **KEEP**, re-file | shipped 0.7.0; Axis A budget, not Axis B |
| Trial-first dry-run lane (releases-roadmap.md:383) | **DROP** | never built |
| `harness-code-mode/` + code-mode execution | **DROP** from roadmap | archive the POC, don't delete |
| D8 harness selection (harness-design.md:100, 161) | **DROP** | a runner concern |

## 9. Exports and SemVer surface

| Kind | Added |
|---|---|
| exports | `createRubric(spec)`, `rubricSha(spec)`, `checkStep(rubric, checkpointId, output, opts)`, `quoteIn(quote, source)`, `numbersInQuote(claim, quote)`, `renderGaps(gaps)`, `rubricVocabulary` |
| `rubricVocabulary` | frozen, machine-readable; lists every rule with its field names, types, required/optional, bounds (count fields integers >= 1, no max; string lists non-empty arrays of non-empty strings; no whitespace-only strings) and defaults (including `strict`); a drafting LLM reads it; every check description shown to anyone is GENERATED from it, never hand-written |
| gate methods | `checkStep(checkpoint, output, opts)`, `drainGaps()`, `recordAccept({...})` (harness-only) |
| config keys | `rubric: { spec, sha256, advanceOn }`; signed spec keys `onExhausted`, `maxReds`, `reads`, `requiresHuman`, per-checkpoint `accept`, per-check `id`, `text`, `strict`, `phrases`, `noneExit`, `expectExit`, `direction`, `baseline`, `patterns`, `allowPrefixes`, `requireNonEmpty`, `size`, `items`, `itemsFrom` |
| rule strings | every rule in §4; deny rules `rubric.invalid`, `rubric.red`, `rubric.stopped`, `rubric.unminted`, `rubric.output-mismatch`, `rubric.exhausted`, `rubric.needs-accept` |
| audit | phases `rubric` (`rubricSha`, `checkpoint`, `verdict`, `outputSha`, bounded `gaps` / `fault`), `rubric_baseline` (`baselineSource`), `rubric_accept`, `rubric_accept_refused` |
| event | the `humanChannel` event gains `rubric: { rubricSha, checkpoint, outputSha, verdict, gaps }` on a `rubric.needs-accept` ask |
| types | `Rubric`, `Check`, `Gap`, `Fault`, `LocateJudge`, `VerdictJudge` (JSDoc typedefs) |
| primitives.json | entries for the seven exports + `Gate#checkStep`, `Gate#drainGaps`, `Gate#recordAccept` |

Name: **rubric**.

## 10. Test plan

- Every rule: green, red, and **falsify-by-revert** (flip the comparison; the test must fail).
- Thresholds: AT / UNDER / OVER (`600` words vs `maxWords 600` green; `601` red).
- Words: `## Summary` counts 1 forgiving, 2 strict `maxWords`, 1 strict `minWords`.
- Headings forgiving: `## Summary`, `summary`, `Summary:` and a bare `Summary` line all match; empty
  heading line never matches. `sectionOrder`: absent = "missing"; present only earlier = "out of
  order". Strict: setext not a heading, bare line not a heading, case differs = red, no ATX heading
  = red "no headings found". Strict never looser: a generated corpus where forgiving red
  implies strict red for every strict-capable rule (falsified by reverting the source).
- `mustCarry`: case differs green by default, red under `strict`; every listed phrase is needed.
- `cited` with zero claims on a non-empty output = red `no-claims`; `commandExit` with `noneExit`
  refused at `createRubric`.
- `blockLines`: count not a multiple of N = red; zero lines = red; phrase missing from one block = red;
  case rule follows `strict`.
- `quoteIn`: `**` case green; reflowed spaces green; a changed word red; empty quote red; 5 MB
  boundary AT / OVER.
- `numbersInQuote`: the "8x" vs "2 weeks -> 4 hours" case red; `2018` does not satisfy `8`.
- `complete`: an omitted item red; signed list; caller list recorded with `outputSha`; missing or
  empty caller list = `stopped`; judge's own list refused.
- `commandExit`: exit equals / differs from `expectExit`; missing exit = `stopped`.
- `notWorse`: equal = green; both directions; missing `direction` rejected at `createRubric`;
  missing `exit`/`matchedPreScope` = `stopped`; non-zero exit + zero pre-scope = `stopped` (and
  green when `exit === noneExit`); non-zero exit with scope-filtered-to-zero but non-zero pre-scope is
  read live; seed baseline recorded, then a different baseline for the same run = `stopped`; seed
  survives cold-start rebuild; baseline passed per call without `"seed"` refused.
- `patternAbsent`: zero hits green; one hit red with bounded list; unknown hit id = `stopped`.
- `filesChanged`: empty + `requireNonEmpty` red; path outside prefixes red; a symlink spelling
  resolves physically.
- Verdicts: a measurement that throws = `stopped` (never an empty set or a zero); `stopped` produces
  a fault, no gap in `drainGaps()`, no `maxReds` increment, an audit line, and `rubric.stopped` at
  the gate.
- Judge: malformed once then good = pass; malformed twice = red; timeout = `stopped`, NOT retried;
  transport error = `stopped`; unpriced = red, no retry; "estimated" pricing = priced; verdict-kind
  green alone = soft-green, never green; a score instead of the verb = red (`clean`).
- Gate: unsigned rubric / tampered sha refused; advance with no minted verdict = deny; `outputSha`
  mismatch = deny; red = deny; stopped = deny; soft-green with no ACCEPT configured = deny;
  `requiresHuman` + green + no ACCEPT = deny via `humanChannel`; reply `{decision:"allow"}` records
  ACCEPT for the sha and allows; any other reply denies; ACCEPT for a different `outputSha` does not
  carry; `requiresHuman` set by a non-signer path refused.
- `maxReds`: absent = no cap; set = `onExhausted` honored; count resets on re-sign; red counts,
  baselines, ACCEPTs and minted verdicts survive a cold-start rebuild from the audit (a resume never
  resets a count).
- Gaps: `key` identical across retries for the same failing check; ordered-rule gaps carry
  `direction`.
- `renderGaps`: the same failing state renders byte-identically twice; different failing states
  render differently; entries follow signed check order; joined by `"; "`.
- `sectionOrder` after a missing name: later names are still checked and the search position does not
  move; missing anywhere = "missing"; found only before the position = "out of order".
- `blockLines` with `size` or `phrases` absent = refused at `createRubric`.
- Bounds: a count of 0, a non-integer, an empty list, an empty string and a whitespace-only string
  are each refused at `createRubric`; a huge count is accepted.
- `outputSha`: equals sha256 of `opts.outputBytes` (string as UTF-8, Buffer, Uint8Array) for any output type, including the hand-computed sha of `JSON.stringify(artifact, null, 2)`; sha256 of a string output without it; `null` for an object without it.
- `rubricVocabulary`: frozen; every rule `createRubric` implements appears in it with fields,
  types, required/optional, bounds and defaults, and every entry is implemented (both directions);
  generated descriptions match the entries.
- Hostile output: throwing getter, Proxy, `__proto__` keys, 10 MB value = red / bounded line, never
  a throw.
- Floor is the ceiling: an advance action Axis A denies (or asks on) stays denied / asked with a green
  verdict minted for it (falsify-by-revert); a rubric config that tries to widen fs/net, raise a
  budget or add an allowlist entry is refused.
- Quote rule: `locate` judge returning no quotes = red; `verdict` judge with verb + raw but no quote
  accepted; no verb or a score = red.
- An adapter whose model != the signed identity's model = red (`clean`); cutoff/band come from the
  signed identity.
- Module 2 (built): `gate.checkStep` ignores any caller-supplied verdict and there is no `gate.mint`;
  `accept: "live"|"later"` is validated, signed and refused off a non-`requiresHuman` checkpoint;
  `recordAccept` is refused on a live checkpoint, a non-`requiresHuman` one, a non-green verdict, a wrong
  sha, a blank `by`; verdicts, red counts, ACCEPTs and seed baselines survive a cold start with the same
  `runId`, and a different `runId` or a re-sign starts fresh; concurrent mint + advance keep audit order
  = decision order.
- Distinct names: every deny rule string is unique.
- Byte-identical decision path when `rubric` is unset.

## 11. Day 1 vs later

| | What |
|---|---|
| **Day 1** | `quoteIn`, `numbersInQuote` · `rubricVocabulary` · `createRubric` / `rubricSha` · `checkStep` with all deterministic checks (shape rules incl. `blockLines` and `strict`, value rules, `complete`, `cited`, and the four borrowed shapes `commandExit` / `notWorse` / `patternAbsent` / `filesChanged`) · the four verdicts minus soft-green (green / red / stopped) · liveness proof · gating checkpoint + `outputSha` + `requiresHuman` · `drainGaps` · `renderGaps` · audit-backed state · `onExhausted: "fail"` |
| Next | `locate` judge in `checkStep` (deadline, one retry on malformed only, clipped quote, foundational judge-quote checks) · `verdict` judge (jev, via a caller-passed adapter; quote optional) · soft-green + ACCEPT fail-closed · `reads` / `agree` |
| Later | bareguard's own judge calibration (in the hash) · `onExhausted: "ask"` |
| To try | **Needle** (https://github.com/cactus-compute/needle, `llms.txt`): a 29-121M-parameter on-device tool-calling/extraction model with grammar-constrained JSON (would cure the malformed-reply class) and a 0-1 confidence score (can never decide, Law 8). A candidate CALLER-side cheap `locate` judge; bareguard would verify its quotes. Its own docs say the base model fails 5 of 6 test suites, so it needs calibration first. Not built; try when a rubric job needs a cheap judge. |

## 12. Decisions

All RULED by hamr. Superseded entries are kept for the record.

**2026-10-06**
1. RULED (hamr, 2026-10-06): Part 1 §6 amended to "may measure declared, deterministic properties; never interprets meaning" (A).
2. RULED (hamr, 2026-10-06): red denies done at a gating checkpoint, bounded by Law 9.
3. RULED (hamr, 2026-10-06): `notWorse` baseline literal or seed, both signed; per-call baseline rejected. Seed meaning superseded by 2026-10-07 #11.
4. RULED (hamr, 2026-10-06): `no-suppressions` = caller count into `notWorse` baseline 0. Superseded by `patternAbsent` (2026-10-07 #13); baseline 0 stays allowed.
5. RULED (hamr, 2026-10-06): judge deadline required; missing = throw; at the gate unset = deny.
6. RULED (hamr, 2026-10-06): thousands separators not stripped.
7. RULED (hamr, 2026-10-06): `quoteIn` source cap 5 MB; over = red.
8. RULED (hamr, 2026-10-06): deny rule names `rubric.invalid`, `rubric.red`, `rubric.unminted`, `rubric.output-mismatch`, `rubric.exhausted`.
9. RULED (hamr, 2026-10-06): `reads` default 2 at gating checkpoints. Superseded by 2026-10-07 #20.
10. RULED (hamr, 2026-10-06): `verdict` judge (jev) moved to Next; own calibration Later; `agree` Next only.
11. RULED (hamr, 2026-10-06): quote rule; `locate` must quote, `verdict` quote optional.
12. RULED (hamr, 2026-10-06): `rubricVocabulary` is a frozen machine-readable export.
13. RULED (hamr, 2026-10-06): soft-green with no ACCEPT fails closed; `onExhausted` defaults to `"fail"`; Laws 8 and 9 kept.
14. RULED (hamr, 2026-10-06): strict word/heading/`mustCarry` defaults (markers counted, ATX-only case-sensitive, exact). Superseded by 2026-10-07 #1.
15. RULED (hamr, 2026-10-06): one retry on malformed reply or timeout. Superseded by 2026-10-07 #19.

**2026-10-07**
1. RULED (hamr, 2026-10-07): forgiving defaults for words, headings and `mustCarry`; signed per-check `strict: true` opts in to the strict rules and can only tighten.
2. RULED (hamr, 2026-10-07): `sections` = presence; `sectionOrder` = forward search with "missing" / "out of order".
3. RULED (hamr, 2026-10-07): fourth verdict `stopped` (instrument failed); denies, no gap to the worker, structured `fault`, not counted toward `maxReds`, audited.
4. RULED (hamr, 2026-10-07): a measurement exception is never an empty set or a zero.
5. RULED (hamr, 2026-10-07): a judge that did not answer (transport error / timeout) is `stopped`; a judge that answered badly stays red; unpriced stays red.
6. RULED (hamr, 2026-10-07): liveness proof for caller-measured checks; missing proof or non-zero exit with zero pre-scope matches = `stopped`; read before scope.
7. RULED (hamr, 2026-10-07): a tool whose "none found" is a non-zero exit declares signed `noneExit`; no softened default.
8. RULED (hamr, 2026-10-07): borrowed shapes `commandExit`, `notWorse` (extended), `patternAbsent`, `filesChanged` as general opt-in checks; the caller measures, bareguard only compares.
9. RULED (hamr, 2026-10-07): `notWorse` `direction` required, never inferred; equal = green; optional per-term breakdown.
10. RULED (hamr, 2026-10-07): `patternAbsent` patterns are the caller's and never evaluated by bareguard; unknown hit id = `stopped`.
11. RULED (hamr, 2026-10-07): `"seed"` baseline = signed counting rule; per-run measured at a signed anchor, recorded in the audit, frozen per `(rubricSha, runId, check)`; a different baseline is refused.
12. RULED (hamr, 2026-10-07): `requiresHuman` checkpoint, signer-set only, tighten-only; ACCEPT via `humanChannel` `{decision:"allow"}` bound to `outputSha` (sha256 of artifact bytes), required even when green.
13. RULED (hamr, 2026-10-07): `patternAbsent` supersedes the 2026-10-06 `no-suppressions` ruling (#4 above).
14. RULED (hamr, 2026-10-07): `blockLines`: blocks of a signed N; non-multiple = red; each phrase in each block.
15. RULED (hamr, 2026-10-07): `complete` sources are a signed list or a caller-supplied list recorded with `outputSha`; never the judge's list; no built-in splitter.
16. RULED (hamr, 2026-10-07): every gap carries a stable `key` and checks a stable `id`; ordered-rule gaps carry `direction`.
17. RULED (hamr, 2026-10-07): `rubricVocabulary` lists every rule's fields, types, required/optional, bounds, defaults (incl. `strict`); descriptions are generated from it.
18. RULED (hamr, 2026-10-07): gate state enforcing a limit is rebuilt from the audit; a resume never resets a count.
19. RULED (hamr, 2026-10-07): judge timeouts are never retried; only a malformed reply gets one retry (supersedes 2026-10-06 #15).
20. RULED (hamr, 2026-10-07): `reads` is a signed per-rubric value, absent = 1 (supersedes 2026-10-06 #9).
21. RULED (hamr, 2026-10-07): `maxReds` is OFF unless set.
22. RULED (hamr, 2026-10-07): each governor / deny rule has a distinct name.
23. RULED (hamr, 2026-10-07): "estimated" pricing counts as priced.
24. RULED (hamr, 2026-10-07): bareguard records the bounded judge facts; the caller keeps the full raw facts.
25. RULED (hamr, 2026-10-07): framing: bareguard builds general pieces for harnesses that have nothing yet; peers' proven shapes are made available, never forced; retry loops, spend caps, typed `done:false`, end door and quarantine, per-run re-signing and no-improvement strike counting stay in the harness.

**2026-10-08** (fwd's spec sign-off)
1. RULED (hamr, 2026-10-08): `sectionOrder` after a MISSING name keeps checking the later names; the search position does not move past the missing one. Missing anywhere = red "missing"; found only before the position = red "out of order".
2. RULED (hamr, 2026-10-08): export `renderGaps(gaps) -> string`: entries in signed check order (stable within a check), joined by "; "; the same failing state always renders the same string; harnesses may detect "stuck" on the render.
3. RULED (hamr, 2026-10-08): `blockLines` requires BOTH `size` and `mustCarry`; either missing is refused at `createRubric`.
4. RULED (hamr, 2026-10-08): bounds in `rubricVocabulary` and `createRubric`: count fields are integers >= 1 with no max; string lists are non-empty arrays of non-empty strings; whitespace-only strings are refused.
5. RULED (hamr, 2026-10-08): `outputSha` = sha256 of exactly the output bytes `checkStep` checked (a string hashed as UTF-8); bareguard never serializes an object to hash it; a harness that hashes differently keeps its own hash.

**2026-10-08** (Module 1 build findings; fwd and loop agreed)
6. RULED (hamr, 2026-10-08): strict is always the tighter result, in both directions: strict `maxWords` counts markers, strict `minWords` counts like forgiving; strict headings take the exact rest of the line after `#{1,6}` + spaces (so `# Summary ##` does not match `Summary`, `## C#` is `C#`), matched only when the forgiving rule also matches.
7. RULED (hamr, 2026-10-08): the phrase field on `mustCarry` and `blockLines` is renamed `text` -> `phrases` (a non-empty list of non-blank strings; `mustCarry` takes a list too, all phrases required); `blockLines` = `{size, phrases}`, both required; `text` on every check is only the signer's explanation (Law 6).
8. RULED (hamr, 2026-10-08): `opts.inputs[name]` supplies `cited`'s frozen source and must match the signed sha256, else `stopped`; a plain-string output is the single field `text`.
9. RULED (hamr, 2026-10-08): `opts.outputBytes` (string, Buffer or Uint8Array) is what `outputSha` hashes, for any output type; an object output with no `outputBytes` has `outputSha` null (Module 2's gate denies it as unbound); bareguard never serializes an object.
10. RULED (hamr, 2026-10-08): `checkStep` returns `baselines` and takes `priorBaselines`; a conflict is `stopped` `baseline-conflict`; the gate (Module 2) records by `(rubricSha, runId, checkId)` and survives resume.
11. RULED (hamr, 2026-10-08): `noneExit` on `commandExit` is refused at `createRubric`.
12. RULED (hamr, 2026-10-08): precedence is stopped > red > green; a stopped verdict gives the worker no gaps and keeps the reds in `full`.
13. RULED (hamr, 2026-10-08): `cited` with zero claims on a non-empty output is red `no-claims`, never a vacuous green, independent of `complete`.
14. RULED (hamr, 2026-10-08): empty or whitespace-only output is red `happened:empty` before `blockLines` (or any check) runs; the foundational check short-circuits.
15. RULED (hamr, 2026-10-08): a `sections`/`sectionOrder` name whose trimmed form ends in `:` is refused at `createRubric`, the error naming it.
16. RULED (hamr, 2026-10-08): a signed name is NEVER clipped in a gap (fwd's longest real name, 159 characters, reached the worker truncated and unreproducible). Signed strings over 1000 characters are refused at `createRubric`; only caller-measured or output-derived values are clipped (120).

**2026-10-08** (Module 2 build; fwd consulted)
17. RULED (hamr, 2026-10-08): the gate mints. New public `gate.checkStep(checkpoint, output, opts)` (async): the GATE runs the checks with its own signed rubric, injects the recorded `priorBaselines` itself, mints the verdict, writes the audit `rubric` line, updates the red counts and buffers the worker gaps for `drainGaps`. Nothing the caller says about a verdict is trusted and there is NO `gate.mint`. It returns the StepResult. The pure exported `checkStep` stays for gate-less agents. (Day 1 imports `rubric.js` statically: the constructor verifies the signature synchronously, and an ES module cannot be lazy-loaded synchronously.) Law 9 unchanged.
18. RULED (hamr, 2026-10-08): `runId` is `config.runId`. The harness passes a stable id on resume (fwd passes `"<flow>/<run>"`); the cold-start rebuild matches audit lines by `run_id` + `rubricSha`. A missing stable `runId` means a resume starts with fresh counts, stated plainly in the docs; no magic.
19. RULED (hamr, 2026-10-08): the `requiresHuman` ask is LIVE by default: rule `rubric.needs-accept`, event key `rubric: { rubricSha, checkpoint, outputSha, verdict, gaps (worker view) }`, asked ONCE per `outputSha`; `{decision:"allow"}` records the ACCEPT bound to that sha; anything else or a timeout denies; a different `outputSha` asks again.
20. RULED (hamr, 2026-10-08): "answer later" is a SIGNED per-checkpoint `accept: "live" | "later"` (default `"live"`, nothing inferred). Only for `"later"`, the harness-only `gate.recordAccept({ checkpoint, outputSha, by, at, askId })` records the ACCEPT; refused (throws + audit line) unless the checkpoint is `requiresHuman` AND `accept: "later"` AND a minted GREEN verdict exists for that exact `outputSha` in this `rubricSha`/`runId`. On a `"later"` checkpoint an advance without an ACCEPT is denied `rubric.needs-accept` with no live ask. Audited, survives cold start.
21. RULED (hamr, 2026-10-08): `advanceOn` is nested in the `rubric` config; `maxReds`/`onExhausted` come ONLY from the signed spec (one source, no top-level gate keys); the red count resets on a re-sign (new `rubricSha`) or an ACCEPT at that `requiresHuman` checkpoint, and on nothing else.
22. RULED (hamr, 2026-10-08): add Needle to the Later table as a "to try" row (a candidate caller-side cheap `locate` judge; needs calibration first).
