import { describe, it, expect } from "vitest";
import { Store } from "../../server/src/store.js";
import { parseDag } from "@mar/core";
import { runDag } from "../src/scheduler.js";
import { fakeAdapter, ok } from "./fakeAdapter.js";

const T = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `do ${id}`, paths: [`${id}/**`], ...extra });
function harness(tasks: any[], script: any, over: object = {}) {
  const store = new Store(":memory:"); store.createRun("r", "g", "/repo");
  const claude = fakeAdapter(script, "claude");
  const codex = fakeAdapter(script, "codex");
  const commits: string[] = [];
  const deps = {
    store, runId: "r", dag: parseDag({ tasks }), repo: "/repo",
    adapters: { claude: claude.adapter, codex: codex.adapter },
    worktrees: { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async (_id: string, m: string) => { commits.push(m); } },
    modelFor: (_r: string, tier: string) => tier, toolsFor: () => ["Read"], concurrency: 1, ...over,
  };
  return { store, claude, codex, commits, deps: deps as any };
}
const types = (store: Store, t: string) => store.listEvents("r").filter((e) => e.type === t);

describe("self-healing", () => {
  it("retries an adapter error with the failure fed back, then succeeds", async () => {
    const { store, claude, deps } = harness([T("a")], (_i: any, n: number) => (n < 3 ? new Error(`boom ${n}`) : ok()), { maxRetries: 3 });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(claude.calls).toHaveLength(3);
    expect(claude.calls[1].prompt).toContain("boom 1");
    expect(claude.calls[2].prompt).toContain("boom 2");
    expect(claude.calls[1].prompt).toContain("Resumed task");
    expect(types(store, "task_retry")).toHaveLength(2);
    expect(types(store, "task_failed")).toHaveLength(0);
  });
  it("marks the task failed only after retries are exhausted", async () => {
    const { store, claude, deps } = harness([T("a"), T("b", { dependsOn: ["a"] })], () => new Error("always"), { maxRetries: 2 });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked" });
    expect(claude.calls).toHaveLength(3);
    expect(types(store, "task_failed")).toHaveLength(1);
  });
  it("without maxRetries behaves as before (single attempt)", async () => {
    const { claude, deps } = harness([T("a")], () => new Error("x"));
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(claude.calls).toHaveLength(1);
  });
  it("preserves partial work: commits a wip on each failed attempt", async () => {
    const { commits, deps } = harness([T("a")], (_i: any, n: number) => (n === 1 ? new Error("crash") : ok()), { maxRetries: 1 });
    await runDag(deps);
    expect(commits.some((m) => m.includes("wip (failed attempt)"))).toBe(true);
  });
  it("retries a verify failure", async () => {
    let calls = 0;
    const { store, deps } = harness([T("a")], () => ok(), {
      maxRetries: 2,
      verify: { commands: ["x"], timeoutMs: 1000 },
      runVerify: async () => (++calls === 1
        ? { ok: false, failed: { command: "x", code: 1, timedOut: false }, tail: "TEST FAILED", ms: 1 }
        : { ok: true, ms: 1 }),
    });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(types(store, "task_retry")).toHaveLength(1);

  });
  it("retries a timeout", async () => {
    const h = harness([T("a")], () => ok(), { maxRetries: 1, taskTimeoutMs: 20 });
    let first = true;
    h.deps.adapters.claude = { runtime: "claude", async *run(i: any) { if (first) { first = false; await new Promise((r) => setTimeout(r, 200)); return; } yield* h.claude.adapter.run(i); } };
    expect(await runDag(h.deps)).toEqual({ a: "done" });
    expect(types(h.store, "task_retry")).toHaveLength(1);
  });
  it("escalates the tier on the final retry", async () => {
    const { store, claude, deps } = harness([T("a", { tier: "low" })], (_i: any, n: number) => (n < 3 ? new Error("x") : ok()), { maxRetries: 2 });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(claude.calls.map((c) => c.model)).toEqual(["low", "low", "mid"]);
    const retries = types(store, "task_retry");
    expect(retries.map((e) => (e.payload as any).escalated)).toEqual([false, true]);
  });
  it("switches runtime on the final retry when already at the top tier", async () => {
    const { store, claude, codex, deps } = harness([T("a", { tier: "high" })], () => ok(), { maxRetries: 1 });
    const failing = fakeAdapter(() => new Error("x"), "claude");
    deps.adapters.claude = failing.adapter;
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(failing.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(1);
    expect((types(store, "task_retry")[0].payload as any).runtime).toBe("codex");
  });
});
