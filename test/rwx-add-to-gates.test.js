// addToGates(gates, entries) — fleet helper that fans one learned rwx entry
// batch out to N gates in a single call (PRD §23.21, follow-on to
// gate.add(); the rwx-e2e bench's own "things that felt wrong" #3: one Gate
// per agent identity meant a harness had to fan gate.add() out to every
// gate by hand, with no built-in way to do it in one call).
//
// Settled semantics under test: NOT all-or-nothing across gates (each gate
// keeps its own lock/tighten-only/cap/audit via its own add()); every gate
// is attempted even if an earlier one throws; a single AggregateError names
// every failing gate on any rejection; gates/entries are validated up
// front (synchronously, before any gate is touched); entries is read
// EXACTLY ONCE and the identical snapshot is handed to every gate.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate, addToGates } from "../src/index.js";

function gateFor(agent, rwxOverrides = {}) {
  return new Gate({
    audit: { path: null },
    rwx: {
      agent,
      agents: { searcher: "r--", booker: "rw-", deployer: "rwx" },
      tools: {},
      ...rwxOverrides,
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

// ─── validation, up front, synchronous ────────────────────────────────────

test("addToGates: rejects a non-array gates argument, synchronously, no gate touched", async () => {
  const gate = gateFor("searcher");
  await gate.init();
  await assert.rejects(() => addToGates(null, { x: "r" }), /non-empty array of Gate instances/);
  await assert.rejects(() => addToGates("gate", { x: "r" }), /non-empty array of Gate instances/);
  await assert.rejects(() => addToGates(gate, { x: "r" }), /non-empty array of Gate instances/);
});

test("addToGates: rejects an empty gates array", async () => {
  await assert.rejects(() => addToGates([], { x: "r" }), /non-empty array of Gate instances/);
});

test("addToGates: rejects a gates array containing a non-Gate value — no gate touched", async () => {
  const gate = gateFor("searcher");
  await gate.init();
  await assert.rejects(() => addToGates([gate, {}], { x: "r" }), /must be a Gate instance/);
  const d = await gate.check({ type: "x", args: {} });
  assert.equal(d.rule, "rwx.unlisted", "the valid gate in the array must not have been touched either");
});

test("addToGates: rejects a duplicate gate instance (conservative default) — no gate touched", async () => {
  const gate = gateFor("searcher");
  await gate.init();
  await assert.rejects(() => addToGates([gate, gate], { x: "r" }), /same Gate instance twice/);
  const d = await gate.check({ type: "x", args: {} });
  assert.equal(d.rule, "rwx.unlisted", "must not have landed — validation runs before any gate is attempted");
});

test("addToGates: rejects malformed entries (matching gate.add()'s own shape rule) before touching any gate", async () => {
  const a = gateFor("searcher");
  const b = gateFor("booker");
  await a.init();
  await b.init();
  for (const bad of [null, undefined, {}, "x", 42, ["r"]]) {
    await assert.rejects(() => addToGates([a, b], bad), /non-empty plain object/);
  }
  assert.equal((await a.check({ type: "x", args: {} })).rule, "rwx.unlisted");
  assert.equal((await b.check({ type: "x", args: {} })).rule, "rwx.unlisted");
});

// ─── all gates succeed ─────────────────────────────────────────────────────

test("addToGates: all gates succeed — lands the entry on every gate and returns a per-gate summary", async () => {
  const a = gateFor("searcher");
  const b = gateFor("booker");
  const c = gateFor("deployer");
  await Promise.all([a.init(), b.init(), c.init()]);

  const summary = await addToGates([a, b, c], { "site.search": "r" });
  assert.equal(summary.length, 3);
  for (const row of summary) assert.equal(row.ok, true);
  assert.deepEqual(summary.map((r) => r.gate).sort(), ["booker", "deployer", "searcher"]);

  for (const gate of [a, b, c]) {
    const d = await gate.check({ type: "site.search", args: {} });
    assert.equal(d.outcome, "allow");
    assert.equal(d.rwxLetter, "r");
  }
});

// ─── one gate rejects, others still land ──────────────────────────────────

test("addToGates: one gate rejects (tighten-only) — the OTHER gates still land the entry, the failing gate's state is UNCHANGED, and a single AggregateError names it", async () => {
  const strict = gateFor("deployer", { tools: { "site.export": "x" } }); // already at "x" — hand-written, stricter; deployer holds full rwx
  const loose = gateFor("booker"); // no existing entry — a genuinely new key
  await strict.init();
  await loose.init();

  const entries = { "site.export": "r" }; // would LOOSEN strict's x -> r
  await assert.rejects(addToGates([strict, loose], entries), (err) => {
    assert.ok(err instanceof AggregateError, "must throw an AggregateError");
    assert.equal(err.errors.length, 1, "exactly one gate failed");
    assert.match(err.message, /deployer/, "the message must name the failing gate");
    assert.ok(Array.isArray(err.failures) && err.failures.length === 1);
    assert.equal(err.failures[0].gate, "deployer");
    assert.match(err.failures[0].message, /would LOOSEN/);
    return true;
  });

  // The failing gate's own state is unchanged — still "x".
  const dStrict = await strict.check({ type: "site.export", args: {} });
  assert.equal(dStrict.outcome, "allow");
  assert.equal(dStrict.rwxLetter, "x", "strict's entry must be unchanged, not loosened to r");

  // The OTHER gate still landed its own copy of the entry.
  const dLoose = await loose.check({ type: "site.export", args: {} });
  assert.equal(dLoose.outcome, "allow");
  assert.equal(dLoose.rwxLetter, "r");
});

// ─── a terminated gate in the fleet ────────────────────────────────────────

test("addToGates: a terminated gate in the fleet is attempted (fails) but the other gates still proceed", async () => {
  const dead = gateFor("searcher");
  const alive = gateFor("booker");
  await dead.init();
  await alive.init();
  await dead.terminate("shutting down");

  await assert.rejects(addToGates([dead, alive], { "site.probe": "r" }), (err) => {
    assert.ok(err instanceof AggregateError);
    assert.equal(err.errors.length, 1);
    assert.match(err.message, /searcher/);
    assert.match(err.failures[0].message, /terminated/);
    return true;
  });

  const dAlive = await alive.check({ type: "site.probe", args: {} });
  assert.equal(dAlive.outcome, "allow", "the live gate must still have landed the entry");
});

// ─── hostile getter: read exactly once, identical snapshot to every gate ──

test("addToGates: a hostile getter on entries is read EXACTLY ONCE, and every gate receives the IDENTICAL snapshot value", async () => {
  const a = gateFor("searcher");
  const b = gateFor("booker");
  const c = gateFor("deployer");
  await Promise.all([a.init(), b.init(), c.init()]);

  let calls = 0;
  const entries = {};
  Object.defineProperty(entries, "probe", {
    enumerable: true,
    get() { calls++; return calls === 1 ? "r" : "x"; }, // would smuggle "x" on any later read
  });

  await addToGates([a, b, c], entries);
  assert.equal(calls, 1, "entries.probe must be read exactly once, no matter how many gates are in the fleet");

  for (const gate of [a, b, c]) {
    const d = await gate.check({ type: "probe", args: {} });
    assert.equal(d.rwxLetter, "r", "every gate must have landed the FIRST read's value, never the smuggled second one");
  }
});

// ─── concurrent addToGates calls racing on overlapping gate sets ─────────

test("addToGates: two concurrent calls racing on an overlapping gate set do not corrupt state — each gate's own lock still serializes correctly", async () => {
  // All three gates use "deployer" (holds the full "rwx" grant) so that
  // whatever letter ("r"/"w"/"x") ultimately lands for a key, a `check()`
  // against it allows and reports the real letter — the assertions below are
  // about ADD()'s own concurrency correctness (no corrupted/lost tighten),
  // not about the grant ceiling, which is already covered elsewhere.
  const shared = gateFor("deployer", { tools: { k: "r" } });
  const onlyA = gateFor("deployer");
  const onlyB = gateFor("deployer");
  await Promise.all([shared.init(), onlyA.init(), onlyB.init()]);

  // Both calls touch `shared`; one tries to tighten k to "w", the other to "x".
  // Whichever wins the shared gate's own internal lock, the other's own add()
  // for "shared" may reject as a stale-relative loosen (queue order, not call
  // order) — but each call's OWN independent gate (onlyA / onlyB) must still
  // land regardless of what happens to `shared`, since addToGates never
  // short-circuits across gates.
  const callX = addToGates([shared, onlyA], { k: "x" });
  const callW = addToGates([shared, onlyB], { k: "w" });
  const [rX, rW] = await Promise.allSettled([callX, callW]);

  // onlyA and onlyB are each in only ONE of the two calls, so their own gate
  // never contends with anything and must always land, regardless of which
  // call (if either) globally "failed" due to `shared`.
  const dA = await onlyA.check({ type: "k", args: {} });
  const dB = await onlyB.check({ type: "k", args: {} });
  assert.equal(dA.outcome, "allow", "onlyA's own independent gate must have landed its entry");
  assert.equal(dB.outcome, "allow", "onlyB's own independent gate must have landed its entry");

  // `shared`'s final letter must be a legal outcome of its own add() lock
  // serializing the two attempts — never anything other than "r" (if both
  // conflicting attempts somehow both failed, impossible here since at least
  // one tighten from "r" must succeed), "w", or "x" — and never silently
  // corrupted into some other value.
  const dShared = await shared.check({ type: "k", args: {} });
  assert.ok(["r", "w", "x"].includes(dShared.rwxLetter), `shared's final letter must be a legal rwx letter, got ${dShared.rwxLetter}`);
  assert.notEqual(dShared.rwxLetter, "r", "at least one of the two concurrent tightens must have landed");

  // Whichever of rX/rW carries the "shared" failure (if any) must correctly
  // name "deployer" (shared's identity) as the failing gate — never silently
  // swallowed, and never corrupting the settled outcome above. Both gates in
  // this fleet happen to share the identity "deployer" (gateIdentity reads
  // the rwx `agent` field, and all three gates here use "deployer"), so this
  // only asserts the failure is reported at all, not which specific gate.
  for (const r of [rX, rW]) {
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof AggregateError);
      assert.match(r.reason.message, /deployer/);
    }
  }
});
