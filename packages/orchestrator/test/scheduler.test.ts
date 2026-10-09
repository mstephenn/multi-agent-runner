import { describe, it, expect, vi } from "vitest";
import { Store } from "../../server/src/store.js";
import { parseDag } from "@mar/core";
import { runDag } from "../src/scheduler.js";
import { fakeAdapter, ok } from "./fakeAdapter.js";

const T = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `do ${id}`, paths: [`${id}/**`], ...extra });
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
  it("falls back to the alternate runtime with its model when enabled", async () => {
    const { store, deps } = harness([T("a")], () => new Error("session limit"), { fallbackRuntime: true });
    const codex = fakeAdapter(() => ok(), "codex");
    deps.adapters.codex = codex.adapter;
    deps.modelFor = ((runtime: string) => runtime === "codex" ? "codex-model" : "claude-model") as any;
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(codex.calls[0]).toMatchObject({ taskId: "a", model: "codex-model" });
    expect(store.listEvents("r").find((e) => e.type === "runtime_fallback")?.payload).toMatchObject({ from: "claude", to: "codex" });
  });
  it("does not switch runtimes when a USD cap is configured", async () => {
    const { store, deps } = harness([T("a")], () => new Error("USD budget reached"), { fallbackRuntime: true, maxBudgetUsdPerTask: 2 });
    const codex = fakeAdapter(() => ok(), "codex");
    deps.adapters.codex = codex.adapter;
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(codex.calls).toHaveLength(0);
    expect(store.listEvents("r").some((e) => e.type === "runtime_fallback")).toBe(false);
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
  it("passes the task's dependsOn list to worktrees.create", async () => {
    const calls: Array<[string, string[] | undefined]> = [];
    const wt = { create: async (id: string, deps?: string[]) => { calls.push([id, deps]); return `/wt/${id}`; }, commit: async () => {}, remove: async () => {} };
    expect(await runDag(harness([T("a"), T("b", { dependsOn: ["a"] })], () => ok(), { worktrees: wt }).deps)).toEqual({ a: "done", b: "done" });
    expect(calls.find(([id]) => id === "b")![1]).toEqual(["a"]);
    expect(calls.find(([id]) => id === "a")![1]).toEqual([]);
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

  const toolRun = (input: unknown) => [{ type: "tool_call", name: "Bash", input }, ...ok()] as any;
  const toolInput = (store: Store) => (store.listEvents("r").find((e) => e.type === "tool_call")!.payload as any).input;

  it("redacts the failure reason", async () => {
    const { store, deps } = harness([T("a")], () => new Error("boom DB_PASSWORD=hunter2"));
    await runDag(deps);
    expect(JSON.stringify(store.taskStatuses("r"))).not.toContain("hunter2");
    expect(JSON.stringify(store.listEvents("r").filter((e) => e.type === "task_failed"))).not.toContain("hunter2");
  });
  it("masks values under secret-named keys whatever their type", async () => {
    const input = { password: 12345, token: { nested: "x" }, apiKey: ["a", "b"], private_key: true, name: "bob", n: 3 };
    const { store, deps } = harness([T("a")], () => toolRun(input));
    await runDag(deps);
    expect(toolInput(store)).toEqual({ password: "[REDACTED]", token: "[REDACTED]", apiKey: "[REDACTED]", private_key: "[REDACTED]", name: "bob", n: 3 });
  });
  it("never passes values deeper than 20 levels through raw", async () => {
    let deep: any = { leaf: "DB_PASSWORD=hunter2" };
    for (let i = 0; i < 30; i++) deep = { x: deep };
    const { store, deps } = harness([T("a")], () => toolRun(deep));
    await runDag(deps);
    const s = JSON.stringify(toolInput(store));
    expect(s).toContain("[TRUNCATED]");
    expect(s).not.toContain("hunter2");
  });
  it("stringifies bigint/function/symbol values in tool input", async () => {
    const { store, deps } = harness([T("a")], () => toolRun({ a: 10n, b: () => 1, c: Symbol("s") }));
    await runDag(deps);
    expect(toolInput(store)).toEqual({ a: "10", b: "[function]", c: "Symbol(s)" });
  });
  it("replaces oversized tool_call input with a marker object", async () => {
    const { store, deps } = harness([T("a")], () => toolRun({ blob: "z".repeat(10_000) }));
    await runDag(deps);
    const inp = toolInput(store);
    expect(inp).toMatchObject({ truncated: "[TRUNCATED]" });
    expect(JSON.stringify(inp).length).toBeLessThan(200);
  });
  it("emits unsafe in task_started", async () => {
    for (const [unsafe, want] of [[true, true], [undefined, false], [false, false]] as const) {
      const { store, deps } = harness([T("a")], () => ok(), { unsafe });
      await runDag(deps);
      expect((store.listEvents("r").find((e) => e.type === "task_started")!.payload as any).unsafe).toBe(want);
    }
  });

  it("abort before start: nothing runs, every task is blocked", async () => {
    const ctl = new AbortController(); ctl.abort();
    const { store, f, deps } = harness([T("a"), T("b", { dependsOn: ["a"] })], () => ok(), { signal: ctl.signal });
    expect(await runDag(deps)).toEqual({ a: "blocked", b: "blocked" });
    expect(f.calls).toHaveLength(0);
    expect(store.taskStatuses("r").map((s) => s.status)).toEqual(["blocked", "blocked"]);
  });
  it("abort mid-flight: running task fails, the rest are blocked, worktree is removed", async () => {
    const ctl = new AbortController();
    const removed: string[] = [];
    const wt = { create: async (id: string) => `/wt/${id}`, commit: async () => {}, remove: async (id: string) => { removed.push(id); } };
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] }), T("c", { dependsOn: ["b"] })], () => { ctl.abort(); return ok(); }, { signal: ctl.signal, worktrees: wt });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked", c: "blocked" });
    const st = Object.fromEntries(store.taskStatuses("r").map((s) => [s.task_id, s.status]));
    expect(st).toEqual({ a: "failed", b: "blocked", c: "blocked" });
    expect(removed).toEqual(["a"]);
  });
  it("worktrees.create throwing fails that task only and does not call remove", async () => {
    const removed: string[] = [];
    const wt = { create: async (id: string) => { if (id === "a") throw new Error("no worktree"); return `/wt/${id}`; }, commit: async () => {}, remove: async (id: string) => { removed.push(id); } };
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] }), T("c")], () => ok(), { worktrees: wt });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked", c: "done" });
    expect(store.taskStatuses("r").find((s) => s.task_id === "a")?.detail).toContain("no worktree");
    expect(removed).toEqual(["c"]);
  });
  // updated: used to require "must not commit" on a budget kill; partial work is now saved (wip commit) before remove.
  it("saves a wip commit, then removes, after a budget kill", async () => {
    const big = [{ type: "usage", input: 500, output: 500, cached: null, costUsd: null }, { type: "assistant_text", text: "more" }];
    const order: string[] = [];
    const wt = { create: async (id: string) => `/wt/${id}`, commit: async (id: string, m: string) => { order.push(`commit:${id}:${m}`); }, remove: async (id: string) => { order.push(`remove:${id}`); } };
    const { deps } = harness([T("a", { budgetTokens: 100 })], () => big as any, { worktrees: wt });
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(order).toEqual(["commit:a:mar(a): wip (failed attempt)", "remove:a"]);
  });
  it("keeps a completed result when final usage crosses the token budget", async () => {
    const result = { type: "result", text: JSON.stringify({ summary: "finished" }) };
    const usage = { type: "usage", input: 500, output: 500, cached: null, costUsd: null };
    const evs = [result, usage];
    const { store, deps } = harness([T("a", { budgetTokens: 100 })], () => evs as any);
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(store.latestBb("r", "a/summary")?.body).toBe("finished");
    const afterUsage = harness([T("a", { budgetTokens: 100 })], () => [usage, result] as any);
    expect(await runDag(afterUsage.deps)).toEqual({ a: "done" });
  });
  it("does not fall back after a token budget breach without a completed result", async () => {
    const usage = { type: "usage", input: 500, output: 500, cached: null, costUsd: null };
    const { deps } = harness([T("a", { budgetTokens: 100 })], () => [usage] as any, { fallbackRuntime: true });
    const codex = fakeAdapter(() => ok(), "codex");
    deps.adapters.codex = codex.adapter;
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(codex.calls).toHaveLength(0);
  });
  it("shares one budget across attempts", async () => {
    const evs = [{ type: "usage", input: 60, output: 0, cached: null, costUsd: null }, { type: "assistant_text", text: "x" }]; // no result -> retryable
    const { f, store, deps } = harness([T("a", { budgetTokens: 100 })], () => evs as any, { maxAttempts: 3 });
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(f.calls).toHaveLength(2); // 60 + 60 > 100 on the second attempt; a fresh budget would allow a third
    expect(store.taskStatuses("r")[0].detail).toBe("failed:budget");
  });

  it("a store throw while starting one task fails only that task and resolves", async () => {
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] }), T("c")], () => ok());
    const orig = store.setTaskStatus.bind(store);
    vi.spyOn(store, "setTaskStatus").mockImplementation((r, t, st, d) => { if (t === "a" && st === "running") throw new Error("disk full"); orig(r, t, st, d); });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked", c: "done" });
    const st = Object.fromEntries(store.taskStatuses("r").map((s) => [s.task_id, s.status]));
    expect(st).toMatchObject({ a: "failed", c: "done" });
    expect(Object.values(st)).not.toContain("running");
  });
  it("a store throw while publishing the result marks the task failed, not running", async () => {
    const { store, deps } = harness([T("a"), T("c")], () => ok());
    const orig = store.writeBb.bind(store);
    vi.spyOn(store, "writeBb").mockImplementation((e) => { if (e.author_task === "a") throw new Error("bb write failed"); return orig(e); });
    expect(await runDag(deps)).toEqual({ a: "failed", c: "done" });
    expect(store.taskStatuses("r").find((s) => s.task_id === "a")?.status).toBe("failed");
  });
  it("a completely dead store still lets runDag resolve with outcomes", async () => {
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] })], () => ok());
    const boom = () => { throw new Error("db closed"); };
    for (const m of ["setTaskStatus", "appendEvent", "taskStatuses", "latestBb", "writeBb"] as const) vi.spyOn(store, m).mockImplementation(boom as never);
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked" });
  });

  describe("optional blackboard keys (I2)", () => {
    it("a dependent needing up/decisions runs when upstream returned decisions: []", async () => {
      const { f, deps } = harness([T("up"), T("dn", { dependsOn: ["up"], needs: ["up/decisions", "up/open_questions", "up/files"] })], () => ok("U"));
      expect(await runDag(deps)).toEqual({ up: "done", dn: "done" });
      expect(f.calls.find((c) => c.taskId === "dn")!.prompt).toContain("(none)");
    });
  });

  describe("save work on failure (I3)", () => {
    const rec = (over: Partial<{ commit: (id: string, m: string) => Promise<void> }> = {}) => {
      const order: string[] = [];
      const wt = { create: async (id: string) => `/wt/${id}`, commit: async (id: string, m: string) => { order.push(`commit:${m}`); await over.commit?.(id, m); }, remove: async () => { order.push("remove"); } };
      return { order, wt };
    };
    const bad = () => [{ type: "result", text: "not json" }] as any;
    it("bad result: wip commit then remove", async () => {
      const { order, wt } = rec();
      expect(await runDag(harness([T("a")], bad, { worktrees: wt }).deps)).toEqual({ a: "failed" });
      expect(order).toEqual(["commit:mar(a): wip (failed attempt)", "remove"]);
    });
    it("adapter throw: wip commit then remove", async () => {
      const { order, wt } = rec();
      expect(await runDag(harness([T("a")], () => new Error("boom"), { worktrees: wt }).deps)).toEqual({ a: "failed" });
      expect(order).toEqual(["commit:mar(a): wip (failed attempt)", "remove"]);
    });
    it("a failing wip commit does not mask the original error", async () => {
      const { order, wt } = rec({ commit: async () => { throw new Error("git exploded"); } });
      const { store, deps } = harness([T("a")], bad, { worktrees: wt });
      expect(await runDag(deps)).toEqual({ a: "failed" });
      expect(store.taskStatuses("r")[0].detail).toBe("bad-result");
      expect(order).toEqual(["commit:mar(a): wip (failed attempt)", "remove"]);
    });
    it("success path commits once with the goal message and no wip commit", async () => {
      const { order, wt } = rec();
      await runDag(harness([T("a")], () => ok(), { worktrees: wt }).deps);
      expect(order).toEqual(["commit:mar(a): do a", "remove"]);
    });
  });

  describe("bad-result is not retried (M2)", () => {
    it("calls the adapter once with maxAttempts 2", async () => {
      const { f, deps } = harness([T("a")], () => [{ type: "result", text: "not json" }] as any, { maxAttempts: 2 });
      expect(await runDag(deps)).toEqual({ a: "failed" });
      expect(f.calls).toHaveLength(1);
    });
  });

  describe("per-task timeout and budget (I4)", () => {
    const never = (_i: any) => new Promise<never>(() => {});
    const hang = (over: object = {}) => {
      const removed: string[] = [], committed: string[] = [];
      const wt = { create: async (id: string) => `/wt/${id}`, commit: async (id: string) => { committed.push(id); }, remove: async (id: string) => { removed.push(id); } };
      const h = harness([T("a"), T("b")], (i: any) => (i.taskId === "a" ? [] : ok()), { worktrees: wt, ...over });
      // task "a" hangs forever and ignores the abort signal
      const good = h.deps.adapters.claude;
      h.deps.adapters = { claude: { runtime: "claude", async *run(i: any) { if (i.taskId === "a") { await never(i); } yield* good.run(i); } }, codex: good } as any;
      return { ...h, removed, committed };
    };
    it("fails a hung task with failed:timeout, cleans up, and lets others finish", async () => {
      vi.useFakeTimers();
      try {
        const { store, deps, removed, committed } = hang({ taskTimeoutMs: 1000 });
        const p = runDag(deps);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await p).toEqual({ a: "failed", b: "done" });
        expect(store.taskStatuses("r").find((s) => s.task_id === "a")?.detail).toBe("failed:timeout");
        expect(removed.sort()).toEqual(["a", "b"]);
        expect(committed).toContain("a");
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });
    it("does not retry a timeout and aborts the attempt's signal", async () => {
      vi.useFakeTimers();
      try {
        const seen: AbortSignal[] = [];
        const { store, deps } = harness([T("a")], () => ok(), { taskTimeoutMs: 500, maxAttempts: 3 });
        deps.adapters = { claude: { runtime: "claude", async *run(i: any) { seen.push(i.signal); await never(i); yield* []; } }, codex: deps.adapters.codex } as any;
        const p = runDag(deps);
        await vi.advanceTimersByTimeAsync(500);
        expect(await p).toEqual({ a: "failed" });
        expect(seen).toHaveLength(1);
        expect(seen[0].aborted).toBe(true);
        expect(store.taskStatuses("r")[0].detail).toBe("failed:timeout");
      } finally { vi.useRealTimers(); }
    });
    it("no timeout configured: no timer is armed", async () => {
      vi.useFakeTimers();
      try {
        const { deps } = harness([T("a")], () => ok());
        const p = runDag(deps);
        expect(await p).toEqual({ a: "done" });
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });
    it("clears the timer after a normal finish", async () => {
      vi.useFakeTimers();
      try {
        const { deps } = harness([T("a")], () => ok(), { taskTimeoutMs: 60_000 });
        expect(await runDag(deps)).toEqual({ a: "done" });
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });
    it("passes maxBudgetUsdPerTask to the adapter as maxBudgetUsd", async () => {
      const { f, deps } = harness([T("a")], () => ok(), { maxBudgetUsdPerTask: 2.5 });
      await runDag(deps);
      expect(f.calls[0].maxBudgetUsd).toBe(2.5);
      const none = harness([T("a")], () => ok());
      await runDag(none.deps);
      expect(none.f.calls[0].maxBudgetUsd).toBeUndefined();
    });
  });
});

describe("runDag shared read-only worktree", () => {
  const R = (id: string, extra: object = {}) => T(id, { role: "researcher", ...extra });
  function fakeWt(over: { acquire?: () => Promise<string> } = {}) {
    const calls: string[] = [];
    const worktrees = {
      create: async (id: string) => { calls.push(`create:${id}`); return `/wt/${id}`; },
      remove: async (id: string) => { calls.push(`remove:${id}`); },
      commit: async (id: string) => { calls.push(`commit:${id}`); },
      shared: {
        acquire: over.acquire ?? (async () => { calls.push("acquire"); return "/wt/.shared"; }),
        release: async () => { calls.push("release"); },
      },
    };
    return { calls, worktrees };
  }
  const roTools = (role: string) => (role === "implementer" ? ["Read", "Edit", "Write", "Bash"] : ["Read"]);

  it("researcher-only DAG: no create/commit/remove, one acquire, one release, cwd is shared", async () => {
    const w = fakeWt();
    const { f, deps } = harness([R("a"), R("b", { dependsOn: ["a"] }), R("c")], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ a: "done", b: "done", c: "done" });
    expect(w.calls.filter((c) => c === "acquire")).toHaveLength(1);
    expect(w.calls.filter((c) => c === "release")).toHaveLength(1);
    expect(w.calls.some((c) => /^(create|commit|remove):/.test(c))).toBe(false);
    expect(f.calls.every((c) => c.cwd === "/wt/.shared")).toBe(true);
  });
  it("mixed DAG: writer chain gets own worktrees, independent researcher shares; payload says which", async () => {
    const w = fakeWt();
    const { store, deps } = harness([T("i"), T("r", { role: "reviewer", dependsOn: ["i"] }), R("s")], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ i: "done", r: "done", s: "done" });
    expect(w.calls).toEqual(expect.arrayContaining(["create:i", "create:r", "commit:i", "commit:r", "remove:i", "remove:r", "acquire"]));
    expect(w.calls.some((c) => c.endsWith(":s"))).toBe(false);
    expect(w.calls.filter((c) => c === "release")).toHaveLength(1);
    const wtOf = Object.fromEntries(store.listEvents("r").filter((e) => e.type === "task_started").map((e) => [e.task_id, e.payload.worktree]));
    expect(wtOf).toEqual({ i: "own", r: "own", s: "shared" });
  });
  it("a writer depending on a read-only (branchless) task is not asked to merge its branch", async () => {
    const w = fakeWt(); const deps_: Record<string, string[] | undefined> = {};
    w.worktrees.create = async (id: string, d?: string[]) => { deps_[id] = d; return `/wt/${id}`; };
    const { deps } = harness([R("design"), T("impl", { dependsOn: ["design"] })], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ design: "done", impl: "done" });
    expect(deps_["impl"]).toEqual([]);
  });
  it("a task that already started in this run gets a resume note in its prompt", async () => {
    const w = fakeWt();
    const { store, f, deps } = harness([T("i")], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    store.appendEvent({ run_id: "r", task_id: "i", agent_id: "i", type: "task_started", payload: {} });
    await runDag(deps);
    expect(f.calls[0].prompt).toContain("Resumed task");
  });
  it("on resume, stale failed/blocked rows of tasks that have not restarted yet read as pending", async () => {
    const w = fakeWt();
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] })], () => ok(), { worktrees: w.worktrees, toolsFor: roTools, concurrency: 1 });
    store.setTaskStatus("r", "a", "failed", "failed:timeout"); store.setTaskStatus("r", "b", "blocked");
    const seen: string[] = [];
    w.worktrees.create = async (id: string) => { if (id === "a") seen.push(store.taskStatuses("r").find((t) => t.task_id === "b")!.status); return `/wt/${id}`; };
    await runDag(deps);
    expect(seen).toEqual(["pending"]);
  });
  it("a task handed a conflicted merge gets resolve instructions in its prompt and the run continues", async () => {
    const w: any = fakeWt();
    w.worktrees.pendingMerges = () => ({ branch: "mar/r/b", files: ["app.ts"], remaining: ["mar/r/d"] });
    const { store, f, deps } = harness([T("c")], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ c: "done" });
    expect(f.calls[0].prompt).toMatch(/Resolve a merge conflict first[\s\S]*app\.ts[\s\S]*git merge --no-edit mar\/r\/d/);
    expect(store.listEvents("r").some((e) => e.type === "dependency_merge_conflict" && e.payload.resolving === true)).toBe(true);
  });
  it("after a runtime reports a usage limit, later tasks go straight to the other runtime", async () => {
    const codex = fakeAdapter(() => new Error("codex exited 1: You hit your usage limit")), claude = fakeAdapter(() => ok());
    const { store, deps } = harness([T("a", { runtime: "codex" }), T("b", { runtime: "codex" })], () => ok(), { fallbackRuntime: true, concurrency: 1 });
    (deps as any).adapters = { claude: claude.adapter, codex: codex.adapter };
    expect(await runDag(deps as any)).toEqual({ a: "done", b: "done" });
    expect(store.listEvents("r").filter((e) => e.type === "runtime_fallback").map((e) => e.task_id)).toEqual(["a", "b"]);
    expect(codex.calls.map((c) => c.taskId)).toEqual(["a"]); // b never tried codex
    expect(claude.calls.map((c) => c.taskId)).toEqual(["a", "b"]);
  });
  it("release is called once even when a task fails", async () => {
    const w = fakeWt();
    const { deps } = harness([R("a"), R("b")], (i: any) => (i.taskId === "a" ? new Error("x") : ok()), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "done" });
    expect(w.calls.filter((c) => c === "release")).toHaveLength(1);
  });
  it("release is called once when the run is aborted", async () => {
    const w = fakeWt(); const ac = new AbortController();
    const { deps } = harness([R("a"), R("b", { dependsOn: ["a"] })], (i: any) => { ac.abort(); return ok(); }, { worktrees: w.worktrees, toolsFor: roTools, signal: ac.signal });
    await runDag(deps);
    expect(w.calls.filter((c) => c === "release")).toHaveLength(1);
  });
  it("a release failure does not fail the run", async () => {
    const w = fakeWt(); w.worktrees.shared.release = async () => { throw new Error("busy"); };
    const { deps } = harness([R("a")], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ a: "done" });
  });
  it("an acquire failure fails the task without hanging, and releases", async () => {
    const calls: string[] = [];
    const w = fakeWt({ acquire: async () => { calls.push("acquire"); throw new Error("no git"); } });
    w.worktrees.shared.release = async () => { calls.push("release"); };
    const { store, f, deps } = harness([R("a"), R("b", { dependsOn: ["a"] })], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked" });
    expect(f.calls).toHaveLength(0);
    expect(store.taskStatuses("r").find((s) => s.task_id === "a")?.detail).toContain("no git");
    expect(calls.filter((c) => c === "release")).toHaveLength(1);
  });
  it("a role with write tools gets its own worktree even if read-only by role", async () => {
    const w = fakeWt();
    const { deps } = harness([R("a")], () => ok(), { worktrees: w.worktrees, toolsFor: () => ["Read", "Bash"] });
    await runDag(deps);
    expect(w.calls).toEqual(expect.arrayContaining(["create:a", "commit:a", "remove:a"]));
    expect(w.calls).not.toContain("acquire");
    expect(w.calls).not.toContain("release");
  });
  it("without `shared` the legacy per-task behaviour applies", async () => {
    const w = fakeWt(); delete (w.worktrees as { shared?: unknown }).shared;
    const { store, deps } = harness([R("a")], () => ok(), { worktrees: w.worktrees, toolsFor: roTools });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(w.calls).toEqual(["create:a", "commit:a", "remove:a"]);
    expect(store.listEvents("r").find((e) => e.type === "task_started")?.payload.worktree).toBe("own");
  });
});


describe("runDag reports", () => {
  const withReport = (report?: string, summary = "short") => [
    { type: "usage", input: 1, output: 1, cached: null, costUsd: null },
    { type: "result", text: JSON.stringify({ summary, ...(report !== undefined ? { report } : {}), filesChanged: [], decisions: [], openQuestions: [] }) },
  ];
  it("stores the redacted report outside the blackboard and reports its size", async () => {
    const report = "# Answer\n" + "long text ".repeat(300) + "\nDB_PASSWORD=hunter2\n";
    const { store, deps } = harness([T("a")], () => withReport(report));
    expect(await runDag(deps)).toEqual({ a: "done" });
    const [r] = store.listReports("r");
    expect(r!.task_id).toBe("a");
    expect(r!.body).not.toContain("hunter2");
    expect(r!.body.length).toBeGreaterThan(1200);
    expect(store.listBb("r").some((e) => e.key.includes("report") || e.body.includes("long text"))).toBe(false);
    const fin = store.listEvents("r").find((e) => e.type === "task_finished")!;
    expect(fin.payload).toMatchObject({ report_chars: r!.body.length, reportSaved: true });
  });
  it("stores nothing when the task has no report", async () => {
    const { store, deps } = harness([T("a")], () => withReport(undefined));
    await runDag(deps);
    expect(store.listReports("r")).toEqual([]);
    const fin = store.listEvents("r").find((e) => e.type === "task_finished")!;
    expect(fin.payload).toMatchObject({ report_chars: 0, reportSaved: false });
  });
  it("does not fail an otherwise good task when saveReport throws", async () => {
    const { store, deps } = harness([T("a")], () => withReport("some report"));
    vi.spyOn(store, "saveReport").mockImplementation(() => { throw new Error("disk full"); });
    expect(await runDag(deps)).toEqual({ a: "done" });
    const fin = store.listEvents("r").find((e) => e.type === "task_finished")!;
    expect(fin.payload).toMatchObject({ reportSaved: false, report_chars: 11 });
  });
  it("a retry attempt overwrites the earlier attempt's report", async () => {
    const { store, deps } = harness([T("a")], (_i: any, n: number) => withReport(`report ${n}`), { maxAttempts: 2 });
    vi.spyOn(store, "writeBb").mockImplementationOnce(() => { throw new Error("bb down"); });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(store.listReports("r").map((r) => r.body)).toEqual(["report 2"]);
  });
});

describe("runDag verify gate", () => {
  const PASS = { ok: true, tail: "", ms: 5 };
  const FAIL = { ok: false, failed: { command: "pnpm test", code: 1, timedOut: false }, tail: "1 failed: API_KEY=abc", ms: 7 };
  const VERIFY = { commands: ["pnpm test"], timeoutMs: 1000 };
  type Fx = { calls: any[]; commits: string[]; removed: string[]; worktrees: any };
  function fx(): Fx {
    const o: Fx = { calls: [], commits: [], removed: [], worktrees: {} };
    o.worktrees = {
      create: async (id: string) => `/wt/${id}`,
      commit: async (id: string, m: string) => { o.commits.push(`${id}:${m}`); },
      remove: async (id: string) => { o.removed.push(id); },
    };
    return o;
  }
  const events = (store: Store, type: string) => store.listEvents("r").filter((e) => e.type === type);

  it("passes: runs the gate in the task worktree after commit, emits started/passed, then publishes", async () => {
    const o = fx();
    const order: string[] = [];
    o.worktrees.commit = async () => { order.push("commit"); };
    const { store, deps } = harness([T("a")], () => ok("A-RESULT"), {
      worktrees: o.worktrees, verify: VERIFY,
      runVerify: async (cwd: string, commands: string[], opts: any) => {
        order.push("verify"); o.calls.push({ cwd, commands, timeoutMs: opts.timeoutMs, signal: !!opts.signal });
        expect(store.latestBb("r", "a/summary")).toBeUndefined(); // not published yet
        return PASS;
      },
    });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(order).toEqual(["commit", "verify"]);
    expect(o.calls).toEqual([{ cwd: "/wt/a", commands: ["pnpm test"], timeoutMs: 1000, signal: true }]);
    expect(events(store, "verify_started")[0].payload).toEqual({ attempt: 1, commands: ["pnpm test"] });
    expect(events(store, "verify_passed")[0].payload).toEqual({ attempt: 1, ms: 5 });
    expect(store.latestBb("r", "a/summary")?.body).toBe("A-RESULT");
    expect(o.removed).toEqual(["a"]);
  });
  it("fails: failed:verify, tail only in the event (redacted), dependents blocked, wip kept, nothing published, worktree removed after", async () => {
    const o = fx();
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] })], () => ok(), {
      worktrees: o.worktrees, verify: VERIFY, runVerify: async () => FAIL,
    });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked" });
    const st = store.taskStatuses("r").find((s) => s.task_id === "a")!;
    expect(st.status).toBe("failed");
    expect(st.detail).toBe("failed:verify");
    const vf = events(store, "verify_failed")[0].payload as any;
    expect(vf).toMatchObject({ command: "pnpm test", code: 1, timedOut: false, ms: 7 });
    expect(vf.tail).toContain("1 failed");
    expect(JSON.stringify(vf)).not.toContain("abc");  // redacted again at the scheduler boundary
    expect(store.latestBb("r", "a/summary")).toBeUndefined();
    expect(o.commits).toHaveLength(1);                  // the normal commit already kept the work on the branch
    expect(o.removed).toEqual(["a"]);
    expect(events(store, "task_failed").map((e) => e.task_id)).toEqual(["a"]);
  });
  it("retry (maxAttempts 2) appends the verification tail to the prompt instead of the generic message", async () => {
    const o = fx();
    let n = 0;
    const { f, deps } = harness([T("a")], () => ok(), {
      worktrees: o.worktrees, verify: VERIFY, maxAttempts: 2, runVerify: async () => (++n === 1 ? FAIL : PASS),
    });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].prompt).toContain("\n\nVerification failed (pnpm test):\n1 failed: API_KEY=[REDACTED]");
    expect(f.calls[1].prompt).not.toContain("Previous attempt failed");
  });
  it("caps the retry tail at 1500 chars", async () => {
    const big = { ...FAIL, tail: "x".repeat(4000) };
    let n = 0;
    const { f, deps } = harness([T("a")], () => ok(), { verify: VERIFY, maxAttempts: 2, runVerify: async () => (++n === 1 ? big : PASS) });
    await runDag(deps);
    const tail = f.calls[1].prompt.split("Verification failed (pnpm test):\n")[1];
    expect(tail.length).toBeLessThanOrEqual(1500);
  });
  it("a verify timeout is reported and not retried", async () => {
    const t = { ok: false, failed: { command: "pnpm test", code: null, timedOut: true }, tail: "timed out", ms: 1000 };
    const { f, store, deps } = harness([T("a")], () => ok(), { verify: VERIFY, maxAttempts: 2, runVerify: async () => t });
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(f.calls).toHaveLength(1);
    expect((events(store, "verify_failed")[0].payload as any).timedOut).toBe(true);
    expect(store.taskStatuses("r")[0].detail).toBe("failed:verify");
  });
  it("skips the gate for reviewers and researchers, and when no commands are configured", async () => {
    const runVerify = vi.fn(async () => PASS);
    const { store, deps } = harness([T("a", { role: "researcher", paths: [] }), T("b", { role: "reviewer", paths: [] })], () => ok(), { verify: VERIFY, runVerify });
    expect(await runDag(deps)).toEqual({ a: "done", b: "done" });
    expect(runVerify).not.toHaveBeenCalled();
    expect(events(store, "verify_started")).toEqual([]);
    const h2 = harness([T("w")], () => ok(), { verify: { commands: [], timeoutMs: 1 }, runVerify });
    await runDag(h2.deps);
    const h3 = harness([T("w")], () => ok(), { runVerify });
    await runDag(h3.deps);
    expect(runVerify).not.toHaveBeenCalled();
  });
  it("gates testers too, and never shared read-only tasks", async () => {
    const runVerify = vi.fn(async () => PASS);
    const { deps } = harness([T("a", { role: "tester" })], () => ok(), { verify: VERIFY, runVerify });
    await runDag(deps);
    expect(runVerify).toHaveBeenCalledTimes(1);
  });
  it("abort during the gate fails the task cleanly and still removes the worktree", async () => {
    const o = fx();
    const ac = new AbortController();
    const { store, deps } = harness([T("a")], () => ok(), {
      worktrees: o.worktrees, verify: VERIFY, signal: ac.signal,
      runVerify: (_c: string, _cmds: string[], opts: any) => new Promise((res) => {
        setTimeout(() => ac.abort(), 10);
        opts.signal.addEventListener("abort", () => res({ ok: false, failed: { command: "pnpm test", code: null, timedOut: false }, tail: "verification aborted", ms: 10 }));
      }),
    });
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(store.taskStatuses("r")[0].detail).toBe("failed:verify");
    expect(o.removed).toEqual(["a"]);
    expect(store.taskStatuses("r").some((s) => s.status === "running")).toBe(false);
  });
  it("a throwing verifier fails the task with failed:verify rather than crashing the run", async () => {
    const { store, deps } = harness([T("a"), T("b")], () => ok(), { verify: VERIFY, runVerify: async (cwd: string) => { if (cwd.endsWith("a")) throw new Error("kaboom"); return PASS; } });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "done" });
    expect(store.taskStatuses("r").find((s) => s.task_id === "a")!.detail).toMatch(/failed:verify/);
  });
});

describe("runDag path ownership enforcement", () => {
  const withGit = (changed: Record<string, string[]>, over: object = {}) => {
    const removed: string[] = [];
    const worktrees = {
      create: async (id: string) => `/wt/${id}`, remove: async (id: string) => { removed.push(id); }, commit: async () => {},
      head: async (id: string) => `sha-start-${id}`,
      changedFiles: async (id: string, since: string) => { expect(since).toBe(`sha-start-${id}`); return changed[id] ?? []; },
    };
    return { removed, over: { worktrees, ...over } };
  };
  const ev = (store: Store, type: string) => store.listEvents("r").filter((e) => e.type === type);

  it("no violation: no event", async () => {
    const { over } = withGit({ a: ["src/a/x.ts", "src/a/deep/y.ts"] });
    const { store, deps } = harness([T("a", { paths: ["src/a/**"] })], () => ok(), { ...over, ownership: "enforce" });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(ev(store, "ownership_violation")).toEqual([]);
  });
  it("warn (default): emits ownership_violation, task still done", async () => {
    const { over } = withGit({ a: ["src/a/x.ts", "src/b/oops.ts", "README.md"] });
    const { store, deps } = harness([T("a", { paths: ["src/a/**"] })], () => ok(), over);
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(ev(store, "ownership_violation")[0].payload).toMatchObject({ files: ["src/b/oops.ts", "README.md"], paths: ["src/a/**"], count: 2, enforced: false });
  });
  it("enforce: fails with failed:ownership, work stays on the branch, dependents blocked, nothing published", async () => {
    const { over, removed } = withGit({ a: ["src/b/oops.ts"] });
    const { store, deps } = harness([T("a", { paths: ["src/a/**"] }), T("b", { dependsOn: ["a"] })], () => ok(), { ...over, ownership: "enforce" });
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked" });
    expect(store.taskStatuses("r").find((s) => s.task_id === "a")!.detail).toBe("failed:ownership");
    expect(ev(store, "ownership_violation")[0].payload).toMatchObject({ enforced: true });
    expect(store.latestBb("r", "a/summary")).toBeUndefined();
    expect(removed).toEqual(["a"]);
  });
  it("caps the listed files at 50", async () => {
    const many = Array.from({ length: 80 }, (_, i) => `out/f${i}.ts`);
    const { over } = withGit({ a: many });
    const { store, deps } = harness([T("a", { paths: ["src/**"] })], () => ok(), over);
    await runDag(deps);
    const p = ev(store, "ownership_violation")[0].payload as any;
    expect(p.files).toHaveLength(50);
    expect(p.count).toBe(80);
  });
  it("skips tasks without declared paths, non-writers, and worktrees lacking the optional methods", async () => {
    const { over } = withGit({ a: ["anything.ts"] });
    const h1 = harness([T("a", { paths: [] })], () => ok(), { ...over, ownership: "enforce" });
    expect(await runDag(h1.deps)).toEqual({ a: "done" });
    const h2 = harness([T("a", { paths: ["src/**"] })], () => ok(), { ownership: "enforce" }); // default fake worktrees: no head/changedFiles
    expect(await runDag(h2.deps)).toEqual({ a: "done" });
    expect(ev(h1.store, "ownership_violation")).toEqual([]);
  });
  it("enforce failure retries with the offending files in the prompt when maxAttempts > 1", async () => {
    let n = 0;
    const base = withGit({});
    base.over.worktrees.changedFiles = async () => (++n === 1 ? ["lib/x.ts"] : ["src/a/ok.ts"]);
    const { f, deps } = harness([T("a", { paths: ["src/a/**"] })], () => ok(), { ...base.over, ownership: "enforce", maxAttempts: 2 });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(f.calls[1].prompt).toContain("lib/x.ts");
    expect(f.calls[1].prompt).toContain("src/a/**");
  });
  it("links dependency paths into writer worktrees only", async () => {
    const linked: string[] = [];
    const { deps } = harness([T("a"), T("r", { role: "researcher", paths: [] })], () => ok(), {
      worktrees: { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {}, link: async (id: string) => { linked.push(id); return []; } },
    });
    await runDag(deps);
    expect(linked).toEqual(["a"]);
  });
  it("a failing link does not fail the task", async () => {
    const { deps } = harness([T("a")], () => ok(), {
      worktrees: { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {}, link: async () => { throw new Error("nope"); } },
    });
    expect(await runDag(deps)).toEqual({ a: "done" });
  });
});

describe("runDag ownership across retries", () => {
  it("measures every attempt against the FIRST attempt's start sha", async () => {
    const seen: string[] = [];
    let head = 0;
    const worktrees = {
      create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {},
      head: async () => `sha${++head}`,
      changedFiles: async (_id: string, since: string) => { seen.push(since); return seen.length === 1 ? ["lib/x.ts"] : ["src/a/ok.ts"]; },
    };
    const { deps } = harness([T("a", { paths: ["src/a/**"] })], () => ok(), { worktrees, ownership: "enforce", maxAttempts: 2 });
    await runDag(deps);
    expect(seen).toEqual(["sha1", "sha1"]);
  });
});

describe("runDag dependency merge conflicts and predicted conflicts", () => {
  const ev = (store: Store, type: string) => store.listEvents("r").filter((e) => e.type === type);
  it("a DependencyMergeConflict from create fails the task with a readable detail, emits dependency_merge_conflict once (no retry) and blocks dependents", async () => {
    const { DependencyMergeConflict } = await import("../src/worktree.js");
    let creates = 0;
    const files = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    const worktrees = {
      create: async (id: string, deps: string[] = []) => { creates++; if (id === "c") throw new DependencyMergeConflict("c", deps[1]!, files); return `/wt/${id}`; },
      remove: async () => {}, commit: async () => {},
    };
    const { store, deps } = harness([T("a"), T("b"), T("c", { dependsOn: ["a", "b"], paths: [] }), T("d", { dependsOn: ["c"], paths: [] })], () => ok(), { worktrees, maxAttempts: 3 });
    expect(await runDag(deps)).toEqual({ a: "done", b: "done", c: "failed", d: "blocked" });
    expect(creates).toBe(3); // a, b, c once: not retried
    const detail = store.taskStatuses("r").find((s) => s.task_id === "c")!.detail!;
    expect(detail).toMatch(/^dependency b: merge conflict in src\/f0\.ts/);
    expect(detail.length).toBeLessThanOrEqual(300);
    const e = ev(store, "dependency_merge_conflict");
    expect(e).toHaveLength(1);
    expect(e[0].payload).toMatchObject({ task: "c", dependency: "b" });
    expect((e[0].payload.files as string[])).toHaveLength(50);
  });
  const withChanged = (changed: Record<string, string[]>) => ({
    worktrees: { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {}, head: async () => "sha", changedFiles: async (id: string) => changed[id] ?? [] },
  });
  it("emits predicted_conflict once per pair when two parallel writers both stray into the same file", async () => {
    const over = withChanged({ a: ["a/x.ts", "shared.txt"], b: ["b/y.ts", "shared.txt", "other.css"], c: ["c/z.ts", "shared.txt"] });
    const { store, deps } = harness([T("a"), T("b"), T("c")], () => ok(), { ...over, concurrency: 3 });
    await runDag(deps);
    const e = ev(store, "predicted_conflict").map((x) => ({ tasks: [...(x.payload.tasks as string[])].sort(), files: x.payload.files }));
    expect(e.sort((p, q) => p.tasks.join().localeCompare(q.tasks.join()))).toEqual([
      { tasks: ["a", "b"], files: ["shared.txt"] }, { tasks: ["a", "c"], files: ["shared.txt"] }, { tasks: ["b", "c"], files: ["shared.txt"] },
    ]);
    expect(ev(store, "ownership_violation")).toHaveLength(3);
  });
  it("also predicts when a violation lands inside the other task's declared paths", async () => {
    const over = withChanged({ a: ["a/x.ts", "b/stolen.ts"] });
    const { store, deps } = harness([T("a"), T("b")], () => ok(), { ...over });
    await runDag(deps);
    expect(ev(store, "predicted_conflict").map((x) => x.payload)).toEqual([{ attempt: 1, tasks: ["a", "b"], files: ["b/stolen.ts"] }]);
  });
  it("no prediction for ordered tasks or disjoint violations", async () => {
    const over = withChanged({ a: ["a/x.ts", "s.txt"], b: ["b/y.ts", "s.txt"], c: ["c/q.ts", "own.txt"], d: ["d/q.ts", "own2.txt"] });
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] }), T("c"), T("d")], () => ok(), { ...over });
    await runDag(deps);
    expect(ev(store, "predicted_conflict")).toEqual([]);
  });
});
