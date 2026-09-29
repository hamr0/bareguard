// fs scope ROOTS must not be, or sit under, a symlink (0.19.2, fail closed).
// Pre-fix, a symlinked root was realpath'd, silently MOVING the scope to the
// link's target: writeScope `/run/out` (-> `/outside`) allowed `/run/out/x`
// while `/outside/x` was denied — reported by fwdloop.
//
// Layout (real tmp dir, itself a real path — see REAL_TMPDIR in _helpers):
//   run/            real dir
//   run/out   ->    ../outside  (symlink)
//   outside/secret.txt

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { Gate } from "../src/index.js";
import { fsCheck } from "../src/primitives/fs.js";
import { makeTmpDir, cleanup } from "./_helpers.js";

let X, RUN, OUT, OUTSIDE, skipReason = "";

test.before(async () => {
  X = await makeTmpDir("bareguard-symroot-");
  RUN = path.join(X, "run");
  OUTSIDE = path.join(X, "outside");
  OUT = path.join(RUN, "out");
  await fsp.mkdir(RUN, { recursive: true });
  await fsp.mkdir(OUTSIDE, { recursive: true });
  await fsp.writeFile(path.join(OUTSIDE, "secret.txt"), "s");
  try {
    await fsp.symlink(OUTSIDE, OUT, "dir");
  } catch (e) {
    // Windows without admin/dev-mode cannot create symlinks; skip those tests.
    skipReason = `symlink creation unsupported (${e.code || e.message})`;
  }
});
test.after(async () => { await cleanup(X); });

test("repro 1: writeScope root that is a symlink THROWS (was: write via link allowed = escape)", (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.throws(() => new Gate({ fs: { readScope: [RUN], writeScope: [OUT] } }), /fs\.writeScope\[0\].*symlink/);
});

test("repro 2: readScope root that is a symlink THROWS (was: read via link allowed = escape)", (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.throws(() => new Gate({ fs: { readScope: [OUT] } }), /fs\.readScope\[0\].*symlink/);
});

test("construct error tells the operator to list the real path (and names it)", (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.throws(() => new Gate({ fs: { readScope: [OUT] } }),
    (e) => /real \(resolved\) path/.test(e.message) && e.message.includes(OUTSIDE));
});

test("repro 3/4: same file, any spelling, same answer — listing the REAL path scopes the real file", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const g = new Gate({ audit: { path: null }, fs: { readScope: [RUN], writeScope: [OUTSIDE] } });
  await g.init();
  // named directly: in scope
  assert.equal((await g.check({ type: "write", path: path.join(OUTSIDE, "secret.txt"), content: "x" })).outcome, "allow");
  // via the link inside readScope root: still denied as an escape (unchanged)
  const via = await g.check({ type: "read", path: path.join(OUT, "secret.txt") });
  assert.equal(via.outcome, "deny");
  assert.equal(via.rule, "fs.readScope.symlinkEscape");
  // write via the link: lexically outside writeScope -> deny (same as direct spelling being allowed only for the real root)
  const w = await g.check({ type: "write", path: path.join(OUT, "secret.txt"), content: "x" });
  assert.equal(w.outcome, "deny");
});

test("dangling-symlink root THROWS", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const dangling = path.join(X, "dangling-root");
  await fsp.symlink(path.join(X, "does-not-exist"), dangling, "dir");
  assert.throws(() => new Gate({ fs: { readScope: [dangling] } }), /fs\.readScope\[0\].*symlink/);
});

test("symlink in a MIDDLE component of the root THROWS (even if the root itself does not exist)", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await fsp.mkdir(path.join(OUTSIDE, "sub"), { recursive: true });
  assert.throws(() => new Gate({ fs: { writeScope: [path.join(OUT, "sub")] } }), /fs\.writeScope\[0\].*symlink/);
  assert.throws(() => new Gate({ fs: { writeScope: [path.join(OUT, "not-created-yet")] } }), /fs\.writeScope\[0\].*symlink/);
});

test("root swapped to a symlink AFTER construction denies fs.<scope>.symlinkRoot at check time", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const swap = path.join(X, "swap-root");
  await fsp.mkdir(swap, { recursive: true });
  const rg = new Gate({ audit: { path: null }, fs: { readScope: [swap], writeScope: [swap] } });
  await rg.init();
  const rd = { type: "read", path: path.join(swap, "secret.txt") };
  const wr = { type: "write", path: path.join(swap, "secret.txt"), content: "x" };
  assert.equal((await rg.check(rd)).outcome, "allow");
  assert.equal((await rg.check(wr)).outcome, "allow");
  await fsp.rm(swap, { recursive: true });
  await fsp.symlink(OUTSIDE, swap, "dir");
  const d1 = await rg.check(rd);
  assert.equal(d1.outcome, "deny");
  assert.equal(d1.rule, "fs.readScope.symlinkRoot");
  const d2 = await rg.check(wr);
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "fs.writeScope.symlinkRoot");
});

test("a symlinked root that does NOT lexically match still fails closed (it could grant via its resolved target)", async (t) => {
  if (skipReason) return t.skip(skipReason);
  // s1 real and lexically containing the path; s2 swapped to a symlink whose
  // target contains the path's RESOLVED location. Without re-checking every
  // root, s2 would admit the escape via the resolved comparison.
  const s1 = path.join(X, "multi-a");
  const s2 = path.join(X, "multi-b");
  await fsp.mkdir(s1, { recursive: true });
  await fsp.mkdir(s2, { recursive: true });
  await fsp.symlink(OUTSIDE, path.join(s1, "l"), "dir");
  const g = new Gate({ audit: { path: null }, fs: { readScope: [s1, s2] } });
  await g.init();
  await fsp.rm(s2, { recursive: true });
  await fsp.symlink(OUTSIDE, s2, "dir");
  const d = await g.check({ type: "read", path: path.join(s1, "l", "secret.txt") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.symlinkRoot");
});

test("direct fsCheck() (no Gate) also fails closed at runtime with the same rule", (t) => {
  if (skipReason) return t.skip(skipReason);
  const d = fsCheck({ type: "read", path: path.join(OUT, "secret.txt") }, { readScope: [OUT] });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.symlinkRoot");
  const w = fsCheck({ type: "write", path: path.join(OUT, "secret.txt"), content: "x" }, { writeScope: [OUT] });
  assert.equal(w.rule, "fs.writeScope.symlinkRoot");
});

test("plain real-dir root still allows in-scope paths (and denies out-of-scope)", async () => {
  const real = path.join(X, "plain");
  await fsp.mkdir(real, { recursive: true });
  const g = new Gate({ audit: { path: null }, fs: { readScope: [real], writeScope: [real] } });
  await g.init();
  assert.equal((await g.check({ type: "read", path: path.join(real, "a.txt") })).outcome, "allow");
  assert.equal((await g.check({ type: "write", path: path.join(real, "new", "b.txt"), content: "x" })).outcome, "allow");
  const out = await g.check({ type: "read", path: path.join(X, "outside", "secret.txt") });
  assert.equal(out.rule, "fs.readScope");
});

test("a scope root that does not exist at all (no symlink) is still accepted, unchanged", async () => {
  const g = new Gate({ audit: { path: null }, fs: { writeScope: [path.join(X, "not", "yet", "created")] } });
  await g.init();
  assert.equal((await g.check({ type: "write", path: path.join(X, "not", "yet", "created", "f.txt"), content: "x" })).outcome, "allow");
});

test("fs.deny roots are NOT restricted: a symlinked deny root only narrows, still constructs", (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.doesNotThrow(() => new Gate({ fs: { deny: [OUT], readScope: [RUN] } }));
});

test("a root's ANCESTOR swapped to a symlink AFTER construction denies .symlinkRoot", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const base = await makeTmpDir("bareguard-symroot-anc-");
  try {
    const run = path.join(base, "run");
    const elsewhere = path.join(base, "elsewhere");
    await fsp.mkdir(path.join(run, "out"), { recursive: true });
    await fsp.mkdir(path.join(elsewhere, "out"), { recursive: true });
    const g = new Gate({ audit: { path: null }, fs: { readScope: [run], writeScope: [path.join(run, "out")] } });
    await g.init();
    const wr = { type: "write", path: path.join(run, "out", "f.txt"), content: "x" };
    const rd = { type: "read", path: path.join(run, "out", "f.txt") };
    assert.equal((await g.check(wr)).outcome, "allow");
    // Swap the ANCESTOR (run) to a symlink; the root entry run/out is never itself a link.
    await fsp.rename(run, path.join(base, "run.real"));
    await fsp.symlink(elsewhere, run, "dir");
    const dw = await g.check(wr);
    assert.equal(dw.outcome, "deny");
    assert.equal(dw.rule, "fs.writeScope.symlinkRoot");
    const dr = await g.check(rd);
    assert.equal(dr.outcome, "deny");
    assert.equal(dr.rule, "fs.readScope.symlinkRoot");
  } finally {
    await cleanup(base);
  }
});
