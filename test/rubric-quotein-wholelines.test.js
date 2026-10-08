import test from "node:test";
import assert from "node:assert/strict";
import { quoteIn } from "../src/index.js";

// quoteIn opts.wholeLines (docs/product/rubric-prd.md §12 #27; asked by bareloop F192)

const A = " * @returns {Date} the parsed date, in the local time zone.";
const DOC = [
  "/**",
  " * Parses an ISO string.",
  " * @param {string} s",
  A,
  " */",
  "export function parse(s) {",
  "  return new Date(s);",
  "}",
].join("\n");
const W = { wholeLines: true };

test("wholeLines: bareloop case 1, a doc line without its ' * ' decoration is ok", () => {
  assert.deepEqual(quoteIn("@returns {Date} the parsed date, in the local time zone.", DOC, W), { ok: true });
  assert.deepEqual(quoteIn(A, DOC, W), { ok: true }, "decorated quote also ok");
});

test("wholeLines: case 2, a bare word hiding in a longer line is not-found", () => {
  assert.deepEqual(quoteIn("return", DOC, W), { ok: false, why: "not-found" });
});

test("wholeLines: case 3, one invented line fails a multi-line quote", () => {
  const q = "@param {string} s\nan invented line";
  assert.deepEqual(quoteIn(q, DOC, W), { ok: false, why: "not-found" });
  assert.deepEqual(quoteIn("@param {string} s\n@returns {Date} the parsed date, in the local time zone.", DOC, W), { ok: true });
});

test("wholeLines: case 4, a decoration-only line quotes as itself", () => {
  assert.deepEqual(quoteIn("/**", DOC, W), { ok: true });
  assert.deepEqual(quoteIn("*/", DOC, W), { ok: true });
  assert.deepEqual(quoteIn("/**", "no comment here", W), { ok: false, why: "not-found" });
});

test("wholeLines: case 5, a prefix of a line is not-found", () => {
  const src = ' * Formats a byte count as a human-readable string such as "1.4 MB".';
  assert.deepEqual(quoteIn("Formats a byte count", src, W), { ok: false, why: "not-found" });
  assert.deepEqual(quoteIn('Formats a byte count as a human-readable string such as "1.4 MB".', src, W), { ok: true });
});

test("default mode is unchanged: substring still passes without opts or with bad opts", () => {
  assert.deepEqual(quoteIn("return", DOC), { ok: true });
  for (const o of [undefined, null, {}, { wholeLines: false }, { wholeLines: "true" }, { wholeLines: 1 }, 5, "x", [], () => 1]) {
    assert.deepEqual(quoteIn("return", DOC, o), { ok: true }, `opts ${String(o)}`);
  }
});

test("wholeLines: '#' strips only when a space follows", () => {
  const src = "#include <x>\n#!/usr/bin/env node\n#define N 1\n# heading text\n";
  assert.deepEqual(quoteIn("#include <x>", src, W), { ok: true });
  assert.deepEqual(quoteIn("include <x>", src, W), { ok: false, why: "not-found" });
  assert.deepEqual(quoteIn("#!/usr/bin/env node", src, W), { ok: true });
  assert.deepEqual(quoteIn("!/usr/bin/env node", src, W), { ok: false, why: "not-found" });
  assert.deepEqual(quoteIn("define N 1", src, W), { ok: false, why: "not-found" });
  assert.deepEqual(quoteIn("heading text", src, W), { ok: true });
  assert.deepEqual(quoteIn("# heading text", src, W), { ok: true });
});

test("wholeLines: '//' is stripped at line start only, a URL keeps its '//'", () => {
  const src = "see https://a.b/c\n  // a note\n";
  assert.deepEqual(quoteIn("see https://a.b/c", src, W), { ok: true });
  assert.deepEqual(quoteIn("see https:", src, W), { ok: false, why: "not-found" });
  assert.deepEqual(quoteIn("see a.b/c", src, W), { ok: false, why: "not-found" });
  assert.deepEqual(quoteIn("a note", src, W), { ok: true });
});

test("wholeLines: CRLF and CR sources, and markers/whitespace are still forgiven per line", () => {
  assert.deepEqual(quoteIn("@param {string} s\n@returns {Date} the parsed date, in the local time zone.", DOC.replace(/\n/g, "\r\n"), W), { ok: true });
  assert.deepEqual(quoteIn("a  **b**", "x\r\n * a b\r\ny", W), { ok: true });
  assert.deepEqual(quoteIn("a\r\nb", "a\rb", W), { ok: true });
  assert.deepEqual(quoteIn("a b", "a\nb", W), { ok: false, why: "not-found" }, "lines are not merged");
});

test("wholeLines: lone '*' is decoration; blank lines in the quote are ignored", () => {
  assert.deepEqual(quoteIn("*", "/**\n *\n */", W), { ok: true });
  assert.deepEqual(quoteIn("\n\n@param {string} s\n\n", DOC, W), { ok: true });
});

test("wholeLines: guards (not-a-string, empty-quote, source-too-large) still apply", () => {
  assert.deepEqual(quoteIn(1, "x", W), { ok: false, why: "not-a-string" });
  assert.deepEqual(quoteIn("x", null, W), { ok: false, why: "not-a-string" });
  assert.deepEqual(quoteIn("", "x", W), { ok: false, why: "empty-quote" });
  assert.deepEqual(quoteIn(" \n\t\n ", "x", W), { ok: false, why: "empty-quote" });
  assert.deepEqual(quoteIn("**\n__", "x", W), { ok: false, why: "empty-quote" });
  assert.deepEqual(quoteIn("x", "x".repeat(5 * 1024 * 1024 + 1), W), { ok: false, why: "source-too-large" });
});
