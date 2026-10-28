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
- `cells`, `table`, `diff`: recompute a signed op over caller-given table rows (shipped 0.26.0, RULED #67); spec in [cells-prd.md](cells-prd.md).
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

*Built on feat/cells, unreleased: the `cells` / `table` / `diff` rules, computed over caller-given table rows, have their own page, [cells-prd.md](cells-prd.md) (ruling #67).*

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
| `carriesAny` | `field`, `phrases:[...]`, `strict?` | at least ONE listed phrase is present on word edges (RULED #69) |
| `blockLines` | `field`, `size`, `phrases:[...]`, `strict?` | see below |
| `in` / `notIn` | `field`, `values:[...]` | value `===` one of / none of |
| `atMost` | `field`, `value`, `order:[...]` | ordered-enum rank <= value's |
| `max` / `min` | `field`, `value` | finite number <= / >= |
| `cited` | `claims` field, `source` input name, `decides?:[...]` (the shared decide core, §5.2; RULED #48, built df699b9, unreleased) | every claim's quote passes `quoteIn` against the frozen input AND `numbersInQuote`; with `decides`, also every decide on that quote AND the claim's typed `values` equal the values extracted from the quote (§4.6) |
| `complete` | `items:[...]` or `itemsFrom:"caller"`, `claims` field | every item is covered by a claim (§4.4) |
| `judged` | `kind:"locate"\|"verdict"`, `ask`; for `locate`: `sources`, `decides:[...]` (each decide a value decide `valueKind`, `op`, `value` or `lo`+`hi`, `currency?` and/or `unit?` (money, RULED #65), `anchor?`, or a presence decide `phrases`) | see §5 and §5.2 (PARKED, RULED #50: `locate` is no longer the next build; the decide core it defined is shared with `cited`, §4.6) |

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
  "text"` (several allowed keys: `"text", "note"` in the three places). Each key is `JSON.stringify`-escaped
  (`"a\"b\nc"`); when `itemsTotal` exceeds the keys shown, ` and N more` follows the key list. A `sectionWords`
  cut at 20 gaps puts ` and N more` (`itemsTotal` minus the sentences shown) on the last section sentence. Typed gaps unchanged.
- **`mustCarry`**: every phrase in `phrases` is a case-insensitive substring of the field; a red
  gap lists the missing phrases (bounded).
- **`carriesAny`** (RULED #69): green when at least ONE phrase in `phrases` appears in the field on word edges (the
  character before and after is the text edge or not `\p{L}\p{M}\p{Nd}`; plain class check, no digit/hyphen glue; no
  stemming, so `hang` misses "hanging"), case-insensitive; a single space inside a phrase matches any whitespace run,
  newlines included. Red gap kind `none-found` with `phrases` (bounded to 20, `itemsTotal` when cut), distinct from
  `mustCarry`'s `missing`; a missing, non-string or unreadable field stays `missing` / `wrong-type` / `unreadable`.
  Green detail: `full.matched`. Full text in ruling #69 (§12).
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
- **`carriesAny` phrases** (RULED #69) are matched on word edges, not as bare substrings. Strict adds an exact-case
  match to the forgiving word-edge match, so it is never green where forgiving is red.

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
quote length bound and no claim value to bind. Everything above is unchanged when a `cited` check signs no
`decides` and its claims carry no `values` (byte-for-byte; RULED #48). A claim that does carry `values` is red
on such a check: `#<i>:d<j>:claim-value-unknown` for each key, or `#<i>:values:claim-value-malformed` when
`values` is not a plain object (there is no decide to bind to).

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
`between` needs `lo`+`hi`, `money` signs at least one of `currency`/`unit` (RULED #65), bounds parsed by the same parser,
at most 10, the whole list in `rubricSha`; RULED #68 adds the date `lang`/`months` and `decimal` decide fields, see §5.2 "Page forms"). Every claim of the check must satisfy the whole list: a check
whose claims are of different shapes is split into several `cited` checks over different `claims` fields.

**Per claim, in this order** (a claim stops at its first QUOTE failure; once the quote is proven, every
later step runs and ALL its reds are reported):

1. **`quoteIn`** the quote against the frozen source (default substring mode), as today. A failure ends the
   claim: no decide runs on an unproven quote, no binding is checked.
2. **Quote length.** Only when the check signs `decides`: a normalized quote over 4000 characters is item
   `#<i>:quote-too-long` (bounds the extraction work; the 4000 is the number §5.2 already carries; exposed as `rubricVocabulary.bounds.quoteMaxChars`, and it applies only when the check signs `decides`). Without
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
  **`j` indexes the WHOLE `decides` list, presence decides included (RULED #59; verified against
  `src/primitives/rubric.js`, where the value indexes are taken over the full list and a presence decide
  keeps its slot).** With `decides = [value, value, presence, value]` the keys are `d0`, `d1` and `d3`;
  `d2` is the presence decide's slot and is `claim-value-unknown`. It is never "the n-th value decide".
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
`claim-value-unknown`, `quote-too-long`, plus the §5.2 decide kinds under a `d<j>:` prefix. Built (RULED #56-#58, unreleased):
`claim-value-absent` (a `text` decide's value is not in the quote / not after the anchor) and
the list form of `claim-value-mismatch` for an unanchored bind-only decide. An item is
assembled from clipped output-derived parts (claim values, keys, quotes: 120) and UNCLIPPED signed parts,
so a signed phrase in `#<i>:d<j>:phrase-missing:<phrase>` is never cut; anchors, bounds and units are not
in items (the worker has the spec). `renderGaps` renders it as the default JSON row (no plain sentence).
`decideQuote` runs once per distinct normalized quote (memoized; the claim values are then compared per
claim), so the work stays inside the existing cap.

**Evidence spans (RULED 2026-10-18, #66; bareloop ask BG-2).** `checkStep` and `gate.checkStep` return `full.evidence`: where each `cited` check that signs `decides` actually read, so a harness can highlight the proof. NOT in the worker `gaps`, NOT in the audit line, NOT on the humanChannel ask event; no verdict or existing field changes; a `cited` check without `decides`, and every other rule, contributes nothing. Shape: `full.evidence = [{ check, claim, text?, spans, spansTotal? }]`: `check` is the check id as signed, `claim` the index into the caller's claims array, `text` the NORMALIZED quote (exactly the string the decides ran on), `spans` `[{ decide, role, start, end, canon?, matched? }]` with `decide` the 0-based index in the WHOLE decides list, `role` one of `anchor|value|currency|unit|until|phrase`, `start`/`end` half-open UTF-16 offsets into `text` (`text.slice(start,end)` is the highlighted string), spans sorted by (`decide`, `start`). EVERY claim of such a check gets an entry, green or red, in check order then claim order. Every span is a position from the read the check itself made (the readers carry them, including the unit a symbol-form read finds right after its number, `$43 US dollars`), never a second search. Per decide, only what was actually located: a value decide with an anchor gives the anchor, the value run, and the currency symbol / unit text that read it (both for `$43 US dollars`; a negative number's span includes its `-`); unanchored with `op`, every token of the kind it read (same-amount-one-price and `value-many` included), each with its currency/unit span; bind-only membership, every token as a `value` span with `canon` (the canonical string; times as `HH:MM`) and `matched: true` on the token(s) equal to THIS claim's typed value (computed per claim, since two claims can share a quote); anchored bind-only, the anchor and the one value with `canon`/`matched`; a `text` decide, the `anchor`, the `value` occurrence the claim text matched (unanchored: the first qualifying whole-token occurrence; anchored: the run after the anchor; with `until`: the field) and the `until` (the first qualifying one; it includes a signed leading space); a presence decide, one `phrase` span per found phrase at its first case-insensitive occurrence (presence has no strict mode). A missing part has no span (`anchor-missing`, `value-none`, `phrase-missing`, `until-missing`; a claim text that does not match has no value span); `anchor-ambiguous` gives every qualifying anchor; `value-malformed` gives the malformed token as a `value` span (tokens read before it stay). `quote-not-found`, `empty-quote`, a malformed claim, `quote-too-long` and `source-too-large` give `spans: []`; `text` is the normalized quote when the claim is well-formed and the quote is at most 4000 characters, else omitted (so always for `quote-too-long`, and ALWAYS for a malformed claim: its entry is `{ check, claim, spans: [] }` and its raw quote is never read for evidence). A case-folded span (presence phrase, `text` value) is found in the lower-cased quote and mapped back to the normalized quote: `İ` (U+0130) is the only code point whose default lower-casing changes length (1 to 2 units), so spans after or inside `İ` are mapped back (RULED #66 amendment); only an edge that lands inside one `İ`'s 2-unit expansion is omitted, rather than widened or guessed. Bounds: at most 100 claims per check get entries, and `full.evidenceTotal` (ONE call-wide number: all claim entries that would exist across the call) is present only when some were cut; at most 50 spans per entry, `spansTotal` when cut. EXPECTATIONS: offsets index the NORMALIZED quote (whitespace collapsed, `**` and `__` removed, trimmed), not the raw page; they point inside the claim's quote, not the page; presence and membership cannot say "the right" occurrence, only an `anchor` can; `numbersInQuote` gets no spans in v1.

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

**Bind-only decides, membership, and the `text` value kind (RULED 2026-10-12, #56-#59, requested by
bareloop for its "required facts" design; BUILT, unreleased (it ships together with the Node >= 22
requirement). Everything in this subsection is the contract the build meets, and nothing
above it changes for a check that signs neither a bind-only decide nor `text`.)**

*Why.* Today a value decide must carry `op` and a bound, so a spec author who only needs "the worker's
price is the price ON the quote" has to invent a bound. And a fact that is a word, not a number (a flight
number, a carrier, a version), has no decide at all. Two additions, both bind-only (they judge nothing,
they tie the claim's declared value to the quote): an `op`-less value decide, and a `text` value kind.

*Bind-only value decide (RULED #56).* A value decide (`number`, `money`, `date`, `time`) MAY omit `op`.
Then it must not carry `value`, `lo` or `hi` (refused at `createRubric`, the error naming the path, for
example `rubric.checkpoints[0].checks[1].decides[0].value: is refused on a bind-only decide (sign an op,
or drop the bound)`). `currency` / `unit` / `anchor` are as today (money still signs at least one of
`currency`/`unit`, RULED #65). A bind-only decide runs NO condition: `value-over` and `value-under` can never come
from it. It runs extraction and binding only, and the claim MUST carry `values.d<j>` for it (a missing
one is `claim-value-missing`, exactly as for any value decide; malformed is `claim-value-malformed`, same
parser as today). It is a value decide in every other respect (it counts for the `d<j>` key set, it is
memoized per distinct quote, its reds are `#<i>:d<j>:<reason>`).

- **WITH `anchor`**: extraction is unchanged (the ONE value right after the anchor; `anchor-missing`,
  `anchor-ambiguous`, `value-none`, `value-malformed` exactly as §5.2), then the binding is unchanged
  (`claim-value-mismatch:<claim>!=<quote>` when the canonical values differ).
- **WITHOUT `anchor` = MEMBERSHIP.** The quote may hold any number of values of the kind. The claim's
  value must canonically EQUAL ONE OF them:
  - zero values of the kind in the quote = `value-none`;
  - any malformed token of the kind in the quote = `value-malformed` (unsure = red, Law 1; a malformed
    token is never counted away, the same as an unanchored condition decide);
  - the claim value is not among the quote's values = `claim-value-mismatch`; `value-many` NEVER fires
    for an unanchored bind-only decide (many values is the normal case here).
  - **Mismatch item.** `#<i>:d<j>:claim-value-mismatch:<claim>!=<q1>,<q2>,...`: `<claim>` is the
    canonical claim value (as today, clipped 120); the right side lists the quote's canonical values in
    quote order, comma-separated, each clipped to 120, **bounded to 20 values**; when cut, the list ends
    `,...(<total> in all)`. With exactly one quote value the item is byte-identical to the anchored one
    (`...:199!=389`). This is the same bound and the same "list the values the quote does hold" idea as
    `value-many`'s `values` / `valuesTotal`, carried in the reason because a mismatch has no gap-level
    field (a `cited` gap's detail lives in `items`, §4.6 "Gap").
  - **Documented limit.** Membership cannot tell WHICH field of the quote a value is (depart vs arrive,
    price vs a fee that happens to equal it): any value of the kind on the quote passes. The human sees the
    quote and the value at Accept. Where the field matters the author signs an `anchor`.
  - Examples (bareloop's). Quote `Alaska 8:15 AM $389 Nonstop`, decide `{valueKind:"money",
    currency:"$"}`: `values {d0:"199"}` = red `#0:d0:claim-value-mismatch:199!=389`; `{d0:"389"}` = green.
    Two-time row `8:15 AM – 9:47 AM`, decide `{valueKind:"time"}`: `"9:47 AM"` green (`"09:47"` green),
    `"8:15 AM"` green, `"10:00"` red `claim-value-mismatch:10:00!=08:15,09:47`. A quote with no `$`
    token = `value-none`; a quote holding `$5USD` = `value-malformed`.

*Condition decides are unchanged (RULED #57).* A value decide WITH `op` keeps ruling #32 exactly: ONE value
of the kind (or the one right after the anchor), else `value-many` / `value-none` (one exception: a money decide whose
tokens all share one amount reads as one price, RULED #65). A worker never chooses
which value a condition reads, or it would pick the passing one. A two-time row such as `8:15 AM - 9:47 AM`
under `op` needs an `anchor` or a narrower quote. Only `op`-less decides gain membership.

*The `text` value kind (RULED #58; bind only).* `{ valueKind: "text", anchor? }`.
- **Refused at `createRubric`** (error naming the path): `op`, `value`, `lo`, `hi`, `currency`, `unit`.
  Only `valueKind` and an optional `anchor` are allowed. `text` is a value decide for the `d<j>` key set,
  so the claim MUST carry `values.d<j>` (missing = `claim-value-missing`).
- **No extraction**: nothing is parsed out of the quote, so a `text` decide has no `value-none` /
  `value-many` / `value-malformed`.
- **The claim value** `values.d<j>` is a non-empty string of at most 200 characters AFTER normalization;
  a non-string, an empty or whitespace-only string, or one over 200 = `claim-value-malformed` (200 is
  counted in UTF-16 code units, like every other length bound here).
- **Normalization** (both the claim value and the quote): trim; collapse every whitespace run to one
  space; then a case-insensitive compare by `String.prototype.toLowerCase()` on both sides. That is the
  fold the codebase already uses everywhere (`carries` / presence decides, `mustCarry`, headings): it is
  locale-independent, NOT full Unicode case folding (`ß` is not `SS`; a char whose lower-case form is
  longer, such as `İ`, lowers to two code units on both sides, so offsets are taken in the folded text).
  The quote has already passed `normalizeForQuote` (which also drops `**` and `__`); the value gets the
  trim and whitespace collapse only, so a value that itself contains `**` or `__` can never be found
  (documented, harmless: it fails closed).
- **WITHOUT `anchor` = PRESENCE.** The folded value must appear in the folded quote as a WHOLE-TOKEN
  sequence: the character before the match and the character after it are each either absent (quote
  start / end) or NOT a Unicode letter (`\p{L}`), combining mark (`\p{M}`) or decimal digit (`\p{Nd}`).
  Punctuation, `_` and spaces are boundaries, EXCEPT digit glue (RULED #60): a `.` or `,` with a decimal
  digit immediately on both sides holds the number together and is not a boundary (`0.41` is not in
  `0.41.0`, `3` is not in `3.5`, `1` is not in `1,234`); and hyphen digit glue (RULED #62): a `-` with a
  decimal digit immediately before it and a letter or digit immediately after it is not a boundary (`0.41.0`
  is not in `[0.41.0-rc1]`, `2026` is not in `2026-10-12`, `rc1` is not in `0.41.0-rc1`; `LAX` in `LAX-SFO`,
  an en dash with spaces, and `5` in `costs 5-` are unaffected). At the match END the last match character
  is the digit and the character after the `-` is a letter or digit; at the START the character before the
  match is the `-`, the one before that a digit, and the first match character a letter or digit. Many occurrences are fine; one qualifying occurrence is
  enough (an earlier occurrence glued to letters, `xMS791 MS791`, does not hide a later whole one).
  The boundary test reads code points with a single-character class lookup: linear, no backtracking, no
  user regex. Boundaries are tested on the match as given, so a value that starts or ends in punctuation
  (`-5`, `a.b.`) is bounded by its OUTER neighbours only.
- **WITH `anchor`**: the same anchor rules as value decides (the anchor normalized, case-sensitive, found
  exactly once: else the decide itself is red `anchor-missing` / `anchor-ambiguous`, item
  `#<i>:d<j>:anchor-missing`). The value must START right after the anchor with only whitespace between
  (skipped), compared case-insensitively, and END on a whole-token boundary (the character after the match
  is absent or not a letter / mark / digit; digit glue, RULED #60, applies: `0.41` does not end before the
  `.` of `0.41.0`; hyphen digit glue, RULED #62, applies: `0.41.0` does not end before the `-` of
  `0.41.0-rc1`). The character BEFORE the match is the anchor's own last
  character or whitespace and is not tested.
- **WITH `anchor` AND `until` (RULED #61): the END LABEL.** `until` is an optional non-empty string (same
  length and shape limits as `anchor`), allowed ONLY on a `text` decide that also signs `anchor`
  (`until` without `anchor`, or on any non-text decide, is refused at `createRubric` naming the path).
  The anchor rules are unchanged (exactly once, else `anchor-missing` / `anchor-ambiguous`). Then the FIRST
  occurrence of `until` after the anchor's END is found in the normalized quote (case-sensitive; none =
  the decide itself is red `until-missing`, item `#<i>:d<j>:until-missing`, so the binding is not
  evaluated). The FIELD is the quote text strictly between the anchor's end and that `until`, trimmed
  (whitespace is already collapsed); an empty field is `value-none`. The claim value (normalized as for
  `text`) must EQUAL the field case-insensitively (`toLowerCase()`): no prefix, no overlong run. Not equal =
  `#<i>:d<j>:claim-value-mismatch:<claim>!=<field>` (both clipped to 120). `until` is normalized like the
  quote (`**` / `__` dropped, whitespace runs collapsed) but NOT trimmed, whereas an `anchor` is trimmed
  (the quote is trimmed, so a signed `"From "` is `"From"`): a signed `" at"` keeps its leading space, so it
  keeps that space at its start edge; whether it can match inside a word is decided by the label word-edge rule
  (RULED #64): `" at"` ends in a word character, so it needs a boundary after it (`" attendant"` does not match).
  Example: quote `Leaves San Francisco International Airport at 9:27 AM`, anchor `Leaves`, until
  ` at`: `"San Francisco International Airport"` green, `"san francisco international airport"` green,
  `"San Francisco"` red `claim-value-mismatch:San Francisco!=San Francisco International Airport`,
  `"San Francisco International Airport at"` red mismatch.
- **LABEL WORD EDGES (RULED #64).** A signed `anchor` (any decide that takes one: value decides AND `text`) and a
  signed `until` match only where their word-character edges (`\p{L}\p{M}\p{Nd}`) sit on a token boundary: if the
  label's FIRST character is a word character, the quote character before the match must be a boundary or the
  quote start; if its LAST character is a word character, the character after the match must be a boundary or
  the quote end. The same helpers as the text boundaries decide it, so the digit glue (#60) and hyphen glue
  (#62) apply (anchor `v1` does not match in `v1.2` nor `v1-b`). A non-qualifying occurrence is SKIPPED: it does
  not count toward `anchor-ambiguous`, and for `until` the search continues to the next occurrence. A label edge
  that is punctuation or a space (`Total:`, a leading `" at"` space) is unaffected at that edge. This TIGHTENS
  released behavior for value-decide anchors (anchors on value decides shipped in 0.22.0): the release CHANGELOG
  lists it under Changed. DIGIT-GLUED ANCHORS are kept strict on purpose (hamr, 2026-10-13; unsure = red): a signed
  anchor `From ` is trimmed to `From`, so quote `From59` is `anchor-missing` (0.22.0 read `59`), while `From 59` is
  still green; likewise `Price12` / `Qty3`. Sign the anchor against a page that puts a space or punctuation after
  the label. Examples: quote `City: Boston atlas Hotel at X`, anchor `City:`, until `" at"`: field
  `Boston atlas Hotel` (`"Boston"` red mismatch); anchor `Leaves` does not match in `Leavesley Park` (text and
  time decides: `anchor-missing`), and `Leavesley Leaves 9:27 AM` finds the anchor once; anchor `Total` on
  `Totals: $5 Total $7` reads `$7`.
- **Limits from real data (bareloop).** A text claim `8:15` inside `8:15-9:47` is red (glued by the hyphen),
  while time membership on `8:15-9:47 AM` still finds both times; `2026` inside `2026-10-12` is red;
  `W-2` and `BA-4` are NOT glued (the hyphen glue of #62 applies only after a digit), so the whole token and
  its parts (`W`, `2`, `BA`, `4`) are all green; `MS791` against `MS791-B` is red (digit before the hyphen). A field containing the
  `until` string is cut at the first QUALIFYING match (`Stratford at Avon Airport` with until `" at"` gives
  field `Stratford`). A membership or bind-only decide is red `value-malformed` if ANY token of the kind in the
  quote is malformed (e.g. `9:27 AM or 9:27AM`): sign an `anchor` to scope past noisy text.
- **Without `until`, anchored `text` is a PREFIX read.** A whole-token prefix (`San Francisco` for `San
  Francisco International Airport`) or an overlong run passes, because the value only has to start at the
  anchor and end on a boundary. Sign `until` to close it (RULED #61).
- **Absent = new red `claim-value-absent`** (a CLAIM-vs-QUOTE red, in the family of
  `claim-value-mismatch`, not a decide red): the value is not in the quote (no anchor), or not right after
  the anchor. Item `#<i>:d<j>:claim-value-absent:<value>`, where `<value>` is the claim value in its
  NORMALIZED form (trimmed, whitespace collapsed, ORIGINAL case, output-derived, clipped to 120), so the
  worker's fix loop sees what it sent. Not evaluated when the decide's own red already says the extraction
  failed (`anchor-missing` / `anchor-ambiguous`), and not evaluated when the value was missing or
  malformed (those reds say so).
- **Membership lists DISTINCT values (RULED #63).** In a membership `claim-value-mismatch` item the quote's
  canonical values are de-duplicated (first-occurrence order), and the 20 bound and the `(N in all)` total
  count DISTINCT values: a row with `09:27` three times and `11:07` three times, claim `12:34`, is
  `12:34!=09:27,11:07`.
- **Spelling limits (no code change).** (a) Time spelling stays per ruling #34: lowercase `am` / `pm` and no-space
  `9:27AM` are malformed in both claim and quote (deliberate; a site that writes them needs a different
  decide). (b) `v0.41.0` in the quote does not match the claim `0.41.0`: `v0` is one whole token (by
  design; claim `v0.41.0` instead).
- **No regex, no wildcards** (decided: either can be added later without breaking any signed spec; a
  signed string with `*` or `.` is a literal today and stays one).
- **Documented limit.** Without an anchor `text` cannot tell which field the value is in. Real evidence
  (bareloop POC round 2, 44 Google Flights listitem blocks): `LAX` and `SFO` are each present in 44/44
  blocks, so an unanchored "from SFO" passes on a wrong-way page; `Departure time:` / `Arrival time:`
  anchors are 44/44. That is why the anchor is in v1.
- **Examples.** Quote `EgyptAir MS791 USD 420`: `"MS791"` green, `"ms791"` green, `"MS79"` red
  `#0:d0:claim-value-absent:MS79` (a prefix of a token). Quote `## [0.41.0] - 2026-10-12`: `"0.41.0"` green.
  Quote `Alaska Airlines 8:15 AM`: `"alaska   airlines"` green (whitespace collapsed, case folded). Quote
  `Alaska 8:15 AM $389 Nonstop`: `"Delta"` red `claim-value-absent:Delta`. Anchored: quote `Departure time:
  8:15 AM. Arrival time: 9:47 AM.`, anchor `Departure time:`, `"8:15 AM"` green, `"9:47 AM"` red.

*Layout note on the examples (RULED #59).* The right money form depends on the page's layout, and a spec
author checks it on the real capture. On bareloop's per-flight `listitem` blocks, `unit: "US dollars"` is
`value-many` (a button label repeats the amount; since RULED #65 an `op` decide reads a repeated SAME amount as one price,
so only different amounts stay `value-many`) while `currency: "$"` finds exactly one token (44/44). On
the one-line link rows (E4 above) it is the reverse: the price is spelled `59 US dollars`, so `unit` works
and `currency: "$"` is `value-none`. With a bind-only decide the same holds for the symbol/unit choice,
except that a repeated amount is no longer `value-many` (membership).

*Vocabulary and createRubric (how `rubricVocabulary` stays driven by the same table).* The DECIDES
descriptor in `src/primitives/rubric.js` is the single table `createRubric` validates against and
`rubricVocabulary` / `describeRule` print. The build changes it, and only it, in four ways: (1) the value
shape's `valueKind` enum gains `"text"` (`["number","money","date","time","text"]`); (2) `op` on the value
shape flips from `required: true` to `required: false`; (3) its `conditions` list is rewritten to say it:
"op may be omitted (a bind-only decide: then value, lo and hi are refused, and without an anchor the claim
value must equal one of the quote's values)"; "an op decide: between needs lo and hi (lo <= hi) and forbids
value; the other ops need value and forbid lo and hi"; "valueKind text is bind-only: it refuses op, value, lo,
hi, currency and unit, and the claim value is a non-empty string of at most 200 characters"; "money needs
at least one of currency or unit (both are allowed; each takes one value or a list); currency and unit are refused on any other valueKind"; (4) the list-level
condition says "a claim must carry a string in values.d<j> for every value decide, any valueKind, with or
without op, `text` included; j indexes the whole decides list". The validator's per-field checks read
those same entries (`required`, `enum`), so the descriptor and the refusals cannot drift; the both-directions
vocabulary test (§10) pins it. The bind-only / `text` shapes are valid only under `cited`: the PARKED
`judged` check keeps requiring `op` and refuses `valueKind: "text"` (it has no claim to bind, §5.2).

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
not exported from `src/index.js`. Its default test keeps only a 16 KiB -> 64 KiB linearity guard; the pathological 5 MiB cases run in the opt-in `npm run bench:rubric` (`bench/rubric-locate.bench.mjs`, not in CI or `npm test`). No `judged` rule uses it (PARKED; the per-read outcome comparator of §5.2 (#38) is not built, it belongs to the parked judge). `createRubric` refuses a `judged` rule as an
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
| `valueKind` | `"number"` \| `"money"` \| `"date"` \| `"time"` (and, under `cited` only, `"text"`: bind only, no parser, BUILT, RULED #58, §4.6) | refused | which parser runs (below) |
| `op` | `"lt"` \| `"lte"` \| `"gt"` \| `"gte"` \| `"between"` | refused | `value < bound`, `<=`, `>`, `>=`, or `lo <= value <= hi` (BOTH ends inclusive). Required on a `locate` decide; under `cited` it MAY be omitted (BUILT, RULED #56: a bind-only decide, then `value`/`lo`/`hi` are refused and an unanchored one is a membership test, §4.6) |
| `value` | number (`number`, `money`) or string (`date`, `time`) | refused | the bound; required unless `between`, refused with `between`. Parsed by the SAME parser as the quote's value, at `createRubric`; a bad bound is refused naming the path |
| `lo`, `hi` | same type as `value` | refused | both required with `between`, refused otherwise; `lo <= hi` required (a wrap-around window such as 22:00-02:00 is refused) |
| `currency` | `"$"` \| `"€"` \| `"£"`, or a list of 1-3 unique ones (RULED #65) | refused | with `money`: at least one of `currency` or `unit` is required (RULED #65, replaces the #43 XOR); refused on any other `valueKind`. Each signed symbol is a money form |
| `unit` | non-blank string, max 100 characters | refused | with `money`: a string, or a list of 1-10 unique strings (RULED #65), each non-blank and max 100 characters: the signed unit text that follows the number (`"US dollars"`); may be signed together with `currency`; refused on any other `valueKind`; case-sensitive, exact as signed; never clipped in a gap |
| `lang` | `"en"` \| `"de"` \| `"fr"` \| `"es"` \| `"it"` \| `"pt"` \| `"nl"`, no default (RULED #68) | refused | `date` only: the ONE signed language whose month names are read; ABSENT = ISO `YYYY-MM-DD` only, exactly as before; refused on any other `valueKind` and on `text`; mutually exclusive with `months`. See "Page forms" |
| `months` | list of exactly 12 non-blank strings (Jan..Dec order) (RULED #68) | refused | `date` only: the signed month names for a language not in the built-in list; refused on any other `valueKind`; refused together with `lang`. See "Page forms" |
| `decimal` | `"."` \| `","`, default `"."` (RULED #68) | refused | `number` and `money` only: the signed decimal mark; refused on `date`, `time` and `text`. Never guessed. See "Page forms" |
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
other four ops require `value` and forbid `lo`/`hi`; `money` requires at least one of `currency` or `unit`, RULED #65).

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
red `value-many` (`measured` = the count, `values` = the values, canonical, clipped, bounded 20 with `valuesTotal` when cut; a money `op`
decide whose tokens all share one amount is the exception, one price, RULED #65), one
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

**`money`.** A money decide signs AT LEAST ONE of `currency` or `unit` (RULED #65, which replaces the #43
XOR); both may be signed on one decide. `currency` is one of `"$"`, `"€"`, `"£"` or a list of 1-3 unique ones; `unit`
is one string or a list of 1-10 unique non-blank strings (max 100 characters each). A plain string behaves exactly
as before. The decide's money values are EVERY token matching ANY signed form, in quote order; each form keeps
its own grammar, below, unchanged. If two forms read the same numeric run (`$43 US dollars`), it is ONE token.
Anchored, the anchor is followed by a value in any signed form, with the same strict adjacency. A malformed
token of any signed form is `value-malformed`. SAME AMOUNT = ONE PRICE (money only): an `op` decide, unanchored,
whose 2+ tokens ALL have the same canonical amount (`$43` and `43 US dollars`, or `$43` shown twice) reads as that
one value and the condition runs on it (the collapse compares amounts only, not currency or unit: with `currency: ["$","€"]`, "€43 or $43" reads as ONE price, 43; sign one currency per check if a page can mix them); two different amounts are `value-many` as before. A bind-only (no `op`)
decide is membership over the union of forms, unchanged. Other value kinds are unchanged: a repeated equal
value is still `value-many`. DOCTRINE: the forms come from the real captured page, never from the model's
imagination; the consumer (bareloop) drafts the rule from the page it saw. bareguard cannot see where a form
came from and matches only what was signed. Limits, not built: a code BEFORE the number (`USD 43`) stays
unread (RULED #37; `43 USD` works as `unit: ["USD"]`), `US$43` is `value-malformed`, and decimal-comma
`43,50 €` is `value-malformed`. (RULED #68 lifts the decimal-comma limit for a decide that signs `decimal: ","`, and reads a symbol glued AFTER the number; see "Page forms" below.)
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
  dollars` are malformed). Still exactly one value: unanchored, two matches of different amounts are `value-many` (the same
  amount repeated is one price, RULED #65), none are
  `value-none`; still anchorable, with strict adjacency as for every other kind: the anchor, then (at
  most whitespace skipped) the number, then one space and the unit (`From 59 US dollars` with anchor
  `From ` reads 59; an anchor followed by a number that is not followed by the unit is `value-none`).
  Only the matching token of the signed unit counts, so other numbers on the line (`1 hr 40 min`,
  `0 checked bags included`) are never money values and never malformed.
- Fractional digits: any count >= 1; compared exactly (as every `number` and `money` value).

**`date`.** A candidate is a maximal run of `0-9` and `-`. Only a run of exactly the shape
`dddd-dd-dd` is a date token; any other run is ignored (so `0.41.0`, a lone ` - `, `1234` are
ignored, and `12026-10-12` yields nothing). A date-shaped run must be a real Gregorian calendar day
with year 0001-9999, else MALFORMED (`2026-13-45`, `2026-02-30`). One format only: ISO `YYYY-MM-DD`,
unless the decide signs `lang` or `months` (RULED #68, see "Page forms" below)
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

#### Page forms: dates in a signed language, decimal comma, symbol after the number (RULED #68)

Everything here is additive. A decide that signs none of `lang`, `months`, `decimal` reads as before, except for the three
named changes in "Behaviour changes" below. bareguard NEVER detects a language, a date order or a decimal mark: only what the
decide signed counts, and a quote in another language is not read (`value-none`). Forms come from the real captured page
(#65 doctrine); bareloop drafts the rule from the page it saw.

**Dates (`lang`, `months`).** `lang` is one of `en de fr es it pt nl`, with NO default: an absent `lang` (and an absent `months`) reads ISO `YYYY-MM-DD` only, exactly as before, and the English forms are opt-in via `lang: "en"`; an unknown code is refused at
`createRubric` naming `decides[j].lang`. `months` is a list of EXACTLY 12 strings in Jan..Dec order, each non-blank, letters
(with marks) and an optional trailing `.` only, no whitespace or digit, at most 40 characters, unique case-insensitively; a bad
list is refused naming `decides[j].months` (or `decides[j].months[i]` for one bad entry). `lang` and `months` together are refused
(the error names `decides[j].months`; mutually exclusive, even `lang: "en"` with `months`). With `months`, ONLY those 12 names are
read (no built-in table, no `de` connector, no month-first form). Both fields are `date` only: on `number`, `money`, `time` or `text`
the field is refused naming its own path (`decides[j].lang`).

The month tables are built in, case-insensitive (`toLowerCase`, the fold used everywhere here), and ACCENT-EXACT (`März` is
read, `Marz` is not; sign `months` for a page that strips accents). Each month has its full name and common short forms; a short
form may carry one trailing `.` (`Okt.`), which belongs to the token. The short forms and the accent-exact rule are RESOLVED (Q2, bareloop's real pages): accents stay EXACT, no folding; the short forms actually seen are English only, day + 3-letter month + year, no dot, often zero-padded (`03 Jul 2025`, `18 Dec 2025`, `30 Jul 2026`, `24 Sep 2026`), and the `en` row below carries all of them. The table:

| lang | full names / short forms |
|---|---|
| en | january..december; jan feb mar apr jun jul aug sep sept oct nov dec |
| de | januar jänner februar märz april mai juni juli august september oktober november dezember; jan jän feb mär mrz apr jun jul aug sep sept okt nov dez |
| fr | janvier février mars avril mai juin juillet août septembre octobre novembre décembre; janv févr avr juil sept oct nov déc |
| es | enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre; ene feb mar abr may jun jul ago sep sept set oct nov dic |
| it | gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre novembre dicembre; gen feb mar apr mag giu lug ago set sett ott nov dic |
| pt | janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro; jan fev mar abr mai jun jul ago set out nov dez |
| nl | januari februari maart april mei juni juli augustus september oktober november december; jan feb mrt apr jun jul aug sep sept okt nov dec |

Forms read (a form is one token; spaces are single, since the quote is already whitespace-normalized, #47, which also folds a
no-break space to a space). The year is exactly 4 digits (0001-9999). The day is 1-2 digits, a leading zero allowed.
- ISO `YYYY-MM-DD`: unchanged, read whatever the language, and the ONLY form read when neither `lang` nor `months` is signed.
- Day-month-year, every signed `lang` and `months`: `D[.] <month> YYYY` (`21 October 2026`, `13. Oktober 2026`, `22 Okt. 2026`). One
  optional `.` directly after the day (the German day dot); read uniformly for every language.
- `es` and `pt` only: `D de <month> de YYYY` (`5 de octubre de 2026`); `de` is case-insensitive; both connectors or neither
  (`5 octubre 2026` is read, `5 de octubre 2026` is not). RESOLVED (Q8, bareloop): strict both-or-neither.
- Month-day-year, `lang: "en"` only: `<month> D, YYYY` (`September 29, 2026`, `Sep 29, 2026`); the comma is required.
Reading rules: a month name matches as a whole word (not preceded or followed by a letter, short-form `.` aside). The value
is a REAL calendar day (31 February, 30 April, 29 February in a non-leap year = `value-malformed`, the token being the whole shaped
form). The decide's value is the canonical ISO `YYYY-MM-DD`, compared as today. A letter directly before the day, or directly after the
year, makes a date-shaped form MALFORMED (as for ISO today). NOT read, with what they give: a missing year (`13. September`,
`October 2026`) is not a date token and is ignored (`value-none` if nothing else); an ordinal (`5th October 2026`, `October 5th, 2026`)
is MALFORMED when the rest is a complete date shape (a day with a letter suffix, a recognised month and a year), else ignored; a
weekday word before the date (`Tue, September 29, 2026`, `Mi, 14. Oktober 2026`) is ignored text, never part of the token and never an
error, so the date after it reads; a month name of another language (`13. Mai 2026` under `en`; `May` under `de`) is not a month, so
nothing is read (`value-none`). Day-first vs month-first is never guessed: `lang` fixes the table, the forms above fix the order.

*Claim value for a date stays the canonical ISO string.* `values.d<j>` is `"2026-10-21"`, never `"21 October 2026"`
(`parseClaimValue` takes no decide and keeps one canonical form; a worker's non-ISO claim value is `claim-value-malformed`).
Signed bounds (`value`, `lo`, `hi`) stay ISO. Reuse: `rubric-cells.js` already signs per-column formats including `D MMM YYYY` and
folds month names with `toLowerCase`; the month-name matching, fold and real-day check are the same vocabulary, and the month
tables SHOULD live in one shared module that both readers import. The cells readers themselves do NOT change (their `D MMM YYYY` stays
English 3-letter only, and `Sept` stays unread there: SemVer).

**Decimal comma (`decimal`).** `decimal` is `"."` (default) or `","`, on `number` and `money`; any other value is refused at
`createRubric` naming `decides[j].decimal`; on `date`, `time`, `text` it is refused naming its own path. Never guessed: with
`"."` the grammar is exactly as today (`,` is the thousands mark: `1,299` is 1299, and stays 1299). With `","` the mirrored grammar
applies (the same strictness): a numeric run is `D+` or `D{1,3} (SEP D{3})+`, where SEP is `.` or a single space, ONE kind per run
(mixing is MALFORMED), then optionally `"," D+`. The first group is 1-3 digits and every later group exactly 3; at most one `,`, after
the grouping, followed by at least one digit; no `.` or space after the `,`. Examples: `1.234,99` = 1234.99, `12 832,99` = 12832.99,
`649,99` = 649.99, `1,299` = 1.299, `1.234` = 1234; MALFORMED: `1.23`, `1.2345`, `1,234.56`, `1.234 567,8`, `12.34.56`. A space joins a run only when a digit
is before it and exactly three digits (not followed by a digit) are after it and the group before has at most 3 digits and no `,` has
been read; so `2026 123` and `12,50 123` do not join. The trailing `.`/`,` cut (sentence punctuation), the sign rules, letter
adjacency and the leading-mark rule (`,5` is malformed) are unchanged. DOCUMENTED LIMIT: because space grouping is read, `Rated 4 832 times` under `decimal: ","`
is 4832 (the signer chose a comma-decimal page; sign `decimal: ","` only on a check whose quote is a price). Signed bounds are JS
numbers and keep their `.`-decimal rendering. *Claim values stay canonical JS-style decimals* (`"1234.99"`). On a decide that signs `decimal: ","`, a claim value containing a `,` (`"1,299"`, `"1234,99"`) is `claim-value-malformed`, never read: unsure = red, so a worker cannot slip a comma-decimal value past the grammar. (This needs the claim parser to receive the decide's `decimal`; decides that do not sign `decimal` keep today's claim grammar, including `"1,234.56"`.) Evidence `canon` stays the canonical decimal.

**Symbol glued after the number (money `currency`).** A signed symbol directly after the digits (`499€`, `699.00€`, `29,99€` with
`decimal: ","`) reads as that currency, the same as the symbol before (`€499`): the run keeps its grammar (a whole number needs no decimals);
the symbol must be one of the decide's signed `currency` symbols. No new signing field. A run with a currency symbol (any of `$ € £`, signed or not) on BOTH sides
(`$43$`, `€43€`, `$43€` and `€43$` even when only one of them is signed) is MALFORMED (unsure = red). A letter or digit directly after the glued symbol
(`499€x`) is MALFORMED; a space, punctuation, `*` or the end may follow (`29.99€*d)` reads). `43€ €` reads 43: the second symbol has no
digits glued to it and is ignored (open question 4). A symbol AFTER A SPACE (`29.99 €`, `649,99 €`) is still NOT read by `currency`
(#37): that form is the `unit` form, `unit: "€"` (works today, and with `decimal: ","`); a check that must read both signs
`currency: "€"` and `unit: "€"` (ONE money decide MAY sign the same symbol in both boxes; `createRubric` accepts it): glued `29,99€` is then a currency token and spaced `29,99 €` a unit token, and on one page the SAME amount counts as ONE price (#65 (4)) while two different amounts are `value-many`. HELD, unchanged: a code before the number
(`CHF 126.65`, `EUR 17.86`, #37 and #65 stand); `126.65 CHF` already reads as `unit: "CHF"`. The glued-after form works anchored with the same
adjacency (anchor, optional whitespace, number, symbol).

**Required tests (the contract's list).** Dates: `03 Jul 2025` (`lang: "en"`, zero-padded day, 3-letter month), `21 October 2026`, `22 Okt. 2026`, `13. Oktober 2026`, `5 de octubre de 2026` and `5 octubre 2026` read, `5 de octubre 2026` not read; `September 29, 2026` and `Sep 29, 2026` (`en`), `September 29 2026` (no comma) not read; weekday prefixes (`Tue, September 29, 2026`, `Mi, 14. Oktober 2026`); `31 February 2026` and 29 February in a non-leap year malformed; `13. Mai 2026` under `en` and `May` under `de` not read; a missing year and an ordinal (`5th October 2026`, `October 5th, 2026`) as above; accents exact (`Marz` unread, `März` read); `months` (own list, no built-in table, no `de` connector); ISO still read under every `lang`; no `lang` = ISO only (`21 October 2026` is `value-none`); the claim value stays ISO. Decimal comma: every example and every MALFORMED case of the grammar above, the space-join conditions, `.`-default unchanged (`1,299` = 1299), a claim value with `,` on a `decimal: ","` decide is `claim-value-malformed`, a default-decimal decide still accepts `"1,234.56"`. Glued-after: `499€`, `699.00€`, `29,99€`, `$`/`£`, anchored, `$43$` / `€43€` / `$43€` (both signed) malformed, `499€x` malformed, `43€ €` reads 43, `29.99 €` NOT read by `currency`; one decide signing `currency: "€"` and `unit: "€"` reads `29,99€` and `29,99 €`, same amount on one page is one price, two amounts are `value-many`. Validation: every refusal with its exact `e.path`. Evidence spans, `rubricVocabulary` entries, and an existing signed spec's `rubricSha` unchanged. Real strings from bareloop's saved pages are fixtures.

**Known limits (#68).** Month matching is code-unit exact: a page sending decomposed (NFD) text does not match (`value-none`, fails safe). A hyphen glued before a short day (`Mon-21 October 2026`) is `value-none`: a run of digits and hyphens is one unit, as for ISO. A signed `months` entry matches exactly as signed: an entry without a dot does not read a page form with a dot (`Okt` does not read `Okt.`), and one signed with a dot is read only with it. Letter edges of the date forms use Unicode letters; an ordinal suffix is any run of letters. Under `decimal: ","` a space-grouped run can swallow a preceding 1-3 digit token (`Zimmer 3 120€` reads 3120); an `anchor` ending before the swallowed token (`Zimmer`) still reads 3120; only one ending right before the price (`Zimmer 3`) reads 120. The weekday skip applies to unanchored dates: an anchored date must start right after the anchor, so `Depart: Mon 5 October 2026` with anchor `Depart:` is `value-none` (fails safe).

**Evidence spans (#66).** Unchanged shape. A date token's `value` span is the whole token from its first character (the day, or the
month word for `September 29, 2026`) to its last digit, including the day dot, a short-form `.`, and the `de` connectors, never
the weekday; `canon` (bind-only) is the ISO date. A glued-after money token gives a `value` span over the digits (including
`.`/space groups and the `,` decimal) and a `currency` span over the symbol AFTER the number; a malformed token gives the shaped range as a `value`
span. `decimal` changes no span role.

**Hash, vocabulary, SemVer.** The new fields hash like any signed field: `rubricSha` is canonical JSON with sorted keys and an absent
key is not in the hash, so an existing signed spec keeps its sha; an EXPLICIT `decimal: "."` hashes differently from absent (same meaning, a re-sign); `lang: "en"` is a real change of meaning (opt-in English forms), so it re-signs. `months` is an array: order is hashed. `rubricVocabulary` lists the three fields under the `cited`
`decides` value shape (generated by `describeRule`): `lang` enum (no default; absent = ISO only), `months` string list of exactly 12 (the descriptor needs an exact-count
bound, which `string-list` lacks today), `decimal` enum + default `"."`, with the conditions above, plus the per-kind refusals. Minor
release 0.27.0 (confirmed by hamr), additive.

**Behaviour changes (existing specs).** An existing signed spec reads identically except: (1) a money
`currency` decide now reads a glued-after symbol: `29.99€` was ignored (`value-none`), it now reads. (2) A TIGHTENING: a token that was read as
`$43` while a currency symbol (any of `$ € £`) sat directly behind it (`$43$`, `€43€`, `$43€`) is now `value-malformed`, and so is `€43$` with only `$` signed. A date decide with no `lang` is NOT changed (ISO only). Nothing else
changes: ISO dates, `.`-decimal numbers, glued-before symbols and every unit form read exactly as before.

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
| `value-many` | `judged` | `measured` = count, `values` = the values (`valuesTotal` when cut) | two or more, unanchored (a money `op` decide: two or more DIFFERENT amounts, RULED #65) |
| `value-malformed` | `judged` | `measured` = the token, clipped 120 | shaped but invalid, a letter suffix, a bad am/pm, a unit |
| `value-over` | `judged` | `measured` = value, `limit` = the bound, `direction` | above `lte` / `lt` / `between` `hi` |
| `value-under` | `judged` | `measured` = value, `limit` = the bound, `direction` | below `gte` / `gt` / `between` `lo` |
| `phrase-missing` | `judged` | `measured` = the first missing signed phrase (never clipped) | a presence decide's phrase is not in the quote |
| `disagree` | `agree` | `measured` = distinct outcomes, `limit` = `reads` | the reads decided or extracted differently |

The next two are `cited` ITEM reasons (`#<i>:d<j>:<reason>`, §4.6 "Gap"), listed here with the decide kinds so
the reason words live in one place. BUILT (RULED #56, #58):

| item reason | where | Meaning |
|---|---|---|
| `claim-value-mismatch:<claim>!=<q1>,<q2>,...` | `cited` binding | a bind-only decide WITHOUT an anchor (membership): the canonical claim value equals none of the quote's values; the quote's canonical values listed in quote order, each clipped 120, at most 20, `,...(<total> in all)` when cut. With one quote value it equals the anchored form `<claim>!=<quote>` |
| `claim-value-absent:<value>` | `cited` binding | a `text` decide: the normalized claim value is not in the quote as a whole-token sequence (no anchor), or not right after the anchor; `<value>` is the normalized claim value (original case), clipped 120 (digit glue, RULED #60: a `.`/`,` between digits is not a boundary; hyphen digit glue, RULED #62) |
| `until-missing` | `cited` decide | an anchored `text` decide signing `until` (RULED #61): no `until` after the anchor; item `#<i>:d<j>:until-missing`, a decide red like `anchor-missing`, the binding is not evaluated. An empty field between the anchor and `until` is `value-none`. With `until` the binding is `claim-value-mismatch:<claim>!=<field>` (the claim must equal the field, case-insensitively); a membership mismatch lists DISTINCT values (RULED #63) |

For a bind-only unanchored decide `value-many` never fires; `value-none` (zero values of the kind) and
`value-malformed` (any malformed token of the kind) keep their meaning. A `text` decide has no extraction, so
it has none of `value-none` / `value-many` / `value-malformed` (only `anchor-missing` / `anchor-ambiguous`
from its own anchor).

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
  states its price in words signs `unit`, not `currency` (or, RULED #65, both: `currency: "$"`, `unit: ["US dollars"]` reads the
  same line as 59, and Google Flights' `From 43 US dollars.` with anchor `From` is 43, green).
  The ruling that decides each of these: #34 (12-hour), #35 (presence), #36 (one quote, co-location),
  #37 (symbol money), #43 (money `unit`).

#### Open questions (for hamr; everything the rulings did not decide)

These concern the PARKED judge. The open questions of the `cited` pivot are at the end of §4.6's rulings, §12 "Open questions after #55".

1. `opts.judge` shape once `verdict` exists: a single function (this build) vs `{ locate, verdict }`.
   And whether the judge's `input` should include `output` (this spec passes `{ output, sources }`).
2. `direction` gains `"below"` and `"above"` (strict `lt`/`gt`); the alternative is to give strict
   compares their own gap kinds. Also: the new optional gap field `anchor`, the new `judged` gap kinds
   (including `phrase-missing`), the money `unit` field (#43) and the `d<i>:<kind>` item form are SemVer-surface additions.
3. (SETTLED, RULED #43: money may sign `unit` instead of `currency`; RULED #65: or both, or lists; see "Extraction: per value kind".)
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
| `rubricVocabulary` | frozen, machine-readable; lists every rule with its field names, types, required/optional, bounds (count fields integers >= 1, no max; string lists non-empty arrays of non-empty strings; no whitespace-only strings; the `cited` caps `quoteSourceMaxBytes`, `quoteWorkMax` and `quoteMaxChars`) and defaults (including `strict`); a drafting LLM reads it; every check description shown to anyone is GENERATED from it, never hand-written. BUILT (RULED #56-#58): the `decides` descriptor's `valueKind` enum gains `"text"`, `op` becomes optional, and its conditions are rewritten (§4.6 "Vocabulary and createRubric"); the shape also carries the `textFields` key (the fields a `text` decide may sign: `anchor`, `until`), the `until` field, and the `text` member of the `valueKind` enum; the descriptor and the validator stay driven by the one table |
| gate methods | `checkStep(checkpoint, output, opts)`, `drainGaps()`, `recordAccept({...})` (harness-only) |
| config keys | `rubric: { spec, sha256, advanceOn }`; signed spec keys `onExhausted`, `maxReds`, `reads`, `requiresHuman`, per-checkpoint `accept`, per-check `id`, `text`, `strict`, `phrases`, `noneExit`, `expectExit`, `direction`, `baseline`, `patterns`, `allowPrefixes`, `requireNonEmpty`, `size`, `items`, `itemsFrom`; for `cited` (§4.6, RULED #48) `decides` and, inside a decide, the same fields as below; the claim shape `{claim, quote, values?}` with `values` keyed `d<j>` and the `cited` gap item reasons `claim-value-missing`, `claim-value-malformed`, `claim-value-mismatch`, `claim-value-unknown`, `quote-too-long` and `d<j>:<decide kind>`; BUILT, unreleased (RULED #56-#59, ships with Node >= 22; #64 label word edges for `anchor` and `until`): `op` optional on a `cited` value decide (bind-only), the value kind `text` (inside a decide: `{valueKind:"text", anchor?, until?}`; `until` RULED #61, hyphen digit glue RULED #62, distinct membership list RULED #63), the item reasons `claim-value-absent` and the list form of `claim-value-mismatch` (`<claim>!=<q1>,<q2>,...`), the 200-character claim-value bound for `text`, the `createRubric` refusals for `value`/`lo`/`hi` without `op` and for `op`/`value`/`lo`/`hi`/`currency`/`unit` on `text`, and the `d<j>` rule that `j` indexes the whole `decides` list; for `judged` (PARKED, §5.2) `kind`, `ask`, `sources`, `decides`, and inside a decide `valueKind`, `op`, `value`, `lo`, `hi`, `currency`, `unit`, `anchor`, `phrases` |
| rule strings | every rule in §4; deny rules `rubric.invalid`, `rubric.red`, `rubric.stopped`, `rubric.unminted`, `rubric.output-mismatch`, `rubric.exhausted`, `rubric.needs-accept` |
| audit | phases `rubric` (`rubricSha`, `checkpoint`, `verdict`, `outputSha`, bounded `gaps` / `fault`), `rubric_baseline` (`baselineSource`), `rubric_accept`, `rubric_accept_refused` |
| event | the `humanChannel` event gains `rubric: { rubricSha, checkpoint, outputSha, verdict, gaps }` on a `rubric.needs-accept` ask |
| types | `Rubric`, `Check`, `Decide`, `Claim`, `Gap`, `Fault`, `StepResult` (JSDoc typedefs; `LocateJudge` and `VerdictJudge` are NOT built, they ride with the PARKED judges) |
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
- **Bind-only decides, membership and `text` (RULED 2026-10-12, §4.6, #56-#59; BUILT: these are the cases the build passes, in `test/rubric-cited-decides.test.js`).** Every case also runs the falsify-by-revert of the source it exercises (reverting the membership compare must turn the wrong-price case green; reverting the whole-token boundary must turn the `MS79` case green; reverting the "anchor required exactly once" rule must turn the ambiguous-anchor case green). Hostile `values` (throwing getter, Proxy, `__proto__` key) stay red, never a throw.
  - Refusals at `createRubric`, each naming the path: a value decide without `op` carrying `value`, `lo` or `hi` (each of three); `op` WITH `value` is still fine; `{valueKind:"text", op:"lt"}`, and `text` with each of `value`, `lo`, `hi`, `currency`, `unit`; `text` with an `anchor` is fine; a blank / over-1000 `anchor` on `text` refused as today; `money` without `op` still needs at least one of `currency`/`unit` (#65); an op-less decide (and `text`) on a `judged` check refused. `rubricSha` changes when `op` is dropped or added, and when `valueKind` becomes `text`.
  - Bind-only, unanchored (membership): quote `Alaska 8:15 AM $389 Nonstop`, `{valueKind:"money", currency:"$"}`: `values {d0:"389"}` green; `{d0:"199"}` red `#0:d0:claim-value-mismatch:199!=389`; `{d0:"$389"}` / `{d0:"389 dollars"}` / a JSON number `claim-value-malformed`; no `values` `claim-value-missing`. Quote `Total: $389 (was $420)`: `"389"` green AND `"420"` green (membership, the documented limit), `"400"` red `claim-value-mismatch:400!=389,420`; `value-many` NEVER appears. Two-time row `8:15 AM – 9:47 AM`, `{valueKind:"time"}`: `"9:47 AM"`, `"09:47"`, `"8:15 AM"` green; `"10:00"` red `claim-value-mismatch:10:00!=08:15,09:47`; `"9:47 PM"` red (AM vs PM). A quote with 21 `$` values and a claim equal to none: the item lists exactly 20 and ends `,...(21 in all)`; a claim equal to the 21st (not listed) is GREEN (membership sees all values, only the DISPLAY is bounded; assert it). A quote with no `$` token = `#0:d0:value-none` (and no mismatch item); a quote with `$5USD` = `#0:d0:value-malformed`; `number` kind with `0.41.0` in the quote = `value-malformed` (unsure = red).
  - Bind-only, anchored: quote `Departure time: 8:15 AM. Arrival time: 9:47 AM.`, `{valueKind:"time", anchor:"Departure time:"}`: `"8:15 AM"` green; `"9:47 AM"` red `claim-value-mismatch:09:47!=08:15` (unanchored membership would have passed it: assert both, so the case proves the anchor narrows); anchor missing = `anchor-missing`, twice = `anchor-ambiguous`, anchor not followed by a value = `value-none`, each with NO binding item.
  - Condition decides unchanged (#57): the same two-time row with `{valueKind:"time", op:"lt", value:"12:00"}` and no anchor = red `#0:d0:value-many` (still, byte-for-byte); with an anchor = the one value; an op decide never gets membership (a claim value that is among the quote's values does not rescue `value-many`).
  - `text`, unanchored (presence): quote `EgyptAir MS791 USD 420`: `"MS791"` green, `"ms791"` green, `" MS791 "` green (trim), `"MS79"` red `#0:d0:claim-value-absent:MS79`, `"S791"` red, `"EgyptAir MS791"` green (a whole-token SEQUENCE), `"MS791 USD"` green, `"791"` red. Quote `## [0.41.0] - 2026-10-12`: `"0.41.0"` green, `"0.41"` red and `"41.0"` red (digit glue, #60), `"2026-10-12"` green. Digit glue (#60): `"3"` vs `Price 3.5 now` red, `"3.5"` green; `"1"` vs `1,234 seats` red, `"1,234"` green; `"5"` vs `costs 5.` green (dot then end) and vs `costs 5, then` green (comma then space); `"MS791"` vs `MS791.` green; `"v1"` vs `v1.2` red; anchored `Version:` on `Version: 0.41.0`: `"0.41"` red, `"0.41.0"` green. Quote `Alaska Airlines 8:15 AM`: `"alaska   airlines"` green, `"ALASKA"` green. Quote `Alaska 8:15 AM $389 Nonstop`: `"Delta"` red. Boundary grid at AND over every edge: match at quote start, at quote end, glued to a letter before, glued after, glued to a digit, glued to a non-ASCII letter (`éMS791`, `MS791é`), to a combining mark (`MS791` + U+0301), to `_` (`_MS791_` is green: `_` is a boundary), to punctuation (`(MS791)` green); an earlier glued occurrence followed by a later whole one = green; many whole occurrences = green. Claim value of 200 characters AT = proceeds, 201 = `claim-value-malformed`, `""`, `"   "`, a JSON number, `null`, an object = `claim-value-malformed`. Case-fold probe: `ß` vs `SS` stays absent (documented: `toLowerCase`, not full folding).
  - `text`, anchored: quote `Departure time: 8:15 AM. Arrival time: 9:47 AM.`, anchor `Departure time:`, `"8:15 AM"` green, `"8:15"` green (the next character is a space, a boundary; a prefix is accepted only at a boundary), `"8:1"` red, `"9:47 AM"` red `claim-value-absent` (present in the quote but not after the anchor); whitespace between anchor and value skipped; anything else between (`Departure time: about 8:15 AM`) = red absent; the anchor twice = `#0:d0:anchor-ambiguous` with NO absent item; anchor missing = `anchor-missing`. Real evidence fixture (bareloop POC round 2, 44 listitem blocks): `LAX` and `SFO` unanchored are green on 44/44 (assert the documented limit); `Departure time:` / `Arrival time:` anchored values are read 44/44 and a swapped pair is red on every block.
  - `until` (#61): quote `Leaves San Francisco International Airport at 9:27 AM`, `{valueKind:"text", anchor:"Leaves", until:" at"}`: `"San Francisco International Airport"` green, `"san francisco international airport"` green, `"San Francisco"` red `claim-value-mismatch:San Francisco!=San Francisco International Airport`, `"San Francisco International Airport at"` red mismatch; without `until` `"San Francisco"` is green (the documented limit); `until` absent after the anchor = `#0:d0:until-missing` (no mismatch item); an `until` only BEFORE the anchor = `until-missing`; the FIRST `until` after the anchor wins; empty field = `value-none`; `until` is case-sensitive; refusals naming the path: `until` without `anchor`, on `money` / `time` / presence, empty or blank `until`, over-1000, non-string.
  - Hyphen digit glue (#62): `"0.41.0"` vs `## [0.41.0-rc1]` red, `"0.41.0-rc1"` green, `"rc1"` vs `0.41.0-rc1` red, `"2026"` vs `2026-10-12` red, `"2026-10-12"` green, `"LAX"` vs `LAX-SFO` green, `"9:47 AM"` vs `8:15 AM – 9:47 AM` green, `"5"` vs `costs 5-` green; anchored `Version:` on `Version: 0.41.0-rc1`: `"0.41.0"` red.
  - Label word edges (#64): `City: Boston atlas Hotel at X`, anchor `City:`, until `" at"`: field `Boston atlas Hotel` (claim `Boston` red mismatch); `From: Joe attendant at Avon` green for `Joe attendant`; anchor `Leaves` vs `Leavesley Park X` = `anchor-missing` (text and time); `Leavesley Leaves 9:27 AM` finds the anchor once (not ambiguous); anchor `Total` vs `Totals: $5 Total $7` reads `$7`, `Total:` unchanged; `xTotal` skipped (start edge); until `at` skips `flat`; anchor `v1` vs `v1.2 v1 x` skips the glued first occurrence.
  - Distinct membership list (#63): a row with `09:27` x3 and `11:07` x3, claim `12:34` = `12:34!=09:27,11:07`; 25 distinct numbers each twice, claim `99` lists 20 and ends `,...(25 in all)`.
  - `d<j>` indexing (#59), asserted against `rubric.js`: `decides = [money value, time value, presence, time value]`: the claim keys are `d0`, `d1`, `d3`; `values.d2` is `claim-value-unknown`; `values.d3` binds the LAST decide; a claim with `d0`, `d1`, `d2` and no `d3` = `d3` `claim-value-missing` AND `d2` `claim-value-unknown`. A `text` decide at index 2 behind a presence at index 1 is keyed `d2`.
  - Mixed check: one `cited` check with an op decide, a bind-only decide, a `text` decide and a presence decide on one quote reports all reds together in decide order (decide reds, then binding reds in decide order, then unknown keys, then `numbers`); `decideQuote` still runs once per distinct normalized quote (spy) and the bind-only / `text` binding is evaluated per claim; no `decides` signed = byte-for-byte as before.
  - `rubricVocabulary` (both directions): `valueKind` enum lists `text`; `op` is `required:false`; the new conditions are present; every refusal above is read from the descriptor (mutating the descriptor in a test changes the refusal); generated descriptions match.
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
      red `value-malformed`. Neither `currency` nor `unit` signed on `money` (both signed together is allowed since RULED #65), and
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
    `op` / `currency` / `value` combinations (`between` with `value`, `lt` with `lo`, `money` with neither
    `currency` nor `unit`, `currency` on `date`, a non-string date bound, `2026-02-30` as a bound, `13:00 PM` as a
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
| BUILT, unreleased (RULED 2026-10-12 #56-#59, bareloop's "required facts"; #60-#64 amendments: digit glue, `until`, hyphen glue, distinct list, label word edges) | **bind-only decides + membership + the `text` value kind (with `until`) + the `d<j>` whole-list clarification (§4.6).** Built on `feat/cited-bind-text`; ships in the next release together with the Node >= 22 requirement; the version number is not fixed here |
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
43. RULED (hamr, 2026-10-12): MONEY `unit` (resolves open question 3). A `money` decide signs exactly one of `currency` or `unit` (XOR; both or neither is refused at `createRubric`; the XOR is REPLACED by #65: at least one). `unit` is a non-empty string (for example `"US dollars"`), matched exactly as signed (case-sensitive, no folding). With `unit`, a value is the `number` grammar run immediately before exactly one space plus the unit text (the unit not followed by an ASCII letter); still exactly one value, still anchorable with strict adjacency (anchor, then the number, then one space and the unit). Thousands separators work (`From 1,234 US dollars.` with anchor `From ` is 1234); trailing punctuation after the unit is fine; a number not followed by one space plus the unit is not a value of this decide (ignored, so `value-none` when no other match). Real example, bareloop's captured Google Flights link line: `From 59 US dollars. Nonstop flight with American. ...` with anchor `From `, `unit: "US dollars"`, `lt` 400 is 59 = green. E4 is rewritten around it; the symbol-currency decide on that line stays red `value-none`. `unit` joins the SemVer-surface additions (open question 2).
44. RULED (hamr, 2026-10-12): JUDGE-INTERNAL RETRY (bareloop 5b). The caller's judge function MAY retry internally (for example once on a transport failure or an HTTP 429) within `deadlineMs`. bareguard sees only the final answer or throw, counts it as one call, and still never retries a throw or a timeout itself (#19, #33 unchanged).
45. RULED (hamr, 2026-10-12): NON-GATING JUDGED CHECKPOINTS (bareloop 5a; clarifies #39, which already allowed them). A non-gating checkpoint may hold judged checks: it records `soft-green` or `red` and returns the gaps (red gaps drive the worker's fix loop; §6 "Non-gating checkpoints record and return gaps/faults but never deny") but never denies. Only a GATING checkpoint holding a judged check must be `requiresHuman`. A rubric may put its single human ACCEPT at the final gating checkpoint (`accept: "later"` + `gate.recordAccept`).
46. RULED (hamr, 2026-10-12): NAMES AND VOCABULARY DESCRIPTOR (settles open questions 4 and 6). The build settles the final names (`decides`, `valueKind`, `op`, `value`, `lo`, `hi`, `currency`, `unit`, `anchor`, `phrases`) and the `rubricVocabulary` list-of-objects descriptor for `decides` in code; the orchestrator reviews them. Open questions 1 and 2 stay open.
47. RULED (hamr, 2026-10-12): WHITESPACE IS COLLAPSED FIRST, and the Module 1 build calls are accepted. `normalizeForQuote` collapses whitespace on the locate decide exactly as everywhere else, so "exactly one space" in the 12-hour and money `unit` grammars means one space AFTER normalization: `9:27  AM` and `59  US dollars` read as `9:27 AM` and `59 US dollars`, not malformed / ignored. Also accepted: a value-many decide's own value list is `values` (`valuesTotal`) because `items` is the `d<i>` list; uppercase `AM`/`PM` with letters glued on (`AMX`, `AMD`, `AMERICAN`) is malformed while a mixed-case word (`American`) is a word and exactly-two-letter `am`/`Am` is malformed; a bare `:` run with no digit (`Total:`) is ignored while `9:27:` / `8:7` are malformed; `measured`/`limit` are canonical strings; `direction` `below`/`above` for `lt`/`gt`; the per-read outcome for `agree` is the overall result plus per-decide kind and canonical extracted value; anchor occurrences are counted overlapping with a 1000 cap.

**2026-10-12 (later; the pivot to `cited` + `decides`, from bareloop's POC, §5.2 "POC 2026-10-12")**


Status of #30-#47: kept as history. Live and shared with `cited`: #32 (exactly one value, anchor), #34 (12-hour time), #35 (presence decide), #36 (co-location: all decides on ONE quote), #37 (confirmed defaults), #43 (money `unit`; its XOR replaced by #65), #46 (names), #47 (whitespace and canonical forms). PARKED with the `locate` judge (design kept, not the next build): #30 and #31 as to the judge and `reads`, #33 (judge crash is `stopped`), #38 (`agree`), #39 (soft-green wiring), #40 (worst-case time), #44 (judge-internal retry), #45 (non-gating judged checkpoints). #31's "`verdict` judge comes next" is superseded by #50. #30's "build now the `locate` judge" is superseded by #48.

48. RULED (hamr, 2026-10-12): PIVOT. The next build is `cited` + `decides`, NOT the `locate` judge. The WORKER grounds its own claims (quote and values); bareguard verifies them deterministically against the signed frozen source. The result is a plain `green`: no soft-green, no ACCEPT requirement, no reads, because every step is deterministic. Reason: bareloop's POC (30 real calls) showed the judge quotes well but nothing binds its quote to the worker's claim (a flight not on the page was green three times). Supersedes #30's "build now the `locate` judge".
49. RULED (hamr, 2026-10-12): EXTEND `cited` (§4.6). A claim is `{claim, quote, values?}`; the check may sign `decides` (the same shapes and the same pure core as §5.2). Per claim: `quoteIn` -> `decideQuote` -> the TYPED BINDING -> `numbersInQuote` on the claim text. TYPED BINDING: for every VALUE decide the claim carries its value in `values` keyed to that decide, parsed with the same `valueKind` parser and compared for EXACT canonical equality with the value extracted from the quote (`09:27` = `9:27 AM`, `59` = `59.00`, `1,200` = `1200`, `9:27 PM` != `9:27 AM`). A missing value, an unparseable value or an unknown extra key is red. Presence decides need no claim value. Build choices made in the spec, for review (open questions 1-4): the key is the decide's index `d<j>`; a claim value is a bare string of one token of the kind; new gap reasons `claim-value-missing`, `claim-value-malformed`, `claim-value-mismatch`, `claim-value-unknown` under the unchanged gap kind `unsupported`.
50. RULED (hamr, 2026-10-12): PARKED, with the design text kept: the `locate` judge (the judge-call parts of §5.2), `reads`/`agree`, calibration and the `verdict` judge (jev, §5.1). Supersedes #31's ordering ("`verdict` judge comes right after").
51. RULED (hamr, 2026-10-12): "no numbers = red" is NOT ported to `cited`. A number-free claim (`nonstop`) is fine; a spec author adds a presence decide where the fact matters.
52. RULED (hamr, 2026-10-12): KEEP `numbersInQuote` on the claim's free text as well as the typed binding (keep both). Its semantics are unchanged; its known looseness and false reds (`09:27` vs `9:27 AM`, `59.00` vs `59`, `1,200` vs `1200`) are documented in §4.2, and the worker's fix loop handles format mismatches.
53. RULED (hamr, 2026-10-12): any future `locate` judge REQUIRES an output-binding claim that uses the typed binding of #49. This supersedes the earlier idea of binding with `numbersInQuote` plus "no numbers = red" (which the $0 re-run showed too loose).
54. RULED (hamr, 2026-10-12): BUILD ORDER. (1) `cited` + `decides` + typed binding, this build. (2) §5.3 mid-run registered pages: bareloop's flight job needs quotes checked against the arbiter's frozen copy of the exact snapshot the worker saw (F1: one url may have several snapshots with different sha256); design next, NOT built. (3) SUPERLATIVES ("cheapest", "earliest", "N best"): a new deterministic aggregate check over the frozen source: for every line matching a signed selector (for example presence phrases plus anchors) extract the anchored value, and the claim's value must be the minimum or maximum; the flight job's real ask is "cheapest nonstop in window"; design after step 2. (4) PARKED: the judge work of #50.
55. RULED (hamr, 2026-10-12): multi-source claims (one claim backed by two quotes from two sources) are Later; noted, not designed.

**2026-10-12 (bind-only decides and `text`; requested by bareloop for its "required facts" design, its PRD v1.96 RF1-RF11; BUILT, unreleased, ships in the next release together with Node >= 22)**

56. RULED (hamr, 2026-10-12): BIND-ONLY VALUE DECIDE. A value decide (`number`/`money`/`date`/`time`) may omit `op`; then it must not carry `value`/`lo`/`hi` (refused at `createRubric`, the error naming the path). `currency`/`unit`/`anchor` as today. It runs no condition (never `value-over` / `value-under`), only extraction and binding, and the claim MUST carry `values.d<j>` for it (missing = `claim-value-missing`, as for any value decide). WITH an anchor: extraction unchanged (the one value after the anchor; `anchor-missing` / `anchor-ambiguous` as today), then binding as today (`claim-value-mismatch` when the canonical values differ). WITHOUT an anchor = MEMBERSHIP: the claim's value must canonically equal ONE OF the quote's values of that kind; zero values of the kind = `value-none`; any malformed token of the kind = `value-malformed` (unsure = red, Law 1); a value not among them = `claim-value-mismatch` (the item shows the canonical claim value, and the quote's canonical values ride the reason the way `value-many` lists them: bounded to 20 with a total when cut); `value-many` never fires for an unanchored bind-only decide. Documented limit: membership cannot tell which field (depart vs arrive); the human sees it at Accept. Example (loop's): quote `Alaska 8:15 AM $389 Nonstop`, `{valueKind:"money", currency:"$"}`: `values {d0:"199"}` red `#0:d0:claim-value-mismatch:...`, `{d0:"389"}` green; two-time row `8:15 AM – 9:47 AM`, bind-only `time`: `"9:47 AM"` green, `"10:00"` red.
57. RULED (hamr, 2026-10-12): CONDITION DECIDES UNCHANGED. A value decide WITH `op` keeps ruling #32: exactly one value of the kind (or the one after the anchor), else `value-many` / `value-none`; a worker never chooses which value a condition reads (else it picks the passing one). A two-time row needs an anchor or a narrower quote.
58. RULED (hamr, 2026-10-12; boundary amended by #60 digit glue): `text` VALUE KIND (bind only). `{ valueKind: "text", anchor? }`. `op`, `value`, `lo`, `hi`, `currency`, `unit` are refused at `createRubric`. No extraction. The claim's `values.d<j>` is a non-empty string of at most 200 characters after normalization (longer / empty / non-string = `claim-value-malformed`). Normalization on both the claim value and the quote: trim, collapse whitespace runs to one space, case-insensitive compare (`toLowerCase()`, the fold the codebase already uses). WITHOUT an anchor = PRESENCE: the value appears in the quote as a whole-token sequence (the character before and after the match is not a Unicode letter or digit, or is the quote start/end); many occurrences are fine. WITH an anchor: the same anchor rules as value decides (the anchor occurs exactly once, else `anchor-missing` / `anchor-ambiguous`); the value must start right after the anchor with only whitespace between, and end on a whole-token boundary. Absent / not-after-anchor = the new red `claim-value-absent` (item `#<i>:d<j>:claim-value-absent`). No regex, no wildcards (decided: either can be added later without breaking anyone). Documented limit: without an anchor it cannot tell which field; real evidence (bareloop POC round 2, 44 Google Flights listitem blocks): `LAX` and `SFO` are each present in 44/44 blocks, so an unanchored "from SFO" passes on a wrong-way page, while `Departure time:` / `Arrival time:` anchors are 44/44, which is why the anchor is in v1. Examples: quote `EgyptAir MS791 USD 420`: `"MS791"` green, `"ms791"` green, `"MS79"` red `claim-value-absent`; `## [0.41.0] - 2026-10-12`: `"0.41.0"` green; `"Alaska Airlines"` matches `alaska   airlines`; `"Delta"` vs `Alaska 8:15 AM $389 Nonstop` red.
59. RULED (hamr, 2026-10-12): DOC CLARIFICATION. The `d<j>` key in `values` indexes the WHOLE `decides` list, presence decides included (a presence decide at index 2 makes the next value decide's key `d3`). Verified against `src/primitives/rubric.js` before writing (the value indexes are taken over the full list). Every place in the PRD and `bareguard.context.md` that implied `j` counts value decides only is fixed; the layout note is added to the examples (on bareloop's per-flight `listitem` blocks `unit: "US dollars"` is `value-many` because a button label repeats the amount while `currency: "$"` is 44/44; on one-line link rows it is the reverse).
60. RULED (hamr, 2026-10-12): DIGIT GLUE (amends #58's boundary). A `.` or `,` with a decimal digit (`\p{Nd}`) immediately on BOTH sides is NOT a boundary; it holds a number together. Applied at both ends of a match: the end is glued when the character after the match is `.`/`,`, the match's last character is a digit and the character after that mark is a digit; the start is glued when the character before the match is `.`/`,`, the match's first character is a digit and the character before that mark is a digit. Applies to unanchored presence and to the end boundary of anchored `text`. Everywhere else punctuation stays a boundary. Reason: versions and decimals; a claim `0.41` must not pass against `0.41.0`, nor `3` against `3.5`, nor `1` against `1,234`. O(1) per hit, no regex built from input. BUILT.

**2026-10-13 (bareloop's real POC: 44 Google Flights listitem blocks + 46 CHANGELOG headings; BUILT, unreleased)**

61. RULED (hamr, 2026-10-13): `until` END LABEL for anchored `text`. Optional `until` (non-empty string, the `anchor` field's limits), allowed only on a `text` decide that also signs `anchor` (otherwise refused at `createRubric` naming the path). Anchor rules unchanged; then the first `until` after the anchor's end (none = decide red `until-missing`, item `#<i>:d<j>:until-missing`); the field is the quote between them, trimmed; empty = `value-none`; the claim value must EQUAL the field case-insensitively, else `#<i>:d<j>:claim-value-mismatch:<claim>!=<field>` (both clipped 120). Without `until` anchored `text` keeps the prefix-ending-on-a-boundary read, documented: a whole-token prefix or an overlong run passes; sign `until` to close it. Build choice: `until` is whitespace-collapsed but not trimmed (an anchor is trimmed), so a signed `" at"` cannot match inside a word. BUILT.
62. RULED (hamr, 2026-10-13): HYPHEN DIGIT GLUE (extends #60). A `-` with a decimal digit (`\p{Nd}`) immediately before it and a letter or digit (`\p{L}`|`\p{Nd}`) immediately after it is not a boundary, at both match ends and for presence and the anchored end boundary. Unaffected: a letter before the `-` (`LAX-SFO`), an en dash, a space after the `-`, nothing after it (`costs 5-`). Reason: a wrong red is safer than a wrong green (Law 1). BUILT.
63. RULED (hamr, 2026-10-13): DEDUPE the membership mismatch list. The quote's canonical values in a membership `claim-value-mismatch` item are de-duplicated (first-occurrence order); the 20 bound and the `(N in all)` total count DISTINCT values. Doc-only alongside: lowercase `am`/`pm` and no-space `9:27AM` stay malformed (ruling #34), and `v0.41.0` does not match claim `0.41.0` (`v0` is one whole token). BUILT.
64. RULED (hamr, 2026-10-13): LABEL WORD EDGES. A signed `anchor` (any decide that takes one: value decides AND `text`) and a signed `until` match only where their word-character edges (`\p{L}\p{M}\p{Nd}`) sit on a token boundary: if the label's FIRST character is a word character, the quote character before the match must be a boundary or the quote start; if its LAST character is a word character, the character after the match must be a boundary or the quote end. Reuses `boundaryBefore` / `boundaryAfter` (so the #60 digit glue and #62 hyphen glue apply: this differs from a plain class check only for a label edge that is a digit next to a glued `.` `,` or `-`, e.g. anchor `v1` does not match in `v1.2`). A non-qualifying occurrence is SKIPPED: it does not count toward `anchor-ambiguous`, and for `until` the search continues to the next occurrence. Labels whose edge is punctuation or a space (`Total:`, a leading `" at"` space) are unaffected at that edge. Reason: `until:" at"` matched the start of `" attendant"` / `" atlas"` (quote `City: Boston atlas Hotel at X`, claim `Boston` was a false GREEN) and anchor `Leaves` matched inside `Leavesley`. Digit-glued anchors stay strict on purpose (hamr, 2026-10-13, unsure = red): signed anchor `From ` is trimmed to `From`, so quote `From59` is `anchor-missing` (it read `59` in 0.22.0), `From 59` is still ok, same for `Price12` / `Qty3`; sign the anchor against a page that puts a space or punctuation after the label. NOTE: this TIGHTENS released behavior for value-decide anchors (anchors on value decides shipped in 0.22.0; pre-1.0, a tightening ships in a minor/patch): the release CHANGELOG must list it under Changed. BUILT.
65. RULED (hamr, 2026-10-14): MONEY FORMS, replaces #43's XOR. (1) `currency` takes `"$"|"€"|"£"` or a list of them (1-3, unique); `unit` takes a string or a list of strings (1-10, unique, each non-blank, max 100 characters). A plain string behaves exactly as in 0.23.0. (2) A money decide signs AT LEAST ONE of `currency` / `unit` (both allowed; neither is refused at `createRubric`, naming `decides[j].currency`); both are still refused on any non-money `valueKind` and on `text`. (3) The decide's money values are every token matching ANY signed form, in quote order; each form keeps its 0.23.0 grammar unchanged (symbol glued `$43`; unit = number + exactly one space + exact unit, case-sensitive, not followed by an ASCII letter). Anchored: the anchor, then a value in any signed form, same strict adjacency. A malformed token of any signed form is `value-malformed`. A numeric run matched by two forms (`$43 US dollars`) is ONE token. (4) SAME AMOUNT = ONE PRICE (money only): an `op` decide, unanchored, with 2+ money tokens that ALL have the same canonical amount reads as ONE value (no `value-many`) and the condition runs on it; two different amounts are `value-many` as today (same `measured` / `values`). Bind-only membership: unchanged semantics over the union of forms. Other value kinds: unchanged (a repeated equal value is still `value-many`). (5) DOCTRINE: forms come from the real captured page, never model-imagined; a consumer (bareloop) drafts the rule, bareguard cannot see where a form came from and matches only what was signed. Real example (bareloop live run mv7qabx4, Google Flights): quote `From 43 US dollars. Nonstop flight with ...` with `{ valueKind: "money", currency: "$", unit: ["US dollars"], op: "lt", value: 450, anchor: "From" }` extracts 43, green. A block holding both `$43` and `43 US dollars` with an unanchored `currency: "$"`, `unit: "US dollars"`, `lt` 450 is green (one price); with `$43` and `44 US dollars` it is `value-many`. NOT in #65: a code BEFORE the number (`USD 43`, #37 stands; `43 USD` works as `unit: ["USD"]`). Known limits, documented not built: `US$43` and decimal-comma `43,50 €` are `value-malformed`. (NOTE, #68: the decimal-comma limit is lifted when the decide signs `decimal: ","`; `US$43` stays `value-malformed`, and a code before the number stays unread.) BEHAVIOR CHANGE: a single-form money `op` decide that was `value-many` only because the SAME amount repeated now passes. Specs refused before (both forms, or arrays) are now accepted. SemVer surface: the spec shape is widened. Hash: arrays hash in order, so reordering a `unit` list changes `rubricSha`.
66. RULED (hamr, 2026-10-18; spec agreed with bareloop, ask BG-2): EVIDENCE SPANS. `full.evidence` on the `checkStep` / `gate.checkStep` result gives, for every claim of every `cited` check that signs `decides`, the spans the check actually read in the normalized quote (`check`, `claim` index, `text`, `spans[{decide, role, start, end, canon?, matched?}]`, `spansTotal?`; roles anchor|value|currency|unit|until|phrase; bind-only membership marks the token(s) equal to the claim's own value with `matched`, per claim). Not in `gaps`, the audit line or the human ask event; no verdict change, no existing field changes, no new export. Bounds: 100 claims per check (`full.evidenceTotal`, one call-wide count, present only when cut), 50 spans per entry (`spansTotal`), `text` omitted over 4000 characters (always for `quote-too-long`). Amendments (hamr, 2026-10-19): every span comes from the read the check made (a symbol-form read records its own unit span); case-folded spans after or inside `İ` are mapped back, only an edge inside one `İ`'s expansion is omitted; (amendment 3) a malformed claim's entry is `{ check, claim, spans: [] }` with NO `text`, ever, and its raw quote is never read for evidence. Full text in §4.6 "Evidence spans". SemVer surface: `full.evidence` / `full.evidenceTotal` and the entry shape.

**Open questions after #55** (for hamr; what the rulings did not decide; each has a spec default in §4.6 that the build follows unless changed):
1. KEY SHAPE for `values`. Spec default: the decide's 0-based index `d<j>` (no new signed field, matches the gap items `d<j>:<kind>`, cannot collide; the cost is that reordering `decides` re-keys the claims, which is a re-sign anyway). Alternative: a signed per-decide `id` (safer against a reader mistaking positions, but adds a signed field, a uniqueness rule and a vocabulary entry to the decide shape shared with `judged`). RESOLVED (bareloop confirmed 2026-10-12): spec default.
2. CLAIM VALUE FORM. Spec default: a bare STRING holding exactly one token of the kind, no currency symbol or unit text (`"59"`, `"9:27 AM"`, `"2026-10-12"`), parsed by the same grammar, equality on the canonical form. Undecided inside it: whether a JSON NUMBER is accepted for `number`/`money` (spec default: malformed, a worker emitting `59` instead of `"59"` is red and fixes it); whether leading zeros (`"0059"`) are accepted (they are digits of the grammar and equal 59); whether `"$59"` or `"59 US dollars"` should be accepted and stripped of the decide's own symbol/unit (spec default: malformed). RESOLVED (bareloop confirmed 2026-10-12): spec default.
3. EXACT GAP NAMES. Spec default: the check's gap kind stays `unsupported`, with new item reasons `claim-value-missing`, `claim-value-malformed`, `claim-value-mismatch`, `claim-value-unknown`, `quote-too-long` and decide reds as `d<j>:<kind>`; item form `#<i>:d<j>:<reason>`, mismatch carries `:<claim>!=<quote>` canonical, unknown key is `#<i>:<key>:claim-value-unknown`. Alternative: promote the new reasons to the gap `kind` (first red wins, like a `locate` gap) and carry `measured`/`limit`/`anchor`/`direction` fields so the worker sees bounds without reading the spec. RESOLVED (bareloop confirmed 2026-10-12): spec default.
4. `values` on a claim of a `cited` check with NO `decides`. Spec default: red, every key is `claim-value-unknown` (never silently ignored). Alternative: ignore it, or refuse at `createRubric` any rubric whose spec cannot know (impossible: claims are output, not spec). RESOLVED (bareloop confirmed 2026-10-12): spec default.
5. `quote-too-long` (4000 normalized characters) applies to `cited` only when it signs `decides`, to keep today's `cited` byte-for-byte; the alternative is a bound for every `cited` check (tighter, but a behaviour change to a built rule). RESOLVED (bareloop confirmed 2026-10-12): spec default.
6. Mismatch evaluated when the decide is red on its OP but extracted a value (spec default: yes, so the worker sees both). Alternative: skip binding for a red decide. RESOLVED (bareloop confirmed 2026-10-12): spec default.
7. Whether a signed opt-out of `numbersInQuote` is wanted later for claim text that is prose; RULED #52 keeps it always on today.
8. How superlatives (step 3) and mid-run sources (step 2) extend the claim: `source` naming a registered label (step 2), and a claim naming the aggregate it answers (step 3). Not designed.

**2026-10-22 (fwdloop ask; RULED; built on feat/cells, unreleased)**

67. RULED (hamr, 2026-10-22), spec in [cells-prd.md](cells-prd.md) (the page carries the detail; built on feat/cells, unreleased, no version picked): a closed-`op` family of generic checks with ONE menu in `rubricVocabulary`, selected by `rule: "cells" | "table" | "diff"` (read with a claim / shape and row math / before-vs-after with a signed key). The whole op list ships on day 1, write-side included. Flow: the agent suggests checks from the vocabulary at draft time, the person signs, the step gives VALUES only, `checkStep` recomputes. LAW 11 ALLOWED for these rules (bareguard computes over caller-given typed rows; the caller owns file parsing), so number, date and blank parsing rules become SemVer surface. Defaults ruled: strict number grammar (sign, optional `$`/`€`/`£`, proper thousands groups; `1e3`, `12%`, `.5`, `0x10`, accounting parentheses red), blank = whitespace-only and skipped by aggregates, row-math blank operand red `empty-operand` unless `allowEmpty: true`, absolute 0.005 default tolerance for float ops (counts, row sets, days exact; signed `tolerance` overrides), `topN` `ties: "any"` default, exact text equals, `rows` claimed by 2-based row number, bad claim red vs broken check or table `stopped`. DATES: the signer picks a format per column from a closed list (never guessed). Added: per-row date mode and a `band` op (fwd's AR aging). POC done (226 synthetic pass; 8 of 9 of fwd's real claiming tries had the right values and failed only on fwdloop's own cite grammar). bareloop will also use it. OPEN: bareloop's "doc checks", the closed date-format list, the table size cap, the `groupTotals` claim shape.

**2026-10-27 (bareloop ask, saved real pages; RULED; spec only, unbuilt, target 0.27.0, confirmed)**

68. RULED (hamr, 2026-10-27; spec agreed with bareloop): PAGE FORMS, additive, spec in §5.2 "Page forms". (1) DATES: a `date` decide may sign `lang` (`en de fr es it pt nl`; ABSENT = ISO only, exactly as today, English forms are opt-in via `lang: "en"`) with built-in case-insensitive, accent-exact month tables (full names and common short forms, a short form may carry a `.`), or a signed `months` list of exactly 12 non-blank names (Jan..Dec) for any other language; `lang` and `months` are mutually exclusive (both = refused at `createRubric` naming `decides[j].months`). Forms read: day-month-year (`21 October 2026`, `13. Oktober 2026` with the day dot), `es`/`pt` `5 de octubre de 2026`, English month-day-year (`September 29, 2026`, `lang: "en"` only); ISO keeps working. RESOLVED by bareloop's page evidence: accents stay exact (no folding), the real short forms seen are English day + 3-letter month + year (`03 Jul 2025`), and the es/pt `de` rule is strict both-or-neither. Real calendar day. NOT read: missing year, ordinals (malformed when otherwise a full date shape), weekday prefixes (ignored text), another language's month names. bareguard never detects a language. The worker's claim value stays ISO `YYYY-MM-DD`. (2) DECIMAL COMMA: a `number` or `money` decide may sign `decimal: ","` (default `"."`), never guessed; thousands mark `.` or a single space, mirrored strictness (`1.234,99`, `12 832,99`); the claim value stays a canonical `.`-decimal string, and a claim value containing a `,` on such a decide is `claim-value-malformed`. (3) SYMBOL GLUED AFTER: `499€`, `699.00€`, `29,99€` read as the signed currency (also `$`, `£`), whole numbers included, no new signing field; a symbol on both sides (`$43$`) is `value-malformed`; one money decide MAY sign the same symbol in both boxes (`currency: "€"` and `unit: "€"`): glued `29,99€` is a currency token, spaced `29,99 €` a unit token, the same amount on one page is ONE price (#65 (4)), two different amounts are `value-many`. (4) HELD: a code before the number (`CHF 126.65`, `EUR 17.86`); #37 and #65 stand, `126.65 CHF` already reads as `unit`. (5) ERRORS: `lang`/`months` on a non-date decide, `decimal` on a non-number/money decide, an unknown `lang` and a bad `months` list are refused at `createRubric` via `fail(where, ...)`, `e.path` naming the exact field (for example `spec.checkpoints.a.checks[0].decides[0].lang`). (6) EVIDENCE (#66): a date token's `value` span is the whole token, a glued-after symbol gets a `currency` span after the number. (7) HASH: the fields hash as signed fields, absent = default, existing sha unchanged. `rubricVocabulary` lists `lang`, `months`, `decimal` with types and defaults. SemVer: minor 0.27.0 (confirmed by hamr), additive; every existing signed spec reads identically except `29.99€` now reads and `$43$` is now malformed (a tightening), named in §5.2. Lifts the decimal-comma limit of #65. SemVer surface: the three spec fields, the month tables, the grammar above.
69. RULED (hamr, 2026-10-28; spec agreed with fwdloop): `carriesAny`, an ANY-OF phrase rule on word edges. `{ id, rule: "carriesAny", field, phrases: [...], strict? }`. `mustCarry`, `carries()` and the presence decide `{ phrases }` (#35) are UNCHANGED, no signed spec changes, every existing `rubricSha` is unchanged. (1) GREEN when at least ONE signed phrase appears in the text field on WORD EDGES: the character before the match is the text start or not a word character (`\p{L}\p{M}\p{Nd}`), and the same for the character after. A plain class check: the #60 digit glue and #62 hyphen glue do NOT apply. `hang` does not match "change", "unchanged", "changing", "hanging"; it matches "hang-up", "(hang)", "HANG:"; `crash` does not match "crash2"; `ANR` matches "ANR,". Word forms are listed by the signer (no stemming). (2) CASE: case-insensitive by default (the `toLowerCase()` fold `mustCarry` uses); `strict: true` ALSO requires the exact case (never looser than forgiving). (3) MULTI-WORD: a single ASCII space inside a phrase matches any run of one or more whitespace characters in the field, newlines included; every other character matches exactly as signed (an inner hyphen in "hang-up" must be a hyphen). The phrase's first and last characters still need word edges ("not responding" does not match "not respondingly"). (4) RED when none is found: gap `{ kind: "none-found", phrases: [the signed list, bounded to 20, itemsTotal when cut] }` (the signed list rides unclipped, as `mustCarry`'s items do). A missing field stays `missing`, a non-string `wrong-type`, a hostile field `unreadable`, as every text rule (`textField`). WHY a new kind: `mustCarry`'s not-found gap is kind `missing`, the SAME kind as a missing field, so a consumer cannot tell "no keyword" from a broken field; the new kind is distinct and `mustCarry` keeps its released kind. (5) `renderGaps`: `none of these words appear in "body": "crash", "hang"` (the field name and each phrase `JSON.stringify`-escaped; ` and N more` when `itemsTotal` exceeds the phrases shown). (6) `createRubric` refuses, via `fail(where, ...)` with the exact `e.path` (for example `spec.checkpoints.a.checks[0].phrases[2]`): `phrases` must be a non-empty list of at most 50 non-blank strings, each at most 200 UTF-16 units; each phrase must START and END with a letter or digit; inside it, whitespace may only be single ASCII spaces (no tab, newline or double space); no duplicates after the case fold. (7) GREEN DETAIL: `full.matched` on the `checkStep` / `gate.checkStep` result, one entry per `carriesAny` check that was green: `{ check, phrases: [the signed phrases found, in signed order, at most 20], phrasesTotal? }` (`phrasesTotal` only when cut). A red check gets no entry; a green check gets one even when another check on the step is red. Like `full.evidence` (#66) the array is ALWAYS present (empty when no `carriesAny` check was green), NOT in `gaps`, the audit line or the humanChannel ask event; no verdict changes. (8) PERFORMANCE: linear-ish in field length times phrases; no regex is ever built from signed input (the module has a ReDoS history); the field size is whatever text rules accept today. (9) EVIDENCE (fwdloop POC F98, 2026-10-28, $0, 32 real flutter issues): a 12-word `mustCarry` list gave 10 false runs of 18 non-crash tickets, 3 of them only from substring hits (`hang` inside change/unchanged/changing); all-of semantics forced one rubric per keyword. SemVer surface: the rule name and its fields, the `none-found` gap kind and shape, the `renderGaps` sentence, `full.matched` and its entry shape. Additive; the version is not decided.
