import { describe, it, expect } from "vitest";
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
});
