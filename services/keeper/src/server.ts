// The keeper's HTTP face: a few read-only and demo routes, plus /relay for one-signature pledges.
//
// Nothing here feeds the keeper: its events come from its own reading of Arc's node (follow.ts).
// Every route is for the app, so each carries CORS. A body is read as plain JSON text; a
// compressed body is not unpacked, so it fails to parse and is refused like any other bad request.
import http from "node:http";

import { missing } from "../../../packages/kit/src/index.ts";
import type { Desk } from "./demo.ts";
import type { Follower } from "./follow.ts";
import { type Keeper } from "./keeper.ts";
import { RELAY, type Relay } from "./relay.ts";

const CORS_PATHS = new Set(["/ledger", "/health", "/demo/usdc", "/demo/campaign", "/demo/campaign/two", "/relay"]);
const TOO_LARGE = Symbol("too-large");
const TOO_SLOW = Symbol("too-slow");
const TOO_BUSY = Symbol("too-busy");
type Refused = typeof TOO_LARGE | typeof TOO_SLOW | typeof TOO_BUSY;

// What all requests together may hold in memory while their bodies arrive.
type Budget = { held: number; max: number };

// Every bigint becomes a decimal string; everything else is copied as is.
function jsonify(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonify);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = jsonify(val);
    return out;
  }
  return v;
}

/** What GET /ledger returns: the whole ledger with every bigint as a decimal string. */
export function ledgerJson(keeper: Keeper): unknown {
  const ledger = keeper.ledger;
  const m = missing(ledger);
  const campaigns = [...ledger.campaigns.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({
      id: c.id,
      sponsor: c.sponsor,
      terms: {
        recipient: c.terms.recipient,
        opensAt: c.terms.opensAt,
        earlyUntil: c.terms.earlyUntil,
        closesAt: c.terms.closesAt,
        target: c.terms.target,
        minPledge: c.terms.minPledge,
        matchAmount: c.terms.matchAmount,
        bonusPool: c.terms.bonusPool,
        rateBps: c.terms.rateBps,
        linearWeight: c.terms.linearWeight,
        bonusFromRecipient: c.terms.bonusFromRecipient,
      },
      matchIn: c.matchIn,
      bonusIn: c.bonusIn,
      outcome: c.outcome,
      pledged: c.pledged,
      pledgedEarly: c.pledgedEarly,
      earlyUnknown: c.earlyUnknown,
      weighted: c.weighted,
      bonusPaid: c.bonusPaid,
      expectedBonusPaid: c.expectedBonusPaid,
      recipientPaid: c.recipientPaid,
      matchReturned: c.matchReturned,
      bonusReturned: c.bonusReturned,
      payFailures: c.payFailures,
      backers: [...c.backers.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([address, b]) => ({
          address,
          principal: b.principal,
          weighted: b.weighted,
          payTo: b.payTo,
          paid: b.paid,
          paidPrincipal: b.paidPrincipal,
          paidBonus: b.paidBonus,
        })),
    }));
  return jsonify({
    lastSeq: ledger.lastSeq,
    totalOwed: ledger.totalOwed,
    missing: m === null ? null : { from: m.from, to: m.to },
    campaigns,
    feed: keeper.feed(),
  });
}

// Read a request body, within three limits: its own size, the time it may take to arrive, and
// what all bodies being read at this moment may hold together. This runs for anyone who connects,
// before any signature is checked, so each limit is what a stranger can cost the process.
function readBody(req: http.IncomingMessage, limit: number, budget: Budget, deadlineMs: number): Promise<Uint8Array | Refused> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: Uint8Array | Refused | Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      budget.held -= size;
      chunks = [];
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(TOO_SLOW), deadlineMs);
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      budget.held += c.length;
      if (size > limit) return finish(TOO_LARGE);
      if (budget.held > budget.max) return finish(TOO_BUSY);
      chunks.push(c);
    });
    req.on("end", () => finish(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", (e) => finish(e));
    req.on("close", () => finish(new Error("closed before the body ended")));
  });
}

export function createServer(o: {
  keeper: Keeper;
  desk?: Desk;
  /** Submits one-signature pledges (POST /relay); absent when the keeper has no key or no helper. */
  relay?: Relay;
  /** The keeper's own reading of the node (follow.ts), shown in /health; absent when it is off. */
  follower?: Pick<Follower, "state">;
  /** What all bodies being read at one moment may hold together. Default 256 KiB: over a hundred of the largest bodies a route takes. */
  maxHeld?: number;
  /** How long a body may take to arrive, in milliseconds. Default ten seconds. */
  bodyDeadlineMs?: number;
  log?: (line: string) => void;
}): http.Server {
  const { keeper, desk, relay, follower, log } = o;
  // The largest body a route takes is 2 KiB (/relay), so the budget is what about 128 such
  // bodies arriving at once would hold. Past it a body is refused as busy until others finish.
  const budget: Budget = { held: 0, max: o.maxHeld ?? 256 * 1024 };
  const bodyDeadlineMs = o.bodyDeadlineMs ?? 10_000;

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      // Nothing a stranger sends may stop the process. Whatever went wrong, answer and carry on.
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(res.writableEnded ? undefined : JSON.stringify({ error: "server error" }));
      } catch {
        // the socket is already gone
      }
    }
  });
  // A request must arrive quickly: its headers within fifteen seconds, all of it within thirty
  // (a body the server reads has its own, shorter deadline). And connections are counted. The
  // defaults (five minutes, no limit) are what a stranger would use to tie the process up.
  // These bound what one connection costs; they do not stop a machine that keeps opening
  // connections from crowding the keeper's own requests out while it lasts (docs/ARCHITECTURE.md
  // says what that can and cannot do).
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 256;
  return server;

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method ?? "GET";
    // The path is whatever comes before the first "?", taken as text. It is only ever compared
    // with the few routes below, so it is not parsed as a URL (a target like "//" is not one).
    const path = (req.url ?? "/").split("?")[0];

    // Does the request say it carries a body? Only two routes read one. Anywhere else, or when a
    // route answers without reading it, the connection is closed with the answer: a body nobody
    // reads must not keep the connection open while it trickles in.
    const saysBody = req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");
    let bodyTaken = false;

    const reply = (status: number, bodyObj: unknown | null, cors: boolean): void => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cors) headers["access-control-allow-origin"] = "*";
      if (saysBody && !bodyTaken) headers.connection = "close";
      res.writeHead(status, headers);
      res.end(bodyObj === null ? "" : JSON.stringify(bodyObj));
      if (log) log(`${method} ${path} ${status}`);
    };

    // A refusal sent before the body has been read, or part-way through it. The connection is
    // closed with the answer, so whatever the sender still means to send is never taken in.
    const refuse = (status: number, bodyObj: unknown, cors: boolean): void => {
      if (res.headersSent) return;
      const headers: Record<string, string> = { "content-type": "application/json", connection: "close" };
      if (cors) headers["access-control-allow-origin"] = "*";
      res.writeHead(status, headers);
      res.end(JSON.stringify(bodyObj));
      if (log) log(`${method} ${path} ${status}`);
    };
    // The length a request declares for its body, when it declares one that can be read.
    const declared = (): number | null => {
      const v = req.headers["content-length"];
      return typeof v === "string" && /^[0-9]{1,15}$/.test(v) ? Number(v) : null;
    };

    if (method === "OPTIONS") {
      if (CORS_PATHS.has(path)) {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        };
        if (saysBody) headers.connection = "close";
        res.writeHead(204, headers);
        res.end();
        if (log) log(`${method} ${path} 204`);
        return;
      }
      reply(404, { error: "not found" }, false);
      return;
    }

    if (method === "GET" && path === "/ledger") return reply(200, ledgerJson(keeper), true);
    if (method === "GET" && path === "/health") return reply(200, { ...keeper.health(), node: follower ? follower.state() : null, desk: desk ? desk.address : null, relay: relay ? relay.address : null }, true);

    if (method === "POST" && path === "/demo/usdc") {
      if (!desk) return reply(503, { ok: false, reason: "no-desk" }, true);
      const length = declared();
      if (length !== null && length > 1024) return refuse(400, { ok: false, reason: "bad-address" }, true);
      readBody(req, 1024, budget, bodyDeadlineMs)
        .then((raw) => {
          if (!(raw instanceof Uint8Array)) return refuse(raw === TOO_BUSY ? 503 : 400, { ok: false, reason: raw === TOO_BUSY ? "busy" : "bad-address" }, true);
          bodyTaken = true;
          let body: unknown;
          try {
            body = JSON.parse(Buffer.from(raw).toString("utf8"));
          } catch {
            return reply(400, { ok: false, reason: "bad-address" }, true);
          }
          const address = (body as { address?: unknown } | null)?.address;
          if (typeof address !== "string") return reply(400, { ok: false, reason: "bad-address" }, true);
          desk
            .giveUsdc(address)
            .then((r) => reply(r.ok ? 200 : r.reason === "bad-address" ? 400 : 409, r, true))
            // The desk itself could not answer (its node is down, say): not the asker's fault.
            .catch(() => reply(503, { ok: false, reason: "busy" }, true));
        })
        .catch(() => refuse(400, { ok: false, reason: "bad-address" }, true));
      return;
    }

    // The desk's two campaigns, each at its own path, so no body is read: the ten-minute one,
    // and the two-minute one.
    if (method === "POST" && (path === "/demo/campaign" || path === "/demo/campaign/two")) {
      if (!desk) return reply(503, { ok: false, reason: "no-desk" }, true);
      desk
        .openCampaign(path === "/demo/campaign/two" ? "two" : "ten")
        .then((r) => reply(r.ok ? 200 : 409, r, true))
        .catch(() => reply(503, { ok: false, reason: "busy" }, true));
      return;
    }

    if (method === "POST" && path === "/relay") {
      if (!relay) return reply(503, { ok: false, reason: "no-relay" }, true);
      const length = declared();
      if (length !== null && length > RELAY.maxBody) return refuse(400, { ok: false, reason: "bad-request" }, true);
      readBody(req, RELAY.maxBody, budget, bodyDeadlineMs)
        .then((raw) => {
          if (!(raw instanceof Uint8Array)) return refuse(raw === TOO_BUSY ? 503 : 400, { ok: false, reason: raw === TOO_BUSY ? "busy" : "bad-request" }, true);
          bodyTaken = true;
          let body: unknown;
          try {
            body = JSON.parse(Buffer.from(raw).toString("utf8"));
          } catch {
            return reply(400, { ok: false, reason: "bad-request" }, true);
          }
          relay
            .relay(body)
            .then((r) => reply(r.ok ? 200 : r.reason === "bad-request" || r.reason === "bad-signature" ? 400 : r.reason === "busy" || r.reason === "keeper-low" || r.reason === "unavailable" ? 503 : 409, r, true))
            .catch(() => reply(503, { ok: false, reason: "busy" }, true));
        })
        .catch(() => refuse(400, { ok: false, reason: "bad-request" }, true));
      return;
    }

    reply(404, { error: "not found" }, false);
  }
}
