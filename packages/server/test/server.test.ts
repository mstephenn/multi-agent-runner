import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";

let srv: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });
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
    // an immediate server-side close (e.g. 1008) arrives right after "open", so settle "open" only if no close follows
    let t: NodeJS.Timeout | undefined;
    ws.on("open", () => { t = setTimeout(() => { resolve("open"); ws.close(); }, 50); });
    ws.on("close", (code) => { clearTimeout(t); resolve(`close:${code}`); });
  });
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error("waitFor timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("server", () => {
  it("lists runs and returns a run snapshot", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x"); ev(s);
    srv = await startServer(s, { port: 0 });
    const runs = await (await fetch(`http://127.0.0.1:${srv.port}/api/runs`)).json();
    expect(runs[0].id).toBe("r");
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs/r`);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const snap = await res.json();
    expect(snap.events).toHaveLength(1);
    expect(snap.blackboard).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.plan).toBeNull();
    s.savePlan("r", { tasks: [] } as any);
    expect((await (await fetch(`http://127.0.0.1:${srv.port}/api/runs/r`)).json()).plan).toEqual({ tasks: [] });
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

  it("closes a slow client with 1013 once its buffer exceeds 5 MB, and unsubscribes", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    await new Promise((r) => ws.on("open", r));
    (ws as any)._socket.pause();
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 200 && s.subscriberCount > 0; i++) ev(s, "usage", { big });
    expect(s.subscriberCount).toBe(0);
    const code = await new Promise<number>((r) => { ws.on("close", (c) => r(c)); (ws as any)._socket.resume(); });
    expect(code).toBe(1013);
  }, 20000);

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
