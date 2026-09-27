# rwx-add POC — findings (throwaway, not shipped)

Design doc: PRD §23.21 (`docs/product/bareguard-prd.md`, ~line 1328 pre-update, see the
PRD's own updated line pointer after this session's edit), read alongside §23.3, §23.4,
§23.20. Code: `rwx-add-poc.mjs`, reusing the sample `harness-code-mode/bareguard.rwx.json`
written for the earlier rwx POC. `src/`, `types/`, `test/`, `docs/`, `package.json` untouched.

Run: `node harness-code-mode/rwx-add-poc.mjs` — **82 PASS, 0 FAIL, exit 0.**
`npm test` — **454/454 pass**, unaffected.

## Post-build update (0.18.0 shipped in `src/`; this POC edited, off-limits lifted)

`gate.add()`, the copy-at-construct fix, and the check()/add() race fix are now real,
shipped code in `src/gate.js`/`src/primitives/rwx.js` — this POC was originally throwaway
and off-limits to edit once that landed, but the orchestrator lifted that restriction for
this specific cleanup: several of THIS POC's own "baseline hole" demonstrations stopped
being reproducible once the real fixes shipped, because they were built to disable a
switch on the POC's own `AddableGate` wrapper — a switch the shipped code has no
equivalent of (a security fix isn't optional), and which the wrapper's `super()` call now
runs INTO regardless of the wrapper's own local disable flags.

Three cases were edited, all from "demonstrate the hole" to "confirm the shipped fix
closes it," using the REAL `Gate` directly where that's now possible instead of the POC's
`AddableGate` stand-in:

1. **Case 1a** (copy-at-construct baseline): previously constructed a plain, unmodified
   `Gate` and showed external mutation of the caller's `rwx.tools` object flipped a
   decision (`deny -> allow`). Now asserts the shipped `Gate` (0.18.0+) is immune to the
   same mutation — `write` stays denied `rwx.unlisted` before AND after.
2. **Case 1's own falsification sub-block**: previously disabled `AddableGate`'s local
   copy (`disable: ["copy"]`) and confirmed the hole reappeared, proving that wrapper-level
   copy was load-bearing. It no longer can: `AddableGate`'s constructor calls `super()`
   first, and the real `Gate` constructor now does its OWN unconditional deep-copy before
   the wrapper's disabled branch ever runs. Re-purposed to confirm the opposite and equally
   load-bearing fact: the BASE class's fix alone is sufficient — still denied even with the
   wrapper's redundant copy explicitly turned off.
3. **Case 12a** (check()/add() race baseline): previously used `AddableGate` with
   `disable: ["race"]` to reproduce the stale-allow hole. Same problem: the wrapper's
   `disable` flag only ever skipped the WRAPPER's own re-check; `super.check()` is the real
   `Gate.check()`, which now closes the race unconditionally. Rewritten to use the real,
   plain `Gate` directly and assert the closed outcome (`deny`, `rwx.tightened`) instead of
   the old hole.

Cases 12b (the fix, via `AddableGate`) and 12c (the per-key sanity case — an unrelated
concurrent `add()` must not spuriously deny) needed **no edits** and now pass again for
real: the orchestrator's review found and the real build fixed a genuine bug this POC's
own escalated decision had introduced (see below) — the fix that made 12c pass again is
in `src/gate.js`, not in this file.

**Bug the orchestrator's review caught (not present in this POC's own design, introduced
during the real build and then fixed there):** the first real-build pass of the
check()/add() race fix gated re-validation on the gate's GLOBAL `_addGeneration` counter —
ANY landed `add()`, anywhere in the tools map, forced a fresh `rwxCheck` on the CURRENTLY
asked key. For a loose-marked entry under `askOn:"loose"`, a fresh check on an entry that
itself never changed always comes back `askHuman` again (asking is what a loose marker
does, unconditionally) — which was then denied as `rwx.tightened` even though nothing
about that key changed. This is exactly case 12c's scenario, and 12c genuinely caught it:
this POC's own decision 5 write-up (below) already got the safety property right — deny
only when THIS key's own entry changed — but the real build's first pass implemented a
coarser, global-generation version of it. Fixed by snapshotting the matched tools-map
entry's own value (not just the generation counter) at the top of the loop, and only
re-running `rwxCheck` when BOTH the generation changed AND this specific entry's value
changed. A bash-map match is structurally exempt from this re-check entirely (`add()`
never touches `rwx.bash`). Falsified in `test/rwx-add.test.js`: reverting to the
global-generation rule turns exactly the new false-deny regression test red (1 failure,
the legitimate-tighten test stays green); forcing the per-key comparison to always report
"unchanged" turns exactly the legitimate-tighten test red (1 failure, the false-deny test
stays green) — confirming the per-key check is load-bearing in both directions, not just
one.

## Decisions applied this session (hamr, 2026-09-26)

Five decisions closed the design forks the original POC pass had escalated. All five are
implemented in `AddableGate` below; PRD §23.21 has been updated to record them as settled
(still PLANNED/not built — 0.17.0 and today's `main` are unaffected).

1. **Size cap: `add()` alone refuses, nothing else.** The original POC's second half — a
   gate-wide `_stepEval` override that denied EVERY action once the map had ever grown past
   the cap — is **removed**. It could never trigger in the first place (the only way the map
   grows is through `add()`, and `add()` now refuses before ever landing a batch that would
   cross the cap), so it was dead code kept "just in case." Past-cap is purely
   "`add()` throws, nothing lands" — no separate poisoned-gate state.
2. **Rejected `add()` is audited loudly BY DEFAULT.** Any thrown `add()` — bad shape, a
   tighten-only violation (letter or marker), or over-cap — now writes one audit line, new
   phase `rwx.add_rejected`, carrying `reason` (the thrown message) and `keys` (the batch's
   attempted keys), THEN rethrows. This is built into `add()`'s own `try/catch`, not an
   opt-in wrapper the caller has to remember to use (the original POC's `addOrAuditReject`
   helper is gone).
3. **Cap = 10,000. Delta validation only.** `add()` no longer merges the batch onto a copy of
   the whole current tools map and re-validates everything (`assertRwxConfig({ tools:
   mergedTools })`, O(map size)). It now calls `assertRwxConfig({ rwx: { ...rwx, tools:
   entries } })` — the SAME real construct-time validator, but handed a slice containing
   ONLY the batch's own entries. This is provably equivalent to whole-map validation
   per-key: reading `assertRwxConfig` in full (`src/primitives/rwx.js:476-549`) shows every
   tools/bash/agents check is a standalone `for (const [k,v] of Object.entries(m))` loop —
   there is no cross-key rule (no uniqueness constraint, no whole-map size check, nothing
   that reads one key's validity off another's). The size cap itself is computed separately,
   also without building the merged map (current key count + however many batch keys are
   genuinely new). The final mutation writes each batch key into the current map IN PLACE,
   one assignment per key — O(batch), never O(map). Case 11's perf numbers below confirm
   this: the pre-change spread from a 10-key map to a 10,000-key map was **~200x**
   (0.049ms → 10.240ms); after the change it's **~28x** (0.057ms → 1.174–1.514ms, noisy at
   this scale but flat by comparison) — the residual scaling comes from `assertRwxConfig`
   also re-validating the UNCHANGED `agents`/`bash` sections every call (small, fixed-size
   maps in this sample file, not the thing that was scaling) plus ordinary V8/GC noise, not
   from the tools map size.
4. **Tighten-only covers the marker too.** `rwx.askOn` is unchanged (still exactly `"none"` |
   `"loose"`). New rule, checked per key alongside the existing letter-rank check: an entry
   currently marked `"loose"` may never move to a non-`"loose"` marker. **Confirmed against
   `src/primitives/rwx.js`'s real `normalizeEntry`**: a bare letter string ALWAYS normalizes
   to `{ letter, marker: null }` — `null`, never `"loose"` — a bare letter does **not**
   normalize to loose (`null` and `"loose"` are two distinct states in this codebase, only
   the object form's *missing/unrecognized* marker string normalizes to `"loose"`, per
   §23.20's typo-safety rule). So the "may never change to a bare letter string" clause in
   the task brief applies: **loose can only move to loose** — not to `tight`, not to
   `settled`, not to a bare letter. `tight <-> settled` moves are unrestricted (neither ever
   asks, so neither move changes what a human sees). A move to an object with a
   missing/unrecognized marker string (e.g. `{ letter: "r", marker: "typo" }`) IS a
   loose -> loose move under this rule (it normalizes to loose at read time), so it's
   allowed — case 3b's "loose -> {marker: unrecognized string}" test covers this explicitly.
5. **check()/add() race — fixed.** `check()` reads the rwx letter (and, for a loose-marked
   entry, may then await a human decision for minutes via `humanChannel`). An `add()` landing
   during that wait can tighten the very key the read-in-progress `check()` matched, so a
   stale letter can ride the human's eventual "allow" through to a decision that no longer
   reflects the current grant. `AddableGate` now tracks an add-generation counter
   (`this._addGeneration`, incremented once per successfully-landed batch) and overrides
   `check()`: it snapshots the generation before delegating to `super.check()`, and if the
   generation changed by the time `super.check()` resolves `"allow"`, it re-runs the real
   `rwxCheck` primitive against the NOW-current map. Only a **fresh `"deny"`** (the agent's
   held letters no longer cover the tightened letter) is treated as unsafe and overridden to
   a terminal `deny`, new rule `rwx.tightened`, audited with its own `phase: "gate"` line. A
   fresh `"askHuman"` (the entry is still, or newly, marker `"loose"`, letter still held) is
   **not** overridden — the human already answered exactly this ask, and letter sufficiency
   hasn't regressed, so re-denying would be a spurious re-ask, not a security fix (case 12c
   proves this: an unrelated `add()` during the same wait must not spuriously deny).

## Architecture

`AddableGate extends Gate` — a real subclass of the shipped `src/gate.js` `Gate`. Every
method except `add()` and `check()` runs the unmodified shipped code path (`super._stepEval`
inside `super.check()`, `super.record`, the real `Audit`/`Budget`/etc). `check()` is
overridden only to bolt on decision 5's race re-check around the otherwise-untouched
`super.check()` call.

- **Constructor**: calls `super(config)` (so the real `assertRwxConfig` throw at construct
  time is completely unchanged), then replaces `this.cfg` with `{ ...config, rwx:
  deepCopy(config.rwx) }` — a JSON round-trip copy of just the `rwx` section (case 1, closes
  the live-reference hole). Initializes `this._addGeneration = 0`.
- **`add(entries)`**: wrapped in one `try/catch`. On the happy path: (1) delta-validate the
  batch alone via the real `assertRwxConfig` (decision 3), (2) per-key tighten-only —
  letter rank then marker (decision 4) — against the current map, (3) size-cap check computed
  from current-count + new-key-count (decisions 1/3), (4) mutate the private tools object IN
  PLACE, bump `_addGeneration`, emit one `rwx.added` line per key. On ANY throw in steps
  1-3: emit `rwx.add_rejected` (reason + attempted keys) BEFORE rethrowing (decision 2) — no
  mutation has happened yet at any throw point, so all-or-nothing is structural, not a
  separate check.
- **`check(action)`**: snapshots `_addGeneration`, delegates to `super.check(action)`
  unchanged, and only if the result is `"allow"` AND the generation moved does it re-run
  `rwxCheck` fresh and possibly override to `rwx.tightened` (decision 5).

## What was proven (case by case)

1. **Copy-at-construct.** Unchanged from the original pass: demonstrated the live-reference
   hole on the real, unmodified shipped `Gate` (mutating the caller's `rwx.tools` object
   after construction flips a decision), then showed `AddableGate` immune to the same
   mutation. Falsified: disabling the copy (`disable: ["copy"]`) reproduced the hole.
2. **New key mid-run.** Unchanged: `search2` denied before `add()`, allowed after.
3. **Tighten-only, letter rank.** Unchanged: hand-written `read: "r"` tightens to `"w"`,
   a follow-up loosen to `"r"` throws, letter stays `"w"`. Falsified: disabling the
   letter-rank check reproduced the loosen.
4. **Tighten-only, marker (NEW, decision 4).** Five sub-cases against a `{letter:"r",
   marker:"loose"}` entry: loose -> loose (same letter) succeeds; loose -> tight (same
   letter) **rejected**; loose -> bare letter (same letter) **rejected** (confirming the
   bare-letter-is-not-loose finding above); loose -> `{marker: unrecognized string}`
   succeeds (normalizes to loose -> loose, per §23.20 typo-safety); tight <-> settled moves
   both succeed, unrestricted. **Falsified**: temporarily forcing the marker-tighten
   condition to `false` reproduced a loose -> tight escape (both the built-in `disable:
   ["markerTighten"]` switch AND a literal source edit-run-revert — see "Falsification log"
   below — confirmed this goes red).
5. **Grant ceiling.** Unchanged: adding `trigger_run: "x"` mid-run to a gate whose agent
   (`researcher`) holds `r--` still denies (`rwx.denied`, not `rwx.unlisted`).
6. **All-or-nothing.** Unchanged in observable behavior, but now STRUCTURAL rather than a
   separate disable-able code branch: three bad batches (bad letter, marker-object missing
   `letter`, one tighten-only violation alongside good new keys) each threw with none of
   the batch's keys landing. There is no longer a meaningful "disable all-or-nothing" switch
   at the `add()`-call level, because a single mutation loop runs only after every check has
   passed for the whole batch — falsified for real instead (see "Falsification log": moving
   the mutation loop before validation made both case 5 and case 9 go red, 15 failures,
   confirming atomicity is genuinely load-bearing there, not incidental).
7. **Validation parity.** Unchanged: the same 14 entry shapes agree between
   `new Gate({ rwx: { tools: { probe: value } } })` and `gate.add({ probe2: value })` — now
   ALSO the exact code path add() uses for real (a single-entry batch), not just a
   stand-in test.
8. **Only the tools map is reachable.** Unchanged: `add({ bash: "x", agents: "x", grants:
   "x" })` leaves the real `rwx.bash`/`rwx.agents` maps byte-identical; the literal string
   key `"bash"` lands as an ordinary (dead, for bash actions) tools-map entry.
9. **Audit — success AND rejection (decision 2, NEW).** A successful 2-key batch wrote
   exactly 2 `rwx.added` lines (read back from the real audit file on disk). A rejected
   `add({ bad_key: "q" })` wrote ZERO `rwx.added` lines AND exactly ONE `rwx.add_rejected`
   line, carrying `reason` (mentions `bad_key`) and `keys: ["bad_key"]` — no opt-in wrapper,
   this is now `add()`'s own default behavior. **Falsified**: disabling the loud-reject
   audit (`disable: ["auditReject"]`) silenced it, confirmed via a second, independent audit
   file. Also falsified for real by literally inverting the `if` condition in the source
   (making loud-reject opt-in instead of default) and confirming 4 failures — see
   "Falsification log."
10. **Size cap — real value, AT/UNDER/OVER (decision 1+3).** Built a 9,998-key map, then:
    UNDER (9,999/10,000) added and evaluated normally; AT (exactly 10,000/10,000) added and
    evaluated normally (decision 1: only PUSHING PAST the cap refuses); OVER (would be
    10,001) threw, map stayed at 10,000, and the gate was **not** poisoned — a subsequent
    unrelated action still evaluates normally (there is no more gate-wide poison state to
    check, decision 1 removed it). Falsified: disabling cap enforcement let a 7-key batch
    land against a cap of 5.
11. **Spec-less key shape.** Unchanged: literal match only, no wildcard/prefix leak.
12. **Perf (decision 3, re-measured).** `add()` + `check()` at 10 / 1,000 / 10,000
    pre-existing keys, real `process.hrtime.bigint()` numbers:

    | keys   | add() (delta validation) | check() |
    |--------|---------------------------|---------|
    | 10     | 0.057 ms                  | 0.111 ms |
    | 1,000  | 0.096–0.111 ms             | 0.058–0.065 ms |
    | 10,000 | 1.174–1.514 ms             | 0.131–0.134 ms |

    `check()` stays flat as before (~0.1 ms, object-key lookup, not map-size-dependent).
    `add()` is now roughly flat too by comparison: **~20-28x** spread from 10 to 10,000 keys
    (varies run to run — single-sample timing noise at sub-millisecond scale — but never
    close to the **original ~200x** spread the whole-map-validation version measured, which
    scaled almost linearly with map size). The residual (not-quite-flat) scaling is NOT from
    `rwx.tools`: `assertRwxConfig` is still handed the (unchanged, small) `agents`/`bash`
    sections on every call and re-validates those too, which is genuinely O(their size) —
    just no longer O(tools map size), which was the actual per-request cost driver in the
    §23.21 spec-less-site flow (one `add()` per unmatched request). **Confirms decision 3's
    expectation**: add() cost is now independent of the pre-existing tools-map size.
13. **check()/add() race (decision 5, NEW).** A gate with `askOn: "loose"` and a
    `{letter:"r", marker:"loose"}` `probe` entry, agent `researcher` (`r--`). A
    human-controlled deferred promise stands in for `humanChannel`.
    - **12a, baseline (fix disabled)**: `check({type:"probe"})` starts, reaches the ask
      (confirmed deterministically via a second deferred promise that resolves the instant
      `humanChannel` is actually invoked — no timing guesswork), THEN `add({probe: {letter:
      "w", marker: "loose"}})` tightens the key (r->w, still loose, so the tighten itself
      is legal under decision 4) WHILE the ask is still pending, THEN the human resolves
      `{decision: "allow"}`. Result: **`outcome: "allow"`** — the stale `r`-based read rides
      through even though `researcher` (`r--`) does not hold `w`. This is the real,
      reproduced hole, not a hypothetical.
    - **12b, fixed (default)**: identical scenario, race re-check enabled. Result:
      **`outcome: "deny", rule: "rwx.tightened"`**, reason names the fresh re-evaluation
      (`rwx.denied: "probe" is tagged "w" but agent "researcher" only holds "r--"`).
    - **12c, sanity**: identical scenario but the concurrent `add()` touches an UNRELATED
      key. Result: **`outcome: "allow"`** — confirms the fix doesn't spuriously deny every
      request that merely overlaps in time with any add(), only ones where the MATCHED
      key's re-evaluation is no longer a clean allow. (First implementation of this fix
      treated any fresh non-`"allow"` outcome — including a still-`"askHuman"` outcome from
      an unrelated add() bumping the generation — as unsafe; this sanity case caught that
      real bug during this session, fixed by narrowing the override to fresh `"deny"`
      specifically. See "Bug found and fixed during this session" below.)
    - Falsified: 12a itself, run with `disable: ["race"]`, IS the falsification for 12b
      (same scenario, fix off) — "demonstrate the hole first," per the task brief. Also
      falsified for real by temporarily removing the `_addGeneration++` bump inside `add()`
      (source edit) and confirming 12b alone went red (1 failure) — see "Falsification log."

## Bug found and fixed during this session

The first implementation of the case-5 race fix treated ANY fresh `rwxCheck` outcome other
than `"allow"` as unsafe (`if (fresh.outcome !== "allow")`). Case 12c (an unrelated `add()`
during the wait) immediately failed: the `probe` entry's marker is still `"loose"`, so a
fresh `rwxCheck` on it always returns `"askHuman"` regardless of whether anything actually
tightened — the override was firing on every concurrent `add()`, not just ones that
genuinely tightened the matched key. Fixed by narrowing the override to fresh `"deny"`
only (the letter-insufficiency case, the one the task's race scenario actually describes);
`"askHuman"` from a still-loose marker is not itself unsafe (letter sufficiency hasn't
regressed, and the human already answered this exact ask). All 82 cases pass after the fix,
including 12c.

## Falsification log (real source edit → run → confirm red → revert)

Per the task brief, these four were falsified with a literal temporary source edit (not
just the built-in `disable` switches, which are ALSO exercised and printed inline on every
run), run, confirmed red, then reverted — verified byte-identical to the pre-edit file via
`diff` after each revert:

1. **Delta validation** (decision 3): replaced the `assertRwxConfig({ rwx: { ...rwx, tools:
   entries } })` call with a no-op comment. Result: **5 failures** (case 5's bad-shape
   batches landed partially, case 8's rejected `bad_key` line lost its real reason). Reverted.
2. **Marker tighten-only** (decision 4): forced the marker-tighten `if` condition to
   `false &&`. Result: **4 failures** (case 3b's loose->tight and loose->bare-letter both
   went through). Reverted.
3. **Loud reject audit** (decision 2): inverted the `if (!this._disable.has("auditReject"))`
   guard to `if (this._disable.has("auditReject"))`, making loud-reject opt-in instead of
   default. Result: **4 failures** (case 8 got zero `rwx.add_rejected` lines on the default
   gate). Reverted.
4. **Race fix** (decision 5): removed the `this._addGeneration++` line from `add()`'s
   success path. Result: **1 failure** (case 12b's fixed scenario no longer detected the
   concurrent tighten, resolved allow same as the baseline). Reverted.
5. **All-or-nothing / cap atomicity** (decisions 1+3, structural claim in case 6 above):
   moved the batch-mutation loop to BEFORE validation instead of after. Result: **15
   failures** across cases 3b, 5, and 9 (bad/loosening batches partially landed; an
   over-cap batch's rejected key stopped denying as unlisted because it had already been
   written). Reverted.

Every revert was verified with `diff` against the pre-edit file (byte-identical) before
moving to the next falsification, and the full suite (`node
harness-code-mode/rwx-add-poc.mjs` = 82/0, `npm test` = 454/454) was re-run clean after the
last revert.

## Findings about the shipped code (unchanged from the original pass)

- **`assertRwxConfig` and `rwxCheck`** (and `matchRwxLetter`, `resolveAgentLetters`,
  `clampLetters`, `matchBash`, `hasJoinMeta`) **are exported** from `src/primitives/rwx.js`
  as ordinary ES module exports, but **none are re-exported through the public
  `src/index.js` barrel**. This POC imports both `assertRwxConfig` (as before) and now also
  `rwxCheck` (new, for decision 5's race re-check) directly from `../src/primitives/rwx.js`.
  Confirmed this session by reading `assertRwxConfig` in full
  (`src/primitives/rwx.js:452-549`): there is genuinely no cross-key rule to lose by
  validating a batch slice instead of the whole map (decision 3's O(batch) claim rests on
  this).
- **`normalizeEntry`** is still module-private; this POC's `localNormalizeEntry` is still a
  ~10-line duplicate, used only to read back a letter+marker for the tighten-only
  comparison — the accept/reject decision on SHAPE always goes through the real
  `assertRwxConfig`.
- **Real build placement (decision 5's fix, in particular)**: this POC's `check()` override
  is an outside-the-loop approximation — it can only compare the FINAL terminal decision
  before/after `super.check()`, not intervene mid-ask the way the real fix should. The real
  fix belongs INSIDE `src/gate.js`'s own `check()` loop, specifically right before the
  `human.decision === "allow"` branch returns (around gate.js:802-811 in the current
  source): re-read `this.cfg.rwx` and re-run `rwxCheck(action, this.cfg.rwx)` there, using
  the SAME `aid` already in scope and the SAME single "gate" audit emit that branch already
  does (just with the overridden outcome/rule/reason when the fresh check is no longer a
  clean allow) — no second audit line, no approximate generation counter needed, because the
  real fix has direct access to the exact moment between "human said allow" and "return."
  This POC's generation-counter approach is a reasonable stand-in for the same PROPERTY
  (add() landed during the wait) but a real implementation shouldn't need it — it can just
  re-read the live `this.cfg.rwx` and compare against what was read at the top of the loop
  iteration.
- **Surprising, not a bug**: `assertRwxConfig` validates whatever `rwx` object it's handed —
  case 6 is genuinely testing add()'s real code path now (not a stand-in), since add() calls
  the exact same function on the exact same kind of single-entry slice case 6 constructs by
  hand.
- The construct-time throw and the runtime `rwx.invalid` fail-closed deny remain two
  different code paths for the same malformed-entry class, unaffected by anything in this
  session.

## Escalated questions

None of the five items above were left undecided — hamr's five decisions this session close
every fork the original POC had escalated. Two smaller, genuinely NEW points came up during
implementation, both resolved conservatively without asking (per the task brief's "choose
the most conservative option"):

1. **Marker rule + a same-letter, same-marker no-op add.** `add({ probe: { letter: "r",
   marker: "loose" } })` when `probe` is already exactly `{letter:"r", marker:"loose"}` is
   treated as a no-op success (loose -> loose, letter unchanged) — case 3b's first sub-case.
   Not explicitly stated in the task brief, but the most conservative reading of "may never
   change to a non-loose marker" is that staying at loose is always fine regardless of
   whether anything actually changed.
2. **Race fix's audit shape.** The real fix (per the note above) would reuse the SAME `aid`
   and emit exactly one "gate" audit line with the overridden outcome. This POC, bolted on
   from outside `super.check()`'s loop, cannot suppress the "allow" gate line `super.check()`
   already wrote before returning — so a race-triggered `rwx.tightened` denial in THIS POC
   produces TWO "gate" audit lines for the same `aid` (one "allow", one "deny"). Flagging
   this as a POC-only artifact, not a design question — the note above already states where
   the real fix avoids it.

## Nothing else escalated

Case 7's "only the tools map is reachable" interpretation remains fully answered
structurally, unchanged from the original pass — no design decision was needed there this
session either.
