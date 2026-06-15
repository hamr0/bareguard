// E6h — the CONSTRUCTIVE half of the €280 A/B (2026-06-15).
// E6g refuted "neutral prompt clears €280": the holistic confidence judge
// over-surfaces a COMPLIANT numeric case (4/5). Hypothesis for the real fix:
// verifiable numeric constraints belong on the DETERMINISTIC path (locate→decide,
// design B / §6.7 `checkable`), not the confidence LLM. This confirms it.
// PASS = judgeLocate passes €280 (0 viols) AND catches €400 (viol) every rep.

import { judgeLocate, MODEL } from "./e6-judge.mjs";
const REPS = Number(process.env.E6_REPS || 3);
const pad = (s, n) => String(s).padEnd(n);

const CASES = [
  ["€280 under €300 (COMPLIANT)", "Book a flight under €300.", { id: "F2", price: 280, currency: "EUR" }, false],
  ["€400 under €300 (VIOLATION)", "Book a flight under €300.", { id: "F1", price: 400, currency: "EUR" }, true],
];

async function run() {
  console.log(`\nE6h — deterministic locate→decide over the €280 case · model=${MODEL} · reps=${REPS}`);
  console.log("=".repeat(72));
  let allOk = true;
  for (const [label, req, ans, gviol] of CASES) {
    let flagged = 0;
    for (let i = 0; i < REPS; i++) if ((await judgeLocate(req, ans)).violation) flagged++;
    const ok = gviol ? flagged === REPS : flagged === 0;
    if (!ok) allOk = false;
    const want = gviol ? `viol ${REPS}/${REPS}` : `viol 0/${REPS}`;
    console.log(`  ${pad(label, 30)} flagged ${flagged}/${REPS}  want ${pad(want, 12)} ${ok ? "ok" : gviol ? "MISS" : "FALSE+"}`);
  }
  console.log("=".repeat(72));
  console.log(`\n  deterministic path ${allOk ? "CLEARS €280 and catches €400 — this is the real fix, not the prompt." : "did NOT behave as required."}`);
}
run();
