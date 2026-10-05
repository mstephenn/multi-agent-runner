import { describe, it, expect } from "vitest";
import { deriveAgents, deriveFlow, deriveContext, deriveLanes, deriveActivity, totals } from "../src/derive.js";

let id = 0;
const e = (task: string | null, type: string, payload: object = {}, ts = 1000 + id) => ({ id: ++id, run_id: "r", task_id: task, agent_id: task, ts, type, payload }) as any;

describe("derive", () => {
  it("builds agent views with tokens null when no usage was reported", () => {
    const a = deriveAgents([e("a", "task_started", { runtime: "codex", tier: "mid", role: "implementer" })], [{ task_id: "a", status: "running", detail: null }]);
    expect(a[0]).toMatchObject({ id: "a", runtime: "codex", status: "running", tokens: null });
  });
  it("sums usage across events and keeps failure detail", () => {
    const a = deriveAgents([
      e("a", "task_started"), e("a", "usage", { input: 10, output: 5, costUsd: 0.01 }), e("a", "usage", { input: 1, output: null, costUsd: null }),
    ], [{ task_id: "a", status: "failed", detail: "failed:budget" }]);
    expect(a[0]).toMatchObject({ tokens: 16, costUsd: 0.01, status: "failed", detail: "failed:budget" });
  });
  it("derives flow edges from blackboard_read events", () => {
    const f = deriveFlow([e("b", "blackboard_read", { key: "a/summary", version: 2, tokens: 40, author: "a" })]);
    expect(f).toEqual([{ from: "a", to: "b", key: "a/summary", version: 2, tokens: 40 }]);
  });
  it("derives the context a task actually received", () => {
    const c = deriveContext([e("b", "prompt_sent", { prompt: "P", keys: ["a/summary"], tokens: 9 }), e("b", "blackboard_read", { key: "a/summary", version: 1, tokens: 7, author: "a" })], "b");
    expect(c.prompt).toBe("P"); expect(c.slices).toEqual([{ key: "a/summary", version: 1, tokens: 7 }]);
  });
  it("returns an empty context for a task that has not started", () => {
    expect(deriveContext([], "zzz")).toEqual({ prompt: null, slices: [], notGiven: [] });
  });
  it("derives timeline lanes with open end for running tasks", () => {
    const l = deriveLanes([e("a", "task_started", {}, 100), e("a", "task_finished", {}, 200), e("b", "task_started", {}, 150)]);
    expect(l).toEqual([{ id: "a", start: 100, end: 200 }, { id: "b", start: 150, end: null }]);
  });
});

describe("deriveAgents edge cases", () => {
  it("keeps tokens null when usage has no numeric fields", () => {
    const a = deriveAgents([e("a", "usage", { input: null, output: "x" }), e("a", "usage", {})], []);
    expect(a[0].tokens).toBeNull();
    expect(a[0].costUsd).toBeNull();
  });
  it("counts a single numeric field and ignores non-finite numbers", () => {
    const a = deriveAgents([e("a", "usage", { input: 4 }), e("a", "usage", { input: NaN, output: Infinity, costUsd: NaN })], []);
    expect(a[0].tokens).toBe(4);
    expect(a[0].costUsd).toBeNull();
  });
  it("derives status from events when no store row exists", () => {
    const a = deriveAgents([e("a", "task_started"), e("b", "task_started"), e("b", "task_finished"), e("c", "task_started"), e("c", "task_failed"), e("d", "blackboard_read", { key: "k", version: 1, author: "a" })], []);
    expect(a.map((x) => [x.id, x.status])).toEqual([["a", "running"], ["b", "done"], ["c", "failed"], ["d", "pending"]]);
  });
  it("store status wins over events, and invalid store status falls back", () => {
    const a = deriveAgents([e("a", "task_started"), e("b", "task_started"), e("b", "task_finished")], [{ task_id: "a", status: "blocked", detail: null }, { task_id: "b", status: "weird", detail: null }]);
    expect(a.map((x) => x.status)).toEqual(["blocked", "done"]);
  });
  it("tolerates out-of-order task_finished before task_started", () => {
    const a = deriveAgents([e("a", "task_finished", {}, 200), e("a", "task_started", { role: "r" }, 100)], []);
    expect(a[0]).toMatchObject({ status: "done", startedAt: 100, endedAt: 200, role: "r" });
  });
  it("keeps first-seen order, exposes unsafe, and does not throw on odd payloads", () => {
    const a = deriveAgents([e("z", "task_started", { unsafe: true, role: 5 }), e("y", "task_started", { unsafe: "yes" }), e("x", "usage", null as any)], [{ task_id: "w", status: "pending", detail: "d" }]);
    expect(a.map((x) => x.id)).toEqual(["w", "z", "y", "x"]);
    expect(a[1]).toMatchObject({ unsafe: true });
    expect(a[1].role).toBeUndefined();
    expect(a[2].unsafe).toBe(false);
    expect(a[0].detail).toBe("d");
  });
  it("does not mutate inputs", () => {
    const evs = [e("a", "task_started"), e("a", "usage", { input: 1 })];
    const tasks = [{ task_id: "a", status: "running", detail: null }];
    const snap = JSON.stringify([evs, tasks]);
    deriveAgents(evs, tasks); deriveFlow(evs); deriveLanes(evs); deriveContext(evs, "a"); deriveActivity(evs, "a");
    expect(JSON.stringify([evs, tasks])).toBe(snap);
  });
});

describe("deriveFlow edge cases", () => {
  it("dedupes identical edges and ignores reads without a string author", () => {
    const r = (author: any, version = 1) => e("b", "blackboard_read", { key: "k", version, tokens: 3, author });
    const f = deriveFlow([r("a"), r("a"), r(undefined), r(5), r("a", 2)]);
    expect(f.map((x) => x.version)).toEqual([1, 2]);
  });
  it("defaults non-finite tokens to 0 and skips malformed reads", () => {
    const f = deriveFlow([e("b", "blackboard_read", { key: "k", version: 1, tokens: NaN, author: "a" }), e("b", "blackboard_read", { version: 1, author: "a" }), e(null, "blackboard_read", { key: "k", version: 1, author: "a" })]);
    expect(f).toEqual([{ from: "a", to: "b", key: "k", version: 1, tokens: 0 }]);
  });
});

describe("deriveContext edge cases", () => {
  it("uses the last prompt_sent and computes notGiven from allKeys", () => {
    const evs = [e("b", "prompt_sent", { prompt: "old", keys: ["x"] }), e("b", "prompt_sent", { prompt: "new", keys: ["a", "b"] }), e("c", "prompt_sent", { prompt: "other", keys: [] })];
    const c = deriveContext(evs, "b", ["a", "b", "c", "d"]);
    expect(c.prompt).toBe("new");
    expect(c.notGiven).toEqual(["c", "d"]);
    expect(deriveContext(evs, "b").notGiven).toEqual([]);
  });
  it("returns no notGiven when the task never received a prompt", () => {
    expect(deriveContext([], "q", ["a"]).notGiven).toEqual([]);
  });
});

describe("deriveLanes edge cases", () => {
  it("handles finish before start and failed tasks, ignoring tasks never started", () => {
    const l = deriveLanes([e("a", "task_finished", {}, 200), e("a", "task_started", {}, 100), e("b", "task_failed", {}, 50), e("c", "task_started", {}, 10), e("c", "task_failed", {}, 20)]);
    expect(l).toEqual([{ id: "a", start: 100, end: 200 }, { id: "c", start: 10, end: 20 }]);
  });
});

describe("deriveActivity", () => {
  it("maps text and tool events for a task only", () => {
    const a = deriveActivity([
      e("a", "assistant_text", { text: "hi" }, 5), e("b", "assistant_text", { text: "no" }), e("a", "usage", { input: 1 }),
      e("a", "tool_call", { name: "shell", input: { command: "ls" } }, 6), e("a", "tool_result", { name: "shell", output: "out", isError: true }, 7),
    ], "a");
    expect(a.map((x) => [x.kind, x.ts])).toEqual([["text", 5], ["tool_call", 6], ["tool_result", 7]]);
    expect(a[0].text).toBe("hi");
    expect(a[1].text).toContain("shell");
    expect(a[1].text).toContain("ls");
    expect(a[2]).toMatchObject({ text: "out", isError: true });
    expect(a[0].isError).toBeUndefined();
  });
  it("truncates to 500 chars with an ellipsis", () => {
    const [x] = deriveActivity([e("a", "assistant_text", { text: "x".repeat(900) })], "a");
    expect(x.text.length).toBe(500);
    expect(x.text.endsWith("…")).toBe(true);
  });
  it("stringifies circular objects safely and tolerates odd payloads", () => {
    const o: any = { n: 1 }; o.self = o;
    const a = deriveActivity([e("a", "tool_call", { name: "t", input: o }), e("a", "tool_result", {}), e("a", "assistant_text", { text: 5 })], "a");
    expect(a).toHaveLength(3);
    expect(a[0].text).toContain("[Circular]");
  });
});

describe("totals", () => {
  it("sums only non-null tokens and costs", () => {
    const base = { status: "done" as const, costUsd: null };
    expect(totals([{ ...base, id: "a", tokens: 5, costUsd: 0.5 }, { ...base, id: "b", tokens: null }, { ...base, id: "c", tokens: 2, costUsd: 0.25 }] as any)).toEqual({ tokens: 7, costUsd: 0.75 });
    expect(totals([{ ...base, id: "b", tokens: null }] as any)).toEqual({ tokens: 0, costUsd: null });
    expect(totals([])).toEqual({ tokens: 0, costUsd: null });
  });
});

describe("performance", () => {
  it("handles 50k events in well under a second", () => {
    const evs: any[] = [];
    for (let i = 0; i < 50_000; i++) {
      const t = `t${i % 200}`;
      evs.push(i % 3 === 0 ? e(t, "usage", { input: 1, output: 1, costUsd: 0.001 }) : i % 3 === 1 ? e(t, "blackboard_read", { key: `k${i % 50}`, version: 1, tokens: 2, author: `t${(i + 1) % 200}` }) : e(t, "task_started", {}, i));
    }
    const t0 = performance.now();
    totals(deriveAgents(evs, [])); deriveFlow(evs); deriveLanes(evs); deriveContext(evs, "t1"); deriveActivity(evs, "t1");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
