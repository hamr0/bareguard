// rwx quote-aware metachar scan (PRD §23.13 decision 1). The bash-matching
// module has a documented ReDoS history (see test/classify.test.js), so any
// new regex/scan here is adversarially re-timed, not just unit-tested.

import test from "node:test";
import assert from "node:assert/strict";
import { hasJoinMeta, matchBash } from "../src/primitives/rwx.js";

const BASH = {
  "git status": "r", "git diff": "r", "git log": "r",
  "git add": "w", "git commit": "w", "npm test": "w",
  ls: "r", cat: "r", grep: "r",
  "npm publish": "x", "git push": "x", rm: "x",
};

// ─── the cases decision 1 exists to fix — quoted parens/semicolons now PASS ──

test("rwx quotes: git commit -m with parens inside double quotes is NOT a join (now allows)", () => {
  const m = matchBash('git commit -m "fix (typo) in parser"', BASH);
  assert.equal(m.joined, false);
  assert.equal(m.ok, true);
  assert.equal(m.letter, "w");
});

test("rwx quotes: git commit -m with a semicolon inside double quotes is NOT a join", () => {
  const m = matchBash('git commit -m "a; b"', BASH);
  assert.equal(m.joined, false);
  assert.equal(m.ok, true);
});

test("rwx quotes: a pipe inside single quotes is fully literal (grep -rn 'foo|bar')", () => {
  const m = matchBash("grep -rn 'foo|bar' src", BASH);
  assert.equal(m.joined, false);
  assert.equal(m.ok, true);
  assert.equal(m.letter, "r");
});

test("rwx quotes: redirects/parens/semicolons inside single OR double quotes are literal", () => {
  for (const cmd of [
    'git commit -m "output > file; rm -rf /"',
    "git commit -m 'a && b || c'",
    'git commit -m "a (b) c < d > e"',
  ]) {
    assert.equal(hasJoinMeta(cmd), false, cmd);
  }
});

// ─── still-dangerous inside double quotes: $( ), backtick, $VAR ──────────────

test("rwx quotes: command substitution $(...) inside double quotes still counts as dangerous", () => {
  assert.equal(hasJoinMeta('git commit -m "$(rm -rf /)"'), true);
});

test("rwx quotes: backtick substitution inside double quotes still counts as dangerous", () => {
  assert.equal(hasJoinMeta('git commit -m "`rm -rf /`"'), true);
});

test("rwx quotes: bare $VAR expansion inside double quotes still counts as dangerous", () => {
  assert.equal(hasJoinMeta('git commit -m "$HOME is unsafe"'), true);
});

// ─── unquoted metacharacters still deny (unchanged) ──────────────────────────

test("rwx quotes: unquoted joiners/redirects still count as dangerous", () => {
  for (const cmd of [
    "ls; rm -rf /", "git status && rm -rf /", "git status || rm -rf /",
    "cat file | sh", "ls $(rm -rf /)", "ls `rm -rf /`", "ls\nrm -rf /",
    "ls \\\nrm -rf /", "cat a >> b", "ls > /tmp/x", "grep x < /etc/shadow",
  ]) {
    assert.equal(hasJoinMeta(cmd), true, cmd);
  }
});

test("rwx quotes: an unquoted bare $VAR (no quotes at all) still counts as dangerous", () => {
  // Decision 1 only changes behavior INSIDE quotes; an entirely unquoted
  // substitution risk is untouched (a documented, not-yet-closed gap).
  assert.equal(hasJoinMeta("cat $HOME/.npmrc"), true);
});

// ─── adversarial quote handling: nested, escaped, unterminated, splices ──────

test("rwx quotes: nested single-inside-double and double-inside-single are handled", () => {
  assert.equal(hasJoinMeta('echo "it\'s fine"'), false);
  assert.equal(hasJoinMeta("echo 'she said \"hi\"'"), false);
});

test("rwx quotes: an escaped double-quote inside a double-quoted span does not close it early", () => {
  // Without escape-awareness this would close after \" and treat the
  // remaining `hi\"` + trailing backslash as unquoted (denying on the stray `\`).
  const cmd = 'git commit -m "say \\"hi\\" ok"';
  assert.equal(hasJoinMeta(cmd), false, cmd);
});

test("rwx quotes: an escaped $ or backtick inside double quotes is inert (does not count as substitution)", () => {
  assert.equal(hasJoinMeta('git commit -m "price is \\$5"'), false);
  assert.equal(hasJoinMeta('git commit -m "\\`not a sub\\`"'), false);
});

test("rwx quotes: an unterminated single quote fails closed (denied)", () => {
  assert.equal(hasJoinMeta("git commit -m 'unterminated"), true);
});

test("rwx quotes: an unterminated double quote fails closed (denied)", () => {
  assert.equal(hasJoinMeta('git commit -m "unterminated'), true);
});

test("rwx quotes: the '\"'\"' single-quote splice idiom is handled inside a real command", () => {
  // Classic bash idiom for embedding a literal apostrophe in a single-quoted
  // string: 'it'"'"'s fine' == the literal text  it's fine
  const cmd = "git commit -m 'it'\"'\"'s a test'";
  assert.equal(hasJoinMeta(cmd), false, cmd);
  const m = matchBash(cmd, BASH);
  assert.equal(m.ok, true);
  assert.equal(m.letter, "w");
});

test("rwx quotes: the splice sequence standalone (mid-parse, unterminated) fails closed", () => {
  // '"'"' by itself (not embedded between two complete quoted segments) ends
  // with an open double-quote span — genuinely unterminated, denied.
  assert.equal(hasJoinMeta("'\"'\"'"), true);
});

// ─── leading-word matching stays word-boundary aware under quoting ───────────

test("rwx quotes: word-boundary matching is unaffected by quote-awareness (ls never matches lsblk)", () => {
  const m = matchBash("lsblk /dev/sda", BASH);
  assert.equal(m.ok, false);
  assert.equal(m.joined, false);
});

// ─── ReDoS re-timing (this module's own scan, not a whole-string regex) ─────

test("rwx quotes: ReDoS re-timing — a long single-quoted adversarial string stays linear", () => {
  // Single-quote span containing thousands of characters that WOULD be
  // OUTSIDE_META hits if quote-tracking leaked state or backtracked.
  const evil = "echo '" + ";&|$`()<>\\\n".repeat(20000) + "'";
  const t0 = process.hrtime.bigint();
  const result = hasJoinMeta(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(result, false, "fully single-quoted content must stay literal");
  assert.ok(ms < 1000, `hasJoinMeta took ${ms.toFixed(1)}ms on a 20000x adversarial single-quoted string (ReDoS)`);
  console.log(`    [timing] hasJoinMeta on 20000x single-quoted adversarial payload: ${ms.toFixed(2)}ms`);
});

test("rwx quotes: ReDoS re-timing — a long double-quoted adversarial string with escapes stays linear", () => {
  const evil = 'echo "' + '\\"\\$\\`'.repeat(20000) + '"';
  const t0 = process.hrtime.bigint();
  const result = hasJoinMeta(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(result, false, "fully escaped double-quoted content must stay inert");
  assert.ok(ms < 1000, `hasJoinMeta took ${ms.toFixed(1)}ms on a 20000x escaped double-quoted string (ReDoS)`);
  console.log(`    [timing] hasJoinMeta on 20000x escaped double-quoted adversarial payload: ${ms.toFixed(2)}ms`);
});

test("rwx quotes: ReDoS re-timing — an unquoted adversarial string of pure metacharacters stays linear", () => {
  const evil = ";&|$`()<>\\\n".repeat(20000);
  const t0 = process.hrtime.bigint();
  const result = hasJoinMeta(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(result, true);
  assert.ok(ms < 1000, `hasJoinMeta took ${ms.toFixed(1)}ms on a 20000x unquoted metachar string (ReDoS)`);
  console.log(`    [timing] hasJoinMeta on 20000x unquoted metachar payload: ${ms.toFixed(2)}ms`);
});

test("rwx quotes: ReDoS re-timing — matchBash against a large bash map with a long safe command stays linear", () => {
  const bigMap = {};
  for (let i = 0; i < 5000; i++) bigMap[`tool-${i} subcommand-${i}`] = "r";
  const cmd = "a".repeat(40000);
  const t0 = process.hrtime.bigint();
  const result = matchBash(cmd, bigMap);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(result.ok, false);
  assert.ok(ms < 1000, `matchBash took ${ms.toFixed(1)}ms against a 5000-entry map and a 40000-char command (ReDoS)`);
  console.log(`    [timing] matchBash against 5000-entry map / 40000-char command: ${ms.toFixed(2)}ms`);
});
