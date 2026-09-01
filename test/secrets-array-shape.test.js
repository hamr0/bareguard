// Regression tests for the same-class sweep (5 sites the code-review flagged
// but left unfixed): `secrets.keys`, `secrets.patterns`, `secrets.envVars`
// (src/primitives/secrets.js) read an array-shaped config value without a
// runtime Array.isArray guard.
//
// `redact()`'s own JSDoc contract is never-throw, and it runs synchronously
// inside `Audit.emit()` inside `gate.check()` — so a deny-shaped
// `<key>.invalid` fix (the pattern used for tools/content/fs/net/bash) is the
// WRONG shape here: it would either have to throw (breaking the contract and
// stopping the gate dead on every subsequent action, per the docblock on
// `ARRAY_SHAPED_CONFIG` in gate.js) or fabricate a "deny" outcome for a
// function that has no decision surface. The fix instead treats a malformed
// value the same as absent (`Array.isArray(x) ? x : []`, matching the pattern
// `classify.js` already uses for `extraDestructive`/`extraSuperDestructive`):
// never throws, never corrupts data, and — because `secrets.keys`/`patterns`/
// `envVars` are already in `ARRAY_SHAPED_CONFIG` — the Gate constructor still
// throws loudly on a malformed value for every caller that goes through
// `new Gate(...)`. This only governs the two paths construction cannot cover:
// a direct public `redact(cfg)` call, and a post-construction `cfg` swap
// (config is held by reference).
//
// Before the fix:
//   - `keys:"apiKey"` (a string) spread into single-char specs ('a','p','i',
//     'K','e','y'), so it did NOT redact the field actually named `apiKey`
//     while corrupting unrelated 1-char-named fields — worse than a no-op,
//     a genuine secret leak that LOOKED configured.
//   - `keys:{}` / `patterns:{}` (non-iterable objects) threw
//     "... is not iterable" out of `redact()`.
//   - `patterns:"xyz"` (a string) crashed with
//     `SyntaxError: Invalid flags supplied to RegExp constructor 'undefinedg'`.
//   - `envVars:"X"` (a string) silently iterated characters as bogus env-var
//     names.
//
// The load-bearing assertion is NOT "it didn't throw" — it's that the
// DEFAULT-ON redaction (`DEFAULT_SECRET_KEYS`/`DEFAULT_SECRET_VALUE_PATTERNS`)
// still fires when the custom value is malformed, and the char-spread
// corruption of unrelated fields is gone.

import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/index.js";

test("secrets.keys: a malformed value falls back to defaults, does not corrupt unrelated fields", () => {
  const action = { apiKey: "sk-live-secret-1234567890abcdef", s: "innocuous", e: "innocuous" };
  const clean = redact(action, { keys: "apiKey" }); // string, not an array
  // Load-bearing: default-on redaction (apiKey is in DEFAULT_SECRET_KEYS) must
  // still fire despite the malformed custom `keys` value.
  assert.equal(clean.apiKey, "[REDACTED:key=apiKey]");
  // The char-spread corruption this replaces used to redact fields literally
  // named "a","p","i","K","e","y" — including the unrelated "e" field here.
  assert.equal(clean.s, "innocuous");
  assert.equal(clean.e, "innocuous");
});

test("secrets.keys: a non-iterable value must not throw", () => {
  assert.doesNotThrow(() => redact({ apiKey: "sk-live-secret-1234567890abcdef" }, { keys: {} }));
  const clean = redact({ apiKey: "sk-live-secret-1234567890abcdef" }, { keys: {} });
  assert.equal(clean.apiKey, "[REDACTED:key=apiKey]");
});

test("secrets.patterns: a malformed value falls back to defaults, does not crash redact()", () => {
  assert.doesNotThrow(() => redact({ a: "Bearer abcdef123456" }, { patterns: "xyz" }));
  const clean = redact({ a: "Bearer abcdef123456" }, { patterns: "xyz" }); // string, not an array
  // Load-bearing: the default-on `Bearer …` value pattern must still fire.
  assert.match(clean.a, /^\[REDACTED:pattern=Bear\.\.\.\]$/);
});

test("secrets.patterns: a non-iterable value must not throw", () => {
  assert.doesNotThrow(() => redact({ a: "Bearer abcdef123456" }, { patterns: {} }));
});

test("secrets.envVars: a malformed value falls back to no extra env-var redaction, does not throw or corrupt", () => {
  // NOTE on why this needs a character-collision fixture: a "typical" multi-
  // char string like `envVars: "MY_SECRET_VAR"` is a WEAK reproduction here —
  // pre-fix, iterating its characters looks up `process.env['M']`,
  // `process.env['Y']`, etc., and in any real environment those single-char
  // lookups are already undefined, so the buggy char-iteration path and the
  // fixed "malformed -> []" path produce IDENTICAL output by coincidence, not
  // by design. That made an earlier version of this test pass even with the
  // fix reverted (caught by re-diffing against the pre-fix source, not by
  // reading the test). To make the two paths actually diverge, this uses a
  // single-CHARACTER env var name that the malformed string's char-iteration
  // would accidentally hit: pre-fix, `envVars: "QZ"` iterates to
  // `process.env['Q']` (a real match here) and `process.env['Z']` (not set),
  // so the pre-fix bug ACCIDENTALLY redacts a value the caller never actually
  // named "Q" for. Post-fix, a malformed `envVars` is entirely ignored ([]),
  // so that accidental match does not happen either — the value survives
  // untouched, same as `envVars` being absent.
  process.env.Q = "hunter2hunter2secretvalue1234567890"; // single-char name: the collision char-iteration hits
  try {
    assert.doesNotThrow(() => redact(
      { a: "contains hunter2hunter2secretvalue1234567890 here" },
      { envVars: "QZ" }, // string, not an array; 'Q' collides with process.env.Q above
    ));
    const clean = redact(
      { a: "contains hunter2hunter2secretvalue1234567890 here" },
      { envVars: "QZ" },
    );
    // Load-bearing: post-fix, the malformed `envVars` must be inert — it must
    // NOT accidentally redact via the 'Q' character the way pre-fix char-
    // iteration did. envVars has no default set to fall back to, so "inert"
    // here means byte-identical to the un-redacted input, not "still protected".
    assert.equal(clean.a, "contains hunter2hunter2secretvalue1234567890 here");
  } finally {
    delete process.env.Q;
  }
});

test("secrets.envVars: a non-iterable value must not throw", () => {
  assert.doesNotThrow(() => redact({ a: "x" }, { envVars: {} }));
});
