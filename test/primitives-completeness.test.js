// Completeness guard for the primitives manifest.
//
// A primitive is any exported symbol whose JSDoc carries @when (see
// scripts/gen-primitives.mjs). This test fails if a PUBLIC export is neither in
// primitives.json nor on the deliberate-exclusion allow-list below — so a NEW
// export can never silently miss the manifest. The allow-list is this repo's
// curation policy, owned here: the generator stays generic and knows none of
// these names.
//
// It also guards the two ways the manifest can be WRONG rather than short: a
// stale allow-list, and an entry missing a required field. `check:primitives`
// (CI) covers the third way — the committed file drifting from the source.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../primitives.json", import.meta.url), "utf8"),
);
const manifested = new Set(manifest.primitives.map((p) => p.name));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

// Every public JS entry point, DERIVED from package.json "exports" and resolved
// through the package NAME (Node self-reference) — exactly what a consumer's
// `import "bareguard/…"` hits. A hardcoded src-path list would bypass the
// exports map: a subpath pointing at a missing/renamed file would break
// consumers while this test stayed green. Data exports (.json) carry no symbols.
const SPECIFIERS = Object.entries(pkg.exports)
  .filter(([, entry]) => !(typeof entry === "string" && entry.endsWith(".json")))
  .map(([sub]) => (sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`));

// Deliberate exclusions — WHY each is out:
const EXCLUDED = new Set([
  // A bare error class: you catch it, you don't construct it as a capability.
  // It belongs inside the `fails` line of whatever throws it, not beside the
  // primitives as a thing to reach for. (Same policy bare-agent uses.)
  "BudgetUnavailableError",
]);

async function allExports() {
  const names = new Set();
  for (const spec of SPECIFIERS) {
    const mod = await import(spec);
    for (const n of Object.keys(mod)) if (n !== "default") names.add(n);
  }
  return names;
}

test("every package.json export subpath resolves", async () => {
  // A clean, named failure for a broken exports map, instead of an opaque
  // MODULE_NOT_FOUND surfacing from inside another test.
  assert.ok(SPECIFIERS.includes(pkg.name), "exports map has no '.' entry");
  for (const spec of SPECIFIERS) {
    await assert.doesNotReject(import(spec), `export subpath does not resolve: ${spec}`);
  }
  for (const [sub, entry] of Object.entries(pkg.exports)) {
    if (typeof entry === "string" && entry.endsWith(".json")) {
      assert.ok(
        existsSync(new URL(`../${entry.slice(2)}`, import.meta.url)),
        `data export ${sub} points at a missing file: ${entry}`,
      );
    }
  }
});

test("every public export is manifested or explicitly excluded", async () => {
  const missing = [...(await allExports())]
    .filter((n) => !manifested.has(n) && !EXCLUDED.has(n))
    .sort();
  assert.deepEqual(
    missing,
    [],
    "These exports are neither in primitives.json nor on the exclusion " +
      "allow-list. Add @when/@fails/@example to each (then run " +
      "`npm run build:primitives`), or add it to EXCLUDED here with a " +
      `reason:\n  ${missing.join("\n  ")}`,
  );
});

test("exclusion allow-list has no stale entries", async () => {
  // An excluded name that is ALSO manifested, or is no longer exported at all,
  // means the list drifted away from the surface it is supposed to describe.
  const exported = await allExports();
  const stale = [...EXCLUDED]
    .filter((n) => manifested.has(n) || !exported.has(n))
    .sort();
  assert.deepEqual(
    stale,
    [],
    `EXCLUDED entries now manifested or no longer exported — remove them:\n  ${stale.join("\n  ")}`,
  );
});

test("manifest is well-formed: every entry has the required fields", () => {
  assert.ok(manifest.primitives.length > 0, "manifest has no primitives");
  for (const p of manifest.primitives) {
    for (const f of ["name", "category", "when", "import", "signature", "fails", "example"]) {
      assert.ok(
        p[f] && String(p[f]).trim(),
        `primitive ${p.name || "(unnamed)"} missing field: ${f}`,
      );
    }
  }
});

test("manifest carries no version — package.json is the single authority", () => {
  // A version stamped here is a 4th pin that goes stale on every bump and, being
  // stale in a believable way, reads as authoritative while lying. Settled
  // suite-wide with bare-agent and litectx; this asserts bareguard does not
  // drift back.
  assert.equal(manifest.version, undefined);
  assert.deepEqual(Object.keys(manifest).sort(), ["package", "primitives"]);
  assert.equal(manifest.package, "bareguard");
});

test("every example is syntactically valid JavaScript", async () => {
  // An example that does not parse is worse than no example: it is a confident
  // wrong answer to "how do I call this?".
  const { execFileSync } = await import("node:child_process");
  for (const p of manifest.primitives) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ["--input-type=module", "--check"], {
        input: p.example,
        stdio: ["pipe", "ignore", "pipe"],
      }),
      `primitive ${p.name}: @example does not parse as an ES module`,
    );
  }
});
