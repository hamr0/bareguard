// Fail when package-lock.json's copy of this project's own version disagrees
// with package.json. npm writes that copy on install; `/release` bumps only
// package.json and runs no install, so the lockfile fell three minors behind
// (0.13.0 while 0.14.0, 0.15.0 and 0.16.0 all shipped) with nothing to catch it.
//
// Scope is deliberately just the version. The lockfile's dependency entries are
// already guarded: `npm ci` fails outright when they disagree with package.json.
// This covers the one field `npm ci` does NOT check.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (f) => JSON.parse(readFileSync(path.join(root, f), "utf8"));

const pkg = read("package.json");
const lock = read("package-lock.json");

// Two places hold it: the lockfile root, and the root package's own entry in
// `packages[""]`. npm writes both, so both are checked — a mismatch in either
// is the same drift.
const found = { "package-lock.json version": lock.version, 'package-lock.json packages[""].version': lock.packages?.[""]?.version };
const wrong = Object.entries(found).filter(([, v]) => v !== pkg.version);

if (wrong.length) {
  console.error(`✗ lockfile version drift — package.json is ${pkg.version}:`);
  for (const [where, v] of wrong) console.error(`    ${where} = ${v ?? "(missing)"}`);
  console.error("  Fix: npm install --package-lock-only   (then commit package-lock.json)");
  process.exit(1);
}

console.log(`✓ package-lock.json version matches package.json — ${pkg.version}`);
