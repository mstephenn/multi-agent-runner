import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";

const mk = () => { const s = new Store(":memory:"); s.createRun("r1", "goal", "/repo"); return s; };

describe("Store", () => {
  it("appends events with increasing ids and returns them after a cursor", () => {
    const s = mk();
    const a = s.appendEvent({ run_id: "r1", task_id: "t", agent_id: "t", type: "task_started", payload: {} });
    const b = s.appendEvent({ run_id: "r1", task_id: "t", agent_id: "t", type: "usage", payload: { input: 1 } });
    expect(b.id).toBeGreaterThan(a.id);
    expect(s.listEvents("r1", a.id).map((e) => e.id)).toEqual([b.id]);
    expect(b.payload).toEqual({ input: 1 });
  });
  it("versions blackboard entries per key and returns the latest", () => {
    const s = mk();
    const w = { run_id: "r1", key: "a/summary", author_task: "a", kind: "summary" as const, body: "v1", refs: [] };
    expect(s.writeBb(w).version).toBe(1);
    expect(s.writeBb({ ...w, body: "v2" }).version).toBe(2);
    expect(s.latestBb("r1", "a/summary")?.body).toBe("v2");
    expect(s.listBb("r1")).toHaveLength(2);
  });
  it("rejects oversize blackboard bodies", () => {
    const s = mk();
    expect(() => s.writeBb({ run_id: "r1", key: "a/summary", author_task: "a", kind: "summary", body: "x".repeat(1201), refs: [] })).toThrow(/too large|cap/i);
  });
  it("notifies subscribers and supports unsubscribe", () => {
    const s = mk(); const seen: number[] = [];
    const off = s.onEvent((e) => seen.push(e.id));
    s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started", payload: {} });
    off();
    s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started", payload: {} });
    expect(seen).toHaveLength(1);
  });
  it("persists task statuses", () => {
    const s = mk();
    s.setTaskStatus("r1", "a", "running"); s.setTaskStatus("r1", "a", "failed", "failed:budget");
    expect(s.taskStatuses("r1")).toEqual([{ task_id: "a", status: "failed", detail: "failed:budget" }]);
  });
  it("round-trips a saved plan", () => {
    const s = mk();
    const dag = { tasks: [{ id: "a", dependsOn: [], needs: [] }] } as any;
    s.savePlan("r1", dag);
    expect(s.loadPlan("r1")).toEqual(dag);
  });
  it("returns undefined for an unknown plan", () => {
    expect(mk().loadPlan("nope")).toBeUndefined();
  });
  it("overwrites the plan when saved twice", () => {
    const s = mk();
    s.savePlan("r1", { tasks: [{ id: "a" }] } as any);
    const second = { tasks: [{ id: "b" }] } as any;
    s.savePlan("r1", second);
    expect(s.loadPlan("r1")).toEqual(second);
  });
  it("isolates subscriber errors from the append", () => {
    const s = mk(); const seen: number[] = [];
    s.onEvent(() => { throw new Error("socket closed"); });
    s.onEvent((e) => seen.push(e.id));
    const e = s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started", payload: {} });
    expect(seen).toEqual([e.id]);
    expect(s.listEvents("r1").map((x) => x.id)).toEqual([e.id]);
  });

  it("accepts a body of exactly 1200 chars", () => {
    const s = mk();
    expect(s.writeBb({ run_id: "r1", key: "k", author_task: "a", kind: "summary", body: "x".repeat(1200), refs: [] }).version).toBe(1);
  });
  it("versions independently per key and per run", () => {
    const s = mk(); s.createRun("r2", "g", "/x");
    const w = { run_id: "r1", key: "a", author_task: "a", kind: "summary" as const, body: "b", refs: [] };
    s.writeBb(w); s.writeBb(w);
    expect(s.writeBb({ ...w, key: "b" }).version).toBe(1);
    expect(s.writeBb({ ...w, run_id: "r2" }).version).toBe(1);
    expect(s.writeBb(w).version).toBe(3);
  });
  it("stores null detail and null task_id rows", () => {
    const s = mk();
    s.setTaskStatus("r1", "a", "running");
    expect(s.taskStatuses("r1")).toEqual([{ task_id: "a", status: "running", detail: null }]);
    s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started", payload: {} });
    expect(s.listEvents("r1")[0]).toMatchObject({ task_id: null, agent_id: null });
  });
  it("isolates events per run in listEvents", () => {
    const s = mk(); s.createRun("r2", "g", "/x");
    s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started", payload: {} });
    const o = s.appendEvent({ run_id: "r2", task_id: null, agent_id: null, type: "task_started", payload: {} });
    expect(s.listEvents("r2").map((e) => e.id)).toEqual([o.id]);
    expect(s.listEvents("r1")).toHaveLength(1);
  });
  it("pages listEvents with a limit and returns the most recent events with truncated", () => {
    const s = mk();
    for (let i = 0; i < 5; i++) s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "usage", payload: { i } });
    expect(s.listEvents("r1", 0, 2).map((e) => e.id)).toEqual([1, 2]);
    expect(s.recentEvents("r1", 2)).toMatchObject({ truncated: true });
    expect(s.recentEvents("r1", 2).events.map((e) => e.id)).toEqual([4, 5]);
    expect(s.recentEvents("r1", 5).truncated).toBe(false);
  });
  it("tolerates an undefined payload", () => {
    const s = mk();
    const e = s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started" } as never);
    expect(e.payload).toEqual({});
    expect(s.listEvents("r1")[0]?.payload).toEqual({});
  });
  it("hasRun and close", () => {
    const s = mk();
    expect(s.hasRun("r1")).toBe(true);
    expect(s.hasRun("nope")).toBe(false);
    s.close();
    expect(() => s.hasRun("r1")).toThrow();
  });

  describe("on-disk backstops", () => {
    const dirs: string[] = [];
    const file = () => { const d = mkdtempSync(join(tmpdir(), "mar-store-")); dirs.push(d); return join(d, "t.db"); };
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    it("has a UNIQUE(run_id,key,version) backstop", () => {
      const f = file(); const s = mk2(f);
      s.writeBb({ run_id: "r1", key: "k", author_task: "a", kind: "summary", body: "b", refs: [] });
      const raw = new Database(f);
      expect(() => raw.prepare("INSERT INTO bb_entries (run_id,key,author_task,version,ts,kind,body,refs) VALUES ('r1','k','a',1,0,'summary','b','[]')").run()).toThrow(/UNIQUE/);
      raw.close(); s.close();
    });
    it("two stores on one file never produce duplicate versions", () => {
      const f = file(); const a = mk2(f); const b = new Store(f);
      const w = { run_id: "r1", key: "k", author_task: "a", kind: "summary" as const, body: "b", refs: [] };
      const versions = [a.writeBb(w), b.writeBb(w), a.writeBb(w), b.writeBb(w)].map((e) => e.version);
      expect(versions).toEqual([1, 2, 3, 4]);
      a.close(); b.close();
    });
    it("a corrupt event payload or refs row does not break reads (placeholder)", () => {
      const f = file(); const s = mk2(f);
      const ok = s.appendEvent({ run_id: "r1", task_id: "t", agent_id: "t", type: "usage", payload: { n: 1 } });
      s.writeBb({ run_id: "r1", key: "k", author_task: "a", kind: "summary", body: "b", refs: ["x"] });
      const raw = new Database(f);
      raw.prepare("INSERT INTO events (run_id,task_id,agent_id,ts,type,payload) VALUES ('r1','t','t',0,'usage','{bad')").run();
      raw.prepare("UPDATE bb_entries SET refs='{bad'").run();
      raw.close();
      const evs = s.listEvents("r1");
      expect(evs).toHaveLength(2);
      expect(evs[0]).toMatchObject({ id: ok.id, payload: { n: 1 } });
      expect(evs[1]?.payload).toEqual({ corrupt: true });
      expect(s.listBb("r1")[0]?.refs).toEqual([]);
      expect(s.latestBb("r1", "k")?.body).toBe("b");
      s.close();
    });
    it("a corrupt plan throws an error naming the run", () => {
      const f = file(); const s = mk2(f);
      s.savePlan("r1", { tasks: [] } as never);
      const raw = new Database(f); raw.prepare("UPDATE plans SET dag='{bad'").run(); raw.close();
      expect(() => s.loadPlan("r1")).toThrow(/corrupt plan for run r1/);
      s.close();
    });
  });
});
const mk2 = (f: string) => { const s = new Store(f); s.createRun("r1", "goal", "/repo"); return s; };

describe("Store reports", () => {
  it("saves, upserts and lists reports in insertion order, isolated per run", () => {
    const s = mk(); s.createRun("r2", "g", "/repo");
    s.saveReport("r1", "b", "B1");
    s.saveReport("r1", "a", "A1");
    s.saveReport("r2", "a", "OTHER");
    s.saveReport("r1", "b", "B2"); // upsert keeps position
    const l = s.listReports("r1");
    expect(l.map((r) => [r.task_id, r.body])).toEqual([["b", "B2"], ["a", "A1"]]);
    expect(typeof l[0]!.ts).toBe("number");
    expect(s.listReports("r2").map((r) => r.body)).toEqual(["OTHER"]);
    expect(s.listReports("none")).toEqual([]);
  });
  it("stores long reports in full and truncates beyond 100k with a visible marker", () => {
    const s = mk();
    s.saveReport("r1", "a", "y".repeat(100_000));
    expect(s.listReports("r1")[0]!.body).toHaveLength(100_000);
    s.saveReport("r1", "b", "y".repeat(100_001));
    const b = s.listReports("r1")[1]!.body;
    expect(b.length).toBeLessThanOrEqual(100_000);
    expect(b.endsWith("…[truncated]")).toBe(true);
  });
});
