---
type: product
title: "Rubric rules: what each one checks"
status: reference
---

# Rubric rules: what each one checks

One page, every rubric rule: what it checks, its key fields, a tiny example, and what makes it red or stopped. Short on purpose.

- Exact field shapes, bounds and defaults: `rubricVocabulary` (frozen export; generate from it, don't hand-copy).
- Full contract: [rubric-prd.md](rubric-prd.md) (laws, §4 check shapes, §7 gaps). The table rules: [cells-prd.md](cells-prd.md).
- Every check also has `id` (unique in its checkpoint) and optional `text` (the signer's note; never decides). Examples below omit `text`.
- **red** = the output failed the check (the worker gets the gap). **stopped** = the instrument failed (the runner gets a `fault`; the worker gets nothing; not counted as a red).
- Signed phrases, section names and `in`/`notIn` values are never clipped in a gap.

## Always on

### `happened`
The output exists: a non-empty string, or an object with at least one own key. Not listed in a spec; it always runs and cannot be switched off.
- Red (gap `kind`): `empty`, `wrong-type` (not a string or object), `unreadable`. It short-circuits: when it is red, no other check runs.

## Size

### `nonEmpty`
A named field has content (non-blank string, non-empty array, object with a key).
- Fields: `field`.
- Example: `{ id: "has-title", rule: "nonEmpty", field: "title" }`
- Red: `missing`, `unreadable`, `empty`, `wrong-type`.

### `maxWords` / `minWords`
The field's word count is at most / at least `value`. A leading `#` run is not a word unless `strict: true`.
- Fields: `field`, `value`, `strict?`.
- Example: `{ id: "short", rule: "maxWords", field: "text", value: 120 }`
- Red: `over` (max) / `under` (min), with `measured` and `limit`; also `missing`, `unreadable`, `wrong-type`.

### `maxLines`
Non-empty line count is at most `value`.
- Fields: `field`, `value`.
- Example: `{ id: "brief", rule: "maxLines", field: "text", value: 10 }`
- Red: `over`; also `missing`, `unreadable`, `wrong-type`.

### `listItems`
The field holds EXACTLY `value` outer list items (ruling #73; a fwdloop ask). No `strict`.
- Fields: `field`, `value`.
- Item line: the text is split into lines, each line trimmed at both ends. It is an item when it starts with `-`, `*`, `+` or `•`, then one or more spaces or tabs, then non-empty text; or with ASCII digits, then `.` or `)`, then one or more spaces or tabs, then non-empty text (the same ordered shape the forgiving heading match accepts). Not items: plain lines, `**bold**`, `---`, `***`, `-x`, a lone `-`, `1.5 x`, `1.Work`, `2024 results`, `1.`, `a) X`. Bullet and number marks count alike.
- Outer: indent is the number of leading characters JS `trimStart` removes (space, tab and NBSP each count 1; tabs are not expanded). The outer items are the item lines whose indent equals the smallest indent among all item lines; a line that is not an item never sets that indent. So `"\t- a\n  - b"` is 1 (indent 1 is smaller than 2), deterministic but mixed tab/space lists are best avoided. `1. Job\n   - detail` is 1.
- Limits: it reads lines, not markdown. A list-marker line inside a ``` fence counts as an item (`"- a\n- b\n- c\n```\n- d\n```"` with `value: 3` is red `over`, `measured: 4`); a block-quote line (`> - a`) is not an item. `value` is an integer >= 1, so "exactly 0 items" cannot be signed (`createRubric` throws). Only a space or tab may follow the mark: a no-break space (U+00A0) after it (common in lists pasted from Word or the web) makes the line not an item. Lines break on `\n` and `\r\n` only; a lone `\r` (also U+2028, U+000B) is not a line break, so `"- a\r- b\r- c"` is one line and `measured` is 1.
- Example: `{ id: "jobs", rule: "listItems", field: "text", value: 3 }`
- Red: `under` (`measured` < `limit`, `direction: "at-least"`) and `over` (`measured` > `limit`, `direction: "at-most"`); 0 items is `under` with `measured: 0`. A missing, unreadable or non-string field is `missing`, `unreadable`, `wrong-type` with `limit` only and NO `direction` (an exact count is neither bound).
- Cost: one pass over the lines; each line is trimmed once and examined by a fixed-length look at its start. No regex on the text and no rescan, so the work grows in proportion to the field length.

### `maxParagraphs`
The field has at most `value` paragraphs (ruling #77; a bareloop ask). No `strict`.
- Fields: `field`, `value` (integer >= 1).
- A line is blank when `trim() === ""` (NBSP and other Unicode whitespace count as blank). A paragraph is a maximal run of non-blank lines, so a heading attached to text is one paragraph and a heading, a blank line, then text is two. Leading, trailing and repeated blank lines add nothing; an empty string is 0. Lines break on `\n` and `\r\n` only; a lone `\r` is not a line break, so `"a\r\rb"` is one paragraph.
- Example: `{ id: "short", rule: "maxParagraphs", field: "text", value: 3 }`
- Red: `over` (`measured`, `limit`, `direction: "at-most"`); also `missing`, `unreadable`, `wrong-type`.
- Cost: one pass over the lines.

### `maxLineWords`
No non-blank line holds more than `value` words (ruling #78; a bareloop ask). No `strict`.
- Fields: `field`, `value` (integer >= 1).
- Words are counted per line as `maxWords` counts them by default (a leading `#` run is not a word), except that ONE leading list marker is not a word either: a bullet (`-`, `*`, `+`, `•` then a space or tab) or an ordered marker (`1.` or `1)` then a space or tab), the same item shape `listItems` uses. Only one marker is removed; `-x` is not a marker. The order is: strip one marker at the line start, then read the rest as a line start, so a `#` run after the marker is not a word either (`- ## a b` = 2, `1. # a` = 1, `## a b` = 2). A marker after a `#` run is not at the line start and stays a word (`## - a b` = 3). Lines break on `\n` and `\r\n` only; a lone `\r` joins lines (`"a b\r\rc d e"` is one line of 5 words).
- Example: `{ id: "tight", rule: "maxLineWords", field: "text", value: 20 }`
- Red: `over` (`measured` = the worst line's word count, `limit`, `direction: "at-most"`). The gap holds no line text. Also `missing`, `unreadable`, `wrong-type`.
- Cost: one pass over the lines.

## Shape

### `sections`
Every named heading is present (case-insensitive, trailing `:` and one list marker forgiven unless `strict`).
- Fields: `field`, `names`, `strict?`.
- Example: `{ id: "heads", rule: "sections", field: "text", names: ["Summary", "Risks"] }`
- Red: `missing` (items = the absent names); `no-headings` (strict only, no heading found).

### `sectionOrder`
Same headings, and they must appear in the listed order.
- Fields: `field`, `names`, `strict?`.
- Example: `{ id: "order", rule: "sectionOrder", field: "text", names: ["Summary", "Risks"] }`
- Red: `missing`, `out-of-order`, or both joined as `missing,out-of-order`; `no-headings` (strict only).

### `sectionWords`
Each listed section's own word count is within about +-20% of `wordsPerSection` (`ceil(N*0.8)` to `floor(N*1.2)`). A section not found is not measured: pair with `sectionOrder`.
- Fields: `field`, `names`, `wordsPerSection`.
- Example: `{ id: "balanced", rule: "sectionWords", field: "text", names: ["Summary", "Risks"], wordsPerSection: 50 }`
- Red: one `section-words` gap per bad section (`section`, `words`, `asked`, `lo`, `hi`; up to 20, `itemsTotal` has the true count).

### `allowedKeys`
An object output has no own key outside the signed list (a string output is the one key `text`).
- Fields: `keys`.
- Example: `{ id: "keys", rule: "allowedKeys", keys: ["text"] }`
- Red: `extra-keys` (`keys` = the extras, `allowed` = the signed list); `unreadable`.

## Words

### `mustCarry`
Every listed phrase appears in the field (case-insensitive substring; `strict` also requires exact case).
- Fields: `field`, `phrases`, `strict?`.
- Example: `{ id: "carry", rule: "mustCarry", field: "text", phrases: ["rollback plan"] }`
- Red: `missing` (items = the absent phrases).

### `carriesAny`
At least ONE listed phrase appears in the field on word edges (any-of; `mustCarry` is all-of).
- Fields: `field`, `phrases`, `strict?`.
- Match: the character before and after the match is the text edge or not a letter, mark or digit (no digit or hyphen glue, no stemming: `hang` misses "hanging" and "change", hits "hang-up", "(hang)", "HANG:"). Case-insensitive; `strict` also requires the exact case. A single space in a phrase matches any run of whitespace, newlines included; every other character is exact.
- Phrases: 1 to 50, each at most 200 characters, starting and ending with a letter or digit, whitespace only as single ASCII spaces, no duplicates after the case fold. Else `createRubric` refuses with `e.path` at `phrases` or `phrases[i]`.
- Example: `{ id: "crash", rule: "carriesAny", field: "body", phrases: ["crash", "hang", "not responding"] }`
- Red: `none-found` (`phrases` = the signed list, up to 20, `itemsTotal` when cut; `renderGaps` says `none of these words appear in "body": "crash", "hang"`); a missing, non-string or unreadable field stays `missing`, `wrong-type`, `unreadable`.
- Green detail: `full.matched` on the step result, one `{ check, phrases, phrasesTotal? }` per green `carriesAny` check (phrases found, signed order, up to 20). Not in the gaps, the audit line or the humanChannel ask.
- Cost (ruling #69 amendment 3): no work cap and no `too-many` gap. The field is lowered and its whitespace runs collapsed once, then each phrase is searched by KMP (the text is never re-read), so the work is about (2 normalizations + 2 x phrases) x field length: linear, growing in proportion to field length x number of phrases, for any input, with no superlinear case. Strict re-scans the raw text for phrases the forgiving pass found, so it can take up to about twice as long when phrases are found. Each candidate match whose edge characters are non-ASCII (e.g. `İ`, accented letters) costs more to check than an ASCII edge. `full.matched` is always complete (every signed phrase found, signed order). Bounding the field (output) size is the harness's job, because `gate.checkStep` holds the gate's ordering lock while it runs.

### `carriesNone`
NO listed phrase appears in the field on word edges (the inverse of `carriesAny`; ruling #76, a bareloop ask).
- Fields: `field`, `phrases`, `strict?`.
- Match, phrase rules, case handling and cost are exactly `carriesAny`'s (same code): word edges, case-insensitive unless `strict`, single spaces match any whitespace run, 1 to 50 phrases, linear with no work cap.
- Example: `{ id: "no-crash", rule: "carriesNone", field: "body", phrases: ["crash", "hang"] }`
- Red: `present` (`measured` = phrases found, `limit: 0`, `items` = the found signed phrases in signed order, never clipped, up to 20, `itemsTotal` when cut); a missing, non-string or unreadable field stays `missing`, `wrong-type`, `unreadable`. No `full.matched` entry.

### `blockLines`
Non-empty lines are grouped in blocks of `size`; every listed phrase must appear in each block.
- Fields: `field`, `size`, `phrases`, `strict?`.
- Example: `{ id: "blocks", rule: "blockLines", field: "text", size: 3, phrases: ["From", "To"] }`
- Red: `zero-lines`, `not-multiple` (line count not divisible by `size`), `block-missing` (items like `block 2:To`); the last two can be joined.

### `in` / `notIn`
A string field equals one of / none of the signed `values` (exact `===`, case-sensitive). The optional boolean `ignoreCase: true` compares `toLowerCase()` of the field with `toLowerCase()` of each value instead: still a whole-value match (no trim, no Unicode normalisation, no punctuation stripping, so "Approved." never matches "approved"). With it, signed values equal after the fold make `createRubric` refuse; a non-boolean value is refused. Absent or `false` changes nothing, including the `rubricSha`. Gaps show the field and signed values as written.
- Fields: `field`, `values`, `ignoreCase?`.
- Example: `{ id: "status", rule: "in", field: "status", values: ["done", "blocked"] }`; case-insensitive: `{ id: "ok", rule: "in", field: "firstLine", values: ["approved."], ignoreCase: true }`
- Red: `not-in` (`in`) / `forbidden` (`notIn`); also `missing`, `unreadable`, `wrong-type`.

### `atMost`
A string field ranks at or below the signed `value` in the ordered list `order` (an ordered enum, e.g. severity).
- Fields: `field`, `value` (must be in `order`), `order` (no duplicates).
- Example: `{ id: "sev", rule: "atMost", field: "severity", value: "medium", order: ["low", "medium", "high"] }`
- Red: `over`, `unknown` (the field's value is not in `order`); also `missing`, `unreadable`, `wrong-type`.

## Format

### `jsonValid`
The string field is valid JSON (ruling #75; a bareloop ask). No `strict`.
- Fields: `field`.
- Green when `JSON.parse` accepts the whole string: any JSON value, so `1`, `"x"`, `null`, arrays and objects all pass; surrounding whitespace is fine. It checks syntax only, not shape.
- Example: `{ id: "reply", rule: "jsonValid", field: "text" }`
- Red: `not-json` when `JSON.parse` throws (bad syntax, an empty string, trailing text). There is no depth cap of its own: deeply nested valid JSON is green. The gap carries NO field text. A missing, unreadable or non-string field is `missing`, `unreadable`, `wrong-type`.
- Cost: one native `JSON.parse` pass.

## Numbers

### `max` / `min`
A number field is at most / at least `value` (finite numbers only).
- Fields: `field`, `value`.
- Example: `{ id: "cost", rule: "max", field: "cost", value: 5 }`
- Red: `over` (max) / `under` (min); `not-finite-number`; also `missing`, `unreadable`.

## Proof

### `cited`
Each claim `{ claim, quote, values? }` in the `claims` field has its `quote` found verbatim in a frozen input, and the claim's numbers appear in that quote. With `decides`, the quote must also satisfy each signed decide (number, money, date, time, text, or a phrase list) and the claim's typed `values.d<j>` must match what is extracted from the quote. Zero claims is red.
- Fields: `claims`, `source` (a signed input name), `decides?` (1-10).
- Example: `{ id: "grounded", rule: "cited", claims: "claims", source: "page" }`
- Red: `no-claims`, `unsupported` (items are per claim: `#0:malformed`, `#0:empty-quote`, `#0:quote-not-found`, `#0:quote-too-long`, `#0:numbers:<n>`, `#0:d<j>:<kind>`, kinds include `phrase-missing:<phrase>` and `none-found`), `too-many` (quote work cap), plus `missing`, `unreadable`, `wrong-type`.
- Stopped: `missing-measurement` (the input is absent or does not match its signed sha256).
- Presence decide `{ phrases, any?, edges? }`: by default every phrase must be in the quote (substring, case-insensitive; red `#<i>:d<j>:phrase-missing:<phrase>`). `any: true` = at least one (red `#<i>:d<j>:none-found`, no phrase in the item). `edges: true` = match each phrase on word edges like `carriesAny` (`Changed` is not in `unchanged`; a phrase then follows `carriesAny`'s phrase rules at `createRubric`). Both are booleans, optional, independent; a green any-of gives a `phrase` evidence span for each found phrase.

### `complete`
Every item of a list is covered by a claim whose `item` equals it. The list is signed (`items`) or caller-supplied (`itemsFrom: "caller"`); exactly one.
- Fields: `claims`, `items?` or `itemsFrom?`.
- Example: `{ id: "all-legs", rule: "complete", claims: "claims", items: ["leg-1", "leg-2"] }`
- Red: `uncovered` (items = the missing ones); plus `missing`, `unreadable`, `wrong-type`.
- Stopped: `missing-measurement` (caller list missing or empty).

## Tables

You pass the table rows to `checkStep` (`opts.tables[name]`, shape `{ header, rows: [{ rowNumber, cells }] }`); bareguard never parses files. Each table name must be signed in the spec's `inputs` with its `tableSha`. Cell numbers and dates are read by a strict, closed grammar; dates need a signed `dateFormats` per column. Full contract: [cells-prd.md](cells-prd.md).

Common fields: `table`, `column`, `range` (`{ from, to }`, row numbers), `where` (1-20 conditions, all must hold), `tolerance` (float ops; default 0.005), `dateFormats`, `allowEmpty`.

- Stopped, all three rules: `table-invalid` (table missing or malformed), `check-invalid` (unknown column or row, or a field that cannot apply), `exception`.
- Red when the table is the problem: `unreadable-cell`, `empty-operand`, `result-empty`, `div-zero`, `no-values`, `no-band`, `value-overflow`, `key-not-unique`, `lookup-not-unique`, `lookup-unreadable`, `fewer-than-n`, `no-rows-checked`, `table-too-large`. Table gaps are listed first.
- Gaps never carry cell text (rows, `row:Column` cells and column names only).

### `cells`: the step claims a value, bareguard recomputes it
Fields: `table`, `claim` (the output field holding the claim object), `op`, plus the op's fields. Example: `{ id: "big", rule: "cells", table: "t", claim: "answer", op: "countIf", where: [{ column: "Amount", cmp: "gt", value: 100 }] }` with output `{ answer: { value: 2 } }`.

Red from the claim: `claim-missing`, `claim-malformed`, `claim-unreadable`, `claim-too-large`, then the op's mismatch kind below.

| Op | Checks (claim shape) | Mismatch gap |
|---|---|---|
| `count` | non-blank cells of a column (`{ value }`) | `value-mismatch` |
| `countEmpty` | blank cells of a column (`{ value }`) | `value-mismatch` |
| `countIf` | rows matching `where` (`{ value }`) | `value-mismatch` |
| `sum` | sum of a column, blanks skipped (`{ value }`) | `value-mismatch` |
| `sumIf` | sum over rows matching `where` (`{ value }`) | `value-mismatch` |
| `average` | mean of a column (`{ value }`) | `value-mismatch`, `no-values` |
| `averageIf` | mean over rows matching `where` (`{ value }`) | `value-mismatch`, `no-values` |
| `median` | median of a column (`{ value }`) | `value-mismatch`, `no-values` |
| `min` | smallest number in a column (`{ value }`) | `value-mismatch`, `no-values` |
| `max` | largest number in a column (`{ value }`) | `value-mismatch`, `no-values` |
| `found` | a needle is (or is not) a cell of a column (`{ value: boolean }`) | `value-mismatch` |
| `lookup` | the cell on the one row whose key column equals `keyValue` (`{ value }`) | `value-mismatch`, `lookup-not-unique` |
| `rows` | the claimed rows (or keys) equal the matching rows (`{ rows }` or `{ keys }`) | `rows-missing`, `rows-extra`, `rows-duplicated`, `keys-extra` |
| `topN` | the n largest or smallest rows or values (`{ rows }` or `{ values }`) | `rows-missing`, `rows-extra`, `rows-duplicated`, `tied-rows-missing`, `topn-values-mismatch`, `fewer-than-n` |
| `uniqueCount` | distinct non-blank values of a column (`{ value }`) | `value-mismatch` |
| `duplicates` | values (and rows) that occur more than once (`{ values }` and/or `{ rows }`) | `values-missing`, `values-extra`, `values-duplicated`, `rows-missing`, `rows-extra`, `rows-duplicated` |
| `groupTotals` | sum of a column per group (`{ totals: [{ group, total }] }`) | `groups-missing`, `groups-extra`, `groups-duplicated`, `group-total-mismatch` |
| `percentOfTotal` | matching rows' sum as a percent of the column total (`{ value }`) | `value-mismatch`, `no-values` |
| `band` | each row's number (or days since a date) falls in a signed band (`{ bands: { "<row>": "<name>" } }`) | `band-mismatch`, `no-band` |
| `daysBetween` | whole days from one date cell to another (`{ value }`) | `value-mismatch` |
| `daysSince` | whole days from a date to the signed `asOf` (`{ value }` for a cell, `{ days: { "<row>": n } }` for a column) | `value-mismatch` (cell), `days-mismatch` (column) |
| `earliest` | the earliest date of a column (`{ value: "<date>" }`) | `value-mismatch`, `no-values` |
| `latest` | the latest date of a column (`{ value: "<date>" }`) | `value-mismatch`, `no-values` |

### `table`: no claim, checks the table itself
Fields: `table`, `op`, plus the op's fields. Example: `{ id: "ids-unique", rule: "table", table: "t", op: "noDuplicates", column: "Id" }`

| Op | Checks | Red gap |
|---|---|---|
| `allNumbers` | every cell of a column reads as a number | `not-number` |
| `allDates` | every cell reads as a date in the signed format | `not-date` |
| `noEmpty` | no blank cell in a column | `empty-cells` |
| `noDuplicates` | no value twice in a column (blanks ignored) | `duplicate-values` |
| `rowCount` | exactly `n` rows | `row-count` |
| `rowMath` | on every matching row, `result` = `a` `fn` `b` (add, sub, mul, div, pct) | `row-math-mismatch` |

### `diff`: before table vs after table
Fields: `before`, `after`, `keyColumn` (required: rows are aligned by it), `op`, plus the op's fields. Example: `{ id: "only-tax", rule: "diff", before: "t", after: "a", keyColumn: "Id", op: "onlyColumnsChanged", columns: ["Tax", "Total"] }`

| Op | Checks | Red gap |
|---|---|---|
| `onlyColumnsChanged` | only the listed columns differ (a removed column is always red) | `column-changed`, `column-added`, `column-removed` |
| `untouchedIdentical` | every aligned row is identical, except `exceptKeys` | `untouched-cell-changed`, `column-added`, `column-removed` |
| `rowsAdded` | exactly `n` keys are in after and not in before | `rows-added-count` |
| `rowsDeleted` | exactly `n` keys are in before and not in after | `rows-deleted-count` |
| `newColumnRule` | the after table's `result` column is new or changed and obeys the row math | `column-not-new-or-changed`, `row-math-mismatch` |

`onlyColumnsChanged` and `untouchedIdentical` compare aligned keys only and do not notice added or deleted rows: pair them with `rowsAdded` / `rowsDeleted`. A blank or repeated key in either table is red `key-not-unique`.

## Measured by your harness

bareguard runs no command and reads no git. You measure and pass `measurements[checkId]`. For `notWorse`, `patternAbsent` and `filesChanged` that includes `exit` and `matchedPreScope` (the match count before any scope filter); `commandExit` needs `exit` only.
- Stopped, all four: `missing-measurement` (a measurement or field absent or the wrong type). For the three with a scope, also `liveness` (non-zero `exit` with 0 `matchedPreScope`: a crashed tool is unknown, not zero). A tool whose "none found" is a non-zero exit signs `noneExit` on the check.

### `commandExit`
The measured `exit` equals `expectExit` (default 0). Takes no `noneExit`.
- Fields: `expectExit?`.
- Example: `{ id: "tests", rule: "commandExit" }`
- Red: `exit` (`measured`, `limit`, and the first output lines if you passed `outputLines`).

### `notWorse`
A measured `value` is not worse than the baseline in the signed `direction` (equal is green). `baseline` is a signed number, or `"seed"` (the runner's first measurement, recorded once).
- Fields: `direction`, `baseline`, `noneExit?`, `terms?`.
- Example: `{ id: "lint", rule: "notWorse", direction: "lower-is-better", baseline: 3, noneExit: 1 }`
- Red: `worse` (`measured`, `limit`, `direction`, and per-term `id=n` items if `terms`).
- Stopped also: `baseline-conflict` (a per-call baseline on a literal, or a seed that differs from the recorded one).

### `patternAbsent`
Zero hits: the caller's scan found none of the signed pattern ids. `patterns` are ids only; the regexes are yours.
- Fields: `patterns`, `noneExit?`.
- Example: `{ id: "no-todo", rule: "patternAbsent", patterns: ["todo", "fixme"], noneExit: 1 }`
- Red: `present` (items like `id@path:line`).
- Stopped also: `unknown-pattern` (a hit whose `id` is not in the signed list).

### `filesChanged`
The caller's changed-file `paths` are non-empty (if `requireNonEmpty`) and every path sits under a signed prefix, resolved physically like the fs scopes.
- Fields: `allowPrefixes`, `requireNonEmpty`, `noneExit?`.
- Example: `{ id: "scope", rule: "filesChanged", allowPrefixes: ["/work/repo/src"], requireNonEmpty: true }`
- Red: `empty`, `outside-prefixes` (items = the offending paths; a relative or non-string path is an offender).
- Stopped also: `exception` (a prefix is or sits under a symlink, or cannot be resolved).
