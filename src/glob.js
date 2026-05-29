// Convert a glob pattern to a RegExp. v0.1 supports `*` only — matches any
// character including `/`. No `?`, no character classes, no escapes (PRD v0.5 §15).

/**
 * Compile a glob pattern (only `*`, matching any char incl. `/` and line
 * terminators) to an anchored RegExp.
 *
 * The `s` (dotAll) flag is required: without it `.` does not match `\n` / `\r`,
 * so a name like `"danger\nous"` would slip past a denylist glob `"danger*"`
 * (the deny direction fails OPEN). `s` makes `*` match line terminators too,
 * closing that bypass; the allowlist direction is unaffected (a miss already
 * fails closed).
 * @param {string} glob glob pattern
 * @returns {RegExp} anchored `^...$` RegExp with dotAll
 */
export function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$", "s");
}

/**
 * True if `name` matches any glob in `globs`.
 * @param {string} name string to test
 * @param {string[]} [globs] glob patterns
 * @returns {boolean}
 */
export function matchAny(name, globs) {
  if (!globs || globs.length === 0) return false;
  return globs.some(g => globToRegex(g).test(name));
}
