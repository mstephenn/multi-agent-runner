import { describe, it, expect, vi } from "vitest";
import { Store } from "../../server/src/store.js";
import { parseDag } from "@mar/core";
import { runDag } from "../src/scheduler.js";
import { fakeAdapter, ok } from "./fakeAdapter.js";

const T = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `do ${id}`, ...extra });
function harness(tasks: any[], script: any, over: object = {}) {
  const store = new Store(":memory:"); store.createRun("r", "g", "/repo");
  const f = fakeAdapter(script);
  const deps = {
    store, runId: "r", dag: parseDag({ tasks }), repo: "/repo",
    adapters: { claude: f.adapter, codex: f.adapter },
    worktrees: { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {} },
    modelFor: () => null, toolsFor: () => ["Read"], concurrency: 2, ...over,
  };
  return { store, f, deps };
}

describe("runDag", () => {
  it("runs in dependency order and passes only needed slices", async () => {
    const { store, f, deps } = harness([T("a"), T("b", { dependsOn: ["a"], needs: ["a/summary"] })], () => ok("A-RESULT"));
    const res = await runDag(deps);
    expect(res).toEqual({ a: "done", b: "done" });
    const bPrompt = f.calls.find((c) => c.taskId === "b")!.prompt;
    expect(bPrompt).toContain("A-RESULT");
    expect(f.calls.find((c) => c.taskId === "a")!.prompt).not.toContain("Context from earlier tasks");
    expect(store.listEvents("r").some((e) => e.type === "blackboard_read" && e.task_id === "b")).toBe(true);
  });
  it("respects the concurrency limit and actually reaches it", async () => {
    let live = 0, peak = 0;
    const { deps } = harness([T("a"), T("b"), T("c"), T("d")], () => ok(), { concurrency: 2 });
    const orig = deps.adapters.claude;
    deps.adapters.claude = {
      runtime: "claude",
      async *run(i: any) {
        live++; peak = Math.max(peak, live);
        try { await new Promise((r) => setTimeout(r, 15)); yield* orig.run(i); } finally { live--; }
      },
    } as any;
    await runDag(deps);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });
  it("runs a task once by default (no retry)", async () => {
    const { f, deps } = harness([T("a")], () => new Error("boom"));
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(f.calls).toHaveLength(1);
  });
  it("retries with the error summary when maxAttempts is 2", async () => {
    const { f, deps } = harness([T("a")], (_i: any, n: number) => (n === 1 ? new Error("boom") : ok()), { maxAttempts: 2 });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(f.calls[1].prompt).toContain("Previous attempt failed: boom");
  });
  it("fails on the single attempt, blocks dependents, runs independents", async () => {
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] }), T("c")], (i: any) => (i.taskId === "a" ? new Error("nope") : ok()));
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked", c: "done" });
    expect(store.taskStatuses("r").find((s) => s.task_id === "b")?.status).toBe("blocked");
  });
  it("blocks transitive dependents regardless of declaration order", async () => {
    const { store, f, deps } = harness(
      [T("c", { dependsOn: ["b"] }), T("b", { dependsOn: ["a"] }), T("a")],
      (i: any) => (i.taskId === "a" ? new Error("nope") : ok()),
    );
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked", c: "blocked" });
    expect(f.calls.map((c) => c.taskId)).toEqual(["a"]);
    const st = Object.fromEntries(store.taskStatuses("r").map((s) => [s.task_id, s.status]));
    expect(st).toMatchObject({ a: "failed", b: "blocked", c: "blocked" });
  });
  it("kills on budget with failed:budget and does not retry", async () => {
    const big = [{ type: "usage", input: 500, output: 500, cached: null, costUsd: null }, { type: "assistant_text", text: "more" }];
    const { store, f, deps } = harness([T("a", { budgetTokens: 100 })], () => big as any);
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(f.calls).toHaveLength(1);
    expect(store.taskStatuses("r")[0].detail).toBe("failed:budget");
  });
  it("does not retry a budget breach even when maxAttempts > 1, and aborts the adapter", async () => {
    const big = [{ type: "usage", input: 500, output: 500, cached: null, costUsd: null }, { type: "assistant_text", text: "more" }];
    const { store, f, deps } = harness([T("a", { budgetTokens: 100 })], () => big as any, { maxAttempts: 3 });
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(store.taskStatuses("r")[0].detail).toBe("failed:budget");
  });
  it("commits the worktree before removing it, and a commit failure fails the task", async () => {
    const order: string[] = [];
    const wt = { create: async (id: string) => `/wt/${id}`, commit: async (id: string) => { order.push(`commit:${id}`); }, remove: async (id: string) => { order.push(`remove:${id}`); } };
    expect(await runDag(harness([T("a")], () => ok(), { worktrees: wt }).deps)).toEqual({ a: "done" });
    expect(order).toEqual(["commit:a", "remove:a"]);
    const bad = { ...wt, commit: async () => { throw new Error("commit failed"); } };
    expect(await runDag(harness([T("a")], () => ok(), { worktrees: bad }).deps)).toEqual({ a: "failed" });
  });
  it("tolerates a worktree remove failure", async () => {
    const wt = { create: async (id: string) => `/wt/${id}`, commit: async () => {}, remove: async () => { throw new Error("rm failed"); } };
    expect(await runDag(harness([T("a")], () => ok(), { worktrees: wt }).deps)).toEqual({ a: "done" });
  });
  it("works when the adapter reports no usage at all", async () => {
    const { deps } = harness([T("a", { budgetTokens: 5 })], () => [{ type: "result", text: JSON.stringify({ summary: "s" }) }] as any);
    expect(await runDag(deps)).toEqual({ a: "done" });
  });
  it("handles usage events with null fields without NaN", async () => {
    const evs = [{ type: "usage", input: null, output: null, cached: null, costUsd: null }, ...ok()];
    const { store, deps } = harness([T("a", { budgetTokens: 100 })], () => evs as any);
    expect(await runDag(deps)).toEqual({ a: "done" });
    const fin = store.listEvents("r").find((e) => e.type === "task_finished")!;
    expect((fin.payload as any).tokens).toBe(15);
  });
  it("repairs a malformed result once, else fails", async () => {
    const bad = () => [{ type: "result", text: "not json" }] as any;
    const fixed = harness([T("a")], bad, { repairResult: async () => JSON.stringify({ summary: "fixed" }) });
    expect(await runDag(fixed.deps)).toEqual({ a: "done" });
    const unfixed = harness([T("a")], bad);
    expect(await runDag(unfixed.deps)).toEqual({ a: "failed" });
  });
  it("accepts results wrapped in a json code fence", async () => {
    const fenced = () => [{ type: "result", text: "```json\n{\"summary\":\"s\"}\n```" }] as any;
    expect(await runDag(harness([T("a")], fenced).deps)).toEqual({ a: "done" });
  });
  it("skips tasks already done in the store (resume)", async () => {
    const { store, f, deps } = harness([T("a"), T("b", { dependsOn: ["a"] })], () => ok());
    store.setTaskStatus("r", "a", "done");
    expect(await runDag(deps)).toEqual({ a: "done", b: "done" });
    expect(f.calls.map((c) => c.taskId)).toEqual(["b"]);
  });
  it("resume re-runs tasks that were failed or running", async () => {
    const { store, f, deps } = harness([T("a"), T("b")], () => ok());
    store.setTaskStatus("r", "a", "failed", "x"); store.setTaskStatus("r", "b", "running");
    expect(await runDag(deps)).toEqual({ a: "done", b: "done" });
    expect(f.calls.map((c) => c.taskId).sort()).toEqual(["a", "b"]);
  });
  it("redacts secrets in logged prompts", async () => {
    const { store, deps } = harness([T("a", { goal: "use DB_PASSWORD=hunter2" })], () => ok());
    await runDag(deps);
    const p = store.listEvents("r").find((e) => e.type === "prompt_sent")!;
    expect(JSON.stringify(p.payload)).not.toContain("hunter2");
  });
  it("redacts secrets in every emitted event (text, tool input/output, failure reason)", async () => {
    const evs = [
      { type: "assistant_text", text: "pw DB_PASSWORD=hunter2" },
      { type: "tool_call", name: "Bash", input: { cmd: "export DB_PASSWORD=hunter2" } },
      { type: "tool_result", name: "Bash", output: "DB_PASSWORD=hunter2" },
      { type: "result", text: "not json DB_PASSWORD=hunter2" },
    ];
    const { store, deps } = harness([T("a")], () => evs as any);
    expect(await runDag(deps)).toEqual({ a: "failed" });
    const all = JSON.stringify(store.listEvents("r").map((e) => e.payload)) + JSON.stringify(store.taskStatuses("r"));
    expect(all).not.toContain("hunter2");
    expect(store.listEvents("r").some((e) => e.type === "tool_call")).toBe(true);
  });
  it("removes its abort listener from the run signal after each task", async () => {
    const ctl = new AbortController();
    const add = vi.spyOn(ctl.signal, "addEventListener"), rem = vi.spyOn(ctl.signal, "removeEventListener");
    const { deps } = harness([T("a"), T("b"), T("c")], () => ok(), { signal: ctl.signal });
    await runDag(deps);
    expect(add).toHaveBeenCalledTimes(3);
    expect(rem).toHaveBeenCalledTimes(3);
  });
});
