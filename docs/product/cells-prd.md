---
type: product
title: "cells — a signed rubric check computed over caller-given table rows (BUILT, unreleased)"
status: built on feat/cells, unreleased
---

# cells — spec

Status: built on feat/cells, unreleased. POC done (2026-10-22), defaults ruled, build details settled in §10. No version picked (hamr's pick).
Parent spec: [rubric-prd.md](rubric-prd.md) (laws §2, vocabulary §4). Ruling: #67 in rubric-prd.md §12.

## 0. In one paragraph

`cells` is a small family of generic rubric checks (`rule: "cells" | "table" | "diff"`, like `cited`; see
§2) that recompute a declared operation over table rows the caller hands in and compare the result with a
value the step gives. The operation (`op`) comes from a closed list in `rubricVocabulary`. The signer picks the
op, the column and the condition; the step supplies values only. bareguard never authors the
formula from the step's words.

## 1. Origin (fwdloop ask, 2026-10-22, confirmed by hamr)

fwdloop asked for a rubric check computed over table cells.

- Evidence: deepseek-flash failed "list every expense over 500" in 4 of 4 tries, twice (fwdloop runs
  `m10-walk-csv-2` run-1 and `m10-walk-csv-3` run-1). A Sonnet run passed (`m10-walk-csv` run-1).
- Truth, checked by bareguard independently: 17 of 40 Amounts are > 500, sum 12719.59, average
  748.2112. The failing tries claimed 2, 3, 18, 53... rows.
- fwdloop grew its own cell grammar (`src/closers.js` in fwdloop: one cell, `#field`,
  sum/count/min/max/sub/daysBetween; no ranges, no condition, no average), and the step writes its own
  cite. That is the flaw: the step authors its own check.
- The source data may hold PII; this page deliberately carries no row contents, descriptions or amounts.

## 2. RULED (hamr, 2026-10-22; ruling #67)

- ONE generic check family with an `op` from a closed list, not one rubric shape per check. Whole op list
  on day 1, write-side ops included ("do all from day 1").
- THREE kinds, one menu in `rubricVocabulary` (the code selects a check by its `rule` field):
  - `cells`: read. The step claims a value over a table; bareguard recomputes and compares. The `band` op
    takes a claim, so it lives here.
  - `table`: no claim. Shape checks and row math on the table itself.
  - `diff`: before vs after table. Must sign a key column.
- The vocabulary is the pre-read menu: the drafter reads it BEFORE committing to a job. A need that maps
  to no op is red at drafting, so the agent cannot over-commit.
- Flow (like bareloop's page facts): at draft time the agent suggests checks from the vocabulary (for
  example `countIf(Amount, ">500")`), the person signs, the step gives VALUES only, `checkStep`
  recomputes and judges. The step never authors its own formula.
- Law 11 ALLOWED for these rules: bareguard may compute over caller-given typed rows, like `cited`
  verifies quotes against a frozen source. The caller still owns file parsing. Consequence: the parsing
  rules (number format, date formats, blank handling) become part of the SemVer surface; changing them
  later changes verdicts.
- Number reading: optional sign; optional currency symbol "$", "€" or "£"; "," only in proper thousands
  groups ("1,20" and "1,2,3" are red); optional decimals. Refused (red): `1e3`, `12%`, `.5`, `0x10`,
  `Infinity`, accounting "(500)". Symbol placement follows #65 (symbol glued directly before the digits,
  no space, a code before the number stays out). Sign-vs-symbol order is a build detail, not stated by
  #65.
- Surrounding whitespace is ignored when a cell (or a claimed date) is read as a number or a date (`" 5 "`, `"2026-10-01\n"` read); blank = whitespace-only. Aggregates (sum, average, median, min, max, groupTotals) skip blanks. A blank
  never satisfies a number or date condition. A non-empty, non-number cell in a number column is red
  `unreadable-cell`.
- Row math: a blank operand is red `empty-operand` unless the check signs `allowEmpty: true` (CHANGED
  from the POC's blank=0, at fwd's request; fits "nothing inferred"). A blank result cell is red
  `result-empty`. Divide by zero is red `div-zero`. Over zero numbers, average/median/min/max are red
  `no-values`.
- Tolerance: counts, row sets, days and uniqueCount are exact. Float ops (sum, average, median, min, max,
  numeric lookup, groupTotals, percentOfTotal, row math) default to absolute 0.005, so a claim rounded to
  cents is green, plus a 1e-9 relative float-noise slack. A signed per-check `tolerance` overrides; a
  negative or non-number tolerance makes the check `stopped`.
- `topN` ties: default `ties: "any"` (any valid pick is green); a signed `ties: "all"` requires every
  tied row.
- Text equals is exact: no trim, no case folding, no wildcards. `between` is inclusive; `before`/`after`
  are strict. AND only. `allNumbers`/`allDates` count blanks as violations unless the check signs
  `allowEmpty`.
- `rows`: claimed by row number (2-based, sheet-style) as the primary form; claiming by key values (a
  multiset, needs a signed `keyColumn`) is the fallback.
- Verdict split: a bad or missing claim is red; a broken check or table (unknown op/column/cmp, a
  non-string cell, a ragged row, a duplicate header, a bad tolerance or `asOf`) is `stopped`; any
  unexpected internal exception is `stopped`, never green. Gaps show row numbers, counts and values the
  agent itself claimed, NEVER table cell text; the expected answer stays in `full.expected`, not in gaps
  (hamr 2026-10-22: a gap reaches the worker and the audit file).
- DATES are FLEXIBLE: the signer picks a date format PER COLUMN from a closed list (fixed at build:
  `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `D MMM YYYY`; details in §10). bareguard reads
  exactly that format with real-calendar validation and never guesses ("03/04" is never auto-read). fwd
  prefers this over caller-side ISO conversion: one implementation inside the checked code, and the
  signer sees the format. Every real fwd input is ISO today.
- Additions (fwd ask, hamr yes):
  - Per-row date mode: the claim is a map of row to days, e.g. `daysSince(Due date, asOf)` for every
    row, `asOf` a signed date. A single signed `{column,row}` cell stays for one-off facts.
  - `band` op: the row's number falls in one of a list of signed bands (e.g. Current = <=0, 1-30, 31-60,
    61-90, 90+ = >90). The claim is a map of row to band name. Real use: fwd's AR aging job
    (`fixtures/ar-aging.csv`: 8 invoices, ISO dates, Invoice # unique, the Days overdue and bucket
    columns blank waiting to be filled). Its guardrail "every invoice appears exactly once" is `rows`
    over the whole table plus `noDuplicates` on Invoice #.
- POC before build (done, §8).

## 3. Boundary

The caller owns file parsing (CSV/xlsx, quotes, "1,200.50", header names) and hands typed rows: each
cell a string, each row carrying `rowNumber` (2-based, sheet-style). bareguard gets typed rows plus the
signed check. No model, no user regex, no free formula language. Since bareguard now reads numbers and
dates out of those strings (Law 11, §2), that reading is SemVer surface.

## 4. Op list (closed; built as listed, §10)

1. **Read / aggregate over a signed range of one column** (`cells`). `count`, `countEmpty`, `countIf`,
   `sum`, `sumIf`, `average`, `averageIf`, `median`, `min`, `max`, `found`, `lookup` (the cell in column
   X on the row where K = Y; 0 or more than 1 match = red; needs a signed needle), `rows` (the claimed
   set of row numbers must EQUAL the matching set exactly: no missing, no extra), `topN`, `uniqueCount`,
   `duplicates`, `groupTotals` (sum per distinct group value; the closest it gets to a pivot table),
   `percentOfTotal`, `band`.
2. **Row math, fixed ops only** (`table`). add, sub, mul, div, pct of two columns, or of a column and a
   signed constant (for example Total = Amount + Tax on every row).
3. **Dates**, in the per-column signed format (§2). `daysBetween`, `daysSince(cell, asOf)` where `asOf`
   is a SIGNED fixed date, never the real clock; `earliest`, `latest`; conditions before / after /
   between. Out: business days (they need a holiday calendar).
4. **Conditions.** Number `>` `>=` `<` `<=` `=` and between; text equals exactly (no wildcards); empty /
   notEmpty; AND only, no OR.
5. **Shape checks** (`table`). `allNumbers`, `allDates`, `noEmpty`, `noDuplicates`, `rowCount`.
6. **Write side, before table vs after table** (`diff`, signed key column). `onlyColumnsChanged`,
   `rowsAdded` / `rowsDeleted` exactly N, a column matches a row-math rule, untouched cells
   byte-identical. No live caller today (fwd: no use; loop: not yet).

About 30 ops in all, so `rubricVocabulary` must describe each op's signed fields and claim shape.

## 5. Tolerance

See §2: exact for counts, row sets, days and uniqueCount; absolute 0.005 default for float ops; a signed
per-check `tolerance` overrides.

## 6. OPEN (after the build)

SETTLED at build (details in §10):

- The exact closed date-format list: `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `D MMM YYYY`.
- Table size cap and its value: 500,000 cells and 16 MiB of characters per table; over = red `table-too-large`.
- `groupTotals` claim shape: an array of `{ group, total }` pairs (no agent-chosen map keys).
- Law 5 fit: conditions are a closed operator set with typed signed values, no regex, no free text; built that way.

STILL OPEN:

- What bareloop's "doc checks" covers (likely tables inside documents, which the caller turns into rows, so the same rules).
- Not built, no caller asked: per-row `daysBetween` over two date columns (the per-row date mode exists for `daysSince`; `daysBetween` takes two single cells), business days, OR conditions.

## 7. Consumers

- **fwdloop**: the live caller. It reviewed every default and asked only for the row-math change
  (`allowEmpty`). It will quote the POC finding in its F74. Its inputs: the expenses CSV,
  `ar-aging.csv`, a `resume.csv`. `diff`: no fwd use today. Once `cells` lands it retires its own
  grammar.
- **bareloop** (updated by hamr via loop, 2026-10-22): it WILL use `cells` with rubric jobs, "all
  spreadsheets operations, doc checks", in the same shape with no variant, and builds nothing until
  bareguard's version lands. What "doc checks" means is OPEN (§6). No clash with `cited` / `decides` or
  its page facts (`MAP_SHAPES` in bareloop's `src/pagemap.js`), since `cells` takes typed rows, not page
  text.

## 8. POC

In `.scratch/cells-poc/` (gitignored; `cells.mjs`, about 474 lines). Run 2026-10-22. It replays fwd's
real tries in place and runs synthetic cases per op.

- Replay of fwd's real tries against a signed `rows` check (Amount > 500): 8 of the 9 tries that made a
  claim had the RIGHT values (the right 17 rows, the right count and sum). They failed on fwdloop's own
  cite grammar (e.g. "does not match the cell or formula grammar", "locked to column 'Amount'"), not on
  the answer. Only `m10-walk-csv-3` try 1 was wrong (18 rows, 1 extra); `cells` gives it red
  `rows-extra`. The passing Sonnet run is green.
- Synthetic: 226 pass, 0 fail (every op, condition, date op, shape check, write-side check, and hostile
  claims: a throwing getter, a Proxy, a `__proto__` key, 200k entries).
- NOT run: large-table timing/perf, `averageIf` against a real claim, Windows.
- Learnings: `diff` needs a signed key (renumbering after a delete makes every later row look changed);
  `found`/`lookup` need a signed needle; `groupTotals` as a map has agent-chosen keys; the vocabulary
  must describe about 30 ops.

## 9. Next

Self-review, branch review, hamr picks the version, then tell fwd and loop the version.

## 10. Build details (feat/cells, decided at build; each is SemVer surface once released)

How a table reaches `checkStep`: `opts.tables[name]` = `{ header: string[], rows: [{ rowNumber, cells: string[] }] }`, referenced by the
signed check's `table` (`before` / `after` for `diff`). RULED (hamr 2026-10-22): tables locked by signed sha256. A table a check reads (`table`,
or a `diff`'s `before`) must be a `spec.inputs` entry `{name, sha256}`, the sha256 being `tableSha(table)` (exported primitive: sha256 over a
canonical JSON form of the header and each row's `rowNumber` and `cells`; over the typed rows, not the raw file; `null`, never a throw, for a
malformed, hostile or over-cap table). `createRubric` refuses an unsigned table; a table that does not hash to its signed sha256 is `stopped`
(`missing-measurement`, like a `cited` input). A `diff`'s `after` table is the artifact being checked and is NOT signed (it comes via
`opts.tables` unlocked). A missing, ragged or non-string table is `stopped` (fault `table-invalid`); a signed column, row or field that cannot apply is `stopped` (`check-invalid`). Each table is copied once per
`checkStep`. The claim is read from the output field the check names in `claim` (a plain object; keys per op in `rubricVocabulary`).

Rule shape: `cells` takes `table`, `claim`, `op` + op fields; `table` takes `table`, `op` + op fields; `diff` takes `before`, `after`,
`keyColumn`, `op` + op fields. `createRubric` refuses a signed check the engine would stop on (unknown op/field/cmp/format, a missing
required field, an unused or missing `dateFormats` entry, a bad `asOf`, a negative `tolerance`, overlapping bands, a `tolerance` on an
exact op); the same validator runs again at check time, where it yields `stopped` `check-invalid`.

Readers: number = `[+-]?[$€£]?` + proper thousands groups + optional decimals (sign BEFORE symbol: `-$5` read, `$-5` refused), whitespace
around is ignored. Dates: `DD/MM/YYYY` and `MM/DD/YYYY` need two-digit day and month; `D MMM YYYY` takes a 1- or 2-digit day and the English
three-letter month in ANY letter case (`Sept` and full names are not read); all four check the real calendar, years 1-9999. `asOf`, condition
bounds and `between` dates are always signed as `YYYY-MM-DD`, whatever the column's format. `daysSince` = `asOf` minus the date.

Ops: `daysSince` with `cell` claims `{value}`; with `column` it is the per-row mode and claims `{days: {"<row>": n}}`. `band` takes signed
`bands: [{name, gt|gte, lt|lte}]` and claims `{bands: {"<row>": "<name>"}}`; with `asOf` the column is a date column and the banded number is the
days since. `diff.untouchedIdentical` takes `exceptKeys` (keys, not row numbers: a delete may renumber). `rowsAdded`/`rowsDeleted` require `n`.
`rows` by keys: `{keys: [...]}` compared as text (`valueKind: "number"` reads numbers); a `rows` claim carrying BOTH `rows` and `keys` is red `claim-malformed` (item `keys`), never graded as one and ignoring the other (a key set to `undefined` counts as absent); `topN` takes `{rows}` or `{values}`, and a claim carrying BOTH is likewise red `claim-malformed` (item `values`; `undefined` counts as absent); `lookup` requires `valueKind` (text, number, date).
`onlyColumnsChanged` and `untouchedIdentical` compare ALIGNED keys only and do NOT notice added or deleted rows; the signer pairs them with `rowsAdded` / `rowsDeleted`.
A removed column is always red in `diff`; a new column is red unless listed (`onlyColumnsChanged`) or unless the op is `newColumnRule`.

Claims strictly typed (hamr 2026-10-22: strict for spreadsheets): a claimed number is a finite JS number, never a numeric string (`{value:"17"}` is red
`claim-malformed`), for `value`, `topN` `values`, `totals[].total`, `days` values and numeric `keys`; text and date claims are strings, `rows` integers,
`days`/`bands` map keys digit strings. A table data problem sorts before a claim problem in `gaps`. Every op has a worked example in `rubricVocabulary`
(`ops.<op>.example`: the check plus, for `cells`, the full step `output`), run green in a test against `rubricVocabulary.cells.exampleTables`.

Gaps: own kinds (listed in `CELLS_GAP_KINDS`), `items` as strings (20 max, `itemsTotal` when cut), `measured`/`limit` for counts and the claimed
value; the expected answer is in `full.expected` only. `items` are row numbers (`values-missing`, `groups-missing` = the first row of each omitted group,
`rows-added-count` = rows of the after table, `rows-deleted-count` = rows of the before table), `row:Column` cells, column names, or what the agent
itself claimed (`values-extra`, `values-duplicated`, `keys-extra`, `groups-extra`, `groups-duplicated`, `group-total-mismatch`); never table cell text.
`duplicates` `values` is a list, so a value claimed twice is red `values-duplicated` (like `rows-duplicated` / `groups-duplicated`). `renderGaps` JSON-escapes
any item that is not a plain token (so a newline or quote in a claimed value never lands raw in a prompt). Overflow (fix after /branch-review): a computed value that is not a finite number (cells are finite, but a sum, a product or a quotient can pass the largest double) is never compared: red `value-overflow`, a table data gap listed first like `unreadable-cell` (items: row numbers for row math, the first row of the group for `groupTotals`, none for a scalar op). It is red and not stopped because the table, not the instrument, produced it, like an unreadable cell; `average` reports it when the SUM overflows even if the mean would fit (the median halves first, so it does not). The comparison helper also refuses a non-finite side as a backstop.

Faults: `table-invalid`, `check-invalid`, `exception`.

Size caps (measured 2026-10-22 on the dev machine, load < 1; ms, median of 3): at 500,000 cells (50,000 rows x 10) snapshot 34, sum 48,
median 51, countIf 48, rows 61, duplicates 60, groupTotals 67, topN 86, per-row daysSince 93, band with a 100k-key claim 75-160, rowMath 59,
diff of one changed cell 161 (two tables); worst adversarial (10 columns x 50,000 rows): diff with EVERY cell changed 330-430 ms. Wide and tall shapes at the cap, re-timed after the header-alignment fix (diff, every cell changed, reversed header): 500,000 columns x 1 row 0.8-1.1 s, 250,000 x 2 about 0.35-0.5 s, 1 column x 500,000 rows about 1.0 s; the other ops stay under about 0.9 s in every shape (topN on 1 column x 500,000 rows is the slowest, 0.33-0.86 s) (before the fix, 50,000 columns took 8.6 s and 500,000 would take minutes: the AFTER header is agent-controlled). Measured earlier under load, over the cap
(not kept): that every-cell diff at 1,000,000 cells took 739 ms and a one-cell diff at 2,000,000 cells 656 ms, so the cap is 500,000 cells and 16 MiB of characters (a single 32 MiB cell scans in about 170 ms). Over a table cap = red `table-too-large`
(like `cited`'s source-too-large, not stopped: the cap is deterministic and the verdict is a pure function of the inputs); claim lists and maps over
100,000 entries are red `claim-too-large`.


## 11. Check helpers for callers (RULED #82, 2026-11-13; DESIGN ONLY, NOT built; no version picked)

Ruling #82 (rubric-prd.md §12), hamr: every rubric check lives in bareguard and callers (fwdloop, bareloop) import it; a whole-input read or a guess stays the caller's; bareguard is bound to receive a specific thing to judge. Settled with fwdloop and bareloop. Source of the need: fwdloop's `src/sheetchecks.js`, `sheetrun.js`, `sheetoffer.js`, `sheetclaims.js` and `src/citedwords.js` (`numbersSaid`) each re-implement a piece of what follows; they were read for shape only, no data copied. All of it is deterministic, no LLM, and nothing is inferred (a literal, a column or a claim shape is said or it is a problem). `checkStep`'s contract does NOT change. Every new function is an export with JSDoc `@when`, so `primitives.json` gains entries (the adoption check is the generator: `git diff primitives.json` shows only additions); the new exports and the additive vocabulary / fault fields are SemVer surface once released (rubric-prd.md §9, "Planned"). Placement of the code (a new `src/primitives/` module next to `rubric-cells.js`, re-exported from `src/index.js`) is the build's call.

### 11.1 Column-bearing fields and the `where` comparison list in `rubricVocabulary`

Verified against `validateSigned` / `FIELD_DOCS` / `OPS` in `rubric-cells.js` (the complete set of fields whose string names a header of a table):

| Field | Where | Value shape |
|---|---|---|
| `column`, `keyColumn`, `groupColumn`, `result` | cells, table (and `keyColumn` / `result` on diff) | plain string |
| `a` | row math (`rowMath`, `newColumnRule`) | plain string (`checkOperand(.., false)`: a name only) |
| `b` | row math | string OR `{ const: finite number }` (the const is not a column) |
| `from`, `to`, `cell` | `daysBetween`, `daysSince` | `{ column, row }`: `.column` |
| `where` | every op that takes it | list of conditions: `[].column` |
| `dateFormats` | date ops | list of `{ column, format }`: `[].column` |
| `columns` | `diff` `onlyColumnsChanged` only | list of strings (headers allowed to change) |

Found beyond fwdloop's own four lists (`COLUMN_STRING_FIELDS`, `COLUMN_OPERAND_FIELDS`, `COLUMN_CELL_FIELDS`, `COLUMN_LIST_FIELDS`): only `columns`, a diff-only field fwdloop's cells/table rules never reach. NOT column-bearing, though they are strings next to columns: `needle`, `keyValue`, `exceptKeys` (cell VALUES, keys), `bands[].name`, `claim`, `table`, `before`, `after`, `id`, `text`. Not verified: that no future op adds a column field; the test below is the guard.

Vocabulary change (additive, on each `rubricVocabulary.rules.<rule>.fields.<name>`): a `columnAt` attribute on exactly the fields above, one of `"self"` (the field value is a header; `b` also admits `{const}`), `"self.column"` (`from`, `to`, `cell`), `"each.column"` (`where`, `dateFormats`), `"each"` (`columns`). Absent on every other field. Generated from one table beside `FIELD_DOCS`, so a field cannot be marked and undocumented. Also published: `rules.cells.fields.where.cmps` (and the same on `table`/`diff` where `where` appears), the ordered list `["gt","gte","lt","lte","eq","between","before","after","dateBetween","dateOn","equals","empty","notEmpty"]`, verified equal to `CMP_ALL` (`CMP_NUM` + `CMP_DATE` + `equals`, `empty`, `notEmpty`) and equal to fwdloop's hand copy `WHERE_CMPS`; plus `cmpKinds` `{ number: [gt gte lt lte eq between], date: [before after dateBetween dateOn], text: [equals], none: [empty notEmpty] }` so a schema builder knows which take `value`, which `lo`/`hi` (`between`, `dateBetween`) and which take nothing. Both come from the constants the validator uses (`CMP_NUM`, `CMP_DATE`, `CMP_ALL`), not a second list. The `where` description string stays generated.

Test plan: (a) every `columnAt` field is a `FIELD_DOCS` field and every `FIELD_DOCS` field of a column-ish type is marked or listed in a short explicit "not a column" allowlist (so a new field forces a decision); (b) for every op's worked example, replace each marked path's column with a sentinel absent from the header and assert the check is refused or `stopped` `check-invalid` naming a column (never green), and that replacing a NON-marked string field with the sentinel never produces a column error (completeness in both directions); (c) `cmps` deep-equals `CMP_ALL`, each `cmpKinds` member is accepted by `checkConds` in the stated shape; (d) the vocabulary stays deep-frozen and JSON-round-trippable.

### 11.2 `checkTables(spec, tables)`: "this spec will not run on these tables", at $0

Pure, NEVER throws (a hostile spec or table, a throwing getter, a Proxy, `__proto__` keys, a non-object argument all return a problems array; copy key-by-key with try/catch like `snapshotTable`). Returns a fresh array of fresh plain objects; empty = ok. `spec` is the raw (not yet `createRubric`-ed) spec an AI drafted; `tables` is `{ name: { header, rows } }`. One call returns ALL problems (fwdloop Q1), each typed, no rendered words beyond the `createRubric` message (callers write their own sentences). Each problem: `{ kind, checkpoint?, index?, id?, ... }` where `checkpoint`, `index` (position in `checks`) and `id` locate a check:

- `no-table`: a `cells` / `table` check names (`table`) or a `diff` names (`before`) a table that `tables` does not carry (the problem carries `table`; only tables a check reads are reported). A diff's `after` is the artifact checked at step time, not signed, and is not required here (OPEN: report it only when given and unreadable).
- `unreadable-table`: `tableSha(t)` is `null` (malformed, hostile, over the caps; one kind, since `tableShaOf` cannot tell them apart). Carries `table`.
- `not-a-column`: a column-bearing field (11.1) names a string that is not in the header of the table the check reads. Carries `table`, `column` (clipped), `field` (the path inside the check, e.g. `where[1].column`, `dateFormats[0].column`, `b`, `cell.column`) plus the check locator. Compared by exact string, like `colIdx` (`header.indexOf`). Only when that table is present and readable (a missing table is already `no-table`). `diff`: `keyColumn` must be in BOTH `before` and a given `after`; `result` of `newColumnRule` is read in the AFTER header (`runDiff` does `colIdx(after, plan.result)`); `columns` may name a column that exists only in `after`. OPEN, verify at build against `runDiff`: which header the other diff fields (`a`, `b`, `where` of `newColumnRule`) are read in; until then `checkTables` reports diff column problems only for `keyColumn` and `result`.
- `sha-mismatch`: a table named in `spec.inputs` whose given table is readable but does not hash to the signed `sha256` (the same comparison `makeEnv` makes). Carries `table`. A `null` hash is `unreadable-table`, not a mismatch. Only tables present in `tables` are compared (an absent one is `no-table` if a check reads it).
- `refused`: what `createRubric` would throw for this spec, with its `path` and `message`. `createRubric` throws at the FIRST problem, so "all" holds as follows: every `cells` / `table` / `diff` check is run through `signedProblem(rule, check)` (the very function `createRubric` calls) plus the "names a table not in `spec.inputs`" refusal, and EACH failing check yields its own `refused` (path as `createRubric` forms it, `spec.checkpoints.<id>.checks[<n>].<field>`); any other `createRubric` refusal (spec shape, checkpoint, a non-cells check) yields ONE `refused`, only when no cells-family refusal was found. This is the one place "one call returns all" is bounded by the validator's own design; a check that is `refused` gets no column / table problems (its fields cannot be trusted).

Order: by checkpoint (spec order), check index, then kind. The array is bounded by the spec's own size (at most one problem per field per check; no cap planned). Cost: one `tableShaOf` + one header copy per given table (shared with the sha check), linear in checks; no work beyond the table caps.

Test plan: each kind alone, and all five in one spec; `diff` aligned with 11.1; boundaries (header with 0 columns, a column name at `MAX_SIGNED` 1000 vs 1001 chars, 20 conditions vs 21, an `inputs` name equal to a `tables` name with a table whose sha differs by one cell); never-throws on hostile input (throwing getters on `spec`, `tables`, a row, a Proxy, `__proto__` / `constructor` keys, cyclic structures, a 500k-cell table at the cap and one over); null-proto: `tables` with an own `__proto__` key and a `toString` table name never match a prototype member; a fresh result object each call (mutate it, call again, same output; the input spec/tables are not mutated or frozen by the call); equivalence: for any spec `checkTables` calls `ok` on, `createRubric` + `checkStep` on those tables yields no `check-invalid` / `table-invalid` / `missing-measurement` fault from tables or columns (differential, fuzzed over the op examples).

### 11.3 `runTableChecks(rubric, checkpoint, tables)`: only the `table` checks, no step output

Runs ONLY the `rule: "table"` checks of one checkpoint over `tables`, with no step output (fwdloop fakes `{done:true}` today to get past `happened`). Same argument contract as `checkStep` for programmer errors: a rubric not from `createRubric()` or an unknown checkpoint throws `TypeError`; a non-object `tables` is `TypeError`; everything about the DATA (hostile, malformed, oversize tables) never throws and lands as a per-check result. Returns a frozen fresh array `[{ id, verdict, gaps, fault? }]` in check order, one entry per `table`-rule check (empty when the checkpoint has none: a table-only checkpoint is legal, and a checkpoint with only other rules returns `[]`, silently, not a problem). `verdict` is `green` / `red` / `stopped` per check; `gaps` are the minted gaps of that check (the same shape `checkStep` puts in `StepResult.gaps`, via `mintGap`); `fault` is the same `{ key, checkpoint, id, kind, detail }` (plus `inputs`, 11.7). The signed-table lock applies exactly as in `checkStep` (a table named in `spec.inputs` that does not hash to its sha256 is `stopped` `missing-measurement`), with ONE snapshot per table name per call (the same `makeEnv` cache). No `happened`, no foundational check, no audit line, no gate state: it is a pure export like `checkStep` itself (a `Gate` wrapper is NOT planned; a caller that wants the audit trail uses `gate.checkStep`). It shares the evaluation path with `checkStep` (`evaluate` through `runCellsFamily`), so a verdict here equals the verdict `checkStep` gives the same check on the same tables.

Test plan: parity: for every `table` op example, `runTableChecks` verdict/gaps equal the matching check inside `checkStep(.., { done: true }, { tables })`; unchanged `checkStep` outputs (golden: a snapshot of today's results over the example specs stays byte-identical); a mutation of the sha lock must go red; oversize and ragged tables become `stopped` / red `table-too-large` per check, never a throw; a throwing `tables` getter is a per-check `stopped`; `__proto__` table name; result frozen, fresh per call; a checkpoint with zero table checks returns `[]`; `TypeError` only for the two programmer errors.

### 11.4 `checkSchema({ rules, columns, tables })`: the JSON schema of ONE check

Generated from `rubricVocabulary` (never hand-written), returns a fresh JSON-schema object for ONE check object over the given rules; the caller wraps it (array, `maxItems`, its own extra fields such as fwdloop's `covers`, and may drop properties). `rules` is a non-empty subset of `["cells", "table"]` (`diff` is OPEN until a caller asks; anything else is a `TypeError`, as are a non-array `columns` / `tables` or a non-string element: programmer errors, not data); `columns` the exact header strings (de-duplicated, order kept); `tables` the input names. Returns `null` when `columns` or `tables` is empty (no enum can be built; fwdloop does the same today). ONE schema, no per-op `oneOf` (fwd Q2, live-proven on its drafter): `op` is an enum across the union of the given rules' ops, and `additionalProperties: false`.

Mapping from the vocabulary's field `type` (fwdloop's `fieldSchema` is the model; the vocabulary is the source, an unknown type THROWS at build, like fwdloop, so a new type cannot be silently dropped):

| Vocabulary field | Schema |
|---|---|
| `id` | `{ type: "string", minLength: 1, maxLength: 128 }`, required |
| `rule` | `{ type: "string", enum: <rules> }`, required |
| `table` | `{ type: "string", enum: <tables> }`, required |
| `claim` | `{ type: "string", minLength: 1, maxLength: 128 }`; required only when `rules` is exactly `["cells"]` |
| `op` | `{ type: "string", enum: <ops of the rules> }`, required |
| `columnAt: "self"` | `{ type: "string", enum: <columns> }`; `b` is `anyOf [that, { type: "object", properties: { const: { type: "number" } }, required: ["const"], additionalProperties: false }]` |
| `columnAt: "self.column"` (`from`/`to`/`cell`) | object `{ column: enum, row: integer minimum 2 }`, both required, no extras |
| `where` (`columnAt: "each.column"`) | array, `minItems` 1, `maxItems` 20; items `{ column: enum, cmp: enum <cmps>, value: anyOf [number, string], lo: same, hi: same }`, required `column`, `cmp`, no extras |
| `dateFormats` (`each.column`) | array, `minItems` 1, `maxItems` 50; items `{ column: enum, format: enum <cells.dateFormats> }`, both required |
| `bands` (`band-list`) | array `minItems` 1 `maxItems` 20 of `{ name, gt, gte, lt, lte }`, `name` required (string `maxLength` 128), bounds numbers |
| `range` | `{ from: integer minimum 2, to: integer minimum 2 }`, both required |
| `integer` / `number` / `boolean` | as typed (`n`: integer `minimum` 0 from the vocabulary) |
| `enum` (`valueKind`, `order`, `ties`, `fn`) | `{ type: "string", enum }` from the vocabulary |
| `name`, `string` (`needle`, `keyValue`) | `{ type: "string", maxLength }` from the vocabulary |
| `date` (`asOf`) | `{ type: "string" }` with the format in `description` only (no `pattern`: some strict-schema providers refuse it; `createRubric` checks the real date) |
| `string-list` (`columns`, `exceptKeys`) | not reached with `rules` cells/table (diff only); when `diff` is added `columns` is an array of the column enum |
| `explanation` (`text`) | `{ type: "string" }`, optional, included: the schema describes what `createRubric` accepts; the caller drops it if it must not be offered (fwdloop does) |

Every property carries the vocabulary `description`. Which fields an op REQUIRES is not expressible in one schema (that is the point); `createRubric` / `checkTables` refuse the rest, and the per-op `requires` / `allows` stay in the vocabulary for the prompt.

Test plan: every field of every given rule appears or is intentionally absent (explicit allowlist); a column field's `enum` equals `columns` exactly (so `"amount"` is invalid when the header is `"Amount"`); `table` enum equals `tables`; schema JSON-round-trips and is identical across calls (deterministic key order) and a fresh object each call (mutating it does not change the next); a draft produced from the schema for each op example validates under a plain JSON-schema validator AND is accepted by `createRubric` (differential on the vocabulary examples); hostile `columns` (`"__proto__"`, `""`, 1,000-char, 100,000 entries) either TypeError (non-string) or produce a plain-data enum, never a prototype effect; `null` for empty columns / tables.

### 11.5 `claimSchema(check)`: the JSON schema of that check's answer box

Returns a fresh JSON-schema object for the claim a `cells` check expects (the object under the check's `claim` name), or `null` for a check with no claim (a `table` rule, a non-cells check, an invalid or hostile check; never throws). Per-check only: NO refusal when two checks share a claim name (bareloop shares one claims box across `cited` checks by design, its L1 49 stages); a caller that merges boxes owns the merge.

Derivation (a conflict with today's code, below): there is no structured claim definition in the source, only the prose string `claim` on each op in `OPS` and `CLAIM_KEYS` (key to kind) in the claim reader. The build adds one structured `claim` table per op (key, type, integer-ness) next to `OPS`, derives BOTH the prose string and `claimSchema` from it, and a test pins them to the reader (see test plan). Types are the strict ones of §10 (JS numbers only, never numeric strings), per op:

| Op | Schema (all `additionalProperties: false`) |
|---|---|
| `count`, `countEmpty`, `countIf`, `uniqueCount`, `daysBetween`, `daysSince` with `cell` | `{ value: integer }` required |
| `sum`, `sumIf`, `average`, `averageIf`, `median`, `min`, `max`, `percentOfTotal` | `{ value: number }` required |
| `found` | `{ value: boolean }` |
| `lookup` | `{ value }` typed from the CHECK's signed `valueKind`: `number` is number, `text` and `date` are string (fwdloop's `string \| number` is looser than needed: the check says which) |
| `rows` | `{ rows: integer[] (minimum 2), keys: array }`, both optional with `minProperties: 1`; `keys` items string, or number when `valueKind` is `number`, and `keys` is offered only when the check signs `keyColumn` (else the form is `claim-malformed`). Both present is red; JSON schema without `oneOf` cannot say it, so it stays a `checkStep` verdict |
| `topN` | `{ rows: integer[] (min 2), values: number[] }`, both optional, `minProperties: 1` |
| `duplicates` | `{ values: string[], rows: integer[] }`, both optional, `minProperties: 1` (BOTH allowed together: `duplicates` grades both) |
| `groupTotals` | `{ totals: [{ group: string, total: number }] }` (pairs, no agent-chosen keys) |
| `band` | `{ bands: { "<row>": string } }`: object with `propertyNames` pattern `^[1-9][0-9]*$` (`ROW_KEY`), `additionalProperties: { type: "string" }` |
| `daysSince` with `column` | `{ days: { "<row>": integer } }`, same `propertyNames`, values integer |
| `earliest`, `latest` | `{ value: string }` with the column's signed format in `description` (the format list is the check's `dateFormats` entry) |

Integer-ness note (verified in code): the reader accepts any finite number for a count / days (`claimNumber`) and a non-integer is then red `value-mismatch`, never green, so the integer schema only forbids claims that could not be right; rows must be integers (`claimRowList`, else red `claim-malformed`). The `{ rows }` minimum 2 is the sheet-style row number (`claimRowList` refuses `< 2`).

Test plan: for every op example, the example's `output` claim validates under its `claimSchema`; for every op, a generated violation per field (a numeric string, a float where integer, a non-string group, a map key `"0"` / `"01"` / `"x"`) is rejected by the schema AND is red `claim-malformed` (or `value-mismatch` for the integer-vs-float case) in `checkStep`, so schema and reader cannot drift; `lookup` per `valueKind`; `null` for table rules, non-checks, unknown ops and hostile input; two checks sharing a claim name each return their own schema; fresh object per call; the prose `claim` string in the vocabulary is byte-identical to today's (empty `git diff` of the vocabulary prose).

### 11.6 `groundedLiterals(check, text)`: every number and date an AI wrote must be in the person's words

`groundedLiterals(check, text)` returns `{ ok, missing: [{ path, kind: "number" | "date", value }] }`; `text` is ONE caller-given string (the job line plus its `~` rules; the caller assembles it, bareguard reads exactly the string it is handed). Never throws: a non-string `text` is `{ ok: false, missing: [], why: "not-a-string" }` (as `numbersInQuote`); a `check` that is not a plain object, or a literal of the wrong type (a numeric string, a non-finite number, a non-ISO or unreal date), is itself `missing` (it cannot be grounded; `value` carried clipped, as the number or string given). It reads own properties only, key-by-key with try/catch.

Scope, exactly: the NUMBER literals `where[i].value` for `gt gte lt lte eq`, and `where[i].lo` / `.hi` for `between` (path like `where[1].value`, `where[0].hi`); the DATE literals `where[i].value` for `before after dateOn`, `where[i].lo` / `.hi` for `dateBetween`, and `asOf` (path `asOf`). NOT read (not a literal the AI is inventing from the person's words, or the person states it elsewhere): `equals` text, `needle`, `keyValue`, band bounds, `n`, `tolerance`, `range`, `exceptKeys`. Noticed, NOT in the settled scope and not added: the row-math `b.const` is also a number the AI writes; OPEN for hamr (one line to add, path `b.const`, kind `number`).

Reader semantics (the person's text, left to right, ONE scan, each match consumed whole as ONE token, tried in this order at each position): time (`h:mm`, 12- or 24-hour), date (ISO `YYYY-MM-DD`), amount (a prefix `$`, `€` or `£`, then the number), bare number. A number inside a time, date or amount is NOT a bare number: `$150` does not say 15, `05:00` does not say 5, `2026-11-18` says no bare 2026. A number literal is grounded when its exact value equals a BARE number OR an AMOUNT token (`$150` says 150, not 15); a date literal is grounded when the text holds that exact ISO date (no `lang`, no other format). Values compare as exact decimals (`parseBound("number", n)` and `compareBounds`, no float: `0.1 + 0.2`); a literal with no plain-decimal `String(n)` (an exponent form) cannot be grounded.

bareguard's OWN reader, not fwdloop's regex. What exists in bareguard (`rubric-locate.js`, the `cited` decide readers) and is reused: `readNumber` and `parseGrammar` (digits, `,` only as proper thousands groups, optional `.` decimals, exact decimal, `prefixOf` sign / adjacency rules, "unsure is malformed"), `readCurrency` and `readCurrencyAfter` for the amount token (symbol glued before the digits, and glued after them, `$43$` malformed), `readDate` (ISO, `isRealDay` calendar validation), `readTime` (`h:mm` / `hh:mm`, `AM`/`PM`), `numRun`, `normalizeForQuote` (the same normalization `cited` applies to text), and the `scanValues` loop shape (`starts`, `read`, resume at `end`). What is NOT already there and is new code: the ONE combined pass that tries the four readers in order at a position and consumes the winner's span (today each kind is scanned alone, which is why `2026-11-18` would otherwise also yield 2026, 11 and 18 as bare numbers); the amount-or-bare grounding set; and a date-SHAPED skip (a run of digit groups joined by `-` `/` `.` such as `3/4/2026` or `18.11.2026`, which is not ISO) consumed as one opaque token that grounds nothing, to keep fwdloop's behaviour of not leaking its digits as bare numbers. A malformed token (the readers' "unsure") is consumed whole and grounds nothing. `cited`'s `numbersInQuote` (`\d+(?:\.\d+)?`, no grouping, no sign, no currency) is NOT reused: it is a different, looser contract (and stays unchanged). The cells reader `readCellNumber` is a whole-cell reader, not a scanner, and is not used. One linear pass, normalize once, NO work cap (the `carriesAny` precedent: go linear, do not cap); the docs state the cost shape only.

Divergences from fwdloop's `numbersSaid` (`src/citedwords.js`), each chosen by bareguard's "nothing inferred", each OPEN for the parity POC fwdloop will run over its real job lines (count, per divergence, how many real lines change grounding):

1. Commas. fwd strips commas anywhere: `1,0,0` says 100, `1,5,0` in `$1,5,0` says 150. bareguard: `,` is read only as proper thousands groups (1-3 digits, then groups of exactly 3); `1,0,0` is malformed, consumed whole, grounds nothing; `1,000` says 1000.
2. Minus. fwd ignores a sign (`-5` says 5). bareguard: a `-` at the start of the text, after whitespace or after `(` is a sign: `-5` says -5, NOT 5; any other `-` is a separator (`10-20` says 10 and 20, never -20); U+2212 is malformed. So a literal `5` is not grounded by `-5`, and a literal `-5` is grounded by it.
3. Letters glued to a number. fwd reads the number out of `5k`, `8x`, `3rd`, `400USD` (bare). bareguard: a letter directly after (or before) the digits makes the token malformed (adjacency, as for `cited`), so it grounds nothing. A space-separated suffix (`400 USD`, `5 k`) is a bare number in both. This is the divergence most likely to cost false refusals; the POC measures it.
4. Leading `.` or `,` and `(`. fwd reads `.5` as 5 and `(500)` as 500. bareguard: a `.` or `,` right before the digits, or a `(` right before them, makes it malformed.
5. Space after the symbol. fwd reads `$ 150` as an amount. bareguard's amount is glued (`$150`, and `150€`): `$ 150` is the bare number 150. For a NUMBER literal the grounding result is identical (an amount or a bare grounds it); the two differ only in whether 15 would be wrongly grounded, which neither does.
6. Time spelling. fwd takes `h:mm` with any case of am/pm and an optional space. bareguard's time reader accepts only `AM` / `PM` in capitals after one space (or none, 24-hour); `9:27 am` and `a.m.` are malformed and consumed whole. No literal in scope is a time, so the only effect is on digits, which both consume.
7. Dates. fwd consumes any `\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}` and grounds by the raw string. bareguard grounds only a REAL ISO date (`2026-02-30` is malformed, consumed, grounds nothing); every other digit-group date shape is the opaque non-grounding token above. The grounded set for valid ISO dates is the same.
8. Numeric compare. fwd compares JS numbers from `Number()`; bareguard compares exact decimals.
9. Normalization. fwd scans the raw text; bareguard runs `normalizeForQuote` first (NFC, whitespace handling shared with `cited`), so a non-breaking space between `$` and digits behaves as the shared normalizer decides. OPEN whether to normalize at all (decided to follow `cited` unless the POC shows a difference on real lines).

Not divergences (checked in the readers): leading zeros (`007` says 7 in both), a trailing `.` after a number (`500.`), `%` after a number (read as the number), decimals (`1.5`).

Test plan: boundaries per divergence (`1,000` vs `1,00` vs `1,0,0` vs `1,0000`; `-5`, `a -5`, `10-20`, `(5`, `5k`, `5 k`, `.5`, `$150` vs `150` vs `15`, `150€`, `$ 150`, `05:00`, `2026-11-18`, `2026-02-30`, `3/4/2026`); each in-scope path (every `cmp` value / lo / hi, `asOf`) and each out-of-scope field proven NOT read (a literal in `n`, `tolerance`, band bound, `equals`, `needle` never appears in `missing`); the `ok` and `missing` shape (order = check order, paths exact); never-throws (hostile `check` with throwing getters, Proxy, `__proto__`, numeric strings, `NaN`, `Infinity`, `-0`, 1e21; hostile `text`: non-string, lone surrogates, a 5 MiB string of digits, of `1,`, of `-`, of `$`, of `:`); linearity as a fast default-suite shape test plus the heavy cases in the opt-in `bench:rubric` (not machine timings in docs); null-proto and fresh-object return (mutating `missing` does not affect the next call; `check` is never mutated); and a differential against the existing readers: for any text, a value the `cited` `number` decide reads from a text equals the bare / amount set here when the combined pass consumes nothing else.

### 11.7 `fault.inputs` on a table sha mismatch

A `stopped` from a signed table that does not hash to its `sha256` (`missing-measurement`, today `makeEnv` in `rubric-cells.js` and the detail "table X does not match its signed sha256") gains a typed `fault.inputs: [names]`: ALL tables given in `opts.tables` that name a `spec.inputs` entry and do not hash to its signed sha256 (fwd G3), not only the first a check read. Today the name is only inside the `detail` prose, `makeEnv` checks one table at a time, and `StepResult.fault` is the first of `full.faults`. Additive: `fault` keeps `{ key, checkpoint, id, kind, detail }` and gains `inputs` only on this one fault; `detail`, `kind`, `key` are unchanged. Names are the signed `spec.inputs` names (each at most 128 chars), listed in `spec.inputs` order, de-duplicated, capped at 20 with `inputsTotal` when cut (the `itemsTotal` convention). Computed lazily, only when a mismatch fault is being made (a green path pays no extra hash), by hashing each given table once (cached per call); a given table that cannot be read (`tableShaOf` null) is a `table-invalid` fault, not a mismatch, and is not listed. The same list rides every table-sha fault of that call, whichever check minted it, and `runTableChecks` (11.3) carries it identically.

Notes verified in code: `stop(kind, detail)` has no extras slot today and the `Fault` typedef has no `inputs`; the audit's `fault` view is redacted then collapsed wholesale (`audit.js`), so an added array is bounded by the existing line bound and names are signed identifiers, not agent text; a name that is also a text `spec.inputs` entry (a `cited` source) is only compared when `opts.tables` carries a TABLE of that name.

Test plan: two mismatched tables of three given, one a table no check of the checkpoint reads, report both names, in `spec.inputs` order; one mismatch reports exactly it; a table with the right sha is absent; an unreadable table is `table-invalid` and absent; 21 mismatched names cap at 20 with `inputsTotal` 21; a green run adds no hash work (spy on `tableShaOf`); `detail` byte-identical to today (golden); `rubricSha` unchanged; the audit line of the fault stays within `MAX_LINE_BYTES`; fresh frozen object per result.

### 11.8 Refused (recorded in #82; do not re-litigate without new evidence)

- `findColumn`, fwdloop's: a guess over the whole sheet (reading the whole input and picking a column); bareguard judges a specific column it is handed, and `checkTables` only says whether a named column exists.
- `covers` validation: `covers` is fwdloop's own field (which `~` rules a check verifies); it is stripped before bareguard and bareguard never sees it.
- "A table-only step has nothing to answer" as a refusal: that is fwdloop's step design; a checkpoint holding only `table` checks is legal and `runTableChecks` serves it.
- Plain-words naming and sentences for problems: callers render their own from the typed problems and gaps (the `createRubric` message is the only prose).
- CSV parsing: reading, not judging; callers pass typed rows. Reopen only if two parsers hand one file different `tableSha`s.
- Refusing two checks that share a claim name: bareloop shares one claims box across `cited` checks by design (L1, 49 stages); `claimSchema` is per check.

### 11.9 Conflicts between this design and the current code (found while verifying)

1. No structured claim definition exists: `claim` is prose in `OPS` and `CLAIM_KEYS` maps key to kind only; `claimSchema` needs a new structured table (11.5), and the prose says `string[]` for `rows` `keys` while the code takes numbers when `valueKind` is `number`, and says `string|number` for `lookup` where the signed `valueKind` decides.
2. `createRubric` stops at its first refusal, so `checkTables`' `refused` is "all" only for cells-family checks via `signedProblem` (11.2); a drafter with a refusal elsewhere sees one.
3. Table-sha mismatch is checked per table, lazily, per check (`makeEnv`); `fault.inputs` needs a call-wide pass and a `stop()` extras slot (11.7). Today a mismatched table no check of the checkpoint reads is never hashed.
4. `rubricVocabulary` carries the `where` comparison list only in prose (the cmp list is a code constant); `columnAt` and `cmps` are new, additive fields.
5. The `diff` column fields are read in different headers (`keyColumn` in both, `result` in the AFTER one); the settled design lists no diff rule, so `diff` is scoped narrowly (11.2, 11.4) and OPEN.
6. bareguard has no combined time / date / amount / bare scanner and no date-shaped skip; the pieces exist (11.6) but the pass is new code.

NOT verified in this pass (design only, no code run): that every `columnAt` field's runtime header (diff) is as stated; the behaviour of `normalizeForQuote` on fullwidth / NBSP digits for 11.6 item 9; the exact `readNumber` / `readCurrency` malformed outcomes for each divergence probe (read from the source, none executed); that `snapshotTable` can be reused for `checkTables` without side effects; test counts. The parity POC against fwdloop's real job lines is not run.
