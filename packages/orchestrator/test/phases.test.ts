import { describe, it, expect, vi } from "vitest";
import { Store } from "../../server/src/store.js";
import { planGoal } from "../src/planner.js";
import { runDag } from "../src/scheduler.js";
import { runPhases, type PhasesDeps, type IntegrationOutcome } from "../src/phases.js";
import { fakeAdapter } from "./fakeAdapter.js";
import type { AdapterInput, AgentEvent } from "../../adapters/src/types.js";

const task = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `goal of ${id}`, paths: [`${id}/**`], ...extra });
const res = (o: unknown): AgentEvent[] => [{ type: "result", text: JSON.stringify(o) }];
const workerOk = (id: string): AgentEvent[] => [
  { type: "usage", input: 10, output: 5, cached: null, costUsd: null },
  { type: "result", text: JSON.stringify({ summary: `did ${id}`, filesChanged: [], decisions: [`dec ${id}`], openQuestions: [`q ${id}`] }) },
];
const phaseOf = (prompt: string) => Number(/plan the NEXT phase \(phase (\d+)\)/.exec(prompt)?.[1] ?? 1);

interface Opts {
  plans: Record<number, unknown>;                         // planner answer per phase
  worker?: (i: AdapterInput, n: number) => AgentEvent[] | Error;
  limits?: Partial<PhasesDeps["limits"]>;
  integrate?: PhasesDeps["integrate"];
  signal?: AbortSignal;
  runId?: string;
}
function harness(store: Store, o: Opts) {
  const runId = o.runId ?? "r1";
  const f = fakeAdapter((i, n) => (i.taskId === "planner"
    ? res(o.plans[phaseOf(i.prompt)] ?? { tasks: [] })
    : o.worker ? o.worker(i, n) : workerOk(i.taskId)));
  const runs: { dag: string[]; phase: number; baseRef?: string }[] = [];
  const started: unknown[] = [];
  const wt = { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {} };
  const deps: PhasesDeps = {
    store, runId, signal: o.signal,
    limits: { maxTasks: 8, maxPhases: 5, maxTotalTokens: 1_000_000, ...o.limits },
    plan: (a) => planGoal({ goal: "the goal", repoMap: "a.ts", adapter: f.adapter, model: null, cwd: "/r", ...a }),
    run: (dag, ctx) => {
      runs.push({ dag: dag.tasks.map((t) => t.id), phase: ctx.phase, baseRef: ctx.baseRef });
      return runDag({
        store, runId, dag, repo: "/r", adapters: { claude: f.adapter, codex: f.adapter }, worktrees: wt, modelFor: () => null,
        toolsFor: () => ["Read"], concurrency: 2, signal: o.signal,
        repairResult: undefined,
      });
    },
    integrate: o.integrate,
    onPhaseStart: (p) => started.push(p),
  };
  store.createRun(runId, "the goal", "/r");
  const planCalls = () => f.calls.filter((c) => c.taskId === "planner");
  return { deps, f, runs, started, planCalls };
}
const mk = () => new Store(":memory:");
const evs = (s: Store, type: string) => s.listEvents("r1").filter((e) => e.type === type);

describe("runPhases", () => {
  it("runs two phases; the phase-2 planner prompt contains the phase-1 summaries; stops when the planner says done", async () => {
    const s = mk();
    const h = harness(s, { plans: {
      1: { tasks: [task("p1-api")], remaining: "wire the UI" },
      2: { tasks: [task("p2-ui", { needs: ["p1-api/summary"] })], remaining: "" },
    } });
    const r = await runPhases(h.deps);
    expect(r.complete).toBe(true);
    expect(r.stop).toBeUndefined();
    expect(r.remaining).toBe("");
    expect(r.results).toEqual({ "p1-api": "done", "p2-ui": "done" });
    expect(h.planCalls()).toHaveLength(2); // no third call: phase 2 returned remaining ""
    const second = h.planCalls()[1].prompt;
    expect(second).toContain("did p1-api");
    expect(second).toContain("dec p1-api");
    expect(second).toContain("q p1-api");
    expect(second).toContain("wire the UI");
    // phase-2 worker received the phase-1 blackboard slice
    expect(h.f.calls.find((c) => c.taskId === "p2-ui")!.prompt).toContain("did p1-api");
    // tasks are stamped with their phase and the union plan is saved
    expect(r.phases.map((p) => p.dag.tasks.map((t) => t.phase))).toEqual([[1], [2]]);
    expect(s.loadPlan("r1")!.tasks.map((t) => [t.id, t.phase])).toEqual([["p1-api", 1], ["p2-ui", 2]]);
    expect(s.listPhases("r1").map((p) => [p.phase, p.remaining, p.status])).toEqual([[1, "wire the UI", "done"], [2, "", "done"]]);
  });
  it("a single phase with remaining '' makes exactly one planner call and no phase 2", async () => {
    const s = mk();
    const h = harness(s, { plans: { 1: { tasks: [task("p1-a")], remaining: "" } } });
    const r = await runPhases(h.deps);
    expect(r.complete).toBe(true);
    expect(h.planCalls()).toHaveLength(1);
    expect(r.phases).toHaveLength(1);
  });
  it("tasks: [] from the re-planner means done and clears the remaining text", async () => {
    const s = mk();
    const h = harness(s, { plans: { 1: { tasks: [task("p1-a")], remaining: "maybe more" }, 2: { tasks: [], remaining: "" } } });
    const r = await runPhases(h.deps);
    expect(r.complete).toBe(true);
    expect(r.remaining).toBe("");
    expect(r.phases).toHaveLength(1);
    expect(s.listPhases("r1")).toHaveLength(1);
    expect(s.listPhases("r1")[0].remaining).toBe("");
  });
  it("stops at maxPhases with the remaining text and does not plan another phase", async () => {
    const s = mk();
    const h = harness(s, { limits: { maxPhases: 2 }, plans: {
      1: { tasks: [task("p1-a")], remaining: "r1" }, 2: { tasks: [task("p2-a")], remaining: "still more" }, 3: { tasks: [task("p3-a")], remaining: "" },
    } });
    const r = await runPhases(h.deps);
    expect(r.complete).toBe(false);
    expect(r.stop?.reason).toBe("max_phases");
    expect(r.remaining).toBe("still more");
    expect(h.planCalls()).toHaveLength(2);
    expect(h.runs.map((x) => x.phase)).toEqual([1, 2]);
  });
  it("stops when maxTotalTokens is exceeded (checked before starting each phase)", async () => {
    const s = mk();
    const h = harness(s, { limits: { maxTotalTokens: 20 }, plans: {
      1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "m" }, 3: { tasks: [task("p3-a")], remaining: "" },
    } });
    const r = await runPhases(h.deps);
    expect(r.stop?.reason).toBe("max_tokens");
    expect(r.complete).toBe(false);
    expect(h.runs.map((x) => x.phase)).toEqual([1, 2]); // 15 tokens <= 20 before phase 2; 30 > 20 before phase 3
    expect(h.planCalls()).toHaveLength(2);             // the planner is not asked for phase 3
  });
  it("counts planner usage towards maxTotalTokens and records it as a task-less usage event", async () => {
    const s = mk();
    const f = fakeAdapter((i) => (i.taskId === "planner"
      ? [{ type: "usage", input: 100, output: 50, cached: null, costUsd: null }, ...res({ tasks: [task("p1-a")], remaining: "more" })]
      : workerOk(i.taskId)));
    const h = harness(s, { plans: {} });
    const deps: PhasesDeps = { ...h.deps, limits: { ...h.deps.limits, maxTotalTokens: 100 }, plan: (a) => planGoal({ goal: "g", repoMap: "a", adapter: f.adapter, model: null, cwd: "/r", ...a }) };
    const r = await runPhases(deps);
    expect(s.usageTokens("r1")).toBeGreaterThanOrEqual(165); // 150 planner + 15 worker
    expect(r.stop?.reason).toBe("max_tokens");               // 165 > 100 before phase 2
    const planner = evs(s, "usage").find((e) => e.task_id === null);
    expect(planner).toMatchObject({ agent_id: "planner", payload: { input: 100, output: 50 } });
  });
  it("a phase with zero done tasks stops with no_progress (never loops)", async () => {
    const s = mk();
    const h = harness(s, { worker: (i) => (i.taskId.startsWith("p2") ? new Error("boom") : workerOk(i.taskId)), plans: {
      1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "m2" }, 3: { tasks: [task("p3-a")], remaining: "" },
    } });
    const r = await runPhases(h.deps);
    expect(r.stop?.reason).toBe("no_progress");
    expect(r.complete).toBe(false);
    expect(r.remaining).toBe("m2");
    expect(h.planCalls()).toHaveLength(2);
    expect(r.results["p2-a"]).toBe("failed");
  });
  it("abort mid-phase: stops with 'aborted', never re-plans", async () => {
    const s = mk(); const ac = new AbortController();
    let started!: () => void; const running = new Promise<void>((r) => { started = r; });
    const h = harness(s, { signal: ac.signal, plans: { 1: { tasks: [task("p1-a")], remaining: "m" } } });
    const f2 = fakeAdapter(() => []);
    void f2;
    const waiting = { runtime: "claude" as const, async *run(i: AdapterInput): AsyncGenerator<AgentEvent> {
      if (i.taskId === "planner") { yield { type: "result", text: JSON.stringify({ tasks: [task("p1-a")], remaining: "m" }) }; return; }
      started(); await new Promise<void>((r) => i.signal.addEventListener("abort", () => r()));
      throw new Error("aborted");
    } };
    const deps: PhasesDeps = { ...h.deps, plan: (a) => planGoal({ goal: "g", repoMap: "a", adapter: waiting, model: null, cwd: "/r", ...a }),
      run: (dag) => runDag({ store: s, runId: "r1", dag, repo: "/r", adapters: { claude: waiting, codex: waiting }, worktrees: { create: async (id) => `/wt/${id}`, remove: async () => {}, commit: async () => {} }, modelFor: () => null, toolsFor: () => ["Read"], concurrency: 1, signal: ac.signal }) };
    const p = runPhases(deps);
    await running; ac.abort();
    const r = await p;
    expect(r.stop?.reason).toBe("aborted");
    expect(r.complete).toBe(false);
    expect(r.phases).toHaveLength(1);
    expect(s.listPhases("r1")[0].status).toBe("incomplete");
  });
  it("a failed writer appears in the re-plan history with its wip branch and reason", async () => {
    const s = mk();
    const h = harness(s, { worker: (i) => (i.taskId === "p1-bad" ? new Error("kaboom") : workerOk(i.taskId)), plans: {
      1: { tasks: [task("p1-good"), task("p1-bad")], remaining: "redo bad part" }, 2: { tasks: [], remaining: "" },
    } });
    await runPhases(h.deps);
    const hist = h.planCalls()[1].prompt;
    expect(hist).toContain("p1-bad");
    expect(hist).toContain("failed");
    expect(hist).toContain("kaboom");
    expect(hist).toContain("mar/r1/p1-bad");
    expect(hist).not.toContain("mar/r1/p1-good");
    expect(hist).toContain("redo bad part");
  });
  it("includes blocked tasks with a reason and no branch", async () => {
    const s = mk();
    const h = harness(s, { worker: (i) => (i.taskId === "p1-a" ? new Error("nope") : workerOk(i.taskId)), plans: {
      1: { tasks: [task("p1-a"), task("p1-b", { dependsOn: ["p1-a"] }), task("p1-c", { paths: ["c/**"] })], remaining: "more" }, 2: { tasks: [], remaining: "" },
    } });
    await runPhases(h.deps);
    const hist = h.planCalls()[1].prompt;
    expect(hist).toMatch(/p1-b \[implementer\] blocked/);
    expect(hist).not.toContain("mar/r1/p1-b");
  });
  it("emits phase_started and phase_finished with the documented payloads", async () => {
    const s = mk();
    const h = harness(s, { plans: { 1: { tasks: [task("p1-a"), task("p1-b")], remaining: "next" }, 2: { tasks: [task("p2-a")], remaining: "" } } });
    await runPhases(h.deps);
    const started = evs(s, "phase_started"), finished = evs(s, "phase_finished");
    expect(started.map((e) => e.task_id)).toEqual([null, null]);
    expect(started[0].payload).toEqual({ phase: 1, maxPhases: 5, tasks: ["p1-a", "p1-b"], remaining: "next" });
    expect(started[1].payload).toEqual({ phase: 2, maxPhases: 5, tasks: ["p2-a"], remaining: "" });
    expect(finished[0].payload).toEqual({ phase: 1, done: 2, failed: 0, blocked: 0, tokens: 30 });
    expect(finished[1].payload).toMatchObject({ phase: 2, done: 1, tokens: 15 });
    expect(h.started).toHaveLength(2);
  });
  it("failure counts in phase_finished", async () => {
    const s = mk();
    const h = harness(s, { worker: (i) => (i.taskId === "p1-a" ? new Error("x") : workerOk(i.taskId)), plans: { 1: { tasks: [task("p1-a"), task("p1-b", { dependsOn: ["p1-a"] }), task("p1-c")], remaining: "" } } });
    await runPhases(h.deps);
    expect(evs(s, "phase_finished")[0].payload).toMatchObject({ done: 1, failed: 1, blocked: 1 });
  });
  it("rejects an unprefixed phase-2 plan once, feeds the error back and runs the repaired plan", async () => {
    const s = mk();
    const f = fakeAdapter((i) => {
      if (i.taskId !== "planner") return workerOk(i.taskId);
      if (!i.prompt.includes("NEXT phase")) return res({ tasks: [task("p1-a")], remaining: "m" });
      return res(i.prompt.includes("rejected:") ? { tasks: [task("p2-a")], remaining: "" } : { tasks: [task("api")], remaining: "" });
    });
    const base = harness(s, { plans: {} });
    const r = await runPhases({ ...base.deps, plan: (a) => planGoal({ goal: "g", repoMap: "a", adapter: f.adapter, model: null, cwd: "/r", ...a }),
      run: (dag) => runDag({ store: s, runId: "r1", dag, repo: "/r", adapters: { claude: f.adapter, codex: f.adapter }, worktrees: { create: async (id) => `/wt/${id}`, remove: async () => {}, commit: async () => {} }, modelFor: () => null, toolsFor: () => ["Read"], concurrency: 1 }) });
    expect(r.complete).toBe(true);
    expect(r.results["p2-a"]).toBe("done");
  });
  it("a failing re-plan stops with replan_failed and keeps the work done so far", async () => {
    const s = mk();
    const h = harness(s, { plans: { 1: { tasks: [task("p1-a")], remaining: "m" } } });
    const r = await runPhases({ ...h.deps, plan: async (a) => { if (a.phase === 1) return { tasks: [{ ...task("p1-a"), dependsOn: [], needs: [] }] as never, remaining: "m" }; throw new Error("planner exploded password=hunter2xyz"); } });
    expect(r.stop?.reason).toBe("replan_failed");
    expect(r.stop?.message).not.toContain("hunter2xyz");
    expect(r.results["p1-a"]).toBe("done");
    expect(r.complete).toBe(false);
  });
  it("phase-1 planning failure propagates (the caller records it)", async () => {
    const s = mk(); const h = harness(s, { plans: {} });
    await expect(runPhases({ ...h.deps, plan: async () => { throw new Error("no plan"); } })).rejects.toThrow("no plan");
  });
});

describe("runPhases resume", () => {
  it("continues at the first phase with unfinished tasks, then keeps looping", async () => {
    const s = mk();
    const first = harness(s, { worker: (i) => (i.taskId.startsWith("p2") ? new Error("flaky") : workerOk(i.taskId)), plans: {
      1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "m2" },
    } });
    expect((await runPhases(first.deps)).stop?.reason).toBe("no_progress");
    const second = harness(s, { plans: { 3: { tasks: [task("p3-a")], remaining: "" } } });
    // fresh deps over the same store (a new `mar resume` process)
    const r = await runPhases(second.deps);
    expect(second.f.calls.map((c) => c.taskId)).toEqual(["p2-a", "planner", "p3-a"]); // p1-a is NOT re-run, no replan before p2 finished
    expect(second.runs.map((x) => x.phase)).toEqual([2, 3]);
    expect(r.complete).toBe(true);
    expect(r.results).toEqual({ "p1-a": "done", "p2-a": "done", "p3-a": "done" });
    expect(phaseOf(second.planCalls()[0].prompt)).toBe(3);
    expect(second.planCalls()[0].prompt).toContain("did p2-a");
  });
  it("a finished run (remaining '') does nothing and reports complete", async () => {
    const s = mk();
    await runPhases(harness(s, { plans: { 1: { tasks: [task("p1-a")], remaining: "" } } }).deps);
    const again = harness(s, { plans: {} });
    const r = await runPhases(again.deps);
    expect(again.f.calls).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.phases).toHaveLength(1);
  });
  it("resuming after maxPhases with a higher limit continues planning", async () => {
    const s = mk();
    const a = harness(s, { limits: { maxPhases: 1 }, plans: { 1: { tasks: [task("p1-a")], remaining: "rest" } } });
    expect((await runPhases(a.deps)).stop?.reason).toBe("max_phases");
    const b = harness(s, { limits: { maxPhases: 3 }, plans: { 2: { tasks: [task("p2-a")], remaining: "" } } });
    const r = await runPhases(b.deps);
    expect(r.complete).toBe(true);
    expect(b.runs.map((x) => x.phase)).toEqual([2]);
    expect(phaseOf(b.planCalls()[0].prompt)).toBe(2);
    expect(b.planCalls()[0].prompt).toContain("rest");
  });
  it("an old single-plan run (no phases rows) resumes as phase 1 with remaining ''", async () => {
    const s = mk(); s.createRun("r1", "g", "/r");
    s.savePlan("r1", { tasks: [{ id: "a", role: "implementer", runtime: "claude", tier: "mid", goal: "A", dependsOn: [], needs: [], paths: [] }] } as never);
    const h = harness(s, { plans: {} });
    const r = await runPhases(h.deps);
    expect(h.runs).toEqual([{ dag: ["a"], phase: 1, baseRef: undefined }]);
    expect(h.planCalls()).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.phases[0].remaining).toBe("");
  });
});

describe("runPhases integration", () => {
  const ok = (branch = "mar/r1/integration"): IntegrationOutcome => ({ result: { branch, merged: [] } });
  it("integrates after every phase with >= 1 done writer when multi-phase; accumulates and builds on the tip", async () => {
    const s = mk(); const calls: any[] = [];
    const h = harness(s, { integrate: async (a) => { calls.push(a); return ok(); }, plans: {
      1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "" },
    } });
    const r = await runPhases(h.deps);
    expect(calls.map((c) => [c.phase, c.branches, c.accumulate, c.baseRef])).toEqual([
      [1, ["mar/r1/p1-a"], false, undefined],
      [2, ["mar/r1/p2-a"], true, "mar/r1/integration"],
    ]);
    expect(h.runs.map((x) => x.baseRef)).toEqual([undefined, "mar/r1/integration"]);
    expect(r.phases.map((p) => p.integration?.result?.branch)).toEqual(["mar/r1/integration", "mar/r1/integration"]);
    expect(evs(s, "integration").map((e) => e.payload.phase)).toEqual([1, 2]);
  });
  it("single-phase runs keep today's rule: only with >= 2 done writers", async () => {
    const s = mk(); const fn = vi.fn(async () => ok());
    await runPhases(harness(s, { integrate: fn, plans: { 1: { tasks: [task("p1-a")], remaining: "" } } }).deps);
    expect(fn).not.toHaveBeenCalled();
    const s2 = mk(); const fn2 = vi.fn(async () => ok());
    await runPhases(harness(s2, { integrate: fn2, plans: { 1: { tasks: [task("p1-a"), task("p1-b")], remaining: "" } } }).deps);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
  it("branches are in topological order and only done writers are merged", async () => {
    const s = mk(); const calls: any[] = [];
    const h = harness(s, { integrate: async (a) => { calls.push(a); return ok(); }, worker: (i) => (i.taskId === "p1-x" ? new Error("no") : workerOk(i.taskId)), plans: {
      1: { tasks: [task("p1-z", { dependsOn: ["p1-y"] }), task("p1-y"), task("p1-x", { paths: ["x/**"] }), task("p1-r", { role: "reviewer" })], remaining: "m" }, 2: { tasks: [], remaining: "" },
    } });
    await runPhases(h.deps);
    expect(calls[0].branches).toEqual(["mar/r1/p1-y", "mar/r1/p1-z"]);
  });
  it("no integration when none is injected; an integration error does not abort the loop; the diff stat reaches the re-planner", async () => {
    const s = mk();
    const noInt = harness(s, { plans: { 1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "" } } });
    expect((await runPhases(noInt.deps)).complete).toBe(true);
    const s2 = mk();
    const bad = harness(s2, { integrate: async () => ({ error: "git exploded" }), plans: { 1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [], remaining: "" } } });
    const r = await runPhases({ ...bad.deps, diffStat: async (b) => ` src/a.ts | 3 +++ (${b})` });
    expect(bad.planCalls()[1].prompt).toContain("git exploded");
    expect(r.integration?.error).toBe("git exploded");
    const s3 = mk();
    const good = harness(s3, { integrate: async () => ({ result: { branch: "mar/r1/integration", merged: ["mar/r1/p1-a"], conflict: { branch: "mar/r1/p1-b", files: ["z.ts"] } } }), plans: { 1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [], remaining: "" } } });
    await runPhases({ ...good.deps, diffStat: async (b) => ` src/a.ts | 3 +++ (${b})` });
    const p = good.planCalls()[1].prompt;
    expect(p).toContain("src/a.ts | 3 +++ (mar/r1/integration)");
    expect(p).toContain("z.ts");
  });
  it("does not integrate once aborted", async () => {
    const s = mk(); const fn = vi.fn(async () => ok()); const ac = new AbortController(); ac.abort();
    const h = harness(s, { integrate: fn, signal: ac.signal, plans: { 1: { tasks: [task("p1-a"), task("p1-b")], remaining: "" } } });
    await runPhases(h.deps);
    expect(fn).not.toHaveBeenCalled();
  });
});
