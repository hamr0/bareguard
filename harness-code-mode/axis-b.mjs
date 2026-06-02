// Axis B — return reconciliation (harness-prd.md §6, decision D7: LOCKED).
//
// DETECT-AND-FEED-A. B compares a RETURNED value against the PER-REQUEST,
// USER-AUTHORED constraint and emits FACTS. It has NO enforcement logic of its
// own (§6.3): it never decides *whether* to stop — Axis A's shape rules do that.
// B only changes *what the human sees* when A stops, and feeds the agent + audit
// sinks. "B always surfaces; only A halts."
//
// HARD CEILING (§6.4) — do NOT overclaim. B reconciles HONEST violations of a
// STATED constraint. It cannot catch:
//   - an in-spec LIE (claims €199, books €450 — a2a F8): needs an independent
//     oracle (payment pre-auth), out of scope.
//   - an OMISSION (hides the better option you never thought to constrain — §11):
//     you can't reconcile against listings you don't know exist.
// This is exactly why reconcile() takes the AUTHORITATIVE returned record, not the
// agent's asserted number — "show the human independent facts, not the agent's
// claim" (§6.2). The price compared is the world's, not the agent's spin.

/**
 * @param {{id?:string, price?:number, stops?:number}} returnedRecord  the
 *   authoritative tool RETURN being acted on (e.g. the catalog row for the flight
 *   the agent chose to book) — NOT a value the agent asserted.
 * @param {{maxPrice?:number, directOnly?:boolean}|null} constraint  the
 *   per-request, USER-AUTHORED constraint. Null / absent → no check (§8 test 5:
 *   opt-in, safe default).
 * @returns {Array<{field:string, stated:(string|number), returned:(string|number), text:string}>}
 *   independent facts (possibly empty). Facts only — no decision, no action.
 */
export function reconcile(returnedRecord, constraint) {
  if (!constraint || !returnedRecord) return [];
  const notes = [];
  if (constraint.maxPrice != null && returnedRecord.price > constraint.maxPrice) {
    notes.push({
      field: "price",
      stated: constraint.maxPrice,
      returned: returnedRecord.price,
      text: `€${returnedRecord.price}, exceeds your stated max of €${constraint.maxPrice}`,
    });
  }
  if (constraint.directOnly && returnedRecord.stops > 0) {
    notes.push({
      field: "stops",
      stated: "direct only",
      returned: `${returnedRecord.stops} stop(s)`,
      text: `${returnedRecord.stops} stop(s), but you asked for direct only`,
    });
  }
  return notes;
}
