---
type: product
title: "Declared result checks — deterministic facts against enumerated rules (DRAFT)"
status: draft
---

# Declared result checks — DRAFT

*2026-10-06. Written by session tree-ab (bareloop) at the guard session's request. Source:
bareloop's rubric (soft-green) spec — bareloop `docs/product/PRD.md` item 33 "2026-10-06 —
rubric job shape" (R0–R14) and `docs/logs/RUBRIC-LEARNINGS.md`, commit b59ce52 on bareloop
`chore/fix-ledger`. Nothing here is built. Anything marked **OPEN** is undecided, with options.
No versions are picked.*

## 1. The boundary change (RULED — hamr, 2026-10-06)

**Old line:** "bareguard never runs an LLM and never judges: you compute the fact."
**New line:** **"bareguard never runs an LLM; it checks deterministic facts against declared,
enumerated rules."**

What stays: Axis B law — a red check is a FACT. It annotates through the existing sinks (audit
line, `drainAnnotations`, riding the next ask via `routeAnnotation`) and **never blocks on its
own**. Routing is unchanged: `surface × reversible × knob`.

**One tension to settle with it (OPEN).** Part 1 §6 says bareguard constrains actions, "never
words the model produces", and axis-b.md's OQ1 note says the checks read "a structured return
field … no text scan". Numeric and membership rules stay inside that. **`quoteIn` (§3) does
not**: it scans a returned string for another string. Options:
- **A.** Amend §6: "bareguard may compare declared values byte-for-byte; it never interprets
  meaning." `quoteIn`/`agree` ship as rules and as pure functions.
- **B.** Keep §6 as is: `quoteIn`/`agree` ship ONLY as exported pure functions (a utility the
  caller runs, like `routeAnnotation`), never as declarable rules the gate runs.
- Recommendation: **B for v1** — it delivers the primitives agents can use now without moving §6.

### Every place the old line (or its §6 twin) is stated

| Where | Line | Text |
|---|---|---|
| `README.md` | 115 | "bareguard never runs an LLM and never judges: you compute the fact." |
| `README.md` | 118 | code comment "you compute the fact (a deterministic check); …" |
| `bareguard.context.md` | 1043 | "You compute the fact (a deterministic check, or a caller-side LLM judge …" |
| `src/gate.js` | 189 | `routeAnnotation` JSDoc — "No LLM, no side effects" (still true; keep) |
| `src/gate.js` | 1392 | `annotate` JSDoc — "bareguard NEVER computes the fact (no LLM)" |
| `types/gate.d.ts` | 3, 352 | generated from the two JSDoc blocks above |
| `primitives.json` | 122 (`routeAnnotation`) + the `annotate` entry | generated `when`/`fails` text from the same JSDoc |
| `docs/product/bareguard-prd.md` | 79–80, 197–217 | §0 "the one boundary" + Part 1 §6 (only if option A) |
| `docs/wiki/axis-b.md` | 139, 164–166 | "#2 RESOLVED … the check stays the caller's" + "Part 1 §6 compliance … no text scan" |

Unaffected: decisions-log.md:81 and design-governance.md:108 ("No LLM speculation on halt") —
still true.

## 2. Mapping onto OQ1

OQ1 (axis-b.md:157–164) froze two operators keyed by tool name: **set membership**
(`provenanceIn`/`provenanceNotIn`) and **ordered-enum threshold** (`maxRisk`), "no numeric
comparison, no nesting, no expression language."

| Rule | OQ1? | Real user |
|---|---|---|
| `in` / `notIn` | **= OQ1 membership** | litectx recall provenance |
| `atMost` (ordered enum) | **= OQ1 threshold** | litectx impact risk |
| `max` / `min` (finite number) | **NEW** — OQ1 said no numeric | bareloop: "total under $400"; README's €300 booking |
| `nonEmpty` | **NEW** | bareloop's "happened" check |
| `quoteIn` | **NEW**, text — see §1 tension | bareloop's "cited" check |
| `agree` | **NEW**, compares two results | bareloop's "agreement" check |

Still no nesting and no expression language. The numeric pair is the only widening of the
declarable set; `quoteIn`/`agree` are functions under option B.

## 3. The v1 rule list (question 1)

All rules read ONE field of the result (§4) against an operator-stated value. Unsure = red: a
field that is missing, the wrong type, or throws when read is a red, never a pass.

| Rule | Config | Pass | Red |
|---|---|---|---|
| `in` | `{rule:"in", field, values:[…]}` | value is a string/number `===` one of `values` | not in set, or missing/wrong type |
| `notIn` | `{rule:"notIn", field, values:[…]}` | value present and not in set | in set, or missing/wrong type |
| `atMost` | `{rule:"atMost", field, value, order:[…]}` | `order.indexOf(v) <= order.indexOf(value)` | above, or `v` not in `order` |
| `max` | `{rule:"max", field, value}` | finite number `<= value` | over, NaN/±Inf, non-number, missing |
| `min` | `{rule:"min", field, value}` | finite number `>= value` | under, NaN/±Inf, non-number, missing |
| `nonEmpty` | `{rule:"nonEmpty", field}` | non-empty string, non-empty array, or object with ≥1 own key | empty / null / missing |

Pure functions (option B — exported, no gate needed):

| Function | Returns | Definition |
|---|---|---|
| `quoteIn(quote, source)` | `{ok, why}` | OPEN normalization (below); empty quote = not ok |
| `agree(a, b)` | `{ok, why}` | OPEN equality (below) |

Every rule carries an optional `text` — the operator's words. It explains a red and **never
decides one**.

**Unknown or malformed rule** — follow the config-shape family: construct-time throw (like
`rwx`), and a post-construction swap to an invalid shape denies at `check()` with
`axisB.checks.invalid`. Rule names are a frozen enum; an unknown name is invalid, never ignored.

## 4. Mechanics (questions 2–5)

**2. Entry point — OPEN.**
- **A. Automatic in `record()`** when `axisB.checks[action.type]` is configured. `record()`
  already holds `action`, `result` and `aid` — so the fact joins its action by `aid` for free,
  and a caller cannot forget to check. Recommended.
- **B. Explicit** `gate.verify(action, result, { aid })`. More visible, but one more call to
  forget, and the join depends on the caller passing `aid`.
Either way, checks run only on a recorded result — a denied action has no result to check.

**3. Field addressing.** Flat, like `flags`: `result[field]`, own properties only
(`Object.hasOwn`), read once inside a try/catch (the `readAnnotation` pattern). Missing → red
"field X missing"; wrong type → red; throwing getter → red "field X unreadable". Field names
`__proto__`/`constructor`/`prototype` are refused at construct. **OPEN:** dotted paths
(`body.total`) — real HTTP results nest; v1 flat keeps it small, the caller can flatten.

**4. Output shape.** Reuse the `annotate` envelope, **one fact per checked action** (not per
rule), emitted through the existing `annotate` path so all three sinks and `routeAnnotation`
apply unchanged:
- `surface` — set by bareguard: `true` if any rule is red. This is the deterministic result,
  so bareguard owning it is exactly the boundary change.
- `verdict` — `"broke"` / `"honored"`.
- `where` — the first red's `text` if given, else a generated one-liner
  ("total: stated ≤ 400, returned 409"); clipped at 300 like today.
- `meta` — `{ checks: [{rule, field, ok}], reds: n }`, bounded by the existing `boundMeta`
  (1000 bytes). Returned values in `meta` are clipped to 120 bytes each.
- **OPEN:** emit an `honored` fact when every rule passes, or stay silent? Silent keeps the
  audit small; emitting proves the checks ran. Lean: emit — "checked and passed" and "never
  checked" must not look the same.

**5. sha256 — agree with guard: audit primitive, not a rule.** bareguard can only hash bytes it
is given, and `result` is an object with no canonical serialization. So: `record(action, result,
{ aid, bytes })` — when the caller passes `bytes` (Buffer or string), the record line carries
`bytesSha256` (hex) of exactly those bytes; no `bytes`, no field. Never a serialization of
`result`. It is on the SemVer surface (an audit field). **OPEN:** whether a string is hashed as
UTF-8 (lean yes, stated in the contract).

## 5. quoteIn / agree (questions 6–7)

**6. quoteIn.** The caller holds the frozen source and passes it; bareguard holds nothing between
calls. Size cap **OPEN** (lean 5 MB; over the cap = not ok "source too large" — unsure = red).
Normalization **OPEN**:
- **A. Byte-exact substring.** Simplest, no false passes, fails on reflowed whitespace.
- **B. bareloop's rule** (`src/judged.js` `unquoted()`): every trimmed, non-empty line of the
  quote appears as a trimmed line of the source — "a half-invented quote is an invented quote".
- **C.** B plus Unicode NFC.
Lean **B** (proven in bareloop, line-anchored, tolerant only of indentation).

**7. agree.** Over two caller-supplied values. **OPEN:** strict `===` for scalars and
canonical-JSON equality for objects (lean), vs. normalized (trim/case) strings. Under option B
there is no "which field" question — the caller picks the values.

## 6. Bounds, interactions, security (questions 8–10)

**8. Audit bounds.** Quotes and sources never go on an audit line. `where` (≤300) and `meta`
(≤1000, per-value 120) are bounded at the source, then redacted, then line-capped by the existing
`LINE_FIELDS` path — no new `LINE_FIELDS` row needed if the fact rides `annotate`. A new row is
needed only for `bytesSha256` (fixed 64 hex chars, `clip`).

**9. Interactions.**
- `rwx` / `tools.allowlist` modes: independent — checks key on `action.type`, exactly like
  `axisB.reversible`; both modes reach `record()`.
- Budget: a check spends nothing (no model, no network). `record()`'s accrual is unchanged.
- `humanChannel`: reached only through the existing ask-riding (`annotations` on `HumanEvent`).
  No new escalation — **I do not argue for one**: a red fact on an irreversible action already
  rides the A-stop, and a reversible one rides the next ask under the `strict` knob.

**10. Security.**
- No user-supplied regex in any rule → no ReDoS.
- Config read via own keys on a null-prototype copy (`safeAction` pattern); `__proto__` field
  names refused.
- Never throws because of the result (any shape, any getter) — a read failure is a red fact.
- An audit **write** failure still propagates, as in every phase.
- `quoteIn` is linear in source size (`indexOf` / line set), with the size cap.

## 7. Dropped

- **"Unparseable" as a bareguard outcome — DROPPED** (guard is right): bareguard never knows a
  result's shape. The declared form covers it: a field that is missing or the wrong type is
  already a red. Parsing a model's output stays the caller's.
- **Repetition / a second LLM read** — the caller runs both reads; bareguard only compares
  (`agree`).

## 8. Also taken (no runtime surface)

- **Policy mutation test helper** — a test recipe generating variants of a forbidden action
  (`rm -rf`, `rm  -fr`, `/bin/rm -rf`, `sh -c "sudo …"`) and asserting `denyPatterns` denies
  every one. Lives in `test/` + a `bareguard.context.md` recipe; not exported. **OPEN:** export it
  for adopters to test their own policies.
- **Fixed URL vs search scope** — a `bareguard.context.md` recipe: `net` allow of one exact URL
  ("only this page") vs a domain list ("search, but only within these domains").

## 9. SemVer surface added (question 11)

| Kind | Added |
|---|---|
| exports | `quoteIn`, `agree` (names OPEN) |
| config keys | `axisB.checks` — `{ [actionType]: Rule[] }` |
| rule strings | `in`, `notIn`, `atMost`, `max`, `min`, `nonEmpty`; deny rule `axisB.checks.invalid` |
| audit fields | `bytesSha256` on `record`; checks ride the existing `annotate` phase (`meta.checks`) |
| record opts | `bytes` |
| primitives.json | entries for `quoteIn`, `agree`; updated `annotate` / `record` text |

## 10. Test plan (question 12)

- Each rule: pass, red, and **falsify-by-revert** (flip the comparison in the source, the test
  must fail).
- `max`/`min`/`atMost`: AT / UNDER / OVER probes (`400` vs `max 400` passes; `400.01` reds).
- Hostile inputs: missing field, wrong type, NaN/±Inf, throwing getter, Proxy, `__proto__`
  field name — each a red fact, never a throw.
- Config: unknown rule → construct throw; post-construction swap → `axisB.checks.invalid` deny.
- Audit: a 10 MB result value still yields a line ≤ `MAX_LINE_BYTES`; a secret in a returned
  value is redacted in `where`/`meta`.
- Join: the emitted fact's audit line carries the same `aid` as its `record` line.
- `quoteIn`: verbatim pass, one invented line red, reflowed indentation (per the chosen
  normalization), source over cap red.
- Byte-identical decision path when `axisB.checks` is unset (existing Axis B guarantee).

## 11. Day 1 vs later (question 13)

| | What | Why |
|---|---|---|
| **Day 1** | `quoteIn`, `agree` as pure exports | usable by agents and bareloop immediately; no gate change; no §6 change |
| **Day 1** | mutation-test recipe, fixed-URL-vs-search recipe | docs + tests only |
| Later | `axisB.checks` with `in`/`notIn`/`atMost` | the OQ1 freeze — when litectx or bareloop asks |
| Later | `max`/`min`/`nonEmpty` | first real user is bareloop's rubric jobs, not built yet |
| Later | `bytesSha256` | bareloop freezes and hashes its own sources today (item 33); needed when a second consumer wants gate-side provenance |
