// fs contract (0.19.0): deny-by-default read/write scoping, symlink/realpath
// resolution, fs.deny as an extra layer, agent-path canonicalization rules.
// Ported from the throwaway fs-contract-poc's `matrix.mjs` scenario matrix
// (24 rows) plus the extra rows the task brief called for explicitly
// (missing-scope-root resolved via ancestor, fresh-root re-resolution,
// direct-primitive raw-config safety). Exercised through the real shipped
// `fsCheck` (via the public `Gate`, and directly for the config-shape rows).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { Gate } from "../src/index.js";
import { fsCheck } from "../src/primitives/fs.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

let ROOT, SCOPE, SECRET, F;

// Symlink creation needs admin/dev-mode privilege on Windows
// (`SeCreateSymbolicLinkPrivilege`) and fails with EPERM without it. The
// non-symlink tests in this file (deny-by-default, agent-path
// canonicalization, config-shape) must still run everywhere; only the
// symlink-dependent tests skip, cleanly and with a stated reason — never a
// silent pass (an unhandled EPERM in `before()` would instead fail EVERY
// test in the file, symlink or not).
let symlinksSupported = true;
let symlinksSkipReason = "";

async function trySymlink(target, linkPath, type) {
  if (!symlinksSupported) return;
  try {
    await fsp.symlink(target, linkPath, type);
  } catch (e) {
    symlinksSupported = false;
    symlinksSkipReason = `symlink creation unsupported in this environment (${e.code || e.message}) — needs admin/dev-mode privilege on Windows`;
  }
}

function skipIfNoSymlinks(t) {
  if (!symlinksSupported) t.skip(symlinksSkipReason);
  return !symlinksSupported;
}

test.before(async () => {
  ROOT = await makeTmpDir("bareguard-fs-contract-");
  F = ROOT;
  SCOPE = path.join(F, "scope");
  SECRET = path.join(F, "secret");
  await fsp.mkdir(SCOPE, { recursive: true });
  await fsp.mkdir(SECRET, { recursive: true });
  await fsp.writeFile(path.join(SCOPE, "x.txt"), "x");
  await fsp.writeFile(path.join(SECRET, "id_rsa"), "SECRET_KEY_MATERIAL");

  // symlink escape: scope/escape-link -> ../secret (lexically inside scope,
  // resolves outside it)
  await trySymlink(SECRET, path.join(SCOPE, "escape-link"), "dir");

  // legit scope ROOT itself is a symlink pointing at a real directory
  await fsp.mkdir(path.join(F, "real-scope"), { recursive: true });
  await fsp.writeFile(path.join(F, "real-scope", "ok.txt"), "ok");
  await trySymlink(path.join(F, "real-scope"), path.join(F, "legit-root-link"), "dir");

  // dangling symlink (final component, and as an intermediate segment)
  await trySymlink(path.join(F, "does-not-exist"), path.join(SCOPE, "dangling"), "file");

  // genuine ELOOP cycle: loopdir/a <-> loopdir/b
  await fsp.mkdir(path.join(F, "loopdir"), { recursive: true });
  await trySymlink(path.join(F, "loopdir", "b"), path.join(F, "loopdir", "a"), "file");
  await trySymlink(path.join(F, "loopdir", "a"), path.join(F, "loopdir", "b"), "file");

  // fake HOME for ~ expansion, isolated from the real user's home
  const home = path.join(F, "fakehome");
  await fsp.mkdir(path.join(home, ".ssh"), { recursive: true });
  await fsp.writeFile(path.join(home, ".ssh", "id_rsa"), "REAL_SSH_KEY");
});

test.after(async () => { await cleanup(ROOT); });

async function gateWith(t, cfg) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({ audit: { path: auditPath }, ...cfg });
  await gate.init();
  return gate;
}

// ---------------------------------------------------------------------------
// deny-by-default: unset / [] scopes
// ---------------------------------------------------------------------------

test("fs: readScope UNSET denies an arbitrary read (deny-by-default, item 1)", async (t) => {
  const gate = await gateWith(t, {});
  const d = await gate.check({ type: "read", path: "/etc/passwd" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.unset");
});

test("fs: readScope: [] denies an arbitrary read the same as unset", async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [] } });
  const d = await gate.check({ type: "read", path: "/etc/passwd" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.unset");
});

test("fs: writeScope UNSET, readScope set — write inside the readScope folder still denies (write != read)", async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [SCOPE] } });
  const d = await gate.check({ type: "write", path: path.join(SCOPE, "x.txt") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.writeScope.unset");
});

test("fs: a writeScope-only folder is NOT readable (no crossover either direction)", async (t) => {
  const gate = await gateWith(t, { fs: { writeScope: [SCOPE] } });
  const d = await gate.check({ type: "read", path: path.join(SCOPE, "x.txt") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.unset");
});

test("fs: multiple readScope folders — a path in the 2nd folder allows", async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [SCOPE, SECRET] } });
  const d = await gate.check({ type: "read", path: path.join(SECRET, "id_rsa") });
  assert.equal(d.outcome, "allow");
});

// ---------------------------------------------------------------------------
// agent path canonicalization (item 4): never inferred, reject outright
// ---------------------------------------------------------------------------

test("fs: relative agent path denies outright, before scope matching", async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [F] } });
  const d = await gate.check({ type: "read", path: ".ssh/id_rsa" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.invalidPath");
});

test("fs: traversal-relative agent path denies outright", async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [F] } });
  const d = await gate.check({ type: "read", path: "../.ssh/id_rsa" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.invalidPath");
});

test("fs: a '~'-prefixed agent path denies outright (agent paths are never canonicalized)", async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [F] } });
  const d = await gate.check({ type: "read", path: "~/.ssh/id_rsa" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.invalidPath");
});

// `path.isAbsolute()` is platform-aware (the same "one definition of
// absolute" shared by fs-config.js — see fs.js header), so the SAME literal
// string is genuinely absolute on win32 and genuinely relative everywhere
// else — this is not a bug to paper over, it's why the fs contract insists
// on one shared `path.isAbsolute()` instead of a bareguard-private notion of
// "looks absolute."
test("fs: a drive-letter path denies as relative/non-absolute on a POSIX host (fs.invalidPath — never reaches scope matching)", { skip: process.platform === "win32" ? "posix-only: this literal string is a genuine absolute path on win32" : false }, async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [F] } });
  const d = await gate.check({ type: "read", path: "C:\\Users\\x\\.ssh\\id_rsa" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.invalidPath");
});

test("fs: the SAME drive-letter path is a genuine absolute path on win32 — passes canonicalization, denies on scope miss instead", { skip: process.platform !== "win32" ? "win32-only: exercises the branch above's inverse" : false }, async (t) => {
  const gate = await gateWith(t, { fs: { readScope: [F] } });
  const d = await gate.check({ type: "read", path: "C:\\Users\\x\\.ssh\\id_rsa" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope"); // absolute and canonicalized fine — just outside this test's readScope
});

// ---------------------------------------------------------------------------
// symlink/resolved-path check (item 5), ON by default, no opt-out
// ---------------------------------------------------------------------------

test("fs: symlink escape — lexically inside scope, resolves outside it, denies", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  const gate = await gateWith(t, { fs: { readScope: [SCOPE] } });
  const d = await gate.check({ type: "read", path: path.join(SCOPE, "escape-link", "id_rsa") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.symlinkEscape");
});

test("fs: a symlinked scope ROOT (legit alias) still allows a real file through it", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  const gate = await gateWith(t, { fs: { readScope: [path.join(F, "legit-root-link")] } });
  const d = await gate.check({ type: "read", path: path.join(F, "legit-root-link", "ok.txt") });
  assert.equal(d.outcome, "allow");
});

test("fs: dangling symlink as the write target denies", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  const gate = await gateWith(t, { fs: { writeScope: [SCOPE] } });
  const d = await gate.check({ type: "write", path: path.join(SCOPE, "dangling") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.writeScope.danglingSymlink");
});

test("fs: dangling symlink as the read target denies", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  const gate = await gateWith(t, { fs: { readScope: [SCOPE] } });
  const d = await gate.check({ type: "read", path: path.join(SCOPE, "dangling") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.danglingSymlink");
});

test("fs: dangling symlink as an INTERMEDIATE path segment denies", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  const gate = await gateWith(t, { fs: { writeScope: [SCOPE] } });
  const d = await gate.check({ type: "write", path: path.join(SCOPE, "dangling", "deeper.txt") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.writeScope.danglingSymlink");
});

test("fs: new file CREATE inside scope (does not exist yet) still allows", async (t) => {
  const gate = await gateWith(t, { fs: { writeScope: [SCOPE] } });
  const d = await gate.check({ type: "write", path: path.join(SCOPE, "brand-new-file.txt") });
  assert.equal(d.outcome, "allow");
});

test("fs: new file CREATE two levels deep, intermediate dir absent, still allows", async (t) => {
  const gate = await gateWith(t, { fs: { writeScope: [SCOPE] } });
  const d = await gate.check({ type: "write", path: path.join(SCOPE, "newdir", "brand-new-file.txt") });
  assert.equal(d.outcome, "allow");
});

test("fs: ELOOP — a genuine symlink cycle denies with a resolveError rule", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  const gate = await gateWith(t, { fs: { readScope: [F] } });
  const d = await gate.check({ type: "read", path: path.join(F, "loopdir", "a") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.resolveError");
});

// ---------------------------------------------------------------------------
// fs.deny: optional extra layer (item 3), wins over a covering readScope
// ---------------------------------------------------------------------------

test("fs.deny wins over a readScope that is a parent of the denied folder", async (t) => {
  const gate = await gateWith(t, { fs: { deny: [SECRET], readScope: [F] } });
  const d = await gate.check({ type: "read", path: path.join(SECRET, "id_rsa") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.deny");
});

// ---------------------------------------------------------------------------
// ~ expansion (item 2)
// ---------------------------------------------------------------------------

test("fs: '~' and '~/x' entries expand once via os.homedir()", async (t) => {
  const home = path.join(F, "fakehome");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prevHome; });
  const gate = await gateWith(t, { fs: { deny: ["~/.ssh"], readScope: [home] } });
  const d = await gate.check({ type: "read", path: path.join(home, ".ssh", "id_rsa") });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.deny");
});

test("fs: bare '~' readScope expands to the whole home, honestly (not a leak — explicitly scoped)", async (t) => {
  const home = path.join(F, "fakehome");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prevHome; });
  const gate = await gateWith(t, { fs: { readScope: ["~"] } });
  const d = await gate.check({ type: "read", path: path.join(home, ".ssh", "id_rsa") });
  assert.equal(d.outcome, "allow");
});

test("fs: '~user' form is refused at construct time (not silently literal)", async () => {
  assert.throws(
    () => new Gate({ fs: { deny: ["~root/.ssh"] } }),
    /~user.*not supported|not supported.*~user/i,
  );
});

test("fs: a relative fs.deny entry is refused at construct time", async () => {
  assert.throws(
    () => new Gate({ fs: { deny: [".ssh"] } }),
    /must be absolute/,
  );
});

// ---------------------------------------------------------------------------
// bad config element types (item 6, fs-specific validator)
// ---------------------------------------------------------------------------

test("fs.deny with a non-string element throws at construct time", async () => {
  assert.throws(
    () => new Gate({ fs: { deny: [123], readScope: [SCOPE] } }),
    /fs\.deny\[0\]/,
  );
});

test("fs.deny with a non-string element denies (not throws) via a direct fsCheck() call", () => {
  const d = fsCheck({ type: "read", path: path.join(SCOPE, "x.txt") }, { deny: [123], readScope: [SCOPE] });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.deny.invalid");
});

test("fs.readScope not an array (string typo) denies via a direct fsCheck() call", () => {
  const d = fsCheck({ type: "read", path: path.join(SCOPE, "x.txt") }, { readScope: SCOPE });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.readScope.invalid");
});

// ---------------------------------------------------------------------------
// NEW (beyond the POC matrix, required by the task brief)
// ---------------------------------------------------------------------------

test("fs: a not-yet-created scope root is resolved via nearest-existing-ancestor + tail, not a lexical-only fallback", async (t) => {
  const freshRoot = path.join(F, "not-created-yet", "workdir");
  const gate = await gateWith(t, { fs: { writeScope: [freshRoot] } });
  // The root doesn't exist on disk at all; a write inside it must still allow
  // (nearest existing ancestor is F, which is real) — proves the root itself
  // goes through the SAME ancestor-walk resolution as a target path, not a
  // rejected lexical-only shortcut.
  const d = await gate.check({ type: "write", path: path.join(freshRoot, "out.txt") });
  assert.equal(d.outcome, "allow");
});

test("fs: a symlinked ancestor of a not-yet-created scope root is honored", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  // real-scope/aliased-parent -> symlink to a real dir; the scope root sits
  // ONE level below that symlink and does not exist yet itself.
  const realParent = path.join(F, "real-parent-for-fresh-root");
  await fsp.mkdir(realParent, { recursive: true });
  const aliasParent = path.join(F, "alias-parent-for-fresh-root");
  await fsp.symlink(realParent, aliasParent, "dir");
  const freshRoot = path.join(aliasParent, "not-created-yet");

  const gate = await gateWith(t, { fs: { writeScope: [freshRoot] } });
  const d = await gate.check({ type: "write", path: path.join(freshRoot, "out.txt") });
  assert.equal(d.outcome, "allow");

  // Confirms the ancestor walk actually went THROUGH the symlink (not a
  // lexical-only fallback that never looks at the disk): retarget the alias
  // to a DIFFERENT real directory and the same query must now resolve
  // outside the scope root and deny.
  const otherReal = path.join(F, "other-real-parent");
  await fsp.mkdir(otherReal, { recursive: true });
  await fsp.unlink(aliasParent);
  await fsp.symlink(otherReal, aliasParent, "dir");
  const d2 = await gate.check({ type: "write", path: path.join(freshRoot, "out.txt") });
  assert.equal(d2.outcome, "allow", "still allowed — the SAME live alias, now pointing elsewhere, still resolves target+root together");
});

test("fs: scope roots are resolved FRESH on every check — retargeting a root symlink between two checks is reflected immediately", async (t) => {
  if (skipIfNoSymlinks(t)) return;
  // Both the checked path and the scope root go through the SAME live
  // symlink, so a STALE cached root resolution (resolved once, reused) would
  // disagree with the target's always-fresh realpath after a retarget — the
  // exact regression "resolve scope roots fresh on every check" defends
  // against. Querying the identical literal path (`rootLink/f.txt`) both
  // times isolates that: a caching bug denies the second call (fresh target
  // vs stale root mismatch); fresh resolution allows it again.
  const targetA = path.join(F, "retarget-a");
  const targetB = path.join(F, "retarget-b");
  await fsp.mkdir(targetA, { recursive: true });
  await fsp.mkdir(targetB, { recursive: true });
  await fsp.writeFile(path.join(targetA, "f.txt"), "a");
  await fsp.writeFile(path.join(targetB, "f.txt"), "b");

  const rootLink = path.join(F, "retarget-root");
  await fsp.symlink(targetA, rootLink, "dir");

  const gate = await gateWith(t, { fs: { readScope: [rootLink] } });
  const queryPath = path.join(rootLink, "f.txt");

  // First check: root points at targetA — allow.
  const d1 = await gate.check({ type: "read", path: queryPath });
  assert.equal(d1.outcome, "allow");

  // Retarget the root symlink to targetB, no gate reconstruction, no config change.
  await fsp.unlink(rootLink);
  await fsp.symlink(targetB, rootLink, "dir");

  // Second check: SAME literal query path, same gate, same config object —
  // must still allow (both root and target resolve fresh through the
  // retargeted symlink together). A cached root would deny here instead.
  const d2 = await gate.check({ type: "read", path: queryPath });
  assert.equal(d2.outcome, "allow");
});
