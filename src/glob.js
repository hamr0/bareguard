// Convert a glob pattern to a RegExp. v0.1 supports `*` only — matches any
// character including `/`. No `?`, no character classes, no escapes (PRD v0.5 §15).

export function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

export function matchAny(name, globs) {
  if (!globs || globs.length === 0) return false;
  return globs.some(g => globToRegex(g).test(name));
}
