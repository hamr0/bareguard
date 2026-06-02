import { Gate } from "../src/index.js";
import { TOOLS, IRREVERSIBLE, TOOL_NAMES } from "./tools.mjs";
import { buildGatedApi, runHarness } from "./gated-sandbox.mjs";
import { AGENT_CODE } from "./agent-harness.mjs";

const log = (m) => console.log("   agent| " + m);

// --- OPERATOR-AUTHORED GATE CONFIG (the agent never sees or writes this) ---

// The must-ask set, expressed by SHAPE: match the action TYPE against the
// operator's irreversible list. The agent can't dodge it — calling tools.X sets
// type:"X", and X is fixed by which menu function it invoked.
const askPattern = new RegExp('"type"\\s*:\\s*"(' + IRREVERSIBLE.join("|") + ')"');

const passedBack = [];
const gate = new Gate({
  audit:   { path: null },                 // fileless in-memory for the PoC
  tools:   { allowlist: TOOL_NAMES },      // EXHAUSTIVE list = the fence (#2)
  content: { askPatterns: [askPattern], denyPatterns: [] },
  humanChannel: async (event) => {         // "pass back to caller" (#1)
    passedBack.push(event);
    console.log("\n>>> GATE PASSED BACK TO CALLER");
    console.log("    " + event.kind + ' on "' + event.action.type + '"  (reason: ' + event.reason + ")");
    console.log("    operator decision: DENY  (PoC policy: irreversible actions need an explicit human GO)\n");
    return { decision: "deny", reason: "PoC: operator did not approve this booking" };
  },
});

await gate.init();
const api = buildGatedApi(gate, TOOLS);

console.log("=== agent-written harness running inside an operator-owned gate ===\n");
const result = await runHarness(AGENT_CODE, api, log);

console.log("\n=== summary ===");
console.log("harness return value :", JSON.stringify(result));
console.log("irreversible actions passed back to caller :", passedBack.length, "(expected 1: bookFlight)");
console.log("\nThree boundaries, all operator-authored, none in the agent's write-path:");
console.log("  L1 bookFlight  -> ASK   : surfaced to humanChannel, denied");
console.log("  L2 wireMoney   -> DENY  : off-menu, refused by allowlist (never reached a human)");
console.log("  L3 fetch()     -> ABSENT: capability not in sandbox scope at all");
