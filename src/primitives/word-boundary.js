// Shared word-boundary test for prefix/command matching (bash.allow in
// bash.js, and rwx's bash-map matching in rwx.js). Extracted (0.19.1) so the
// two modes can't silently drift apart on what counts as a boundary — they
// were built independently and rwx.js's matchBash only recognized a plain
// space, while bash.allow already recognized space OR tab (the shell splits
// words on both).
//
// ASCII space/tab only, deliberately not `\s`: `\s` also matches Unicode
// whitespace (U+00A0 NBSP, U+2000 en quad, etc.), and the shell never splits
// words on those — treating one as a boundary would let a Unicode-whitespace
// byte between a real prefix and unrelated text sneak past the check
// (`allow: ["ls"]` must not admit "ls /etc").
export const WORD_BOUNDARY = /[ \t]/;

/**
 * True when `cmd` starts with `prefix` on a word boundary: the command
 * equals the prefix exactly; OR the prefix already ends in a boundary char
 * (a prefix authored with a trailing space/tab, e.g. "git ", already carries
 * its own boundary — a plain `startsWith` is correct there); OR the char in
 * `cmd` immediately after `prefix` is a boundary char.
 * @param {string} cmd
 * @param {string} prefix
 * @returns {boolean}
 */
export function startsWithWordBoundary(cmd, prefix) {
  if (!cmd.startsWith(prefix)) return false;
  if (cmd.length === prefix.length) return true; // exact match
  if (WORD_BOUNDARY.test(prefix[prefix.length - 1])) return true; // boundary already baked into the prefix
  return WORD_BOUNDARY.test(cmd[prefix.length]); // next char after the prefix must be a space or tab
}
