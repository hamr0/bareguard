// E5 — harness SELECTION (validates D8). Operator-authored catalog of VETTED
// capability bundles. The agent may PROPOSE one of these by name at runtime; it may
// NOT author its own (that would be M1 — a fence no operator vetted). Selection is
// TIGHTEN-ONLY (D2): a bundle is a SUBSET of the floor's tools, can never widen past
// it, and never loosens the floor's ask/deny rules.

// The floor's full legitimate tool set. A bundle can only ever be a subset of this.
export const FLOOR_TOOLS = ["search", "readPolicy", "bookFlight", "sendEmail"];

// The operator's vetted bundles. Each is a capability SCOPE the agent may request.
export const CATALOG = {
  research: ["search", "readPolicy"],
  booking:  ["search", "readPolicy", "bookFlight"],
  comms:    ["readPolicy", "sendEmail"],
};

/**
 * Resolve an agent-PROPOSED bundle name to a concrete allowlist.
 * @param {string} name proposed bundle name
 * @returns {string[]|null} the tighten-only allowlist, or `null` for an
 *   off-catalog / self-authored proposal (→ no ungoverned path: the runner refuses
 *   to execute; D8). The intersection with FLOOR_TOOLS enforces tighten-only even if
 *   a catalog entry were mis-edited to list a non-floor tool.
 */
export function resolveBundle(name) {
  const allow = CATALOG[name];
  if (!allow) return null;
  return allow.filter((t) => FLOOR_TOOLS.includes(t));
}

/**
 * Advisory match-validator (D8): suggest whether a proposed bundle fits the task.
 * ADVISES ONLY — it returns a note for the human/audit and never changes a gate
 * decision. OQ2 asks whether this earns its keep; E5 lets us watch it change
 * nothing while the deterministic floor does all the work.
 * @param {string} task   the user request, in words
 * @param {string} bundle the agent's proposed bundle name
 * @returns {string|null} an advisory note, or null if it looks fine
 */
export function adviseFit(task, bundle) {
  if (/\b(book|flight|reserve)\b/i.test(task) && bundle !== "booking") {
    return `task looks like booking, but agent proposed bundle="${bundle}"`;
  }
  if (/\b(email|notify|message)\b/i.test(task) && bundle !== "comms") {
    return `task looks like comms, but agent proposed bundle="${bundle}"`;
  }
  return null;
}
