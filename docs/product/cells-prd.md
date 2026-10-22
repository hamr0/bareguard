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
- Blank = whitespace-only. Aggregates (sum, average, median, min, max, groupTotals) skip blanks. A blank
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
  unexpected internal exception is `stopped`, never green. Gaps show claimed values and row numbers; the
  expected answer stays in `full`, not in gaps.
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
signed check's `table` (`before` / `after` for `diff`). It is NOT a signed `spec.inputs` entry (no sha): like `measurements` it is a value
the caller measures (Law 11); the signed part is the op, the columns and the formats. A missing, ragged or non-string table is `stopped`
(fault `table-invalid`); a signed column, row or field that cannot apply is `stopped` (`check-invalid`). Each table is copied once per
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
`rows` by keys: `{keys: [...]}` compared as text (`valueKind: "number"` reads numbers); `lookup` requires `valueKind` (text, number, date).
A removed column is always red in `diff`; a new column is red unless listed (`onlyColumnsChanged`) or unless the op is `newColumnRule`.

Gaps: own kinds (listed in `CELLS_GAP_KINDS`), `items` as strings (20 max, `itemsTotal` when cut), `measured`/`limit` for counts and the claimed
value; the expected answer is in `full.expected` only. Faults: `table-invalid`, `check-invalid`, `exception`.

Size caps (measured 2026-10-22 on the dev machine, load < 1; ms, median of 3): at 500,000 cells (50,000 rows x 10) snapshot 34, sum 48,
median 51, countIf 48, rows 61, duplicates 60, groupTotals 67, topN 86, per-row daysSince 93, band with a 100k-key claim 75-160, rowMath 59,
diff of one changed cell 161 (two tables); worst adversarial: diff with EVERY cell changed 330-430 ms. Measured earlier under load, over the cap
(not kept): that every-cell diff at 1,000,000 cells took 739 ms and a one-cell diff at 2,000,000 cells 656 ms, so the cap is 500,000 cells and 16 MiB of characters (a single 32 MiB cell scans in about 170 ms). Over a table cap = red `table-too-large`
(like `cited`'s source-too-large, not stopped: the cap is deterministic and the verdict is a pure function of the inputs); claim lists and maps over
100,000 entries are red `claim-too-large`.

