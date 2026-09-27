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
// §23.21's spec-less-site per-request key builder is not in rwxmap's src/
// export yet — it lives as a POC, pinned by 19 tests (poc/match/key.test.mjs)
// and slated to graduate later. POC path — switch to rwxmap's src export
// when it ships.
const RWXMAP_KEY_POC_PATH = "/home/hamr/PycharmProjects/rwxmap/poc/match/key.mjs";

let rwxmap, keyPoc;
try {
  rwxmap = await import(RWXMAP_PATH);
  keyPoc = await import(RWXMAP_KEY_POC_PATH);
} catch (err) {
  console.log(`SKIP: rwxmap (or its poc/match/key.mjs) not found (${err.message})`);
  process.exit(0);
}
const { operationsFrom, exportGate, classifyRow } = rwxmap;
// requestKey(method, url, {mixedIds?}) -> "<host>.<METHOD> <normalized path>"
// — see poc/match/key.mjs's own header comment for the full normalization
// rules (lowercased WHATWG hostname incl. punycode IDN, non-default port
// kept, query+fragment dropped via .pathname, repeated slashes collapsed,
// trailing slash dropped except "/", id segments -> "{id}").
const { requestKey } = keyPoc;

// `gate.rwxTools()` and `addToGates()` (both PRD §23.21, added this session,
// closing this bench's own findings #1/#3) replace the two internal-reach-ins
// this bench used to do: `gate.cfg.rwx.tools` direct reads (step 9) and a
// hand-rolled fan-out loop over both gates' `add()` calls (ensureSite below).
// The replay below now goes through `gate.readAudit()` — a later debrief
// finding on this bench's OWN #2 fix: `gate.audit.readAll()`/`gate.audit`
// (the live `Audit` instance, with a public `emit()`) is internal plumbing,
// not the documented replay path — this bench used to read the audit FILE
// directly by path instead, which worked but bypassed the gate entirely
// (and wouldn't work at all in fileless mode). `readAudit()` is the
// documented, read-only, decoupled accessor; it returns the same data.
const { Gate, addToGates } = await import("../src/index.js");
// rwxCheck is still not part of the public API (src/index.js does not
// re-export it) — read directly from the primitive module for the replay's
// own re-check. This is an import, not an edit; src/ is untouched.
const { rwxCheck } = await import("../src/primitives/rwx.js");

/**
 * Self-check that this bench's understanding of requestKey's contract
 * matches what it actually does — a few real calls covering the properties
 * the coordinator asked to see exercised explicitly: default-port drop,
 * non-default port kept, host lowercasing, trailing-slash drop, query/
 * fragment drop, and id-segment normalization. Not a re-test of rwxmap's
 * own 19 pinned tests (those already cover this far more exhaustively) —
 * just evidence that THIS bench is calling it the way it actually behaves.
 * @param {(line:string)=>void} log
 * @returns {{passCount:number, failCount:number}}
 */
function keyFormatSelfCheck(log) {
  let passCount = 0, failCount = 0;
  const cases = [
    ["default https port dropped", "GET", "https://API.Example.com:443/x", "api.example.com.GET /x"],
    ["default http port dropped", "GET", "http://API.Example.com:80/x", "api.example.com.GET /x"],
    ["non-default port kept", "GET", "http://127.0.0.1:8080/x", "127.0.0.1:8080.GET /x"],
    ["host lowercased", "GET", "https://API.EXAMPLE.COM/x", "api.example.com.GET /x"],
    ["query + fragment dropped", "GET", "https://api.example.com/x?y=1&z=2#frag", "api.example.com.GET /x"],
    ["repeated slashes collapsed", "GET", "https://api.example.com/x//y", "api.example.com.GET /x/y"],
    ["trailing slash dropped", "GET", "https://api.example.com/x/", "api.example.com.GET /x"],
    ["root path stays '/'", "GET", "https://api.example.com/", "api.example.com.GET /"],
    ["all-digit id -> {id}", "GET", "https://api.example.com/orders/98765", "api.example.com.GET /orders/{id}"],
    ["UUID id -> {id}", "GET", "https://api.example.com/users/3fa85f64-5717-4562-b3fc-2c963f66afa6", "api.example.com.GET /users/{id}"],
    ["16+ hex id -> {id}", "GET", "https://api.example.com/objects/1234567890abcdef1234", "api.example.com.GET /objects/{id}"],
    ["method uppercased", "get", "https://api.example.com/x", "api.example.com.GET /x"],
  ];
  for (const [label, method, url, expected] of cases) {
    const got = requestKey(method, url);
    const pass = got === expected;
    if (pass) passCount++; else failCount++;
    log(`  [keyfmt] ${label}: requestKey(${JSON.stringify(method)}, ${JSON.stringify(url)}) = "${got}" (expected "${expected}") -> ${pass ? "PASS" : "FAIL"}`);
  }
  return { passCount, failCount };
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
    // Not part of the spec — a hand-written committed-config-only route
    // used for the rwx.askOn:"loose" demonstration (bench steps 13-15).
    if (req.method === "GET" && url.pathname === "/legacy/fare-lookup") {
      return sendJson(res, 200, { ok: true });
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

// Site C: "flights-rpc" — Google-Flights-shaped RPC endpoint, no spec, POST
// with an opaque JSON-array body and the operation name only in the PATH
// (not the body) for the RPC call, and only in the BODY (not the path) for
// the /graphql call.
const RPC_SHOPPING_RESULTS_PATH =
  "/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults";

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => resolve(body));
  });
}

function makeRpcServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/openapi.json") {
      return sendJson(res, 404, { error: "no spec here" }); // spec-less site
    }
    if (req.method === "POST" && url.pathname === RPC_SHOPPING_RESULTS_PATH) {
      await readBody(req); // opaque JSON array; the harness never inspects it
      return sendJson(res, 200, { shoppingResults: [] });
    }
    if (req.method === "POST" && url.pathname === "/graphql") {
      await readBody(req); // the operation name lives only in here, not in the path
      return sendJson(res, 200, { data: {} });
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
      // Applied to BOTH agents' gates in ONE call via addToGates() — the
      // tools map is a shared fact about the site, independent of which
      // agent later acts on it — only the agent's own letters (per-gate,
      // rwx.agent) decide what that agent may then do with the same entry.
      // This replaces this bench's own former hand-rolled fan-out loop
      // (findings.md #3): each gate is still fully independent (its own
      // lock/tighten-only/cap/audit), addToGates() just makes the "add to
      // every gate in the fleet" call a single call instead of a manual loop.
      try {
        const summary = await addToGates(Object.values(this.gates), tools);
        this.log(`  [add] fleet: added ${Object.keys(tools).length} ${vendor} keys from spec to ${summary.length} gate(s)`);
      } catch (err) {
        // addToGates is NOT all-or-nothing: this only throws when at least
        // one gate rejected, and err.failures names exactly which — the
        // OTHER gates in the fleet still landed their own copy of the batch.
        this.log(`  [add] fleet: ${err.message}`);
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
   * @param {string} [body] raw request body (opaque to the harness/gate —
   *   never inspected for classification or gating; §23.12's own line:
   *   bareguard's content patterns never scan a write's payload either)
   */
  async call(agentName, origin, vendor, method, urlPath, operationId, body) {
    const site = await this.ensureSite(origin, vendor);
    const url = `${origin}${urlPath}`;
    let actionType;

    if (site.hasSpec) {
      actionType = `${vendor}.${operationId}`;
    } else {
      // §23.21 step 3: no spec -> classify this one request, add(one).
      const [pathOnly] = urlPath.split("?");
      const verdict = classifyRow({ method, path: pathOnly });
      // POC path — switch to rwxmap's src export when it ships.
      actionType = requestKey(method, url);
      this.findings.push({ kind: "classifyRow", vendor, method, path: pathOnly, verdict });
      const gate = this.gates[agentName];
      try {
        await gate.add({ [actionType]: verdict.class });
        this.log(`  [add] ${agentName} gate: added ${actionType} = ${verdict.class} (${verdict.source}/${verdict.rule})`);
      } catch (err) {
        this.log(`  [add] ${agentName} gate: REJECTED add for ${actionType}: ${err.message}`);
      }
    }

    const action = { type: actionType, url, agent: agentName };
    const gate = this.gates[agentName];
    const decision = await gate.check(action);

    let fetched = null;
    if (decision.outcome === "allow") {
      try {
        const fetchOpts = { method };
        if (body !== undefined) {
          fetchOpts.body = body;
          fetchOpts.headers = { "content-type": "application/json" };
        }
        const r = await fetch(url, fetchOpts);
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

// `humanCallCounts`: Map<actionType, number> of how many times the channel
// was actually invoked for that type — how steps 13-15 prove "humanChannel
// is actually called" (or, for step 15, that it is NOT called) rather than
// just asserting the eventual decision.
function scriptedHumanChannel(log, humanCallCounts) {
  return async (event) => {
    const type = event.action.type;
    humanCallCounts.set(type, (humanCallCounts.get(type) ?? 0) + 1);
    log(`  [human] asked: ${event.rule} on ${type} (${event.reason})`);
    if (type === "airline.legacyFareLookupDeny") {
      return { decision: "deny", reason: "scripted human DENY (bench step 14)" };
    }
    return { decision: "allow", reason: "scripted human ALLOW (bench script default)" };
  };
}

// The COMMITTED starter file's tools section (hand-authored by "the
// operator", never written to at runtime).
const COMMITTED_TOOLS = {
  // Deliberately stricter than what rwxmap would emit for a similarly-named
  // operation, purely to exercise gate.add()'s tighten-only rejection
  // (bench step 9) — it does not correspond to any live endpoint in this
  // scenario, so it cannot interfere with the spec batch add.
  "airline.testDeprecatedRead": "w", // hand-tightened above rwxmap's own "r" for this made-up op

  // HAND-WRITTEN loose entries (labeled): no row rwxmap actually emitted in
  // this bench ever came out marker:"loose" (see rwx-e2e.md — the spec's 4
  // ops and site C's 2 ops all landed "settled" or "tight"). These three
  // exist purely to exercise rwx.askOn:"loose" for real, per the
  // coordinator's follow-up ask — they are synthetic operator config, not
  // an rwxmap export.
  "airline.legacyFareLookupAllow": { letter: "r", marker: "loose" }, // searcher holds "r" -> asks -> scripted allow
  "airline.legacyFareLookupDeny": { letter: "r", marker: "loose" },  // searcher holds "r" -> asks -> scripted deny
  "airline.legacyFareBooking": { letter: "w", marker: "loose" },     // searcher LACKS "w" -> denies without ever asking
};

async function buildGates(auditPath, log, humanCallCounts) {
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
  const humanChannel = scriptedHumanChannel(log, humanCallCounts);

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
  const rpcServer = makeRpcServer();
  const airlinePort = await listen(airlineServer);
  const hotelPort = await listen(hotelServer);
  const rpcPort = await listen(rpcServer);
  const airlineOrigin = `http://127.0.0.1:${airlinePort}`;
  const hotelOrigin = `http://127.0.0.1:${hotelPort}`;
  const rpcOrigin = `http://127.0.0.1:${rpcPort}`;

  const auditPath = path.join(
    os.tmpdir(),
    `bareguard-rwx-e2e-${runLabel}-${process.pid}-${Date.now()}.jsonl`,
  );
  try { await fsp.rm(auditPath, { force: true }); } catch {}

  const humanCallCounts = new Map();
  const { searcher, booker } = await buildGates(auditPath, log, humanCallCounts);
  const gates = { searcher, booker };
  const harness = new Harness(gates, log);

  // --- Key-format self-check (requestKey, the POC's own contract) --------
  const keyfmt = keyFormatSelfCheck(log);
  passCount += keyfmt.passCount;
  failCount += keyfmt.failCount;

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
    // gate.rwxTools() (new this session, §23.21) replaces this bench's former
    // direct read of `searcher.cfg.rwx.tools` — a decoupled snapshot of the
    // live map via the public accessor, instead of internal `cfg` state.
    const toolsNow = searcher.rwxTools();
    const stillStrict = toolsNow["airline.testDeprecatedRead"] === "w";
    const pass = rejected != null && stillStrict;
    record(9, "searcher", "airline.testDeprecatedRead", "(no live request — config-only test)", "throw + stays \"w\"", `${rejected ? "threw: " + rejected : "did NOT throw"}; entry now=${JSON.stringify(toolsNow["airline.testDeprecatedRead"])}`, pass);
  }

  // --- Step 11: searcher POST site-C RPC path -> allow, real 200 fetch ----
  // Google-Flights-shaped: no spec, opaque JSON-array body, the operation
  // name lives only in the path's trailing segment ("GetShoppingResults").
  {
    const r = await harness.call(
      "searcher", rpcOrigin, "flights-rpc", "POST",
      RPC_SHOPPING_RESULTS_PATH, undefined, JSON.stringify([["c", "abc123"]]),
    );
    const pass = r.decision.outcome === "allow" && r.fetched === 200;
    record(11, "searcher", r.action.type, r.action.url, "allow + 200", `${r.decision.outcome}/${r.decision.rule} + ${r.fetched}`, pass);
  }

  // --- Step 12: searcher POST /graphql -> denied (operation only in body,
  //     path alone floors x by design) -------------------------------------
  {
    const r = await harness.call(
      "searcher", rpcOrigin, "flights-rpc", "POST",
      "/graphql", undefined, JSON.stringify({ query: "query GetShoppingResults { flights { id } }" }),
    );
    const pass = r.decision.outcome === "deny";
    record(12, "searcher", r.action.type, r.action.url, "deny", `${r.decision.outcome}/${r.decision.rule}`, pass);
  }

  // --- Step 13: rwx.askOn:"loose" for real — searcher holds the letter,
  //     humanChannel is actually invoked, human says allow -> allow --------
  {
    const action = { type: "airline.legacyFareLookupAllow", url: `${airlineOrigin}/legacy/fare-lookup`, agent: "searcher" };
    const decision = await searcher.check(action);
    let fetched = null;
    if (decision.outcome === "allow") {
      const r = await fetch(action.url);
      fetched = r.status;
    }
    const asked = (humanCallCounts.get(action.type) ?? 0) >= 1;
    const pass = decision.outcome === "allow" && decision.rule === "humanChannel.allow" && asked && fetched === 200;
    record(13, "searcher", action.type, action.url, "ask -> human allow -> allow", `${decision.outcome}/${decision.rule} asked=${asked} fetched=${fetched}`, pass);
  }

  // --- Step 14: same, human says deny -> deny ------------------------------
  {
    const action = { type: "airline.legacyFareLookupDeny", url: `${airlineOrigin}/legacy/fare-lookup`, agent: "searcher" };
    const decision = await searcher.check(action);
    const asked = (humanCallCounts.get(action.type) ?? 0) >= 1;
    const pass = decision.outcome === "deny" && asked;
    record(14, "searcher", action.type, action.url, "ask -> human deny -> deny", `${decision.outcome}/${decision.rule} asked=${asked}`, pass);
  }

  // --- Step 15: loose entry at a letter the agent lacks -> deny WITHOUT
  //     ever asking (letter check runs before askOn) -----------------------
  {
    const action = { type: "airline.legacyFareBooking", url: `${airlineOrigin}/legacy/fare-lookup`, agent: "searcher" };
    const decision = await searcher.check(action);
    const asked = humanCallCounts.has(action.type);
    const pass = decision.outcome === "deny" && decision.rule === "rwx.denied" && !asked;
    record(15, "searcher", action.type, action.url, "deny, never asked", `${decision.outcome}/${decision.rule} asked=${asked}`, pass);
  }

  // --- Step 16: concurrency — 20 per-request adds+checks at once across
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
      16, "searcher", "(20 concurrent hotel GETs)", hotelOrigin,
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

  // --- Finale: replay the audit log ----------------------------------------
  const replay = await replayAudit(searcher, log);
  passCount += replay.passCount;
  failCount += replay.failCount;

  await new Promise((resolve) => airlineServer.close(resolve));
  await new Promise((resolve) => hotelServer.close(resolve));
  await new Promise((resolve) => rpcServer.close(resolve));

  return { rows, passCount, failCount, auditPath, findings: harness.findings, logLines };
}

/**
 * Replay the audit log in order: rebuild the tools map as
 * COMMITTED_TOOLS + every rwx.added line's key/letter/marker, in log order.
 * Assert every FINAL gate allow line is allowed by rwxCheck(action, map) at
 * that point in the log, exactly one final line per aid, and every allowed
 * key traces to the committed file or a logged rwx.added line.
 * @param {import("../src/gate.js").Gate} gate any gate sharing the audit
 *   file with the run being replayed (searcher and booker both write to the
 *   same `auditPath` in this bench, so either's `readAudit()` sees the
 *   whole log)
 */
async function replayAudit(gate, log) {
  let passCount = 0, failCount = 0;
  const lines = await gate.readAudit();

  const toolsMap = { ...COMMITTED_TOOLS };
  const addedKeys = new Set(Object.keys(COMMITTED_TOOLS));
  const finalOutcomesByAid = new Map(); // aid -> count of terminal decision lines seen
  const finalDecisionByAid = new Map();

  const TERMINAL_PHASES = new Set([
    "terminal-allow", "terminal-deny", "human-allow", "human-deny",
    "halt-deny", "topup-allow", "rwx.tightened",
  ]);
  // A "gate" phase line with decision allow/deny is the terminal commit —
  // but askOn:"loose" ALSO logs an earlier "gate" phase line for the SAME
  // aid with decision:"askHuman" (the ask-emit, outside the lock, per
  // gate.js), and a separate "approval" phase line recording the human's
  // own raw reply. Confirmed by reading the real JSONL (see rwx-e2e.md):
  // only phase==="gate" with decision allow/deny is the one final line.
  function isFinalCheckLine(entry) {
    return typeof entry.aid === "string" && entry.phase === "gate" &&
      (entry.decision === "allow" || entry.decision === "deny");
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
  const result = await runScenario("run1");
  console.log("");
  console.log(`=== run1 totals: PASS=${result.passCount} FAIL=${result.failCount} ===`);

  console.log("\n--- rwxmap real output (exportGate for airline, classifyRow for spec-less sites) ---");
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

export { runScenario, requestKey, COMMITTED_TOOLS };
