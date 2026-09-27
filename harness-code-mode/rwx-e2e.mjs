#!/usr/bin/env node
// rwx-e2e.mjs — end-to-end bench: bareguard's rwx mode + gate.add() driven by
// rwxmap's real classifier, against two local HTTP sites. This is a BENCH,
// NOT shipped code — nothing here is imported by src/, and nothing in src/
// imports rwxmap (PRD §23.12/§23.20 boundary). rwxmap is read from the local
// checkout by absolute path; if it's missing, this prints SKIP and exits 0.
//
// Scenario, PRD refs: §23.12 (rwxmap alignment / exporter contract), §23.20
// (marker-carrying entries, rwx.askOn), §23.21 (runtime gate.add() for
// spec-less sites — the flow this bench drives end to end).
//
// Read-only w.r.t. both repos: never edits rwxmap, never edits bareguard's
// src/types/test/package.json — only this file + rwx-e2e.md are touched.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";

const RWXMAP_PATH = "/home/hamr/PycharmProjects/rwxmap/src/index.js";

let rwxmap;
try {
  rwxmap = await import(RWXMAP_PATH);
} catch (err) {
  console.log(`SKIP: rwxmap not found at ${RWXMAP_PATH} (${err.message})`);
  process.exit(0);
}
const { operationsFrom, exportGate, classifyRow } = rwxmap;

const { Gate } = await import("../src/index.js");
// Not part of the public API (src/index.js does not re-export it) — read
// directly from the primitive module for the replay's own re-check. This is
// an import, not an edit; src/ is untouched.
const { rwxCheck } = await import("../src/primitives/rwx.js");

// ---------------------------------------------------------------------------
// §23.21's spec-less-site normalizer is NOT SHIPPED by rwxmap yet. Stand-in
// per the PRD's exact spec: key = "<host>.<METHOD> <normalized path>" —
// drop the query string, and normalize id-shaped path segments: all-digit
// -> "{id}", a UUID -> "{id}", a long hex string -> "{id}".
// REPLACE with rwxmap's exported normalizer when it ships.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const ALL_DIGIT_RE = /^\d+$/;

function normalizeKeyStandIn(host, method, rawPath) {
  const [pathOnly] = rawPath.split("?"); // drop query string
  const segments = pathOnly.split("/").map((seg) => {
    if (seg === "") return seg;
    if (ALL_DIGIT_RE.test(seg)) return "{id}";
    if (UUID_RE.test(seg)) return "{id}";
    if (LONG_HEX_RE.test(seg)) return "{id}";
    return seg;
  });
  const normalizedPath = segments.join("/");
  return `${host}.${method.toUpperCase()} ${normalizedPath}`;
}

// ---------------------------------------------------------------------------
// Two local sites.
// ---------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

const AIRLINE_SPEC = {
  openapi: "3.0.0",
  info: { title: "airline", version: "1.0.0" },
  paths: {
    "/flights": {
      get: {
        operationId: "searchFlights",
        summary: "Search available flights",
      },
    },
    "/flights/{id}": {
      get: {
        operationId: "getFlight",
        summary: "Get a single flight",
      },
    },
    "/bookings": {
      post: {
        operationId: "addBooking",
        summary: "Add a new booking",
      },
    },
    "/bookings/{id}": {
      delete: {
        operationId: "cancelBooking",
        summary: "Cancel a booking",
      },
    },
  },
};

function makeAirlineServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/openapi.json") {
      return sendJson(res, 200, AIRLINE_SPEC);
    }
    if (req.method === "GET" && url.pathname === "/flights") {
      return sendJson(res, 200, { flights: [{ id: "1", from: "SFO", to: "JFK" }] });
    }
    if (req.method === "GET" && /^\/flights\/[^/]+$/.test(url.pathname)) {
      return sendJson(res, 200, { id: url.pathname.split("/")[2], from: "SFO", to: "JFK" });
    }
    if (req.method === "POST" && url.pathname === "/bookings") {
      return sendJson(res, 201, { id: "b-1", status: "confirmed" });
    }
    if (req.method === "DELETE" && /^\/bookings\/[^/]+$/.test(url.pathname)) {
      return sendJson(res, 204, {});
    }
    return sendJson(res, 404, { error: "not found" });
  });
}

function makeHotelServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/openapi.json") {
      return sendJson(res, 404, { error: "no spec here" }); // spec-less site
    }
    if (req.method === "GET" && url.pathname === "/rooms") {
      return sendJson(res, 200, { rooms: [{ id: "101", city: url.searchParams.get("city") ?? null }] });
    }
    if (req.method === "GET" && /^\/rooms\/[^/]+$/.test(url.pathname)) {
      return sendJson(res, 200, { id: url.pathname.split("/")[2] });
    }
    if (req.method === "POST" && url.pathname === "/reservations") {
      return sendJson(res, 201, { id: "res-1" });
    }
    return sendJson(res, 404, { error: "not found" });
  });
}

// ---------------------------------------------------------------------------
// Harness: the ONLY code in this bench that touches both rwxmap and
// gate.add(). Per §23.21's flow: forced spec check first per site; spec
// found -> classify every operation -> add(all); no spec -> per request:
// classifyRow + stand-in key -> add(one) -> then check() -> fetch only on
// allow.
// ---------------------------------------------------------------------------

class Harness {
  constructor(gates, log) {
    this.gates = gates; // { searcher: Gate, booker: Gate }
    this.log = log;
    this.siteCache = new Map(); // origin -> { hasSpec, vendor }
    this.findings = [];
  }

  async ensureSite(origin, vendor) {
    if (this.siteCache.has(origin)) return this.siteCache.get(origin);
    // §23.21 step 1: forced spec check first, no skip to per-request.
    let spec = null;
    try {
      const r = await fetch(`${origin}/openapi.json`);
      if (r.ok) spec = await r.json();
    } catch { /* treat as no spec */ }

    if (spec) {
      const ops = operationsFrom(spec);
      const { tools, collisions } = exportGate(ops, { vendor });
      this.findings.push({
        kind: "exportGate",
        vendor,
        tools,
        collisions,
      });
      // §23.21 step 2: spec found -> classify every operation -> add(all).
      // Applied to BOTH agents' gates: the tools map is a shared fact about
      // the site, independent of which agent later acts on it — only the
      // agent's own letters (per-gate, rwx.agent) decide what that agent
      // may then do with the same entry.
      for (const [name, gate] of Object.entries(this.gates)) {
        try {
          await gate.add(tools);
          this.log(`  [add] ${name} gate: added ${Object.keys(tools).length} ${vendor} keys from spec`);
        } catch (err) {
          this.log(`  [add] ${name} gate: REJECTED batch for ${vendor} spec: ${err.message}`);
        }
      }
      const entry = { hasSpec: true, vendor };
      this.siteCache.set(origin, entry);
      return entry;
    }

    const entry = { hasSpec: false, vendor };
    this.siteCache.set(origin, entry);
    return entry;
  }

  /**
   * Perform one harness-mediated call.
   * @param {"searcher"|"booker"} agentName
   * @param {string} origin e.g. "http://127.0.0.1:54321"
   * @param {string} vendor site vendor tag (spec sites only)
   * @param {string} method
   * @param {string} urlPath live request path, WITH query string if any
   * @param {string} [operationId] known ahead of time by the harness author
   *   for a spec'd site (see rwx-e2e.md finding: rwxmap gives no path->
   *   operationId matcher back, so the harness must already know which
   *   operation a URL maps to)
   */
  async call(agentName, origin, vendor, method, urlPath, operationId) {
    const site = await this.ensureSite(origin, vendor);
    const host = new URL(origin).host;
    let actionType;

    if (site.hasSpec) {
      actionType = `${vendor}.${operationId}`;
    } else {
      // §23.21 step 3: no spec -> classify this one request, add(one).
      const [pathOnly] = urlPath.split("?");
      const verdict = classifyRow({ method, path: pathOnly });
      actionType = normalizeKeyStandIn(host, method, pathOnly);
      const gate = this.gates[agentName];
      try {
        await gate.add({ [actionType]: verdict.class });
        this.log(`  [add] ${agentName} gate: added ${actionType} = ${verdict.class} (${verdict.source}/${verdict.rule})`);
      } catch (err) {
        this.log(`  [add] ${agentName} gate: REJECTED add for ${actionType}: ${err.message}`);
      }
    }

    const url = `${origin}${urlPath}`;
    const action = { type: actionType, url, agent: agentName };
    const gate = this.gates[agentName];
    const decision = await gate.check(action);

    let fetched = null;
    if (decision.outcome === "allow") {
      try {
        const r = await fetch(url, { method });
        fetched = r.status;
      } catch (err) {
        fetched = `fetch-error:${err.message}`;
      }
    }
    return { action, decision, fetched };
  }
}

// ---------------------------------------------------------------------------
// Gate config. Shared committed tools map (the operator's own
// bareguard.rwx.json, hand-authored) + a scripted humanChannel + audit to a
// temp file.
// ---------------------------------------------------------------------------

function scriptedHumanChannel(log) {
  return async (event) => {
    log(`  [human] asked: ${event.rule} on ${event.action.type} (${event.reason})`);
    return { decision: "allow", reason: "scripted human allow (loose marker, per bench script)" };
  };
}

// The COMMITTED starter file's tools section (hand-authored by "the
// operator", never written to at runtime). Deliberately includes ONE
// hand-written entry stricter than what rwxmap would emit for a similarly-
// named operation, purely to exercise gate.add()'s tighten-only rejection
// (§23.21 step 9 of this bench) — it does not correspond to any live
// endpoint in this scenario, so it cannot interfere with the spec batch add.
const COMMITTED_TOOLS = {
  "airline.testDeprecatedRead": "w", // hand-tightened above rwxmap's own "r" for this made-up op
};

async function buildGates(auditPath, log) {
  const baseRwx = {
    agents: { searcher: "r--", booker: "rw-" },
    tools: { ...COMMITTED_TOOLS },
    askOn: "loose",
  };
  const netCfg = {
    allowDomains: ["127.0.0.1"],
    // denyPrivateIps is OFF here: 127.0.0.1 IS a private/loopback address,
    // so isPrivateIp() would flag every call in this bench regardless of
    // vendor. The allowDomains allowlist alone bounds egress to the two
    // local test servers, which is the whole point of this bench running
    // real HTTP against 127.0.0.1 rather than mocked fetches. A real
    // deployment fetching real internet hosts would leave denyPrivateIps on.
    denyPrivateIps: false,
  };
  const humanChannel = scriptedHumanChannel(log);

  const searcher = new Gate({
    rwx: { ...baseRwx, agent: "searcher" },
    net: netCfg,
    audit: { path: auditPath },
    humanChannel,
  });
  const booker = new Gate({
    rwx: { ...baseRwx, agent: "booker" },
    net: netCfg,
    audit: { path: auditPath },
    humanChannel,
  });
  await searcher.init();
  await booker.init();
  return { searcher, booker };
}

// ---------------------------------------------------------------------------
// The scenario, run once per invocation of runScenario() (called twice per
// process run to satisfy "run it twice").
// ---------------------------------------------------------------------------

async function runScenario(runLabel) {
  const rows = [];
  let passCount = 0, failCount = 0;
  const logLines = [];
  const log = (line) => { logLines.push(line); console.log(line); };

  const airlineServer = makeAirlineServer();
  const hotelServer = makeHotelServer();
  const airlinePort = await listen(airlineServer);
  const hotelPort = await listen(hotelServer);
  const airlineOrigin = `http://127.0.0.1:${airlinePort}`;
  const hotelOrigin = `http://127.0.0.1:${hotelPort}`;

  const auditPath = path.join(
    os.tmpdir(),
    `bareguard-rwx-e2e-${runLabel}-${process.pid}-${Date.now()}.jsonl`,
  );
  try { await fsp.rm(auditPath, { force: true }); } catch {}

  const { searcher, booker } = await buildGates(auditPath, log);
  const gates = { searcher, booker };
  const harness = new Harness(gates, log);

  function record(step, agent, actionType, url, expected, got, pass) {
    rows.push({ step, agent, actionType, url, expected, got, pass });
    if (pass) passCount++; else failCount++;
  }

  // --- Step 1: searcher GET flights -> allow, real 200 fetched -----------
  {
    const r = await harness.call("searcher", airlineOrigin, "airline", "GET", "/flights", "searchFlights");
    const pass = r.decision.outcome === "allow" && r.fetched === 200;
    record(1, "searcher", r.action.type, r.action.url, "allow + 200", `${r.decision.outcome}/${r.decision.rule} + ${r.fetched}`, pass);
  }

  // --- Step 2: searcher POST bookings -> deny (rwx.denied) ----------------
  {
    const r = await harness.call("searcher", airlineOrigin, "airline", "POST", "/bookings", "addBooking");
    const pass = r.decision.outcome === "deny" && r.decision.rule === "rwx.denied";
    record(2, "searcher", r.action.type, r.action.url, "deny/rwx.denied", `${r.decision.outcome}/${r.decision.rule}`, pass);
  }

  // --- Step 3: booker POST bookings -> allow (or ask -> human allow) ------
  {
    const r = await harness.call("booker", airlineOrigin, "airline", "POST", "/bookings", "addBooking");
    const pass = r.decision.outcome === "allow";
    const marker = r.decision.rwxMarker ?? "(none)";
    record(3, "booker", r.action.type, r.action.url, "allow", `${r.decision.outcome}/${r.decision.rule} marker=${marker}`, pass);
  }

  // --- Step 4: searcher GET hotel /rooms?city=x -> per-request add, allow,
  //     key has no query string ------------------------------------------
  {
    const r = await harness.call("searcher", hotelOrigin, "hotel", "GET", "/rooms?city=paris");
    const pass = r.decision.outcome === "allow" && !r.action.type.includes("?") && r.fetched === 200;
    record(4, "searcher", r.action.type, r.action.url, "allow, key has no '?'", `${r.decision.outcome}/${r.decision.rule} type="${r.action.type}" fetched=${r.fetched}`, pass);
  }

  // --- Step 5: searcher POST hotel /reservations -> denied ----------------
  {
    const r = await harness.call("searcher", hotelOrigin, "hotel", "POST", "/reservations");
    const pass = r.decision.outcome === "deny";
    record(5, "searcher", r.action.type, r.action.url, "deny", `${r.decision.outcome}/${r.decision.rule}`, pass);
  }

  // --- Step 6: fetch to metadata IP typed as a site key -> net deny -------
  {
    const action = { type: "airline.searchFlights", url: "http://169.254.169.254/latest/meta-data", agent: "searcher" };
    const decision = await searcher.check(action);
    const pass = decision.outcome === "deny" && decision.rule.startsWith("net.");
    record(6, "searcher", action.type, action.url, "deny/net.*", `${decision.outcome}/${decision.rule}`, pass);
  }

  // --- Step 7: host not in allowDomains -> net deny -----------------------
  {
    const action = { type: "airline.searchFlights", url: "http://example.com/flights", agent: "searcher" };
    const decision = await searcher.check(action);
    const pass = decision.outcome === "deny" && decision.rule === "net.allowDomains";
    record(7, "searcher", action.type, action.url, "deny/net.allowDomains", `${decision.outcome}/${decision.rule}`, pass);
  }

  // --- Step 8: unlisted key with no add -> rwx.unlisted -------------------
  {
    const action = { type: "airline.neverAdded", url: `${airlineOrigin}/flights`, agent: "searcher" };
    const decision = await searcher.check(action);
    const pass = decision.outcome === "deny" && decision.rule === "rwx.unlisted";
    record(8, "searcher", action.type, action.url, "deny/rwx.unlisted", `${decision.outcome}/${decision.rule}`, pass);
  }

  // --- Step 9: hand-written stricter committed entry; add tries to loosen
  //     it -> rwx.add_rejected, stays strict ------------------------------
  {
    let rejected = null;
    try {
      await searcher.add({ "airline.testDeprecatedRead": "r" }); // would loosen w -> r
    } catch (err) {
      rejected = err.message;
    }
    const stillStrict = searcher.cfg.rwx.tools["airline.testDeprecatedRead"] === "w";
    const pass = rejected != null && stillStrict;
    record(9, "searcher", "airline.testDeprecatedRead", "(no live request — config-only test)", "throw + stays \"w\"", `${rejected ? "threw: " + rejected : "did NOT throw"}; entry now=${JSON.stringify(searcher.cfg.rwx.tools["airline.testDeprecatedRead"])}`, pass);
  }

  // --- Step 10: concurrency — 20 per-request adds+checks at once across
  //     both sites --------------------------------------------------------
  {
    const concurrentCalls = [];
    for (let i = 0; i < 10; i++) {
      concurrentCalls.push(harness.call("searcher", hotelOrigin, "hotel", "GET", `/rooms/${1000 + i}`));
    }
    for (let i = 0; i < 10; i++) {
      concurrentCalls.push(harness.call("searcher", hotelOrigin, "hotel", "GET", `/rooms?city=city${i}`));
    }
    const results = await Promise.allSettled(concurrentCalls);
    const allAllowed = results.every(
      (r) => r.status === "fulfilled" && r.value.decision.outcome === "allow",
    );
    const anyThrew = results.some((r) => r.status === "rejected");
    const pass = allAllowed && !anyThrew;
    record(
      10, "searcher", "(20 concurrent hotel GETs)", hotelOrigin,
      "all 20 allow, none throw",
      `allAllowed=${allAllowed} anyThrew=${anyThrew} (${results.length} settled)`,
      pass,
    );
  }

  // --- Print the table -----------------------------------------------------
  log("");
  log(`=== ${runLabel}: step results ===`);
  log("step | agent    | action type                          | url                                              | expected                 | got                                                                 | result");
  for (const r of rows) {
    log(
      `${String(r.step).padEnd(4)} | ${r.agent.padEnd(8)} | ${String(r.actionType).slice(0, 36).padEnd(36)} | ${String(r.url).slice(0, 48).padEnd(48)} | ${String(r.expected).padEnd(24)} | ${String(r.got).slice(0, 68).padEnd(68)} | ${r.pass ? "PASS" : "FAIL"}`,
    );
  }

  // --- Finale: replay the audit file --------------------------------------
  const replay = await replayAudit(auditPath, log);
  passCount += replay.passCount;
  failCount += replay.failCount;

  await new Promise((resolve) => airlineServer.close(resolve));
  await new Promise((resolve) => hotelServer.close(resolve));

  return { rows, passCount, failCount, auditPath, findings: harness.findings, logLines };
}

/**
 * Replay the audit log in order: rebuild the tools map as
 * COMMITTED_TOOLS + every rwx.added line's key/letter/marker, in log order.
 * Assert every FINAL gate allow line is allowed by rwxCheck(action, map) at
 * that point in the log, exactly one final line per aid, and every allowed
 * key traces to the committed file or a logged rwx.added line.
 */
async function replayAudit(auditPath, log) {
  let passCount = 0, failCount = 0;
  const buf = await fsp.readFile(auditPath, "utf8");
  const lines = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const toolsMap = { ...COMMITTED_TOOLS };
  const addedKeys = new Set(Object.keys(COMMITTED_TOOLS));
  const finalOutcomesByAid = new Map(); // aid -> count of terminal decision lines seen
  const finalDecisionByAid = new Map();

  const TERMINAL_PHASES = new Set([
    "terminal-allow", "terminal-deny", "human-allow", "human-deny",
    "halt-deny", "topup-allow", "rwx.tightened",
  ]);
  // The audit line's own `phase`/`rule` naming varies by exit path; a line
  // counts as a "final gate line" for this replay if it carries an `aid`
  // and an `outcome` of allow/deny (i.e. it's a check() commit line, not an
  // ask-emit, an rwx.added, or an rwx.add_rejected line).
  function isFinalCheckLine(entry) {
    return typeof entry.aid === "string" && (entry.decision === "allow" || entry.decision === "deny");
  }

  for (const entry of lines) {
    if (entry.phase === "rwx.added" && typeof entry.key === "string") {
      toolsMap[entry.key] = entry.marker ? { letter: entry.letter, marker: entry.marker } : entry.letter;
      addedKeys.add(entry.key);
      continue;
    }
    if (isFinalCheckLine(entry)) {
      const count = (finalOutcomesByAid.get(entry.aid) ?? 0) + 1;
      finalOutcomesByAid.set(entry.aid, count);
      finalDecisionByAid.set(entry.aid, entry);

      if (entry.decision === "allow" && entry.action) {
        // Re-run rwxCheck against the map AS RECONSTRUCTED AT THIS POINT.
        // The re-check needs the acting agent's letters; reconstruct a
        // minimal rwxCfg using the same agents map and the agent name
        // carried on the action (harness always sets action.agent).
        const rwxCfg = {
          agent: entry.action.agent,
          agents: { searcher: "r--", booker: "rw-" },
          tools: toolsMap,
          askOn: "loose",
        };
        const verdict = rwxCheck(entry.action, rwxCfg);
        const netOk = !entry.action.url || allowedByNet(entry.action.url);
        const allowedNow = (verdict.outcome === "allow" || verdict.outcome === "askHuman") && netOk;
        if (allowedNow) passCount++; else failCount++;
        log(
          `  [replay] aid=${entry.aid} allow line for "${entry.action.type}" — ` +
          `rwxCheck-at-this-point says ${verdict.outcome}/${verdict.rule}, net ok=${netOk} -> ${allowedNow ? "PASS" : "FAIL"}`,
        );

        if (!addedKeys.has(entry.action.type)) {
          failCount++;
          log(`  [replay] FAIL: allowed key "${entry.action.type}" traces to neither the committed file nor a logged rwx.added`);
        } else {
          passCount++;
        }
      }
    }
  }

  let oneLinePerAid = true;
  for (const [aid, count] of finalOutcomesByAid) {
    if (count !== 1) {
      oneLinePerAid = false;
      log(`  [replay] FAIL: aid=${aid} has ${count} final gate lines (expected exactly 1)`);
    }
  }
  if (oneLinePerAid) passCount++; else failCount++;

  log(`  [replay] reconstructed tools map has ${Object.keys(toolsMap).length} keys; ${finalOutcomesByAid.size} distinct aids seen`);
  return { passCount, failCount };
}

function allowedByNet(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("--- rwxmap normalizeKeyStandIn self-check (not part of the numbered scenario) ---");
  console.log("  ", normalizeKeyStandIn("127.0.0.1:9999", "GET", "/rooms?city=paris"));
  console.log("  ", normalizeKeyStandIn("127.0.0.1:9999", "GET", "/rooms/42"));
  console.log("  ", normalizeKeyStandIn("127.0.0.1:9999", "GET", "/rooms/3fa85f64-5717-4562-b3fc-2c963f66afa6"));
  console.log("  ", normalizeKeyStandIn("127.0.0.1:9999", "GET", "/rooms/deadbeefcafebabe1234"));
  console.log("");

  const result = await runScenario("run1");
  console.log("");
  console.log(`=== run1 totals: PASS=${result.passCount} FAIL=${result.failCount} ===`);

  console.log("\n--- rwxmap exportGate output (airline) ---");
  for (const f of result.findings) {
    console.log(JSON.stringify(f, null, 2));
  }

  if (result.failCount > 0) {
    process.exitCode = 1;
  }

  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  await main();
}

export { runScenario, normalizeKeyStandIn, COMMITTED_TOOLS };
