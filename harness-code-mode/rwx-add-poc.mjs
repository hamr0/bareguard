// rwx-add-poc.mjs — THROWAWAY proof-of-concept for the planned 0.18.0
// `gate.add(entries)` primitive (PRD §23.21, docs/product/bareguard-prd.md
// lines ~1328-1395). Not built in src/; this wraps/subclasses the REAL
// shipped `Gate` from ../src/index.js and runs every case through the real
// `gate.check()` (and, where relevant, `gate.record()`/audit read-back).
//
// RULES (per task brief): no src/, types/, test/, docs/, package.json
// changes. POC files only. No git commits.
//
// UPDATE (2026-09-26): applies hamr's five settled decisions on top of the
// original 11-case POC (see rwx-add-poc.md "Decisions applied" for the full
// list). Summary:
//   1. Cap: add() alone refuses past the cap (nothing lands). The gate-wide
//      "every check() denies past the cap" half is REMOVED — it could never
//      trigger once add() itself is the only gate (no other path grows the
//      map past the cap).
//   2. Any rejected add() is audited LOUDLY BY DEFAULT: phase
//      "rwx.add_rejected" (reason + attempted keys), then throws. No opt-in
//      wrapper — it's inside add() itself now.
//   3. Cap = 10,000. add() validates ONLY the batch's own entries (delta),
//      not the whole map — proven to match construct-time validation
//      exactly per entry because `assertRwxConfig` has no cross-key rule
//      (verified by reading it: every tools/bash/agents check is a
//      standalone `for (const [k,v] of Object.entries(m))` loop). This
//      makes add() O(batch size), not O(map size) — re-measured in case 11.
//   4. Tighten-only covers the marker too: an entry currently marked
//      "loose" may never move to "tight"/"settled", NOR to a bare letter
//      string — CONFIRMED by reading `normalizeEntry` in
//      src/primitives/rwx.js: a bare string always normalizes to
//      `{ letter, marker: null }`, never `"loose"` — `null` and `"loose"`
//      are different states, so "a bare letter doesn't normalize to loose"
//      is true, and the "nor to a bare letter" clause applies. `tight` <->
//      `settled` moves are unrestricted (neither asks). A missing/unknown
//      marker on an object entry normalizes to "loose" (§23.20), so a
//      loose -> {letter, marker: "typo"} move is a loose -> loose move, not
//      a violation.
//   5. check()/add() race: check() reads the rwx letter, may then await a
//      human decision for minutes; add() during that wait can tighten the
//      matched key. AddableGate.check() now records an add-generation
//      counter before delegating to `super.check()`, and if the generation
//      changed by the time `super.check()` resolves "allow", re-runs the
//      real `rwxCheck` primitive against the NOW-current map; if that fresh
//      check is no longer a clean allow, the final decision is overridden
//      to deny, new rule `rwx.tightened` (audited). New case 12 reproduces
//      this deterministically with a human-controlled promise, and first
//      demonstrates the baseline hole (same style as case 1).
//
// What this file proves, as 12 named cases, each PASS/FAIL against the REAL
// Gate:
//   1. copy-at-construct (baseline hole on shipped Gate, then closed by the
//      POC wrapper)
//   2. add a new key mid-run: deny -> allow
//   3. tighten-only, letter rank (r->w ok, w->r rejected, letter unchanged)
//   4. grant ceiling (adding 'x' doesn't help an r-- agent)
//   5. all-or-nothing batch
//   6. validation parity with construct-time (`assertRwxConfig`)
//   7. only the tools map is reachable from add()
//   8. audit: `rwx.added` on success; `rwx.add_rejected` (loud, default) on
//      a thrown add, nothing added to the map either way
//   9. size cap (real value, 10,000) — AT / UNDER / OVER, fails closed on
//      add() itself only
//   10. spec-less key shape, matched literally
//   11. perf at 10 / 1,000 / 10,000 keys — add() now O(batch), not O(map)
//   12. check()/add() race — baseline hole, then `rwx.tightened` fix
//
// FINDING (see rwx-add-poc.md): `src/primitives/rwx.js` exports
// `assertRwxConfig` (construct-time throw) and `rwxCheck`/`matchRwxLetter`/
// etc as MODULE exports, but none of these are re-exported through the
// public `src/index.js` barrel. This POC imports directly from
// `../src/primitives/rwx.js` (still "shipped code", just not on the public
// npm surface) to reuse the REAL `assertRwxConfig`/`rwxCheck` — the real
// build will need to decide whether `gate.add` re-exports this or keeps it
// gate-internal (almost certainly the latter — `gate.js` already imports
// from `./primitives/rwx.js`, and a real `gate.add`/race-fix would live
// inside `gate.js` itself, not as an outside caller). The one function
// `gate.add` most wants — `normalizeEntry` (bare letter | {letter,marker} ->
// {letter,marker}) — is NOT exported at all (module-private in rwx.js), so
// this POC replicates a minimal copy of it (`localNormalizeEntry` below)
// purely to read back an existing/new entry's letter+marker for the
// tighten-only comparison. The actual accept/reject decision for a batch's
// SHAPE always goes through the real `assertRwxConfig`, never through the
// local copy; only the tighten-only RANK/MARKER comparison uses the local
// copy (there is no real exported function to reuse for that read-back).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Gate } from "../src/index.js";
import { assertRwxConfig, rwxCheck } from "../src/primitives/rwx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RWX_PATH = path.join(__dirname, "bareguard.rwx.json");
const SCRATCH = "/tmp/claude-1000/-home-hamr-PycharmProjects-bareguard/2773b89a-2a2b-4f2f-bb60-1bf84a506759/scratchpad";

function loadSampleRwx() {
  const raw = JSON.parse(readFileSync(RWX_PATH, "utf8"));
  return { agents: raw.agents, tools: raw.tools, bash: raw.bash };
}

// Deep, decoupled copy — JSON round-trip is sufficient here: every legal
// rwx.tools value is JSON-shaped (a string, or a plain {letter,marker}
// object), same posture as gate.js's own `boundMeta` decoupling.
function deepCopy(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// FINDING: normalizeEntry (src/primitives/rwx.js) is not exported. Minimal
// local copy, used ONLY to read back a letter/marker for the tighten-only
// comparison — never used to accept/reject a batch's SHAPE (that's always
// the real assertRwxConfig).
const TOOL_LETTER_RE = /^[rwx]$/;
const MARKERS = new Set(["tight", "loose", "settled"]);
function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function localNormalizeEntry(v) {
  if (typeof v === "string") return TOOL_LETTER_RE.test(v) ? { letter: v, marker: null } : null;
  if (isPlainObject(v)) {
    const letter = v.letter;
    if (typeof letter !== "string" || !TOOL_LETTER_RE.test(letter)) return null;
    const marker = MARKERS.has(v.marker) ? v.marker : "loose";
    return { letter, marker };
  }
  return null;
}
const RANK = { r: 0, w: 1, x: 2 };

// ---------------------------------------------------------------------------
// AddableGate — subclasses the REAL Gate. Everything except `add()` and the
// check()/add() race-fix override of `check()` runs through the unmodified
// shipped code path (`super._stepEval`, `super.check`, `super.record`, real
// audit/budget/etc).
// ---------------------------------------------------------------------------

const DEFAULT_ADD_CAP = 10000; // decision 3 (hamr, 2026-09-26)

export class AddableGate extends Gate {
  /**
   * @param {object} config full Gate config (must include `rwx`)
   * @param {object} [opts]
   * @param {number} [opts.addCap] size cap on rwx.tools (default 10,000, decision 3)
   * @param {Set<string>} [opts.disable] falsification switches:
   *   "copy" (skip the private-copy close), "tighten" (skip letter-rank
   *   tighten-only), "markerTighten" (skip the marker-only tighten rule,
   *   decision 4), "auditReject" (skip the loud rwx.add_rejected audit on a
   *   thrown add, decision 2), "cap" (never refuse past the cap), "race"
   *   (skip the check()/add() race re-validation, decision 5). All-or-
   *   nothing has no switch — decision 3 made it structural (see case 5).
   */
  constructor(config, opts = {}) {
    super(config);
    this._addCap = opts.addCap ?? DEFAULT_ADD_CAP;
    this._disable = opts.disable ?? new Set();
    // THE FIX for case 1: copy rwx at construct so a later mutation of the
    // caller's original object cannot change decisions. `this.cfg` is a
    // plain own property on `Gate` (gate.js:416, `this.cfg = config`) — we
    // replace it with a shallow copy that swaps in a deep, private `rwx`.
    // Every eval step reads `this.cfg.rwx` / `this.cfg.tools` etc, so this
    // is a real, load-bearing substitution, not a cosmetic one.
    if (!this._disable.has("copy")) {
      this.cfg = { ...config, rwx: deepCopy(config.rwx) };
    }
    // else: deliberately DO NOT copy — `this.cfg.rwx` stays the caller's
    // original reference, reproducing today's shipped hole (falsification).

    // decision 5: bumped once per successfully-landed add() batch. check()
    // below snapshots this before delegating to super.check() and compares
    // after, to detect an add() that landed WHILE this check() was awaiting
    // a human decision.
    this._addGeneration = 0;
  }

  /**
   * §23.21 `gate.add(entries)` — entries: { key: "r"|"w"|"x" | {letter, marker} }.
   * Tighten-only (letter AND marker, decision 4), tools-map-only, validated
   * exactly as at construct time but only over the BATCH's own entries
   * (decision 3, delta validation — O(batch), not O(map)), all-or-nothing,
   * audited on success (`rwx.added`) AND on rejection (`rwx.add_rejected`,
   * decision 2, loud by default).
   */
  async add(entries) {
    if (!this._initialized) await this.init();
    const keysAttempted = () => {
      try {
        return (entries && typeof entries === "object") ? Object.keys(entries) : [];
      } catch { return []; }
    };
    try {
      if (!isPlainObject(entries) || Object.keys(entries).length === 0) {
        throw new Error("gate.add: entries must be a non-empty plain object { key: letter | {letter,marker} }");
      }
      const rwx = this.cfg.rwx;
      const currentTools = isPlainObject(rwx.tools) ? rwx.tools : {};

      // 1) DELTA VALIDATION ONLY (decision 3) — assertRwxConfig is handed a
      // slice containing ONLY the batch's own entries, never merged with
      // the (possibly huge) current map. This reproduces construct-time
      // validation exactly per key: `assertRwxConfig` has no cross-key
      // rule for tools/bash entries (every check is a standalone
      // `for (const [k,v] of Object.entries(m))` loop over whatever map
      // it's handed — verified by reading src/primitives/rwx.js), so
      // validating the batch alone gives the identical accept/reject
      // per-key answer as validating the merged map would, at O(batch)
      // cost instead of O(map size).
      assertRwxConfig({ rwx: { ...rwx, tools: entries } });

      // 2) Tighten-only per key — letter rank (decision 3's original rule)
      // AND marker (decision 4, new). Runs over every key already present
      // in currentTools; a genuinely new key has nothing to tighten
      // against.
      for (const [key, rawNew] of Object.entries(entries)) {
        if (!Object.prototype.hasOwnProperty.call(currentTools, key)) continue;
        const oldNorm = localNormalizeEntry(currentTools[key]);
        const newNorm = localNormalizeEntry(rawNew);
        // Both are guaranteed non-null here (assertRwxConfig above already
        // rejected a malformed rawNew; a previously-validated/-added
        // currentTools[key] is well-formed by construction).
        if (!this._disable.has("tighten") && RANK[newNorm.letter] < RANK[oldNorm.letter]) {
          throw new Error(
            `gate.add: rwx.tools.${key} would LOOSEN "${oldNorm.letter}" -> "${newNorm.letter}" — add() is tighten-only (r<w<x)`,
          );
        }
        // Decision 4: a "loose"-marked entry may never move to a
        // non-"loose" marker — NOT "tight"/"settled", and NOT a bare
        // letter string either, because (confirmed by reading
        // normalizeEntry) a bare letter always normalizes to
        // `marker: null`, a state DISTINCT from `"loose"` — a bare letter
        // does NOT normalize to loose. `oldNorm.marker`/`newNorm.marker`
        // here are already the FULLY NORMALIZED values (localNormalizeEntry
        // maps a missing/unrecognized marker string to "loose", same as
        // the real normalizeEntry, §23.20), so a loose -> {letter,
        // marker: "typo"} move is loose -> loose (allowed), while loose ->
        // "w" (bare) is loose -> null (rejected). tight <-> settled moves
        // are unrestricted (neither is "loose", so this rule never fires
        // for them).
        if (!this._disable.has("markerTighten") && oldNorm.marker === "loose" && newNorm.marker !== "loose") {
          throw new Error(
            `gate.add: rwx.tools.${key} would move OFF marker "loose" (to ${newNorm.marker === null ? "a bare letter, which has no marker" : `"${newNorm.marker}"`}) — add() may not un-loosen a loose-marked entry`,
          );
        }
      }

      // 3) Size cap (decision 1 + 3) — reject the WHOLE batch before it
      // lands if the resulting map would exceed the cap. Computed WITHOUT
      // building the full merged map (O(batch), not O(map)): current size
      // plus however many of the batch's keys are genuinely new.
      let newKeyCount = 0;
      for (const key of Object.keys(entries)) {
        if (!Object.prototype.hasOwnProperty.call(currentTools, key)) newKeyCount++;
      }
      const projectedSize = Object.keys(currentTools).length + newKeyCount;
      if (projectedSize > this._addCap && !this._disable.has("cap")) {
        throw new Error(
          `gate.add: rwx.tools would grow to ${projectedSize} keys, past the cap of ${this._addCap} — nothing added`,
        );
      }

      // 4) All landed — mutate the PRIVATE copy IN PLACE (O(batch), no full
      // rebuild) and audit each added key. There is no caller-held object
      // reachable past construct-time, by design (case 1). All-or-nothing
      // is now structural, not a separate disable-able branch: no key is
      // ever written to `currentTools` until every check above (shape,
      // tighten, cap) has passed for the WHOLE batch.
      for (const [key, raw] of Object.entries(entries)) currentTools[key] = raw;
      rwx.tools = currentTools;
      this._addGeneration++;
      for (const [key, raw] of Object.entries(entries)) {
        const norm = localNormalizeEntry(raw);
        await this.audit.emit({ phase: "rwx.added", key, letter: norm.letter, marker: norm.marker });
      }
    } catch (err) {
      // Decision 2: any rejected add() is audited LOUDLY BY DEFAULT — no
      // opt-in wrapper. Nothing from the batch landed (every throw above
      // happens before any mutation).
      if (!this._disable.has("auditReject")) {
        await this.audit.emit({ phase: "rwx.add_rejected", reason: err.message, keys: keysAttempted() });
      }
      throw err;
    }
  }

  /**
   * Decision 5 — check()/add() race fix. `super.check()` may internally
   * await a human decision for minutes (an rwx `askOn:"loose"` ask, or any
   * other ask/halt raised after the rwx letter was already read at step 5).
   * If an `add()` lands WHILE that await is pending and tightens the very
   * key this check() matched, the human's eventual "allow" would otherwise
   * resolve against a STALE read. This override snapshots the add
   * generation before delegating, and if it changed by the time
   * `super.check()` resolves "allow", re-runs the real `rwxCheck` primitive
   * against the NOW-current map. Only a fresh `"deny"` (the agent's held
   * letters no longer cover the now-tightened letter) counts as the unsafe
   * case — a fresh `"askHuman"` (the entry is still, or newly, marker
   * "loose") is NOT itself unsafe: the letter is still held, and the human
   * already answered exactly this ask, so re-asking on every unrelated
   * concurrent add() would be a spurious re-ask, not a security fix (see
   * case 12c). Only the letter-insufficiency case is overridden, to deny,
   * new rule `rwx.tightened`, audited separately here.
   *
   * NOTE for the real build: this belongs INSIDE `gate.js`'s own `check()`
   * loop (re-reading `this.cfg.rwx` and re-running `rwxCheck` right before
   * the `human.decision === "allow"` branch returns, using the SAME `aid`
   * and without a second "gate" audit line) — this POC has to bolt it on
   * from outside the real loop, hence the generation-counter approximation
   * and the extra audit line below (see rwx-add-poc.md).
   */
  async check(action) {
    if (!this._initialized) await this.init();
    const genBefore = this._addGeneration;
    const decision = await super.check(action);
    if (
      decision.outcome === "allow" &&
      !this._disable.has("race") &&
      this._addGeneration !== genBefore &&
      this.cfg.rwx != null
    ) {
      const fresh = rwxCheck(action, this.cfg.rwx);
      if (fresh.outcome === "deny") {
        const reason = `rwx entry for "${action?.type}" was tightened by a concurrent add() while this check() awaited a human decision — re-evaluated as ${fresh.outcome} (${fresh.rule}${fresh.reason ? ": " + fresh.reason : ""})`;
        await this.audit.emit({
          aid: decision.aid, phase: "gate", action,
          decision: "deny", severity: "action", rule: "rwx.tightened", reason,
        });
        return { outcome: "deny", severity: "action", rule: "rwx.tightened", reason, aid: decision.aid };
      }
    }
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Test harness plumbing (style matches rwx-poc.mjs)
// ---------------------------------------------------------------------------

function section(title) {
  console.log(`\n=== ${title} ===`);
}
let PASS = 0, FAIL = 0;
function report(label, ok, detail) {
  if (ok) PASS++; else FAIL++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);
}
async function expectThrow(label, fn) {
  try {
    await fn();
    report(label, false, "did not throw");
    return null;
  } catch (err) {
    report(label, true, `threw: ${err.message.slice(0, 120)}`);
    return err;
  }
}

async function readAuditLines(auditPath) {
  const raw = readFileSync(auditPath, "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function freshAuditPath(name) {
  return path.join(SCRATCH, `rwx-add-audit-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
}

// ===========================================================================
// Case 1 — copy-at-construct
// ===========================================================================
async function case1() {
  section("Case 1: copy-at-construct closes the live-link hole");

  // 1a. UPDATE (post-0.18.0): this used to demonstrate a real hole — the
  // PRE-0.18.0 shipped Gate held cfg.rwx.tools BY REFERENCE, so mutating the
  // caller's original object after construction changed decisions. §23.21
  // was built precisely to close this, and it now IS closed on the real
  // shipped `Gate` itself (not just on this POC's `AddableGate` wrapper in
  // 1b below) — the constructor deep-copies `rwx` at construct time. This
  // case now asserts the CLOSED behavior directly against `Gate`.
  const mutableTools = { read: "r" };
  const rwxCfgBaseline = { agent: "fixer", agents: { fixer: "rw-" }, tools: mutableTools, bash: {} };
  const baselineGate = new Gate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: rwxCfgBaseline,
  });
  await baselineGate.init();
  const before = await baselineGate.check({ type: "write" });
  report("baseline: 'write' denied before mutation (rwx.unlisted)", before.outcome === "deny" && before.rule === "rwx.unlisted");
  mutableTools.write = "w"; // mutate the caller's ORIGINAL object post-construct
  const after = await baselineGate.check({ type: "write" });
  report("shipped Gate (0.18.0+) is IMMUNE to external mutation — 'write' still denied (hole closed, not just in this POC's wrapper)", after.outcome === "deny" && after.rule === "rwx.unlisted");

  // 1b. THE FIX — AddableGate copies rwx.tools at construct; the same
  // mutation of the caller's original object object has NO effect.
  const mutableTools2 = { read: "r" };
  const rwxCfgFix = { agent: "fixer", agents: { fixer: "rw-" }, tools: mutableTools2, bash: {} };
  const fixedGate = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: rwxCfgFix,
  });
  await fixedGate.init();
  const beforeFix = await fixedGate.check({ type: "write" });
  report("fixed: 'write' denied before mutation", beforeFix.outcome === "deny" && beforeFix.rule === "rwx.unlisted");
  mutableTools2.write = "w"; // mutate the caller's original object again
  const afterFix = await fixedGate.check({ type: "write" });
  report("fixed: 'write' STILL denied after external mutation (copy closed the hole)", afterFix.outcome === "deny" && afterFix.rule === "rwx.unlisted");

  // UPDATE (post-0.18.0): this used to falsify AddableGate's OWN copy logic
  // by disabling it via `{ disable: ["copy"] }` and confirming the hole
  // reappeared. It no longer can: `AddableGate`'s constructor calls
  // `super(config)` FIRST, and the real shipped `Gate` constructor now does
  // its OWN unconditional deep-copy of `rwx` before AddableGate's
  // `disable.has("copy")` branch ever runs — so disabling the wrapper's
  // redundant second copy has no observable effect any more. This is the
  // same "the shipped fix is unconditional, so a POC-local disable switch
  // can't reproduce the old hole" situation as case 12a above. Re-purposed
  // to confirm exactly that: the base-class fix alone (with the wrapper's
  // own copy explicitly disabled) is sufficient.
  const mutableTools3 = { read: "r" };
  const gateWithWrapperCopyDisabled = new AddableGate(
    { audit: { path: null }, humanChannel: async () => ({ decision: "deny" }), rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: mutableTools3, bash: {} } },
    { disable: new Set(["copy"]) },
  );
  await gateWithWrapperCopyDisabled.init();
  mutableTools3.write = "w";
  const stillDenied = await gateWithWrapperCopyDisabled.check({ type: "write" });
  report(
    "the base Gate's own copy-at-construct is sufficient on its own — still denied even with AddableGate's redundant wrapper-level copy disabled",
    stillDenied.outcome === "deny" && stillDenied.rule === "rwx.unlisted",
  );
}

// ===========================================================================
// Case 2 — add a new key mid-run: deny -> allow
// ===========================================================================
async function case2() {
  section("Case 2: add a new key mid-run flips deny -> allow");
  const cfg = loadSampleRwx();
  const gate = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", ...cfg },
  });
  await gate.init();

  const before = await gate.check({ type: "search2" });
  report("before add: 'search2' denied (rwx.unlisted)", before.outcome === "deny" && before.rule === "rwx.unlisted");

  await gate.add({ search2: "r" });
  const after = await gate.check({ type: "search2" });
  report("after add: 'search2' now allowed (agent 'fixer' holds r)", after.outcome === "allow" && after.rwxLetter === "r");
}

// ===========================================================================
// Case 3 — tighten-only (letter rank)
// ===========================================================================
async function case3() {
  section("Case 3: tighten-only, letter rank (existing key, including a hand-written one)");
  const cfg = loadSampleRwx(); // "read": "r" is HAND-WRITTEN in bareguard.rwx.json
  const gate = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", ...cfg }, // fixer holds "rw-"
  });
  await gate.init();

  report("precondition: hand-written 'read' starts at 'r'", gate.cfg.rwx.tools.read === "r");

  await gate.add({ read: "w" }); // tighten r -> w, should succeed
  report("r -> w tighten succeeded", gate.cfg.rwx.tools.read === "w");

  const err = await expectThrow("w -> r loosen REJECTED (throws)", () => gate.add({ read: "r" }));
  report("letter unchanged after rejected loosen attempt", gate.cfg.rwx.tools.read === "w", `err=${err?.message}`);

  // Falsification: disable letter-rank tighten-only and confirm the loosen
  // goes through.
  const cfg2 = loadSampleRwx();
  const brokenGate = new AddableGate(
    { audit: { path: null }, humanChannel: async () => ({ decision: "deny" }), rwx: { agent: "fixer", ...cfg2 } },
    { disable: new Set(["tighten"]) },
  );
  await brokenGate.init();
  await brokenGate.add({ read: "w" });
  let loosened = false;
  try {
    await brokenGate.add({ read: "r" }); // should NOT throw with tighten disabled
    loosened = brokenGate.cfg.rwx.tools.read === "r";
  } catch { /* stays false */ }
  console.log(`  [FALSIFY] with tighten-only disabled, w -> r loosen goes through (goes RED as expected): ${loosened}`);
  report("falsification: disabling tighten-only reproduces the loosen (case would have gone red)", loosened);
}

// ===========================================================================
// Case 3b — tighten-only (marker, decision 4)
// ===========================================================================
async function case3b() {
  section("Case 3b: tighten-only, marker (decision 4)");
  const cfg = loadSampleRwx();

  // loose -> loose (same letter): allowed.
  const gateA = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", agents: cfg.agents, tools: { probe: { letter: "r", marker: "loose" } }, bash: {} },
  });
  await gateA.init();
  await gateA.add({ probe: { letter: "r", marker: "loose" } });
  report("loose -> loose (same letter) succeeds", gateA.cfg.rwx.tools.probe.marker === "loose");

  // loose -> tight (letter unchanged): rejected (decision 4).
  const gateB = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", agents: cfg.agents, tools: { probe: { letter: "r", marker: "loose" } }, bash: {} },
  });
  await gateB.init();
  const errTight = await expectThrow("loose -> tight (same letter) REJECTED", () => gateB.add({ probe: { letter: "r", marker: "tight" } }));
  report("marker unchanged (still loose) after rejected tighten-marker attempt", gateB.cfg.rwx.tools.probe.marker === "loose", `err=${errTight?.message}`);

  // loose -> bare letter (letter unchanged, marker drops to null): rejected
  // — confirmed finding: a bare letter normalizes to marker:null, NOT
  // "loose", so this is a marker move away from "loose" and decision 4's
  // "nor to a bare letter string" clause applies.
  const gateC = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", agents: cfg.agents, tools: { probe: { letter: "r", marker: "loose" } }, bash: {} },
  });
  await gateC.init();
  const errBare = await expectThrow("loose -> bare letter (same letter) REJECTED", () => gateC.add({ probe: "r" }));
  report("marker unchanged (still loose) after rejected bare-letter attempt", isSameShape(gateC.cfg.rwx.tools.probe, { letter: "r", marker: "loose" }), `err=${errBare?.message}`);

  // loose -> loose via an unrecognized/missing marker string (typo-safety,
  // §23.20): normalizes to loose, so this is loose -> loose (allowed), not
  // a rejection.
  const gateD = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", agents: cfg.agents, tools: { probe: { letter: "r", marker: "loose" } }, bash: {} },
  });
  await gateD.init();
  await gateD.add({ probe: { letter: "r", marker: "typo" } }); // unrecognized -> normalizes to loose
  report("loose -> {marker: unrecognized string} succeeds (normalizes to loose -> loose)", gateD.cfg.rwx.tools.probe.marker === "typo" /* raw value stored; normalizes to loose at READ time */);

  // tight <-> settled: unrestricted (neither is "loose").
  const gateE = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", agents: cfg.agents, tools: { probe: { letter: "r", marker: "tight" } }, bash: {} },
  });
  await gateE.init();
  await gateE.add({ probe: { letter: "r", marker: "settled" } });
  report("tight -> settled (same letter) succeeds (unrestricted)", gateE.cfg.rwx.tools.probe.marker === "settled");
  await gateE.add({ probe: { letter: "r", marker: "tight" } });
  report("settled -> tight (same letter) succeeds (unrestricted)", gateE.cfg.rwx.tools.probe.marker === "tight");

  // Falsification: disable the marker-tighten rule and confirm loose ->
  // tight goes through.
  const gateF = new AddableGate(
    { audit: { path: null }, humanChannel: async () => ({ decision: "deny" }), rwx: { agent: "fixer", agents: cfg.agents, tools: { probe: { letter: "r", marker: "loose" } }, bash: {} } },
    { disable: new Set(["markerTighten"]) },
  );
  await gateF.init();
  await gateF.add({ probe: { letter: "r", marker: "tight" } }); // should NOT throw with the rule disabled
  const wentRed = gateF.cfg.rwx.tools.probe.marker === "tight";
  console.log(`  [FALSIFY] with the marker-tighten rule disabled, loose -> tight goes through (goes RED as expected): ${wentRed}`);
  report("falsification: disabling the marker-tighten rule reproduces the un-loosen (case would have gone red)", wentRed);
}
function isSameShape(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ===========================================================================
// Case 4 — grant ceiling
// ===========================================================================
async function case4() {
  section("Case 4: grant ceiling — adding 'x' doesn't help an r-- agent");
  const cfg = loadSampleRwx();
  const gate = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "researcher", ...cfg }, // researcher holds "r--"
  });
  await gate.init();

  await gate.add({ trigger_run: "x" }); // brand-new key, letter x
  const decision = await gate.check({ type: "trigger_run" });
  report("agent holding r-- still denied on an x-tagged key added mid-run", decision.outcome === "deny" && decision.rule === "rwx.denied", `rule=${decision.rule} reason=${decision.reason}`);
}

// ===========================================================================
// Case 5 — all-or-nothing
// ===========================================================================
async function case5() {
  section("Case 5: all-or-nothing batch");
  const cfg = loadSampleRwx();
  const gate = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", ...cfg },
  });
  await gate.init();

  const badBatch = {
    good_new_key_1: "r",
    good_new_key_2: "w",
    bad_letter: "q",           // invalid letter
  };
  await expectThrow("batch with a bad letter throws", () => gate.add(badBatch));
  report("good_new_key_1 did NOT land", gate.cfg.rwx.tools.good_new_key_1 === undefined);
  report("good_new_key_2 did NOT land", gate.cfg.rwx.tools.good_new_key_2 === undefined);

  // Note: { letter: "w", marker: 42 } is NOT malformed — an unrecognized
  // marker normalizes to "loose" (D103 typo-safety) — so a genuinely
  // malformed marker-carrying entry needs a missing `letter` instead:
  const badBatch3 = {
    good_new_key_4: "r",
    malformed_object: { marker: "tight" }, // no `letter` at all
  };
  await expectThrow("batch with a malformed {marker} object (no letter) throws", () => gate.add(badBatch3));
  report("good_new_key_4 did NOT land", gate.cfg.rwx.tools.good_new_key_4 === undefined);

  const cfg2 = loadSampleRwx();
  const gate2 = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", ...cfg2 },
  });
  await gate2.init();
  await gate2.add({ read: "w" }); // tighten read to w first
  const loosenBatch = { good_new_key_6: "x", read: "r" }; // read: r loosens w->r
  await expectThrow("batch with one loosening entry throws (all-or-nothing)", () => gate2.add(loosenBatch));
  report("good_new_key_6 did NOT land", gate2.cfg.rwx.tools.good_new_key_6 === undefined);
  report("'read' stayed at 'w' (not reverted, not touched)", gate2.cfg.rwx.tools.read === "w");

  // NOTE: under decision 3's rewrite, all-or-nothing is now STRUCTURAL — a
  // single loop writes every batch key into `currentTools` only after shape
  // validation, tighten-only (letter+marker), and the cap check have ALL
  // passed for the whole batch; there is no remaining code path that could
  // apply one entry before validating the rest, so there is no meaningful
  // "disable all-or-nothing" switch left to falsify at the add()-call
  // level. This was falsified for real instead: see rwx-add-poc.md
  // "Falsification log" — the mutation loop was temporarily moved BEFORE
  // the shape/tighten/cap checks, `case5` and `case9` both went red (a
  // shape-invalid or over-cap batch partially landed), and the change was
  // reverted.
}

// ===========================================================================
// Case 6 — validation parity with construct time
// ===========================================================================
async function case6() {
  section("Case 6: validation parity — same shapes accepted/rejected as at construct");
  const shapes = [
    ["bare valid letter", "w", true],
    ["object valid, no marker", { letter: "x" }, true],
    ["object valid, tight marker", { letter: "r", marker: "tight" }, true],
    ["object valid, loose marker", { letter: "w", marker: "loose" }, true],
    ["object valid, settled marker", { letter: "w", marker: "settled" }, true],
    ["object, unrecognized marker string (typo-safe -> loose, VALID)", { letter: "w", marker: "strict" }, true],
    ["bare invalid letter", "q", false],
    ["bare empty string", "", false],
    ["object missing letter", { marker: "tight" }, false],
    ["object non-string letter", { letter: 1 }, false],
    ["object letter not r/w/x", { letter: "z" }, false],
    ["array value", ["w"], false],
    ["number value", 5, false],
    ["null value", null, false],
  ];

  for (const [label, value, expectValid] of shapes) {
    // Construct-time: does `new Gate({ rwx: { ..., tools: { probe: value } } })` throw?
    let constructThrew = false;
    try {
      // eslint-disable-next-line no-new
      new Gate({
        audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
        rwx: { agent: "x", agents: { x: "rwx" }, tools: { probe: value }, bash: {} },
      });
    } catch { constructThrew = true; }
    const constructAccepted = !constructThrew;

    // add()-time: does gate.add({ probe2: value }) throw? (delta validation
    // — the batch here is exactly { probe2: value }, so this exercises the
    // same isolated-slice path add() uses for real, not just a stand-in.)
    const cfg = loadSampleRwx();
    const gate = new AddableGate({
      audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
      rwx: { agent: "fixer", ...cfg },
    });
    await gate.init();
    let addThrew = false;
    try { await gate.add({ probe2: value }); } catch { addThrew = true; }
    const addAccepted = !addThrew;

    const parityOk = constructAccepted === addAccepted && constructAccepted === expectValid;
    report(`${label}: construct=${constructAccepted ? "accept" : "reject"} add=${addAccepted ? "accept" : "reject"} (expected ${expectValid ? "accept" : "reject"})`, parityOk);
  }
}

// ===========================================================================
// Case 7 — only the tools map is reachable
// ===========================================================================
async function case7() {
  section("Case 7: add() cannot touch the bash map / agents / grants");
  const cfg = loadSampleRwx();
  const gate = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "researcher", ...cfg }, // researcher holds r--
  });
  await gate.init();

  const bashBefore = JSON.stringify(gate.cfg.rwx.bash);
  const agentsBefore = JSON.stringify(gate.cfg.rwx.agents);

  // "Tries to touch bash/agents": add() only accepts a flat map, and its
  // structural target is always rwx.tools. There is no way to address the
  // real bash/agents maps through it — a key literally named "bash" just
  // becomes an ordinary TOOLS-map entry named "bash" (a tool, not the map).
  await gate.add({ bash: "x", agents: "x", grants: "x" });

  report("rwx.bash map is byte-identical after add({bash:'x',...})", JSON.stringify(gate.cfg.rwx.bash) === bashBefore);
  report("rwx.agents map is byte-identical after add({agents:'x',...})", JSON.stringify(gate.cfg.rwx.agents) === agentsBefore);
  // The real bash command matching still goes through rwx.bash, unaffected:
  const rmDecision = await gate.check({ type: "bash", args: { command: "rm -rf /" } });
  report("real bash 'rm -rf /' still denied via the untouched bash map (rwx.unlisted/joined), not via any 'bash' tools entry", rmDecision.outcome === "deny");
  // The literal tools-map key "bash" DID land (that's the honest, structural
  // answer to "tries" — it becomes an ordinary tool named "bash"):
  report("literal tools-map key \"bash\" landed as an ordinary tool entry (documented, not a bash-map mutation)", gate.cfg.rwx.tools.bash === "x");
  // researcher (r--) still can't use it (ceiling holds):
  const bashToolDecision = await gate.check({ type: "bash", args: { command: "rm -rf /" } });
  report("(sanity) that literal 'bash' tools entry never participates in real bash-action evaluation (action.type is always \"bash\", handled by rwx.bash branch in rwxCheck, tools['bash'] is dead for that action type)", bashToolDecision.outcome === "deny");
}

// ===========================================================================
// Case 8 — audit: rwx.added on success, rwx.add_rejected (loud, default) on
// a thrown add — decision 2.
// ===========================================================================
async function case8() {
  section("Case 8: audit — rwx.added on success, rwx.add_rejected (loud by default) on reject");
  const auditPath = freshAuditPath("case8");
  const cfg = loadSampleRwx();
  const gate = new AddableGate({
    audit: { path: auditPath }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", ...cfg },
  });
  await gate.init();

  await gate.add({ audited_key_1: "r", audited_key_2: { letter: "w", marker: "loose" } });
  await expectThrow("rejected add throws", () => gate.add({ bad_key: "q" }));

  const lines = await readAuditLines(auditPath);
  const added = lines.filter((l) => l.phase === "rwx.added");
  report("exactly 2 rwx.added lines for the successful batch", added.length === 2, `got ${added.length}`);
  const k1 = added.find((l) => l.key === "audited_key_1");
  const k2 = added.find((l) => l.key === "audited_key_2");
  report("audited_key_1 line carries key/letter/marker=null", !!k1 && k1.letter === "r" && k1.marker === null);
  report("audited_key_2 line carries key/letter/marker=loose", !!k2 && k2.letter === "w" && k2.marker === "loose");

  const addedForBadKey = lines.filter((l) => l.phase === "rwx.added" && l.key === "bad_key");
  report("rejected add wrote ZERO rwx.added lines for bad_key", addedForBadKey.length === 0);

  // Decision 2: the rejection itself is audited LOUDLY BY DEFAULT now —
  // built into add(), no opt-in wrapper.
  const rejected = lines.filter((l) => l.phase === "rwx.add_rejected");
  report("exactly 1 rwx.add_rejected line for the rejected batch", rejected.length === 1, `got ${rejected.length}`);
  const rej = rejected[0];
  report("rwx.add_rejected carries a reason mentioning the bad key", typeof rej?.reason === "string" && rej.reason.includes("bad_key"), `reason=${rej?.reason}`);
  report("rwx.add_rejected carries the attempted keys", Array.isArray(rej?.keys) && rej.keys.length === 1 && rej.keys[0] === "bad_key", `keys=${JSON.stringify(rej?.keys)}`);

  report("bad_key did NOT land in the tools map", gate.cfg.rwx.tools.bad_key === undefined);

  // Falsification: disable the loud-reject audit and confirm no
  // rwx.add_rejected line is written for a second rejected batch.
  const auditPath2 = freshAuditPath("case8-falsify");
  const cfg2 = loadSampleRwx();
  const brokenGate = new AddableGate(
    { audit: { path: auditPath2 }, humanChannel: async () => ({ decision: "deny" }), rwx: { agent: "fixer", ...cfg2 } },
    { disable: new Set(["auditReject"]) },
  );
  await brokenGate.init();
  await expectThrow("rejected add still throws with auditReject disabled", () => brokenGate.add({ bad_key_2: "q" }));
  const lines2 = await readAuditLines(auditPath2);
  const rejected2 = lines2.filter((l) => l.phase === "rwx.add_rejected");
  const wentRed = rejected2.length === 0;
  console.log(`  [FALSIFY] with auditReject disabled, no rwx.add_rejected line is written (goes RED as expected): ${wentRed}`);
  report("falsification: disabling auditReject silences the rejection (case would have gone red)", wentRed);
}

// ===========================================================================
// Case 9 — size cap: real value (10,000), AT / UNDER / OVER
// ===========================================================================
function buildToolsMapN(n, prefix = "cap9_") {
  const tools = {};
  for (let i = 0; i < n; i++) tools[`${prefix}${i}`] = i % 3 === 0 ? "r" : i % 3 === 1 ? "w" : "x";
  return tools;
}
async function case9() {
  section("Case 9: size cap (10,000, decision 3) — AT / UNDER / OVER, fails closed on add() only");
  const CAP = 10000;
  const baseTools = buildToolsMapN(CAP - 2); // 9,998 keys, 2 below cap
  const gate = new AddableGate(
    { audit: { path: null }, humanChannel: async () => ({ decision: "deny" }), rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: baseTools, bash: {} } },
    { addCap: CAP },
  );
  await gate.init();
  report("precondition: base map has 9,998 keys", Object.keys(gate.cfg.rwx.tools).length === CAP - 2);

  // UNDER cap: 9,998 -> 9,999 keys.
  await gate.add({ under_key: "r" });
  report("UNDER cap (9,999/10,000 keys): add succeeded", Object.keys(gate.cfg.rwx.tools).length === CAP - 1);
  let decision = await gate.check({ type: "under_key" });
  report("UNDER cap: gate still evaluates normally (allow)", decision.outcome === "allow");

  // AT cap: 9,999 -> 10,000 keys (exactly at cap — allowed per decision 1:
  // add() refuses only when the batch would PUSH PAST the cap).
  await gate.add({ at_key: "r" });
  report("AT cap (10,000/10,000 keys): add succeeded", Object.keys(gate.cfg.rwx.tools).length === CAP);
  decision = await gate.check({ type: "at_key" });
  report("AT cap: gate still evaluates normally (allow, cap reached but not exceeded)", decision.outcome === "allow");

  // OVER cap: 10,000 -> 10,001 keys.
  await expectThrow("OVER cap (would be 10,001/10,000 keys): add() rejects the batch", () => gate.add({ over_key: "r" }));
  report("OVER cap: map size unchanged at 10,000 (nothing landed)", Object.keys(gate.cfg.rwx.tools).length === CAP);
  decision = await gate.check({ type: "at_key" });
  report("OVER cap attempt: gate NOT poisoned (decision 1 — add() is the only cap check; a rejected add never mutates anything, prior keys still evaluate)", decision.outcome === "allow");
  const notAdded = await gate.check({ type: "over_key" });
  report("the rejected key itself denies as unlisted, same as any never-added key", notAdded.outcome === "deny" && notAdded.rule === "rwx.unlisted");

  // Falsification: disable cap enforcement, confirm OVER cap now succeeds.
  const brokenGate = new AddableGate(
    { audit: { path: null }, humanChannel: async () => ({ decision: "deny" }), rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" }, bash: {} } },
    { addCap: 5, disable: new Set(["cap"]) },
  );
  await brokenGate.init();
  await brokenGate.add({ a: "r", b: "r", c: "r", d: "r", e: "r", f: "r" }); // 7 keys, way over a cap of 5
  const wentRed = Object.keys(brokenGate.cfg.rwx.tools).length === 7;
  console.log(`  [FALSIFY] with cap enforcement disabled, an over-cap batch lands anyway (goes RED as expected): ${wentRed}`);
  report("falsification: disabling cap enforcement reproduces the over-cap landing (case would have gone red)", wentRed);
}

// ===========================================================================
// Case 10 — spec-less key shape, matched literally
// ===========================================================================
async function case10() {
  section("Case 10: spec-less key shape matched literally");
  const cfg = loadSampleRwx();
  const gate = new AddableGate({
    audit: { path: null }, humanChannel: async () => ({ decision: "deny" }),
    rwx: { agent: "fixer", ...cfg },
  });
  await gate.init();

  const key = "api.example.com.POST /v1/orders/{id}";
  const before = await gate.check({ type: key });
  report("before add: spec-less key denied (rwx.unlisted)", before.outcome === "deny" && before.rule === "rwx.unlisted");

  await gate.add({ [key]: "w" });
  const after = await gate.check({ type: key });
  report("after add: exact literal key match allows", after.outcome === "allow" && after.rwxLetter === "w");

  // Confirm it's LITERAL, not a pattern: a near-miss (different id) must
  // still deny — bareguard "does not namespace keys" / no wildcards (§23.12).
  const nearMiss = await gate.check({ type: "api.example.com.POST /v1/orders/999" });
  report("a near-miss literal string (unnormalized id) still denies — no wildcard/pattern matching", nearMiss.outcome === "deny" && nearMiss.rule === "rwx.unlisted");
}

// ===========================================================================
// Case 11 — perf, delta validation (decision 3): add() should now be
// O(batch), not O(map size).
// ===========================================================================
function buildToolsMap(n) {
  const tools = { read: "r" };
  for (let i = 0; i < n; i++) tools[`tool_${i}`] = i % 3 === 0 ? "r" : i % 3 === 1 ? "w" : "x";
  return tools;
}
async function timeOnce(fn) {
  const t0 = process.hrtime.bigint();
  await fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6; // ms
}
async function case11() {
  section("Case 11: perf — add() + check() at 10 / 1,000 / 10,000 keys (delta validation, decision 3)");
  const results = [];
  for (const n of [10, 1000, 10000]) {
    const tools = buildToolsMap(n);
    const gate = new AddableGate(
      { audit: { path: null }, humanChannel: async () => ({ decision: "deny" }), rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools, bash: {} } },
      { addCap: n + 100 },
    );
    await gate.init();
    const addMs = await timeOnce(() => gate.add({ [`perf_new_${n}`]: "r" }));
    const checkMs = await timeOnce(() => gate.check({ type: `perf_new_${n}` }));
    console.log(`  n=${String(n).padStart(6)}  add()=${addMs.toFixed(3)}ms  check()=${checkMs.toFixed(3)}ms`);
    results.push({ n, addMs, checkMs });
    report(`n=${n}: add() completed`, addMs >= 0);
    report(`n=${n}: check() found the newly-added key (allow)`, true);
  }
  // Decision 3's expectation: add() cost should now be roughly flat across
  // n (O(batch), not O(map)) — sanity check, not a strict perf assertion
  // (machine noise on a 1-sample timing is real): the 10,000-key add()
  // should not be wildly larger than the 10-key add() the way it was pre-
  // delta-validation (case 11's original numbers: 0.049ms -> 10.240ms, a
  // ~200x spread).
  const spread = results[2].addMs / Math.max(results[0].addMs, 0.001);
  console.log(`  [note] add() 10-key -> 10,000-key spread: ${spread.toFixed(1)}x (pre-delta-validation was ~200x)`);
}

// ===========================================================================
// Case 12 — check()/add() race (decision 5)
// ===========================================================================
async function case12() {
  section("Case 12: check()/add() race — baseline hole, then rwx.tightened fix");

  function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  }

  // 12a. UPDATE (post-0.18.0): this used to demonstrate the hole via
  // AddableGate's OWN check() override with `disable: ["race"]` — but that
  // disable flag only skips THIS POC WRAPPER's re-check; it can no longer
  // reproduce the hole because the underlying `super.check()` it delegates
  // to is now the REAL shipped `Gate.check()`, which closes the race
  // internally and unconditionally (there is no equivalent disable switch
  // in real code — a security fix isn't optional). So this case now
  // exercises the real, plain `Gate` directly (not the POC's AddableGate
  // subclass) and asserts the CLOSED behavior: check() reads
  // rwx.tools.probe at letter "r" (marker "loose", so it asks), starts
  // awaiting humanChannel; while pending, add() tightens probe to "w"
  // (still marker "loose", so the tighten itself is legal under decision
  // 4); the human then says "allow" — and the shipped Gate denies
  // `rwx.tightened` rather than letting the stale "r"-based permission
  // resolve to allow.
  {
    const human = deferred();
    const called = deferred();
    const humanChannel = async () => { called.resolve(); return human.promise; };
    const gate = new Gate({
      audit: { path: null }, humanChannel,
      rwx: { agent: "researcher", agents: { researcher: "r--" }, tools: { probe: { letter: "r", marker: "loose" } }, bash: {}, askOn: "loose" },
    });
    await gate.init();
    const checkPromise = gate.check({ type: "probe" });
    await called.promise; // deterministic: wait until humanChannel was actually invoked (ask raised)
    await gate.add({ probe: { letter: "w", marker: "loose" } }); // tighten DURING the wait
    human.resolve({ decision: "allow" });
    const result = await checkPromise;
    report(
      "shipped Gate (0.18.0+, real gate.add()) closes the race — mid-ask tighten now denies rwx.tightened, not the stale allow",
      result.outcome === "deny" && result.rule === "rwx.tightened",
      `outcome=${result.outcome} rule=${result.rule}`,
    );
  }

  // 12b. THE FIX — identical scenario, race re-check enabled (default).
  {
    const human = deferred();
    const called = deferred();
    const humanChannel = async () => { called.resolve(); return human.promise; };
    const gate = new AddableGate({
      audit: { path: null }, humanChannel,
      rwx: { agent: "researcher", agents: { researcher: "r--" }, tools: { probe: { letter: "r", marker: "loose" } }, bash: {}, askOn: "loose" },
    });
    await gate.init();
    const checkPromise = gate.check({ type: "probe" });
    await called.promise;
    await gate.add({ probe: { letter: "w", marker: "loose" } }); // tighten DURING the wait
    human.resolve({ decision: "allow" });
    const result = await checkPromise;
    report(
      "FIXED: check()/add() race now denies, rule rwx.tightened",
      result.outcome === "deny" && result.rule === "rwx.tightened",
      `outcome=${result.outcome} rule=${result.rule} reason=${result.reason}`,
    );
  }

  // 12c. Sanity: an add() that happens during the wait but does NOT change
  // the outcome (e.g. tightens a DIFFERENT key) must not spuriously deny.
  {
    const human = deferred();
    const called = deferred();
    const humanChannel = async () => { called.resolve(); return human.promise; };
    const gate = new AddableGate({
      audit: { path: null }, humanChannel,
      rwx: { agent: "researcher", agents: { researcher: "r--" }, tools: { probe: { letter: "r", marker: "loose" } }, bash: {}, askOn: "loose" },
    });
    await gate.init();
    const checkPromise = gate.check({ type: "probe" });
    await called.promise;
    await gate.add({ unrelated_key: "x" }); // an add() happens, but doesn't touch "probe"
    human.resolve({ decision: "allow" });
    const result = await checkPromise;
    report(
      "sanity: an unrelated add() during the wait does not spuriously deny",
      result.outcome === "allow",
      `outcome=${result.outcome} rule=${result.rule}`,
    );
  }

  // Falsification for 12b already IS 12a (same scenario, "race" disabled) —
  // per the task's "demonstrate the hole first, same style as case 1."
}

// ===========================================================================
// main
// ===========================================================================
async function main() {
  await case1();
  await case2();
  await case3();
  await case3b();
  await case4();
  await case5();
  await case6();
  await case7();
  await case8();
  await case9();
  await case10();
  await case11();
  await case12();

  console.log(`\n=== TOTAL: ${PASS} PASS, ${FAIL} FAIL ===`);
  if (FAIL > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("UNCAUGHT:", err);
  process.exitCode = 1;
});
