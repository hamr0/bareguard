// Shared key clipper. One home for what gate.js and rwx.js each carried as a
// private copy; a leaf module, so neither imports the other.

/**
 * Bound a caller-supplied key before it is interpolated into an error message
 * or a deny reason (both are unbounded downstream; errors are not redacted and
 * not size-capped by anything downstream).
 * @param {*} k key (coerced with String)
 * @returns {string} the key, clipped to 64 chars plus an ellipsis
 */
export function clipKey(k) {
  const s = String(k);
  return s.length > 64 ? s.slice(0, 64) + "…" : s;
}
