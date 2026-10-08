---
type: log
title: "rubric — learnings: evidence, rationale and history"
status: active
---

# rubric — learnings

Evidence, rationale and history behind `docs/product/rubric-prd.md`. The PRD is specs only; every
"why" lives here, grouped by topic, each linked back to the PRD section it supports.
Nothing here is normative: if this file and the PRD disagree, the PRD wins.

Reference key: `F<n>` = bareloop `docs/logs/FINDINGS.md`; "fwd" = fwdloop live runs as reported by
the fwd session; "loop" = bareloop runtime as reported by the loop session; "guard" = the
bareguard session; "tree-ab" = the bareloop design session.

## L1. Sources

- **2026-10-06, design rounds (guard x tree-ab), four rounds.** Replaced the PRD's first draft
  (9a3996f). Every point left undecided was ruled by hamr the same day.
- **Live evidence** from fwd (fwdloop) and loop (bareloop runtime), quoted per topic below.
- **2026-10-07, fit check by fwd and loop** against the 2026-10-06 PRD, plus hamr's rulings of that
  day (forgiving defaults, `stopped`, liveness proof, borrowed shapes, `requiresHuman`,
  `blockLines`, `complete` sources, small fixes). See L8.

## L2. Boundary and the red-denies-done argument  (PRD §2)

- **Boundary change.** Old line: "bareguard never runs an LLM and never judges: you compute the
  fact." New: "bareguard never runs an LLM; it checks deterministic facts against declared,
  enumerated rules." RULED hamr 2026-10-06.
- **Red denies "done" (YES).** It narrows the stated law "a guess never drives a deny". Argument:
  denying an *advance* is not an action on the world; a false red costs a retry, a false green
  ships a wrong result. That is the cost asymmetry: so at a gating checkpoint any red denies the
  advance, deterministic or judge. Law 9 bounds it: it only ever adds a deny.
- **Part 1 §6 amendment (A).** Part 1 §6 said bareguard never constrains words the model produces,
  but shape checks (`maxWords`, `sections`) and `quoteIn` read output text. Rejected B (keep §6 and
  fence rubric behind a separate entry point): the same code with a fence of words.
- **Non-gating checkpoints never deny** because red-denies-advance applies to the close verdict,
  never to step exits (loop; F87, F212). PRD §6.

## L3. Evidence behind each law  (PRD §2 laws)

| Law | Evidence / reasoning |
|---|---|
| 1 Unsure = red | A missing field, wrong type, throwing getter, judge crash, malformed reply, timeout or unknown price must never read green. (The 2026-10-07 `stopped` verdict, L8, splits the instrument-failure half of this out of red.) |
| 2 Checks outside the agent | fwd and loop: the worker never sees its rubric; a retry gets only the gap. Enforced by construction (gap view, PRD §7). |
| 3 Derived from the signed rubric | F58: a separately written check drifted lenient. F183: check descriptions drifted from the checks, hence descriptions are generated from `rubricVocabulary`, never hand-written (PRD §9). |
| 4 Never widen at runtime | fwd. (The 2026-10-06 version said "exact headings are case-sensitive, `mustCarry` is exact" — built on a wrong relay, see L8-A. The law itself survives: nothing is widened at runtime to turn red green.) |
| 5 Typed fields, no user regex | fwd; F198: a gap parsed out of prose broke (a governor parsed gap prose). A signed user regex also brings ReDoS risk: bareguard's no-user-regex is the better line (L8-B). |
| 6 Text explains, never decides | Every check's `text` is the signer's words. |
| 7 Tamper = deny | F132: an unsigned or hash-mismatched rubric is refused at load. |
| 8 Decisive binary | Models hedge near a threshold; over-surfacing is fixed with stronger decisive buckets, never carve-outs (feedback_llm_decisive_verbs). A score instead of the verb is malformed. |
| 9 Floor is the ceiling | Axis A is the guard; a rubric is a deny-only addition to it. |

## L4. Checks: evidence per rule  (PRD §4)

- `maxWords`: fwd "633 words, limit 600". `sections`: bareloop item 33. `maxLines`, `sectionOrder`,
  `mustCarry`: fwd. `in`/`notIn`/`atMost`: OQ1 constraint operators (litectx).
- `max`/`min`: bareloop "total under $400".
- `notWorse`: loop's repeat live winner (F99, 67 -> 8 -> 1 -> 0; F198). `direction` is signed, never
  inferred (bareloop v1.82).
- `cited`: F161. `complete`: F155 (completeness existed only for the doc genre; an omitted item went
  unnoticed).
- `quoteIn`: F161 needed only whitespace and `**`/`__` forgiven (a judge dropped `**`); every
  further loosening (case-fold, NFC, list markers, single `*`/`_`) is a false-pass risk with no
  evidence. Substring, not line-wise, because a CV summary is one line.
- `numbersInQuote`: number words ("three") are deliberately unchecked, a documented gap. Thousands
  separators RULED not stripped (hamr 2026-10-06): `1,200` vs `1200` stays a false red, per Law 4.
- `notWorse` baseline (2026-10-06): A literal + B seed, C (baseline passed per call) rejected as an
  unsigned tamper path. The 2026-10-07 ruling replaced the "seed written into the rubric" meaning of
  B with a per-run measured, audit-frozen baseline (L8).
- `no-suppressions`: loop's other repeat winner (F87/F81/F99/F134: added `any`/casts/disables caught
  after the step was green). It is language-specific pattern matching over a diff, so on 2026-10-06
  the caller computed a count passed to `notWorse` baseline 0 (rejected B: a built-in rule with a
  signed pattern set). Superseded 2026-10-07 by `patternAbsent` (L8).
- Foundational vs opt-in (V2): a signed rubric cannot switch a foundational check off, tighten-only.
  A checkpoint whose legitimate output is "nothing found" must still return a declared non-empty
  shape: "empty because done" and "empty because it never ran" must not look the same.
- Rule sizes/caps: `quoteIn` source cap 5 MB (RULED hamr 2026-10-06), linear time.
- Drafting: a drafted line that maps to no owned rule is red at drafting, never bent onto the nearest
  rule (F159). A check contradicting its own goal line is red at drafting (fwd amendment 6, e.g.
  "under 600 words" with three "250ish" sections). `goal` is set by the machine from the signed
  text (fwd F50).

## L5. Judges: rationale  (PRD §5)

- **Why locate is the default.** bareguard's own A/B (quoted in bareloop `src/judged.js` header):
  "`judgeVerdict` is injectable, `judgeLocate` is not". A model asked "did it pass?" can be argued
  with; one asked "quote me the line" cannot.
- **Locate vs verdict as a deliberate split.** A locate judge's quotes feed a deterministic decide,
  so bareguard decides; a verdict judge decides itself, so its green is never green alone.
- **Quote rule (RULED 2026-10-06).** A classifier such as jev cannot quote, so a verdict judge's
  quote is optional; but it must return a decisive verb and its raw answer.
- **Call hygiene.** loop F148/F152/F154; about 1 in 6 haiku replies malformed. Deadline required, no
  default: missing = throw (programming error), at the gate unset = deny. F192's record kept neither
  the quote start nor its length nor a hash and the cause stayed unknown, hence the bounded record.
  Calibration history: never passed live (F159 1/10, F192 6/10).
- **Retry rule (2026-10-07).** A timeout is never retried: a retry doubles a stall and hides an
  outage. Only a malformed reply gets the one retry; haiku locate malformed about 1 in 6, one retry
  works (loop).
- **Repetition (`reads`).** Evidence is thin: two reads + agree is a draft only (bareloop PRD R6, no
  data); the one measured instability is the POC's `paramNames` drifting between reps on the same
  file (bareloop `src/judged.js` header). Compare decided outcomes, not raw quotes: two honest reads
  may quote different spans or drop a `**` (F161) and still decide the same; "right verdict, wrong
  reason is luck", so a red on `add` vs a red on `sub` is a disagreement. N identical replays of a
  cached response measure nothing, so independent calls.
- **Default `reads`.** 2026-10-06 ruling: 2 at gating checkpoints with a judge (smallest N that can
  disagree; doubles cents-level cost only where a wrong green would ship). SUPERSEDED 2026-10-07:
  `reads` is a signed per-rubric value, absent = 1, because changing `reads` changes what
  calibration certified.
- **Repetition vs calibration.** Different failures. Calibration = accuracy against known answers,
  once, before signing: catches a judge consistently wrong (N wrong reads agree). Repetition =
  stability on this live input, every run: catches a judge right on the set but flaky here. When
  calibration lands it should grade each case `reads` times and require all N correct.
- **Uncalibrated soft-green** is acceptable only because the final ACCEPT exists.
- **jev as verdict judge.** jev is a real, already-calibrated user (bareagent `calibrateJev`), so
  the verdict judge moved from Later to Next (hamr 2026-10-06). Structural only; adapter lives in
  bareagent (about 30 lines). `JevProvider` has no AbortSignal, hence the race for `deadlineMs`.
  Pinned model because a moving alias would let the cutoff that runs differ from the cutoff signed.
  bareguard's own calibration should borrow `calibrateJev`'s design (known-answer cases, injection
  battery, negative control that must fail).
- **F161 honest ceiling.** A quote existing does not mean it supports the claim; `quoteIn` +
  `numbersInQuote` cannot close that gap. Stated, not fixed.

## L6. Verdicts and exhaustion  (PRD §6)

- soft-green in bareloop terms mints, and what it withholds is learning credit, not "done" (loop).
- Soft-green with no ACCEPT moment fails closed (RULED 2026-10-06).
- `onExhausted` default `"fail"` (RULED 2026-10-06): terminal red; bareloop calls it `escalated` and
  the human still sees it at the end door. `"ask"` is for loops with no end door. The machine never
  adds an ask by default: fwd asks sit only at signed positions.
- `maxReds` reuses budget's countable resources. 2026-10-07: OFF unless set so it never fights a
  harness's own retry logic (fwd has its own ralph loop and cap-halt; bareloop its own strike ladder).
- Two governors once shared one name (cap-halt) in bareloop; hence every deny/governor rule gets a
  distinct name from day one.

## L7. Mechanics, Axis B and exports  (PRD §7-§9)

- Checkpoints: bareguard knows neither "close" nor "step"; bareloop maps close -> gating, step exits
  -> non-gating.
- `drainAnnotations` keeps its shape for SemVer. bareagent `judgeToAnnotation`
  (`src/bareguard-adapter.js:478`) is a live adopter of `annotate`; the envelope cannot change.
  bareloop does not call `annotate` (deliberately unwired, `src/kinds.js:1741`, because it never buys
  a verdict). litectx gates through `flags` (Axis A), not Axis B.
- Axis B cleanup: the trial-first dry-run lane was proposed and never built; hamr: will never happen.
  `harness-code-mode/` is archived as POC evidence (E1-E6), not deleted. D8 harness selection is a
  runner concern. OQ3 shipped 0.7.0 as Axis A budget.
- F190 (bareloop run `mu4hec9u`): calibration graded 0/10 because the judge provider was built without a `baseUrl`: a wiring bug, not judge skill. With F159 and F192, most live judge wrongness was wrong ruler or wrong wiring, not judge opinion.
- F192: raw judge facts were not kept. 2026-10-07: the full raw facts are the caller's to keep;
  bareguard records only the bounded form.

## L8. 2026-10-07 fit check by fwd and loop

### A. CORRECTION: fwdloop's heading rules

On 2026-10-06 a fwd session relayed that fwdloop's headings were "case-sensitive, left unwidened on
purpose". fwdloop's code (`src/closers.js`, `closeWordsAndSections`) is the opposite:

- case-INSENSITIVE (both sides lowercased);
- accepts a trailing `:`;
- accepts a bare line as a heading (a heading is a line that is only that text, optionally after `#`);
- strips a leading `#` run before counting words;
- `mustCarry` (in `closeLinesAndCarry`) is a case-insensitive substring.

The PRD's first strict defaults (case-sensitive ATX-only headings, markers counted in words, exact
`mustCarry`) were built on the wrong relay. Corrected 2026-10-07: forgiving default, strict opt-in
(PRD §4.1). Lesson: verify a peer's description of its code against the code.

### B. bareloop's pain list (do not copy)

- F212: an exception inside a measurement became an empty set, so a step could never pass or fail
  truthfully. -> `stopped` verdict; a measurement exception is never an empty set or a zero.
- F198: a governor parsed gap prose. -> structured gaps with stable keys.
- F155: completeness only for the doc genre. -> `complete` with a caller-supplied list.
- F159: judge rulebook doc-only, the real rubric gap. -> `rubricVocabulary`.
- F192: raw judge facts not kept. -> caller keeps the raw facts.
- F161: a quote existing is not the quote supporting the claim (honest ceiling).
- The broken-ruler bug, bareloop's most dangerous class: a crashed counter reading 0 = fake green.
  Run `mslsnnzk`: `tsc` exit 2, 67 real lines filtered out by scope, count read 0. Liveness must be
  read BEFORE scope. -> liveness proof with `matchedPreScope`.
- Symlink / lexical scope fake-greens: resolve physically (bareguard's fs scopes already do).
- A signed user regex brought ReDoS risk: bareguard's no-user-regex is the better line.
- F183: check descriptions drifted from checks -> generate them from the catalogue.
- Two governors once shared one name (cap-halt) -> distinct names from day one.
- haiku locate malformed about 1 in 6; one retry works.
- Tools that spell "none found" as a non-zero exit (`grep -c` -> 1, `pytest` -> 5) false-stop unless
  declared -> signed `noneExit`, never a softened default.

Real code consulted for the borrowed shapes: bareloop `src/kinds.js` `runCommandExit` (green iff
exit equals `expectExit`, gap = exit + expected + output lines), `runCountNotWorse` (parser
normalised, baseline measured per run), `runPatternAbsentInDiff` (scope resolved physically),
`runFilesChanged` (`allowPrefixes` resolved on both sides physically on a lexical miss). bareguard
takes the comparison only; the caller measures.

### C. What each consumer will use (fit check)

- **fwd (fwdloop):** adopt Day 1 with changes. Deletes its own `closeWordsAndSections` /
  `closeLinesAndCarry` / `SHAPE_KEYS` checks once matched. No judge needed. Keeps typed `done:false`,
  frozen inputs, ralph loop + cap-halt, `validateDeclaration`/amendment 6, ask machinery unless
  `requiresHuman` lands. Never wants `onExhausted: "ask"`.
- **loop (bareloop runtime):** NEED NOW `quoteIn` + `numbersInQuote` (bareloop M5 citation rule) and
  `complete` with a caller-supplied list. LATER the locate judge and maybe `reads`/`agree`. WON'T
  USE now the jev verdict judge, soft-green/ACCEPT (keeps its own end door and quarantine-from-credit)
  or `rubricVocabulary`. Keeps its own close stages, strike ladder, `escalated`, cap-halt.

### D. hamr's framing ruling (2026-10-07)

bareguard builds for harnesses that have NOTHING yet. bareloop and fwdloop are evidence sources, not
targets to switch over; proven shapes from them are made available as general pieces. Deliberately
NOT taken (they stay in the harness): retry loops and spend caps, typed `done:false`, bareloop's end
door and quarantine, per-run re-signing, "no-improvement" strike counting.

### E. Why each 2026-10-07 ruling

- **`stopped`.** A broken instrument is not a failing piece of work; a worker cannot fix a broken
  ruler, so it gets no gap and the count of reds is not charged (F212; the broken-ruler bug).
- **Liveness proof.** Exit code alone is not enough: a tool that exits non-zero having matched
  nothing is "crashed: unknown, not zero".
- **Seed baseline.** The counting rule is signed, never a number; the number is measured per run at
  a named anchor and frozen in the audit so a second, different baseline for the same run is tamper.
- **`requiresHuman`.** For harnesses without an end door; the ask sits at a signed position so it is
  never a surprise ask (fwd: asks only at signed positions). `outputSha` = sha256 of artifact bytes
  matches fwdloop's accept/send `artifactSha256`.
- **`complete` sources.** Never the judge's own list: a judge that lists its own items marks its own
  homework. No sentence splitter: splitting is language-specific parsing the caller owns.
- **Stable gap `key`.** So harnesses can compare gaps across tries without parsing text (F198).
- **Audit-rebuilt state.** A resume must not reset a red count or forget a frozen baseline; same
  rule as the budget.
- **Estimated pricing = priced.** Only an unpriced round has no cost to account.

### F. fwd spec sign-off (2026-10-08)

fwd signed off the spec on 2026-10-08 with five asks, all RULED by hamr (PRD §12, 2026-10-08):
`sectionOrder` keeps checking later names after a missing one; exported deterministic `renderGaps`
so harnesses can detect "stuck" on the render; `blockLines` requires both `size` and `mustCarry`;
bounds (counts integers >= 1 no max, non-empty string lists of non-empty strings, no
whitespace-only strings); `outputSha` = sha256 of exactly the checked bytes. fwdloop's ordered
"sections" maps to `sectionOrder`.

### G. Module 1 build findings and the fwd / loop answers (2026-10-08)

Module 1 (the pure core, `src/primitives/rubric.js`) surfaced nine questions; fwd and loop agreed
and hamr RULED all nine (PRD §12, 2026-10-08 #6-#13).

- **Strict could LOOSEN.** The first build counted markers under strict for both word rules, so
  `minWords` strict passed `## Summary` at 2 where forgiving said 1 (the 2026-10-06 strict word rule
  versus the "strict only tightens" law). Ruled: strict `maxWords` counts markers, strict `minWords`
  counts like forgiving. The proof is a generated corpus (forgiving red implies strict red, every
  strict-capable rule), not a reading of the rule.
- **Headings and the "forgiving also matches" conjunction.** Strict headings now take the exact rest
  of the line (`# Summary ##` is `Summary ##`, `## C#` is `C#`). The hand-coded parse stays linear
  (the old regex's lazy capture before ` *#*$` backtracks quadratically). Two further loosenings
  were found by the generated test and closed by making a strict match also require the forgiving
  match: a name ending in `:` (strict kept the colon, forgiving strips it), and case folding that is
  not substring-preserving (final-sigma: `"Σ"` is a strict substring of `"ΑΣ"` but its lowercase is
  not a substring of the lowercased text). Consequence: a name ending in `:` matches in neither mode.
- **`text` meant two things.** On `mustCarry`/`blockLines` it was the phrase, everywhere else the
  signer's explanation (Law 6). Renamed the phrase field to `phrases` (a list on both); `text` is
  now only the explanation, optional, never decides.
- **Object outputs could not be bound.** bareguard never serializes an object, so an object output
  had `outputSha` null and no way to match fwdloop's accept/send hash. Ruled: `opts.outputBytes`
  (string or bytes) is hashed exactly, for any output type; with none, an object stays unbound and
  Module 2's gate denies it. fwdloop serialises as `JSON.stringify(artifact, null, 2)`; a test pins
  our sha256 of those bytes to a hand-computed one.
- **Kept as built:** `opts.inputs[name]` with a sha256 check for `cited` (mismatch = stopped); a plain
  string is the field `text`; `baselines` out / `priorBaselines` in with `baseline-conflict`;
  stopped > red > green with the worker's gaps empty.
- **`noneExit` on `commandExit` was a trap** (no match count, so it did nothing); now refused.
- **Fake-green hole (from loop).** `cited` with zero claims on a non-empty output was vacuously
  green, so a worker could pass by citing nothing. Now red `no-claims`, independent of `complete`.

## L9. Superseded 2026-10-06 entries (history)

| 2026-10-06 ruling | Superseded by (2026-10-07) |
|---|---|
| Strict word rule: markers counted, split on `/\s+/` of the raw text | Forgiving words rule, strict opt-in |
| Headings ATX-only, case-sensitive, exact | Forgiving headings, strict opt-in |
| `mustCarry` exact | Case-insensitive substring default, strict opt-in |
| `no-suppressions` = caller count -> `notWorse` baseline 0 | `patternAbsent` (baseline 0 stays allowed) |
| `notWorse` baseline "seed" written into the signed rubric | "seed" = signed rule, per-run measured, audit-frozen baseline |
| `judge.reads` default 2 at gating checkpoints | signed per-rubric, absent = 1 |
| One retry on malformed reply **or timeout** | timeouts never retried |
| Three verdicts | four verdicts (`stopped`) |
| Unsure = red for every cause | instrument failure = `stopped` |
