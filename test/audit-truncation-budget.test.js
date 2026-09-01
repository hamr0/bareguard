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
  assert.equal(line._dropped, "line exceeded MAX_LINE_BYTES after field truncation");
  assert.deepEqual(line.action, { type: "tool" });
  assert.equal(line.result.costUsd, 1.23);
  assert.equal(line.result.tokens, 42);
  assert.equal(line.result.pricing, "priced");

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
