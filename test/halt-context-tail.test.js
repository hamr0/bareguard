// Ruling #72: haltContext() is an incremental tally over the audit tail, not a
// full re-read per ask. Same answers (differential vs the old full-scan formula),
// bounded cost (bytes-read spy, no timings).
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

const allow = async () => ({ decision: "allow" });

// The OLD formula, verbatim, over a full readAll().
function reference(gate, lines) {
  const records = lines.filter(l => l.phase === "record");
  const totUsd = records.reduce((a, r) => a + (r.result?.costUsd ?? 0), 0);
  const totTok = records.reduce((a, r) => a + (r.result?.tokens ?? 0), 0);
  const last5 = records.slice(-5).map(r => r.result?.costUsd ?? 0);
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const earliestTs = lines[0]?.ts ? Date.parse(lines[0].ts) : null;
  const latestTs = lines.at(-1)?.ts ? Date.parse(lines.at(-1).ts) : null;
  return {
    spent: { costUsd: totUsd, tokens: totTok },
    cap: { costUsd: gate.budget.capUsd, tokens: gate.budget.capTokens },
    turns: gate.limits.turns,
    maxTurns: gate.limits.maxTurns,
    timeElapsedMs: (earliestTs && latestTs) ? (latestTs - earliestTs) : 0,
    spendRate: { avgPerTurn: records.length ? totUsd / records.length : 0, last5Avg: avg(last5), last5 },
  };
}
async function same(gate) {
  const lines = await gate.audit.readAll();
  assert.deepEqual(await gate.haltContext(), reference(gate, lines));
}
function mulberry(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
async function mk(t, extra = {}) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const mkGate = async (o = {}) => { const g = new Gate({ audit: { path: auditPath }, humanChannel: allow, ...extra, ...o }); await g.init(); return g; };
  return { auditPath, mkGate };
}
const askAction = (i) => ({ type: "fetch", url: `https://api/delete-acct-${i}` });

test("differential: randomized records/annotates/asks, two gates on one file, cold start", async (t) => {
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = mulberry(seed);
    const { mkGate } = await mk(t);
    const gates = [await mkGate(), await mkGate()];
    const steps = 6 + Math.floor(rnd() * 30);
    for (let i = 0; i < steps; i++) {
      const g = gates[Math.floor(rnd() * gates.length)];
      const op = Math.floor(rnd() * 4);
      if (op === 0) await g.record({ type: "x", n: i }, { costUsd: Math.round(rnd() * 1e4) / 1e5, tokens: Math.floor(rnd() * 900) });
      else if (op === 1) await g.record({ type: "y", n: i }, { tokens: Math.floor(rnd() * 50) });
      else if (op === 2) await g.annotate({ surface: false, verdict: `v${seed}-${i}-中\u{1F600}` });
      else await g.check(askAction(i)); // ask path -> event.context
      if (rnd() < 0.5) await same(g);
    }
    for (const g of gates) await same(g);
    await same(await mkGate()); // cold start over the existing file
  }
});

test("event.context on the ask path equals the old formula", async (t) => {
  const events = [];
  const { mkGate } = await mk(t);
  const g = await mkGate({ humanChannel: async (e) => { events.push(e); return { decision: "allow" }; } });
  await g.record({ type: "x" }, { costUsd: 0.25, tokens: 7 });
  await g.check(askAction(1));
  assert.equal(events.length, 1);
  // context is computed before the ask's own audit lines, so compare to a fresh gate's view of the same prefix
  assert.deepEqual(events[0].context.spent, { costUsd: 0.25, tokens: 7 });
  assert.deepEqual(events[0].context.spendRate.last5, [0.25]);
});

test("ask path does not call audit.readAll (spy)", async (t) => {
  const { mkGate } = await mk(t);
  const g = await mkGate();
  await g.record({ type: "x" }, { costUsd: 0.1, tokens: 1 });
  let calls = 0;
  const orig = g.audit.readAll.bind(g.audit);
  g.audit.readAll = async () => { calls++; return orig(); };
  for (let i = 0; i < 5; i++) await g.check(askAction(i));
  await g.haltContext();
  assert.equal(calls, 0);
});

test("bytes read: N asks on a big file read about the file once", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const seed = await mkGate();
  for (let i = 0; i < 300; i++) await seed.record({ type: "x", n: i, pad: "p".repeat(400) }, { costUsd: 0.001, tokens: 1 });
  const size = (await fsp.stat(auditPath)).size;
  const g = await mkGate();
  let bytes = 0;
  const origOpen = fsp.open, origReadFile = fsp.readFile;
  fsp.open = async (...a) => {
    const fh = await origOpen.apply(fsp, a);
    const r = fh.read.bind(fh);
    fh.read = async (...b) => { const res = await r(...b); bytes += res.bytesRead; return res; };
    return fh;
  };
  fsp.readFile = async (...a) => { const res = await origReadFile.apply(fsp, a); bytes += Buffer.byteLength(res); return res; };
  try {
    const N = 40;
    for (let i = 0; i < N; i++) await g.check(askAction(i));
  } finally { fsp.open = origOpen; fsp.readFile = origReadFile; }
  const finalSize = (await fsp.stat(auditPath)).size;
  assert.ok(bytes <= finalSize + 64 * 1024, `read ${bytes} bytes, file ${finalSize} (start ${size})`);
  assert.ok(bytes < 3 * finalSize, "not N x file");
});

test("partial trailing line is held back, consumed once complete", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const g = await mkGate();
  await g.record({ type: "x" }, { costUsd: 0.5, tokens: 2 });
  const line = JSON.stringify({ phase: "record", ts: new Date().toISOString(), result: { costUsd: 0.25, tokens: 3 } });
  await fsp.appendFile(auditPath, line.slice(0, 20));
  let ctx = await g.haltContext();
  assert.deepEqual(ctx.spent, { costUsd: 0.5, tokens: 2 });
  await fsp.appendFile(auditPath, line.slice(20) + "\n");
  ctx = await g.haltContext();
  assert.deepEqual(ctx.spent, { costUsd: 0.75, tokens: 5 });
  await same(g);
});

test("multi-byte UTF-8 across chunk edges and a line longer than the chunk", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const g = await mkGate();
  g.audit.tailChunkBytes = 7; // tiny: every line spans many chunks, cuts land mid-codepoint
  const ts = new Date().toISOString();
  const mk1 = (c, pad) => JSON.stringify({ phase: "record", ts, action: { pad }, result: { costUsd: c, tokens: 1 } }) + "\n";
  let blob = "";
  for (let i = 0; i < 20; i++) blob += mk1(0.01 * (i + 1), "中\u{1F600}é".repeat(1 + i * 5));
  await fsp.writeFile(auditPath, blob);
  await same(g);
  await fsp.appendFile(auditPath, mk1(0.5, "\u{1F600}".repeat(5000)));
  await same(g);
  for (const sz of [1, 2, 3, 64, 4096]) {
    g.audit.tailChunkBytes = sz;
    g._haltTally = undefined;
    await same(g);
  }
});

test("empty file, ENOENT", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const g = await mkGate();
  await fsp.rm(auditPath, { force: true });
  await same(g);
  assert.equal((await g.haltContext()).spent.costUsd, 0);
  await fsp.writeFile(auditPath, "");
  await same(g);
});

test("truncated / rotated file resets and rescans from 0", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const g = await mkGate();
  for (let i = 0; i < 10; i++) await g.record({ type: "x", n: i, pad: "z".repeat(100) }, { costUsd: 1, tokens: 1 });
  assert.equal((await g.haltContext()).spent.costUsd, 10);
  const ts = new Date().toISOString();
  await fsp.writeFile(auditPath, JSON.stringify({ phase: "record", ts, result: { costUsd: 0.5, tokens: 9 } }) + "\n");
  await same(g);
  assert.deepEqual((await g.haltContext()).spent, { costUsd: 0.5, tokens: 9 });
  await fsp.rm(auditPath);
  assert.deepEqual((await g.haltContext()).spent, { costUsd: 0, tokens: 0 });
});

test("fileless mode tallies by index", async () => {
  const g = new Gate({ audit: { path: null }, humanChannel: allow });
  await g.init();
  for (let i = 0; i < 8; i++) {
    await g.record({ type: "x" }, { costUsd: 0.1 * i, tokens: i });
    await same(g);
  }
  await g.check(askAction(1));
  await same(g);
});

test("concurrent asks do not double count", async (t) => {
  const { mkGate } = await mk(t);
  const g = await mkGate();
  for (let i = 0; i < 12; i++) await g.record({ type: "x", n: i }, { costUsd: 0.5, tokens: 10 });
  const ctxs = await Promise.all(Array.from({ length: 30 }, () => g.haltContext()));
  for (const c of ctxs) assert.deepEqual(c.spent, { costUsd: 6, tokens: 120 });
  const decs = await Promise.all(Array.from({ length: 20 }, (_, i) => g.check(askAction(i))));
  assert.ok(decs.every(d => d.outcome === "allow"));
  await same(g);
  await same(await mkGate());
});

test("malformed complete line throws like readAll, does not advance, recovers once removed", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const g = await mkGate();
  await g.record({ type: "x" }, { costUsd: 1, tokens: 1 });
  const before = await fsp.readFile(auditPath, "utf8");
  await fsp.appendFile(auditPath, "{not json\n");
  await assert.rejects(() => g.haltContext(), SyntaxError);
  await assert.rejects(() => g.audit.readAll(), SyntaxError);
  await assert.rejects(() => g.haltContext(), SyntaxError); // still thrown, not swallowed
  await fsp.writeFile(auditPath, before); // shorter-or-equal rewrite
  const ok = JSON.stringify({ phase: "record", ts: new Date().toISOString(), result: { costUsd: 2, tokens: 2 } });
  await fsp.appendFile(auditPath, ok + "\n");
  await same(g);
  assert.equal((await g.haltContext()).spent.costUsd, 3);
});

test("failed read leaves the tally intact and later calls recover", async (t) => {
  const { mkGate } = await mk(t);
  const g = await mkGate();
  await g.record({ type: "x" }, { costUsd: 1, tokens: 1 });
  await same(g);
  await g.record({ type: "x" }, { costUsd: 2, tokens: 2 });
  const origOpen = fsp.open;
  fsp.open = async () => { throw Object.assign(new Error("boom"), { code: "EIO" }); };
  try { await assert.rejects(() => g.haltContext(), /boom/); } finally { fsp.open = origOpen; }
  await same(g);
  assert.equal((await g.haltContext()).spent.costUsd, 3);
});

test("a read failing MID-scan does not advance or corrupt the tally", async (t) => {
  const { mkGate } = await mk(t);
  const g = await mkGate();
  g.audit.tailChunkBytes = 64;
  for (let i = 0; i < 6; i++) await g.record({ type: "x", n: i }, { costUsd: 1, tokens: 1 });
  const origOpen = fsp.open;
  let n = 0;
  fsp.open = async (...a) => {
    const fh = await origOpen.apply(fsp, a);
    const r = fh.read.bind(fh);
    fh.read = async (...b) => { if (++n === 3) throw new Error("mid-scan"); return r(...b); };
    return fh;
  };
  try { await assert.rejects(() => g.haltContext(), /mid-scan/); } finally { fsp.open = origOpen; }
  await same(g); // full rescan from committed offset, no partial double count
  assert.equal((await g.haltContext()).spent.costUsd, 6);
});
