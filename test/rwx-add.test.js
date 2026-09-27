// gate.add(entries) — runtime, tighten-only growth of the rwx tools map for
// spec-less sites (PRD §23.21, 0.18.0). Ported from the POC
// (harness-code-mode/rwx-add-poc.mjs / .md), which validated this design
// against the real shipped Gate before it was built into src/gate.js.
//
// Covers: new-key mid-run, tighten-only (letter AND marker), the grant
// ceiling, all-or-nothing, validation parity with construct-time, "only the
// tools map is reachable", the 10,000-key cap (AT/UNDER/OVER), audit lines
// on success AND rejection, hostile-input hardening, and the check()/add()
// race fix.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Gate } from "../src/index.js";
import { rwxCheck } from "../src/primitives/rwx.js";
import { makeTmpDir, cleanup } from "./_helpers.js";

const MAX_LINE_BYTES = 3500;

function gateFor(rwxOverrides = {}, humanChannel) {
  return new Gate({
    audit: { path: null }, // fileless — inspect via gate.audit.readAll()
    rwx: {
      agent: "fixer",
      agents: { researcher: "r--", fixer: "rw-", deployer: "rwx" },
      tools: { read: "r", write: "w", deploy: "x" },
      bash: { "git status": "r", "git commit": "w", "git push": "x" },
      ...rwxOverrides,
    },
    humanChannel: humanChannel ?? (async () => ({ decision: "deny" })),
  });
}

// ─── new key mid-run ──────────────────────────────────────────────────────

test("add: a brand-new key denies before add(), allows after", async () => {
  const gate = gateFor();
  await gate.init();
  const before = await gate.check({ type: "search", args: {} });
  assert.equal(before.outcome, "deny");
  assert.equal(before.rule, "rwx.unlisted");

  await gate.add({ search: "r" });
  const after = await gate.check({ type: "search", args: {} });
  assert.equal(after.outcome, "allow");
  assert.equal(after.rwxLetter, "r");
});

// ─── tighten-only: letter rank ────────────────────────────────────────────

test("add: letter rank tightens (r -> w) but never loosens (w -> r)", async () => {
  const gate = gateFor({ tools: { probe: "r" } });
  await gate.init();
  await gate.add({ probe: "w" }); // r -> w: tighten, ok
  const d1 = await gate.check({ type: "probe", args: {} });
  assert.equal(d1.outcome, "allow");
  assert.equal(d1.rwxLetter, "w");

  await assert.rejects(
    () => gate.add({ probe: "r" }), // w -> r: loosen, rejected
    /would LOOSEN "w" -> "r"/,
  );
  // letter unchanged after the rejected attempt
  const d2 = await gate.check({ type: "probe", args: {} });
  assert.equal(d2.rwxLetter, "w");
});

test("add: an equal letter (no-op) is not a loosen and succeeds", async () => {
  const gate = gateFor({ tools: { probe: "w" } });
  await gate.init();
  await assert.doesNotReject(() => gate.add({ probe: "w" }));
});

// ─── tighten-only: marker ─────────────────────────────────────────────────

test("add: a loose-marked entry may move to loose (same letter) — no-op success", async () => {
  const gate = gateFor({ tools: { probe: { letter: "r", marker: "loose" } } });
  await gate.init();
  await assert.doesNotReject(() => gate.add({ probe: { letter: "r", marker: "loose" } }));
});

test("add: a loose-marked entry may NOT move to tight", async () => {
  const gate = gateFor({ tools: { probe: { letter: "r", marker: "loose" } } });
  await gate.init();
  await assert.rejects(
    () => gate.add({ probe: { letter: "r", marker: "tight" } }),
    /would move OFF marker "loose"/,
  );
});

test("add: a loose-marked entry may NOT move to a bare letter (bare normalizes to marker:null, not loose)", async () => {
  const gate = gateFor({ tools: { probe: { letter: "r", marker: "loose" } } });
  await gate.init();
  await assert.rejects(
    () => gate.add({ probe: "r" }),
    /would move OFF marker "loose".*bare letter/,
  );
});

test("add: a loose-marked entry moving to an unrecognized marker string normalizes to loose -> loose (allowed)", async () => {
  const gate = gateFor({ tools: { probe: { letter: "r", marker: "loose" } } });
  await gate.init();
  await assert.doesNotReject(() => gate.add({ probe: { letter: "r", marker: "typo" } }));
});

test("add: tight <-> settled moves are unrestricted (neither ever asks)", async () => {
  const gate = gateFor({ tools: { a: { letter: "r", marker: "tight" }, b: { letter: "r", marker: "settled" } } });
  await gate.init();
  await assert.doesNotReject(() => gate.add({ a: { letter: "r", marker: "settled" } }));
  await assert.doesNotReject(() => gate.add({ b: { letter: "r", marker: "tight" } }));
});

// ─── grant ceiling ────────────────────────────────────────────────────────

test("add: adding a letter the agent doesn't hold still denies (grant is the ceiling)", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: { agent: "researcher", agents: { researcher: "r--" }, tools: {} },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  await gate.add({ trigger_run: "x" });
  const d = await gate.check({ type: "trigger_run", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.denied"); // listed now, but researcher only holds "r--"
});

// ─── all-or-nothing ───────────────────────────────────────────────────────

test("add: a batch with one bad entry lands NONE of it", async () => {
  const gate = gateFor({ tools: { probe: "w" } });
  await gate.init();
  await assert.rejects(() => gate.add({ good_key: "r", probe: "r" /* loosen */ }));
  const dGood = await gate.check({ type: "good_key", args: {} });
  assert.equal(dGood.outcome, "deny");
  assert.equal(dGood.rule, "rwx.unlisted", "good_key must not have landed even though its own entry was fine");
});

test("add: a batch with a bad SHAPE lands none of it either", async () => {
  const gate = gateFor();
  await gate.init();
  await assert.rejects(() => gate.add({ good_key: "r", bad_key: "q" }));
  const d = await gate.check({ type: "good_key", args: {} });
  assert.equal(d.rule, "rwx.unlisted");
});

// ─── validation parity with construct-time ───────────────────────────────

test("add: the same entry shapes accepted/rejected at construct time agree with add()", async () => {
  const shapes = [
    ["r", true], ["w", true], ["x", true], ["q", false], ["", false],
    [{ letter: "r" }, true], [{ letter: "r", marker: "loose" }, true],
    [{ letter: "r", marker: "typo" }, true], // normalizes to loose
    [{ letter: "q" }, false], [{}, false], [null, false], [42, false], [["r"], false],
  ];
  for (const [value, shouldAccept] of shapes) {
    const constructOk = (() => {
      try { new Gate({ rwx: { agent: "a", agents: { a: "rwx" }, tools: { probe: value } } }); return true; }
      catch { return false; }
    })();
    assert.equal(constructOk, shouldAccept, `construct-time: ${JSON.stringify(value)}`);

    const gate = gateFor();
    await gate.init();
    const addOk = await gate.add({ probe2: value }).then(() => true, () => false);
    assert.equal(addOk, shouldAccept, `add(): ${JSON.stringify(value)}`);
  }
});

// ─── only the tools map is reachable ─────────────────────────────────────

test("add: bash/agents/grants keys are inert tools-map entries, real maps untouched", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.add({ bash: "x", agents: "x", grants: "x" });
  // the REAL bash map is untouched — "git status" still resolves for bash actions
  const dBash = await gate.check({ type: "bash", args: { command: "git status" } });
  assert.equal(dBash.outcome, "allow");
  // the literal string key "bash" landed as an ordinary (dead, for bash
  // actions since those match on cmd, not type) tools-map entry
  const dToolBash = await gate.check({ type: "bash_literal_probe_unused", args: {} });
  assert.equal(dToolBash.rule, "rwx.unlisted"); // sanity: unrelated type still unlisted
  // the agent's own grant is unaffected — still "rw-", not widened by the
  // literal tools-map key named "agents"
  const dGrants = await gate.check({ type: "grants", args: {} });
  assert.equal(dGrants.outcome, "deny"); // "grants" tagged "x"; fixer holds "rw-"
  assert.equal(dGrants.rule, "rwx.denied");
});

// ─── cap: AT / UNDER / OVER ───────────────────────────────────────────────

function bigToolsMap(n) {
  const m = {};
  for (let i = 0; i < n; i++) m[`k${i}`] = "r";
  return m;
}

test("add: cap UNDER (9,999/10,000) lands normally", async () => {
  const gate = gateFor({ tools: bigToolsMap(9998) });
  await gate.init();
  await assert.doesNotReject(() => gate.add({ extra: "r" })); // -> 9,999
  const d = await gate.check({ type: "extra", args: {} });
  assert.equal(d.outcome, "allow");
});

test("add: cap AT exactly 10,000 lands normally (only crossing refuses)", async () => {
  const gate = gateFor({ tools: bigToolsMap(9999) });
  await gate.init();
  await assert.doesNotReject(() => gate.add({ extra: "r" })); // -> 10,000 exactly
  const d = await gate.check({ type: "extra", args: {} });
  assert.equal(d.outcome, "allow");
});

test("add: cap OVER (10,001) refuses, nothing lands, gate is not poisoned", async () => {
  const gate = gateFor({ tools: bigToolsMap(10000) });
  await gate.init();
  await assert.rejects(() => gate.add({ extra: "r" }), /past the cap of 10000/); // would be 10,001
  const d = await gate.check({ type: "extra", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted", "the rejected key must not have landed");
  // gate is not poisoned — an unrelated, already-listed key still evaluates normally
  const d2 = await gate.check({ type: "k0", args: {} });
  assert.equal(d2.outcome, "allow");
});

// ─── audit: success AND rejection ────────────────────────────────────────

test("add: a successful batch writes one rwx.added line per key", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.add({ search: "r", export: { letter: "w", marker: "loose" } });
  const lines = await gate.audit.readAll();
  const added = lines.filter((l) => l.phase === "rwx.added");
  assert.equal(added.length, 2);
  const search = added.find((l) => l.key === "search");
  assert.equal(search.letter, "r");
  assert.equal(search.marker, null);
  const exp = added.find((l) => l.key === "export");
  assert.equal(exp.letter, "w");
  assert.equal(exp.marker, "loose");
});

test("add: a rejected batch writes zero rwx.added lines and one rwx.add_rejected line (reason + keys)", async () => {
  const gate = gateFor();
  await gate.init();
  await assert.rejects(() => gate.add({ bad_key: "q" }));
  const lines = await gate.audit.readAll();
  assert.equal(lines.filter((l) => l.phase === "rwx.added").length, 0);
  const rejected = lines.filter((l) => l.phase === "rwx.add_rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /bad_key/);
  assert.deepEqual(rejected[0].keys, ["bad_key"]);
});

test("add: rejection is audited loudly by DEFAULT — no opt-in needed", async () => {
  const gate = gateFor({ tools: { probe: "w" } });
  await gate.init();
  await assert.rejects(() => gate.add({ probe: "r" })); // tighten-only violation
  const lines = await gate.audit.readAll();
  const rejected = lines.filter((l) => l.phase === "rwx.add_rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /LOOSEN/);
});

// ─── hostile inputs ───────────────────────────────────────────────────────

test("add: no rwx config on this gate — rejects conservatively", async () => {
  const gate = new Gate({ audit: { path: null }, tools: { allowlist: ["read"] } });
  await gate.init();
  await assert.rejects(() => gate.add({ probe: "r" }), /this gate has no rwx config/);
  const lines = await gate.audit.readAll();
  assert.equal(lines.filter((l) => l.phase === "rwx.add_rejected").length, 1);
});

test("add: an empty batch is rejected (1..n, not 0..n)", async () => {
  const gate = gateFor();
  await gate.init();
  await assert.rejects(() => gate.add({}), /non-empty plain object/);
});

test("add: a non-plain-object entries argument is rejected", async () => {
  const gate = gateFor();
  await gate.init();
  for (const bad of [null, undefined, "probe", 42, ["r"], new Map()]) {
    await assert.rejects(() => gate.add(bad), /non-empty plain object/, JSON.stringify(bad));
  }
});

test("add: __proto__/constructor/prototype keys are rejected outright, whole batch", async () => {
  const gate = gateFor();
  await gate.init();
  // JSON.parse creates "__proto__" as a genuine own enumerable property
  // (an object literal would instead set the prototype, never landing as an
  // own key at all — this is the realistic hostile shape, e.g. a harness
  // parsing an untrusted spec response).
  const hostile = JSON.parse('{"good_key":"r","__proto__":"r"}');
  await assert.rejects(() => gate.add(hostile), /not a usable tools-map key/);
  const d = await gate.check({ type: "good_key", args: {} });
  assert.equal(d.rule, "rwx.unlisted", "all-or-nothing: good_key must not have landed either");
});

test("add: constructor/prototype keys as OWN properties are also rejected", async () => {
  const gate = gateFor();
  await gate.init();
  const hostile = Object.create(null);
  hostile.good_key = "r";
  hostile.constructor = "r";
  await assert.rejects(() => gate.add(hostile), /not a usable tools-map key/);
});

test("add: a hostile getter is read EXACTLY ONCE (no TOCTOU between validate and store)", async () => {
  const gate = gateFor();
  await gate.init();
  let calls = 0;
  const entries = {};
  Object.defineProperty(entries, "probe", {
    enumerable: true,
    get() { calls++; return calls === 1 ? "r" : "x"; }, // would smuggle "x" on a second read
  });
  await gate.add(entries);
  assert.equal(calls, 1, "the value must be read exactly once");
  const d = await gate.check({ type: "probe", args: {} });
  assert.equal(d.rwxLetter, "r", "the FIRST read's value must be what actually landed");
});

test("add: a getter that throws marks that key unreadable and fails the whole batch closed (no crash)", async () => {
  const gate = gateFor();
  await gate.init();
  const entries = { good_key: "r" };
  Object.defineProperty(entries, "bad_key", {
    enumerable: true,
    get() { throw new Error("boom"); },
  });
  await assert.rejects(() => gate.add(entries)); // fails shape validation on "[UNREADABLE]"
  const d = await gate.check({ type: "good_key", args: {} });
  assert.equal(d.rule, "rwx.unlisted", "all-or-nothing: good_key must not have landed either");
});

test("add: entries whose Object.keys() itself throws (revoked Proxy) rejects cleanly", async () => {
  const gate = gateFor();
  await gate.init();
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  await assert.rejects(() => gate.add(proxy), /non-empty plain object/);
});

// ─── check()/add() race (§23.21 decision 5) ──────────────────────────────

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("add/check race: an UNRELATED concurrent ask (no add() during the wait) is unaffected", async () => {
  const asked = deferred();
  const human = deferred();
  const gate = gateFor(
    { askOn: "loose", tools: { probe: { letter: "r", marker: "loose" } } },
    async () => { asked.resolve(); return human.promise; },
  );
  await gate.init();
  const checkPromise = gate.check({ type: "probe", args: {} });
  await asked.promise;
  human.resolve({ decision: "allow" });
  const d = await checkPromise;
  assert.equal(d.outcome, "allow", "no add() happened during the wait — behavior must be byte-identical");
});

test("add/check race: a concurrent add() that tightens the MATCHED key past the held letter denies (rwx.tightened), not the stale allow", async () => {
  const asked = deferred();
  const human = deferred();
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher",
      agents: { researcher: "r--" }, // holds only "r"
      tools: { probe: { letter: "r", marker: "loose" } },
      askOn: "loose",
    },
    humanChannel: async () => { asked.resolve(); return human.promise; },
  });
  await gate.init();

  const checkPromise = gate.check({ type: "probe", args: {} });
  await asked.promise; // check() is now blocked awaiting the human decision
  await gate.add({ probe: { letter: "w", marker: "loose" } }); // r -> w while the ask is pending
  human.resolve({ decision: "allow" }); // the human's answer is now stale

  const d = await checkPromise;
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.tightened");
  const lines = await gate.audit.readAll();
  assert.ok(lines.some((l) => l.phase === "gate" && l.rule === "rwx.tightened" && l.decision === "deny"));
});

test("add/check race: a concurrent add() to an UNRELATED key during the wait does NOT spuriously deny (per-key, not global-generation)", async () => {
  // This is the corrected behavior after orchestrator review found a real
  // bug: an earlier version of this fix gated purely on the global
  // `_addGeneration` counter, so ANY landed add() — including one to a
  // totally unrelated key, which is normal, constant traffic in the
  // spec-less-site flow (a batch lands per unmatched request) — forced a
  // fresh `rwxCheck` on THIS key. For a loose-marked entry under
  // `askOn:"loose"`, a fresh check on an UNCHANGED entry always comes back
  // "askHuman" again (asking is what a loose marker does, unconditionally),
  // which the old code then denied as `rwx.tightened` even though nothing
  // about "probe" changed. hamr's rule is "if it got STRICTER in the
  // meantime, deny" — an unrelated add() is not stricter for this key, so
  // the human's "allow" must stand.
  const asked = deferred();
  const human = deferred();
  const gate = gateFor(
    { askOn: "loose", tools: { probe: { letter: "r", marker: "loose" }, unrelated: "r" } },
    async () => { asked.resolve(); return human.promise; },
  );
  await gate.init();
  const checkPromise = gate.check({ type: "probe", args: {} });
  await asked.promise;
  await gate.add({ unrelated: "w" }); // unrelated key, but bumps the add-generation
  human.resolve({ decision: "allow" });
  const d = await checkPromise;
  assert.equal(d.outcome, "allow", "an unrelated concurrent add() must not spuriously deny this key's already-answered ask");
});

test("add/check race: humanChannel is never called twice (no re-entering the ask path)", async () => {
  const asked = deferred();
  const human = deferred();
  let humanChannelCalls = 0;
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher", agents: { researcher: "r--" },
      tools: { probe: { letter: "r", marker: "loose" } }, askOn: "loose",
    },
    humanChannel: async () => { humanChannelCalls++; asked.resolve(); return human.promise; },
  });
  await gate.init();
  const checkPromise = gate.check({ type: "probe", args: {} });
  await asked.promise;
  await gate.add({ probe: { letter: "w", marker: "loose" } });
  human.resolve({ decision: "allow" });
  await checkPromise;
  assert.equal(humanChannelCalls, 1);
});

test("add/check race: an add() landing during an await INSIDE _stepEval (before rwx step 5 ever reads the map) must NOT cause a false rwx.tightened deny", async () => {
  // Debrief finding: the race snapshot used to be taken BEFORE `check()`
  // even called `_stepEval` — but `_stepEval` itself awaits real I/O ahead
  // of rwx's own step 5 (`deferRateCheck`/`spawnRateCheck` read the audit
  // log). If an add() landed during ONE OF THOSE internal awaits, step 5
  // ends up reading the ALREADY-tightened entry — the ask itself is
  // correctly computed against the new entry, and the human legitimately
  // approves it — but the stale pre-_stepEval snapshot still disagreed,
  // producing a false `rwx.tightened` deny with a misleading audit reason
  // ("while this check() awaited a human decision" — it did not; the add()
  // landed before the ask was even raised). Reproduced here deterministically
  // by wrapping `_stepEval` with a controllable pause point BEFORE it does
  // any of its own real work, standing in for spawnRateCheck's fs read.
  const gate = gateFor(
    { askOn: "loose", tools: { probe: { letter: "r", marker: "loose" } } },
    async () => ({ decision: "allow" }),
  );
  await gate.init();
  const paused = deferred();
  const pausedEntered = deferred();
  const originalStepEval = gate._stepEval.bind(gate);
  gate._stepEval = async (action, raceSnapshot) => {
    pausedEntered.resolve();
    await paused.promise; // stand-in for spawnRateCheck's real I/O await, BEFORE rwx step 5 runs
    return originalStepEval(action, raceSnapshot); // forward the race-snapshot out-parameter, or step 5 can never overwrite it
  };
  const checkPromise = gate.check({ type: "probe", args: {} });
  await pausedEntered.promise; // check() is blocked inside _stepEval, before ANY rwx read has happened
  await gate.add({ probe: { letter: "w", marker: "loose" } }); // tighten lands during _stepEval's OWN internal pause, not during the human wait
  paused.resolve(); // _stepEval continues; step 5 now reads the ALREADY-tightened "w" entry
  const d = await checkPromise;
  assert.equal(d.outcome, "allow", "the ask was computed against the already-tightened entry and legitimately approved by the human — must not be denied as stale");
  assert.notEqual(d.rule, "rwx.tightened");
});

test("add/check race: an add() landing AFTER rwx step 5's read but BEFORE humanChannel dispatch (during check()'s own ask audit line) must deny — the ask was answered under OLD terms", async () => {
  // Orchestrator-found safety hole in an earlier fix attempt: that version
  // moved the race snapshot to immediately before dispatching to
  // humanChannel, reasoning that was "the state as the ask was raised."
  // That is backwards. The ask decision is computed at rwx step 5 — an
  // `r--` agent asking about a "probe" tagged {r, loose} produces an
  // askHuman for THAT decision. If add() tightens "probe" to {w, loose}
  // AFTER step 5's read but BEFORE the human actually answers (here:
  // during check()'s own "gate"/askHuman audit-line write, which happens
  // between the step-5 read and the humanChannel dispatch), a
  // dispatch-time snapshot would already see "w" as if that were the
  // ORIGINAL value — comparing "w" now against "w" then finds no change
  // and wrongly allows, even though the agent only ever held "r" and the
  // human never actually approved a "w"-tagged action. Ported directly
  // from the orchestrator's repro (gap.mjs).
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher", agents: { researcher: "r--" },
      tools: { probe: { letter: "r", marker: "loose" } }, askOn: "loose",
    },
    humanChannel: async () => ({ decision: "allow" }),
  });
  await gate.init();
  const originalEmit = gate.audit.emit.bind(gate.audit);
  let fired = false;
  gate.audit.emit = async (line) => {
    // check() writes its "gate"/askHuman audit line (computed from step 5's
    // read) BEFORE calling humanChannel — tighten the entry right then,
    // between the read and the dispatch.
    if (!fired && line.phase !== "rwx.added" && line.action?.type === "probe") {
      fired = true;
      await gate.add({ probe: { letter: "w", marker: "loose" } });
    }
    return originalEmit(line);
  };
  const d = await gate.check({ type: "probe", args: {} });
  assert.equal(gate.cfg.rwx.tools.probe.letter, "w", "sanity: the tighten did land");
  assert.equal(d.outcome, "deny", "the human approved the OLD (r) decision, not the new w-tagged one — must not be allowed");
  assert.equal(d.rule, "rwx.tightened");
});

// §23.21 REDESIGN ("check and audit in the same logical order", debrief
// round 3): a single gate-wide ordering lock now covers BOTH add()'s whole
// _addOnce AND check()'s final commit (_commitDecision) — see gate.js. The
// audit log's line order is the TRUE order: whichever of a check()'s
// commit or an add()'s mutation acquires the lock first is unambiguously
// first. A consequence for tests: firing add() from INSIDE a mocked
// audit.emit and AWAITING it there deadlocks by design whenever that emit
// call is itself happening while the SAME lock is held (any final "gate"/
// "approval" line) — add() cannot acquire a lock its own trigger is
// blocking on. The fix for every such test is to fire add() WITHOUT
// awaiting it inside the mock; it then queues behind the in-progress
// commit and lands right after, which is "correct by the invariant," not
// a workaround.

test("add/check race: the TERMINAL allow path commits atomically — a same-tick, fire-and-forget add() cannot land before the commit (total ordering via the shared lock)", async () => {
  // Debrief round 2 found this hole: the pre-redesign fix wrote the "allow"
  // line, THEN re-checked, sometimes downgrading to a second "rwx.tightened"
  // deny line for the same aid — which (debrief round 3) made spawn-rate/
  // defer-rate over-count a denied action as allowed, since they scan the
  // audit log for `decision === "allow"` lines. Under the redesign, the
  // compare happens INSIDE the lock BEFORE any line is written at all, so a
  // concurrent add() can never land between the compare and the write — it
  // either already landed (and the compare catches it) or it's still queued
  // behind this very commit (and can't possibly have landed yet). Ported
  // from the orchestrator's repro (terminal-allow-race.mjs), adapted to fire
  // add() without awaiting it (awaiting it here would deadlock — see the
  // dedicated test below).
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "reader", agents: { reader: "r--" },
      tools: { probe: { letter: "r", marker: "tight" } }, bash: {},
    },
  });
  await gate.init();
  const originalEmit = gate.audit.emit.bind(gate.audit);
  let fired = false;
  let addPromise = null;
  gate.audit.emit = async (line) => {
    if (!fired && line.action?.type === "probe") {
      fired = true;
      // Fire WITHOUT awaiting: add() needs the exact lock this call is
      // currently holding (we're inside check()'s _commitDecision), so it
      // queues behind this commit and cannot land until this emit — and
      // the commit around it — finishes.
      addPromise = gate.add({ probe: { letter: "x", marker: "tight" } });
    }
    return originalEmit(line);
  };
  const d = await gate.check({ type: "probe", args: {} });
  assert.equal(d.outcome, "allow", "the add() was still queued, not yet landed, when this commit ran — its allow is valid against the map as of that instant in the log");
  assert.equal(d.rule, "rwx.allow");
  await addPromise; // let the queued tighten land now
  assert.equal(gate.cfg.rwx.tools.probe.letter, "x", "the tighten lands AFTER check()'s commit, per the total-ordering invariant");
  const lines = await gate.audit.readAll();
  const gateLines = lines.filter((l) => l.phase === "gate" && l.action?.type === "probe");
  assert.equal(gateLines.length, 1, "exactly one final gate line for this aid — never allow-then-deny");
  assert.equal(gateLines[0].decision, "allow");
  // A SUBSEQUENT check(), now that the tighten has actually landed, denies correctly.
  const d2 = await gate.check({ type: "probe", args: {} });
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "rwx.denied");
});

test("add/check race: an UNRELATED-key add() queued during the terminal allow's own commit lands afterward, without affecting this check()'s outcome", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "reader", agents: { reader: "r--" },
      tools: { probe: { letter: "r", marker: "tight" }, unrelated: "r" }, bash: {},
    },
  });
  await gate.init();
  const originalEmit = gate.audit.emit.bind(gate.audit);
  let fired = false;
  let addPromise = null;
  gate.audit.emit = async (line) => {
    if (!fired && line.action?.type === "probe") {
      fired = true;
      addPromise = gate.add({ unrelated: "w" }); // fire-and-forget — queued behind this commit
    }
    return originalEmit(line);
  };
  const d = await gate.check({ type: "probe", args: {} });
  assert.equal(d.outcome, "allow");
  assert.equal(d.rule, "rwx.allow");
  await addPromise;
  assert.equal(gate.cfg.rwx.tools.unrelated, "w", "the unrelated add() still lands, just after this check()'s commit");
});

test("add/check race: awaiting add() from INSIDE a locked commit's own audit sink deadlocks by design (not detected/thrown — escalated, not yet documented in the PRD)", async () => {
  // add() acquires the SAME lock check()'s final commit is holding while it
  // writes its one audit line. If a caller's audit sink awaits add() from
  // inside that very write, add() can never acquire the lock (it's waiting
  // on a commit that is itself waiting on this call to return) — a genuine
  // deadlock, not a bug this file works around. Detecting "would this
  // await deadlock" cheaply would need reentrancy tracking on the lock
  // (an owner token or call-depth counter) for a benefit limited to a
  // caller doing something already contradictory (blocking a commit on
  // itself); not implemented — flagged here as an escalated, deliberate
  // non-decision rather than silently left unstated.
  const gate = new Gate({
    audit: { path: null },
    rwx: { agent: "reader", agents: { reader: "r--" }, tools: { probe: { letter: "r", marker: "tight" } }, bash: {} },
  });
  await gate.init();
  const originalEmit = gate.audit.emit.bind(gate.audit);
  let fired = false;
  gate.audit.emit = async (line) => {
    if (!fired && line.action?.type === "probe") {
      fired = true;
      await gate.add({ probe: { letter: "x", marker: "tight" } }); // AWAITED from inside the locked commit — deadlocks
    }
    return originalEmit(line);
  };
  const checkPromise = gate.check({ type: "probe", args: {} });
  const timeout = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 200));
  const result = await Promise.race([checkPromise, timeout]);
  assert.equal(result, "TIMEOUT", "check() must not resolve — this is the documented deadlock, not a bug");
});

// ─── 1. audit write failure mid-add() ─────────────────────────────────────
//
// Repo rule: an audit WRITE failure PROPAGATES (never silently swallowed).
// Additional invariant this section proves: add() must never end with a key
// that is LIVE in the tools map (checks allow it) but has no rwx.added line
// — "every allowed key traces back to a logged add." The chosen ordering is
// audit-lines-first, mutate-after: every rwx.added line for the batch is
// written BEFORE any key is copied into the live tools map. If an audit
// write throws partway through a batch, nothing has been mutated yet, so
// the whole batch simply fails to land (all-or-nothing holds). The residual
// this leaves is "logged but not landed" (an earlier key in the same batch
// may already have a real rwx.added line on disk even though the batch as a
// whole didn't land) — never "landed but not logged". Logged-but-not-landed
// is safe: the audit trail can over-claim what's granted, but `check()`
// only ever consults the live tools map, never the audit log, so a stray
// log line grants nothing. Landed-but-not-logged would be unsafe: a real,
// usable capability with no audit trail explaining it.

function makeThrowingAudit(gate, { failOnPhase, failOnNth, failMessage }) {
  const original = gate.audit.emit.bind(gate.audit);
  let count = 0;
  gate.audit.emit = async (fields) => {
    if (fields.phase === failOnPhase) {
      count++;
      if (count === failOnNth) throw new Error(failMessage);
    }
    return original(fields);
  };
  return () => { gate.audit.emit = original; };
}

test("add: audit write failure on the 1st rwx.added line of a 3-key batch propagates; nothing lands", async () => {
  const gate = gateFor();
  await gate.init();
  makeThrowingAudit(gate, { failOnPhase: "rwx.added", failOnNth: 1, failMessage: "disk full (simulated)" });

  await assert.rejects(() => gate.add({ k1: "r", k2: "w", k3: "x" }), /disk full \(simulated\)/);

  for (const k of ["k1", "k2", "k3"]) {
    const d = await gate.check({ type: k, args: {} });
    assert.equal(d.rule, "rwx.unlisted", `${k} must not have landed`);
  }
  const lines = await gate.audit.readAll();
  assert.equal(lines.filter((l) => l.phase === "rwx.added").length, 0, "no rwx.added lines at all — the failure was on the very first one");
  const rejected = lines.filter((l) => l.phase === "rwx.add_rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /disk full \(simulated\)/);
  assert.deepEqual(rejected[0].keys.sort(), ["k1", "k2", "k3"]);
});

test("add: audit write failure on the 2nd rwx.added line of a 3-key batch propagates; nothing lands (residual: k1's rwx.added line is logged-but-not-landed)", async () => {
  const gateGen = gateFor();
  await gateGen.init();
  const genBefore = gateGen._addGeneration;

  const gate = gateFor();
  await gate.init();
  makeThrowingAudit(gate, { failOnPhase: "rwx.added", failOnNth: 2, failMessage: "disk full on 2nd line (simulated)" });

  await assert.rejects(() => gate.add({ k1: "r", k2: "w", k3: "x" }), /disk full on 2nd line/);

  // Structural guarantee: NONE of the batch landed (audit-first, mutate-after
  // — the mutation loop never ran because the audit-writing loop threw).
  for (const k of ["k1", "k2", "k3"]) {
    const d = await gate.check({ type: k, args: {} });
    assert.equal(d.rule, "rwx.unlisted", `${k} must not have landed`);
  }
  // _addGeneration must be consistent with "nothing landed" — unchanged.
  assert.equal(gate._addGeneration, genBefore, "_addGeneration must not bump when nothing actually landed");

  const lines = await gate.audit.readAll();
  const added = lines.filter((l) => l.phase === "rwx.added");
  // The documented residual: k1's line was written before k2's write threw.
  // This is "logged but not landed" — safe, because check() never consults
  // the audit log, only the live (untouched) tools map.
  assert.equal(added.length, 1, "exactly one rwx.added line — for k1, the only write that completed before the failure");
  assert.equal(added[0].key, "k1");
  const rejected = lines.filter((l) => l.phase === "rwx.add_rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /disk full on 2nd line/);
  assert.deepEqual(rejected[0].keys.sort(), ["k1", "k2", "k3"]);
});

test("add: audit write failure on the rwx.add_rejected line itself (a genuinely-bad batch whose rejection audit ALSO fails to write) propagates", async () => {
  const gate = gateFor();
  await gate.init();
  makeThrowingAudit(gate, { failOnPhase: "rwx.add_rejected", failOnNth: 1, failMessage: "audit sink fully down (simulated)" });

  // bad_key: "q" is a genuinely malformed entry — would normally be
  // rejected with a "must be r/w/x or {...}" message, but the audit write
  // for THAT rejection also throws, so the propagated error is the audit
  // failure, not the original validation message. This still satisfies the
  // repo rule (a write failure PROPAGATES, is never swallowed into a
  // resolved promise) — it does not additionally promise to preserve the
  // original rejection reason when the rejection's OWN audit write fails.
  await assert.rejects(() => gate.add({ bad_key: "q" }), /audit sink fully down \(simulated\)/);
  const d = await gate.check({ type: "bad_key", args: {} });
  assert.equal(d.rule, "rwx.unlisted", "bad_key must not have landed either way");
});

// ─── 2. race + human says NO (deny), and humanChannel timeout ────────────

test("add/check race: human explicitly DENIES during a pending tighten — the human's deny stands (no rwx.tightened needed)", async () => {
  const asked = deferred();
  const human = deferred();
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher", agents: { researcher: "r--" },
      tools: { probe: { letter: "r", marker: "loose" } }, askOn: "loose",
    },
    humanChannel: async () => { asked.resolve(); return human.promise; },
  });
  await gate.init();
  const checkPromise = gate.check({ type: "probe", args: {} });
  await asked.promise;
  await gate.add({ probe: { letter: "w", marker: "loose" } }); // tighten DURING the wait — irrelevant, human said no
  human.resolve({ decision: "deny", reason: "operator said no" });
  const d = await checkPromise;
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.ask", "the ORIGINAL ask rule, not rwx.tightened — the race-check only runs on the allow path");
  assert.equal(d.reason, "operator said no");
});

test("add/check race: humanChannel TIMES OUT during a pending tighten — denies via the timeout path, not rwx.tightened", async () => {
  const asked = deferred();
  // A humanChannel that answers eventually via a real setTimeout, but only
  // long after the 20ms gate timeout has already fired — matching the style
  // of the existing humanChannelTimeoutMs tests in test/halt-flow.test.js
  // (a manually-resolved deferred left pending past the test's own end
  // trips node:test's dangling-promise detection at process exit).
  const gate = new Gate({
    audit: { path: null },
    humanChannelTimeoutMs: 20,
    rwx: {
      agent: "researcher", agents: { researcher: "r--" },
      tools: { probe: { letter: "r", marker: "loose" } }, askOn: "loose",
    },
    humanChannel: (event) => {
      asked.resolve();
      return new Promise((resolve) => setTimeout(() => resolve({ decision: "allow" }), 200));
    },
  });
  await gate.init();
  const checkPromise = gate.check({ type: "probe", args: {} });
  await asked.promise;
  await gate.add({ probe: { letter: "w", marker: "loose" } }); // tighten while the timeout is ticking
  const d = await checkPromise;
  assert.equal(d.outcome, "deny");
  assert.match(d.reason, /humanChannel timeout/);
  assert.notEqual(d.rule, "rwx.tightened", "timeout denies on its own terms, not via the race-check");
});

// ─── 3. race, marker-only change, ask raised by something OTHER than rwx ──

test("add/check race: an UNRELATED ask (flags) is pending; a concurrent add() moves the matched key's MARKER only (letter unchanged) — denies rwx.tightened on the fresh askHuman", async () => {
  // "probe" starts as a bare "r" (no marker at all — never asks under
  // askOn:"loose"). The pending ask is raised by `flags` (step 4b), which
  // runs BEFORE rwx's own step 5 in the eval order — so rwx's step 5 is
  // never even reached for THIS check() call; the ask has nothing to do
  // with rwx. While that unrelated ask is pending, add() moves "probe" to
  // {letter:"r", marker:"loose"} — letter unchanged, so this is legal under
  // decision 4's tighten-only rule (loose is not a loosen of a bare "r").
  // A fresh rwxCheck on "probe" now returns askHuman (marker is loose,
  // askOn:"loose"), which is exactly what "if it got stricter, deny" means:
  // the human answered an ask that had nothing to do with rwx, and the
  // action would NOW independently require an rwx ask it didn't before.
  const asked = deferred();
  const human = deferred();
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher", agents: { researcher: "r--" },
      tools: { probe: "r" }, // bare "r" — no marker, never asks via rwx alone
      askOn: "loose",
    },
    flags: { severity: { high: "ask" } }, // an ask source with NOTHING to do with rwx
    humanChannel: async () => { asked.resolve(); return human.promise; },
  });
  await gate.init();
  const checkPromise = gate.check({ type: "probe", args: {}, severity: "high" });
  await asked.promise;
  await gate.add({ probe: { letter: "r", marker: "loose" } }); // marker-only change, letter unchanged
  human.resolve({ decision: "allow" });
  const d = await checkPromise;
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.tightened");
  assert.match(d.reason, /askHuman/);
});

// ─── 4. audit hygiene of add lines: redaction + byte bounds ──────────────

test("add: a secret-looking key is redacted in the rwx.added line", async () => {
  const dir = await makeTmpDir();
  try {
    const auditPath = path.join(dir, "audit.jsonl");
    const gate = new Gate({
      audit: { path: auditPath },
      rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: {} },
      humanChannel: async () => ({ decision: "deny" }),
    });
    await gate.init();
    const secretKey = "api.example.com.GET /v1/x?token=sk-abc123def456ghi789";
    await gate.add({ [secretKey]: "r" });
    const raw = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const line = raw.map((l) => JSON.parse(l)).find((l) => l.phase === "rwx.added");
    assert.ok(line, "expected an rwx.added line");
    assert.ok(!line.key.includes("sk-abc123def456ghi789"), `key was not redacted: ${line.key}`);
    assert.match(line.key, /\[REDACTED:pattern=/);
  } finally { await cleanup(dir); }
});

test("add: a Bearer-token-looking key is redacted in the rwx.add_rejected line's keys array", async () => {
  const dir = await makeTmpDir();
  try {
    const auditPath = path.join(dir, "audit.jsonl");
    const gate = new Gate({
      audit: { path: auditPath },
      rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: {} },
      humanChannel: async () => ({ decision: "deny" }),
    });
    await gate.init();
    const secretKey = "Authorization: Bearer sk-liveSECRETtoken1234567890abcdef";
    await assert.rejects(() => gate.add({ [secretKey]: "q" /* bad letter, forces rejection */ }));
    const raw = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const line = raw.map((l) => JSON.parse(l)).find((l) => l.phase === "rwx.add_rejected");
    assert.ok(line, "expected an rwx.add_rejected line");
    const serializedKeys = JSON.stringify(line.keys);
    assert.ok(!serializedKeys.includes("sk-liveSECRETtoken1234567890abcdef"), `keys not redacted: ${serializedKeys}`);
  } finally { await cleanup(dir); }
});

test("add: a 50KB key in a successful add() keeps the rwx.added line at or under MAX_LINE_BYTES", async () => {
  const dir = await makeTmpDir();
  try {
    const auditPath = path.join(dir, "audit.jsonl");
    const gate = new Gate({
      audit: { path: auditPath },
      rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: {} },
      humanChannel: async () => ({ decision: "deny" }),
    });
    await gate.init();
    const hugeKey = "k".repeat(50 * 1024);
    await gate.add({ [hugeKey]: "r" });
    const raw = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    let sawAdded = false;
    for (const l of raw) {
      const bytes = Buffer.byteLength(l, "utf8");
      assert.ok(bytes <= MAX_LINE_BYTES, `line was ${bytes} bytes, over the ${MAX_LINE_BYTES}-byte cap: ${l.slice(0, 200)}...`);
      const parsed = JSON.parse(l);
      if (parsed.phase === "rwx.added") sawAdded = true;
    }
    assert.ok(sawAdded, "expected an rwx.added line even though the key was huge");
  } finally { await cleanup(dir); }
});

test("add: a 50KB key in a REJECTED add() keeps the rwx.add_rejected line at or under MAX_LINE_BYTES", async () => {
  const dir = await makeTmpDir();
  try {
    const auditPath = path.join(dir, "audit.jsonl");
    const gate = new Gate({
      audit: { path: auditPath },
      rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: {} },
      humanChannel: async () => ({ decision: "deny" }),
    });
    await gate.init();
    const hugeKey = "k".repeat(50 * 1024);
    await assert.rejects(() => gate.add({ [hugeKey]: "q" }));
    const raw = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    let sawRejected = false;
    for (const l of raw) {
      const bytes = Buffer.byteLength(l, "utf8");
      assert.ok(bytes <= MAX_LINE_BYTES, `line was ${bytes} bytes, over the ${MAX_LINE_BYTES}-byte cap`);
      const parsed = JSON.parse(l);
      if (parsed.phase === "rwx.add_rejected") sawRejected = true;
    }
    assert.ok(sawRejected, "expected an rwx.add_rejected line even though the key was huge");
  } finally { await cleanup(dir); }
});

test("add: a long multibyte-UTF8 key is bounded correctly (byte-counted, not UTF-16-unit-counted)", async () => {
  const dir = await makeTmpDir();
  try {
    const auditPath = path.join(dir, "audit.jsonl");
    const gate = new Gate({
      audit: { path: auditPath },
      rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: {} },
      humanChannel: async () => ({ decision: "deny" }),
    });
    await gate.init();
    // U+4E2D is 3 bytes in UTF-8 but 1 UTF-16 code unit — repeating it enough
    // times to exceed MAX_LINE_BYTES in bytes while staying "short" in units.
    const multibyteKey = "中".repeat(2000); // 2000 units, 6000 bytes
    await gate.add({ [multibyteKey]: "r" });
    const raw = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    for (const l of raw) {
      const bytes = Buffer.byteLength(l, "utf8");
      assert.ok(bytes <= MAX_LINE_BYTES, `line was ${bytes} bytes (not units), over the ${MAX_LINE_BYTES}-byte cap`);
    }
  } finally { await cleanup(dir); }
});

test("add: the thrown Error message for a rejected key is clipped (bounded), not unbounded like the raw key", async () => {
  const gate = gateFor();
  await gate.init();
  const hugeKey = "k".repeat(50 * 1024);
  const err = await gate.add({ [hugeKey]: "q" }).then(() => null, (e) => e);
  assert.ok(err, "expected add() to throw");
  // The thrown message embeds the key via clipKey (64-char clip with an
  // ellipsis), same treatment every other rwx error message gives a
  // caller-supplied key — it must not carry the full 50KB key verbatim.
  assert.ok(err.message.length < 1000, `error message was ${err.message.length} chars, expected it clipped`);
});

// ─── concurrent add() calls are serialized ────────────────────────────────
//
// Found by orchestrator review: the audit-lines-first fix (previous commit)
// introduced a genuine async window inside add() — validate against the
// live tools map, THEN await the audit writes, THEN mutate. Two concurrent
// add() calls that both entered before either had mutated both validated
// against the SAME stale state, so a tighten-only violation could slip
// through (an "x" key concurrently "tightened" to "w" — actually a LOOSEN,
// since the "w" call's tighten-check read the map before the "x" call had
// landed), and two batches that each individually fit the 10,000-key cap
// could jointly cross it. Fixed with a promise-chain mutex (`_addQueue`)
// that runs add() calls strictly one at a time, in call order.

test("add: concurrent add()s to the SAME key are serialized — the second-to-run one validates against the FIRST's already-landed result, no loosen slips through", async () => {
  const gate = gateFor({ tools: { k: "r" } });
  await gate.init();
  // Two concurrent tighten attempts on the same key, from "r": x (bigger
  // tighten) and w (smaller tighten). Whichever actually runs SECOND (queue
  // order, not call order, since the queue only guarantees non-overlap, not
  // which literal call goes first) must validate against the FIRST's
  // landed result — so if x lands first, w -> x would be a loosen and must
  // be rejected; if w lands first, x is still a valid tighten over w and
  // must succeed. Either resolution is fine; what must NEVER happen is a
  // net loosen (x landing, then being silently overwritten by w).
  const pB = gate.add({ k: "x" });
  const pA = gate.add({ k: "w" });
  const results = await Promise.allSettled([pA, pB]);
  const finalLetter = gate.cfg.rwx.tools.k;
  assert.ok(["r", "w", "x"].includes(finalLetter) === false || finalLetter === "x" || finalLetter === "w",
    "sanity: final letter is one of the attempted values");
  // The load-bearing assertion: whichever one landed LAST in queue order is
  // never a loosen relative to whichever landed first. Concretely, for this
  // exact pair, "x" landing first then "w" attempting w<x must be REJECTED
  // — this is what actually happened pre-fix (repro below is deterministic
  // given add()'s FIFO queue: pB (x) was queued before pA (w) in this test).
  assert.equal(finalLetter, "x", "x was queued first and must land; w's later attempt (a loosen relative to x) must be rejected");
  const wResult = results[0]; // pA = the "w" attempt, queued second
  assert.equal(wResult.status, "rejected");
  assert.match(wResult.reason.message, /would LOOSEN/);
  const d = await gate.check({ type: "k", args: {} });
  assert.equal(d.rwxLetter, "x");
  const lines = await gate.audit.readAll();
  assert.equal(lines.filter((l) => l.phase === "rwx.added" && l.key === "k" && l.letter === "x").length, 1);
  assert.equal(lines.filter((l) => l.phase === "rwx.add_rejected").length, 1);
});

test("add: two concurrent batches that EACH individually fit the cap but would JOINTLY exceed it — the second is rejected, size stays <= cap", async () => {
  const CAP = 10000;
  const gate = gateFor({ tools: bigToolsMap(CAP - 1) }); // 9,999 keys — exactly 1 slot of headroom
  await gate.init();
  // Each batch alone is exactly at the boundary: 9,999 + 1 = 10,000, which
  // fits (only CROSSING refuses). Read against the SAME starting state
  // (9,999), both would pass their own cap check — the bug this test
  // targets is that check running against STALE state for whichever one
  // does not go first, not either batch being individually over-cap (a
  // batch that's over-cap alone would reject on its own math regardless of
  // concurrency, and would not actually exercise the shared-state race).
  const batchA = { extra_a1: "r" };
  const batchB = { extra_b1: "r" };
  const [rA, rB] = await Promise.allSettled([gate.add(batchA), gate.add(batchB)]);
  const finalSize = Object.keys(gate.cfg.rwx.tools).length;
  assert.ok(finalSize <= CAP, `final size ${finalSize} exceeded the cap of ${CAP}`);
  const landedA = "extra_a1" in gate.cfg.rwx.tools;
  const landedB = "extra_b1" in gate.cfg.rwx.tools;
  assert.notEqual(landedA && landedB, true, "both batches landing would push size to 10,001, over the cap");
  assert.ok(landedA || landedB, "at least one of the two batches should still fit and land (9,999 + 1 = 10,000 is legal)");
  const rejected = [rA, rB].filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 1, "exactly one of the two concurrent batches was rejected");
  assert.match(rejected[0].reason.message, /past the cap/);
});

test("add: a rejected add() followed by a concurrent GOOD add() still lands (the queue is not wedged by a rejection)", async () => {
  const gate = gateFor();
  await gate.init();
  const pBad = gate.add({ bad_key: "q" }); // malformed, will reject
  const pGood = gate.add({ good_key: "r" }); // unrelated, must still land
  const [rBad, rGood] = await Promise.allSettled([pBad, pGood]);
  assert.equal(rBad.status, "rejected");
  assert.equal(rGood.status, "fulfilled");
  const d = await gate.check({ type: "good_key", args: {} });
  assert.equal(d.outcome, "allow");
  // Queue health check: a THIRD add(), issued only after the first two have
  // settled, must also land — proves the queue token chain wasn't left in
  // a broken state by the rejection.
  await gate.add({ third_key: "w" });
  const d3 = await gate.check({ type: "third_key", args: {} });
  assert.equal(d3.outcome, "allow");
});

// ─── add() after terminate() rejects ──────────────────────────────────────

test("add: gate.add() after gate.terminate() rejects — nothing lands, one rwx.add_rejected line", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.terminate("shutting down");
  await assert.rejects(() => gate.add({ probe: "r" }), /gate has been terminated/);
  // A terminated gate's check() itself halt-denies before ever reaching rwx
  // eval, so "did it land" is checked directly against the live map instead.
  assert.equal("probe" in gate.cfg.rwx.tools, false, "probe must not have landed");
  const lines = await gate.audit.readAll();
  const rejected = lines.filter((l) => l.phase === "rwx.add_rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /gate has been terminated/);
  assert.deepEqual(rejected[0].keys, ["probe"]);
  assert.equal(lines.filter((l) => l.phase === "rwx.added").length, 0);
});

test("add: an add() already IN FLIGHT (past its terminated check) still lands; one merely QUEUED behind it is rejected once terminate() has run", async () => {
  // The terminated check is the FIRST synchronous statement in _addOnce, so
  // there is no separate "grandfathering" rule to test beyond ordinary
  // program order: a call already PAST that line when terminate() runs is
  // unaffected (nothing re-checks it later); a call whose _addOnce hasn't
  // started yet (still waiting in the add() queue) sees the new state.
  // Paused via the audit-write step (which only runs AFTER the terminated
  // check) rather than by wrapping _addOnce itself, so this genuinely tests
  // "already past the check," not "queued but not yet started."
  const gate = gateFor();
  await gate.init();
  const pause = deferred();
  const entered = deferred();
  const originalEmit = gate.audit.emit.bind(gate.audit);
  let paused = false;
  gate.audit.emit = async (fields) => {
    if (fields.phase === "rwx.added" && !paused) {
      paused = true;
      entered.resolve();
      await pause.promise; // hold this add() mid-flight, already past the terminated check
    }
    return originalEmit(fields);
  };
  const firstAdd = gate.add({ blocker: "r" });
  await entered.promise;
  const secondAdd = gate.add({ probe: "r" }); // queued behind firstAdd — has NOT entered _addOnce at all yet
  await gate.terminate("mid-flight shutdown");
  pause.resolve(); // let firstAdd (already past the check) finish landing
  await firstAdd;
  await assert.rejects(() => secondAdd, /gate has been terminated/);
  assert.equal(gate.cfg.rwx.tools.blocker, "r", "an add() already past the terminated check must still land");
  assert.equal("probe" in gate.cfg.rwx.tools, false, "a merely-queued add() is rejected once terminated");
});

test("add: gate.add() is NOT blocked by a budget-halt state (deliberately not treated the same as termination)", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: {} },
    budget: { maxCostUsd: 0.01 },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.5 }); // blow the cost cap
  const halted = await gate.check({ type: "x" });
  assert.equal(halted.severity, "halt", "sanity: the budget is genuinely in a halt state");
  await assert.doesNotReject(() => gate.add({ probe: "r" }));
  // check() itself would ALSO halt-deny "probe" now (the budget halt applies
  // gate-wide, unrelated to rwx) — landedness is verified directly against
  // the live map instead, since add() succeeding is the property under test.
  assert.equal(gate.cfg.rwx.tools.probe, "r");
});

// ─── property test: randomized interleavings, replay-verified ────────────
//
// The real proof for §23.21's "check and audit in the same logical order"
// invariant: "the audit log's line order is the true order; a final allow
// line is always valid against the tools map as of its position in the
// log." Runs many randomized interleavings of concurrent check()s (some
// asking, with random delays) and concurrent tightening add()s, then
// REPLAYS the audit log in order — rebuilding the tools map from the
// initial config plus each rwx.added line in sequence — and asserts every
// final "gate" allow line was genuinely allowed by rwxCheck against the
// map AS REPLAYED UP TO THAT POINT, and that every check() (by aid) has
// EXACTLY ONE final (non-askHuman) "gate" line.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tighten-only-respecting random move for a tools-map entry, so add()
// calls in the scenario are always LEGAL (a rejected add() teaches nothing
// about the property under test — it never lands).
const LETTERS = ["r", "w", "x"];
function randomTighten(rng, current) {
  const norm = typeof current === "string"
    ? { letter: current, marker: null }
    : { letter: current.letter, marker: current.marker ?? "loose" };
  const curRank = LETTERS.indexOf(norm.letter);
  const nextRank = curRank + Math.floor(rng() * (LETTERS.length - curRank));
  const letter = LETTERS[Math.min(nextRank, LETTERS.length - 1)];
  let marker;
  if (norm.marker === "loose") {
    marker = "loose"; // loose can only stay loose
  } else if (norm.marker === null) {
    marker = null; // bare letter can tighten its letter but has no marker to move (stay bare)
  } else {
    marker = rng() < 0.5 ? "tight" : "settled"; // tight<->settled unrestricted
  }
  return marker === null ? letter : { letter, marker };
}

async function runInterleavingScenario(seed) {
  const rng = mulberry32(seed);
  const initialTools = {
    k1: { letter: "r", marker: "loose" },
    k2: { letter: "r", marker: "tight" },
    k3: "r",
    k4: { letter: "r", marker: "settled" },
  };
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      // r-- ONLY (not full "rwx"): every key starts at a letter the agent
      // holds, but add() can tighten a key's letter up to w/x, which the
      // agent does NOT hold — this is what gives the property test real
      // teeth. An agent holding every letter could never observe a fresh
      // rwxCheck "deny" no matter how a key's letter moved, which would
      // make the letter-insufficiency check below unable to ever fail —
      // exactly the "test that can't produce the negative" antigen.
      agent: "agent", agents: { agent: "r--" },
      tools: JSON.parse(JSON.stringify(initialTools)),
      bash: {}, askOn: "loose",
    },
    humanChannel: async () => {
      // Random delay so ask-then-allow races land at unpredictable points
      // relative to concurrent add()s.
      await new Promise((resolve) => setTimeout(resolve, Math.floor(rng() * 4)));
      return { decision: "allow" };
    },
  });
  await gate.init();
  // Jitter the audit write itself (fileless mode's real emit is a near-
  // instant in-memory push, far too fast to expose an unlocked commit's
  // race window in practice) — this stands in for real file-mode I/O
  // latency, so the property test can actually exercise interleavings a
  // removed lock would let through, not just ones the timing happens to
  // avoid. Applied to EVERY emit uniformly (not just "gate" lines), same as
  // real I/O would affect every write.
  const originalEmit = gate.audit.emit.bind(gate.audit);
  let forcedFired = false;
  let forcedAddPromise = null;
  gate.audit.emit = async (fields) => {
    // A DETERMINISTIC forced collision, once per seed, layered on top of
    // the randomized traffic below: the first final "gate" line for key
    // "k2" (tight — resolves ALLOW directly, no human wait, so its only
    // race window is this emit's own await) triggers a same-tick,
    // fire-and-forget add() that tightens k2 past what the agent holds.
    // Pure random jitter alone was measured NOT to reliably reproduce this
    // exact interleaving within a practical seed count (Node's timer
    // queue resolves same-tick setTimeout callbacks predictably enough
    // that the narrow window rarely got hit by chance) — this forced pair
    // guarantees the property test actually exercises the violation this
    // seed's replay is supposed to catch, on the correct implementation
    // (where it must NOT manifest) and the falsified one (where it must).
    if (!forcedFired && fields.phase === "gate" && fields.action?.type === "k2" && fields.decision !== "askHuman") {
      forcedFired = true;
      forcedAddPromise = gate.add({ k2: { letter: "x", marker: "tight" } }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, Math.floor(rng() * 3)));
    return originalEmit(fields);
  };

  // Concentrate on the first 2 keys (not all 4) to maximize the odds that a
  // check() and an add() collide on the SAME key within a single seed —
  // with keys spread thin across many operations, most pairs never
  // contend for the same entry at all, and the property test would pass
  // "for free" without ever exercising the thing it claims to prove.
  const keys = Object.keys(initialTools).slice(0, 2);
  const checkPromises = [];
  // Guarantee at least one check() on "k2" every seed, so the deterministic
  // forced-collision hook above always has something to trigger on.
  checkPromises.push(gate.check({ type: "k2", args: {} }));
  const NUM_CHECKS = 16;
  for (let i = 0; i < NUM_CHECKS; i++) {
    const key = keys[Math.floor(rng() * keys.length)];
    checkPromises.push(gate.check({ type: key, args: {} }));
  }
  const addPromises = [];
  const NUM_ADDS = 12;
  for (let i = 0; i < NUM_ADDS; i++) {
    const key = keys[Math.floor(rng() * keys.length)];
    const current = gate.cfg.rwx.tools[key]; // read-time snapshot; a concurrent add() to the SAME key may race this one too — that's fine, one of them wins, the other is a legal-shaped but possibly-stale tighten attempt
    const entries = { [key]: randomTighten(rng, current) };
    // Fire-and-forget with a random start delay (some adds race check()'s
    // reads, some race its commits, some land well before or after).
    addPromises.push(
      new Promise((resolve) => setTimeout(resolve, Math.floor(rng() * 3))).then(() => gate.add(entries).catch(() => {})),
    );
  }

  // NOTE: `forcedAddPromise` must NOT be read into this array literal —
  // it's still `null` at this synchronous point (nothing has had a chance
  // to run its microtasks yet), so capturing it here would wait on a
  // `Promise.resolve()` stand-in instead of the real, later-assigned
  // promise — a real bug caught while building this test (the forced
  // add() would fire but the replay below could run before it actually
  // landed, silently defeating the deterministic collision). Await the
  // random traffic first (guaranteed to include the "k2" check that
  // triggers the forced add(), so `forcedAddPromise` is assigned by now),
  // THEN await the live reference.
  await Promise.allSettled([...checkPromises, ...addPromises]);
  if (forcedAddPromise) await forcedAddPromise;

  // ── Replay the audit log in order, rebuilding the tools map. ──
  const lines = gate.audit.entries;
  let replayedTools = JSON.parse(JSON.stringify(initialTools));
  const finalLinesByAid = new Map();
  const violations = [];

  for (const line of lines) {
    if (line.phase === "rwx.added") {
      replayedTools[line.key] = line.marker != null ? { letter: line.letter, marker: line.marker } : line.letter;
      continue;
    }
    if (line.phase !== "gate") continue;
    if (line.decision === "askHuman") continue; // not a final line
    // A final commit line (allow or deny).
    finalLinesByAid.set(line.aid, (finalLinesByAid.get(line.aid) ?? 0) + 1);
    if (line.decision === "allow") {
      const replayCfg = { agent: "agent", agents: { agent: "r--" }, tools: replayedTools, bash: {}, askOn: "loose" };
      const fresh = rwxCheck(line.action, replayCfg);
      // NOT a strict "must equal allow": a loose-marked entry's fresh
      // rwxCheck is ALWAYS "askHuman" (that's what askOn:"loose" does,
      // unconditionally, for as long as the letter is held) — an allow
      // reached via a human's approval (rule "humanChannel.allow" /
      // "topup-on-ask treated as allow") legitimately replays as askHuman
      // when the entry never actually changed. What the redesign actually
      // guarantees, and what would be a real security violation to miss,
      // is that the agent's letters still COVER the matched entry's letter
      // — i.e., a fresh "deny" (letter insufficiency) is never valid to
      // find behind a logged allow. (`_commitDecision` itself downgrades to
      // `rwx.tightened` on ANY fresh non-allow whenever it detects a
      // change at all, so this is not a gap being waved through — it is
      // the one legitimate "unchanged, still loose" case the design
      // deliberately leaves as-is.)
      if (fresh.outcome === "deny") {
        violations.push(`seed ${seed}: aid ${line.aid} action ${JSON.stringify(line.action)} was logged ALLOW but rwxCheck against the replayed map (up to this point) says DENY (${fresh.rule}) — letter insufficiency slipped through`);
      }
    }
  }
  for (const [aid, count] of finalLinesByAid) {
    if (count !== 1) violations.push(`seed ${seed}: aid ${aid} has ${count} final gate lines, expected exactly 1`);
  }
  return violations;
}

test("property: 200 randomized interleavings of concurrent check()s and tightening add()s replay-verify clean (the real proof of the ordering invariant)", async () => {
  const NUM_SEEDS = 200;
  const allViolations = [];
  for (let seed = 1; seed <= NUM_SEEDS; seed++) {
    const violations = await runInterleavingScenario(seed);
    allViolations.push(...violations);
  }
  assert.equal(allViolations.length, 0, `${allViolations.length} violation(s) across ${NUM_SEEDS} seeds:\n${allViolations.slice(0, 10).join("\n")}`);
});

// ─── throughput measurement: check() with and without add() contention ───

test("perf: check() throughput with and without add() contention on the shared lock (measured, reported)", async () => {
  const N = 500;

  // Baseline: no rwx add() contention at all (a gate with no rwx config —
  // the lock is still acquired for every commit, but never contended).
  const plainGate = new Gate({ audit: { path: null }, tools: { allowlist: ["probe"] } });
  await plainGate.init();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await plainGate.check({ type: "probe", args: {} });
  const t1 = process.hrtime.bigint();
  const baselineMs = Number(t1 - t0) / 1e6;

  // Contended: an rwx gate, with a concurrent stream of add() calls competing
  // for the same lock every check() also needs for its commit.
  const busyGate = new Gate({
    audit: { path: null },
    rwx: { agent: "agent", agents: { agent: "rwx" }, tools: { probe: "r" }, bash: {} },
  });
  await busyGate.init();
  let addCounter = 0;
  const addLoop = (async () => {
    for (let i = 0; i < N; i++) await busyGate.add({ [`extra${addCounter++}`]: "r" });
  })();
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await busyGate.check({ type: "probe", args: {} });
  const t3 = process.hrtime.bigint();
  await addLoop;
  const contendedMs = Number(t3 - t2) / 1e6;

  console.log(`  [perf] check() x${N}, no contention:    ${baselineMs.toFixed(2)}ms total, ${(baselineMs / N).toFixed(4)}ms/call`);
  console.log(`  [perf] check() x${N}, with add() contention (${N} concurrent add()s on the same lock): ${contendedMs.toFixed(2)}ms total, ${(contendedMs / N).toFixed(4)}ms/call`);
  console.log(`  [perf] contended/baseline ratio: ${(contendedMs / baselineMs).toFixed(2)}x`);

  // Not a strict pass/fail gate on the ratio (contention cost is legitimate
  // and expected) — just a sanity floor that neither run is pathologically
  // slow (each call still completes in well under 50ms on average).
  assert.ok(baselineMs / N < 50, `baseline check() averaged ${(baselineMs / N).toFixed(2)}ms/call — unexpectedly slow`);
  assert.ok(contendedMs / N < 50, `contended check() averaged ${(contendedMs / N).toFixed(2)}ms/call — unexpectedly slow`);
});
