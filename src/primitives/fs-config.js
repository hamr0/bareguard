// Single source of truth for `fs.deny` / `fs.readScope` / `fs.writeScope`
// entry validation + normalization — used at `Gate` construct time AND by
// `fsCheck` when called directly with raw config, so there is exactly one
// place that decides what a scope/deny entry means (no drift between the two
// call sites). Governing rule: nothing inferred — say it or don't; not
// saying is deny (see fs.js header).
//
// Entry rules (agreed design):
//   - absolute path: kept as-is (`path.isAbsolute()` true on this platform).
//   - "~" or "~/x": expanded ONCE via `os.homedir()`.
//   - "~user" form: refused (construct-time throw).
//   - "": refused.
//   - non-string: refused.
//   - relative ("x", "./x", "../x"): refused.
//   - "~" itself when `os.homedir()` is empty/non-absolute: refused.

import path from "node:path";
import os from "node:os";

/**
 * Normalize a single scope/deny entry. Never throws; returns a result object
 * so the caller decides whether "bad" means "throw" (construct time) or
 * "deny" (a runtime check that cannot afford to throw mid-`check()`).
 * @param {*} raw
 * @returns {{ok:true,value:string}|{ok:false,reason:string}}
 */
export function normalizeEntry(raw) {
  if (typeof raw !== "string") {
    return { ok: false, reason: `entry is not a string (type ${typeof raw}): ${describe(raw)}` };
  }
  if (raw === "") {
    return { ok: false, reason: "entry is an empty string" };
  }
  if (raw === "~") {
    const home = os.homedir();
    if (typeof home !== "string" || home === "" || !path.isAbsolute(home)) {
      return { ok: false, reason: `entry is "~" but os.homedir() is not usable (${describe(home)})` };
    }
    return { ok: true, value: home };
  }
  if (raw.startsWith("~/")) {
    const home = os.homedir();
    if (typeof home !== "string" || home === "" || !path.isAbsolute(home)) {
      return { ok: false, reason: `entry "${raw}" needs os.homedir() but it is not usable (${describe(home)})` };
    }
    return { ok: true, value: path.join(home, raw.slice(2)) };
  }
  if (raw.startsWith("~")) {
    return { ok: false, reason: `"~user" form is not supported: ${raw}` };
  }
  if (!path.isAbsolute(raw)) {
    return { ok: false, reason: `entry must be absolute, or "~"/"~/x": ${raw}` };
  }
  return { ok: true, value: raw };
}

function describe(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Validate + normalize a full `fs` config section. Throws (construct-time,
 * fail-closed) on the first bad entry anywhere in `deny`/`readScope`/
 * `writeScope`. `undefined`/`null` for a list means "not configured" (the fs
 * primitive's deny-by-default handles scopes; an unset `deny` stays "no extra
 * deny layer"). `[]` is a legal, meaningful "nothing allowed" / "no extra
 * deny" value — distinct from unset only for `deny` (unset vs `[]` behave
 * identically for `deny`; for `readScope`/`writeScope` both deny everything,
 * but with different rule names — see fs.js).
 * @param {object} [fsCfg]
 * @returns {{deny:string[],readScope:string[]|null,writeScope:string[]|null}}
 */
export function resolveFsConfig(fsCfg = {}) {
  const cfg = fsCfg ?? {};
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(`invalid bareguard config: fs must be a plain object, got ${Array.isArray(cfg) ? "array" : typeof cfg}`);
  }
  const out = { deny: [], readScope: null, writeScope: null };

  for (const key of ["deny", "readScope", "writeScope"]) {
    const list = cfg[key];
    if (list === undefined || list === null) continue; // absent — deny-by-default for scopes is fsCheck's job; `deny` stays "no extra layer"
    if (!Array.isArray(list)) {
      throw new Error(`invalid bareguard config: fs.${key} must be an array, got ${typeof list}`);
    }
    const resolved = [];
    for (let i = 0; i < list.length; i++) {
      const r = normalizeEntry(list[i]);
      if (!r.ok) {
        throw new Error(`invalid bareguard config: fs.${key}[${i}] — ${r.reason}`);
      }
      resolved.push(r.value);
    }
    out[key] = resolved;
  }
  return out;
}
