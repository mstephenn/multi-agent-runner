import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";

const dirs: string[] = [];
let srv: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "mar-ro-")); dirs.push(d); return d; };
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

const seed = (path: string) => {
  const s = new Store(path);
  s.createRun("r1", "goal", "/repo");
  s.appendEvent({ run_id: "r1", task_id: "a", agent_id: "a", type: "usage", payload: { input: 5, output: 7 } });
  s.setTaskStatus("r1", "a", "done");
  s.saveReport("r1", "a", "REPORT");
  s.close();
};

describe("Store readOnly", () => {
  it("reads a closed DB, does not touch it and leaves no -wal/-shm behind", () => {
    const d = tmp(); const p = join(d, "mar.db"); seed(p);
    const before = { sha: sha(p), mtime: statSync(p).mtimeMs, files: readdirSync(d).sort() };
    const s = new Store(p, { readOnly: true });
    expect(s.listRuns().map((r) => r.id)).toEqual(["r1"]);
    expect(s.usageTokens("r1")).toBe(12);
    expect(s.listReports("r1")[0]?.body).toBe("REPORT");
    s.close();
    expect({ sha: sha(p), mtime: statSync(p).mtimeMs, files: readdirSync(d).sort() }).toEqual(before);
  });
  it("sees committed rows that are still in the -wal of a live writer, without modifying files", () => {
    const d = tmp(); const p = join(d, "mar.db"); seed(p);
    const live = new Store(p); // keeps the WAL open
    live.createRun("r2", "second", "/repo");
    const before = { sha: sha(p), files: readdirSync(d).sort() };
    const s = new Store(p, { readOnly: true });
    expect(s.listRuns().map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    s.close();
    expect({ sha: sha(p), files: readdirSync(d).sort() }).toEqual(before);
    live.close();
  });
  it("never creates a missing file and says so", () => {
    const d = tmp(); const p = join(d, "nope.db");
    expect(() => new Store(p, { readOnly: true })).toThrow(/no such database|not found|does not exist/i);
    expect(existsSync(p)).toBe(false);
    expect(() => new Store(":memory:", { readOnly: true })).toThrow();
  });
  it("write methods throw", () => {
    const d = tmp(); const p = join(d, "mar.db"); seed(p);
    const s = new Store(p, { readOnly: true });
    const dag = { tasks: [] };
    for (const f of [
      () => s.createRun("x", "g", "r"),
      () => s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "usage", payload: {} }),
      () => s.writeBb({ run_id: "r1", key: "k", author_task: "a", kind: "summary", body: "b", refs: [] }),
      () => s.setTaskStatus("r1", "a", "failed"),
      () => s.saveReport("r1", "a", "x"),
      () => s.savePlan("r1", dag),
      () => s.savePhase("r1", 1, dag, "", "done"),
      () => s.setPhaseStatus("r1", 1, "done"),
    ]) expect(f).toThrow(/read-only/);
    s.close();
  });
  it("older DBs without newer tables degrade to empty reads", () => {
    const d = tmp(); const p = join(d, "old.db");
    const raw = new Database(p);
    raw.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, goal TEXT, repo TEXT, created INTEGER);
      INSERT INTO runs VALUES ('r1','g','/r',1);`);
    raw.close();
    const s = new Store(p, { readOnly: true });
    expect(s.listRuns()).toHaveLength(1);
    expect(s.listPhases("r1")).toEqual([]);
    expect(s.listReports("r1")).toEqual([]);
    expect(s.loadPlan("r1")).toBeUndefined();
    expect(s.listEvents("r1")).toEqual([]);
    expect(s.listBb("r1")).toEqual([]);
    expect(s.taskStatuses("r1")).toEqual([]);
    expect(s.usageTokens("r1")).toBe(0);
    expect(s.recentEvents("r1", 5)).toEqual({ events: [], truncated: false });
    expect(s.hasRun("r1")).toBe(true);
    s.close();
  });
  it("exposes lastEventTs and eventsOfType", () => {
    const d = tmp(); const p = join(d, "mar.db"); seed(p);
    const s = new Store(p, { readOnly: true });
    expect(typeof s.lastEventTs("r1")).toBe("number");
    expect(s.lastEventTs("nope")).toBeUndefined();
    expect(s.eventsOfType("r1", ["usage"])).toHaveLength(1);
    expect(s.eventsOfType("r1", ["integration"])).toHaveLength(0);
    s.close();
  });
});

describe("server readOnly", () => {
  const get = (port: number, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
  it("GET /api/meta reports readOnly (false by default)", async () => {
    srv = await startServer(new Store(":memory:"), { port: 0 });
    expect(await (await get(srv.port, "/api/meta")).json()).toEqual({ readOnly: false });
    await srv.close();
    const d = tmp(); const p = join(d, "mar.db"); seed(p);
    srv = await startServer(new Store(p, { readOnly: true }), { port: 0, readOnly: true });
    expect(await (await get(srv.port, "/api/meta")).json()).toEqual({ readOnly: true });
  });
  it("/api/meta enforces Host and method", async () => {
    srv = await startServer(new Store(":memory:"), { port: 0 });
    const { request } = await import("node:http");
    const status = (headers: Record<string, string>, method = "GET") => new Promise<number>((res, rej) => {
      const r = request({ host: "127.0.0.1", port: srv!.port, path: "/api/meta", method, headers }, (x) => { x.resume(); res(x.statusCode ?? 0); });
      r.on("error", rej); r.end();
    });
    expect(await status({ host: "evil.example" })).toBe(403);
    expect(await status({}, "POST")).toBe(405);
  });
  it("stop is 405 and never calls onStop; snapshot serving leaves the DB bytes and mtime unchanged", async () => {
    const d = tmp(); const p = join(d, "mar.db"); seed(p);
    const before = { sha: sha(p), mtime: statSync(p).mtimeMs, files: readdirSync(d).sort() };
    let stopped = 0;
    const store = new Store(p, { readOnly: true });
    srv = await startServer(store, { port: 0, readOnly: true, onStop: () => { stopped++; } });
    const res = await get(srv.port, "/api/runs/r1/stop", { method: "POST", headers: { "x-mar": "1" } });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "read-only history view" });
    expect(stopped).toBe(0);
    const snap = await (await get(srv.port, "/api/runs/r1")).json() as { events: unknown[]; reports: unknown[] };
    expect(snap.events).toHaveLength(1);
    expect(snap.reports).toHaveLength(1);
    await srv.close(); srv = undefined; store.close();
    expect({ sha: sha(p), mtime: statSync(p).mtimeMs, files: readdirSync(d).sort() }).toEqual(before);
  });
});
