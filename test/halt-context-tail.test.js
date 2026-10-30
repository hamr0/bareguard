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
  // win32 emit() takes a proper-lockfile lock (10 retries) that gives up under ~dozens of simultaneous emitters,
  // so there the 20 asks run as sequential groups of 4 concurrent ones; elsewhere all 20 are in flight at once.
  const width = process.platform === "win32" ? 4 : 20;
  const decs = [];
  for (let from = 0; from < 20; from += width) {
    decs.push(...await Promise.all(Array.from({ length: Math.min(width, 20 - from) }, (_, k) => g.check(askAction(from + k)))));
  }
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

test("concurrent asks share one scan: bytes read stay about one file, not N", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const seed = await mkGate();
  for (let i = 0; i < 200; i++) await seed.record({ type: "x", n: i, pad: "p".repeat(300) }, { costUsd: 0.01, tokens: 1 });
  const g = await mkGate();
  let bytes = 0;
  const origOpen = fsp.open;
  fsp.open = async (...a) => {
    const fh = await origOpen.apply(fsp, a);
    const r = fh.read.bind(fh);
    fh.read = async (...b) => { const res = await r(...b); bytes += res.bytesRead; return res; };
    return fh;
  };
  try { await Promise.all(Array.from({ length: 30 }, () => g.haltContext())); } finally { fsp.open = origOpen; }
  const size = (await fsp.stat(auditPath)).size;
  assert.ok(bytes <= size + 64 * 1024, `read ${bytes} for a ${size}-byte file`);
});

// ── File identity: swaps and in-place rewrites (dev/ino + whole-last-line anchor) ──
const TS = "2026-10-30T00:00:00.000Z";
const rec = (cost, tok, pad = "z".repeat(100)) => JSON.stringify({ phase: "record", ts: TS, result: { costUsd: cost, tokens: tok }, pad }) + "\n";
const lineSet = (n, cost, tok = 1) => Array.from({ length: n }, () => rec(cost, tok)).join("");
async function swapIn(auditPath, text) { // new inode: write beside, rename over
  await fsp.writeFile(auditPath + ".new", text);
  await fsp.rename(auditPath + ".new", auditPath);
}
const fullReread = async (g) => {
  const lines = await g.audit.readAll();
  return { costUsd: lines.reduce((a, l) => a + (l.phase === "record" ? l.result.costUsd : 0), 0),
           tokens: lines.reduce((a, l) => a + (l.phase === "record" ? l.result.tokens : 0), 0) };
};

test("identity: file replaced by a different, LARGER file is rescanned (spent equals a fresh full re-read)", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  await fsp.writeFile(auditPath, lineSet(10, 1));
  const g = await mkGate();
  assert.deepEqual((await g.haltContext()).spent, { costUsd: 10, tokens: 10 });
  const off = g._haltTally.offset;
  await swapIn(auditPath, lineSet(30, 2));
  assert.ok((await fsp.stat(auditPath)).size > off, "precondition: new file is larger than the offset");
  const spent = (await g.haltContext()).spent;
  assert.deepEqual(spent, { costUsd: 60, tokens: 30 });
  assert.deepEqual(spent, await fullReread(g));
});

test("identity: file replaced by a SMALLER file is rescanned", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  await fsp.writeFile(auditPath, lineSet(10, 1));
  const g = await mkGate();
  await g.haltContext();
  await swapIn(auditPath, lineSet(3, 5));
  const spent = (await g.haltContext()).spent;
  assert.deepEqual(spent, { costUsd: 15, tokens: 3 });
  assert.deepEqual(spent, await fullReread(g));
});

// Lines built by a real gate, so they carry ts / seq / run_id / aid like production lines.
async function realLines(t, n, cost) {
  const { auditPath, mkGate } = await mk(t);
  const g = await mkGate();
  for (let i = 0; i < n; i++) await g.record({ type: "x", n: i }, { costUsd: cost, tokens: 1 });
  return fsp.readFile(auditPath, "utf8");
}
// Make every open() report the given dev/ino, as a filesystem that reuses an inode number would.
function pinIdentity(dev, ino) {
  const origOpen = fsp.open;
  fsp.open = async (...a) => {
    const fh = await origOpen.apply(fsp, a);
    const st = fh.stat.bind(fh);
    fh.stat = async (...b) => { const x = await st(...b); return b[0]?.bigint ? Object.assign(x, { dev, ino }) : x; };
    return fh;
  };
  return () => { fsp.open = origOpen; };
}

test("identity: delete + recreate + regrow past the offset is rescanned even when the inode number is reused (real gate lines)", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  await fsp.writeFile(auditPath, await realLines(t, 10, 1));
  const g = await mkGate();
  assert.deepEqual((await g.haltContext()).spent, { costUsd: 10, tokens: 10 });
  const { dev, ino } = g._haltTally.anchor;
  await fsp.rm(auditPath);
  await fsp.writeFile(auditPath, await realLines(t, 30, 3));
  const restore = pinIdentity(dev, ino); // simulate inode reuse on any OS: identity cannot help here
  try {
    const spent = (await g.haltContext()).spent;
    assert.deepEqual(spent, { costUsd: 90, tokens: 30 });
    assert.deepEqual(spent, await fullReread(g));
  } finally { restore(); }
});

test("identity: same-shaped lines that differ only EARLY in the line (past a 64-byte tail) are told apart", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  await fsp.writeFile(auditPath, lineSet(10, 1));
  const g = await mkGate();
  await g.haltContext();
  const { dev, ino } = g._haltTally.anchor;
  await fsp.rm(auditPath);
  await fsp.writeFile(auditPath, lineSet(30, 3)); // every line ends in the same 100 'z' + tail
  const restore = pinIdentity(dev, ino);
  try {
    const spent = (await g.haltContext()).spent;
    assert.deepEqual(spent, { costUsd: 90, tokens: 30 });
    assert.deepEqual(spent, await fullReread(g));
  } finally { restore(); }
});

test("identity: the byte before the anchored line must be a newline (scanFrom, direct)", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  await fsp.writeFile(auditPath, lineSet(5, 1));
  const g = await mkGate();
  const first = await g.audit.scanFrom(0, undefined, () => {});
  const buf = await fsp.readFile(auditPath);
  assert.deepEqual(await g.audit.scanFrom(first.end, first.anchor, () => {}), { end: first.end, anchor: first.anchor });
  buf[first.end - first.anchor.len - 1] = 0x20; // the line's bytes are intact; the byte before is no longer '\n'
  await fsp.writeFile(auditPath, buf);
  assert.deepEqual(await g.audit.scanFrom(first.end, first.anchor, () => {}), { truncated: true });
});

test("identity: a foreign line longer than the anchor bound is anchored by its last bytes and a rewrite of them is rescanned", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  const longLine = (c) => JSON.stringify({ phase: "record", ts: TS, result: { costUsd: 1, tokens: 1 }, pad: c.repeat(6000) }) + "\n";
  await fsp.writeFile(auditPath, longLine("a"));
  const g = await mkGate();
  await g.haltContext();
  assert.equal(g._haltTally.anchor.partial, true);
  await fsp.writeFile(auditPath, longLine("b") + lineSet(3, 2)); // in place, same inode, bigger
  const spent = (await g.haltContext()).spent;
  assert.deepEqual(spent, { costUsd: 1 + 6, tokens: 4 });
  assert.deepEqual(spent, await fullReread(g));
});

test("identity: copytruncate (same inode, truncated then regrown past the offset) is rescanned via the line anchor", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  await fsp.writeFile(auditPath, lineSet(10, 1));
  const g = await mkGate();
  await g.haltContext();
  const ino = (await fsp.stat(auditPath)).ino;
  await fsp.writeFile(auditPath, Array.from({ length: 30 }, (_, i) => rec(2, 1, `y${i}`.padEnd(100, "y"))).join("")); // in place: O_TRUNC, same inode
  assert.equal((await fsp.stat(auditPath)).ino, ino, "precondition: same inode");
  const spent = (await g.haltContext()).spent;
  assert.deepEqual(spent, { costUsd: 60, tokens: 30 });
  assert.deepEqual(spent, await fullReread(g));
});

test("identity: documented residual - same inode AND a byte-identical whole last line ending at the same offset is NOT detected", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  // A: nine cost-1 lines then a marker line; B: nine cost-2 lines, the SAME marker line, then 20 more.
  const marker = rec(1, 1, "m".repeat(100));
  await fsp.writeFile(auditPath, lineSet(9, 1) + marker);
  const g = await mkGate();
  assert.deepEqual((await g.haltContext()).spent, { costUsd: 10, tokens: 10 });
  await fsp.writeFile(auditPath, lineSet(9, 2) + marker + lineSet(20, 2)); // in place
  const spent = (await g.haltContext()).spent;
  assert.deepEqual(spent, { costUsd: 10 + 40, tokens: 30 }, "old total + only the new tail: the stale prefix is kept");
  assert.notDeepEqual(spent, await fullReread(g), "this is the residual the docs state");
});

test("identity: unusable inode (0) falls back to size + line anchor; growth by append is NOT a rescan", async (t) => {
  const { auditPath, mkGate } = await mk(t);
  await fsp.writeFile(auditPath, lineSet(10, 1));
  const g = await mkGate();
  await g.haltContext();
  g._haltTally.anchor = { ...g._haltTally.anchor, ino: 0n, dev: 0n }; // as a platform with no file index would give
  await fsp.appendFile(auditPath, lineSet(5, 1));
  assert.deepEqual((await g.haltContext()).spent, { costUsd: 15, tokens: 15 });
  let bytes = 0;
  const origOpen = fsp.open;
  fsp.open = async (...a) => { const fh = await origOpen.apply(fsp, a); const r = fh.read.bind(fh); fh.read = async (...b) => { const x = await r(...b); bytes += x.bytesRead; return x; }; return fh; };
  try { await g.haltContext(); } finally { fsp.open = origOpen; }
  assert.ok(bytes <= 3502, `an unchanged file costs only the one bounded anchor read-back, got ${bytes}`);
});
