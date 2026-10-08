// Shared plain-object test. One home for what gate.js, rwx.js and rubric-state.js
// each carried as a private copy; a leaf module, so none of them imports gate.js.

/**
 * True for a plain object — `{}`-literal shaped, or the null-prototype shape
 * `safeAction()` deliberately produces gate-wide (0.6.0) — and false for
 * everything else a config section must not be: an array, a string/number/
 * boolean (primitives coerce through `Object.getPrototypeOf` to their wrapper
 * prototype, e.g. `String.prototype`, never `Object.prototype`), or an exotic
 * object like `Map`/`Set`/`Date`. The prior guard at each of these three call
 * sites was `typeof s !== "object" || Array.isArray(s)`, which a `Map` passes
 * (`typeof` is `"object"`, it is not an `Array`) — so `new Gate({ tools: new
 * Map([["allowlist",["x"]]]) })` constructed with no error, and `s["allowlist"]`
 * on a Map is always `undefined` (Map entries are not own properties), reading
 * as "unconfigured" — full fail-OPEN, same failure as the string-section bug
 * this replaces, just a different exotic type slipping through the same hole.
 * One structural check closes the whole family (Map, Set, Date, anything else
 * with a foreign prototype) instead of enumerating bad types one at a time.
 * @param {*} v value to check
 * @returns {boolean} true if `v` is a plain object (Object.prototype or null prototype)
 */
export function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
