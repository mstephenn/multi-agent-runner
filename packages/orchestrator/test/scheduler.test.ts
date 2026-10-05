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
  it("a result arriving after the budget cap still fails the task (hard cap)", async () => {
    const evs = [{ type: "usage", input: 500, output: 500, cached: null, costUsd: null }, ...ok()];
    const { store, deps } = harness([T("a", { budgetTokens: 100 })], () => evs as any);
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(store.taskStatuses("r")[0].detail).toBe("failed:budget");
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
