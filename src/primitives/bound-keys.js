// Partial top-level-key bound for an annotation `meta` object (ruling #71). One
// helper shared by BOTH bound points - the source bound in gate.js (`boundMeta`)
// and the audit-line bound in audit.js - so the two cannot drift: a rule that
// two places spell by hand is how this repo's re-bounds have disagreed before.
//
// Leaf module (imports only clip-key.js); neither gate.js nor audit.js import
// each other through it.

import { clipKey } from "./clip-key.js";

/** The `meta` byte cap, at both bound points. Not exported by the package. */
export const META_BYTE_CAP = 1000;

/** Marker keys this helper stamps. A caller key with one of these names never survives a bound. */
const MARKER_KEYS = Object.freeze(["_truncated", "bytes", "_droppedKeys", "_droppedKeysMore"]);

/** At most this many dropped-key NAMES are listed; the rest are counted in `_droppedKeysMore`. */
const MAX_LISTED_NAMES = 16;

const byteLen = (s) => Buffer.byteLength(s, "utf8");

/**
 * Bound `obj` to `cap` BYTES by dropping whole TOP-LEVEL keys, largest serialized
 * pair first (ties: key name ascending, code-unit order, so the result is
 * deterministic), until the survivors plus the markers fit. Strings are never cut.
 * Result: the surviving keys in their original order, then `_truncated: true`
 * (a boolean), `bytes` (the original size), `_droppedKeys` (names, each clipped
 * by `clipKey`, at most 16 and a quarter of `cap` in bytes), and `_droppedKeysMore`
 * (only when names were left off the list: how many).
 *
 * The markers always win: a caller key named like a marker is removed before
 * anything is measured (and listed as dropped), so a caller can never forge a
 * "not truncated" result. With `resume`, the input is the output of an earlier
 * pass of this helper (the audit-line bound re-bounds a source-bounded `meta`
 * after redaction expanded it): its own markers are read back - original `bytes`
 * kept, earlier dropped names carried forward - instead of being treated as caller keys.
 * An array, or an object where not even one key fits beside the markers, ends as
 * `{_truncated, bytes}`.
 * @param {object|Array} obj  a JSON-clean value (already round-tripped); not mutated
 * @param {number} cap  byte cap for the whole result, markers included
 * @param {{bytes?: number, resume?: boolean}} [opts]  `bytes` = the original size to
 *   report when the caller measured it before decoupling; default is `obj`'s own size
 * @returns {object} bounded copy, serialized size <= cap whenever `cap` can hold the bare markers
 */
export function dropKeysToFit(obj, cap, opts = {}) {
  const measured = byteLen(JSON.stringify(obj));
  let origBytes = opts.bytes ?? measured;
  if (Array.isArray(obj)) return { _truncated: true, bytes: origBytes };

  const forced = [];     // caller keys named like a marker: dropped first, always
  const keys = [];       // ordinary caller keys, original order
  let priorNames = [];
  let priorMore = 0;
  const hasPrior = opts.resume === true && obj._truncated === true
    && Number.isSafeInteger(obj.bytes) && obj.bytes >= 0;
  if (hasPrior) {
    origBytes = obj.bytes;
    if (Array.isArray(obj._droppedKeys)) priorNames = obj._droppedKeys.filter((n) => typeof n === "string");
    if (Number.isSafeInteger(obj._droppedKeysMore) && obj._droppedKeysMore > 0) priorMore = obj._droppedKeysMore;
  }
  for (const k of Object.keys(obj)) {
    if (k === "__proto__") continue;
    if (MARKER_KEYS.includes(k)) { if (!hasPrior) forced.push(k); continue; }
    keys.push(k);
  }

  const sized = keys.map((k) => ({
    k,
    size: byteLen(JSON.stringify(k)) + 1 + byteLen(JSON.stringify(obj[k])),
  }));
  const order = sized.slice().sort((a, b) => b.size - a.size || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

  const nameBudget = Math.floor(cap / 4);
  // `newlyDropped` is only the first few names (that is all that can be listed);
  // `newCount` is the true count, so this stays O(1) per step.
  const markerFragment = (newlyDropped, newCount = newlyDropped.length) => {
    const all = priorNames.concat(forced, newlyDropped);
    const totalNames = priorNames.length + forced.length + newCount;
    const listed = [];
    let used = 0;
    for (const n of all) {
      if (listed.length >= MAX_LISTED_NAMES) break;
      const c = clipKey(n);
      const b = byteLen(JSON.stringify(c)) + 1;
      if (used + b > nameBudget) break;
      listed.push(c);
      used += b;
    }
    const more = totalNames - listed.length + priorMore;
    return `"_truncated":true,"bytes":${origBytes},"_droppedKeys":${JSON.stringify(listed)}`
      + (more > 0 ? `,"_droppedKeysMore":${more}` : "");
  };

  // Walk the drop count up until the arithmetic size fits. Survivor size is kept as
  // a running sum so this is O(n log n), not a re-stringify per step.
  let survivorSum = sized.reduce((s, e) => s + e.size, 0);
  let fitAt = -1;
  for (let i = 0; i <= order.length; i++) {
    if (i > 0) survivorSum -= order[i - 1].size;
    const left = order.length - i;
    const frag = byteLen(markerFragment(order.slice(0, MAX_LISTED_NAMES).filter((_, j) => j < i).map((e) => e.k), i));
    const total = 2 + survivorSum + (left > 0 ? left - 1 + 1 : 0) + frag;
    if (total <= cap) { fitAt = i; break; }
  }
  if (fitAt >= 0) {
    const dropped = new Set(order.slice(0, fitAt).map((e) => e.k));
    const out = {};
    for (const k of keys) if (!dropped.has(k)) out[k] = obj[k];
    const names = order.slice(0, fitAt).map((e) => e.k);
    // Re-derive the markers as an object, in the same shape the fragment measured.
    Object.assign(out, JSON.parse(`{${markerFragment(names)}}`));
    if (byteLen(JSON.stringify(out)) <= cap) return out;
  }
  return { _truncated: true, bytes: origBytes };
}
