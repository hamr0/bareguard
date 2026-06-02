// E4 — hardened sandbox (closes seam-PoC caveat C1: "node:vm is not a security
// sandbox"). Replaces the in-process node:vm with a REAL isolation boundary:
//
//   1. PROCESS isolation — the agent body runs in a separate Node process, so a
//      constructor.constructor escape reaches THAT process's globals, never the
//      parent's. The gate, the real tools, and any operator secret live in the
//      parent and are physically unreachable across the boundary.
//   2. RUNTIME-ENFORCED confinement — the child is spawned with `--permission`
//      (Node 22's stable permission model). fs / child_process / worker are denied
//      at the syscall layer (ERR_ACCESS_DENIED) even WITH full `require` in hand.
//      node:vm hid symbols (bypassable); this enforces, so escape buys nothing.
//   3. CAPABILITY only via gated RPC — the child has NO tool function in scope. The
//      sole way to act is to post a tool request to the parent, which runs it
//      through bareguard's gate. The child cannot call a tool directly, cannot
//      forge an allow, cannot reach the allowlist.
//
// Remaining honest caveat: the permission model does NOT gate network egress, so
// true network confinement still needs an OS sandbox (netns / seccomp) or a
// no-egress environment. The RPC design means the body has no LEGITIMATE network
// tool regardless; any direct fetch is off-policy and out of scope for E4.

import { spawn } from "node:child_process";

// Runs INSIDE the --permission child. Builds the gated tool proxy and executes the
// agent body. There is no tool implementation here — every tools.* call is an RPC
// to the parent. `log` is also an RPC so output is ordered with tool calls.
const BOOTSTRAP = `
  const pending = new Map(); let seq = 0;
  function callTool(type, args) {
    return new Promise((resolve) => {
      const id = ++seq; pending.set(id, resolve);
      process.send({ kind: 'tool', id, type, args: args ?? {} });
    });
  }
  process.on('message', (m) => {
    if (m && m.kind === 'result') {
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m.result); }
    }
  });
  const log = (msg) => process.send({ kind: 'log', msg: String(msg) });
  // tools.NAME(args) -> gated RPC; tools.call(type, args) -> generic gated RPC.
  const tools = new Proxy({}, {
    get: (_t, name) => (a, b) => (name === 'call' ? callTool(a, b) : callTool(name, a)),
  });
  (async () => {
    let ret = null, error = null;
    try {
      const body = new Function('tools', 'log', '"use strict";\\nreturn (async () => {' + process.env.E4_BODY + '\\n})();');
      ret = await body(tools, log);
    } catch (e) { error = String((e && e.stack) || e); }
    process.send({ kind: 'done', ret, error });
  })();
`;

/**
 * Execute an agent body in the hardened sandbox.
 * @param {string} agentBody  JS statements; `tools` and `log` are in scope.
 * @param {object} opts
 * @param {(type:string, args:object) => Promise<any>} opts.onTool  the PARENT-side
 *   gated dispatcher (runs each requested action through bareguard's gate).
 * @param {(msg:string) => void} [opts.onLog]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{ret:any, error:(string|null)}>}
 */
export function runHardened(agentBody, { onTool, onLog, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--permission", "-e", BOOTSTRAP], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, E4_BODY: agentBody },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hardened sandbox timed out after " + timeoutMs + "ms"));
    }, timeoutMs);

    child.on("message", async (m) => {
      if (!m || typeof m !== "object") return;
      if (m.kind === "log") { onLog?.(m.msg); return; }
      if (m.kind === "tool") {
        let result;
        try { result = await onTool(m.type, m.args); }
        catch (e) { result = { error: { type: "host_error", reason: String(e) } }; }
        child.send({ kind: "result", id: m.id, result });
        return;
      }
      if (m.kind === "done") {
        clearTimeout(timer);
        child.kill();
        resolve({ ret: m.ret, error: m.error });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
