// Regression tests for /code-review findings #2, #3, #7, #8 (all in
// src/primitives/audit.js's oversize-line truncation path):
//
//   #2/#3 — the wholesale payload collapse fired on EVERY object-shaped
//     payload key unconditionally, even one that was not the reason the line
//     was oversize, and always replaced it with `{_truncated,bytes[,type]}` —
//     destroying `result.costUsd`/`.tokens`/`.pricing`/`.counts`. The cold-start
//     budget rebuild (`_rebuildBudgetFromAudit`, via `sanitizeSpend`) reads
//     exactly those fields off `result`, so a collapsed round silently
//     rebuilds as $0 spend on restart — a cap bypass that fails OPEN.
//   #7 — the last-resort scalar-only fallback dropped `action`/`result`
//     entirely (both are objects), so a round that reaches this branch
//     vanishes from the cold-start rebuild the same way.
//   #8 — the `perKey` bound (`action`/`result`) called `boundOwnValues` on any
//     truthy value, including a STRING. `boundOwnValues` spreads its argument's
//     own keys, so a string silently turned into a char-indexed object
//     (`"search"` -> `{0:'s',1:'e',...}`), corrupting the field's type.
//
// Each case below reproduces the bug directly against the pre-fix behavior
// described in the commit this test ships with; see the audit.js comments at
// the fixed call sites for the mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Audit } from "../src/primitives/audit.js";
import { sanitizeSpend } from "../src/primitives/budget.js";
import { makeTmpDir, cleanup } from "./_helpers.js";

const MAX_LINE_BYTES = 3500;

async function emitAndRead(t, fields) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  const a = new Audit({ filePath: auditPath, runId: "r1" });
  await a.init();
  await a.emit(fields);
  const [line] = await a.readAll();
  return line;
}

test("audit truncation: an oversize `action` must not collapse a tiny `result` that carries real spend", async (t) => {
  // Enough distinct keys that per-field clipping (200 bytes/key) alone cannot
  // bring the line under MAX_LINE_BYTES, forcing the wholesale-collapse block
  // to run — while `result` is tiny and was never the reason the line is
  // oversize.
  const bigAction = { type: "bash" };
  for (let i = 0; i < 50; i++) bigAction["ka" + i] = "y".repeat(300);
  const line = await emitAndRead(t, {
    phase: "record",
    action: bigAction,
    result: { costUsd: 0.50, tokens: 1200, pricing: "priced" },
  });
  assert.equal(line.action._truncated, true, "action should actually have been collapsed in this case");
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") <= MAX_LINE_BYTES);
  // result was never the oversize field — it must survive untouched.
  assert.deepEqual(line.result, { costUsd: 0.50, tokens: 1200, pricing: "priced" });
  const { unpriced, dUsd, dTok } = sanitizeSpend(line.result);
  assert.equal(unpriced, false);
  assert.equal(dUsd, 0.50);
  assert.equal(dTok, 1200);
});

test("audit truncation: a `result` that IS collapsed must still preserve its budget scalars", async (t) => {
  const bigAction = { type: "bash" };
  for (let i = 0; i < 50; i++) bigAction["ka" + i] = "y".repeat(300);
  const bigResult = { costUsd: 0.75, tokens: 99999, pricing: "priced", counts: { writes: 3 } };
  for (let i = 0; i < 50; i++) bigResult["kr" + i] = "z".repeat(300);

  const line = await emitAndRead(t, { phase: "record", action: bigAction, result: bigResult });
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") <= MAX_LINE_BYTES);
  assert.equal(line.result._truncated, true, "result should actually have been collapsed in this case");
  assert.equal(line.result.costUsd, 0.75);
  assert.equal(line.result.tokens, 99999);
  assert.equal(line.result.pricing, "priced");
  assert.deepEqual(line.result.counts, { writes: 3 });

  const { unpriced, dUsd, dTok } = sanitizeSpend(line.result);
  assert.equal(unpriced, false);
  assert.equal(dUsd, 0.75);
  assert.equal(dTok, 99999);
});

test("audit truncation: the scalar-only last-resort fallback must still preserve result spend + action.type", async (t) => {
  const fields = {
    phase: "record",
    action: { type: "tool" },
    result: { costUsd: 1.23, tokens: 42, pricing: "priced" },
  };
  // Force the true last-resort branch: many extra caller-supplied top-level
  // scalar fields that are not covered by any per-field bound, so the line is
  // still oversize even after the wholesale collapse.
  for (let i = 0; i < 40; i++) fields["extra" + i] = "e".repeat(150);

  const line = await emitAndRead(t, fields);
  // Unlike its two siblings above, this test never checked the actual line
  // bound — a scalars-only line that keeps every caller-supplied top-level key
  // uncapped can still exceed MAX_LINE_BYTES (measured: 6024 bytes for this
  // exact shape before the key-count bound existed), silently breaking the
  // atomic-append guarantee this whole file exists to preserve.
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") <= MAX_LINE_BYTES);
  assert.equal(line._dropped, "line exceeded MAX_LINE_BYTES after field truncation");
  assert.deepEqual(line.action, { type: "tool" });
  assert.equal(line.result.costUsd, 1.23);
  assert.equal(line.result.tokens, 42);
  assert.equal(line.result.pricing, "priced");
  // The drop must be loud and countable, not silent.
  assert.equal(typeof line._dropped_keys, "number");
  assert.ok(line._dropped_keys > 0);
  assert.equal(typeof line._dropped_bytes, "number");
  assert.ok(line._dropped_bytes > 0);

  // This is exactly what `_rebuildBudgetFromAudit` gates a round's accrual on.
  assert.ok(line.phase === "record" && line.result);
  const { unpriced, dUsd, dTok } = sanitizeSpend(line.result);
  assert.equal(unpriced, false);
  assert.equal(dUsd, 1.23);
  assert.equal(dTok, 42);
});

test("audit truncation: a string `action`/`result` must not be corrupted into a char-indexed object", async (t) => {
  const line = await emitAndRead(t, {
    phase: "record",
    action: "search",
    reason: "y".repeat(4000), // forces the oversize-line path
    result: { ok: true },
  });
  assert.equal(typeof line.action, "string");
  assert.equal(line.action, "search");
});

test("audit truncation: many caller-supplied top-level scalar keys alone (no oversize single field) still fit MAX_LINE_BYTES", async (t) => {
  // Every individual key here is far under FIELD_BYTE_CAP; only the KEY COUNT
  // is what pushes the line over MAX_LINE_BYTES. Measured against the pre-fix
  // source: 6024 bytes, over the cap, written anyway.
  const fields = {
    phase: "record",
    action: { type: "tool" },
    result: { costUsd: 2.5, tokens: 7, pricing: "priced" },
  };
  for (let i = 0; i < 40; i++) fields["k" + i] = "v".repeat(150);

  const line = await emitAndRead(t, fields);
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") <= MAX_LINE_BYTES);
  assert.ok(line._dropped_keys > 0);
  assert.ok(line._dropped_bytes > 0);
  // Never-droppable routing/correlation fields must all have survived.
  assert.equal(line.phase, "record");
  assert.equal(typeof line.ts, "string");
  assert.equal(typeof line.seq, "number");
  assert.equal(typeof line.run_id, "string");
  // Budget carriers must have survived too.
  assert.deepEqual(line.action, { type: "tool" });
  const { unpriced, dUsd, dTok } = sanitizeSpend(line.result);
  assert.equal(unpriced, false);
  assert.equal(dUsd, 2.5);
  assert.equal(dTok, 7);
});

test("audit truncation: an unserializable payload PLUS many top-level scalar keys still fits MAX_LINE_BYTES", async (t) => {
  // Exercises the OTHER caller of scalarOnlyLine (the unserializable-payload
  // catch in emit()) together with the new key-count bound: a BigInt makes
  // JSON.stringify(line) throw, and 40 extra scalar keys mean the scalars-only
  // fallback it builds is itself still oversize on key count alone.
  const fields = {
    phase: "record",
    action: { type: "tool", weird: 10n },
    result: { costUsd: 3.1, tokens: 9, pricing: "priced" },
  };
  for (let i = 0; i < 40; i++) fields["extra" + i] = "e".repeat(150);

  const line = await emitAndRead(t, fields);
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") <= MAX_LINE_BYTES);
  assert.ok(line._dropped_keys > 0);
  assert.ok(line._dropped_bytes > 0);
  assert.deepEqual(line.action, { type: "tool" });
  const { unpriced, dUsd, dTok } = sanitizeSpend(line.result);
  assert.equal(unpriced, false);
  assert.equal(dUsd, 3.1);
  assert.equal(dTok, 9);
});

test("audit truncation: the must-keep core, every field maxed, never exceeds MAX_LINE_BYTES on its own (the genuinely-final guard's invariant)", async (t) => {
  // boundKeyCount's last-resort fallback (audit.js, the "GENUINELY FINAL
  // GUARD" comment) exists for a case its own comment says is "not reachable
  // with today's fixed ~12-key core and caps" — i.e. that MUST_KEEP_KEYS,
  // each clipped to its worst-case length, plus the re-derived action/result
  // carriers, can never itself exceed MAX_LINE_BYTES. That claim has no
  // in-repo test and cannot be whitebox-tested without exporting internals
  // (rejected: test-only production code). This proves it through the public
  // Audit API instead: every MUST_KEEP_KEYS field that IS caller-controlled
  // (run_id/parent_run_id at construction; phase/decision/severity/rule/aid/
  // dimension/newCap per emit) is set at or beyond its 120-byte clip length,
  // action/result carry real spend, and 40 extra 150-byte scalar keys force
  // the line through the oversize path into the scalar-only last resort.
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  const long = (prefix) => prefix + "x".repeat(200); // well beyond the 120-byte clip
  const a = new Audit({
    filePath: auditPath,
    runId: long("run-"),
    parentRunId: long("parent-"),
  });
  await a.init();

  const fields = {
    phase: long("phase-"),
    decision: long("decision-"),
    severity: long("severity-"),
    rule: long("rule-"),
    aid: long("aid-"),
    dimension: long("dimension-"),
    newCap: long("newcap-"),
    action: { type: "tool" },
    result: { costUsd: 4.2, tokens: 17, pricing: "priced" },
  };
  // Extra droppable keys, oversized enough that dropping them all is the
  // ONLY way the drop loop could bring the line under MAX_LINE_BYTES with the
  // must-keep core this large — if the invariant were false, this is exactly
  // the shape that would hit the genuinely-final guard's core fallback
  // (`{ts, seq, run_id}` only) and lose every other must-keep field.
  for (let i = 0; i < 40; i++) fields["extra" + i] = "e".repeat(150);

  await a.emit(fields);
  const [line] = await a.readAll();

  const lineBytes = Buffer.byteLength(JSON.stringify(line), "utf8");
  assert.ok(lineBytes <= MAX_LINE_BYTES, `line was ${lineBytes} bytes, over the ${MAX_LINE_BYTES}-byte cap`);
  // Proves the backstop actually ran, not that the line happened to be small.
  assert.ok(line._dropped_keys > 0);
  assert.ok(line._dropped_bytes > 0);
  // The genuinely-final core fallback (`{ts, seq, run_id}` only) never fired —
  // that is this test's actual claim: the must-keep core fit without it.
  assert.equal(line._dropped_core, undefined);
  // Every must-keep field survived, at its clipped (not dropped) worst-case length.
  for (const key of ["ts", "seq", "run_id", "parent_run_id", "spawn_depth",
                      "phase", "decision", "severity", "rule", "aid", "dimension", "newCap"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(line, key), `must-keep key "${key}" was dropped`);
  }
  assert.ok(line.run_id.startsWith("run-"));
  assert.ok(line.phase.startsWith("phase-"));
  assert.ok(line.aid.startsWith("aid-"));
  // Budget carriers survived the collapse too.
  assert.deepEqual(line.action, { type: "tool" });
  const { unpriced, dUsd, dTok } = sanitizeSpend(line.result);
  assert.equal(unpriced, false);
  assert.equal(dUsd, 4.2);
  assert.equal(dTok, 17);
});

test("audit truncation: a topup line's dimension/newCap survive many extra top-level scalar keys", async (t) => {
  // `_rebuildBudgetFromAudit` (gate.js) reconstructs a raised cap from
  // `l.dimension`/`l.newCap` on a `phase:"topup"` line — these are never
  // dropped even under key-count pressure, or a cold-start rebuild silently
  // loses the topup and reopens the original cap.
  const fields = { phase: "topup", action: null, dimension: "costUsd", oldCap: 1, newCap: 5 };
  for (let i = 0; i < 40; i++) fields["extra" + i] = "e".repeat(150);

  const line = await emitAndRead(t, fields);
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") <= MAX_LINE_BYTES);
  assert.ok(line._dropped_keys > 0);
  assert.equal(line.dimension, "costUsd");
  assert.equal(line.newCap, 5);
});
