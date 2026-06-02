import vm from "node:vm";

// Wrap every tool so EVERY call the agent's code makes routes through
// bareguard's gate.run(). The agent code only ever sees this wrapped API.
// gate.run() returns the executor's result on allow, or a structured
// { error: { type:"policy_denied", ... } } object on deny — it never throws on
// a policy decision, so the agent code keeps running and simply gets a refusal.
export function buildGatedApi(gate, tools) {
  const api = {};
  for (const name of Object.keys(tools)) {
    api[name] = (args = {}) =>
      gate.run({ type: name, ...args }, () => tools[name](args));
  }
  // An escape hatch so the agent can attempt an ARBITRARY tool type that is not
  // on the menu — used to demonstrate the allowlist backstop (#2). In a real
  // code-mode runtime this wouldn't exist; the typed API simply wouldn't have
  // the symbol. Here it lets the gate, not the API surface, do the refusing.
  api.call = (type, args = {}) =>
    gate.run({ type, ...args }, async () => {
      const fn = tools[type];
      if (!fn) throw new Error("no such tool: " + type);
      return fn(args);
    });
  return api;
}

// Run agent-authored code with ONLY the gated api (and a log fn) in scope.
//
// CAVEAT: node:vm is NOT a security sandbox — a determined payload can escape
// via constructor.constructor and friends. It is enough HERE to show capability
// confinement structurally: process / fetch / require / Buffer are simply
// absent from the context, so off-menu capabilities aren't reachable by name.
// A real deployment uses isolated-vm, a Worker, or a subprocess.
export async function runHarness(code, api, log) {
  const ctx = vm.createContext({ tools: api, log });
  const wrapped = "(async () => {\n" + code + "\n})()";
  return vm.runInContext(wrapped, ctx, { timeout: 5000 });
}
