import { findInvalidIndex, findBlankStringIndex } from "./config-validate.js";

// bash primitive (PRD §8 row 1). Runs at step 3 (action-type deny) when
// action.type === "bash".

// Accepts either flat (action.cmd) or nested (action.args.cmd / .command)
// shapes so wireGate-style {type, args, _ctx} adapters compose without a
// translation layer. Flat shape is the documented canonical form; nested
// fallbacks exist because every wireGate-style adapter surfaces the same
// seam. (v0.4.1, multis seam fix.)
// Shell-control metacharacters that chain, substitute, or redirect — a prefix
// allowlist can't bound what runs after them (`git x; rm -rf ~` starts with an
// allowed prefix but runs `rm`). When `bash.allow` is set, any of these makes
// the command unallowlistable, so it's denied. content.denyPatterns scans the
// whole string and is the right tool when you genuinely need pipes/chaining.
const SHELL_META = /[;&|<>$`()\n\r]/;

/**
 * Step-3 deny for `bash` actions: denyPattern match, then prefix-allowlist (shell-meta makes a command unallowlistable).
 * @param {object} action action being evaluated; command read from action.cmd, action.args.cmd, or action.args.command
 * @param {string} action.type action type (no-op unless "bash")
 * @param {string} [action.cmd] command string (flat shape)
 * @param {object} [action.args] nested-shape args
 * @param {object} [cfg] bash config
 * @param {RegExp[]} [cfg.denyPatterns] patterns that deny the command
 * @param {string[]} [cfg.allow] allowed command prefixes (prefix-only; shell metacharacters force deny)
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null if allowed/not applicable
 */
export function bashCheck(action, cfg = {}) {
  if (action.type !== "bash") return null;
  const rawCmd = action.cmd ?? action.args?.cmd ?? action.args?.command;
  // A present-but-non-string command is type confusion: `RegExp.test` would
  // coerce it (so denyPatterns half-work), but `.match`/`.startsWith` on the
  // allow path throw a TypeError mid-eval. Deny it outright rather than letting
  // behaviour depend on which rules happen to be configured. (Absent → "".)
  if (rawCmd != null && typeof rawCmd !== "string") {
    return { outcome: "deny", severity: "action", rule: "bash.invalidCmd", reason: `command is not a string (type ${typeof rawCmd})` };
  }
  const cmd = rawCmd ?? "";

  // `cfg` is held by reference and can be swapped post-construction; a deny/
  // scope rule the gate cannot evaluate must fail CLOSED, not throw mid-eval
  // (`for...of`/`.some` on a non-array) or silently no-op. Same class, same
  // fix shape, as `tools.denylist`/`fs.deny`/`content.denyPatterns`/etc.
  if (cfg.denyPatterns !== undefined && cfg.denyPatterns !== null) {
    if (!Array.isArray(cfg.denyPatterns)) {
      return { outcome: "deny", severity: "action", rule: "bash.denyPatterns.invalid", reason: `bash.denyPatterns is not an array (type ${typeof cfg.denyPatterns})` };
    }
    const badIdx = findInvalidIndex(cfg.denyPatterns, "regexp");
    if (badIdx !== -1) {
      return { outcome: "deny", severity: "action", rule: "bash.denyPatterns.invalid", reason: `bash.denyPatterns[${badIdx}] is not a RegExp (type ${typeof cfg.denyPatterns[badIdx]})` };
    }
    for (const re of cfg.denyPatterns) {
      if (re.test(cmd)) {
        return { outcome: "deny", severity: "action", rule: "bash.denyPatterns", reason: `matches ${re}` };
      }
    }
  }

  if (cfg.allow !== undefined && cfg.allow !== null) {
    if (!Array.isArray(cfg.allow)) {
      return { outcome: "deny", severity: "action", rule: "bash.allow.invalid", reason: `bash.allow is not an array (type ${typeof cfg.allow})` };
    }
    const meta = cmd.match(SHELL_META);
    if (meta) {
      return {
        outcome: "deny", severity: "action", rule: "bash.allow.shellMeta",
        reason: `command contains shell metacharacter ${JSON.stringify(meta[0])}; bash.allow is prefix-only`,
      };
    }
    // `cfg` is held by reference (TOCTOU, same class as the denyPatterns
    // guard above): construct time (assertArrayShapedConfig, gate.js) already
    // throws on a blank/whitespace-only bash.allow element, but a direct
    // primitive call or a post-construction `cfg` swap bypasses that. Fail
    // CLOSED here too, reusing the `bash.allow.invalid` rule the shape guard
    // above uses — a blank entry is a config error, not a wildcard (0.19.1;
    // `cmd.startsWith("")` used to be true for every command, so a blank
    // entry silently disabled the whole allowlist).
    const blankIdx = findBlankStringIndex(cfg.allow);
    if (blankIdx !== -1) {
      return {
        outcome: "deny", severity: "action", rule: "bash.allow.invalid",
        reason: `bash.allow[${blankIdx}] is empty or whitespace-only, not a valid command prefix`,
      };
    }
    // A prefix match must land on a word boundary: "git status" must not
    // admit "git statuses-are-fine --evil" just because the raw bytes match.
    // A prefix matches when: the command equals it exactly; OR the command
    // continues with the prefix followed by a boundary char (the boundary
    // can live in either string — a prefix already authored with a trailing
    // space, e.g. "git ", already carries its own boundary, so a plain
    // startsWith is correct there and needs no extra char check).
    // The boundary is ASCII space/tab only, not `\s` (which also matches
    // Unicode whitespace like U+00A0 NBSP, U+2000 en quad, etc.) — the shell
    // only splits words on space and tab; newline/CR are already denied
    // upstream by SHELL_META. Using `\s` here would let a Unicode-whitespace
    // byte between a real prefix and unrelated text sneak past the boundary
    // check (`allow: ["ls"]` must not admit "ls /etc"). A blank/whitespace-
    // only prefix can't reach this point — it's already denied above.
    const BOUNDARY = /[ \t]/;
    const allowed = cfg.allow.some(prefix => {
      if (!cmd.startsWith(prefix)) return false;
      if (cmd.length === prefix.length) return true; // exact match
      if (BOUNDARY.test(prefix[prefix.length - 1])) return true; // boundary already baked into the prefix
      return BOUNDARY.test(cmd[prefix.length]); // next char after the prefix must be a space or tab
    });
    if (!allowed) {
      return { outcome: "deny", severity: "action", rule: "bash.allow", reason: "command not in bash.allow" };
    }
  }

  return null;
}
