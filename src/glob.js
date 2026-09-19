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
 * @when Only to mirror bareguard's own glob matching outside the gate — previewing which tools an allowlist admits, or testing a pattern you are about to configure. Supports `*` ONLY (matching any character, including `/` and newlines): no `?`, no character classes, no escapes.
 * @category matching
 * @fails Throws a `SyntaxError` only if the escaped pattern is not a valid RegExp; ordinary glob input never does. Regex metacharacters in the input are escaped for you, so `"a.b"` matches the literal `a.b`.
 * @example
 * import { globToRegex } from "bareguard";
 * globToRegex("read_*").test("read_file"); // true
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
 * @when The one you usually want over `globToRegex` — test a name against a list of patterns the way `tools.allowlist` / `fs.deny` do. Use it to preview a config, not to enforce; enforcement is the Gate's job.
 * @category matching
 * @fails Never throws for ordinary input; a missing or empty `globs` returns `false` (no match), which is why an EMPTY `tools.allowlist` is handled by the gate rather than here.
 * @example
 * import { matchAny } from "bareguard";
 * matchAny("read_file", ["read_*", "search"]); // true
 */
export function matchAny(name, globs) {
  if (!globs || globs.length === 0) return false;
  return globs.some(g => globToRegex(g).test(name));
}
