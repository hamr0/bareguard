// Axis B — gate.annotate (§6.6/§8.2). The thin return-time-judge primitive:
// bareguard buffers a CALLER-computed fact, audits it (sink 1), lets it ride the
// next human ask (sink 3), and drains it for agent feedback (sink 2). bareguard
// never runs an LLM and never decides an outcome. These are the §8.2.4 acceptance
// tests; each is mutation-verified to fail when the routing/wiring breaks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Gate, routeAnnotation } from "../src/index.js";
import { makeHumanChannel, makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// pure-allow content (disable shipped safe-default patterns) + a structured flag
// to raise a CONTROLLED ask, so we observe only Axis-B behavior.
const PURE = { denyPatterns: [], askPatterns: [] };
const ASKFLAG = { needsReview: { yes: "ask" } };
const asks = (action = {}) => ({ type: "book", needsReview: "yes", ...action });

// §8.2.4 #1 — annotate() buffers, and the next HITL check() carries the facts.
test("annotate() buffers; the next ask check() carries the fact in its event", async () => {
  const channel = makeHumanChannel([{ decision: "allow" }]);
  const gate = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: channel });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke", where: "you said under €300; the booking is €400" });
  const decision = await gate.check(asks());
  assert.equal(decision.outcome, "allow");
  assert.equal(channel.events.length, 1, "the ask reached the human channel");
  const ann = channel.events[0].annotations;
  assert.ok(Array.isArray(ann) && ann.length === 1, "event carries one annotation");
  assert.equal(ann[0].surface, true);
  assert.equal(ann[0].verdict, "broke");
  assert.equal(ann[0].where, "you said under €300; the booking is €400");
});

// §8.2.4 #2 — the routing function, every surface × reversible × knob cell.
test("routeAnnotation covers every surface × reversible × knob cell (§8.2.2)", () => {
  // honored (surface=false): never surfaced; reversible decides pass vs floor-ride.
  assert.equal(routeAnnotation(false, true,  "strict"),  "pass");
  assert.equal(routeAnnotation(false, false, "strict"),  "annotate-floor-ask");
  assert.equal(routeAnnotation(false, true,  "relaxed"), "pass");
  assert.equal(routeAnnotation(false, false, "relaxed"), "annotate-floor-ask");
  // broke (surface=true): irreversible always rides A's stop (knob irrelevant)...
  assert.equal(routeAnnotation(true, false, "strict"),  "annotate-floor-ask");
  assert.equal(routeAnnotation(true, false, "relaxed"), "annotate-floor-ask");
  // ...reversible is the only place the knob bites.
  assert.equal(routeAnnotation(true, true, "strict"),  "HITL");
  assert.equal(routeAnnotation(true, true, "relaxed"), "log");
  // default knob is strict.
  assert.equal(routeAnnotation(true, true), "HITL");
});

// §8.2.4 #3 — reversibility is read from the GATED ACTION's type, not the fact.
test("reversibility comes from the action's type (operator config), never the fact", async () => {
  // (a) fact lies with reversible:true, but the action type is NOT operator-declared
  // reversible → treated irreversible → surfaces even under relaxed. The fact's own
  // field is ignored; if it weren't, relaxed would have suppressed it.
  const ch1 = makeHumanChannel([{ decision: "allow" }]);
  const g1 = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: ch1,
    axisB: { reversibleEscalation: "relaxed", reversible: [] } });
  await g1.init();
  await g1.annotate({ surface: true, reversible: true, where: "x" });
  await g1.check(asks({ type: "book" }));
  assert.ok(ch1.events[0].annotations, "fact's reversible:true did NOT relax it — action type governs");

  // (b) same relaxed knob, but the ACTION's type IS declared reversible → log-only,
  // not attached. Proves the action drove the routing, not the fact.
  const ch2 = makeHumanChannel([{ decision: "allow" }]);
  const g2 = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: ch2,
    axisB: { reversibleEscalation: "relaxed", reversible: ["recall"] } });
  await g2.init();
  await g2.annotate({ surface: true, where: "x" });
  await g2.check(asks({ type: "recall" }));
  assert.equal(ch2.events[0].annotations, undefined, "reversible action + relaxed → logged, not surfaced");
});

// §8.2.4 #4 — facts hit the audit line AND are returned for agent feedback.
test("annotate audits the fact (sink 1) and drainAnnotations returns it (sink 2)", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke", where: "w", meta: { field: "price" } });
  const lines = (await gate.audit.readAll()).filter((l) => l.phase === "annotate");
  assert.equal(lines.length, 1, "one annotate audit line");
  assert.equal(lines[0].where, "w");
  assert.equal(lines[0].surface, true);

  const drained = gate.drainAnnotations();
  assert.equal(drained.length, 1, "drain returns the buffered fact");
  assert.equal(drained[0].verdict, "broke");
  assert.deepEqual(drained[0].meta, { field: "price" });
  assert.equal(gate.drainAnnotations().length, 0, "drain clears the buffer");
});

// §8.2.4 #5 — no annotate() ⇒ byte-identical decision path (additive).
test("no annotate() ⇒ the event has no annotations key (no regression)", async () => {
  const channel = makeHumanChannel([{ decision: "allow" }]);
  const gate = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: channel });
  await gate.init();
  const decision = await gate.check(asks());
  assert.equal(decision.outcome, "allow");
  assert.equal("annotations" in channel.events[0], false, "untouched event has no annotations key");
});

// §8.2.4 #6 — knob defaults to strict; relaxed never interrupts a reversible path.
test("knob default is strict; B never creates an interrupt on a reversible path", async () => {
  // default knob (omitted) is strict → reversible broke rides the ask.
  const chS = makeHumanChannel([{ decision: "allow" }]);
  const gS = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: chS,
    axisB: { reversible: ["recall"] } });
  await gS.init();
  await gS.annotate({ surface: true, where: "x" });
  await gS.check(asks({ type: "recall" }));
  assert.ok(chS.events[0].annotations, "default knob is strict → reversible broke surfaces");

  // B never CREATES a stop: a reversible action with no floor ask → no human call.
  const chN = makeHumanChannel([]); // throws if ever called
  const gN = new Gate({ audit: { path: null }, content: PURE, humanChannel: chN,
    axisB: { reversibleEscalation: "relaxed", reversible: ["recall"] } });
  await gN.init();
  await gN.annotate({ surface: true, where: "x" });
  const dN = await gN.check({ type: "recall" }); // allowed, no floor ask
  assert.equal(dN.outcome, "allow");
  assert.equal(chN.events.length, 0, "B raised no human ask on a reversible path");
});

// §8.2.4 #7 — B never auto-rejects: worst case is HITL, never a B-authored deny.
test("annotate never turns an allow into a deny (B never blocks alone)", async () => {
  const gate = new Gate({ audit: { path: null }, content: PURE });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke", where: "bad booking" });
  const d = await gate.check({ type: "anything" });
  assert.equal(d.outcome, "allow", "a surface fact cannot flip an allowed action to deny");
  assert.notEqual(d.rule, "axisB", "no Axis-B-authored decision rule exists");
});

// Security: the annotate audit line must not persist raw secrets in where/meta.
test("annotate audit line redacts secrets in where/meta (redaction is audit-only)", async () => {
  const gate = new Gate({ audit: { path: null }, secrets: { patterns: [/sk-[A-Za-z0-9]+/] } });
  await gate.init();
  await gate.annotate({ surface: true, where: "reply leaked sk-ABC123", meta: { token: "sk-XYZ789" } });
  const line = (await gate.audit.readAll()).find((l) => l.phase === "annotate");
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes("sk-ABC123"), "where secret not persisted raw");
  assert.ok(!serialized.includes("sk-XYZ789"), "meta secret not persisted raw");
  // the live fact (drain / humanChannel) keeps the real value — redaction is audit-only.
  assert.equal(gate.drainAnnotations()[0].where, "reply leaked sk-ABC123");
});

// Security: oversized fields are bounded so the annotate audit line stays atomic.
test("annotate bounds oversized verdict/where/meta (audit line stays under PIPE_BUF)", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const huge = "x".repeat(5000);
  await gate.annotate({ surface: true, verdict: huge, where: huge, meta: { blob: "y".repeat(5000) } });
  const fact = gate.drainAnnotations()[0];
  assert.ok(fact.where.length <= 300, "where bounded to 300 chars");
  assert.ok(fact.verdict.length <= 80, "verdict bounded to 80 chars");
  assert.equal(fact.meta._truncated, true, "oversized meta replaced with a marker");
  const line = (await gate.audit.readAll()).find((l) => l.phase === "annotate");
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") < 3500, "annotate audit line under the atomic-append cap");
});

// Security: redaction EXPANDS matches; the persisted line must stay atomic anyway.
// (Uses a real file — fileless mode skips truncation by design — and an expanding
// redactor: each /a/ match becomes a ~22-byte [REDACTED:...] tag.)
test("annotate audit line stays atomic when redaction expands where/meta (file path)", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ audit: { path: auditPath }, secrets: { patterns: [/a/] } });
    await gate.init();
    await gate.annotate({ surface: true, where: "a".repeat(300), meta: { k: "a".repeat(300) } });
    const raw = await readFile(auditPath, "utf8");
    for (const l of raw.split("\n").filter(Boolean)) {
      const bytes = Buffer.byteLength(l + "\n", "utf8");
      assert.ok(bytes <= 3500, `audit line must stay under the atomic-append cap; got ${bytes} bytes`);
    }
  } finally {
    await cleanup(dir);
  }
});

// The bounds above cap SIZE. These four pin the LOSS SHAPE the `Annotation` typedef
// documents — how a caller finds out (or doesn't) that a field was cut. A judge author
// sizes their output against these, so a doc claim that drifts from the code is a
// silent data-loss path, not a typo.

// `where` clips SILENTLY: the fact carries no marker, so an over-long `where` is
// indistinguishable from one that always fit. This is why `where` is documented as a
// one-line ADDRESS and never a place for bulk evidence.
test("where clips silently — the clipped fact carries no truncation marker", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const addresses = Array.from({ length: 8 }, (_, i) =>
    `src/backup.js(${56 + i},48): error TS1016: A required parameter cannot follow an optional parameter.`).join(" ");
  assert.ok(addresses.length > 300, "fixture must exceed the cap or the test proves nothing");
  await gate.annotate({ surface: true, where: addresses });
  const fact = gate.drainAnnotations()[0];
  assert.equal(fact.where.length, 300, "clipped to exactly the cap");
  assert.ok(!fact.where.includes("TRUNCAT"), "no marker is appended");
  assert.ok(addresses.startsWith(fact.where), "it is a prefix — the tail is simply gone");
});

// The SOURCE cap counts UTF-16 code units, not bytes, so `where` is not a byte
// budget: 300 CJK chars is 900 bytes. Append atomicity is preserved by the audit
// sink's own BYTE backstop (next test), never by this cap — documented so nobody
// sizes a byte budget against a character count.
test("the source caps count CHARACTERS, not bytes (300 CJK chars = 900 bytes)", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ surface: true, where: "危".repeat(400) });
  const { where } = gate.drainAnnotations()[0];
  assert.equal(where.length, 300, "clipped by code units");
  assert.equal(Buffer.byteLength(where, "utf8"), 900, "…which is 3x the byte count the cap implies");
});

// The SECOND bound, and the one a judge author gets burned by: redaction EXPANDS
// fields, so an in-budget meta can still be replaced wholesale in the persisted
// row. Sizing to the source cap does NOT guarantee field/stated/returned survive.
test("the audit sink re-bounds AFTER redaction: a LEGAL meta is still replaced in the row", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ audit: { path: auditPath }, secrets: { patterns: [/a/] } });
    await gate.init();
    const meta = { field: "price", stated: 300, returned: 400, note: "a".repeat(300) };
    assert.ok(Buffer.byteLength(JSON.stringify(meta), "utf8") < 1000, "meta is LEGAL at the source cap");
    await gate.annotate({ surface: true, verdict: "broke", where: "a".repeat(250), meta });
    const raw = await readFile(auditPath, "utf8");
    const row = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.phase === "annotate");
    assert.equal(row.meta._truncated, true, "a source-legal meta is replaced in the persisted row");
    assert.equal(row.meta.field, undefined, "the mechanical fields do not survive the audit bound");
    assert.ok(row.where.endsWith("[TRUNCATED]"), "the AUDIT clip DOES carry a marker (unlike the source clip)");
    assert.equal(row._truncated, true, "and flags the row");
    assert.ok(Buffer.byteLength(JSON.stringify(row), "utf8") < 3500, "still atomic");
  } finally {
    await cleanup(dir);
  }
});

// A third loss mode with its own marker — a consumer testing only `_truncated`
// reads an unserializable meta as intact.
test("an unserializable meta becomes {_unserializable}, a DIFFERENT marker", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const circular = { field: "price", stated: 300 };
  circular.self = circular;
  await gate.annotate({ surface: true, meta: circular });
  const { meta } = gate.drainAnnotations()[0];
  assert.equal(meta._unserializable, true, "distinct from _truncated");
  assert.equal(meta._truncated, undefined, "a consumer checking only _truncated reads this as intact");
  assert.equal(meta.field, undefined, "same total loss of the mechanical fields");
});

// `meta` is ALL-OR-NOTHING: over the cap the WHOLE object is replaced, so bulky
// evidence takes field/stated/returned down with it. This is the clause BA-20's
// judge contract depends on; the boundary is asserted from both sides.
test("meta over the cap loses EVERY key, not just the bulky one", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({
    surface: true,
    meta: { field: "price", stated: 300, returned: 400, evidence: "x".repeat(1200) },
  });
  const fact = gate.drainAnnotations()[0];
  assert.equal(fact.meta._truncated, true, "replaced by a marker (loud, unlike where)");
  assert.equal(fact.meta.field, undefined, "the mechanical fields are collateral damage");
  assert.equal(fact.meta.stated, undefined);
  assert.equal(fact.meta.returned, undefined);
});

test("the meta cap boundary: at 1000 bytes it survives, one byte over loses everything", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const sized = (bytes) => {
    const meta = { e: "x".repeat(bytes - Buffer.byteLength(JSON.stringify({ e: "" }), "utf8")) };
    assert.equal(Buffer.byteLength(JSON.stringify(meta), "utf8"), bytes, "fixture sized exactly");
    return meta;
  };
  await gate.annotate({ surface: true, meta: sized(1000) });
  await gate.annotate({ surface: true, meta: sized(1001) });
  const [at, over] = gate.drainAnnotations();
  assert.equal(at.meta._truncated, undefined, "exactly at the cap rides intact");
  assert.equal(over.meta._truncated, true, "one byte over is replaced wholesale");
});

// ── The malformed contract (§6.7) ───────────────────────────────────────────
// A fact that omits an explicit boolean `surface` used to normalize into a fact
// BYTE-IDENTICAL to a legitimate honored one: "I couldn't read what you sent" and
// "everything was fine" were the same value, and both routed as `honored`. Every
// doorway into that dead fact is now rejected, buffered NOWHERE, and audited as a
// DISTINCT phase (`annotate_malformed`) so a parser counting `phase === "annotate"`
// cannot miscount a rejection as a fact.

// Doorway 1 — the retired pre-E6 sketch shape (what BA-20 cited as current).
test("a sketch-shaped fact is MALFORMED: nothing buffered, loud audit row", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ kind: "violation", field: "price", stated: 300, returned: 400, text: "€400 exceeds €300" });
  assert.equal(gate.drainAnnotations().length, 0, "no dead fact reaches the authoritative drain");
  const lines = (await gate.audit.readAll()).filter((l) => l.phase === "annotate_malformed");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, "missing-surface");
  assert.equal((await gate.audit.readAll()).filter((l) => l.phase === "annotate").length, 0,
    "a malformed call emits NO `annotate` row — the phases are distinct");
});

// Doorway 2 — the shipped shape with `surface` simply forgotten.
test("a fact that forgets `surface` is MALFORMED, not silently honored", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ verdict: "broke", where: "you said under €300; the booking is €400" });
  assert.equal(gate.drainAnnotations().length, 0);
  assert.equal((await gate.audit.readAll()).filter((l) => l.phase === "annotate_malformed")[0].reason, "missing-surface");
});

// Doorway 3 — a non-boolean `surface`. Truthiness is NOT the contract: only an
// explicit boolean is, so `"false"` (a truthy string) can never mean surface.
test("a non-boolean `surface` is MALFORMED — truthy strings are not the contract", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  for (const s of ["true", "false", 1, 0, null]) {
    await gate.annotate({ surface: s, where: "x" });
  }
  assert.equal(gate.drainAnnotations().length, 0, "nothing buffered from any of them");
  assert.equal((await gate.audit.readAll()).filter((l) => l.phase === "annotate_malformed").length, 5);
});

// Doorway 4 — junk. Still ignored for buffering, but no longer SILENT.
test("a non-object fact is MALFORMED and annotate never throws", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  for (const junk of [null, undefined, "broke", 42, true]) {
    await gate.annotate(junk); // must not throw into the agent loop
  }
  assert.equal(gate.drainAnnotations().length, 0, "nothing buffered from junk");
  const lines = (await gate.audit.readAll()).filter((l) => l.phase === "annotate_malformed");
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l.reason === "not-an-object"));
});

// Doorway 5 — the array. `typeof [] === "object"`, so the non-object guard never
// caught it; a judge returning `[fact]` instead of `fact` used to buffer a dead
// fact that routed as `honored`. Its own reason, because the fix is different
// (unwrap the array, not add a field).
test("an ARRAY is MALFORMED with its own reason", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate([{ surface: true, verdict: "broke", where: "a real violation" }]);
  assert.equal(gate.drainAnnotations().length, 0, "the wrapped fact is NOT buffered");
  assert.equal((await gate.audit.readAll()).filter((l) => l.phase === "annotate_malformed")[0].reason, "array");
});

// Doorway 6 — a fact whose SHAPE is fine but that EXPLODES WHEN READ. `surface`,
// `verdict`, `where` and `meta` are all caller-controlled property reads, so any of
// them can be a getter or Proxy trap that throws. This threw out of `annotate()` and
// into the agent loop before the read was guarded — the one contract Axis B leans on
// ("a detector never breaks the loop it observes").
test("a fact that THROWS when read is MALFORMED, not an exception", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const revoked = Proxy.revocable({ surface: true }, {});
  revoked.revoke();
  const hostile = [
    { get surface() { throw new Error("boom"); } },                    // the guard's own read
    { surface: true, get verdict() { throw new Error("boom"); } },     // after the guard passes
    { surface: true, get where()   { throw new Error("boom"); } },
    { surface: true, get meta()    { throw new Error("boom"); } },
    revoked.proxy,                                                      // even Array.isArray throws
  ];
  for (const fact of hostile) {
    await gate.annotate(fact); // must not throw into the agent loop
  }
  assert.equal(gate.drainAnnotations().length, 0, "an unreadable fact buffers nothing");
  const lines = (await gate.audit.readAll()).filter((l) => l.phase === "annotate_malformed");
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l.reason === "unreadable"), "all five report `unreadable`");
});

// The rejection is WHOLE-FACT. A legitimate `surface: true` does NOT survive a
// hostile `where` — "I could only read half of this" is not "everything was fine",
// which is the exact conflation this rule exists to kill. It is still not invisible:
// the malformed row is the loud signal.
test("an unreadable fact is rejected whole, even when `surface` read fine", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke", get where() { throw new Error("boom"); } });
  assert.equal(gate.drainAnnotations().length, 0, "no half-fact is buffered");
  assert.equal((await gate.audit.readAll()).filter((l) => l.phase === "annotate").length, 0);
});

// The narrowed half of the contract, pinned so it cannot quietly widen again: the
// "never throws" guarantee covers THE FACT, not the audit WRITE. A failed append
// must stay loud — silently losing the durable record is the worse failure.
test("an audit WRITE failure still propagates (the guarantee covers the fact, not the disk)", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  gate.audit.emit = async () => { throw new Error("ENOSPC"); };
  await assert.rejects(
    () => gate.annotate({ surface: true, verdict: "broke", where: "a real violation" }),
    /ENOSPC/, "a well-formed fact surfaces the write failure");
  await assert.rejects(
    () => gate.annotate({ kind: "violation" }),
    /ENOSPC/, "and so does the malformed row's own write");
});

// TOCTOU: the value VALIDATED must be the value STORED. `surface` used to be read
// twice — once to check `typeof === "boolean"`, once to store `=== true` — so a
// getter answering differently on the second read validated as a real violation and
// landed as `surface:false`, routing as `honored` and vanishing. That is the exact
// fail-open this rejection rule exists to close, reached straight through the guard.
test("`surface` is read ONCE — a flipping getter cannot validate true and store false", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  let reads = 0;
  await gate.annotate({
    get surface() { reads++; return reads === 1; },   // true on the check, false on the store
    verdict: "broke", where: "a real violation",
  });
  const facts = gate.drainAnnotations();
  assert.equal(reads, 1, "the field is read exactly once");
  assert.equal(facts.length, 1, "the fact it validated as is the fact it kept");
  assert.equal(facts[0].surface, true, "stored value === validated value, not the flipped one");
  assert.equal(routeAnnotation(facts[0].surface, true, "strict"), "HITL", "and it still reaches the human");
});

// Same seam on the carried fields: a `verdict` that turns non-string on a second
// read must not slip a non-string past the type check into the stored fact.
test("`verdict` and `where` are read once too — no validate-vs-store divergence", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  let vReads = 0;
  await gate.annotate({
    surface: true,
    get verdict() { vReads++; return vReads === 1 ? "broke" : { evil: true }; },
    where: "w",
  });
  const facts = gate.drainAnnotations();
  assert.equal(vReads, 1, "verdict is read exactly once");
  assert.equal(facts[0].verdict, "broke", "the validated string is what was stored");
});

// Atomicity: redaction EXPANDS a field, and it runs pattern-by-pattern over text a
// previous pattern already rewrote — so a later pattern matching the `[REDACTED:…]`
// marker compounds. Any field added to the redactor MUST also be re-bounded in the
// audit truncation branch, or an 80-char source field can blow the ~3500-byte
// atomic-append cap (measured: 63 KB on one line before `verdict` was re-bounded).
test("a redaction-expanded `verdict` cannot break audit line atomicity", async (t) => {
  const dir = await makeTmpDir();
  t.after(() => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({
    audit: { path: auditPath },
    // each later pattern also matches characters the earlier one just INSERTED
    secrets: { patterns: [/x/g, /E/g, /D/g, /A/g, /T/g] },
  });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "x".repeat(80), where: "x".repeat(300), meta: { b: "x".repeat(400) } });

  const raw = (await readFile(auditPath, "utf8")).trim();
  assert.equal(raw.split("\n").length, 1, "one line");
  const bytes = Buffer.byteLength(raw, "utf8");
  assert.ok(bytes <= 3500, `line must stay under the atomic-append cap, got ${bytes} bytes`);
  const row = JSON.parse(raw);
  assert.equal(row._truncated, true, "and it says so");
  assert.ok(!row.verdict.includes("x".repeat(10)), "the raw secret text is still gone");
});

// Security: `verdict` is caller-judge free text, exactly like `where`. The 0.7.0
// redaction pass covered `where`/`meta` and MISSED it, so a judge that echoed a key
// into its verdict wrote the raw secret into the shared audit file.
test("a secret in `verdict` is redacted in the audit line, like `where`", async () => {
  const gate = new Gate({ audit: { path: null }, secrets: { patterns: [/sk-[A-Za-z0-9]{10,}/g] } });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke: sk-ABCDEFGHIJKLMNOP", where: "leaked sk-ABCDEFGHIJKLMNOP" });
  const row = (await gate.audit.readAll()).filter((l) => l.phase === "annotate")[0];
  assert.ok(!row.verdict.includes("sk-ABCDEFGHIJKLMNOP"), "verdict must not persist the raw key");
  assert.ok(row.verdict.includes("REDACTED"), "verdict carries the redaction marker");
  assert.ok(!row.where.includes("sk-ABCDEFGHIJKLMNOP"), "where stays redacted too (no regression)");
});

// The `meta` bound must be a FACT, not a request. `boundMeta` used to hand the
// caller's own object straight back, so a judge that kept appending evidence after
// annotate() grew the drained fact past the documented 1000-byte cap — and the audit
// row, serialized at emit time, kept the small version. The two sinks disagreed.
test("the `meta` bound survives the caller mutating their object afterwards", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const meta = { field: "price", stated: 300, returned: 400 };
  await gate.annotate({ surface: true, verdict: "broke", meta });

  meta.evidence = "x".repeat(5000);          // the caller keeps writing after handing it over
  const drained = gate.drainAnnotations()[0];
  assert.notEqual(drained.meta, meta, "the drained meta is not the caller's object");
  assert.equal(drained.meta.evidence, undefined, "the post-hoc write does not reach the fact");
  assert.ok(JSON.stringify(drained.meta).length <= 1000, "the cap still holds after the mutation");
  assert.deepEqual(drained.meta, { field: "price", stated: 300, returned: 400 }, "content is carried intact");

  const row = (await gate.audit.readAll()).filter((l) => l.phase === "annotate")[0];
  assert.deepEqual(row.meta, drained.meta, "audit sink and drain sink agree");
});

// NEGATIVE CONTROL — the rule must reject only the malformed. An explicit
// `surface: false` is a legitimate honored fact and still buffers normally.
test("an explicit `surface: false` is well-formed and still buffers", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ surface: false, verdict: "honored", where: "all good" });
  const facts = gate.drainAnnotations();
  assert.equal(facts.length, 1, "honored facts are NOT collateral damage of the rule");
  assert.equal(facts[0].surface, false);
  assert.equal((await gate.audit.readAll()).filter((l) => l.phase === "annotate_malformed").length, 0);
  assert.equal((await gate.audit.readAll()).filter((l) => l.phase === "annotate").length, 1);
});

// A rejection is a RECORD, not a verdict — same class as `unpriced`/`budget_warn`.
test("a malformed annotate changes no decision", async () => {
  const gate = new Gate({ audit: { path: null }, content: PURE });
  await gate.init();
  await gate.annotate({ kind: "violation", text: "€400 exceeds €300" });
  const d = await gate.check({ type: "llm", prompt: "hi" });
  assert.equal(d.outcome, "allow", "rejecting a fact cannot change what the gate allows");
});

// honored facts (surface=false) never reach the human, even on an ask.
test("a honored fact (surface=false) is not attached to the ask", async () => {
  const channel = makeHumanChannel([{ decision: "allow" }]);
  const gate = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: channel });
  await gate.init();
  await gate.annotate({ surface: false, verdict: "honored", where: "all good" });
  await gate.check(asks());
  assert.equal(channel.events[0].annotations, undefined, "honored ⇒ nothing to surface");
});
