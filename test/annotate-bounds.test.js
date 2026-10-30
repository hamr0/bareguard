// Ruling #71 - the annotation buffer cap (256 facts, not exported), the
// `annotate_dropped` audit phase, and the PARTIAL meta bound at both bound points
// (source: gate.js boundMeta; line: audit.js after redaction). Distinct inputs
// throughout; no sleeps. Real audit files where the on-disk line is the subject.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Gate } from "../src/index.js";
import { makeHumanChannel, makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

const PURE = { denyPatterns: [], askPatterns: [] };
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");
const fresh = async (extra = {}) => { const g = new Gate({ audit: { path: null }, ...extra }); await g.init(); return g; };
const lines = async (g, phase) => (await g.audit.readAll()).filter((l) => l.phase === phase);
const fileLines = async (p) => (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => ({ raw: l, row: JSON.parse(l) }));

// ── Change 1: the buffer cap ─────────────────────────────────────────────────

test("cap: 255 and 256 facts all survive, no annotate_dropped; 257 evicts exactly the oldest", async () => {
  for (const n of [255, 256]) {
    const g = await fresh();
    for (let i = 0; i < n; i++) await g.annotate({ surface: true, verdict: `s${n}-${i}` });
    const out = g.drainAnnotations();
    assert.equal(out.length, n);
    assert.equal(out[0].verdict, `s${n}-0`);
    assert.equal((await lines(g, "annotate_dropped")).length, 0, `${n} facts: nothing dropped`);
  }
  const g = await fresh();
  for (let i = 0; i < 257; i++) await g.annotate({ surface: true, verdict: `t-${i}` });
  const out = g.drainAnnotations();
  assert.equal(out.length, 256);
  assert.equal(out[0].verdict, "t-1", "all surface:true -> the oldest overall goes");
  assert.equal(out[255].verdict, "t-256");
  assert.equal((await lines(g, "annotate")).length, 257, "sink 1 still audits EVERY fact, evicted or not");
});

test("cap: eviction order with mixed surface - oldest surface:false first, never a surface:true while one exists", async () => {
  const g = await fresh();
  // positions: 0 true, 1 false, 2 true, 3 false, then 252 trues
  await g.annotate({ surface: true, verdict: "m-0" });
  await g.annotate({ surface: false, verdict: "m-1" });
  await g.annotate({ surface: true, verdict: "m-2" });
  await g.annotate({ surface: false, verdict: "m-3" });
  for (let i = 4; i < 256; i++) await g.annotate({ surface: true, verdict: `m-${i}` });
  await g.annotate({ surface: true, verdict: "m-256" }); // evicts m-1
  await g.annotate({ surface: true, verdict: "m-257" }); // evicts m-3
  await g.annotate({ surface: true, verdict: "m-258" }); // none left: evicts oldest overall, m-0
  const verdicts = g.drainAnnotations().map((a) => a.verdict);
  assert.equal(verdicts.length, 256);
  assert.ok(!verdicts.includes("m-1") && !verdicts.includes("m-3") && !verdicts.includes("m-0"));
  assert.equal(verdicts[0], "m-2");
});

test("cap: a broke fact survives a flood of honored facts; a full buffer of broke facts evicts the incoming honored one", async () => {
  const g = await fresh();
  await g.annotate({ surface: true, verdict: "broke", where: "price over budget" });
  for (let i = 0; i < 600; i++) await g.annotate({ surface: false, verdict: "honored", where: `h${i}` });
  const out = g.drainAnnotations();
  assert.equal(out.length, 256);
  assert.equal(out[0].verdict, "broke", "the broke fact is still first");
  assert.equal(out[1].where, "h345", "the survivors are the 255 NEWEST honored facts");
  assert.equal(out[255].where, "h599");

  const g2 = await fresh();
  for (let i = 0; i < 256; i++) await g2.annotate({ surface: true, verdict: `b${i}` });
  await g2.annotate({ surface: false, verdict: "late-honored" });
  const out2 = g2.drainAnnotations();
  assert.deepEqual(out2.map((a) => a.verdict), Array.from({ length: 256 }, (_, i) => `b${i}`));
});

test("cap: surface:false facts still buffer and drain below the cap", async () => {
  const g = await fresh();
  await g.annotate({ surface: false, verdict: "honored", where: "ok" });
  assert.equal(g.drainAnnotations().length, 1);
});

test("annotate_dropped: first line at the first eviction, the next 256 evictions later, cumulative across drains", async () => {
  const g = await fresh();
  for (let i = 0; i < 256; i++) await g.annotate({ surface: true, verdict: `d${i}` });
  assert.equal((await lines(g, "annotate_dropped")).length, 0);
  await g.annotate({ surface: true, verdict: "e1" });           // eviction 1
  let dropped = await lines(g, "annotate_dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].dropped, 1);
  assert.equal(dropped[0].action, null);
  // The line follows the annotate line of the fact that caused it.
  const all = await g.audit.readAll();
  const at = all.findIndex((l) => l.phase === "annotate_dropped");
  assert.equal(all[at - 1].phase, "annotate");
  assert.equal(all[at - 1].verdict, "e1");
  for (let i = 2; i <= 256; i++) await g.annotate({ surface: true, verdict: `e${i}` }); // evictions 2..256
  assert.equal((await lines(g, "annotate_dropped")).length, 1, "not one line per eviction");
  g.drainAnnotations();                                          // a drain must not reset the count
  for (let i = 0; i < 256; i++) await g.annotate({ surface: true, verdict: `f${i}` }); // fills to 256, no eviction
  assert.equal((await lines(g, "annotate_dropped")).length, 1);
  await g.annotate({ surface: true, verdict: "g1" });            // eviction 257
  dropped = await lines(g, "annotate_dropped");
  assert.equal(dropped.length, 2);
  assert.equal(dropped[1].dropped, 257, "cumulative, not reset by the drain");
  for (let i = 0; i < 255; i++) await g.annotate({ surface: true, verdict: `h${i}` }); // evictions 258..512
  assert.equal((await lines(g, "annotate_dropped")).length, 2);
  await g.annotate({ surface: true, verdict: "i1" });            // eviction 513
  dropped = await lines(g, "annotate_dropped");
  assert.deepEqual(dropped.map((l) => l.dropped), [1, 257, 513]);
});

const WIN_FILE_INFLIGHT = 4;

test("annotate_dropped under concurrency: one row per trigger value (1, 257, 513), fileless and file mode", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const fileGate = new Gate({ audit: { path: auditPath }, content: PURE });
    await fileGate.init();
    for (const [mode, g] of [["fileless", await fresh()], ["file", fileGate]]) {
      for (let i = 0; i < 256; i++) await g.annotate({ surface: true, verdict: `${mode}-fill${i}` });
      // win32 file mode: audit emit() takes a proper-lockfile lock (10 retries, <=200 ms apart), which gives up
      // under ~dozens of simultaneous emitters. So there, the same n annotates run as sequential groups of
      // WIN_FILE_INFLIGHT concurrent ones. Everywhere else (and fileless on win32) all n are in flight at once.
      const width = mode === "file" && process.platform === "win32" ? WIN_FILE_INFLIGHT : Infinity;
      const batch = async (n, tag) => {
        for (let from = 0; from < n; from += width) {
          const to = Math.min(n, from + width);
          await Promise.all(Array.from({ length: to - from }, (_, k) => g.annotate({ surface: true, verdict: `${mode}-${tag}${from + k}` })));
        }
      };
      await batch(10, "a");                       // evictions 1..10 in flight together
      assert.deepEqual((await lines(g, "annotate_dropped")).map((l) => l.dropped), [1], `${mode}: first row once`);
      await batch(247, "b");                      // evictions 11..257
      assert.deepEqual((await lines(g, "annotate_dropped")).map((l) => l.dropped), [1, 257], `${mode}: 257 once`);
      await batch(256, "c");                      // evictions 258..513
      assert.deepEqual((await lines(g, "annotate_dropped")).map((l) => l.dropped), [1, 257, 513], `${mode}: 513 once`);
      assert.equal((await lines(g, "annotate")).length, 256 + 10 + 247 + 256);
    }
    const onDisk = (await fileLines(auditPath)).filter((l) => l.row.phase === "annotate_dropped");
    assert.deepEqual(onDisk.map((l) => l.row.dropped), [1, 257, 513]);
  } finally { await cleanup(dir); }
});

test("annotate_dropped reaches the real file as a small intact line; a full buffer still rides an ask", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const channel = makeHumanChannel([{ decision: "allow" }]);
    const g = new Gate({ audit: { path: auditPath }, content: PURE, flags: { needsReview: { yes: "ask" } }, humanChannel: channel });
    await g.init();
    for (let i = 0; i < 260; i++) await g.annotate({ surface: true, verdict: `r${i}` });
    const dropLines = (await fileLines(auditPath)).filter((l) => l.row.phase === "annotate_dropped");
    assert.equal(dropLines.length, 1);
    assert.equal(dropLines[0].row.dropped, 1);
    const d = await g.check({ type: "book", needsReview: "yes" });
    assert.equal(d.outcome, "allow", "eviction changed no decision");
    assert.equal(channel.events[0].annotations.length, 256, "the ask carries what remains in the buffer");
  } finally { await cleanup(dir); }
});

// ── Change 2a: the source bound ──────────────────────────────────────────────

const sized = (extra, total) => { // {...extra, pad: "x"*n} whose JSON is exactly `total` bytes
  const base = bytesOf({ ...extra, pad: "" });
  return { ...extra, pad: "x".repeat(total - base) };
};

test("source bound: AT 1000 rides intact, UNDER rides intact, OVER drops the largest key and keeps the rest", async () => {
  const g = await fresh();
  const at = sized({ id: "a1", rid: "r1" }, 1000);
  const under = sized({ id: "a2", rid: "r2" }, 999);
  const over = sized({ id: "a3", rid: "r3" }, 1001);
  assert.deepEqual([bytesOf(under), bytesOf(at), bytesOf(over)], [999, 1000, 1001]);
  await g.annotate({ surface: true, meta: under });
  await g.annotate({ surface: true, meta: at });
  await g.annotate({ surface: true, meta: over });
  const [u, a, o] = g.drainAnnotations().map((f) => f.meta);
  assert.deepEqual(u, under);
  assert.deepEqual(a, at);
  assert.deepEqual(o, { id: "a3", rid: "r3", _truncated: true, bytes: 1001, _droppedKeys: ["pad"] });
  assert.ok(bytesOf(o) <= 1000);
});

test("source bound: barebox shape - id, rid, agent survive a 5 KB url; markers say what went", async () => {
  const g = await fresh();
  await g.annotate({ surface: true, verdict: "broke", meta: { id: "f-77", rid: "run-9", agent: "scout", url: "https://e.example/" + "p".repeat(5000) } });
  const { meta } = g.drainAnnotations()[0];
  assert.equal(meta.id, "f-77");
  assert.equal(meta.rid, "run-9");
  assert.equal(meta.agent, "scout");
  assert.equal(meta.url, undefined);
  assert.equal(meta._truncated, true);
  assert.equal(typeof meta.bytes, "number");
  assert.ok(meta.bytes > 5000);
  assert.deepEqual(meta._droppedKeys, ["url"]);
});

test("source bound: drops largest first, ties broken by name, deterministic; strings are never cut", async () => {
  const g = await fresh();
  // two equal-size big keys: b and a. Dropping the tie must pick "a" first (name ascending).
  const meta = { keep: "k", b: "y".repeat(450), a: "z".repeat(450), c: "w".repeat(300) };
  await g.annotate({ surface: true, meta });
  await g.annotate({ surface: true, meta: { ...meta } });
  const [m1, m2] = g.drainAnnotations().map((f) => f.meta);
  assert.deepEqual(m1, m2, "same input, same output");
  assert.deepEqual(m1._droppedKeys, ["a"], "one drop of the largest (tie -> 'a') is enough");
  assert.equal(m1.b, "y".repeat(450), "a surviving string is whole");
  assert.equal(m1.c, "w".repeat(300));
  // survivors keep original order, markers after
  assert.deepEqual(Object.keys(m1), ["keep", "b", "c", "_truncated", "bytes", "_droppedKeys"]);
});

test("source bound: a caller key named like a marker cannot forge the result - the marker wins", async () => {
  const g = await fresh();
  await g.annotate({ surface: true, meta: { id: "x1", _truncated: false, bytes: 3, _droppedKeys: [], _droppedKeysMore: 0, big: "q".repeat(1200) } });
  const { meta } = g.drainAnnotations()[0];
  assert.equal(meta._truncated, true);
  assert.notEqual(meta.bytes, 3);
  assert.ok(meta.bytes > 1200);
  assert.equal(meta.id, "x1");
  assert.ok(meta._droppedKeys.includes("big"));
  for (const k of ["_truncated", "bytes", "_droppedKeys", "_droppedKeysMore"]) {
    if (k !== "_truncated" && k !== "bytes" && k !== "_droppedKeys") assert.equal(meta[k], undefined, "no stray caller marker");
  }
  assert.ok(meta._droppedKeys.includes("bytes") && meta._droppedKeys.includes("_truncated"), "the colliding caller keys are listed as dropped");
  // a colliding key alone, under the cap, is the caller's own data and rides unchanged
  await g.annotate({ surface: true, meta: { _truncated: false, id: "x2" } });
  assert.deepEqual(g.drainAnnotations()[0].meta, { _truncated: false, id: "x2" });
});

test("source bound: array meta and nothing-fits end as markers only; many/long key names are bounded and counted", async () => {
  const g = await fresh();
  await g.annotate({ surface: true, meta: Array.from({ length: 400 }, (_, i) => `item-${i}`) });
  await g.annotate({ surface: true, meta: { only: "o".repeat(1500) } });
  const many = {};
  for (let i = 0; i < 60; i++) many[`k${String(i).padStart(2, "0")}-${"n".repeat(70)}`] = "v".repeat(30);
  await g.annotate({ surface: true, meta: many });
  const [arr, one, mn] = g.drainAnnotations().map((f) => f.meta);
  assert.deepEqual(Object.keys(arr), ["_truncated", "bytes"]);
  assert.equal(arr._truncated, true);
  assert.deepEqual(one, { _truncated: true, bytes: bytesOf({ only: "o".repeat(1500) }), _droppedKeys: ["only"] });
  assert.ok(bytesOf(mn) <= 1000);
  assert.equal(mn._truncated, true);
  assert.ok(mn._droppedKeys.length <= 16);
  for (const n of mn._droppedKeys) assert.ok(n.length <= 65, "names are clipped (64 chars + ellipsis)");
  assert.equal(mn._droppedKeys.length + mn._droppedKeysMore + Object.keys(mn).filter((k) => k.startsWith("k")).length, 60,
    "listed + elided + surviving = every key");
});

test("source bound: __proto__ is stripped at every depth and the copy is decoupled, also past the bound", async () => {
  const g = await fresh();
  const hostile = JSON.parse('{"id":"p1","__proto__":{"x":1},"deep":{"__proto__":{"y":2},"k":1},"big":"' + "b".repeat(1200) + '"}');
  await g.annotate({ surface: true, meta: hostile });
  const { meta } = g.drainAnnotations()[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(meta, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyNames(meta.deep), ["k"]);
  hostile.id = "mutated";
  assert.equal(meta.id, "p1");
});

// ── Change 2b: the audit-line bound (real file) ──────────────────────────────

test("line bound: id/rid/agent stay ON DISK when redaction expands the line (source bound AND line bound)", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    // /Q+/ is absent from every KEY, so redaction expands only VALUES. note passes the
    // source bound (<1000) and the 5 KB url is dropped there; redaction then expands
    // `note` and `where` past the line cap, forcing the line bound to run on the meta.
    const gate = new Gate({ audit: { path: auditPath }, secrets: { patterns: [/Q/] } });
    await gate.init();
    const meta = { id: "f-31", rid: "run-8", agent: "scout", note: "Q".repeat(100), url: "https://e.example/" + "u".repeat(5000) };
    await gate.annotate({ surface: true, verdict: "broke", where: "Q".repeat(250), meta });
    const [fact] = gate.drainAnnotations();
    assert.deepEqual(fact.meta._droppedKeys, ["url"], "source bound dropped only the url");
    assert.equal(fact.meta.note, "Q".repeat(100));
    const [{ raw, row }] = (await fileLines(auditPath)).filter((l) => l.row.phase === "annotate");
    assert.ok(Buffer.byteLength(raw + "\n", "utf8") <= 3500, "line under the atomic-append cap");
    assert.equal(row._truncated, true, "the line bound ran (this is the redaction-expanded path)");
    assert.ok(row.where.endsWith("[TRUNCATED]"));
    assert.equal(row.meta.id, "f-31");
    assert.equal(row.meta.rid, "run-8");
    assert.equal(row.meta.agent, "scout");
    assert.equal(row.meta.note, undefined, "the expanded key is what went");
    assert.equal(row.meta._truncated, true);
    assert.equal(row.meta.bytes, fact.meta.bytes, "the ORIGINAL size from the source bound is kept");
    assert.deepEqual(row.meta._droppedKeys, ["url", "note"], "earlier names carried forward, new ones appended");
  } finally { await cleanup(dir); }
});

test("line bound: a legal meta that only redaction pushed past 1000 loses its expanded key, not everything", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ audit: { path: auditPath }, secrets: { patterns: [/Q/] } });
    await gate.init();
    const meta = { field: "price", stated: 300, returned: 400, note: "Q".repeat(300) };
    await gate.annotate({ surface: true, verdict: "broke", where: "Q".repeat(250), meta });
    const [{ raw, row }] = (await fileLines(auditPath)).filter((l) => l.row.phase === "annotate");
    assert.ok(Buffer.byteLength(raw + "\n", "utf8") <= 3500);
    assert.deepEqual(
      { field: row.meta.field, stated: row.meta.stated, returned: row.meta.returned },
      { field: "price", stated: 300, returned: 400 });
    assert.equal(row.meta.note, undefined);
    assert.deepEqual(row.meta._droppedKeys, ["note"]);
    assert.equal(row.meta._truncated, true);
  } finally { await cleanup(dir); }
});

test("line bound: a meta of only-big keys ends as markers on the line, and every line is under the cap and in BYTES", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ audit: { path: auditPath }, secrets: { patterns: [/Q/] } });
    await gate.init();
    // CJK: 3 bytes per UTF-16 unit - the byte count, not the unit count, must be bounded.
    await gate.annotate({ surface: true, verdict: "危".repeat(80), where: "危".repeat(300), meta: { a: "Q".repeat(200), b: "Q".repeat(200), c: "危".repeat(200) } });
    for (const { raw, row } of await fileLines(auditPath)) {
      assert.ok(Buffer.byteLength(raw + "\n", "utf8") <= 3500, `${row.phase} line must stay atomic`);
    }
    const row = (await fileLines(auditPath)).find((l) => l.row.phase === "annotate").row;
    assert.equal(row.meta._truncated, true);
    assert.ok(bytesOf(row.meta) <= 1000);
  } finally { await cleanup(dir); }
});

test("regression: a 6 KB url in `action` on check/record lines still clips; rid, tool and aid survive", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ audit: { path: auditPath }, content: PURE });
    await gate.init();
    const action = { type: "fetch", tool: "browse", rid: "run-5", url: "https://e.example/" + "z".repeat(6000) };
    const d = await gate.check(action);
    assert.equal(d.outcome, "allow");
    await gate.record(action, { costUsd: 0.01 }, { aid: d.aid });
    const rows = (await fileLines(auditPath)).filter((l) => l.row.phase === "gate" || l.row.phase === "record");
    assert.ok(rows.length >= 2);
    for (const { raw, row } of rows) {
      assert.ok(Buffer.byteLength(raw + "\n", "utf8") <= 3500);
      assert.ok(row.action.url.endsWith("[TRUNCATED]"), `${row.phase}: url clipped`);
      assert.ok(Buffer.byteLength(row.action.url, "utf8") < 400);
      assert.equal(row.action.rid, "run-5");
      assert.equal(row.action.tool, "browse");
      assert.equal(row.aid, d.aid);
    }
  } finally { await cleanup(dir); }
});
