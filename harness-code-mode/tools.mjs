// The capability menu — the EXHAUSTIVE list. THIS IS THE BOUNDARY (#2).
// Operator-authored. The agent's code can COMPOSE these; it cannot ADD to them.
// "Code mode" gives the agent a typed API like this and lets it write code over
// it, instead of dispatching one tool-call at a time.

export const TOOLS = {
  // --- reversible / safe: the gate lets these through unchallenged ---
  async search({ from, to } = {}) {
    const catalog = [
      { id: "RY123", carrier: "Ryanair", price: 275, stops: 2 },
      { id: "TP456", carrier: "TAP",     price: 295, stops: 0 },
      { id: "LH789", carrier: "Lufthansa", price: 410, stops: 1 },
    ];
    return from && to ? catalog : [];
  },
  async readPolicy() {
    return { maxPrice: 300, directOnly: true };
  },

  // --- irreversible: the predefined MUST-ASK set (operator-defined, by SHAPE) ---
  async bookFlight({ id, price } = {}) {
    return { booked: true, id, price, pnr: "PNR-" + id };
  },
  async sendEmail({ to } = {}) {
    return { sent: true, to };
  },
};

// The operator's classification of what is irreversible — NOT the agent's.
// Customs decides; the package never self-tags (§12.1). The agent code has no
// access to this list and cannot change which of its actions get passed back.
export const IRREVERSIBLE = ["bookFlight", "sendEmail"];

// The exhaustive allowlist handed to bareguard. Anything the agent's code tries
// to call outside this set is denied at the gate (step 5), even though the code
// "ran".
export const TOOL_NAMES = Object.keys(TOOLS);
