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
  process.env.BAREGUARD_TEST_ENVVARS_SHAPE = "hunter2hunter2secretvalue";
  try {
    assert.doesNotThrow(() => redact(
      { a: "contains hunter2hunter2secretvalue here" },
      { envVars: "BAREGUARD_TEST_ENVVARS_SHAPE" }, // string, not an array
    ));
    const clean = redact(
      { a: "contains hunter2hunter2secretvalue here" },
      { envVars: "BAREGUARD_TEST_ENVVARS_SHAPE" },
    );
    // envVars has no default set to fall back to; the assertion is that the
    // malformed value is inert (no crash, no partial/garbled redaction) —
    // other layers (key-aware walk, value patterns) still run unaffected.
    assert.equal(clean.a, "contains hunter2hunter2secretvalue here");
  } finally {
    delete process.env.BAREGUARD_TEST_ENVVARS_SHAPE;
  }
});

test("secrets.envVars: a non-iterable value must not throw", () => {
  assert.doesNotThrow(() => redact({ a: "x" }, { envVars: {} }));
});
