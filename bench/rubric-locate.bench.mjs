// Opt-in bench (NOT picked up by `node --test`): `npm run bench:rubric`.
// The pathological 5 MiB decide-core cases moved here from test/rubric-locate-decide.test.js.
// The default suite keeps a 16 KiB -> 64 KiB linearity guard. Exits non-zero on a breached bound.
import assert from "node:assert/strict";
import { decideQuote, extractValue } from "../src/primitives/rubric-locate.js";

const val = (valueKind, op, bound, more = {}) => ({ valueKind, op, ...(op === "between" ? bound : { value: bound }), ...more });
const money = (op, v, more = {}) => val("money", op, v, { currency: "$", ...more });

const MiB5 = 5 * 1024 * 1024;
const cases = {
  digits: "7".repeat(MiB5),
  commas: "1,".repeat(MiB5 / 2),
  dotsdigits: "1.".repeat(MiB5 / 2),
  anchors: "Total: ".repeat(MiB5 / 7),
  numbers: "1 ".repeat(MiB5 / 2),
  times: "12:05 AM ".repeat(Math.floor(MiB5 / 9)),
  dates: "2026-10-12 ".repeat(Math.floor(MiB5 / 11)),
  money: "$1,234.50 ".repeat(Math.floor(MiB5 / 10)),
  units: "5 US dollars ".repeat(Math.floor(MiB5 / 13)),
  dashes: "-".repeat(MiB5),
  colons: ":".repeat(MiB5),
  mixed: "09:27 AM 1.2k $5USD (5) -5 \u22125 a.m. ".repeat(Math.floor(MiB5 / 36)),
};
const decs = [
  val("number", "lt", 5), money("lt", 5), val("money", "lt", 5, { unit: "US dollars" }), val("date", "gte", "2026-01-01"), val("time", "lt", "12:00"),
  val("number", "lt", 5, { anchor: "Total:" }), val("time", "lt", "12:00", { anchor: "Total: " }), { phrases: ["zzz"] },
];

let worst = 0;
const t0 = process.hrtime.bigint();
for (const [name, q] of Object.entries(cases)) {
  for (const d of decs) {
    const t1 = process.hrtime.bigint();
    const r = decideQuote(q, [d]);
    const ms = Number(process.hrtime.bigint() - t1) / 1e6;
    worst = Math.max(worst, ms);
    assert.equal(typeof r.ok, "boolean", `${name}`);
    assert.ok(ms < 30000, `${name} ${JSON.stringify(d)} took ${ms}ms`); // includes the existing normalizeForQuote
  }
}
console.log(`5 MiB decide (96 cases): worst single decide ${worst.toFixed(0)} ms, total ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);

// extraction alone (no normalize) is linear: 5x the input costs well under 15x the time
const tm = (q) => { const t1 = process.hrtime.bigint(); extractValue({ valueKind: "time" }, q); extractValue({ valueKind: "number" }, q); extractValue(money("lt", 1), q); return Number(process.hrtime.bigint() - t1) / 1e6; };
const unit = "09:27 AM $5 12 2026-10-12 ";
tm(unit.repeat(1000)); // warm up
const small = tm(unit.repeat((MiB5 / 5 / unit.length) | 0));
const large = tm(unit.repeat((MiB5 / unit.length) | 0));
console.log(`extraction only: 1 MiB ${small.toFixed(0)} ms, 5 MiB ${large.toFixed(0)} ms`);
assert.ok(large < 10000 && large < small * 15 + 50, `not linear: ${small} -> ${large}`);

// one huge number is still exact and bounded
assert.equal(extractValue({ valueKind: "number" }, cases.digits).ok, true);
assert.equal(decideQuote(cases.digits, [val("number", "gt", 5)]).ok, true);
console.log("bench:rubric ok");
