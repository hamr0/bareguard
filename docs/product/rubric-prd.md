---
type: product
title: "rubric — signed, deterministic checks that gate an advance (DRAFT)"
status: draft
---

# rubric — DRAFT spec

Evidence, rationale and history: docs/logs/rubric-learnings.md.

*`cited` with `decides` and the typed claim binding (§4.6) is BUILT on `feat/locate-judge` (df699b9, unreleased); the `locate` judge and everything marked PARKED or Next remains spec only. No versions picked. Last updated 2026-10-12 (PIVOT: `cited` + `decides` with a typed claim binding, §4.6, rulings #48-#55, is now built; the `locate` judge, §5.2, is PARKED). Every decision is
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
6. The agent or runner sends the advance action `{ type: <advanceOn>, checkpoint, outputSha }` (a `tool` equal to an `advanceOn` entry counts too, §7)
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
| config `rubric.advanceOn` | the action type(s) or tool name(s) that count as "advance" (matches `action.type` OR a valid `action.tool`), nested in `rubric` (§7) |
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
- `sectionWords`: each listed section's own word count is within +-20% of `wordsPerSection` (ported from fwdloop, RULED 2026-10-08 #25).
- `allowedKeys`: an object output has no own key outside a signed list (ported from fwdloop, RULED 2026-10-08 #26).
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

### 2.1 Doc sites carrying the old boundary line (updated 2026-10-08, Part 3)

All sites below were reworded to the ruled line; `types/gate.d.ts` and `primitives.json` regenerate from the JSDoc. Axis B docs that describe `annotate` as transport keep that framing; `trial-first`, code-mode and D8 are marked DROPPED from the roadmap (§8).

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
| `sectionWords` | `field`, `names:[...]`, `wordsPerSection` | each found section's words are within `[ceil(N*0.8), floor(N*1.2)]` inclusive (no `strict`) |
| `allowedKeys` | `keys:[...]` | the output has no own key outside `keys` |
| `mustCarry` | `field`, `phrases:[...]`, `strict?` | every listed phrase is present |
| `blockLines` | `field`, `size`, `phrases:[...]`, `strict?` | see below |
| `in` / `notIn` | `field`, `values:[...]` | value `===` one of / none of |
| `atMost` | `field`, `value`, `order:[...]` | ordered-enum rank <= value's |
| `max` / `min` | `field`, `value` | finite number <= / >= |
| `cited` | `claims` field, `source` input name, `decides?:[...]` (the shared decide core, §5.2; RULED #48, built df699b9, unreleased) | every claim's quote passes `quoteIn` against the frozen input AND `numbersInQuote`; with `decides`, also every decide on that quote AND the claim's typed `values` equal the values extracted from the quote (§4.6) |
| `complete` | `items:[...]` or `itemsFrom:"caller"`, `claims` field | every item is covered by a claim (§4.4) |
| `judged` | `kind:"locate"\|"verdict"`, `ask`; for `locate`: `sources`, `decides:[...]` (each decide a value decide `valueKind`, `op`, `value` or `lo`+`hi`, `currency?` or `unit?`, `anchor?`, or a presence decide `phrases`) | see §5 and §5.2 (PARKED, RULED #50: `locate` is no longer the next build; the decide core it defined is shared with `cited`, §4.6) |

**Forgiving defaults:**
- **Word**: per line, strip a leading `/^#+\s*/`, split on `/\s+/`, count the non-empty tokens; the
  total over all lines.
- **Heading line**: the line with a leading `/^#+\s*/` stripped, a trailing `/:\s*$/` stripped,
  trimmed, and lowercased; it must be non-empty. A line whose FIRST character is `#` (a `#`-run,
  no leading whitespace) carries a SECOND key as well: the same text with ONE leading ordered-list
  marker stripped (ASCII digits, then `.` or `)`, then at least one space/tab, then a non-empty rest:
  `## 1. Work History` has keys `1. work history` and `work history`; `## 2) Skills` has `2) skills`
  and `skills`). A bare line (no leading `#`) has only the plain key: a bare numbered line is never
  marker-stripped, so `2. Summary` does not satisfy `Summary`. Not a marker, so no second key:
  `2024 results`, `1.5 Skills`, `1.Work`, a bare `1.`, `a) Skills`, bold `**1.** X`, non-ASCII
  digits; only one marker is stripped (`## 1. 2. X` has `1. 2. x` and `2. x`). A section name is
  the name trimmed and lowercased (signed names are NOT marker-stripped); it matches a heading line
  if EITHER key equals it (so `## 1. Intro` matches `Intro` and a signed `1. Intro`; a bare
  `1. Intro` matches a signed `1. Intro`; `## Intro` does not match a signed `1. Intro`). A line
  is one heading position, however many keys it has, so it starts at most one section. A `sections`/`sectionOrder` name whose trimmed
  form ends in `:` is REFUSED at `createRubric` (the `:` is stripped from the line, not the name, so
  it could never match; the error names it) (RULED 2026-10-08 #15).
- **`sections`**: each name must match a heading line anywhere; absent = red "missing".
- **`sectionOrder`**: for each name in order, search forward from the position after the previous
  match. Not found anywhere = red "missing"; found only earlier = red "out of order". It implies
  presence, so `sections` and `sectionOrder` on the same names are redundant but allowed; listing
  both reports the union of reds. After a MISSING name, keep checking the later names; the search
  position does NOT move past the missing one. A harness whose "sections" means an ordered map
  maps it to `sectionOrder` (fwdloop does); presence-only `sections` stays available.
- **`sectionWords`** (RULED 2026-10-08 #25; ported from fwdloop's `wordsPerSection`, M4e amendment 15).
  Headings and words are the forgiving ones above (`#` run not a word, case-insensitive, trailing
  `:` ok, found by the same forward search as `sectionOrder`). A section's words are the words on the
  lines after its heading up to the next FOUND listed heading, or the end; an unlisted heading stays
  inside the section; text before the first found heading belongs to no section. Red per section whose
  count is outside `lo = ceil(N*0.8)` .. `hi = floor(N*1.2)` inclusive (180 -> 144..216). A listed
  section that is missing or out of order is NOT measured by this rule (fwdloop reds it in its separate
  sections check): pair `sectionWords` with `sectionOrder`. There is no `strict` (strict could only
  drop sections from the measure, which is looser). One gap per offending section, in signed order,
  `{kind:"section-words", section, words, asked, lo, hi}` (bounded to 20, `itemsTotal` set when cut; the
  signed `section` is never clipped). `renderGaps` renders it as `<section>: <words> words, about
  <asked> asked (<lo>-<hi>)` (fwdloop's strike detection keys on that string).
- **`allowedKeys`** (RULED 2026-10-08 #26; ported from fwdloop's softgreen extra-key check). Red when
  the output has an own enumerable string key that is not in the signed `keys` (exact, case-sensitive;
  the allowed list is a ceiling, not a requirement). A plain-string output is the single field `text`.
  A non-object, array or null output is already red `happened:wrong-type` before any rule runs; an
  unreadable key list (hostile Proxy) is red `unreadable`, never a throw. Gap
  `{kind:"extra-keys", keys, allowed}`: `keys` in the output's own insertion order (as fwdloop's
  `Object.keys`), clipped to 120 and bounded to 20 (`itemsTotal` when cut); `allowed` is the signed list,
  never clipped. The caller strips `done`/`blocker` before calling (no `ignoreKeys`). `renderGaps`:
  `artifact has key(s) "lines" besides "text"; the check reads "text" only, so put the whole answer in
  "text"` (several allowed keys: `"text", "note"` in the three places).
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

**`cited`: work cap** (RULED 2026-10-08 #24). Each distinct normalized quote costs one linear search
of the source, whatever the quote's length. Before searching, the check counts the DISTINCT
non-empty normalized quotes (identical quotes are searched once); if that count exceeds
`floor(128 MiB / normalized-source-length)` (128 MiB = 134,217,728; 25 quotes at the 5 MiB source
cap, 1,024 at 128 KiB) the check is red with the existing `too-many` gap, `measured` = the distinct
quotes, `limit` = the count this source size allows. A pure function of the inputs, never a clock,
so a verdict is reproducible (Law 8). Exposed as `rubricVocabulary.bounds.quoteWorkMax`.

### 4.2 Pure helpers

**`quoteIn(quote, source)`**: collapse whitespace (`\s+` to one space, trim) and strip `**` and `__`
on both sides, then substring containment. Substring, not line-wise (opt-in `{ wholeLines: true }` matches whole lines instead, RULED 2026-10-08 #27, contiguous-run refinement #28; `cited` does not use it). Empty quote = red. Source cap
**5 MB**; over it = red "source too large". Linear time.
The `cited` rule also caps total search work per check (§4.1, ruling #24).

**`numbersInQuote(claim, quote)`**: number tokens are `/\d+(?:\.\d+)?/g`; every token in the claim
must appear as a token in the quote (`8` does not match `2018`). `8x` is 8, `1.2k` is 1.2, `50%` is
50, `2 weeks` is 2. Number words are unchecked (documented gap). `1,200` vs `1200` is a false red
(thousands separators are not stripped).

**Known looseness (bareloop's $0 re-run on its real Google Flights page, 2026-10-12; RULED #52 keeps the
helper unchanged).** It is a bag-of-tokens test, so it is too loose to be THE binding of a claim to a
quote: a fake `7:00 AM` passes when the digits `7` and `00` occur anywhere else in the quote (a fake time
with a true price would be green); `AM` vs `PM` is invisible (`9:27 PM` passes against `9:27 AM`); roles
are invisible (a price of 40 passes against a duration of 40). It also gives FALSE reds on format
differences: `09:27` vs `9:27 AM` (token `09` is not `9`), `59.00` vs `59`, `1,200` vs `1200`. Those
false reds are acceptable (the worker's fix loop rewrites the claim text in the quote's format); the
looseness is why `cited` with `decides` adds the typed binding of §4.6 and keeps `numbersInQuote` only as
a second net on the free text.

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

### 4.6 `cited` with `decides` and the typed claim binding (RULED 2026-10-12, #48-#55; BUILT on `feat/locate-judge` df699b9, unreleased)

**Why (evidence, §5.2 "POC 2026-10-12").** A judge that points at a quote does not bind the quote to what
the worker CLAIMS (a worker output naming a flight that is not on the page was green three times, because
the judge quoted the nearest real line that passed the decides), and `numbersInQuote` alone is too loose to
bind it (§4.2). So the WORKER grounds its own claims, quote and typed values together, and bareguard
verifies deterministically. No model, no judge, no reads: the result is a plain `green` (no soft-green, no
ACCEPT requirement; RULED #48).

**Without `decides` (verified in `src/primitives/rubric.js`, `runCited`; the behaviour a `cited` check keeps when it signs no `decides`).** The rule table gives `cited` the fields
`claims` (a field name), `source` (an input name, `ref: "input"`) and the universal `text`. A claim is an
object whose OWN string properties `claim` and `quote` are read (anything else on it is ignored; `item`
is read by `complete`). Per claim, in order: a missing or non-string `claim`/`quote` is item
`#<i>:malformed`; a source over the 5 MB cap `#<i>:source-too-large`; an empty normalized quote
`#<i>:empty-quote`; a quote not in the normalized source `#<i>:quote-not-found`; a number token of the claim
not among the quote's `#<i>:numbers:<tokens>`. The first failing reason ends that claim. The check is one
gap `{kind:"unsupported", measured: <claims failing>, limit: <claims>, items: [...]}`, items clipped and
bounded to 20 (`itemsTotal` when cut). Zero claims is `no-claims`; the work cap is `too-many`; a missing
`opts.inputs[source]` or a sha256 mismatch is `stopped` `missing-measurement`. With no `decides` there is no
claim value and no quote length bound. Everything above is unchanged when a `cited` check signs no
`decides` (byte-for-byte; RULED #48).

**The signed check and the claim.**

```js
// check (signed): `decides` is optional; same decide shapes and limits as §5.2 (value or presence; <= 10)
{ id: "flight-1", rule: "cited", claims: "claims", source: "offers",
  decides: [
    { valueKind: "money", unit: "US dollars", op: "lt", value: 400, anchor: "From " },                       // d0
    { valueKind: "time", op: "between", lo: "06:00", hi: "21:00", anchor: "Leaves Los Angeles International Airport at " }, // d1
    { phrases: ["Nonstop flight"] } ] }                                                                       // d2: no claim value

// claim (the worker's output): { claim, quote } as today, plus `values`
{ claim: "American nonstop, departs 9:27 AM, $59",
  quote: "From 59 US dollars. Nonstop flight with American. ... Leaves Los Angeles International Airport at 9:27 AM on Thursday, November 12 ...",
  values: { d0: "59", d1: "9:27 AM" } }
```

`decides` joins the `cited` descriptor in `rubricVocabulary` (RULED #46's list-of-decides descriptor, shared
with the parked `judged`), is validated at `createRubric` exactly as §5.2 specifies (value XOR presence,
`between` needs `lo`+`hi`, `money` signs exactly one of `currency`/`unit`, bounds parsed by the same parser,
at most 10, the whole list in `rubricSha`). Every claim of the check must satisfy the whole list: a check
whose claims are of different shapes is split into several `cited` checks over different `claims` fields.

**Per claim, in this order** (a claim stops at its first QUOTE failure; once the quote is proven, every
later step runs and ALL its reds are reported):

1. **`quoteIn`** the quote against the frozen source (default substring mode), as today. A failure ends the
   claim: no decide runs on an unproven quote, no binding is checked.
2. **Quote length.** Only when the check signs `decides`: a normalized quote over 4000 characters is item
   `#<i>:quote-too-long` (bounds the extraction work; the 4000 is the number §5.2 already carries). Without
   `decides` there is no such bound, as today.
3. **`decideQuote(quote, decides)`**: every decide on that ONE quote (co-location, RULED #36). Each red
   decide is item `#<i>:d<j>:<kind>` (`j` = 0-based index in `decides`, `kind` as in §5.2: `anchor-missing`,
   `value-none`, `value-many`, `value-over`, `phrase-missing`, ...).
4. **The typed binding** (below).
5. **`numbersInQuote(claim text, quote)`**, unchanged semantics, kept on the free text on purpose (RULED
   #52): it catches a stray number in the text (item `#<i>:numbers:<tokens>`). **The claim TEXT must spell
   numbers as the quote does**: only `values` are canonicalized. Real case (quote reads `9:27 AM`): claim
   text `9:27 AM` with `values.d1` `"09:27"` is green; claim text `09:27` is red `#<i>:numbers:09`, because
   the text token `09` is not among the quote's tokens (the `values` entry `"09:27"` is fine on its own).

**The typed binding (RULED #49).** For EVERY VALUE decide `d<j>` of the check, the claim must carry its own
value in `claim.values["d<j>"]`, and that value must EQUAL the value the decide extracted from the quote.

- **Key.** `values` is a plain object keyed by `d<j>`, `j` the decimal 0-based index of the decide in the
  signed `decides` list (`d0`, `d1`, ... `d9`; no leading zeros, case-sensitive). The index form is used in
  every gap item, so the worker's fix loop already speaks it; it adds no signed field and cannot collide.
  A position is bound to its role by the signed order, so the worker cannot swap roles (a price into a
  duration slot): the value in `d1` is compared with the value extracted by decide 1 only. (The alternative
  of a signed per-decide `id` is open question 1.)
- **Form of a claim value.** A bare STRING holding exactly one token of the decide's `valueKind` and nothing
  else (after `normalizeForQuote`, so surrounding whitespace is fine; no sentence, no symbol, no unit):
  `number` and `money`: the `number` grammar of §5.2 (`59`, `59.00`, `1,200`, `1200`, `0.5`; `number` may
  carry a leading `-`, `money` may not; NO currency symbol and NO unit text, the decide's signed
  `currency`/`unit` already defines the role, so `"$59"` and `"59 US dollars"` are malformed); `date`:
  exactly one ISO `YYYY-MM-DD`; `time`: exactly one time token, 24-hour or `h:mm AM|PM` (`"9:27 AM"`,
  `"09:27"`, `"21:27"`). It is parsed by the SAME grammar as the quote's value (a new pure function
  `parseClaimValue(valueKind, raw)` in `rubric-locate.js`, built on the same readers, because
  `parseBound` takes a JS number for `number`/`money`). A value that is not a string (a JSON number, `null`,
  an object) is malformed (open question 2).
- **Equality, exact and canonical.** Both sides are reduced to the canonical form of §5.2 (exact decimal
  string for `number`/`money`, `YYYY-MM-DD` for `date`, minutes since midnight for `time`) and compared for
  equality: `09:27` equals `9:27 AM`, `59` equals `59.00`, `1,200` equals `1200`, `-0` equals `0`, `9:27
  PM` does NOT equal `9:27 AM`. The decide's `op`/bounds are NOT applied to the claim value; the quote's
  value is what the decide judges, and the equality ties the claim to it. Canonicalization applies to
  `values` ONLY, never to the claim text (step 5).
- **Reds** (each an item, all reported):
  - `#<i>:d<j>:claim-value-missing`: a value decide with no `values["d<j>"]` (also when `values` is absent
    or `{}`).
  - `#<i>:d<j>:claim-value-malformed`: present but not parseable as that decide's kind (including a
    non-string). `#<i>:values:claim-value-malformed`: `values` present but not a plain object (an array,
    `null`, a string).
  - `#<i>:d<j>:claim-value-mismatch:<claim>!=<quote>`: both canonical (display forms: decimal string,
    `YYYY-MM-DD`, `HH:MM`; output-derived, each clipped to 120). BOTH sides are canonical forms, never the
    worker's spelling: a worker's `9:27 PM` shows as `21:27`, `7:00 AM` as `07:00`, `59.00` as `59`). Evaluated whenever the quote's decide
    extracted a value (including a decide that is red on its op, e.g. `value-over`); not evaluated when
    the extraction itself failed (the decide's own red already says so).
  - `#<i>:<key>:claim-value-unknown`: a key of `values` that is not `d<j>` of a VALUE decide: a presence
    decide's index, an index past the list, any other string, a duplicate-looking key (`D0`, `d00`).
    `<key>` is output-derived, clipped to 120. This covers a claim carrying `values` against a check with
    NO `decides` (every key is unknown; the claim is red, never silently ignored; open question 4).
- **Presence decides need no claim value.** A check holding only presence decides takes claims without
  `values`. **"No numbers = red" is NOT ported** (RULED #51): a number-free claim (`nonstop`) is fine; where
  the fact matters, the spec author signs a presence decide for it.

**Gap.** The kind and fields of the check's gap are unchanged: one gap per failing check,
`{kind:"unsupported", measured: <claims with at least one red>, limit: <claims>, items}`, `key`
`<checkpoint>:<id>`. `items` is the flat list of reds over all claims in claim order (within a claim: the
decide reds in decide order, then the binding reds in decide order then unknown keys in the object's own
key order, then `numbers`), clipped and bounded to 20 with `itemsTotal` when cut. The new reason words are
the new "gap kinds": `claim-value-missing`, `claim-value-malformed`, `claim-value-mismatch`,
`claim-value-unknown`, `quote-too-long`, plus the §5.2 decide kinds under a `d<j>:` prefix. An item is
assembled from clipped output-derived parts (claim values, keys, quotes: 120) and UNCLIPPED signed parts,
so a signed phrase in `#<i>:d<j>:phrase-missing:<phrase>` is never cut; anchors, bounds and units are not
in items (the worker has the spec). `renderGaps` renders it as the default JSON row (no plain sentence).
`decideQuote` runs once per distinct normalized quote (memoized; the claim values are then compared per
claim), so the work stays inside the existing cap.

**Real-page check 2026-10-12 (bareloop, df699b9; `createRubric` + `checkStep`, $0, no model).** On its
real captured Google Flights page: 44 honest claims = 39 green / 5 red, the 5 exactly the after-21:00
departures. Fake `7:00 AM` with the true price = `#0:d1:claim-value-mismatch:07:00!=06:00`; fake price =
`#0:d0:claim-value-mismatch:45!=59`; `9:27 PM` on an AM line = `21:27!=09:27`. Missing `values`, `"$59"`, a
JSON number, an unknown key, a stray number in the text and a paraphrased quote were all red as specified.
44 wrong-price claims = `items` bounded to 20, `itemsTotal` 49 (`itemsTotal` counts ITEMS over all claims,
not claims: the 44 price mismatches plus the 5 time-op reds).

**What this proves, and does not.** It proves that each claim comes with a quote that is verbatim in the
frozen source, that every signed fact holds on that same quote, and that the values the worker DECLARED are
the values on that quote, in the roles the spec names. A flight named in the output that is not on the
page cannot pass: its declared time or price will not equal the nearest real line's. It does NOT prove the
free text of the claim beyond its numbers (the carrier name, a prose adjective): a fact that matters is a
presence decide or a typed value. It does NOT prove the worker picked the BEST option ("cheapest",
"earliest", "N best"): that is the superlative check of §11 build step 3. The claim's source is one signed
input today; pages registered mid-run (§5.3) are build step 2.

**Not now (RULED #55).** One claim backed by TWO quotes from TWO sources (multi-source claims) is Later.

## 5. Judges

> **PARKED (RULED 2026-10-12, #50).** The judge kinds below (`locate`, `verdict`), `reads`/`agree`, soft-green via a judge and calibration are not the next build; the design text is kept. The decide core of §5.2 is NOT parked: it ships first inside `cited` (§4.6). Any future `locate` judge REQUIRES an output-binding claim that uses the typed binding of §4.6 (RULED #53); it supersedes the earlier idea of `numbersInQuote` plus "no numbers = red".

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
- A **timeout** (or transport error) is never retried by bareguard: it is `stopped`. The caller's judge
  function MAY retry internally within `deadlineMs` (RULED 2026-10-12 #44); bareguard sees only the final
  answer or throw.
- A **malformed reply** gets exactly **one retry**, then red (`clean`). Never repair a reply.
- Unpriced = red, never retried. "estimated" pricing counts as priced; only unpriced is red.
- What the judge said is recorded in bounded form: the quote's start (clipped), its original length
  and the sha256 of the full quote. The full raw judge facts are the caller's to keep.

**Repetition: signed `reads: N`** (per rubric; absent = 1; Next):
- The locate judge is called **N times**, each an independent call (prompt caching fine; replaying
  a cached response is not).
- The deterministic decide runs on **each** read's quote (a `locate` check has exactly one quote per
  read, §5.2). A read's decided outcome = the verdict plus the set of reds keyed `(check, decide)` plus,
  for a `locate` check, each decide's extracted value (RULED 2026-10-12 #38).
- **Compare decided outcomes and extracted values, not raw quotes.** Any difference = red `agree`
  ("judges disagree", each read's outcome in the full view). A read's malformed reply gets its own one retry before
  counting. A read that times out makes the whole check `stopped`.
- `verdict`-kind judges compare `verdict` only.
- Cost = N x judge calls, each reported through the existing budget path; the minted record says how
  many reads ran.

**Calibration (Later, bareguard's own).** The judge identity is in the hash now, so a model bump
forces a re-sign. It should grade each case `reads` times and require all N correct. An
uncalibrated judge's soft-green is acceptable only because the final ACCEPT exists (§6).

### 5.1 Using bareagent's jev as a verdict judge (PARKED, RULED #50; was Next, after the `locate` build)

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

### 5.2 The decide core, shared by `cited` (now, §4.6) and the `locate` judge (PARKED) (RULED 2026-10-12, #30-#47; the core is built pure and wired into `cited` on `feat/locate-judge` df699b9, unreleased; the `locate` judge stays PARKED)

#### POC 2026-10-12 (why the plan changed; RULED #48)

bareloop ran a POC with a real judge (DeepSeek `deepseek-flash`, pinned; 30 calls, about $0.01) on its real
captured Google Flights page (LAX to SFO, 44 result lines) plus its CHANGELOG, against the pure core at
commit 4fcca4a. Evidence, in the order it was gathered:

- **$0 step, no model.** `decideQuote` on all 44 real lines with the E4 decides: 39 green, 5 red, and the 5
  reds are exactly the departures after 21:00. The 12-hour parsing and the anchors are correct on real text.
- **The judge pointed well.** Exactly one quote 30/30; the right line 24/24 where one exists; 0 malformed
  replies. Once in 4 runs it quoted a card's child rows instead of the link line (red at `quoteIn`).
- **But nothing bound the quote to the worker's claim.** A worker output naming a flight that is NOT on the
  page (`United, departs 7:00 AM, $45`) was GREEN three times: the judge quoted the nearest real United
  line, which passes the decides. A vague claim produced 3 different outcomes in 3 runs.
- **`numbersInQuote` is too loose to be the binding.** A $0 re-run of cited-style checks (`quoteIn` +
  `numbersInQuote` + `decideQuote`, hand-written claims, no model): the fake `7:00 AM` passed because the
  digits `7` and `00` occur elsewhere in the line (a fake time with a true price would be green); AM/PM is
  invisible (`9:27 PM` vs `9:27 AM` passes); roles are invisible (price 40 vs duration 40); and it gave
  false reds on `09:27` vs `9:27 AM`, `59.00` vs `59`, `1,200` vs `1200`.

**What changed.** The next build is `cited` + `decides` with a typed claim binding (§4.6), not the judge:
the worker grounds its own claims and bareguard verifies deterministically (RULED #48-#52). The judge-call
parts of this section (the `judged` check shape, "The judge call", "Per-read decide", `reads`/`agree`,
soft-green, the foundational-check table) are PARKED but kept as written; the decide core below
(shapes, anchors, extraction, per-kind grammar, exact comparison, canonical forms, decide gap kinds,
examples E1-E4) is shared and is what `cited` uses first. Any future `locate` judge must also carry an
output-binding claim built on the typed binding (RULED #53).

**Reading guide.** LIVE and shared: "The signed check shape" (the decide table and the vocabulary
conditionals only), "Extraction: shared rules", "Anchor", "Extraction: per value kind", "Exact comparison",
"Canonical forms and the pure core", the decide gap kinds, examples E1-E4. PARKED: the `judged`/`locate` check
wrapper and its fields, "The judge call", "Per-read decide" step 1, `reads`/`agree`, soft-green and ACCEPT
wiring, "What this proves" of the judge, the foundational-check table. Where parked text says "the judged
check", read it as "the check that holds the decides"; for `cited` that is §4.6.


The first judge to build, and the only consumer that needs one is bareloop (fwd needs none; its PRD
says "No LLM judge"). The shape: the judge only POINTS. It returns ONE quote per read and which signed
source it came from; bareguard's own code proves the quote is in that source, then runs the check's
signed LIST of decides on that one quote (extract a value of a signed kind and compare it with a signed
bound, and/or require a signed phrase). The judge never supplies a value, a verdict or a score (Laws 5,
8). The sources are the signed `inputs` already in the spec (§3), frozen by sha256 before the run.
Pages fetched mid-run are NOT in this build (§5.3).

**Why one quote (RULED #36).** The requirement is CO-LOCATION: the facts that make one claim true
must sit in the same line. bareloop's real Google Flights result (LAX to SFO, barebrowse snapshot, $0)
is ONE link line carrying the price, the departure time, the stops and the carrier; the price in
`StaticText "$59"` or the departure in `generic "Departure time: 9:27 AM."` elsewhere on the page
could belong to a different result. A check that decides several quotes separately cannot prove they
are the same flight; a check that decides several facts on ONE quote can. So: one judged check = one
claim = one quote per read = one list of decides, all of which must pass on that quote.

**Today (verified in `src/primitives/rubric.js` and `src/primitives/rubric-locate.js`).** The pure decide core is BUILT in
`rubric-locate.js` (`parseBound`, `extractValue`, `evalDecide`, `decideQuote`) and is imported by `cited`
in `rubric.js` (§4.6, built df699b9, unreleased) and by its own test (`test/rubric-locate-decide.test.js`); it is
not exported from `src/index.js`, and no `judged` rule uses it (PARKED; the per-read outcome comparator of §5.2 (#38) is not built, it belongs to the parked judge). `createRubric` refuses a `judged` rule as an
unknown rule, and `checkStep` throws a `TypeError` when given a `judge` option. The spec keys
`judge` (identity: `provider`, `model`, `cutoff?`, `band?`) and `reads` (integer >= 1) are already
validated and already in `rubricSha`. `quoteIn` normalizes both sides with `normalizeForQuote` (strip
`**` and `__`, collapse whitespace, trim) and tests substring containment; `numbersInQuote` tests a
claim's number tokens against a quote's. `cited` reads its source from `opts.inputs[name]` and makes
a missing text or a sha256 mismatch `stopped` (`missing-measurement`). The `Fault.kind` typedef does
not list `judge-no-answer` yet (the PRD §6 list does). The judge parts of this section would change all of that and are PARKED; §4.6 changes only `cited`.

#### The signed check shape

```js
// REAL: bareloop's captured Google Flights result line (see the examples below)
{ id: "flight-1", rule: "judged", kind: "locate",
  ask: "Quote the result line (the link) for the cheapest nonstop flight.",
  sources: ["offers"],
  decides: [
    { valueKind: "time", op: "between", lo: "06:00", hi: "21:00", anchor: "Leaves Los Angeles International Airport at " },
    { valueKind: "time", op: "lte", value: "12:00", anchor: "arrives at San Francisco International Airport at " },
    { phrases: ["Nonstop flight"] } ] }

// a money decide with a symbol (ruling #37)
{ id: "fare", rule: "judged", kind: "locate", ask: "Quote the line that states the total price.",
  sources: ["offers"],
  decides: [ { valueKind: "money", currency: "$", op: "lt", value: 400, anchor: "Total:" } ] }

// a money decide with a unit instead of a symbol (ruling #43): matches `From 59 US dollars.`
{ id: "price", rule: "judged", kind: "locate", ask: "Quote the result line (the link) for the cheapest nonstop flight.",
  sources: ["offers"],
  decides: [ { valueKind: "money", unit: "US dollars", op: "lt", value: 400, anchor: "From " } ] }

// a single date decide on a file
{ id: "newest-release", rule: "judged", kind: "locate",
  ask: "Quote the heading line of the newest release in the changelog.",
  sources: ["changelog"],
  decides: [ { valueKind: "date", op: "gte", value: "2026-10-01" } ] }
```

Check-level fields (the final field list, RULED #41):

| Field | Type | Required | Rule |
|---|---|---|---|
| `kind` | `"locate"` | yes | `"verdict"` is refused at `createRubric` until its build (§5.1) |
| `ask` | signed string | yes | what the judge is asked; non-blank, max 1000 characters (rides unclipped). Never decides (Law 6) |
| `sources` | non-empty list of input names | yes | no duplicates; each must be in `spec.inputs` (same `ref: "input"` check as `cited`'s `source`) |
| `decides` | non-empty list of decide objects, at most 10 | yes | every decide must pass on the ONE quote (below). Checked in order, all evaluated |
| `text` | explanation | no | as on every check |

A decide is EXACTLY one of two shapes (a mix, or neither, is refused at `createRubric` naming the path):

| Field | Value decide | Presence decide | Rule |
|---|---|---|---|
| `valueKind` | `"number"` \| `"money"` \| `"date"` \| `"time"` | refused | which parser runs (below) |
| `op` | `"lt"` \| `"lte"` \| `"gt"` \| `"gte"` \| `"between"` | refused | `value < bound`, `<=`, `>`, `>=`, or `lo <= value <= hi` (BOTH ends inclusive) |
| `value` | number (`number`, `money`) or string (`date`, `time`) | refused | the bound; required unless `between`, refused with `between`. Parsed by the SAME parser as the quote's value, at `createRubric`; a bad bound is refused naming the path |
| `lo`, `hi` | same type as `value` | refused | both required with `between`, refused otherwise; `lo <= hi` required (a wrap-around window such as 22:00-02:00 is refused) |
| `currency` | `"$"` \| `"€"` \| `"£"` | refused | with `money`: exactly one of `currency` or `unit` is required (XOR, RULED #43); refused otherwise. The only symbol that counts as a money value |
| `unit` | non-blank string, max 100 characters | refused | with `money`: the signed unit text that follows the number (`"US dollars"`); XOR with `currency`; refused on any other `valueKind`; case-sensitive, exact as signed; never clipped in a gap |
| `anchor` | signed non-blank string | refused | optional; see "Anchor"; max 1000 characters; never clipped in a gap |
| `phrases` | refused | non-empty list of non-blank strings | the PRESENCE decide: every phrase must be a case-insensitive substring of the quote (the `mustCarry` rule, on the normalized quote) |

The bound field is `value` because that is the name `maxWords`, `max` and `min` already use for their
signed number; `op` is the comparison; `phrases` is the existing `mustCarry`/`blockLines` word. The
whole check, including `sources`, every decide, `anchor`, bounds and phrases, is in `rubricSha`. A numeric `value`/`lo`/`hi`
must have a plain decimal rendering (`String(n)` with no exponent); `1e21` is refused. A rubric that
holds any `judged` check must carry a non-null `spec.judge` identity (refused otherwise), and a
GATING checkpoint holding one must be `requiresHuman` (refused otherwise, RULED #39, see "Soft-green").
The vocabulary entry for `judged` is generated like every other rule (§9): it needs a new descriptor
type for a list of nested decide objects (the exact descriptor is settled at build, RULED #46), the name list and enums, and documented
conditionals (a decide is value XOR presence; `between` requires `lo`+`hi` and forbids `value`; the
other four ops require `value` and forbid `lo`/`hi`; `money` requires exactly one of `currency` or `unit`).

#### The judge call

`opts.judge` is a function (a later build may also accept `{ locate, verdict }`, open question 1),
`opts.deadlineMs` is required with it (§5 call hygiene). Per judged check, per read:

```
judge(input, check, { signal, identity }) -> { quotes: [{ source, quote }], facts?, pricing? }
  input    = { output, sources: { [name]: text } }  // only the check's own `sources`, hash-verified
  check    = the signed check ({ id, ask, sources, decides })
  identity = the signed spec.judge
```

- The reply carries EXACTLY ONE quote (RULED #36): `quotes` is an array of length one. `source` must
  be one of the check's `sources`, `quote` a string. `facts` is recorded in bounded form and never
  decides. `pricing` follows `Result.pricing`: absent or `"estimated"` = priced, `"unpriced"` = red.
- **Malformed** = the reply is not a plain object, `quotes` is not an array, or an element is not an
  object with string own `source` and `quote`. One retry (an independent call), never repaired; still
  malformed = red `clean` gap `malformed`. An empty `quotes` array is an ANSWER ("found nothing"),
  not malformed: no retry, red `clean` gap `no-quotes`. **Two or more quotes is an answer too, and
  red**: gap `too-many` (`measured` = count, `limit` = 1), no retry, nothing is decided on any of
  them. This is what keeps co-location provable: a judge cannot satisfy one decide with one line and
  another decide with a second line.
- **Unpriced** = red `clean` gap `unpriced`, no retry. **Throw, reject, transport error or timeout past
  `deadlineMs` = `stopped`** with fault `judge-no-answer`, never retried (RULED #33). The loop's harness
  treats `stopped` as an instrument stop, never as a strike on the worker (RULED #37).
- `opts.inputs[name]` for every source must be present and hash to the signed `sha256`, or `stopped`
  `missing-measurement` (as `cited`). Rubric holds a `judged` check but `opts.judge` is absent =
  `stopped` `missing-measurement` (a harness bug, not a red). A source over the 5 MB cap is red
  `source-too-large` BEFORE the judge is called (no spend on a call that cannot be checked).
- A normalized quote over 4000 characters is red `quote-too-long` (`measured` = length, `limit` =
  4000). The 20-quote cap of the first draft is gone: there is one quote. The 4000 stays because it
  still bounds the audit record and the extraction work (RULED #37).
- **Judge-internal retry (RULED #44).** The caller's judge function MAY retry internally (for example
  once on a transport failure or an HTTP 429) as long as it finishes within `deadlineMs`. bareguard sees
  only the final answer or the final throw, counts it as one call, and still never retries a throw or a
  timeout itself.
- Cost is the caller's to report through the budget path (§7 Interactions); bareguard accrues nothing.
- **Worst-case time (RULED #40).** The only time limit is the caller's per-call `deadlineMs`; there is
  no signed total wall. A judged check can therefore take up to `reads x 2 x deadlineMs` (each of the
  `reads` independent calls may run twice, the second being the one malformed-reply retry). A
  checkpoint with several judged checks sums them. A caller that needs a hard wall sets `deadlineMs`
  from it.

#### Per-read decide (deterministic, in this order)

1. **Exactly one quote** (above): 0 = `no-quotes`, 2+ = `too-many`.
2. **`quoteIn`** the quote against the named source's text in default (substring) mode. A `source`
   not in the check's `sources` = red `unknown-source`; an empty normalized quote = `empty-quote`; not
   found = `quote-not-found`. These reds belong to the foundational `quoteIn` check (`check: "quoteIn"`).
   A failure here ends the read: no decide runs on an unproven quote.
3. **Every decide, in signed order, on that same normalized quote.** All are evaluated (a failing one
   does not hide the others, so the worker's gap shows every failing decide). A value decide
   **extracts** exactly one value of its `valueKind` (below; zero, two or more, or a malformed token =
   red; unsure = red, Law 1) and **compares** it with its bound exactly (no floats, below). A presence
   decide is red `phrase-missing` when any of its phrases is absent.

The check is green only if the judge returned exactly one quote, it is in the source, and EVERY decide
passes. A decide can only add reds; none is ever dropped to turn a red green. `numbersInQuote` is NOT
applied to a locate check: it pairs a claim with a quote, and a locate judge returns no claims. The
exactly-one-value rule does that job here.

**What this proves, and does not.** bareguard proves that the one quote is in a frozen signed source
and that every signed fact holds on that same line. It does not prove the judge pointed at the RIGHT
line ("the cheapest flight" can be answered with a different flight that also passes). That is why a
green locate is a soft-green (below) and why `anchor`, `reads` and the human ACCEPT exist.

#### Extraction: shared rules

All parsing is hand-coded, single pass over UTF-16 code units, linear, no regex with backtracking
and no user regex. It runs on the quote after `normalizeForQuote` (the text `quoteIn` matched), so
the parsed text is the proven text. **Every "one space" below means one space AFTER normalization (RULED
#47):** `normalizeForQuote` collapses every whitespace run (spaces, tabs, newlines) to a single space
first, so `9:27  AM` and `59  US dollars` read exactly as `9:27 AM` and `59 US dollars`. The decide
never sees a run of two spaces or a tab. An anchor is normalized the same way. (The scanners themselves
still refuse a double space or tab if ever handed raw text; that is a unit-test fact, not a signed
behavior.) Digits are ASCII `0-9` only (non-ASCII digits are never digits).
Comparison is case-sensitive wherever a letter matters.

**Adjacency, fail-closed.** A value token directly preceded or followed by an ASCII letter is
MALFORMED (red), never read around it: `1.2k` and `5m` would otherwise read as 1.2 and 5 and be wrong
by orders of magnitude; `08:10am`, `2026-10-12T08:00`, `v2` are unsure. Not a letter, so allowed
after a token: a space, `%`, `)`, `,`, `;`, a trailing `.`, an en dash, an arrow, any non-ASCII
symbol (`50%` is 50, `2 weeks` is 2; `$59,` is 59; `9:27 AM.` is 9:27 AM). The one exception to
"a letter after a token is malformed" is the `time` suffix ` AM` / ` PM` (below): that suffix is part of
the token, not an adjacent letter, so it is consumed by the time grammar before this rule looks at the
character after it. A sign: an ASCII `-` directly before a token that sits at the start of the quote or follows
whitespace or `(` is a sign; any other `-` directly before a token (`2026-10`) is a separator and is
ignored. A sign makes a `number` negative and is MALFORMED on a `money` or `time` token (`-$5`).
U+2212 (`−`) directly before any `number`, `money` or `time` token is MALFORMED (it is never read as
a minus, never dropped). `(` directly before a `money` or `number` token is MALFORMED (accounting
negatives).

**Anchor.** With a signed `anchor`, the rule changes from "exactly one value in the quote" to "the
value right after the anchor". The anchor is normalized with `normalizeForQuote` (so `"LAX "` equals
`"LAX"`) and searched, case-sensitive, in the normalized quote:
- not in the quote = red `anchor-missing`;
- in the quote twice or more = red `anchor-ambiguous` (unsure = red, RULED #37; never "use the first");
- once: the text after it, with at most whitespace skipped, must BEGIN with a token of `valueKind`;
  otherwise red `value-none` (carries `anchor`). That token alone is the value. A malformed token
  there is red `value-malformed`. Every other value elsewhere in the quote is ignored: that is what an
  anchor is for. (Strictly adjacent, not "next value in the text", RULED #37.) Each decide has its own anchor, searched in the
same quote; one decide's anchor never moves another's.

**Without an anchor** (per decide) every token of the kind is counted: zero = red `value-none`, two or more =
red `value-many` (`measured` = the count, `values` = the values, canonical, clipped, bounded 20 with `valuesTotal` when cut), one
= the value. A malformed token in an unanchored quote is red `value-malformed` (it is not counted
away: a quote with `0.41.0` in a `number` check is unsure).

#### Extraction: per value kind

**`number`.** A numeric run is a maximal run of `0-9`, `,` and `.` that starts with a digit. Trailing
`.` and `,` characters are cut off the run first (sentence punctuation). The rest must be exactly
`D+ ( "," D D D )* ( "." D+ )?` read left to right: if any `,` is present the first group is 1-3
digits and every later group is exactly 3; at most one `.`, followed by at least one digit. Anything
else (`12,34`, `0.41.0`, `1.2.3`, `1,2`) is MALFORMED. The value is that decimal with the commas
removed. A sign is as in the shared rules above (`-5` is negative; `2026-10` has no sign). `+` is ignored. Not interpreted: `%` scaling, `k`/`m`/`b` suffixes (malformed by adjacency), number
words, exponent forms, a leading `.` (`.5`: the run starts at `5`, preceded by `.`, MALFORMED).

**`money`.** A money decide signs exactly ONE of `currency` or `unit` (RULED #43); the two are never
mixed on one decide, and a check that needs both forms signs two decides.
- **With `currency`** (the symbol form): the signed symbol, then immediately a numeric run with the
  `number` grammar, no sign, no space between (`$318.40`, `$1,234`, `€400`). Only tokens with that symbol
  count: a bare `1234`, or `€400` in a `$` check, is not a money value (`€400` is ignored, not
  malformed). A symbol not followed by a digit is ignored. Currency codes (`USD`) and a TRAILING symbol
  (`400 €`) are not read (RULED #37).
- **With `unit`** (the unit form, RULED #43): a value is a numeric run (the `number` grammar, no sign)
  immediately followed by exactly ONE space (after normalization, #47) and then the signed `unit` text, matched exactly as signed
  (case-sensitive, no case folding: `59 US dollars` matches `unit: "US dollars"`, `59 us dollars` and
  `59 US Dollars` do not), and the unit text must NOT be followed by an ASCII letter (`59 US dollarsX` is
  not a value). The numeric run is the value; the space and the unit are not part of it. Any other
  character, or the end of the quote, may follow the unit (`From 59 US dollars.` is 59; so are `, `, `)`
  and `;`). Thousands separators work as in the `number` grammar: `From 1,234 US dollars.` with anchor
  `From ` is 1234. A number NOT followed by a single space plus the unit (`59 dollars`, `59US dollars`,
  `59US dollars`, a bare `59`) is not a value of this decide: it is ignored, not
  malformed. The shared adjacency rule still applies to the numeric run (`v59 US dollars`, `1.2k US
  dollars` are malformed). Still exactly one value: unanchored, two matches are `value-many`, none are
  `value-none`; still anchorable, with strict adjacency as for every other kind: the anchor, then (at
  most whitespace skipped) the number, then one space and the unit (`From 59 US dollars` with anchor
  `From ` reads 59; an anchor followed by a number that is not followed by the unit is `value-none`).
  Only the matching token of the signed unit counts, so other numbers on the line (`1 hr 40 min`,
  `0 checked bags included`) are never money values and never malformed.
- Fractional digits: any count >= 1; compared exactly (as every `number` and `money` value).

**`date`.** A candidate is a maximal run of `0-9` and `-`. Only a run of exactly the shape
`dddd-dd-dd` is a date token; any other run is ignored (so `0.41.0`, a lone ` - `, `1234` are
ignored, and `12026-10-12` yields nothing). A date-shaped run must be a real Gregorian calendar day
with year 0001-9999, else MALFORMED (`2026-13-45`, `2026-02-30`). One format only: ISO `YYYY-MM-DD`
(RULED #37: date checks are on files, not search pages; a travel date lives in the signed search url). Compared as the fixed-width string.

**`time`** (RULED #34). A candidate is a maximal run of `0-9` and `:`. A run containing a `:` must be
exactly `d:dd` or `dd:dd`, minutes 0-59, else MALFORMED (`8:7`, `08:10:30`, `123:45`); a run with no `:`
is ignored (`1234`). Two forms:
- **24-hour**: no suffix, hours 0-23 (`24:00` is MALFORMED). `9:27` is 09:27.
- **12-hour**: the token followed by exactly ONE space (after normalization, #47: a double space or tab collapses to it) and then `AM` or `PM` in UPPERCASE, the two letters
  NOT followed by an ASCII letter (end, space, `.`, `,`, `)` all fine). Hours 1-12 (`h:mm AM` or `hh:mm AM`);
  hour `0` or `13`+ with a suffix is MALFORMED (`00:30 AM`, `13:05 PM`). Meaning: `12:xx AM` = `00:xx`,
  `12:xx PM` = `12:xx`, `h:xx AM` = `h:xx`, `h:xx PM` = `h+12:xx` (`12:05 AM` = 00:05, `12:05 PM` =
  12:05, `9:27 AM` = 09:27, `9:27 PM` = 21:27, `11:07 AM` = 11:07).
- **Not accepted, and MALFORMED (never read as 24-hour, because `08:10 PM` must not pass as 08:10)**:
  lowercase or mixed case (`9:27 am`, `9:27 Am`), the dotted forms (`9:27 a.m.`, `p.m.`), no space
  (`9:27AM`, already malformed by letter adjacency), and any other letters glued to an UPPERCASE
  suffix (`9:27 AMX`, `9:27 AMD`, `9:27 PMS`, `9:27 AMERICAN`: all malformed, fail-closed). A bare `:` with no digit
  in its run (`Total:`) is not a time and is ignored; a run with a `:` and a digit that is not `d:dd`/`dd:dd`
  (`9:27:`, `8:7`) is malformed. Lowercase and dotted are left out because the real page uses
  uppercase only and each extra spelling is another way to misread; widening is a later, signed ruling
  (open question 5). A time followed by a space and a word that merely STARTS with those letters
  (mixed or lower case beyond two letters, `9:27 American`, `9:27 ampere`) is the 24-hour time 09:27 followed
  by a word: the suffix is exactly the two uppercase letters not followed by a letter. Exactly two letters
  `am`/`Am`/`pM` after the space are malformed (never read as a word).
- Signed bounds (`value`, `lo`, `hi`) go through the same parser, so `"9:00 PM"` is a legal bound; they
  are stored as the canonical minutes.
Compared as minutes since midnight; no time zone, no date. Linear and hand-coded: the token is read
left to right, then a fixed look-ahead of at most 4 characters decides the suffix.

**Exact comparison.** `number` and `money` values and bounds are exact decimals (integer part,
fraction part, sign) compared digit by digit; never IEEE floats. `0` is a value (a zero is not
"absent"); `-0` equals `0`.

#### How the foundational checks apply

| Check | On a locate check |
|---|---|
| `clean` | red on `malformed` (after the one retry), `no-quotes`, `unpriced`; `check: "clean"`, `id` = the judged check's id |
| `quoteIn` | the one quote, against its named source; reds `unknown-source`, `empty-quote`, `quote-not-found`, `source-too-large`; `check: "quoteIn"` |
| `numbersInQuote` | not applied (no claim is paired); see above |
| `agree` | `reads > 1`; below |
| `signed` | unchanged; `sources`, every decide, `anchor`, bounds and phrases are all in the hash |

**`reads: N` and `agree` (RULED #38).** The signed top-level `reads` (absent = 1) applies to every judged
locate check. Each read is an independent judge call (own deadline, own malformed retry); the per-read
decide runs on each read's one quote. A read's **outcome** is `green` or `red` plus, per decide in
signed order, its result: for a value decide the extracted value in its normalized exact form (the
canonical decimal for `number`/`money`, the `YYYY-MM-DD` string for `date`, minutes since midnight for
`time`; absent when none could be extracted) and its red kind if any; for a presence decide its
pass/fail. Reads **agree only if they decide the same overall outcome AND every decide extracted the
same value and the same presence result.** Raw quotes are still not compared: two reads that quote
different lines but extract the same values agree; two reads that both decide green but extract
different values (`$318` vs `$390`, 9:27 AM vs 10:15 AM) DISAGREE. Any difference = ONE red gap,
`check: "agree"`, kind `disagree`, `measured` = the number of distinct outcomes, `limit` = `reads`, the
same `key` (`<checkpoint>:<id>`); it replaces that check's per-read reds in the worker's view, and each
read's outcome stays in `full`. A read that is `stopped` (no answer) makes the whole check `stopped`. The
minted record says how many reads and calls ran.

**Soft-green and ACCEPT (RULED #39).** A checkpoint whose checks are all green and at least one is a
green `judged` check mints `soft-green` (the verdict carries `softGreen: true` and the judged check
ids; it does not count toward `maxReds`; no gap). A judge can never pass a step alone: `soft-green`
allows the advance only after an ACCEPT bound to the `outputSha`, through the existing `requiresHuman`
machinery (§6: `accept: "live"` asks once per sha with rule `rubric.needs-accept`; `"later"` uses
`gate.recordAccept`). So that "no ACCEPT moment configured" is impossible by construction,
`createRubric` refuses a GATING checkpoint holding a `judged` check unless it is `requiresHuman`. A
non-gating checkpoint records the soft-green and never denies. `gate.recordAccept` accepts a latest
verdict of `green` OR `soft-green` for exactly that `outputSha`. A soft-green with no ACCEPT denies
`rubric.needs-accept`; no new deny rule name. Precedence `stopped > red > soft-green > green`; the
cold-start rebuild reads `soft-green` like `green`. This also needs the `Check`/`StepResult` typedefs to
add the verdict. The §6 sentence "with no ACCEPT moment configured, soft-green fails closed" stays true
and is now unreachable for a gating checkpoint.

**Gaps (all rendered by `renderGaps` as the default JSON row; none gets a plain sentence, the two
that do exist only because fwdloop keys on their text).** One gap per failing check, `key`
`<checkpoint>:<id>`, `kind` = the kind of the FIRST red decide in signed order (or the read-level kind
when the read ended before the decides ran), `items` = `["d<i>:<kind>", ...]` for every red decide
(`i` = 0-based index in `decides`; bounded 20, `itemsTotal` when cut; the worker needs the position,
not the quote). `items` is always this `d<i>` list; a `value-many` decide's own value list therefore rides as
`values` (RULED #47). The kind-specific fields describe that first red decide. Fields are the existing gap
fields, plus one new optional `anchor`:

| `kind` | `check` | Fields | Meaning |
|---|---|---|---|
| `no-quotes` | `clean` | | the judge returned an empty list |
| `malformed` | `clean` | | malformed after one retry |
| `unpriced` | `clean` | | the judge call was unpriced |
| `unknown-source` | `quoteIn` | `measured` = the named source, clipped | the judge named a source the check does not list |
| `empty-quote` / `quote-not-found` / `source-too-large` | `quoteIn` | | as `cited` |
| `too-many` | `judged` | `measured` = count, `limit` = 1 | more than one quote (existing kind) |
| `quote-too-long` | `judged` | `measured` = length, `limit` = 4000 | |
| `anchor-missing` / `anchor-ambiguous` | `judged` | `anchor` (signed, unclipped), `measured` = occurrences | |
| `value-none` | `judged` | `anchor?` | no value of the kind (or none right after the anchor) |
| `value-many` | `judged` | `measured` = count, `values` = the values (`valuesTotal` when cut) | two or more, unanchored |
| `value-malformed` | `judged` | `measured` = the token, clipped 120 | shaped but invalid, a letter suffix, a bad am/pm, a unit |
| `value-over` | `judged` | `measured` = value, `limit` = the bound, `direction` | above `lte` / `lt` / `between` `hi` |
| `value-under` | `judged` | `measured` = value, `limit` = the bound, `direction` | below `gte` / `gt` / `between` `lo` |
| `phrase-missing` | `judged` | `measured` = the first missing signed phrase (never clipped) | a presence decide's phrase is not in the quote |
| `disagree` | `agree` | `measured` = distinct outcomes, `limit` = `reads` | the reads decided or extracted differently |

`direction` for the value gaps: `"at-most"` (`lte`, `between` `hi`), `"at-least"` (`gte`, `between`
`lo`), plus two NEW values `"below"` (`lt`) and `"above"` (`gt`) because the existing two mean
inclusive (open question 2). A `between` miss reports the end it crossed in `limit`. Signed values
(`value`, `lo`, `hi`, `anchor`, `currency`, `unit`, `phrases`) ride unclipped; the measured value and token are
output-derived, clipped to 120. The judge's quote itself is never in a gap or on an audit line whole:
the `full` record and the audit hold, for the quote, `source`, the first 120 characters, the original
length and the sha256 of the full quote (§5), plus `reads` and the number of calls made.

**Canonical forms and the pure core (RULED #47).** `measured` and `limit` in a value gap are STRINGS in canonical
form: `number`/`money` the exact decimal (`"409"`, `"318.4"`: no trailing zeros, no thousands separator,
`-0` is `0`), `date` the `YYYY-MM-DD` string, `time` 24-hour `HH:MM` (`"11:07"`). `direction` is `"below"` for
`lt`, `"at-most"` for `lte` and `between` `hi`, `"above"` for `gt`, `"at-least"` for `gte` and `between` `lo`.
Anchor occurrences are counted overlapping and the count stops at 1000 (`measured` never exceeds 1000). A
`between` or comparison whose signed bound does not re-parse is `value-malformed` (`measured` `"bound"`); it
cannot happen after `createRubric` validated the bound. The per-read comparable outcome (the input to `agree`) is
`[overall green/red, per decide in signed order: [type, "ok" or the red kind, the extracted canonical value or
null (`value-many`: its count and values)]]`: the canonical decimal string for `number`/`money`, the
`YYYY-MM-DD` string for `date`, integer minutes for `time`, never the quote. The pure core lives in
`src/primitives/rubric-locate.js` and is not exported from `src/index.js`.

**Examples (also in the test plan).**
- E1, REAL (bareloop CHANGELOG.md), `decides: [{valueKind:"date", op:"gte", value:"2026-10-01"}]`, no
  anchor, quote `## [0.41.0] - 2026-10-12`: one date token (`0.41.0` and the lone `-` are ignored),
  2026-10-12 >= 2026-10-01 = GREEN (soft-green at the checkpoint). Mutated to `## [0.41.0] -
  2026-09-12`: `value-under`, RED.
- E2, `money` `$` `lt` 400, quote `Alaska 1234 · LAX 08:10 → SFO 09:35 · Nonstop · Total: $318.40`. With
  anchor `Total:` = $318.40 = GREEN. WITHOUT an anchor this quote still holds exactly one money value
  (`1234` has no `$`, the times are not money) = GREEN. With `Total: $409.00` = `value-over`, RED.
- E3, trap: `From $349 + taxes and fees`, anchor `Total:`: `anchor-missing`, RED (the unanchored read of
  this quote would be one value, $349, and pass: the anchor is what stops it). `Total: $318.40 (was
  $420)` with anchor `Total:` = $318.40 = GREEN; without an anchor, two money values = `value-many`, RED.
- E4, REAL (bareloop's captured Google Flights page, LAX to SFO, barebrowse snapshot). The result line,
  verbatim:
  `link "From 59 US dollars. Nonstop flight with American. Operated by SkyWest Airlines as American Eagle. Leaves Los Angeles International Airport at 9:27 AM on Thursday, November 12 and arrives at San Francisco International Airport at 11:07 AM on Thursday, November 12. Total duration 1 hr 40 min. 1 carry-on bag included. 0 checked bags included. Select flight"`
  Other real lines of the same page: `generic "Departure time: 9:27 AM."`, `StaticText "$59"`,
  `generic "59 US dollars"`, `StaticText "Nonstop"`. With ONE quote (the link line) the real all-pass
  check is these `decides` (RULED #43):
  1. money, `unit: "US dollars"`, `lt` 400, anchor `From `: after `From ` comes `59 US dollars`, the unit
     follows the number after one space, value 59 < 400 = GREEN (`lt` 59 would be `value-over`; `From 409
     US dollars.` is `value-over`).
  2. `time` `between` `06:00`..`21:00`, anchor `Leaves Los Angeles International Airport at ` (= `...Airport at`):
     reads `9:27 AM` = 09:27 = GREEN. (The `11:07 AM` later in the line is not read: that is what the
     anchor is for. Unanchored, the line holds two times = `value-many`.)
  3. presence `["Nonstop flight"]`: the phrase is in the quote = GREEN.
  All three pass on the same quote = a green `judged` check = soft-green at a `requiresHuman` checkpoint.
  As an extra illustration only, a fourth decide `time` `lte` `12:00`, anchor `arrives at San Francisco
  International Airport at `, reads `11:07 AM` = 11:07 = GREEN (`lte` `11:00` would be `value-over`).
  **A SYMBOL-currency money decide on this line is still RED.** `money` `currency: "$"` `lt` `400`, anchor
  `From `: after `From` comes `59 US dollars`, which is not a `$` money token, so `value-none` (carrying
  `anchor`); with no anchor the line holds no `$` token either (`value-none`). The `$59` the page also
  shows is in `StaticText "$59"`, a different line, so it is not on the quote. That is why a page that
  states its price in words signs `unit`, not `currency`.
  The ruling that decides each of these: #34 (12-hour), #35 (presence), #36 (one quote, co-location),
  #37 (symbol money), #43 (money `unit`).

#### Open questions (for hamr; everything the rulings did not decide)

These concern the PARKED judge. The open questions of the `cited` pivot are at the end of §4.6's rulings, §12 "Open questions after #55".

1. `opts.judge` shape once `verdict` exists: a single function (this build) vs `{ locate, verdict }`.
   And whether the judge's `input` should include `output` (this spec passes `{ output, sources }`).
2. `direction` gains `"below"` and `"above"` (strict `lt`/`gt`); the alternative is to give strict
   compares their own gap kinds. Also: the new optional gap field `anchor`, the new `judged` gap kinds
   (including `phrase-missing`), the money `unit` field (#43) and the `d<i>:<kind>` item form are SemVer-surface additions.
3. (SETTLED, RULED #43: money may sign `unit` instead of `currency`; see "Extraction: per value kind".)
4. (SETTLED AT BUILD, RULED #46: the names `decides`, `valueKind`, `value` (the bound), `op`, `lo`/`hi`,
   `anchor`, `phrases`, `unit` are settled in code and the orchestrator reviews them.)
5. 12-hour times accept uppercase ` AM`/` PM` with exactly one space only after normalization (ruling #34, #47). Lowercase
   (`9:27 am`) and dotted (`9:27 a.m.`) are MALFORMED by this spec. Widen if a real page ever needs
   them (each extra spelling is another way to misread).
6. (SETTLED AT BUILD, RULED #46: the `rubricVocabulary` list-of-objects descriptor for `decides` is
   settled in code and the orchestrator reviews it.)

### 5.3 Search inputs registered mid-run (bareloop; Next, build step 2 after `cited` + `decides`, NOT built, design next; first real page captured 2026-10-12, finding F1)

**Why it is needed by the pivot (RULED #54).** bareloop's flight job must check the worker's quotes against the arbiter's frozen copy of the exact snapshot the worker saw. With `cited` (§4.6) the `source` of a claim names such a registered label instead of a pre-run input; the arbiter, never the worker, registers each snapshot (F1: one url may have several snapshots with different sha256).

Not part of the locate build (RULED #31). bareloop's wish: the sources of a locate check are web
pages found DURING the run (a search), not files frozen before it. Requirements captured so far, to
be specified further as real pages come in (the first, bareloop's Google Flights LAX to SFO snapshot, produced finding F1 below):

- **Only the arbiter registers a page, never the worker.** The worker cannot add a source that
  checks its own claim.
- **The signed slot** is a label plus `"search"` plus allowed domains, e.g. `{ name: "offers", kind:
  "search", allowDomains: ["alaskaair.com"] }`. `allowDomains` maps to the `net.allowDomains` shape (the
  floor is unchanged; Law 9: a rubric never widens a scope). The slot is in `rubricSha`; its content is
  not known up front, so it has no sha256 in the spec.
- **A quote citing the label may match ANY page registered under it** (`sources: ["offers"]` is a
  set of pages, not one).
- **A page whose host is outside the allowed domains = red** (not stopped: the content was wrong, not
  the instrument).
- **Per-page audit:** label, sha256 of the page bytes, byte count, the URL requested, the final URL
  after redirects, the tool that fetched it, a timestamp and the run id.
- **Finding F1 (bareloop's real page, 2026-10-12, RULED #42).** The FIRST snapshot after `goto` can be
  EMPTY: the results load later. So one URL can be registered several times with different sha256, and
  the design must expect that. Each registration is its own page record under the label (own sha256,
  byte count, timestamp); an empty or results-less snapshot is just a page that no quote can match
  (a quote citing the label still matches ANY page under it, so an early empty snapshot does not
  poison a later full one). Whether the registration call should refuse or flag an empty page, and how
  a re-registration of the same URL is ordered for the cold-start rebuild, stay open below. Still NOT
  built.
- Open: the page text the `locate` judge sees and `quoteIn` checks must be the exact registered bytes
  (hash recorded at registration); how a registered page is cold-start-rebuilt; the 5 MB cap per page;
  page count per label (F1 makes several per URL normal); what counts as "the same host" (redirects, subdomains); whether the registration
  call is a new gate method (harness-only, like `recordAccept`). None of this is decided.

## 6. Verdicts, the advance and the human moments

**Four verdicts:**

| Verdict | Meaning | Gating checkpoint | Gap / fault | Counts toward `maxReds` |
|---|---|---|---|---|
| **green** | every check deterministic and green (including `cited` with `decides` and the typed binding, §4.6: plain green, no ACCEPT requirement) | allow | none | no |
| **soft-green** | every check green, at least one involved a judge (carries a flag; only a judge produces it, so it is PARKED with the `locate` judge, §5.2) | allow only after ACCEPT, else deny | none | no |
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
    different `outputSha` asks again. Concurrent advances for the same `(checkpoint, outputSha)` share ONE ask and one ACCEPT line. A concurrent advance that JOINS an in-flight ask gets no `approval` audit line of its own: only the ask's owner (the first advance) has one, and the `rubric_accept` line carries the owner's `askId`. A reader joining approvals to decisions by `aid` will see a joiner `allow` with no approval line under its own `aid`; follow the shared `(checkpoint, outputSha)` to the owner's. A reply that arrives after the verdict moved on (the latest verdict is no longer that green `outputSha`, or the checkpoint is exhausted) is discarded: nothing is recorded and the red count is not reset. If the Axis A floor also asks on the advance, the floor's ask
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
3. The advance action, one whose `type` or valid `tool` is listed in `rubric.advanceOn`, carries `{ checkpoint,
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
  stable order within a check), each rendered from its gap fields, joined by `"; "`. The two gaps of
  `sectionWords` and `allowedKeys` render as the plain sentences in §4.1 instead of a JSON row. The same
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

**Interactions.** Independent of `rwx` / `tools.allowlist` mode. `advanceOn` matches `action.type` OR a valid
`action.tool` (a non-empty string; `tool` is an identity field, so either hit makes the action an
advance; a non-string/empty `tool` never matches and `tool: null` is absent). RULED 2026-10-08, with
fwdloop and bareloop consulted; it only tightens. Name the advance action with a reserved name that is no
real tool's name (e.g. `fwdloop.advance`): an `advanceOn` entry equal to a real tool name (e.g. `write`)
would run the rubric on the model's ordinary tool calls and could deny them. A check spends no budget; a judge call's cost is the caller's to report through the
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
| config keys | `rubric: { spec, sha256, advanceOn }`; signed spec keys `onExhausted`, `maxReds`, `reads`, `requiresHuman`, per-checkpoint `accept`, per-check `id`, `text`, `strict`, `phrases`, `noneExit`, `expectExit`, `direction`, `baseline`, `patterns`, `allowPrefixes`, `requireNonEmpty`, `size`, `items`, `itemsFrom`; for `cited` (§4.6, RULED #48) `decides` and, inside a decide, the same fields as below; the claim shape `{claim, quote, values?}` with `values` keyed `d<j>` and the `cited` gap item reasons `claim-value-missing`, `claim-value-malformed`, `claim-value-mismatch`, `claim-value-unknown`, `quote-too-long` and `d<j>:<decide kind>`; for `judged` (PARKED, §5.2) `kind`, `ask`, `sources`, `decides`, and inside a decide `valueKind`, `op`, `value`, `lo`, `hi`, `currency`, `unit`, `anchor`, `phrases` |
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
- Headings forgiving, list marker (RULED 2026-10-09 #29): `## 1. Work History` matches `Work history`
  (also `2) `, `10. `, a tab); not markers: `2024 results`, `1.5 Skills`, `1.Work`, `a) X`, `**1.** X`,
  non-ASCII digits; only ONE marker is stripped; a signed `1. Intro` matches `## 1. Intro` but not
  `## Intro`; a bare `2. Summary` does NOT satisfy `Summary` and does not split a `sectionWords`
  span; strict is unchanged; one `## 1. Intro` line starts one section even if `1. Intro` and
  `Intro` are both listed. Tests: `test/rubric-fwd-ports.test.js`.
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
- `sectionWords`: AT / UNDER / OVER the band (180 -> 143/144/216/217, plus a ceil/floor grid); preamble, unlisted-heading and missing/out-of-order cases match fwdloop's am15 fixtures; rendered text equals fwdloop's red string. `allowedKeys`: extra key present / absent / several (insertion order), multi-key list, string output, hostile Proxy; rendered text equals fwdloop's with only "softgreen " dropped.
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
- **`cited` + `decides` + typed claim binding (RULED 2026-10-12, §4.6, #48-#55; BUILT df699b9, unreleased).** Every case also runs the falsify-by-revert of the source it exercises (reverting the equality compare must turn the fake-time case green; reverting the unknown-key rule must turn the swapped-key case green). The decide-level cases (extraction, anchors, 12-hour times, money `unit`, exact comparison, canonical forms) are the ones listed under the PARKED `locate` bullet below and in `test/rubric-locate-decide.test.js`; they are not repeated here. Fixture: bareloop's real captured Google Flights page as the `offers` input (44 result lines) and the E4 decides as `d0` money `unit "US dollars"` `lt 400` @`From `, `d1` time `between 06:00..21:00` @`Leaves Los Angeles International Airport at `, `d2` presence `["Nonstop flight"]`.
  - Honest, whole page: each of the 44 real lines as a quote with true `values` (`d0`, `d1` read off the line) = 39 green, 5 red, the 5 reds exactly the after-21:00 departures (items `#<i>:d1:value-over`); the binding itself is green on all 44 (the claim values equal the extracted ones even where the decide is red).
  - **Fake time, true price.** Claim `United, 7:00 AM, $59` over the real United line with `values {d0:"59", d1:"7:00 AM"}` = red `#0:d1:claim-value-mismatch:07:00!=<the line's time>`, while `numbersInQuote` ALONE is green on it (assert both, so the case proves the binding is what catches it). A fake price with a true time = red `#0:d0:claim-value-mismatch:45!=59`.
  - Claim-text spelling (real case, df699b9): claim text `9:27 AM` with `values.d1` `"09:27"` over a quote reading `9:27 AM` = green; claim text `09:27` (same values) = red `#0:numbers:09`, because `numbersInQuote` stays on the text (RULED #52) and only `values` are canonicalized.
  - Canonical equality: `values.d1` `"09:27"` over a quote reading `9:27 AM` = green; `"9:27 AM"` = green; `"21:27"` = red mismatch; `"9:27 PM"` = red mismatch (AM vs PM is no longer invisible); `values.d0` `"59.00"`, `"59"`, `"0059"` (malformed? leading zeros are digits of the `number` grammar, so it parses and equals 59; assert whichever the build ratifies, open question 2) over `59 US dollars`; `"1,200"` and `"1200"` over a `1,200 US dollars` quote (use `lt 5000`) = green; `"1,20"` = `claim-value-malformed`.
  - Role swap is impossible: a check with two time decides (`d1` departure @`Leaves...`, `d2` arrival @`arrives at...`) and `values {d1: <arrival>, d2: <departure>}` = two mismatches; a check with a price decide and a duration decide that both read 40 cannot be confused (values are keyed by decide, not by number).
  - Missing, malformed, unknown: no `values` on a check with value decides = `claim-value-missing` for each value decide; `values: {}` same; `values` an array / `null` / a string = `#0:values:claim-value-malformed`; `values.d1` = `"$59"`, `"59 US dollars"` (symbol/unit text), `"about 9:27"`, `"9:27 am"`, a JSON number, `null` = `claim-value-malformed`; extra keys `d3` (past the list), `d2` (a presence decide), `price`, `D0`, `d00` = `claim-value-unknown`; `values` on a `cited` check with NO `decides` = red (every key unknown), and the same claim without `values` is green exactly as before.
  - Presence-only claims: a `cited` check whose decides are only `phrases ["Nonstop flight"]` accepts a claim `nonstop` with no `values` = green; a number-free claim text is never red (no "no numbers = red"); the phrase absent from the quote = red `#0:d0:phrase-missing:Nonstop flight` (phrase unclipped).
  - Quote first: a paraphrased quote (one word changed) = red `#0:quote-not-found` ONLY: no decide item, no binding item (assert `decideQuote` never ran); an empty quote, a source over 5 MB, a malformed claim object keep today's items; a normalized quote of 4001 characters with `decides` signed = `#0:quote-too-long` (4000 AT = proceeds), and the same quote with NO `decides` is not bounded.
  - Stray number: claim text `United $45` with `values {d0:"59",...}` over a quote with `59` = red `#0:numbers:45` (the typed value is right; the free text is wrong); claim text `59.00` against quote `59` = `numbers:59.00` false red (documented looseness, §4.2); all reds of one claim are listed together (a mismatch AND a stray number in one claim = two items).
  - Unchanged behaviour with no `decides`: every existing `cited` test passes byte-for-byte (items, `measured`, `limit`, `no-claims`, `too-many`, `stopped`); `rubricSha` changes when `decides`, a decide field or the decide order changes; `createRubric` refuses `decides` that is empty, over 10, not an array, a decide that is value AND presence or neither, `between` with `value`, `money` with both or neither of `currency`/`unit`, a bad bound, naming the path; `rubricVocabulary` lists `decides` on `cited` with its conditions and the generated description matches.
  - Verdict: a `cited` check with decides that passes is plain `green` (never `soft-green`), at a gating checkpoint it advances with no `requiresHuman`; reds are `red` with the gap in `drainGaps()`; a source sha mismatch is still `stopped`; the work cap still applies and `decideQuote` runs once per distinct normalized quote (spy).
- PARKED: `locate` judge and value decide (RULED 2026-10-12, §5.2, revised by #34-#46; the decide-level cases are live, the judge-call cases are not built). Every case below also
  runs the falsify-by-revert of the source it exercises. Notation: `decides` entries are written
  `kind op bound @anchor`.
  - E1 (REAL bareloop CHANGELOG.md), `date gte 2026-10-01`, no anchor: quote `## [0.41.0] - 2026-10-12`
    = green (one date; `0.41.0` and the lone `-` ignored); mutated `## [0.41.0] - 2026-09-12` = red
    `value-under`; the boundary `2026-10-01` itself = green (AT), `2026-09-30` = red.
  - E2, `money $ lt 400`: `Alaska 1234 · LAX 08:10 → SFO 09:35 · Nonstop · Total: $318.40` with anchor
    `Total:` = green; the same WITHOUT an anchor = green (exactly one `$` value); `Total: $409.00` = red
    `value-over`; `Total: $400.00` = red (`lt` is strict, AT is red); `$399.99` = green.
  - E3 traps: `From $349 + taxes and fees` with anchor `Total:` = red `anchor-missing`; `Total: $318.40 (was
    $420)` with anchor `Total:` = green; the same without an anchor = red `value-many` with both values listed.
  - Departure window, `time between 06:00..21:00`: `LAX 08:10 → SFO 09:35` no anchor = red
    `value-many`; anchor `LAX ` = 08:10 green; `LAX 22:45 → SFO 00:10` anchor `LAX ` = red `value-over`;
    AT `06:00` and `21:00` green (both ends inclusive), `05:59` / `21:01` red; `lo > hi` refused at `createRubric`.
  - **REAL Google Flights lines (bareloop's captured page, LAX to SFO).** The link line L (verbatim):
    `link "From 59 US dollars. Nonstop flight with American. Operated by SkyWest Airlines as American Eagle. Leaves Los Angeles International Airport at 9:27 AM on Thursday, November 12 and arrives at San Francisco International Airport at 11:07 AM on Thursday, November 12. Total duration 1 hr 40 min. 1 carry-on bag included. 0 checked bags included. Select flight"`
    and the other real lines `generic "Departure time: 9:27 AM."`, `StaticText "$59"`, `generic "59 US dollars"`,
    `StaticText "Nonstop"`. The page source holding all of them is the `offers` input.
    - 12-hour time (#34), `time between 06:00..21:00 @"Leaves Los Angeles International Airport at "` on L = 09:27
      = green. `generic "Departure time: 9:27 AM."` with anchor `Departure time: ` = 09:27 green (the
      trailing period after `AM` does not break extraction: the suffix is part of the token and `.` is
      not a letter). `$59,` in `money $ lt 400` on `Total: $59, nonstop` = 59 green (trailing comma cut);
      `59.` in `number` = 59.
    - 12-hour values: `12:05 AM` = 00:05 (5 minutes) green against `lt 01:00`; `12:05 PM` = 12:05 (725)
      green against `gte 12:00` and red `value-under` against `lt 01:00`; `9:27 PM` = 21:27 = red
      `value-over` against `between 06:00..21:00`; `9:00 PM` = 21:00 AT green, `9:01 PM` red; `6:00 AM` AT
      green, `5:59 AM` red; `09:27 AM` (two-digit hour) = 09:27; a 12-hour BOUND `"9:00 PM"` parses to 21:00
      and `rubricSha` is stable under it.
    - Malformed times (never read as 24-hour): `0:30 AM`, `00:30 AM`, `13:05 PM`, `9:27 am`, `9:27 Am`,
      `9:27AM`, `9:27 a.m.`, `9:27 p.m.`, `9:27 AMX`, `9:27 AMD`, `9:27:`, `24:00`, `8:7`, `08:10:30` =
      red `value-malformed`. `9:27 American` = the 24-hour 09:27 (the letters are a word, not the suffix). `9:27  AM` (two spaces) and `9:27<tab>AM`
      read `9:27 AM` = 09:27 after normalization (#47); `Total:` is no time (ignored).
      A 24-hour `00:30` and `23:59` are fine.
    - Presence (#35): `phrases ["Nonstop flight"]` on L = green; case-insensitive (`nonstop FLIGHT`)
      green; on a quote `1 stop with Delta` = red `phrase-missing` (`measured` `Nonstop flight`); on
      `StaticText "Nonstop"` = red (`Nonstop` is not `Nonstop flight`); two phrases with one missing =
      red; a quote that is NOT in the source (the judge made it up) = red `quote-not-found`, no decide runs.
    - Co-location (#36), the real check `decides: [time between 06:00..21:00 @Leaves..., time lte 12:00
      @"arrives at San Francisco International Airport at ", phrases ["Nonstop flight"]]` with the judge
      returning ONE quote (L): all three pass = green judged check = `soft-green`. Same check with `lte
      11:00` on the arrival = red `value-over` (`items` `["d1:value-over"]`, `measured` 11:07, `limit`
      11:00), the other two decides still evaluated. Same check with a flight whose presence fails and
      whose time fails = both in `items`, `kind` of the FIRST (`d0`), in signed order.
    - **Symbol money does not read words (#37).** Adding `money currency $ lt 400 @"From "` to the check
      on L = red `value-none` carrying `anchor` `From ` (`59 US dollars` is not a `$` token), so the whole
      check is red (`items` `["d3:value-none"]`) even though the other decides pass. The same symbol decide
      with no anchor on L = red `value-none`. On `StaticText "$59"` it would be 59, but that line is not the
      quote. `generic "59 US dollars"` with a symbol decide = red `value-none`.
    - **Money `unit` (#43).** The real all-pass check on L: `money unit "US dollars" lt 400 @"From "`,
      `time between 06:00..21:00 @"Leaves Los Angeles International Airport at "`, `phrases ["Nonstop flight"]`
      = green judged check = `soft-green`. Plus: `From 59 US dollars.` = 59 green; `From 1,234 US dollars.`
      anchor `From ` = 1234 (red `value-over` against `lt 400`, green against `gt 1000`); `From 409 US
      dollars.` = red `value-over` (`measured` 409, `limit` 400); AT `From 400 US dollars` against `lt 400` =
      red, `From 399.99 US dollars` = green; trailing punctuation after the unit (`59 US dollars.`, `, `,
      `)`) fine; unit missing (`From 59 dollars.`, `From 59.`, `From 59US dollars`) = red
      `value-none` carrying `anchor`; case is exact (`59 us dollars`, `59 US Dollars` = red `value-none`);
      `59 US dollarsX` = red `value-none`; unanchored `59 US dollars and 61 US dollars` = red `value-many`
      (both listed); unanchored line with `1 hr 40 min` and `0 checked bags` and one `59 US dollars` = 59
      (the other numbers are not money values); `v59 US dollars` = red `value-malformed`; `-59 US dollars` =
      red `value-malformed`. `currency` and `unit` both signed on one decide, neither signed on `money`, and
      `unit` on a `number` / `date` / `time` decide, a blank `unit`, a non-string `unit`, a `unit` over 100
      characters are each refused at `createRubric` naming the path. Changing the `unit` changes `rubricSha`.
    - **One quote per read (#36).** The judge returns two quotes (L and `StaticText "$59"`) = red
      `too-many` (`measured` 2, `limit` 1), NO retry, nothing decided on either (assert the decides never
      ran); zero quotes = red `no-quotes`; one quote with the right `source` = proceeds. A judge that
      returns one quote per decide is therefore red, not green.
    - `agree` tightened (#38), `reads: 2`: both reads quote L = identical outcomes and values = agree
      (soft-green); read 1 quotes L (departs 09:27) and read 2 quotes a DIFFERENT real result line with a
      departure of 10:15 AM, both inside 06:00..21:00 so both decide green = red `agree`/`disagree`
      (different extracted values); the same two lines with identical extracted values (two lines that
      both depart 9:27 AM) = agree; a presence pass in one read and a presence fail in the other = red
      `disagree`; one read `value-over`, the other green = red `disagree`; two reads that are both red
      with the same kinds and the same extracted values do NOT disagree (the per-decide reds show).
  - Value edge cases: zero values (`no price listed`) = red `value-none`; `0` / `$0.00` is a value (green
    against `lt 400`, not "absent"); two values = red `value-many`; one malformed token in an unanchored
    quote (`0.41.0` in `number`, `12,34`, `1.2k`, `5m`, `$5USD`, `2026-13-45`, `2026-02-30`, `24:00`,
    `08:10:30`, `08:10am`, `-$5`, `−5`, `($5)`) = red `value-malformed`, never read around;
    `-5` is -5 and `2026-10` has no sign; `1,234.50` ok, `1,23` malformed; non-ASCII digits are no digits;
    a value exactly AT / UNDER / OVER the bound for each of `lt`, `lte`, `gt`, `gte`; decimal exactness
    (`0.1 + 0.2` style bounds, a 30-digit value) never goes through floats.
  - Anchor: present once and followed by whitespace then the value = that value; anchor present TWICE = red
    `anchor-ambiguous`; anchor followed by other text before the value (`Total: see $400`) = red
    `value-none` with `anchor`; the anchor `LAX ` (trailing space) equals `LAX`; the anchor is
    case-sensitive; an anchor with `**` or runs of whitespace in the quote still matches after normalize;
    two decides with different anchors on one quote each read their own value.
  - Judge replies: a quote NOT in the named source = red `quote-not-found`; a source not in the check's
    `sources` = red `unknown-source`; an empty quote = red `empty-quote`; an empty `quotes` array = red
    `no-quotes` with NO retry; malformed once then good = pass (second call made); malformed twice = red
    `malformed`; a score instead of quotes = malformed; unpriced = red, no retry; `pricing: "estimated"` =
    priced; a normalized quote over 4000 characters (AT 4000 ok, 4001 red) = red `quote-too-long`; the
    judge's `facts` never change a verdict.
  - Instrument: the judge throws / rejects = `stopped` `judge-no-answer`, one call, no gap in
    `drainGaps()`; a timeout past `deadlineMs` = `stopped`, not retried, and the `AbortSignal` is aborted;
    `opts.judge` absent on a rubric with a judged check = `stopped` `missing-measurement`; `deadlineMs`
    missing with a judge = throw (gate: deny); `opts.inputs[source]` missing or a sha256 mismatch =
    `stopped`; a source over 5 MB = red `source-too-large` with ZERO judge calls; stopped beats red; the
    call count never exceeds `reads x 2` (the worst case of #40) and there is no other clock.
  - `reads: 3`: three identical green reads = soft-green; two green and one red = red `agree` (one gap,
    `measured` 2, `limit` 3, the per-read reds only in `full`); one read `stopped` = the whole check
    `stopped`; the audit record says 3 reads and the number of calls (with a malformed retry, 4); `reads`
    absent = one call.
  - Judge-internal retry (#44): a judge function that fails once internally and answers on its own second
    attempt within `deadlineMs` = bareguard sees one call and one answer (assert call count 1 on bareguard's
    side); a judge that throws after its own retries = `stopped` `judge-no-answer`, bareguard makes no
    second call; a judge still working past `deadlineMs` is aborted and is `stopped`.
  - Non-gating judged checkpoints (#45): a non-gating checkpoint holding a judged check that passes records
    `soft-green` and never denies; one whose judged check is red records `red`, RETURNS the gap(s)
    (`drainGaps()` carries them, so the worker's fix loop runs) and never denies; a judged check `stopped`
    at a non-gating checkpoint is recorded and never denies; a non-gating judged checkpoint is NOT
    required to be `requiresHuman` (createRubric accepts it); a GATING one that is not `requiresHuman` is
    still refused; a rubric with the single `requiresHuman` accept at the FINAL gating checkpoint
    (`accept: "later"` + `gate.recordAccept`) accepts that gate's `outputSha` and the earlier non-gating
    soft-greens need no ACCEPT.
  - Soft-green (#39): all-green with a judged check = `soft-green`, never `green`, no gap, not counted
    toward `maxReds`; the advance is denied `rubric.needs-accept` until an ACCEPT for the `outputSha`; live
    ask and `accept: "later"` + `recordAccept` both work on a soft-green; a gating checkpoint with a
    judged check that is not `requiresHuman` is refused at `createRubric` (the judge can never pass a
    step alone); a non-gating one records and never denies; a judged check with `spec.judge` null is
    refused; cold start rebuilds a soft-green.
  - Spec shape: `kind: "verdict"` refused (names §5.1); `decides` missing / empty / over 10 entries /
    not an array refused; a decide that is both value and presence, or neither, refused; `valueKind` /
    `op` / `currency` / `value` combinations (`between` with `value`, `lt` with `lo`, `money` without
    `currency`, `currency` on `date`, a non-string date bound, `2026-02-30` as a bound, `13:00 PM` as a
    bound, `1e21`, an unknown `sources` name, a duplicate source, an empty `sources`, an empty or
    non-string `phrases`) each refused at `createRubric`; the old flat `compare`/`bound` fields are an
    unknown key; changing `anchor`, a source, a bound, a phrase, the order of `decides` or `reads` changes
    `rubricSha`; `rubricVocabulary` lists every new field with type, required and conditions, and the
    generated description matches.
  - Audit and gaps: for the quote only `source`, the first 120 characters, the length and the sha256
    (never the whole quote); `renderGaps` of a value gap is byte-identical across two runs and differs
    between `value-over`, `value-none` and `phrase-missing`; signed `anchor` / `value` / `phrases` are
    never clipped in a gap; a hostile judge reply (throwing getter, Proxy, `__proto__` key, 10 MB string)
    is malformed or bounded, never a throw.
- Distinct names: every deny rule string is unique.
- Byte-identical decision path when `rubric` is unset.

## 11. Day 1 vs later

| | What |
|---|---|
| **Day 1** | `quoteIn`, `numbersInQuote` · `rubricVocabulary` · `createRubric` / `rubricSha` · `checkStep` with all deterministic checks (shape rules incl. `blockLines` and `strict`, value rules, `complete`, `cited`, and the four borrowed shapes `commandExit` / `notWorse` / `patternAbsent` / `filesChanged`) · the four verdicts minus soft-green (green / red / stopped) · liveness proof · gating checkpoint + `outputSha` + `requiresHuman` · `drainGaps` · `renderGaps` · audit-backed state · `onExhausted: "fail"` |
| **Build order (RULED 2026-10-12, #48-#55)** | **(1) BUILT on `feat/locate-judge` (df699b9, unreleased): `cited` + `decides` + typed claim binding (§4.6).** Wired the built pure core (`rubric-locate.js`) into `cited`: decides on the claim's quote, `values` keyed `d<j>` equal to the extracted values, `numbersInQuote` kept on the free text, plain green. Adds `parseClaimValue`, the new gap reasons, the `cited` `decides` descriptor and `rubricVocabulary`/primitives.json entries. Source = a frozen signed `inputs` entry |
| Next, step 2 | search inputs registered mid-run (bareloop, §5.3): quotes checked against the arbiter's frozen copy of the exact snapshot the worker saw (F1: one url, several snapshots). Design next, NOT built |
| Next, step 3 | SUPERLATIVES ("cheapest", "earliest", "N best"): a new deterministic aggregate check over the frozen source. For every line matching a signed selector (presence phrases plus anchors), extract the anchored value; the claim's value must be the minimum or maximum. The flight job's real ask is "cheapest nonstop in window". Design after step 2, NOT built |
| PARKED (design kept, §5.1, §5.2) | the `locate` judge (judge call, `reads`/`agree`, soft-green + ACCEPT wiring), the `verdict` judge (jev), calibration. A future `locate` judge REQUIRES an output-binding claim using the typed binding (RULED #53) |
| Later (noted) | multi-source claims: one claim backed by two quotes from two sources (RULED #55) |
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
23. RULED (hamr, 2026-10-08): the two ACCEPT paths differ on an exhausted checkpoint, and that is intended. A LIVE accept (`humanChannel` ask) is written only if, inside the lock, the checkpoint's latest verdict is still the green for exactly the asked `outputSha` AND the checkpoint is not exhausted; otherwise the answer is discarded (no accept line, no red reset), so a stale answer can never reset the red count and lift the signed `maxReds` wall. A LATER accept (`accept: "later"` + `gate.recordAccept`) needs a green for the exact `outputSha` but MAY be recorded on an exhausted checkpoint and resets the reds, matching §6 "terminal until a re-sign or ACCEPT": it is a deliberate human decision about a known green output, while the live guard only rejects answers that went stale while pending. Rejected: making both identical so only a re-sign lifts exhaustion.
24. RULED (hamr, 2026-10-08): `cited` has a deterministic WORK cap, not a clock. Distinct normalized quotes x normalized source length is capped at 128 MiB (`floor(128 MiB / source length)` distinct quotes); over it = the existing `too-many` gap (`measured` = distinct quotes, `limit` = allowed), checked before any search. Identical normalized quotes are searched once (pure performance, same verdict). Measured: per-quote cost is flat in quote length, so claims x source length bounds the work (worst case ~70 ms per quote at 5 MiB; capped worst case about 1 s). No new rule name or gap kind; a wall-clock budget was rejected because verdicts must be deterministic (Law 8).
25. RULED (hamr, 2026-10-08): `sectionWords` (`field`, `names`, `wordsPerSection`) is ported from fwdloop's `wordsPerSection` (M4e amendment 15) so the forgiving defaults keep matching `closers.js`: each found section within `[ceil(N*0.8), floor(N*1.2)]` inclusive; a missing or out-of-order listed section is not measured (pair with `sectionOrder`); no `strict`; one `{kind:"section-words", section, words, asked, lo, hi}` gap per section; `renderGaps` text `<section>: <words> words, about <asked> asked (<lo>-<hi>)`.
26. RULED (hamr, 2026-10-08): `allowedKeys` (`keys`) is ported from fwdloop's softgreen extra-key check with a GENERAL wording (no "softgreen"): an object output with an own key outside the signed list is red, `{kind:"extra-keys", keys, allowed}`; the caller strips `done`/`blocker` first (no `ignoreKeys`); `renderGaps` text `artifact has key(s) "<k>", ... besides "<allowed>"; the check reads "<allowed>" only, so put the whole answer in "<allowed>"`.
27. RULED (hamr, 2026-10-08): `quoteIn(quote, source, opts?)` gains an opt-in `{ wholeLines: true }`, asked by bareloop (F192). Default unchanged (byte-for-byte); any `opts` other than an object with `wholeLines === true` is the default mode. Whole-line mode: both sides split into lines (CRLF ok), each normalized per line after stripping ONE leading comment decoration (`/**`, `*/`, `//`, `* ` or a lone `*`, and `#` only when a space or tab follows, or alone on its line, so `#include` stays whole); a decoration-only line keys as itself; every non-empty quote line must EQUAL a whole source line (not a substring). Tighten-only; the `cited` rule is not changed.
28. RULED (hamr, 2026-10-08): `quoteIn` wholeLines: the quote's lines must be a contiguous run of source lines, in order, with empty and decoration-only lines skippable on both sides (bareloop); a decoration-only quote falls back to per-line equality and is documented as proving nothing about location; in a MIXED quote decoration-only lines are skipped too, so a quote's `/**` or `*/` lines are not required to appear (`/**\nfoo\n*/` matches a source `foo`) and only the substantive lines are proven; a lone `#` line is decoration-only like a lone `*`; never-throws on a hostile `opts` (a throwing getter or Proxy means default mode).
29. RULED (hamr, 2026-10-09): forgiving headings strip ONE leading ordered-list marker (`1. `, `2) `) after the `#` run, asked by fwd from a live run (numbered headings like `## 1. Work History` never matched `Work history`); the strip applies only to `#`-run lines, as a second key beside the plain one (a name matches either); signed names and bare lines are NOT stripped (a first cut that stripped every line and the signed side let a bare `2. Summary` satisfy `Summary` and split `sectionWords` sections), strict is unchanged (its exact-text half still sees the marker).

**2026-10-12** (the `locate` judge; hamr ruled, requirements from bareloop, the only consumer needing judges)
30. RULED (hamr, 2026-10-12): build now the `locate` judge kind, signed `reads: N` with `agree`, and a NEW deterministic value rule (§5.2). Sources are the existing frozen signed `inputs` (sha256 up front). The judge only points (quote(s) + which source); bareguard's code extracts the value and compares it with a signed bound. Value kinds `number`, `money`, `date`, `time`; comparisons `<`, `<=`, `>`, `>=` and `between`.
31. RULED (hamr, 2026-10-12): NOT now: sources registered mid-run (bareloop's web pages; recorded as the §5.3 Next section, design pending a real captured page). The `verdict` judge kind and the jev adapter (§5.1) come NEXT, right after this build; the design stays. Calibration stays Later.
32. RULED (hamr, 2026-10-12): a quote must yield EXACTLY ONE value of the signed kind, otherwise unsure = red. The spec MAY sign an `anchor` label (e.g. `Total:`); the value is then the first value of that kind right after the anchor in the quote, and an anchor missing from the quote is red. (The exact parse rules, "adjacent" and a twice-present anchor are spec'd in §5.2 and listed as open questions.)
33. RULED (hamr, 2026-10-12): a judge crash, transport error or timeout is `stopped` (unchanged; the loop accepts it). A reply malformed after its one retry is red `clean`. Unpriced is red.
34. RULED (hamr, 2026-10-12, from bareloop's real Google Flights page): `time` accepts 12-hour `h:mm AM|PM` / `hh:mm AM|PM` in addition to 24-hour `HH:MM`: exactly one space then UPPERCASE `AM`/`PM` not followed by a letter, hours 1-12 (hour 0 or 13+ with a suffix is malformed), `12:xx AM` = `00:xx`, `12:xx PM` = `12:xx`, `9:27 PM` = `21:27`. Lowercase, `a.m.`, no-space and multi-space forms are MALFORMED, never read as 24-hour (hamr left the choice to the spec; chosen: the real page is uppercase and every extra spelling is another misread). The suffix is part of the token, not an adjacent letter, and trailing punctuation (`9:27 AM.`, `$59,`) does not break extraction. Hand-coded, linear (§5.2).
35. RULED (hamr, 2026-10-12): a PRESENCE decide, `{ phrases: [...] }`: pass when the quote contains every signed phrase (case-insensitive substring, the `mustCarry` rule) and the quote is verbatim in the frozen source (`quoteIn`). Gap kind `phrase-missing`.
36. RULED (hamr, 2026-10-12): CO-LOCATION. One judged check = one claim = ONE quote per read, and the signed check carries a LIST `decides` of value and presence decides, all applied to that same quote; all must pass. This replaces "every returned quote must pass". Exactly one quote per read (spec choice, keeps co-location provable): zero = `no-quotes`, two or more = red `too-many` (limit 1), no retry. The old flat single-decide fields (`valueKind`, `compare`, `bound`, `lo`, `hi`, `currency`, `anchor` on the check) move into a decide.
37. RULED (hamr, 2026-10-12): confirmed defaults. Money stays symbol-only (`$` `€` `£`) for now; so on bareloop's real link line (`From 59 US dollars. ...`) a money decide is RED `value-none` and that is recorded honestly (open question 3: a signed opt-in `unit` suffix, for hamr and loop; nothing is silently widened). Dates ISO `YYYY-MM-DD` only (date checks are on files; a travel date lives in the signed search url). Strict anchor adjacency; an anchor present twice = red `anchor-ambiguous`; `between` inclusive and `lo > hi` refused. The 4000-character quote bound stays; the 20-quote bound is dropped (one quote). A crash, transport error or timeout is `stopped`, and the loop's harness treats `stopped` as an instrument stop, never a worker strike.
38. RULED (hamr, 2026-10-12): `agree` is tightened. Reads agree only if they decide the same outcome AND every decide extracted the same (normalized, exact) value and the same presence result; different values = red `agree`. Raw quotes are still not compared.
39. RULED (hamr, 2026-10-12): soft-green wiring. A gating checkpoint holding a judged check must be `requiresHuman` (refused at `createRubric` otherwise); soft-green reuses the existing ACCEPT paths (live, or `accept: "later"` + `gate.recordAccept`, which accepts `soft-green`). A judge can never pass a step alone.
40. RULED (hamr, 2026-10-12): the only time limit is the caller's per-call `deadlineMs`; no signed total wall. The documented worst case is `reads x 2 x deadlineMs` per judged check (§5.2).
41. RULED (hamr, 2026-10-12): names. Plain names consistent with the existing vocabulary. Check: `kind`, `ask`, `sources`, `decides`, `text`. Value decide: `valueKind`, `op` (`lt|lte|gt|gte|between`), `value` (the bound; the word `maxWords`/`max`/`min` use), `lo`, `hi`, `currency`, `anchor`. Presence decide: `phrases`. Gap `direction` is unchanged (open question 2 on `below`/`above`). Unsure names are in the open list (question 4).
42. RULED (hamr, 2026-10-12): §5.3 finding F1 from bareloop's real page: the first snapshot after `goto` can be empty (results load later), so one URL may be registered several times with different sha256; the mid-run design must expect that. Still NOT built.
43. RULED (hamr, 2026-10-12): MONEY `unit` (resolves open question 3). A `money` decide signs exactly one of `currency` or `unit` (XOR; both or neither is refused at `createRubric`). `unit` is a non-empty string (for example `"US dollars"`), matched exactly as signed (case-sensitive, no folding). With `unit`, a value is the `number` grammar run immediately before exactly one space plus the unit text (the unit not followed by an ASCII letter); still exactly one value, still anchorable with strict adjacency (anchor, then the number, then one space and the unit). Thousands separators work (`From 1,234 US dollars.` with anchor `From ` is 1234); trailing punctuation after the unit is fine; a number not followed by one space plus the unit is not a value of this decide (ignored, so `value-none` when no other match). Real example, bareloop's captured Google Flights link line: `From 59 US dollars. Nonstop flight with American. ...` with anchor `From `, `unit: "US dollars"`, `lt` 400 is 59 = green. E4 is rewritten around it; the symbol-currency decide on that line stays red `value-none`. `unit` joins the SemVer-surface additions (open question 2).
44. RULED (hamr, 2026-10-12): JUDGE-INTERNAL RETRY (bareloop 5b). The caller's judge function MAY retry internally (for example once on a transport failure or an HTTP 429) within `deadlineMs`. bareguard sees only the final answer or throw, counts it as one call, and still never retries a throw or a timeout itself (#19, #33 unchanged).
45. RULED (hamr, 2026-10-12): NON-GATING JUDGED CHECKPOINTS (bareloop 5a; clarifies #39, which already allowed them). A non-gating checkpoint may hold judged checks: it records `soft-green` or `red` and returns the gaps (red gaps drive the worker's fix loop; §6 "Non-gating checkpoints record and return gaps/faults but never deny") but never denies. Only a GATING checkpoint holding a judged check must be `requiresHuman`. A rubric may put its single human ACCEPT at the final gating checkpoint (`accept: "later"` + `gate.recordAccept`).
46. RULED (hamr, 2026-10-12): NAMES AND VOCABULARY DESCRIPTOR (settles open questions 4 and 6). The build settles the final names (`decides`, `valueKind`, `op`, `value`, `lo`, `hi`, `currency`, `unit`, `anchor`, `phrases`) and the `rubricVocabulary` list-of-objects descriptor for `decides` in code; the orchestrator reviews them. Open questions 1 and 2 stay open.
47. RULED (hamr, 2026-10-12): WHITESPACE IS COLLAPSED FIRST, and the Module 1 build calls are accepted. `normalizeForQuote` collapses whitespace on the locate decide exactly as everywhere else, so "exactly one space" in the 12-hour and money `unit` grammars means one space AFTER normalization: `9:27  AM` and `59  US dollars` read as `9:27 AM` and `59 US dollars`, not malformed / ignored. Also accepted: a value-many decide's own value list is `values` (`valuesTotal`) because `items` is the `d<i>` list; uppercase `AM`/`PM` with letters glued on (`AMX`, `AMD`, `AMERICAN`) is malformed while a mixed-case word (`American`) is a word and exactly-two-letter `am`/`Am` is malformed; a bare `:` run with no digit (`Total:`) is ignored while `9:27:` / `8:7` are malformed; `measured`/`limit` are canonical strings; `direction` `below`/`above` for `lt`/`gt`; the per-read outcome for `agree` is the overall result plus per-decide kind and canonical extracted value; anchor occurrences are counted overlapping with a 1000 cap.

**2026-10-12 (later; the pivot to `cited` + `decides`, from bareloop's POC, §5.2 "POC 2026-10-12")**

Status of #30-#47: kept as history. Live and shared with `cited`: #32 (exactly one value, anchor), #34 (12-hour time), #35 (presence decide), #36 (co-location: all decides on ONE quote), #37 (confirmed defaults), #43 (money `unit`), #46 (names), #47 (whitespace and canonical forms). PARKED with the `locate` judge (design kept, not the next build): #30 and #31 as to the judge and `reads`, #33 (judge crash is `stopped`), #38 (`agree`), #39 (soft-green wiring), #40 (worst-case time), #44 (judge-internal retry), #45 (non-gating judged checkpoints). #31's "`verdict` judge comes next" is superseded by #50. #30's "build now the `locate` judge" is superseded by #48.

48. RULED (hamr, 2026-10-12): PIVOT. The next build is `cited` + `decides`, NOT the `locate` judge. The WORKER grounds its own claims (quote and values); bareguard verifies them deterministically against the signed frozen source. The result is a plain `green`: no soft-green, no ACCEPT requirement, no reads, because every step is deterministic. Reason: bareloop's POC (30 real calls) showed the judge quotes well but nothing binds its quote to the worker's claim (a flight not on the page was green three times). Supersedes #30's "build now the `locate` judge".
49. RULED (hamr, 2026-10-12): EXTEND `cited` (§4.6). A claim is `{claim, quote, values?}`; the check may sign `decides` (the same shapes and the same pure core as §5.2). Per claim: `quoteIn` -> `decideQuote` -> the TYPED BINDING -> `numbersInQuote` on the claim text. TYPED BINDING: for every VALUE decide the claim carries its value in `values` keyed to that decide, parsed with the same `valueKind` parser and compared for EXACT canonical equality with the value extracted from the quote (`09:27` = `9:27 AM`, `59` = `59.00`, `1,200` = `1200`, `9:27 PM` != `9:27 AM`). A missing value, an unparseable value or an unknown extra key is red. Presence decides need no claim value. Build choices made in the spec, for review (open questions 1-4): the key is the decide's index `d<j>`; a claim value is a bare string of one token of the kind; new gap reasons `claim-value-missing`, `claim-value-malformed`, `claim-value-mismatch`, `claim-value-unknown` under the unchanged gap kind `unsupported`.
50. RULED (hamr, 2026-10-12): PARKED, with the design text kept: the `locate` judge (the judge-call parts of §5.2), `reads`/`agree`, calibration and the `verdict` judge (jev, §5.1). Supersedes #31's ordering ("`verdict` judge comes right after").
51. RULED (hamr, 2026-10-12): "no numbers = red" is NOT ported to `cited`. A number-free claim (`nonstop`) is fine; a spec author adds a presence decide where the fact matters.
52. RULED (hamr, 2026-10-12): KEEP `numbersInQuote` on the claim's free text as well as the typed binding (keep both). Its semantics are unchanged; its known looseness and false reds (`09:27` vs `9:27 AM`, `59.00` vs `59`, `1,200` vs `1200`) are documented in §4.2, and the worker's fix loop handles format mismatches.
53. RULED (hamr, 2026-10-12): any future `locate` judge REQUIRES an output-binding claim that uses the typed binding of #49. This supersedes the earlier idea of binding with `numbersInQuote` plus "no numbers = red" (which the $0 re-run showed too loose).
54. RULED (hamr, 2026-10-12): BUILD ORDER. (1) `cited` + `decides` + typed binding, this build. (2) §5.3 mid-run registered pages: bareloop's flight job needs quotes checked against the arbiter's frozen copy of the exact snapshot the worker saw (F1: one url may have several snapshots with different sha256); design next, NOT built. (3) SUPERLATIVES ("cheapest", "earliest", "N best"): a new deterministic aggregate check over the frozen source: for every line matching a signed selector (for example presence phrases plus anchors) extract the anchored value, and the claim's value must be the minimum or maximum; the flight job's real ask is "cheapest nonstop in window"; design after step 2. (4) PARKED: the judge work of #50.
55. RULED (hamr, 2026-10-12): multi-source claims (one claim backed by two quotes from two sources) are Later; noted, not designed.

**Open questions after #55** (for hamr; what the rulings did not decide; each has a spec default in §4.6 that the build follows unless changed):
1. KEY SHAPE for `values`. Spec default: the decide's 0-based index `d<j>` (no new signed field, matches the gap items `d<j>:<kind>`, cannot collide; the cost is that reordering `decides` re-keys the claims, which is a re-sign anyway). Alternative: a signed per-decide `id` (safer against a reader mistaking positions, but adds a signed field, a uniqueness rule and a vocabulary entry to the decide shape shared with `judged`). RESOLVED (bareloop confirmed 2026-10-12): spec default.
2. CLAIM VALUE FORM. Spec default: a bare STRING holding exactly one token of the kind, no currency symbol or unit text (`"59"`, `"9:27 AM"`, `"2026-10-12"`), parsed by the same grammar, equality on the canonical form. Undecided inside it: whether a JSON NUMBER is accepted for `number`/`money` (spec default: malformed, a worker emitting `59` instead of `"59"` is red and fixes it); whether leading zeros (`"0059"`) are accepted (they are digits of the grammar and equal 59); whether `"$59"` or `"59 US dollars"` should be accepted and stripped of the decide's own symbol/unit (spec default: malformed). RESOLVED (bareloop confirmed 2026-10-12): spec default.
3. EXACT GAP NAMES. Spec default: the check's gap kind stays `unsupported`, with new item reasons `claim-value-missing`, `claim-value-malformed`, `claim-value-mismatch`, `claim-value-unknown`, `quote-too-long` and decide reds as `d<j>:<kind>`; item form `#<i>:d<j>:<reason>`, mismatch carries `:<claim>!=<quote>` canonical, unknown key is `#<i>:<key>:claim-value-unknown`. Alternative: promote the new reasons to the gap `kind` (first red wins, like a `locate` gap) and carry `measured`/`limit`/`anchor`/`direction` fields so the worker sees bounds without reading the spec. RESOLVED (bareloop confirmed 2026-10-12): spec default.
4. `values` on a claim of a `cited` check with NO `decides`. Spec default: red, every key is `claim-value-unknown` (never silently ignored). Alternative: ignore it, or refuse at `createRubric` any rubric whose spec cannot know (impossible: claims are output, not spec). RESOLVED (bareloop confirmed 2026-10-12): spec default.
5. `quote-too-long` (4000 normalized characters) applies to `cited` only when it signs `decides`, to keep today's `cited` byte-for-byte; the alternative is a bound for every `cited` check (tighter, but a behaviour change to a built rule). RESOLVED (bareloop confirmed 2026-10-12): spec default.
6. Mismatch evaluated when the decide is red on its OP but extracted a value (spec default: yes, so the worker sees both). Alternative: skip binding for a red decide. RESOLVED (bareloop confirmed 2026-10-12): spec default.
7. Whether a signed opt-out of `numbersInQuote` is wanted later for claim text that is prose; RULED #52 keeps it always on today.
8. How superlatives (step 3) and mid-run sources (step 2) extend the claim: `source` naming a registered label (step 2), and a claim naming the aggregate it answers (step 3). Not designed.
