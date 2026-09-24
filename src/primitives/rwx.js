// rwx primitive (PRD §23) — operator-tagged capability letters for agent
// fleets. A second, MUTUALLY EXCLUSIVE mode of control beside the closed
// `tools.allowlist` / `bash.allow`: the operator tags every tool and every
// bash command with one letter (r/w/x), gives every agent a three-letter
// ceiling, and the gate hands an agent only what its letters cover. Runs at
// step 5 (the eval-order slot `tools.allowlist` occupies in allowlist mode) —
// `gate.js` picks exactly one of the two, never both (§23.2).
//
// Config shape (the PARSED object — bareguard never loads a file, §23.13
// decision 4):
//   rwx: {
//     agent:  "fixer",                                   // this gate's agent name
//     agents: { researcher: "r--", fixer: "rw-", deployer: "rwx" },
//     tools:  { read: "r", write: "w", deploy: { letter: "x", marker: "loose" } },
//     bash:   { ls: "r", "git status": "r", "git commit": "w", "git push": "x" },
//     letters: "rw-",  // optional: explicit override (a spawned child's
//                      // clamped grant), carried on the same channel as
//                      // spawnDepth (config field, falls back to
//                      // BAREGUARD_RWX_LETTERS) — skips the `agents` lookup.
//     askOn:  "none",  // optional (default "none"): "loose" asks (via
//                      // humanChannel) before allowing an action whose
//                      // matched entry carries marker:"loose" — the letter
//                      // is still required; a missing letter still denies.
//   }
//
// A `tools`/`bash` map ENTRY (D103, settled with the rwxmap project,
// 2026-09-24) is EITHER a bare letter string — `"w"` — the unchanged,
// forever-legal, HUMAN-WRITTEN form that never asks, OR a marker-carrying
// object — `{ letter: "w", marker: "loose" }` — the shape rwxmap's offline
// exporter can emit. `marker` is exactly `"tight"|"loose"|"settled"`; any
// other key on the object is ignored (rwxmap's `evidence` field never enters
// this file, same boundary as §23.12's `destructive`). The marker can only
// TIGHTEN: it never grants a letter, never skips a `rwx.denied`, never
// upgrades an ask into an allow or a deny into anything softer.

/**
 * True for a plain object — `{}`-literal shaped, or the null-prototype shape
 * `safeAction()` produces gate-wide. Duplicated from `gate.js` (not imported)
 * to avoid a primitives→gate circular import; identical logic, same reasoning
 * (a `Map`/`Set`/`Date` must not silently read as "unconfigured").
 * @param {*} v value to check
 * @returns {boolean}
 */
function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Bound a caller-supplied config key before it is interpolated into an error
 * message or a deny reason (both are unbounded downstream). Duplicated from
 * `gate.js`'s `clipKey` for the same reason as `isPlainObject` above.
 * @param {*} k
 * @returns {string}
 */
function clipKey(k) {
  const s = String(k);
  return s.length > 64 ? s.slice(0, 64) + "…" : s;
}

const AGENT_LETTERS_RE = /^[r-][w-][x-]$/;
const TOOL_LETTER_RE = /^[rwx]$/;

/**
 * The closed marker vocabulary (D103) — exactly three values, NOT "strict".
 * `tight`/`settled` never ask; `loose` asks under `rwx.askOn:"loose"`.
 * @type {ReadonlySet<string>}
 */
const MARKERS = new Set(["tight", "loose", "settled"]);

/**
 * Normalize a `tools`/`bash` map ENTRY into its letter + marker (D103). A
 * bare string is the human-written form — no marker, never asks. A plain
 * object carries `letter` (required, one of r/w/x) and an optional
 * `marker`; every other object key is ignored, so rwxmap's `evidence` field
 * never enters this file. A missing or unrecognized `marker` string
 * normalizes to `"loose"` — typo-safety: it asks (under `askOn:"loose"`)
 * rather than silently sailing through as if it were `tight`/`settled`.
 * Returns `null` for a malformed entry — missing/non-string `letter`,
 * `letter` not one of r/w/x, or a value that is neither a string nor a
 * plain object — which the caller turns into a fail-closed `rwx.invalid`
 * deny (never a throw at read time; the construct-time throw in
 * {@link assertRwxConfig} is the earlier, non-TOCTOU catch of the same
 * shape error).
 * @param {*} v raw map value
 * @returns {{letter:string, marker:(string|null)}|null}
 */
function normalizeEntry(v) {
  if (typeof v === "string") {
    return TOOL_LETTER_RE.test(v) ? { letter: v, marker: null } : null;
  }
  if (isPlainObject(v)) {
    const letter = v.letter;
    if (typeof letter !== "string" || !TOOL_LETTER_RE.test(letter)) return null;
    const marker = MARKERS.has(v.marker) ? v.marker : "loose";
    return { letter, marker };
  }
  return null;
}

/**
 * Shell-control metacharacters that chain, substitute, or redirect a bash
 * command onto more than one program — the settled joined-command list
 * (§23.6/§23.14): `;` `&` `|` `$` `` ` `` `(` `)` newline `\` continuation,
 * AND redirects (`>` `>>` `<`, including fd forms). A leading-word prefix
 * allowlist can't bound what runs after any of these, so their presence
 * (outside a quoted span, see {@link hasJoinMeta}) makes a command
 * unmatchable except by an exact, verbatim listing.
 * @type {RegExp}
 */
const OUTSIDE_META = /[;&|$`()\n\r\\<>]/;

/**
 * Quote-aware scan for {@link OUTSIDE_META} metacharacters (§23.13 decision
 * 1): a naive whole-string regex test denies `git commit -m "fix (typo)"`
 * because `(` `)` sit inside a quoted string that is not chaining anything.
 * This walks the command tracking quote state instead of testing the whole
 * string at once:
 *   - **single-quoted** spans are fully literal — nothing inside one (not
 *     even a backslash) is dangerous, and the span ends only at the next `'`.
 *   - **double-quoted** spans are literal EXCEPT `$` and `` ` `` — bash still
 *     expands `$VAR`/`$(...)`/backticks inside double quotes, so those still
 *     count as dangerous. A backslash inside a double-quoted span escapes the
 *     next character (so `\"` does not close the span and `\$`/`` \` ``
 *     don't count as expansion) — this also prevents an escaped quote from
 *     desynchronizing the scanner's quote-tracking.
 *   - **outside quotes**, the full {@link OUTSIDE_META} set is dangerous,
 *     including a bare backslash (a `\`-newline line continuation joins two
 *     commands, so it is a hard stop here, not a per-char escape — this
 *     matches the POC's validated behaviour, not the shell's own escaping
 *     rules, and is the more conservative of the two).
 *   - an **unterminated** quote (single OR double) at end-of-string is
 *     treated as dangerous — a malformed/adversarial-looking command fails
 *     closed rather than being silently parsed as "safe so far".
 *
 * No backtracking is possible: this is a linear single pass over the string
 * (one `RegExp#test` per character against a character-class-only pattern,
 * O(1) each), not a whole-string regex — re-timed adversarially in
 * `test/rwx-quotes.test.js` per this module's ReDoS-history antigen.
 * @param {string} cmd
 * @returns {boolean} true if a live (unquoted, or double-quoted `$`/backtick) metacharacter is present
 */
export function hasJoinMeta(cmd) {
  let state = "none"; // "none" | "single" | "double"
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (state === "none") {
      if (c === "'") { state = "single"; continue; }
      if (c === '"') { state = "double"; continue; }
      if (OUTSIDE_META.test(c)) return true;
      continue;
    }
    if (state === "single") {
      if (c === "'") state = "none";
      continue; // everything else is fully literal, including backslash
    }
    // state === "double"
    if (c === "\\") { i++; continue; } // escape: skip the next char entirely
    if (c === '"') { state = "none"; continue; }
    if (c === "$" || c === "`") return true;
    // else: literal inside a double-quoted span (incl. `;` `&` `|` `(` `)` `<` `>`)
  }
  return state !== "none"; // unterminated quote — fail closed
}

/**
 * Rule (§23.6): match a bash command's LEADING WORD(S) against the rwx bash
 * map, longest listed prefix wins, word-boundary aware (`"ls"` never matches
 * `"lsblk"` — the prefix must be followed by end-of-string or a space). A
 * joined/chained command ({@link hasJoinMeta}) is denied unless the WHOLE
 * string is listed verbatim.
 * A matched entry is normalized via {@link normalizeEntry}: `letter` is
 * `null` unless the raw value is a valid bare-letter string OR a valid
 * `{letter, marker}` object — a MALFORMED matched entry (e.g. an object with
 * no/bad `letter`) reports back its RAW value as `letter` (so the caller's
 * own type check turns it into an `rwx.invalid` deny with a useful "got
 * ..." message) with `marker: null`. `marker` is the entry's normalized
 * marker (`"tight"|"loose"|"settled"`), or `null` for a bare-string entry
 * (never asks) or an unmatched command.
 * @param {string} cmd
 * @param {Object<string,*>} bashMap
 * @returns {{ok:boolean, letter:(string|null), marker:(string|null), matchedKey:(string|null), joined:boolean}}
 */
export function matchBash(cmd, bashMap) {
  const map = isPlainObject(bashMap) ? bashMap : {};
  const entryFor = (raw, key) => {
    const norm = normalizeEntry(raw);
    return norm
      ? { ok: true, letter: norm.letter, marker: norm.marker, matchedKey: key, joined: false }
      : { ok: true, letter: raw, marker: null, matchedKey: key, joined: false };
  };
  if (hasJoinMeta(cmd)) {
    if (Object.prototype.hasOwnProperty.call(map, cmd)) return entryFor(map[cmd], cmd);
    return { ok: false, letter: null, marker: null, matchedKey: null, joined: true };
  }
  let best = null;
  for (const key of Object.keys(map)) {
    if (cmd === key || cmd.startsWith(key + " ")) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  if (best !== null) return entryFor(map[best], best);
  return { ok: false, letter: null, marker: null, matchedKey: null, joined: false };
}

/**
 * Runtime (TOCTOU) shape backstop — `cfg` is held by reference by `Gate`, so a
 * caller can swap the whole `rwx` value, or one of its three maps, out after
 * construction validated it. Mirrors the `<key>.invalid` fail-closed family
 * (`tools.allowlist.invalid`, `bash.allow.invalid`, …): a rule the gate
 * cannot evaluate must fail CLOSED, not silently no-op or throw mid-`check()`.
 * @param {*} rwxCfg
 * @returns {string|null} a reason string, or null if the shape is usable
 */
function rwxRuntimeShapeError(rwxCfg) {
  if (!isPlainObject(rwxCfg)) {
    return `rwx is not a plain object (type ${Array.isArray(rwxCfg) ? "array" : typeof rwxCfg})`;
  }
  for (const section of ["tools", "bash", "agents"]) {
    const m = rwxCfg[section];
    if (m === undefined || m === null) continue;
    if (!isPlainObject(m)) {
      return `rwx.${section} is not a plain object (type ${Array.isArray(m) ? "array" : typeof m})`;
    }
  }
  return null;
}

/**
 * Resolve this gate's own letters. Explicit `rwx.letters` (or the
 * `BAREGUARD_RWX_LETTERS` env var equivalent — the same channel `spawnDepth`
 * travels on, §23.13 decision 2) wins when present: this is how a spawned
 * child receives its parent-clamped grant without an `agents` lookup.
 * Otherwise `rwx.agent` is looked up in `rwx.agents`; an unlisted (or
 * unnamed) agent resolves to `"---"` — it starts, but every action denies
 * (§23.4). Read fresh on every call (never cached) — same TOCTOU posture as
 * every other config read in this file.
 * @param {object} rwxCfg already shape-checked by {@link rwxRuntimeShapeError}
 * @returns {{letters:string, agentName:string, unlisted:boolean, shapeError:(string|null)}}
 */
export function resolveAgentLetters(rwxCfg) {
  const envLetters = typeof process !== "undefined" && process.env ? process.env.BAREGUARD_RWX_LETTERS : undefined;
  const explicit = rwxCfg.letters ?? envLetters ?? null;
  if (explicit != null) {
    const agentName = typeof rwxCfg.agent === "string" ? rwxCfg.agent : "(spawned child)";
    if (typeof explicit !== "string" || !AGENT_LETTERS_RE.test(explicit)) {
      return {
        letters: "---", agentName, unlisted: false,
        shapeError: `rwx.letters is not a valid letters string (got ${JSON.stringify(explicit)})`,
      };
    }
    return { letters: explicit, agentName, unlisted: false, shapeError: null };
  }
  const agentName = rwxCfg.agent;
  const agentsMap = isPlainObject(rwxCfg.agents) ? rwxCfg.agents : {};
  if (typeof agentName !== "string" || !Object.prototype.hasOwnProperty.call(agentsMap, agentName)) {
    return { letters: "---", agentName: typeof agentName === "string" ? agentName : "(unnamed)", unlisted: true, shapeError: null };
  }
  const letters = agentsMap[agentName];
  if (typeof letters !== "string" || !AGENT_LETTERS_RE.test(letters)) {
    return {
      letters: "---", agentName, unlisted: false,
      shapeError: `rwx.agents.${clipKey(agentName)} is not a valid letters string (got ${JSON.stringify(letters)})`,
    };
  }
  return { letters, agentName, unlisted: false, shapeError: null };
}

/**
 * Delegation clamp (§23.9): attenuate ONLY — a child's letters are
 * `min(what the parent requested for it, what the parent holds)` per letter,
 * so a child can never outgrow its parent. `spawn` gets no letter of its own
 * (rejected: `spawn` = `x`); this is pure attenuation of the THREE letters.
 * Runs in the PARENT's gate at spawn time (`Gate#clampRwxLetters`); a child
 * never verifies its own letters.
 * @param {string} parentLetters this gate's own resolved letters
 * @param {string} [requestedLetters] letters the child is being asked to hold; default `"rwx"` (ask for everything — the clamp does the rest)
 * @returns {string} the clamped 3-char letters string, never wider than `parentLetters`
 */
export function clampLetters(parentLetters, requestedLetters = "rwx") {
  const p = typeof parentLetters === "string" ? parentLetters : "";
  const r = typeof requestedLetters === "string" ? requestedLetters : "";
  return "rwx".split("").map((ch) => (p.includes(ch) && r.includes(ch) ? ch : "-")).join("");
}

/**
 * Pure letter lookup for a tool/bash action against the rwx maps ONLY (no
 * agent-grant check, no deny/allow decision) — used by `gate.record()` to
 * accrue the letter count itself into `budget.resources` (§23.10: "the gate
 * accrues the letter count itself in rwx mode instead of relying on the
 * caller's `result.counts`"). Never throws.
 * @param {object} action
 * @param {*} rwxCfg
 * @returns {string|null} the matched single letter, or null if unmatched/unusable
 */
export function matchRwxLetter(action, rwxCfg) {
  if (!isPlainObject(rwxCfg) || action == null || typeof action !== "object") return null;
  if (action.type === "bash") {
    const cmd = action.cmd ?? action.args?.cmd ?? action.args?.command;
    if (typeof cmd !== "string") return null;
    const m = matchBash(cmd, rwxCfg.bash);
    return (m.ok && typeof m.letter === "string" && TOOL_LETTER_RE.test(m.letter)) ? m.letter : null;
  }
  const toolsMap = isPlainObject(rwxCfg.tools) ? rwxCfg.tools : {};
  const norm = normalizeEntry(toolsMap[action.type]);
  return norm ? norm.letter : null;
}

/**
 * Step-5 rwx decision (§23.4/§23.5/§23.6) — runs in place of
 * `tools.allowlist` when `rwx` config is present (mutually exclusive,
 * enforced at construct time by {@link assertRwxConfig}). Deny by absence,
 * loudly: an unlisted tool, unlisted command, or unlisted agent denies
 * (never asks, never guesses); a listed-but-insufficient letter denies too.
 * Attaches `rwxLetters` (the agent's full grant) and, once a specific
 * tool/command has been matched, `rwxLetter` (the letter that matched) and,
 * for an object-form entry, `rwxMarker` (its normalized `tight`/`loose`/
 * `settled` marker) onto the decision — `gate.js` reads these onto the
 * audit line. When `rwx.askOn:"loose"` is set (D103) and the matched
 * entry's marker is `"loose"`, an otherwise-allowed action resolves to
 * `askHuman` instead — the marker only ever TIGHTENS: it never grants a
 * letter a `rwx.denied` would still deny, and it never turns a deny into an
 * allow or an ask.
 * @param {object} action action being evaluated
 * @param {*} rwxCfg `cfg.rwx` — the caller's rwx config object
 * @returns {{outcome:string,severity:string,rule:string,reason:(string|null),rwxLetters?:string,rwxLetter?:string,rwxMarker?:string}} a terminal allow/deny/askHuman decision (never null); `check()` resolves `askHuman` via `humanChannel` as usual
 */
export function rwxCheck(action, rwxCfg) {
  const shapeErr = rwxRuntimeShapeError(rwxCfg);
  if (shapeErr) {
    return { outcome: "deny", severity: "action", rule: "rwx.invalid", reason: shapeErr };
  }

  const resolved = resolveAgentLetters(rwxCfg);
  if (resolved.shapeError) {
    return { outcome: "deny", severity: "action", rule: "rwx.invalid", reason: resolved.shapeError };
  }
  const { letters, agentName, unlisted } = resolved;

  if (unlisted) {
    return {
      outcome: "deny", severity: "action", rule: "rwx.unlisted",
      reason: `agent "${clipKey(agentName)}" is not in the rwx agents map — it holds "---"`,
      rwxLetters: letters,
    };
  }

  // askOn (D103): "none" (default) is byte-identical to pre-D103 behavior;
  // "loose" asks (never denies, never auto-allows past a missing letter)
  // when the MATCHED entry's normalized marker is "loose". Validated at
  // construct time ({@link assertRwxConfig}); an unusable value read here
  // (TOCTOU) falls back to "none" — the strictly-narrower, byte-identical
  // behavior — rather than failing the whole check closed over an ask-only knob.
  const askOn = rwxCfg.askOn === "loose" ? "loose" : "none";

  if (action?.type === "bash") {
    const rawCmd = action.cmd ?? action.args?.cmd ?? action.args?.command;
    if (rawCmd != null && typeof rawCmd !== "string") {
      return {
        outcome: "deny", severity: "action", rule: "rwx.invalid",
        reason: `command is not a string (type ${typeof rawCmd})`,
        rwxLetters: letters,
      };
    }
    const cmd = rawCmd ?? "";
    const m = matchBash(cmd, rwxCfg.bash);
    if (m.joined) {
      return {
        outcome: "deny", severity: "action", rule: "rwx.joined",
        reason: `"${clipKey(cmd)}" contains a joined/chained shell construct and is not listed verbatim in the rwx bash map`,
        rwxLetters: letters,
      };
    }
    if (!m.ok) {
      return {
        outcome: "deny", severity: "action", rule: "rwx.unlisted",
        reason: `"${clipKey(cmd)}" is not in the rwx bash map — add it as r, w or x`,
        rwxLetters: letters,
      };
    }
    if (typeof m.letter !== "string" || !TOOL_LETTER_RE.test(m.letter)) {
      return {
        outcome: "deny", severity: "action", rule: "rwx.invalid",
        reason: `rwx.bash.${clipKey(m.matchedKey)} is not a valid letter (got ${JSON.stringify(m.letter)})`,
        rwxLetters: letters,
      };
    }
    if (!letters.includes(m.letter)) {
      return {
        outcome: "deny", severity: "action", rule: "rwx.denied",
        reason: `"${clipKey(cmd)}" is tagged "${m.letter}" but agent "${clipKey(agentName)}" only holds "${letters}"`,
        rwxLetters: letters, rwxLetter: m.letter,
        ...(m.marker ? { rwxMarker: m.marker } : {}),
      };
    }
    if (askOn === "loose" && m.marker === "loose") {
      return {
        outcome: "askHuman", severity: "action", rule: "rwx.ask",
        reason: `"${clipKey(cmd)}" is tagged "${m.letter}" with marker "loose" — rwx.askOn:"loose" asks before allowing (letter is held)`,
        rwxLetters: letters, rwxLetter: m.letter, rwxMarker: m.marker,
      };
    }
    return {
      outcome: "allow", severity: "action", rule: "rwx.allow", reason: null,
      rwxLetters: letters, rwxLetter: m.letter,
      ...(m.marker ? { rwxMarker: m.marker } : {}),
    };
  }

  const toolsMap = isPlainObject(rwxCfg.tools) ? rwxCfg.tools : {};
  const rawEntry = toolsMap[action?.type];
  if (rawEntry === undefined) {
    return {
      outcome: "deny", severity: "action", rule: "rwx.unlisted",
      reason: `"${clipKey(action?.type)}" is not in the rwx tools map — add it as r, w or x`,
      rwxLetters: letters,
    };
  }
  const normTool = normalizeEntry(rawEntry);
  const letter = normTool ? normTool.letter : rawEntry;
  const marker = normTool ? normTool.marker : null;
  if (typeof letter !== "string" || !TOOL_LETTER_RE.test(letter)) {
    return {
      outcome: "deny", severity: "action", rule: "rwx.invalid",
      reason: `rwx.tools.${clipKey(action?.type)} is not a valid letter (got ${JSON.stringify(letter)})`,
      rwxLetters: letters,
    };
  }
  if (!letters.includes(letter)) {
    return {
      outcome: "deny", severity: "action", rule: "rwx.denied",
      reason: `"${clipKey(action?.type)}" is tagged "${letter}" but agent "${clipKey(agentName)}" only holds "${letters}"`,
      rwxLetters: letters, rwxLetter: letter,
      ...(marker ? { rwxMarker: marker } : {}),
    };
  }
  if (askOn === "loose" && marker === "loose") {
    return {
      outcome: "askHuman", severity: "action", rule: "rwx.ask",
      reason: `"${clipKey(action?.type)}" is tagged "${letter}" with marker "loose" — rwx.askOn:"loose" asks before allowing (letter is held)`,
      rwxLetters: letters, rwxLetter: letter, rwxMarker: marker,
    };
  }
  return {
    outcome: "allow", severity: "action", rule: "rwx.allow", reason: null,
    rwxLetters: letters, rwxLetter: letter,
    ...(marker ? { rwxMarker: marker } : {}),
  };
}

/**
 * Construct-time validation (§23.2/§23.3/§23.8) — throws, same family as
 * `assertArrayShapedConfig`:
 *   - `rwx` present but not a plain object, or one of its three maps not a
 *     plain object;
 *   - a `tools`/`bash` map value that is neither exactly `"r"`/`"w"`/`"x"`
 *     NOR a plain object `{ letter: "r"|"w"|"x", marker?: "tight"|"loose"|
 *     "settled" }` (D103) — a missing/non-string `letter`, a `letter` not
 *     one of r/w/x, or a value that is neither a string nor a plain object
 *     all count as malformed here; an unrecognized/missing `marker` on an
 *     otherwise-valid object is NOT a construct-time error (it normalizes
 *     to `"loose"` at read time, §{@link normalizeEntry});
 *   - an `agents` map value (or `rwx.letters`) that is not a 3-char
 *     `[r-][w-][x-]` string;
 *   - `rwx.askOn` present but not exactly `"none"` or `"loose"` (D103);
 *   - `rwx` configured TOGETHER WITH `tools.allowlist` / `bash.allow` /
 *     `bash.denyPatterns` — the two modes are mutually exclusive (§23.2), so
 *     nobody is left guessing which is in charge;
 *   - `bash.classify: true` in rwx mode (§23.8) — it belongs to allowlist
 *     mode only; setting it in rwx mode would look like protection without
 *     being any.
 * @param {object} config full gate config
 * @returns {void}
 */
export function assertRwxConfig(config) {
  const rwxCfg = config?.rwx;
  if (rwxCfg === undefined || rwxCfg === null) return;

  if (!isPlainObject(rwxCfg)) {
    throw new Error(
      `invalid bareguard config: rwx must be a plain object, got ${Array.isArray(rwxCfg) ? "array" : typeof rwxCfg}`,
    );
  }

  const conflicts = [];
  if (config.tools?.allowlist !== undefined && config.tools.allowlist !== null) conflicts.push("tools.allowlist");
  if (config.bash?.allow !== undefined && config.bash.allow !== null) conflicts.push("bash.allow");
  if (config.bash?.denyPatterns !== undefined && config.bash.denyPatterns !== null) conflicts.push("bash.denyPatterns");
  if (conflicts.length > 0) {
    throw new Error(
      `invalid bareguard config: rwx is mutually exclusive with ${conflicts.join(", ")} — two modes doing the same job; pick one (§23.2)`,
    );
  }
  if (config.bash?.classify === true) {
    throw new Error(
      `invalid bareguard config: bash.classify is not usable together with rwx — it belongs to allowlist mode only (§23.8)`,
    );
  }

  for (const section of ["tools", "bash", "agents"]) {
    const m = rwxCfg[section];
    if (m === undefined || m === null) continue;
    if (!isPlainObject(m)) {
      throw new Error(
        `invalid bareguard config: rwx.${section} must be a plain object, got ${Array.isArray(m) ? "array" : typeof m}`,
      );
    }
    if (section === "agents") {
      for (const [k, v] of Object.entries(m)) {
        if (typeof v !== "string" || !AGENT_LETTERS_RE.test(v)) {
          throw new Error(
            `invalid bareguard config: rwx.agents.${clipKey(k)} must be a 3-char letters string like "rw-", got ${JSON.stringify(v)}`,
          );
        }
      }
      continue;
    }
    // tools / bash (D103): a bare letter string, or a marker-carrying object
    // `{ letter: "r"|"w"|"x", marker?: "tight"|"loose"|"settled" }` — any
    // other object key is ignored. `normalizeEntry` returning null is the
    // one construct-time shape error for this section.
    for (const [k, v] of Object.entries(m)) {
      if (!normalizeEntry(v)) {
        throw new Error(
          `invalid bareguard config: rwx.${section}.${clipKey(k)} must be "r"/"w"/"x" or { letter: "r"|"w"|"x", marker?: "tight"|"loose"|"settled" }, got ${JSON.stringify(v)}`,
        );
      }
    }
  }

  if (rwxCfg.letters !== undefined && rwxCfg.letters !== null) {
    if (typeof rwxCfg.letters !== "string" || !AGENT_LETTERS_RE.test(rwxCfg.letters)) {
      throw new Error(
        `invalid bareguard config: rwx.letters must be a 3-char letters string like "rw-", got ${JSON.stringify(rwxCfg.letters)}`,
      );
    }
  }
  if (rwxCfg.agent !== undefined && rwxCfg.agent !== null && typeof rwxCfg.agent !== "string") {
    throw new Error(`invalid bareguard config: rwx.agent must be a string, got ${typeof rwxCfg.agent}`);
  }
  if (rwxCfg.askOn !== undefined && rwxCfg.askOn !== null) {
    if (rwxCfg.askOn !== "none" && rwxCfg.askOn !== "loose") {
      throw new Error(
        `invalid bareguard config: rwx.askOn must be "none" or "loose", got ${JSON.stringify(rwxCfg.askOn)}`,
      );
    }
  }
}
