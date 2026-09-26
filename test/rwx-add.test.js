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
