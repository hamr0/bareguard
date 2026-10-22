---
type: product
title: "cells — a signed rubric check computed over caller-given table rows (PROPOSED)"
status: proposed
---

# cells — PROPOSED spec

Status: PROPOSED. POC in progress (2026-10-22). Not built. No version picked.
Parent spec: [rubric-prd.md](rubric-prd.md) (laws §2, vocabulary §4). Ruling: #67 in rubric-prd.md §12.

## 0. In one paragraph

`cells` is ONE generic rubric check (`rule: "cells"`, like `cited`) that recomputes a declared
operation over table rows the caller hands in and compares the result with a value the step
gives. The operation (`op`) comes from a closed list in `rubricVocabulary`. The signer picks the
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

- ONE generic check kind, `cells`, with an `op` from a closed list. Not one rubric shape per check.
- The whole op list ships on day 1, including the write-side ops ("do all from day 1"), even though
  no consumer writes sheets today.
- The vocabulary is the pre-read menu: the op list is in `rubricVocabulary`. The drafter reads it BEFORE
  committing to a job. A need that maps to no op is red at drafting, so the agent cannot over-commit.
- Flow (like bareloop's page facts): at draft time the agent suggests checks from the vocabulary (for
  example `countIf(Amount, ">500")`), the person signs, the step gives VALUES only, `checkStep`
  recomputes and judges. The step never authors its own formula.
- POC before build.

## 3. Boundary

The caller owns file parsing (CSV/xlsx, quotes, "1,200.50", header names) and hands typed rows: each
cell a string, each row carrying `rowNumber` (2-based, sheet-style). bareguard gets typed rows plus the
signed check. No model, no user regex, no free formula language.

## 4. Op list (PROPOSED, closed)

1. **Read / aggregate over a signed range of one column.** `count`, `countEmpty`, `countIf`, `sum`,
   `sumIf`, `average`, `averageIf`, `median`, `min`, `max`, `found`, `lookup` (the cell in column X on
   the row where K = Y; 0 or more than 1 match = red), `rows` (the claimed set of row numbers must EQUAL
   the matching set exactly: no missing, no extra; claimable by row number, as fwd asked), `topN`,
   `uniqueCount`, `duplicates`, `groupTotals` (sum per distinct group value; the closest it gets to a
   pivot table), `percentOfTotal`.
2. **Row math, fixed ops only.** add, sub, mul, div, pct of two columns, or of a column and a signed
   constant (for example Total = Amount + Tax on every row).
3. **Dates, ISO `YYYY-MM-DD` only (anything else = red).** `daysBetween`, `daysSince(cell, asOf)` where
   `asOf` is a SIGNED fixed date, never the real clock; `earliest`, `latest`; conditions before / after /
   between. Out: business days (they need a holiday calendar).
4. **Conditions.** Number `>` `>=` `<` `<=` `=` and between; text equals exactly (no wildcards);
   empty / notEmpty; AND only, no OR.
5. **Shape checks.** `allNumbers`, `allDates`, `noEmpty`, `noDuplicates`, `rowCount`.
6. **Write side, before table vs after table.** `onlyColumnsChanged`, `rowsAdded` / `rowsDeleted`
   exactly N, a column matches a row-math rule, untouched cells byte-identical. No live caller today
   (fwd: not planned, the natural "after" is a new file beside the frozen "before"; loop: no table jobs).

## 5. Tolerance

A signed absolute tolerance per check. Exact for counts, row sets and dates (fwd agreed; its current
compare is float-noise prone).

## 6. OPEN (hamr rules after the POC)

- **Law 11** ("the caller measures, bareguard only compares", rubric-prd §2): `cells` has bareguard
  recompute aggregates over caller-given rows. It may fit the way `cited` checks quotes against a
  frozen source. Not ruled.
- **Law 5** fit: conditions are a closed operator set, not a regex. Believed to fit. Not ruled.
- POC choices still to rule on:
  - empty-cell handling in `average` / `min` / `max`;
  - number reading beyond stripping `$` and `,`;
  - the default tolerance for averages;
  - `topN` ties;
  - the shape of the `groupTotals` claim;
  - whether the write side stays in `cells` or becomes its own kind.

## 7. Consumers

- **fwdloop**: the live caller. It pauses sheet checks and ships M10 without them. Once `cells` lands it
  will retire its own grammar, if `daysBetween` is included.
- **bareloop**: no need today. If it lands, it adopts the shape as-is. No clash with `cited` / `decides`
  or its page facts (`MAP_SHAPES` in bareloop's `src/pagemap.js`), since `cells` takes typed rows, not
  page text.

## 8. POC

In `.scratch/cells-poc/` (gitignored). It replays fwd's real tries in place and runs synthetic cases
per op.

**Results: TBD.** (Placeholder. Fill from the POC; do not paste fwd's real rows.)

## 9. Next

POC results, then hamr rules the OPEN items, then build, then tell fwd the version.
