// command-severity classification (PRD harness §7.1, multis-driven). Owns the
// MECHANISM (classify a bash command into a tier) + a best-effort, full
// cross-platform pattern list. The consumer owns the ceremony.
//
// HONEST SCOPE: best-effort pattern matching, defense-in-depth — DEFEATABLE by
// obfuscation (base64 -d | sh, renamed binaries, novel subcommands). This is UX
// tiering, NOT a sandbox and NOT enforcement: the fs/exec scope stays the hard
// boundary, and `tier` is never a security guarantee. It is a speed bump + an
// HITL trigger. The list is maintained here on a best-effort basis; PRs welcome.
//
// Tiers:
//   safe              — runs (no match).
//   destructive       — loss of a NAMED target (rm <path>, mv over, chmod, kill,
//                       sudo, git push --force, DROP/TRUNCATE/DELETE FROM, …).
//   super_destructive — machine / irrecoverable (rm -rf / ~ /*; dd of=/dev/*;
//                       mkfs/wipefs; fork bomb; shutdown/reboot; curl | sh;
//                       diskutil eraseDisk; format C:; reg delete HKLM; …).
//
// Patterns are authored WITHOUT the /g flag on purpose: `RegExp.test` is called
// repeatedly across a shared array, and /g makes `.test` stateful via lastIndex.

const TIER_NUM = { safe: 1, destructive: 2, super_destructive: 3 };

// Path predicate for a super-destructive `rm` target — the location half only;
// it is AND-ed with an `rm -rf` anchor below (so `ls /etc` is never super, only
// `rm -rf /etc` is). Matches, in order of specificity:
//   • a system root OR ANY descendant  (`/etc`, `/usr/local/bin`, `/boot/…`) —
//     no legitimate through-a-bot recursive delete lives under these;
//   • a home/mount root or EXACTLY ONE level below it (`/home`, `/home/alice`,
//     `/var`, `/Users/bob`) — a whole account/mount, but NOT a deeper nested
//     path: `[^\/…]+` can't cross a `/`, so `rm -rf /home/alice/project/build`
//     and `rm -rf /var/tmp/x` fall through to tier 2 (a routine build-clean can
//     never become un-runnable) — the crux invariant of BG-1;
//   • `~`, `$HOME`, `${HOME}`, plus single/double-quoted forms of any of these;
//   • the bare filesystem root `/` (or `/*`).
// No nested unbounded quantifier over overlapping classes → linear, no ReDoS.
const SUPER_RM_TARGET =
  '(?:["\']?)' + // optional opening quote (`rm -rf "$HOME"`)
  "(?:" +
  '\\/(?:etc|usr|bin|sbin|lib64|lib|boot|sys|proc|dev|root)(?:\\/[^\\s"\']*)?' + // system root + any descendant
  '|\\/(?:var|opt|srv|mnt|media|home|Users)(?:\\/[^\\/\\s"\']+)?' + // home/mount root or exactly one level
  "|~\\/?" + // ~ or ~/
  "|\\$\\{?HOME\\}?" + // $HOME or ${HOME}
  "|\\/" + // bare /
  ")" +
  '(?:["\']?)(?:\\s|\\*|$)'; // optional closing quote, then a token boundary

// The two ReDoS-safe `rm -rf` anchors (combined `-rf` / split `-r -f`) share the
// target predicate above via composition so BG-1's location list stays DRY. The
// flag-detection prefixes are byte-identical to the audited originals; r and f
// are tested with non-consuming LOOKAHEADS (`(?=[a-z]*r)(?=[a-z]*f)`), never a
// sequence of consuming `[a-z]*r[a-z]*f[a-z]*` stars (which redistributes a long
// flagless run across three quantifiers on a failing tail → catastrophic
// backtracking). Lookaheads each scan once and don't backtrack.
const SUPER_RM_COMBINED = new RegExp(
  "\\brm\\s+(?:-\\S+\\s+)*-(?=[a-zA-Z]*r)(?=[a-zA-Z]*f)[a-zA-Z]+\\s+(?:-\\S+\\s+)*" +
    SUPER_RM_TARGET,
  "i",
);
// split flags: `rm -r -f /` (≥2 flag tokens then a root target). Linear — each
// `-[a-zA-Z]+\s+` is bounded by a required `-` and `\s+`.
const SUPER_RM_SPLIT = new RegExp(
  "\\brm\\s+(?:-[a-zA-Z]+\\s+){2,}" + SUPER_RM_TARGET,
  "i",
);

/**
 * Super-destructive (tier 3): machine / irrecoverable. Keyed by platform; the
 * `common` set applies everywhere and is merged with the active platform's set.
 * @type {{ common: RegExp[], linux: RegExp[], darwin: RegExp[], win32: RegExp[] }}
 */
export const SUPER_DESTRUCTIVE_PATTERNS = {
  common: [
    // `rm -rf` of a filesystem/system/home root — see SUPER_RM_TARGET (BG-1).
    SUPER_RM_COMBINED,
    SUPER_RM_SPLIT,
    /--no-preserve-root\b/i,
    // dd writing to a raw block device.
    /\bdd\b[^\n]*\bof=\/dev\/(?:disk|rdisk|sd|nvme|hd|mmcblk|vd)/i,
    // redirect into a raw block device.
    />\s*\/dev\/(?:disk|rdisk|sd|nvme|hd|mmcblk|vd)/i,
    // fork bomb  :(){ :|:& };:
    /:\(\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;\s*:/,
    // pipe a network download straight into a shell/interpreter.
    /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python[0-9.]*|perl|ruby|node)\b/i,
    // power-state changes (recoverable, but machine-level — ask).
    /\b(?:shutdown|reboot|halt|poweroff)\b/i,
    /\binit\s+[06]\b/,
  ],
  linux: [
    /\bmkfs(?:\.[a-z0-9]+)?\b/i,
    /\bwipefs\b/i,
    /\bsfdisk\b/i,
  ],
  darwin: [
    /\bdiskutil\s+(?:erase(?:Disk|Volume)|partitionDisk|reformat|secureErase)\b/i,
    /\bcsrutil\s+disable\b/i,
    /\bnvram\s+-c\b/i,
  ],
  win32: [
    /\bformat\s+(?:\/\S+\s+)*[a-z]:/i,
    /\bdiskpart\b/i,
    // Remove-Item with BOTH -Recurse and -Force (either order).
    /\bRemove-Item\b(?=[^\n]*-Recurse)(?=[^\n]*-Force)/i,
    /\breg\s+delete\s+HK(?:LM|CU|CR|U|CC)\b/i,
    /\b(?:del|erase)\b[^\n]*\s\/s\b/i,
    /\brmdir\b[^\n]*\s\/s\b/i,
    /\bshutdown\b[^\n]*\s\/[sr]\b/i,
  ],
};

/**
 * Destructive (tier 2): loss of a named target. Keyed by platform; `common`
 * merges with the active platform's set.
 * @type {{ common: RegExp[], linux: RegExp[], darwin: RegExp[], win32: RegExp[] }}
 */
export const DESTRUCTIVE_PATTERNS = {
  common: [
    /\brm\b/,
    /\bmv\b/,
    // find as a deletion/execution vector (BG-2): a `-delete` action, or
    // `-exec`/`-execdir` running an arbitrary command. `-exec(?:dir)?` matches
    // plain `-exec` too (not just `-execdir`), so `find . -exec <cmd>` is caught
    // on its own, not incidentally via a payload that happens to contain `rm`.
    // find is POSIX → common tier; win32 `find` (string search) carries neither
    // flag, so no cross-platform false positive.
    /\bfind\b[^\n]*\s-delete\b/i,
    /\bfind\b[^\n]*\s-exec(?:dir)?\b/i,
    /\b(?:chmod|chown|chgrp)\b/,
    /\b(?:kill|killall|pkill)\b/,
    /\bsudo\b/,
    /\bshred\b/,
    /\btruncate\b/,
    /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*f/,
    /\bgit\s+branch\b[^\n]*\s-D\b/,
    /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
    /\bDELETE\s+FROM\b/i,
  ],
  linux: [
    /\b(?:apt|apt-get|dnf|yum|pacman|snap|zypper)\b[^\n]*\b(?:remove|purge|erase|uninstall)\b/i,
    /\bsystemctl\s+(?:stop|disable|mask)\b/i,
  ],
  darwin: [
    /\bbrew\s+uninstall\b/i,
  ],
  win32: [
    /\bRemove-Item\b/i,
    /\b(?:del|erase)\b/i,
    /\brmdir\b/i,
    /\btaskkill\b/i,
    /\bStop-(?:Process|Service)\b/i,
  ],
};

/**
 * Inline-interpreter code payloads (BG-3) — OPT-IN, never in the default sets.
 *
 * `python3 -c "…"`, `node -e "…"`, `perl -e`, `ruby -e`, `node --eval`, `php -r`
 * can do anything a regex can't read (`shutil.rmtree('/')`, `fs.rmSync(…)`), so
 * they classify `safe` by default — and CANNOT be reliably gated, because the
 * identical action via `python3 script.py` (or a heredoc, or base64|sh) stays
 * `safe` too. This is the module's HONEST SCOPE boundary made explicit rather
 * than silent: inline interpreter code is out of scope for the default floor;
 * the hard boundary stays fs/exec scoping, not command text.
 *
 * A consumer that nonetheless wants a coarse HITL speed-bump on inline code
 * (e.g. a governed bot that rarely runs `-c`/`-e` at all) opts in:
 *   `classifyCommand(cmd, { extraDestructive: INTERPRETER_PATTERNS })`
 * bareguard owns the canonical pattern shape (Principle 8); the array is frozen
 * so it is read-only introspection, never a mutable module-global. `reclassify`
 * can still tier any specific invocation back down.
 * @type {readonly RegExp[]}
 */
export const INTERPRETER_PATTERNS = Object.freeze([
  // python -c, node -e, perl -e/-E, ruby -e
  /\b(?:python[0-9.]*|node|perl|ruby)\b[^\n]*\s-(?:c|e|E)\b/i,
  // node/deno --eval
  /\b(?:node|deno)\b[^\n]*\s--eval\b/i,
  // php inline code flag
  /\bphp\b[^\n]*\s-r\b/i,
]);

const PLATFORMS = new Set(["linux", "darwin", "win32"]);

/** @returns {"linux"|"darwin"|"win32"} the host platform, defaulting to linux. */
function currentPlatform() {
  const p = typeof process !== "undefined" ? process.platform : "linux";
  return PLATFORMS.has(p) ? /** @type {"linux"|"darwin"|"win32"} */ (p) : "linux";
}

/**
 * Classify a shell command into a severity tier. Pure and exported for unit
 * testing. Super-destructive is checked before destructive, so `sudo rm -rf /`
 * is `super_destructive`, not `destructive`.
 *
 * @param {string} command the command string
 * @param {object} [opts]
 * @param {"linux"|"darwin"|"win32"} [opts.platform]  platform hint; auto-detected
 *   from `process.platform` when omitted.
 * @param {RegExp[]} [opts.extraDestructive]       consumer tier-2 additions.
 * @param {RegExp[]} [opts.extraSuperDestructive]  consumer tier-3 additions.
 * @param {(command: string, tier: "safe"|"destructive"|"super_destructive") =>
 *   ("safe"|"destructive"|"super_destructive")} [opts.reclassify]  final override
 *   hook for app-specific commands; an invalid return is ignored.
 * @returns {"safe"|"destructive"|"super_destructive"}
 */
export function classifyCommand(command, opts = {}) {
  if (typeof command !== "string" || command.length === 0) return "safe";
  const platform = opts.platform && PLATFORMS.has(opts.platform) ? opts.platform : currentPlatform();

  const supers = [
    ...SUPER_DESTRUCTIVE_PATTERNS.common,
    ...(SUPER_DESTRUCTIVE_PATTERNS[platform] ?? []),
    ...(Array.isArray(opts.extraSuperDestructive) ? opts.extraSuperDestructive : []),
  ];
  const dests = [
    ...DESTRUCTIVE_PATTERNS.common,
    ...(DESTRUCTIVE_PATTERNS[platform] ?? []),
    ...(Array.isArray(opts.extraDestructive) ? opts.extraDestructive : []),
  ];

  /** @type {"safe"|"destructive"|"super_destructive"} */
  let tier = "safe";
  if (supers.some((re) => re.test(command))) tier = "super_destructive";
  else if (dests.some((re) => re.test(command))) tier = "destructive";

  if (typeof opts.reclassify === "function") {
    const r = opts.reclassify(command, tier);
    if (r === "safe" || r === "destructive" || r === "super_destructive") tier = r;
  }
  return tier;
}

/**
 * Step-4 (ask step) classifier for `bash` actions. No-op unless `bash.classify`
 * is on. Tiers 2–3 raise an askHuman decision carrying `classification` + `tier`;
 * the gate copies those onto the HumanEvent so the consumer's humanChannel maps
 * severity → ceremony. bareguard holds zero auth logic and never hard-denies.
 *
 * @param {object} action  action being evaluated; command read from action.cmd,
 *   action.args.cmd, or action.args.command.
 * @param {object} [cfg]  bash config (`classify`, `platform`, `extra*`, `reclassify`).
 * @returns {{outcome:string,severity:string,rule:string,reason:string,
 *   classification:string,tier:number}|null} askHuman decision, or null.
 */
export function bashClassifyCheck(action, cfg = {}) {
  if (!cfg.classify) return null;
  if (action.type !== "bash") return null;
  // Absent / non-string commands classify as "safe" → null below (and a
  // non-string cmd was already denied by bashCheck at step 3); no guard needed.
  const rawCmd = action.cmd ?? action.args?.cmd ?? action.args?.command;
  const tier = classifyCommand(rawCmd, {
    platform: cfg.platform,
    extraDestructive: cfg.extraDestructive,
    extraSuperDestructive: cfg.extraSuperDestructive,
    reclassify: cfg.reclassify,
  });
  if (tier === "safe") return null;

  return {
    outcome: "askHuman",
    severity: "action",
    rule: "bash.classify",
    reason: `command classified ${tier} (tier ${TIER_NUM[tier]})`,
    classification: tier,
    tier: TIER_NUM[tier],
  };
}
