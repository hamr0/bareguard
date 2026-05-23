// net primitive (PRD §8 row 4). Runs at step 3 when action.type === "fetch".
// Domain allowlist + private-IP deny.

function isPrivateIp(host) {
  if (!host) return false;
  let h = host.toLowerCase();
  // URL.hostname returns IPv6 literals wrapped in brackets ("[::1]"); strip
  // them so the IPv6 matchers below actually fire. Without this every IPv6
  // branch is dead code and denyPrivateIps is a no-op for IPv6.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);

  if (h === "localhost") return true;
  // IPv6 loopback (::1) and unspecified (::, routes to localhost)
  if (h === "::1" || h === "::") return true;

  // IPv4-mapped IPv6, dotted form (::ffff:127.0.0.1) — recurse on embedded v4
  let mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  // IPv4-mapped IPv6, hex form (::ffff:7f00:1) — URL parser compresses the
  // embedded v4 to hex; decode the low 32 bits back to dotted form.
  mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  // IPv4-compatible IPv6 (deprecated, ::a.b.c.d → ::hi:lo). The whole ::/96
  // block is non-public, so decode and classify the embedded v4. Note ::1/::
  // are handled above and won't reach here (no second hextet).
  mapped = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }

  // IPv6 unique local fc00::/7 (fc__ and fd__)
  if (/^f[cd][0-9a-f]*:/.test(h)) return true;
  // IPv6 link-local fe80::/10 + deprecated site-local fec0::/10 (fe8 through fef)
  if (/^fe[89a-f][0-9a-f]*:/.test(h)) return true;

  // IPv4 ranges
  const m = h.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 0)   return true;              // 0.0.0.0/8 — incl. 0.0.0.0 (routes to localhost)
  if (a === 127) return true;              // loopback 127.0.0.0/8
  if (a === 10)  return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 — incl. cloud metadata 169.254.169.254
  return false;
}

// Accepts either flat (action.url) or nested (action.args.url) shapes so
// wireGate-style {type, args, _ctx} adapters compose without a translation
// layer. (v0.4.1, multis seam fix.)
export function netCheck(action, cfg = {}) {
  if (action.type !== "fetch") return null;
  const url = action.url ?? action.args?.url;
  if (typeof url !== "string") return null;

  let host;
  try { host = new URL(url).hostname; }
  catch { return { outcome: "deny", severity: "action", rule: "net.invalidUrl", reason: `invalid URL: ${url}` }; }

  if (cfg.denyPrivateIps && isPrivateIp(host)) {
    return { outcome: "deny", severity: "action", rule: "net.denyPrivateIps", reason: `private host: ${host}` };
  }

  if (cfg.allowDomains) {
    const allowed = cfg.allowDomains.some(d => host === d || host.endsWith("." + d));
    if (!allowed) {
      return { outcome: "deny", severity: "action", rule: "net.allowDomains", reason: `host ${host} not in allowDomains` };
    }
  }

  return null;
}

export { isPrivateIp };
