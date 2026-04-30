// net primitive (PRD §8 row 4). Runs at step 3 when action.type === "fetch".
// Domain allowlist + private-IP deny.

function isPrivateIp(host) {
  if (!host) return false;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1") return true;
  // IPv4 private ranges and loopback
  if (/^127\./.test(host)) return true;
  const m = host.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function netCheck(action, cfg = {}) {
  if (action.type !== "fetch") return null;
  const url = action.url;
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
