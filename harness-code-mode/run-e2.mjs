// E2 — Axis-B reconcile, end-to-end (harness-prd.md §6.2, graduation gate §9.2.2).
//
// The FIRST PoC that touches the new surface. It demonstrates the LOCKED D7 claim
// literally: Axis A's shape rule decides WHETHER to stop (bookFlight is
// irreversible -> ask, in BOTH runs below); Axis B only changes WHAT THE HUMAN
// SEES at that stop. B annotates with an INDEPENDENT fact drawn from the
// authoritative tool return — never the agent's spin — curing F7 (invisible loss
// becomes visible on the approval screen).
//
// NOT a primitive change: src/ is untouched. B lives in this harness/runner layer
// (per §7 "where it lives"); bareguard stays the chokepoint it calls. Never ship.

import { Gate } from "../src/index.js";
import { TOOLS, IRREVERSIBLE, TOOL_NAMES } from "./tools.mjs";
import { buildGatedApi, runHarness } from "./gated-sandbox.mjs";
import { agentBody } from "./agent-harness-e2.mjs";
import { reconcile } from "./axis-b.mjs";

const log = (m) => console.log("   " + m);

// PER-REQUEST, USER-AUTHORED constraint (D3 / M1): rides WITH the request, not in
// the floor, and the agent body never sees it. This is the only input B reconciles
// against. In a real runtime it is captured from the user's request, never the
// agent checking itself.
const REQUEST_CONSTRAINT = { maxPrice: 300, directOnly: true };

// Axis A floor (operator-authored, by SHAPE): irreversible action types -> ask.
const askPattern = new RegExp('"type"\\s*:\\s*"(' + IRREVERSIBLE.join("|") + ')"');

async function runScenario(label, strategy) {
  console.log(`\n=== ${label} (agent strategy: ${strategy}) ===`);

  // Authoritative tool RETURNS are recorded so Axis B reconciles against the
  // world's number, not the agent's asserted one (§6.2). The agent's code only
  // ever sees the gated api; the recorder sits in the runner, outside its reach.
  const returns = [];
  const auditLog = [];

  const gate = new Gate({
    audit: { path: null },
    tools: { allowlist: TOOL_NAMES },
    content: { askPatterns: [askPattern], denyPatterns: [] },
    humanChannel: async (event) => {
      // A has ALREADY decided to stop (askPattern matched bookFlight). B does NOT
      // decide whether to stop — it enriches what the human sees right here.
      const id = event.action.id;
      const authoritative =
        returns
          .flatMap((r) => (Array.isArray(r.value) ? r.value : []))
          .find((f) => f && f.id === id) ?? null;

      const notes = reconcile(authoritative, REQUEST_CONSTRAINT);

      // Audit: request + return together so the reconcile is reconstructable
      // later (§7 audit-extend / OQ4).
      auditLog.push({ action: event.action, authoritative, notes });

      console.log(`\n   >>> AXIS A STOPPED on "${event.action.type}" (irreversible -> ask)`);
      if (notes.length === 0) {
        console.log("       AXIS B (independent): within your stated constraints.");
        console.log("       human sees a clean fact -> APPROVES.");
        return { decision: "allow", reason: "within stated constraints" };
      }
      console.log("       AXIS B (independent fact, NOT the agent's claim):");
      for (const n of notes) console.log(`         • ${n.text}`);
      console.log("       human sees the loss the agent glossed over -> DENIES.");
      return {
        decision: "deny",
        reason: "Axis B: " + notes.map((n) => n.text).join("; "),
      };
    },
  });

  await gate.init();

  // record returns by composing a thin wrapper around the gated api (runner layer,
  // not visible to the agent body inside the sandbox).
  const api = buildGatedApi(gate, TOOLS);
  const recordingApi = {};
  for (const k of Object.keys(api)) {
    recordingApi[k] = async (...a) => {
      const value = await api[k](...a);
      returns.push({ tool: k, value });
      return value;
    };
  }

  const result = await runHarness(agentBody(strategy), recordingApi, log);

  const denied = result && result.error && result.error.type === "policy_denied";
  console.log(`   outcome: booking ${denied ? "DENIED" : "ALLOWED"}`);
  return { result, auditLog };
}

console.log("=== E2 — Axis-B return reconciliation, riding into Axis-A's stop ===");
console.log(`    per-request constraint (user-authored): maxPrice=${REQUEST_CONSTRAINT.maxPrice}, directOnly=${REQUEST_CONSTRAINT.directOnly}`);

// Scenario 1: the agent DRIFTS to the €410 flight (honest violation of stated €300).
const drift = await runScenario("VIOLATION", "drift");
// Scenario 2: the agent COMPLIES (€295, direct). Same Axis-A stop; B has nothing
// to flag, so the human's view — and decision — differ. Proves B changes the VIEW,
// not WHETHER you stop.
const comply = await runScenario("CLEAN", "comply");

console.log("\n=== summary ===");
console.log("Both runs hit the SAME Axis-A stop (bookFlight is irreversible -> ask).");
console.log("Axis B changed only WHAT THE HUMAN SAW at that stop:");
console.log(`  VIOLATION: B surfaced "${drift.auditLog[0]?.notes.map((n) => n.text).join("; ")}" -> human DENIED.`);
console.log(`  CLEAN:     B surfaced nothing -> human APPROVED.`);
console.log("\nD7 demonstrated: B detect-and-feed-A. A decides whether to stop; B");
console.log("decides what the human sees. The independent fact came from the tool");
console.log("RETURN, not the agent's spin (F7 cured: invisible loss made visible).");
