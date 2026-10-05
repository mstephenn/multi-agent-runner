import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";

type RunSummary = { id: string };
type Snapshot = { events: { id: number }[]; blackboard: unknown[]; tasks: unknown[]; plan: unknown; truncated?: boolean };
const asJson = <T>(res: Response) => res.json() as Promise<T>;

let srv: Awaited<ReturnType<typeof startServer>> | undefined;
const tmpDirs: string[] = [];
afterEach(async () => {
  await srv?.close(); srv = undefined;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const ev = (s: Store, type: any = "task_started", payload: Record<string, unknown> = {}) => s.appendEvent({ run_id: "r", task_id: "a", agent_id: "a", type, payload });

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }
const raw = (port: number, path: string, o: { method?: string; headers?: Record<string, string> } = {}) =>
  new Promise<Raw>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject); r.end();
  });
// resolves "open" when the upgrade succeeds, else the HTTP status of the rejection or "close:<code>"
const wsProbe = (url: string, o: WebSocket.ClientOptions = {}) =>
  new Promise<string>((resolve) => {
    const ws = new WebSocket(url, o);
    ws.on("unexpected-response", (_q, res) => { resolve(String(res.statusCode)); ws.terminate(); });
    ws.on("error", () => { /* surfaced via unexpected-response/close */ });
    // a ping/pong round trip orders after any immediate server-side close (e.g. 1008), so "open" is settled deterministically
    ws.on("open", () => ws.ping());
    ws.on("pong", () => { resolve("open"); ws.close(); });
    ws.on("close", (code) => resolve(`close:${code}`));
  });
// Raw TCP websocket client that never reads until told to: a slow consumer without poking ws internals.
const slowClient = (port: number, run: string) =>
  new Promise<{ resume: () => Promise<Buffer>; destroy: () => void }>((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    sock.on("error", reject);
    sock.once("data", () => {
      sock.pause();
      resolve({
        destroy: () => sock.destroy(),
        resume: () => new Promise<Buffer>((done) => {
          const chunks: Buffer[] = [];
          sock.on("data", (d: Buffer) => chunks.push(d));
          sock.on("close", () => done(Buffer.concat(chunks)));
          sock.resume();
        }),
      });
    });
    sock.on("connect", () => sock.write(`GET /ws?run=${run} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
  });
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error("waitFor timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("server", () => {
  it("lists runs and returns a run snapshot", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x"); ev(s);
    srv = await startServer(s, { port: 0 });
    const runs = await asJson<RunSummary[]>(await fetch(`http://127.0.0.1:${srv.port}/api/runs`));
    expect(runs[0].id).toBe("r");
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/r`);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const snap = await asJson<Snapshot>(res);
    expect(snap.events).toHaveLength(1);
    expect(snap.blackboard).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.plan).toBeNull();
    s.savePlan("r", { tasks: [] } as any);
    expect((await asJson<Snapshot>(await fetch(`http://127.0.0.1:${srv.port}/api/runs/r`))).plan).toEqual({ tasks: [] });
  });

  it("replays after cursor then streams live events in order", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    const e1 = ev(s); ev(s, "usage");
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r&after=${e1.id}`);
    const got: any[] = [];
    await new Promise<void>((res) => { ws.on("message", (m) => { got.push(JSON.parse(m.toString())); if (got.length === 2) res(); }); ws.on("open", () => setTimeout(() => ev(s, "task_finished"), 20)); });
    expect(got.map((g) => g.type)).toEqual(["usage", "task_finished"]);
    ws.close();
  });

  it("only delivers events for the subscribed run", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x"); s.createRun("other", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    const got: any[] = [];
    ws.on("message", (m) => got.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on("open", r));
    s.appendEvent({ run_id: "other", task_id: null, agent_id: null, type: "task_started", payload: {} });
    ev(s);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
    ws.close();
  });

  it("does not duplicate an event appended between subscribe and replay end", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    ev(s);
    const orig = s.listEvents.bind(s);
    let injected = false;
    s.listEvents = (id: string, after?: number) => {
      if (!injected && id === "r") { injected = true; ev(s, "usage"); } // lands in both the live buffer and the replay
      return orig(id, after);
    };
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    const got: any[] = [];
    ws.on("message", (m) => got.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on("open", r));
    await new Promise((r) => setTimeout(r, 50));
    expect(got.map((g) => g.id)).toEqual([1, 2]);
    ws.close();
  });

  it("treats a bad `after` as 0", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x"); ev(s); ev(s);
    srv = await startServer(s, { port: 0 });
    for (const after of ["abc", "-5", "1.5", "NaN"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r&after=${after}`);
      const got: any[] = [];
      ws.on("message", (m) => got.push(JSON.parse(m.toString())));
      await new Promise((r) => ws.on("open", r));
      await waitFor(() => got.length >= 2);
      expect(got).toHaveLength(2);
      ws.close();
    }
  });

  it("closes the websocket with 1008 for an unknown run and 400s a malformed run id", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    srv = await startServer(s, { port: 0 });
    expect(await wsProbe(`ws://127.0.0.1:${srv.port}/ws?run=nope`)).toBe("close:1008");
    expect(await wsProbe(`ws://127.0.0.1:${srv.port}/ws?run=${encodeURIComponent("../x")}`)).toBe("400");
    expect(await wsProbe(`ws://127.0.0.1:${srv.port}/ws`)).toBe("400");
    expect(await wsProbe(`ws://127.0.0.1:${srv.port}/other?run=r`)).toBe("404");
    expect(s.subscriberCount).toBe(0);
  });

  it("removes every store subscription when sockets close or error", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const a = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    const b = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    const c = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    await Promise.all([a, b, c].map((w) => new Promise((r) => w.on("open", r))));
    expect(s.subscriberCount).toBe(3);
    a.close(); b.terminate(); // clean close and abrupt drop
    await waitFor(() => s.subscriberCount === 1);
    await srv.close(); srv = undefined; // closing the server terminates the rest
    await waitFor(() => s.subscriberCount === 0);
  });

  it("closes a slow client with 1013 once its live buffer exceeds 5 MB, and unsubscribes", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const c = await slowClient(srv.port, "r");
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 300 && s.subscriberCount > 0; i++) ev(s, "usage", { big });
    expect(s.subscriberCount).toBe(0);
    const data = await c.resume();
    // the final frame is an unmasked close frame: 0x88, len 15, code 1013 (0x03f5), "slow consumer"
    expect([...data.subarray(data.length - 17, data.length - 11)]).toEqual([0x88, 15, 0x03, 0xf5, ..."sl".split("").map((ch) => ch.charCodeAt(0))]);
  }, 20000);

  it("replays a large run (far above 5 MB) without a 1013, in order", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    const pad = "y".repeat(10_000);
    const N = 1500; // ~15 MB
    for (let i = 0; i < N; i++) ev(s, "usage", { i, pad });
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    const ids: number[] = []; let closed: number | undefined;
    ws.on("message", (m) => ids.push(JSON.parse(m.toString()).id));
    ws.on("close", (c) => { closed = c; });
    await waitFor(() => ids.length === N || closed !== undefined, 15000);
    expect(closed).toBeUndefined();
    expect(ids).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    ev(s, "usage"); // still live after replay
    await waitFor(() => ids.length === N + 1);
    ws.close();
  }, 30000);

  it("snapshot honours ?limit= (default, clamp) and reports truncated", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    for (let i = 0; i < 5; i++) ev(s, "usage", { i });
    srv = await startServer(s, { port: 0 });
    const get = async (q: string) => asJson<Snapshot>(await fetch(`http://127.0.0.1:${srv!.port}/api/runs/r${q}`));
    const cut = await get("?limit=2");
    expect(cut.events.map((e) => e.id)).toEqual([4, 5]);
    expect(cut.truncated).toBe(true);
    const all = await get("");
    expect(all.events).toHaveLength(5); expect(all.truncated).toBe(false);
    expect((await get("?limit=abc")).events).toHaveLength(5);
    expect((await get("?limit=0")).events).toHaveLength(5);
    expect((await get("?limit=999999999")).truncated).toBe(false);
  });

  it("rejects messages over 1 KB from the client (1009)", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    await new Promise((r) => ws.on("open", r));
    const code = new Promise<number>((r) => ws.on("close", (c) => r(c)));
    ws.send("z".repeat(2048));
    expect(await code).toBe(1009);
    await waitFor(() => s.subscriberCount === 0);
  });

  it("survives a malformed upgrade target and keeps serving", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const port = srv.port;
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1"); let out = "";
      sock.setEncoding("utf8"); sock.on("data", (d) => { out += d; }); sock.on("close", () => resolve(out)); sock.on("error", reject);
      sock.write(`GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect((await raw(port, "/api/runs")).status).toBe(200);
  });

  describe("error paths", () => {
    it("a throwing store yields a 500 JSON without stack or paths, and the server stays up", async () => {
      const s = new Store(":memory:"); s.createRun("r", "g", "/x");
      srv = await startServer(s, { port: 0 });
      const orig = s.listRuns.bind(s);
      s.listRuns = () => { throw new Error("boom /secret/path"); };
      const r = await raw(srv.port, "/api/runs");
      expect(r.status).toBe(500);
      expect(JSON.parse(r.body)).toEqual({ error: "internal" });
      s.loadPlan = () => { throw new Error("corrupt"); };
      expect((await raw(srv.port, "/api/runs/r")).status).toBe(500);
      s.listRuns = orig;
      expect((await raw(srv.port, "/api/runs")).status).toBe(200);
    });
    it("a throw during WS replay closes with 1011 and unsubscribes", async () => {
      const s = new Store(":memory:"); s.createRun("r", "g", "/x");
      srv = await startServer(s, { port: 0 });
      s.listEvents = () => { throw new Error("db gone"); };
      expect(await wsProbe(`ws://127.0.0.1:${srv.port}/ws?run=r`)).toBe("close:1011");
      await waitFor(() => s.subscriberCount === 0);
    });
    it("a throwing hasRun during upgrade closes with 1011", async () => {
      const s = new Store(":memory:"); s.createRun("r", "g", "/x");
      srv = await startServer(s, { port: 0 });
      s.hasRun = () => { throw new Error("db gone"); };
      expect(await wsProbe(`ws://127.0.0.1:${srv.port}/ws?run=r`)).toBe("close:1011");
      expect(s.subscriberCount).toBe(0);
    });
  });

  it("stop endpoint calls onStop; unknown run is 404; bad id is 400", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    let stopped = "";
    srv = await startServer(s, { port: 0, onStop: (id) => { stopped = id; } });
    const h = { "x-mar": "1" };
    expect((await raw(srv.port, "/api/runs/r/stop", { method: "POST", headers: h })).status).toBe(204);
    expect(stopped).toBe("r");
    expect((await raw(srv.port, "/api/runs/nope")).status).toBe(404);
    stopped = "";
    expect((await raw(srv.port, "/api/runs/nope/stop", { method: "POST", headers: h })).status).toBe(404);
    expect((await raw(srv.port, "/api/runs/bad%20id/stop", { method: "POST", headers: h })).status).toBe(400);
    expect((await raw(srv.port, "/api/runs/%E0%A4%A")).status).toBe(400);
    expect(stopped).toBe("");
  });

  it("binds to 127.0.0.1 only (real bound address)", async () => {
    srv = await startServer(new Store(":memory:"), { port: 0 });
    expect(srv.address().address).toBe("127.0.0.1");
    expect(srv.address().port).toBe(srv.port);
  });

  it("unknown routes are 404", async () => {
    srv = await startServer(new Store(":memory:"), { port: 0 });
    expect((await raw(srv.port, "/nope")).status).toBe(404);
    expect((await raw(srv.port, "/api/nope")).status).toBe(404);
  });

  describe("cross-origin protection", () => {
    it("rejects a forged Host on HTTP (DNS rebinding) and accepts localhost", async () => {
      const s = new Store(":memory:"); s.createRun("r", "g", "/x");
      srv = await startServer(s, { port: 0 });
      expect((await raw(srv.port, "/api/runs", { headers: { host: "evil.example" } })).status).toBe(403);
      expect((await raw(srv.port, "/api/runs", { headers: { host: `evil.example:${srv.port}` } })).status).toBe(403);
      expect((await raw(srv.port, "/api/runs", { headers: { host: "127.0.0.1" } })).status).toBe(403);
      expect((await raw(srv.port, "/api/runs", { headers: { host: `localhost:${srv.port}` } })).status).toBe(200);
      expect((await raw(srv.port, "/api/runs", { headers: { host: `127.0.0.1:${srv.port}` } })).status).toBe(200);
    });
    it("compares Host case-insensitively and ignores a trailing dot", async () => {
      srv = await startServer(new Store(":memory:"), { port: 0 });
      for (const h of [`LOCALHOST:${srv.port}`, `localhost.:${srv.port}`, `127.0.0.1.:${srv.port}`]) {
        expect((await raw(srv.port, "/api/runs", { headers: { host: h } })).status, h).toBe(200);
      }
      expect((await raw(srv.port, "/api/runs", { headers: { host: `evil.localhost:${srv.port}` } })).status).toBe(403);
      expect(await wsProbe(`ws://127.0.0.1:${srv.port}/ws?run=nope`, { origin: `HTTP://LOCALHOST.:${srv.port}` })).toBe("close:1008");
    });
    it("rejects forged Host and foreign Origin on WS upgrade", async () => {
      const s = new Store(":memory:"); s.createRun("r", "g", "/x");
      srv = await startServer(s, { port: 0 });
      const u = `ws://127.0.0.1:${srv.port}/ws?run=r`;
      expect(await wsProbe(u, { headers: { Host: "evil.example" } })).toBe("403");
      expect(await wsProbe(u, { origin: "http://evil.example" })).toBe("403");
      expect(await wsProbe(u, { origin: `http://127.0.0.1.evil.example:${srv.port}` })).toBe("403");
      expect(await wsProbe(u, { origin: "null" })).toBe("403");
      expect(await wsProbe(u, { origin: `http://localhost:${srv.port}` })).toBe("open");
      expect(await wsProbe(u, { origin: `http://127.0.0.1:${srv.port}` })).toBe("open");
      expect(await wsProbe(u)).toBe("open"); // non-browser client, no Origin
      await waitFor(() => s.subscriberCount === 0);
    });
    it("stop requires same-origin (if Origin present) and the x-mar header; sends no CORS headers", async () => {
      const s = new Store(":memory:"); s.createRun("r", "g", "/x");
      let stopped = 0;
      srv = await startServer(s, { port: 0, onStop: () => { stopped++; } });
      const p = "/api/runs/r/stop";
      expect((await raw(srv.port, p, { method: "POST" })).status).toBe(403);
      expect((await raw(srv.port, p, { method: "POST", headers: { "x-mar": "0" } })).status).toBe(403);
      expect((await raw(srv.port, p, { method: "POST", headers: { "x-mar": "1", origin: "http://evil.example" } })).status).toBe(403);
      expect((await raw(srv.port, p, { method: "POST", headers: { "x-mar": "1", host: "evil.example" } })).status).toBe(403);
      expect(stopped).toBe(0);
      const ok = await raw(srv.port, p, { method: "POST", headers: { "x-mar": "1", origin: `http://localhost:${srv.port}` } });
      expect(ok.status).toBe(204);
      expect(stopped).toBe(1);
      const pre = await raw(srv.port, p, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
      for (const r of [ok, pre]) expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
      expect(pre.status).not.toBe(204);
    });
  });

  describe("static files", () => {
    const setup = () => {
      const base = mkdtempSync(join(tmpdir(), "mar-static-"));
      const root = join(base, "web"); const evil = join(base, "web-evil");
      mkdirSync(join(root, "assets"), { recursive: true }); mkdirSync(evil);
      writeFileSync(join(root, "index.html"), "<html>INDEX</html>");
      writeFileSync(join(root, "assets", "a.js"), "console.log(1)");
      writeFileSync(join(root, ".env"), "SECRET=1");
      mkdirSync(join(root, ".git")); writeFileSync(join(root, ".git", "config"), "SECRET=2");
      writeFileSync(join(evil, "secret.txt"), "SECRET=3");
      writeFileSync(join(base, "outside.txt"), "SECRET=4");
      symlinkSync(join(base, "outside.txt"), join(root, "link.txt"));
      symlinkSync(base, join(root, "linkdir"));
      tmpDirs.push(base);
      return { root, base };
    };
    it("serves files, index at /, and SPA fallback with mime types", async () => {
      const { root } = setup();
      srv = await startServer(new Store(":memory:"), { port: 0, staticDir: root });
      const a = await raw(srv.port, "/assets/a.js");
      expect(a.status).toBe(200); expect(a.body).toBe("console.log(1)"); expect(a.headers["content-type"]).toContain("text/javascript");
      expect((await raw(srv.port, "/")).body).toContain("INDEX");
      expect((await raw(srv.port, "/some/spa/route")).body).toContain("INDEX");
      expect((await raw(srv.port, "/api/nope")).status).toBe(404);
    });
    it("serves HEAD without a body, 404s missing assets but falls back for extensionless routes", async () => {
      const { root } = setup();
      srv = await startServer(new Store(":memory:"), { port: 0, staticDir: root });
      const h = await raw(srv.port, "/assets/a.js", { method: "HEAD" });
      expect(h.status).toBe(200); expect(h.body).toBe(""); expect(h.headers["content-length"]).toBe("14");
      expect((await raw(srv.port, "/assets/missing.js")).status).toBe(404);
      expect((await raw(srv.port, "/favicon.ico")).status).toBe(404);
      expect((await raw(srv.port, "/runs/abc")).body).toContain("INDEX");
      expect((await raw(srv.port, "/", { method: "POST" })).status).toBe(405);
    });
    it("does not follow symlinks out of the root", async () => {
      const { root } = setup();
      srv = await startServer(new Store(":memory:"), { port: 0, staticDir: root });
      for (const p of ["/link.txt", "/linkdir/outside.txt"]) {
        const r = await raw(srv.port, p);
        expect(r.body, p).not.toContain("SECRET");
        expect(r.status, p).not.toBe(200);
      }
    });
    it.skipIf(process.getuid?.() === 0)("an unreadable file is a 500, not a crash", async () => {
      const { root } = setup();
      chmodSync(join(root, "assets", "a.js"), 0o000);
      srv = await startServer(new Store(":memory:"), { port: 0, staticDir: root });
      expect((await raw(srv.port, "/assets/a.js")).status).toBe(500);
      expect((await raw(srv.port, "/")).status).toBe(200);
    });
    it("blocks traversal, sibling-prefix dirs, malformed encoding and dotfiles", async () => {
      const { root } = setup();
      srv = await startServer(new Store(":memory:"), { port: 0, staticDir: root });
      for (const p of ["/..%2f..%2fetc/passwd", "/%2e%2e/x", "/%2e%2e/web-evil/secret.txt", "/../web-evil/secret.txt", "/..%2fweb-evil%2fsecret.txt", "/..%2foutside.txt", "/.env", "/%2eenv", "/.git/config", "/assets/%2e%2e/.env"]) {
        const r = await raw(srv.port, p);
        expect(r.body, p).not.toMatch(/SECRET|root:/);
        expect([400, 403, 404], p).toContain(r.status);
      }
      expect((await raw(srv.port, "/%E0%A4%A")).status).toBe(400);
      expect((await raw(srv.port, "/a%00b")).status).toBe(400);
    });
  });

  it("close() resolves with open sockets and in-flight keep-alive connections", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    ws.on("error", () => {});
    await new Promise((r) => ws.on("open", r));
    const hung = new Promise<void>((resolve) => {
      const r = request({ host: "127.0.0.1", port: srv!.port, path: "/api/runs", headers: { connection: "keep-alive" } }, (res) => { res.resume(); res.on("end", resolve); });
      r.on("error", () => resolve()); r.end();
    });
    await hung;
    await Promise.race([srv.close(), new Promise((_, rej) => setTimeout(() => rej(new Error("close hung")), 3000))]);
    srv = undefined;
  });
});
