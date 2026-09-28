// ONE element-type validator for every array-shaped config key EXCEPT
// `fs.deny`/`fs.readScope`/`fs.writeScope`, which get a richer, path-specific
// validator (`fs-config.js`: tilde expansion, absolute-only, per-index
// messages) — this table exists for everything else: `tools.allowlist`/
// `denylist`, `content.denyPatterns`/`askPatterns`, `bash.allow`/
// `denyPatterns`/`extraDestructive`/`extraSuperDestructive`, `net.allowDomains`,
// `secrets.keys`/`patterns`/`envVars`, `axisB.reversible`.
//
// `gate.js`'s `assertArrayShapedConfig` already throws at construct time when
// one of these keys is present but not an ARRAY (section/array shape). What it
// did NOT check before this — measured empirically, see CONTRACT.md §A — is
// the type of each ELEMENT inside an otherwise-well-shaped array. A single bad
// element (`content.denyPatterns: [/ok/, "oops"]`, `tools.allowlist: [123]`)
// used to reach the matching code untouched and either throw mid-`check()`
// (killing the gate for every later action) or, for `secrets.*`, get swallowed
// by `redact()`'s outer never-throw catch — which discarded the WHOLE
// key-walk result, not just the bad entry, silently turning off default-key
// redaction. Two call sites use this ONE table (never two copies of the
// element-type list):
//   - construct time (`Gate` constructor, via `assertArrayShapedConfig`):
//     `assertArrayElementTypes` throws loud and early — same family, same
//     polarity as the array-shape check it sits next to.
//   - direct primitive calls with raw config that bypassed construct-time
//     validation (a caller invoking `toolsAllowlistCheck`/`contentDenyCheck`/
//     `bashCheck`/`redact` etc. directly, or a `cfg` swapped by reference
//     after construction): `findInvalidIndex` reports the bad element without
//     throwing, so the caller can fail CLOSED (deny) instead of crashing out
//     of `check()`; `filterValidElements` drops ONLY the bad element(s) and
//     keeps the rest of the list live — `secrets.redact()`'s never-throw
//     contract needs this shape specifically (see secrets.js).

/**
 * `"section.key"` -> the type every element of that array must be.
 * @type {Readonly<Object<string,"string"|"regexp">>}
 */
export const ARRAY_ELEMENT_TYPES = Object.freeze({
  "tools.allowlist": "string",
  "tools.denylist": "string",
  "content.denyPatterns": "regexp",
  "content.askPatterns": "regexp",
  "net.allowDomains": "string",
  "bash.allow": "string",
  "bash.denyPatterns": "regexp",
  "bash.extraDestructive": "regexp",
  "bash.extraSuperDestructive": "regexp",
  "secrets.keys": "string",
  "secrets.patterns": "regexp",
  "secrets.envVars": "string",
  "axisB.reversible": "string",
});

function typeName(elementType) {
  return elementType === "regexp" ? "RegExp" : "string";
}

function describeElement(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * @param {*} value
 * @param {"string"|"regexp"} elementType
 * @returns {boolean}
 */
export function isValidElement(value, elementType) {
  return elementType === "regexp" ? value instanceof RegExp : typeof value === "string";
}

/**
 * Index of the first element that fails `elementType`, or -1 if the list is
 * clean (or not even an array — the array-shape check is a separate concern,
 * handled by the caller before this runs). Never throws.
 * @param {*} list
 * @param {"string"|"regexp"} elementType
 * @returns {number}
 */
export function findInvalidIndex(list, elementType) {
  if (!Array.isArray(list)) return -1;
  for (let i = 0; i < list.length; i++) {
    if (!isValidElement(list[i], elementType)) return i;
  }
  return -1;
}

/**
 * Construct-time (throwing) element-type check for one `section.key` array.
 * No-op when the key has no table entry (e.g. an fs.* key, validated
 * separately) or `list` isn't an array (the array-shape check already threw
 * or the key wasn't configured).
 * @param {string} section
 * @param {string} key
 * @param {*} list
 * @returns {void}
 */
export function assertArrayElementTypes(section, key, list) {
  const elementType = ARRAY_ELEMENT_TYPES[`${section}.${key}`];
  if (!elementType || !Array.isArray(list)) return;
  const idx = findInvalidIndex(list, elementType);
  if (idx !== -1) {
    throw new Error(
      `invalid bareguard config: ${section}.${key}[${idx}] must be a ${typeName(elementType)}, got ${typeof list[idx]}: ${describeElement(list[idx])}`,
    );
  }
}

/**
 * Never-throwing filter: keep only the elements matching `elementType`, drop
 * the rest. Used where discarding an entire list on one bad element would be
 * worse than the bad element itself (`secrets.redact()` — see secrets.js).
 * @param {*} list
 * @param {"string"|"regexp"} elementType
 * @returns {Array}
 */
export function filterValidElements(list, elementType) {
  if (!Array.isArray(list)) return [];
  return list.filter((v) => isValidElement(v, elementType));
}
