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

### `blockLines`
Non-empty lines are grouped in blocks of `size`; every listed phrase must appear in each block.
- Fields: `field`, `size`, `phrases`, `strict?`.
- Example: `{ id: "blocks", rule: "blockLines", field: "text", size: 3, phrases: ["From", "To"] }`
- Red: `zero-lines`, `not-multiple` (line count not divisible by `size`), `block-missing` (items like `block 2:To`); the last two can be joined.

### `in` / `notIn`
A string field equals one of / none of the signed `values` (exact `===`).
- Fields: `field`, `values`.
- Example: `{ id: "status", rule: "in", field: "status", values: ["done", "blocked"] }`
- Red: `not-in` (`in`) / `forbidden` (`notIn`); also `missing`, `unreadable`, `wrong-type`.

### `atMost`
A string field ranks at or below the signed `value` in the ordered list `order` (an ordered enum, e.g. severity).
- Fields: `field`, `value` (must be in `order`), `order` (no duplicates).
- Example: `{ id: "sev", rule: "atMost", field: "severity", value: "medium", order: ["low", "medium", "high"] }`
- Red: `over`, `unknown` (the field's value is not in `order`); also `missing`, `unreadable`, `wrong-type`.

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
- Red: `no-claims`, `unsupported` (items are per claim: `#0:malformed`, `#0:empty-quote`, `#0:quote-not-found`, `#0:quote-too-long`, `#0:numbers:<n>`, `#0:d<j>:<kind>`), `too-many` (quote work cap), plus `missing`, `unreadable`, `wrong-type`.
- Stopped: `missing-measurement` (the input is absent or does not match its signed sha256).

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
