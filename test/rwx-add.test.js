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
import { Gate } from "../src/index.js";

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
