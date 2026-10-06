import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { StoredEvent } from "@mar/core";
import type { Store } from "./store.js";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BUFFERED = 5 * 1024 * 1024; // live events only; replay waits for drain instead
const CLOSE_GRACE_MS = 2000; // a slow consumer may never finish the closing handshake; ws would wait 30s
const REPLAY_CHUNK = 500;
const MAX_PENDING = 100_000; // live events buffered while a slow replay is in flight
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50000;
// lowercase and drop a trailing dot on the hostname ("LOCALHOST.:80" -> "localhost:80")
const norm = (s: string) => s.toLowerCase().replace(/\.(?=(:\d+)?$)/, "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const status = (res: ServerResponse, code: number) => { res.writeHead(code); res.end(); };
const rejectUpgrade = (socket: Duplex, code: number, text: string) => {
  socket.on("error", () => { /* peer already gone */ });
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};
const decode = (s: string): string | undefined => {
  try { const d = decodeURIComponent(s); return d.includes("\0") ? undefined : d; } catch { return undefined; }
};

export async function startServer(store: Store, opts: { port: number; staticDir?: string; onStop?: (runId: string) => void; readOnly?: boolean }) {
  let port = 0;
  // Local-only server that any web page in the user's browser can reach: pin Host (DNS rebinding) and Origin (CSRF/CSWSH).
  const hostOk = (req: IncomingMessage) => {
    const h = req.headers.host === undefined ? undefined : norm(req.headers.host);
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };
  const originOk = (req: IncomingMessage) => {
    const o = req.headers.origin === undefined ? undefined : norm(req.headers.origin);
    return o === undefined || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  };

  const staticRoot = opts.staticDir && existsSync(opts.staticDir) ? realpathSync(resolve(opts.staticDir)) : undefined;
  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (!staticRoot || pathname === "/api" || pathname.startsWith("/api/") || pathname === "/ws") return status(res, 404);
    if (req.method !== "GET" && req.method !== "HEAD") return status(res, 405);
    const decoded = decode(pathname);
    if (decoded === undefined) return status(res, 400);
    if (decoded.split("/").some((seg) => seg.startsWith("."))) return status(res, 404); // dotfiles and `..`
    const inside = (f: string) => f.startsWith(staticRoot + sep);
    let file = resolve(staticRoot, "." + (decoded === "/" ? "/index.html" : decoded));
    const usable = (f: string) => { try { return inside(f) && statSync(f).isFile() && inside(realpathSync(f)); } catch { return false; } };
    if (!inside(file)) return status(res, 404);
    if (!usable(file)) {
      if (extname(decoded) !== "") return status(res, 404); // missing asset, not an SPA route
      file = resolve(staticRoot, "index.html");
    }
    if (!usable(file)) return status(res, 404);
    const body = readFileSync(file); // throws on EACCES etc.; the handler turns that into a 500
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": body.length, "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (!hostOk(req)) return json(res, 403, { error: "forbidden host" });
    const [pathname = "/", query = ""] = (req.url ?? "/").split("?", 2);
    if (pathname === "/api/meta") return req.method === "GET" ? json(res, 200, { readOnly: opts.readOnly === true }) : status(res, 405);
    if (pathname === "/api/runs") return req.method === "GET" ? json(res, 200, store.listRuns()) : status(res, 405);
    const m = pathname.match(/^\/api\/runs\/([^/]+)(\/stop)?$/);
    if (!m) return serveStatic(req, res, pathname);
    const id = decode(m[1] ?? "");
    if (id === undefined || !RUN_ID.test(id)) return json(res, 400, { error: "invalid run id" });
    if (m[2]) {
      if (req.method !== "POST") return status(res, 405);
      if (opts.readOnly) return json(res, 405, { error: "read-only history view" });
      if (!originOk(req)) return json(res, 403, { error: "forbidden origin" });
      if (req.headers["x-mar"] !== "1") return json(res, 403, { error: "missing x-mar header" });
      if (!store.hasRun(id)) return json(res, 404, { error: "unknown run" });
      opts.onStop?.(id);
      return status(res, 204);
    }
    if (req.method !== "GET") return status(res, 405);
    if (!store.hasRun(id)) return json(res, 404, { error: "unknown run" });
    const rawLimit = new URLSearchParams(query).get("limit") ?? "";
    const limit = /^\d{1,9}$/.test(rawLimit) && Number(rawLimit) > 0 ? Math.min(Number(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
    const { events, truncated } = store.recentEvents(id, limit);
    return json(res, 200, { events, truncated, blackboard: store.listBb(id), tasks: store.taskStatuses(id), plan: store.loadPlan(id) ?? null,
      reports: store.listReports(id).map(({ task_id, body }) => ({ task_id, body })) });
  };

  const http = createServer((req, res) => {
    try { handle(req, res); } catch {
      // never leak stacks or paths; the request must not take the process down
      if (!res.headersSent) json(res, 500, { error: "internal" }); else res.destroy();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  wss.on("error", () => { /* per-socket errors are handled below */ });

  const attach = async (ws: WebSocket, run: string, after: number) => {
    let last = after;
    let replaying = true;
    const pending: StoredEvent[] = [];
    let off = () => {};
    const drop = (code?: number) => {
      off();
      if (code !== undefined && ws.readyState === ws.OPEN) {
        ws.close(code, "slow consumer");
        setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
      }
    };
    const emit = (e: StoredEvent) => {
      last = e.id;
      ws.send(JSON.stringify(e), (err) => { if (err) ws.terminate(); });
    };
    const send = (e: StoredEvent) => {
      if (e.id <= last || ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) return drop(1013);
      emit(e);
    };
    ws.on("error", () => { off(); ws.terminate(); });
    ws.on("close", () => off());
    // Subscribe first and buffer, so nothing appended during replay is lost or duplicated.
    off = store.onEvent((e) => {
      if (e.run_id !== run) return;
      if (!replaying) return send(e);
      pending.push(e);
      if (pending.length > MAX_PENDING) { pending.length = 0; drop(1013); }
    });
    try {
      // Replay in chunks; wait for the socket to drain between chunks (the cap applies to live events only).
      for (;;) {
        const page = store.listEvents(run, last, REPLAY_CHUNK);
        for (const e of page) if (ws.readyState === ws.OPEN) emit(e);
        if (page.length < REPLAY_CHUNK) break;
        while (ws.readyState === ws.OPEN && ws.bufferedAmount > MAX_BUFFERED / 2) await sleep(5);
        if (ws.readyState !== ws.OPEN) { off(); return; }
      }
      for (const e of pending) send(e);
    } catch {
      off();
      if (ws.readyState === ws.OPEN) ws.close(1011, "internal error");
    } finally { replaying = false; pending.length = 0; }
  };

  http.on("upgrade", (req, socket, head) => {
    if (!hostOk(req) || !originOk(req)) return rejectUpgrade(socket, 403, "Forbidden");
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { return rejectUpgrade(socket, 400, "Bad Request"); }
    if (url.pathname !== "/ws") return rejectUpgrade(socket, 404, "Not Found");
    const run = url.searchParams.get("run") ?? "";
    if (!RUN_ID.test(run)) return rejectUpgrade(socket, 400, "Bad Request");
    const rawAfter = url.searchParams.get("after") ?? "";
    const after = /^\d{1,15}$/.test(rawAfter) ? Number(rawAfter) : 0;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => ws.terminate());
      try {
        if (!store.hasRun(run)) return ws.close(1008, "unknown run");
      } catch { return ws.close(1011, "internal error"); }
      void attach(ws, run, after);
    });
  });

  await new Promise<void>((ok, fail) => { http.once("error", fail); http.listen(opts.port, "127.0.0.1", ok); });
  port = (http.address() as AddressInfo).port;
  return {
    port,
    address: () => http.address() as AddressInfo,
    close: () => new Promise<void>((done) => {
      for (const c of wss.clients) c.terminate();
      http.close(() => done());
      http.closeAllConnections();
    }),
  };
}
