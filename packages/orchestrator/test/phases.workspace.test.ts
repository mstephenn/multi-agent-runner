import { describe, it, expect } from "vitest";
import { Store } from "../../server/src/store.js";
import { planGoal } from "../src/planner.js";
import { runDag } from "../src/scheduler.js";
import { runPhases, type PhasesDeps, type IntegrationOutcome } from "../src/phases.js";
import { fakeAdapter } from "./fakeAdapter.js";
import type { AdapterInput, AgentEvent } from "../../adapters/src/types.js";

const task = (id: string, repo: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `goal of ${id}`, repo, paths: [`${id}/**`], ...extra });
const res = (o: unknown): AgentEvent[] => [{ type: "result", text: JSON.stringify(o) }];
const worker = (id: string): AgentEvent[] => [
  { type: "usage", input: 10, output: 5, cached: null, costUsd: null },
  { type: "result", text: JSON.stringify({ summary: `did ${id}`, filesChanged: [], decisions: [], openQuestions: [] }) },
];
const phaseOf = (prompt: string) => Number(/plan the NEXT phase \(phase (\d+)\)/.exec(prompt)?.[1] ?? 1);
const REPOS = ["api", "web", "docs"];

type IntegrateArgs = Parameters<NonNullable<PhasesDeps["integrate"]>>[0];
function harness(store: Store, plans: Record<number, unknown>, over: Partial<PhasesDeps> = {}, fail: (i: AdapterInput) => boolean = () => false) {
  const f = fakeAdapter((i) => (i.taskId === "planner" ? res(plans[phaseOf(i.prompt)] ?? { tasks: [] }) : fail(i) ? new Error("boom") : worker(i.taskId)));
  const integrations: IntegrateArgs[] = [];
  const runs: { phase: number; baseRef?: string }[] = [];
  const wt = { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {} };
  const deps: PhasesDeps = {
    store, runId: "r1",
    limits: { maxTasks: 8, maxPhases: 5, maxTotalTokens: 1_000_000 },
    plan: (a) => planGoal({ goal: "g", repoMap: "a.ts", adapter: f.adapter, model: null, cwd: "/r", workspace: REPOS, ...a }),
    run: (dag, ctx) => {
      runs.push({ phase: ctx.phase, baseRef: ctx.baseRef });
      return runDag({ store, runId: "r1", dag, repo: "/r", adapters: { claude: f.adapter, codex: f.adapter }, worktrees: wt, modelFor: () => null, toolsFor: () => ["Read"], concurrency: 3 });
    },
    integrate: async (a) => { integrations.push(a); return { result: { branch: "mar/r1/integration", merged: a.branches } } as IntegrationOutcome; },
    ...over,
  };
  store.createRun("r1", "g", "/r");
  return { deps, f, integrations, runs };
}
const evs = (s: Store, type: string) => s.listEvents("r1").filter((e) => e.type === type);

describe("runPhases in a workspace", () => {
  it("integrates per repo (only repos with done writers), in topological order, with repo on the event", async () => {
    const s = new Store(":memory:");
    const h = harness(s, { 1: { tasks: [task("p1-a", "api"), task("p1-b", "api", { dependsOn: ["p1-a"], paths: [] }), task("p1-w", "web"), task("p1-w2", "web", { dependsOn: ["p1-w"], paths: [] })], remaining: "" } });
    const r = await runPhases(h.deps);
    expect(r.complete).toBe(true);
    expect(h.integrations.map((a) => [a.repo, a.branches, a.accumulate])).toEqual([
      ["api", ["mar/r1/p1-a", "mar/r1/p1-b"], false],
      ["web", ["mar/r1/p1-w", "mar/r1/p1-w2"], false],
    ]);
    expect(evs(s, "integration").map((e) => [e.payload.repo, e.payload.branch])).toEqual([["api", "mar/r1/integration"], ["web", "mar/r1/integration"]]);
    expect(r.phases[0].integrations?.map((i) => i.repo)).toEqual(["api", "web"]);
  });
  it("single-phase rule applies per repo: one done writer in a repo is not integrated", async () => {
    const s = new Store(":memory:");
    const h = harness(s, { 1: { tasks: [task("p1-a", "api"), task("p1-w", "web")], remaining: "" } });
    await runPhases(h.deps);
    expect(h.integrations).toEqual([]);
  });
  it("a failed integration of one repo does not stop the other and is reported per repo", async () => {
    const s = new Store(":memory:");
    const h = harness(s, { 1: { tasks: [task("p1-a", "api"), task("p1-b", "api", { dependsOn: ["p1-a"] }), task("p1-w", "web"), task("p1-x", "web", { dependsOn: ["p1-w"] })], remaining: "" } }, {
      integrate: async (a) => (a.repo === "api" ? { error: "boom" } : { result: { branch: "mar/r1/integration", merged: a.branches } }),
    });
    const r = await runPhases(h.deps);
    expect(r.phases[0].integrations).toEqual([
      { repo: "api", error: "boom" },
      { repo: "web", result: { branch: "mar/r1/integration", merged: ["mar/r1/p1-w", "mar/r1/p1-x"] } },
    ]);
    expect(evs(s, "integration").map((e) => [e.payload.repo, e.payload.error ?? e.payload.branch])).toEqual([["api", "boom"], ["web", "mar/r1/integration"]]);
  });
  it("phase 2 accumulates per repo and gets the integration branch as base; a repo first touched in phase 2 starts fresh", async () => {
    const s = new Store(":memory:");
    const h = harness(s, {
      1: { tasks: [task("p1-a", "api")], remaining: "more" },
      2: { tasks: [task("p2-a", "api"), task("p2-w", "web")], remaining: "" },
    });
    await runPhases(h.deps);
    expect(h.integrations.map((a) => [a.phase, a.repo, a.accumulate, a.baseRef])).toEqual([
      [1, "api", false, undefined],
      [2, "api", true, "mar/r1/integration"],
      [2, "web", false, undefined],
    ]);
    expect(h.runs).toEqual([{ phase: 1, baseRef: undefined }, { phase: 2, baseRef: "mar/r1/integration" }]);
  });
  it("the re-planner history shows repo per task and per-repo integration results", async () => {
    const s = new Store(":memory:");
    const h = harness(s, {
      1: { tasks: [task("p1-a", "api"), task("p1-w", "web")], remaining: "more" },
      2: { tasks: [task("p2-a", "api")], remaining: "" },
    });
    await runPhases(h.deps);
    const second = h.f.calls.filter((c) => c.taskId === "planner")[1].prompt;
    expect(second).toMatch(/p1-a \[implementer @api\] done/);
    expect(second).toMatch(/p1-w \[implementer @web\] done/);
  });
  it("per-repo integrates() switch skips repos with integration off", async () => {
    const s = new Store(":memory:");
    const h = harness(s, { 1: { tasks: [task("p1-a", "api"), task("p1-b", "api", { dependsOn: ["p1-a"] }), task("p1-w", "web"), task("p1-x", "web", { dependsOn: ["p1-w"] })], remaining: "" } }, { integrates: (repo) => repo === "web" });
    await runPhases(h.deps);
    expect(h.integrations.map((a) => a.repo)).toEqual(["web"]);
  });
  it("resume replays stored per-repo integrations", async () => {
    const s = new Store(":memory:");
    const plans = { 1: { tasks: [task("p1-a", "api"), task("p1-b", "api", { dependsOn: ["p1-a"] })], remaining: "more" }, 2: { tasks: [task("p2-a", "api")], remaining: "" } };
    const h1 = harness(s, plans, {}, (i) => i.taskId === "p2-a");
    const r1 = await runPhases(h1.deps);
    expect(r1.phases[0].integrations?.map((i) => i.repo)).toEqual(["api"]);
    const h2 = harness(s, plans);
    s.createRun("r1", "g", "/r");
    const r2 = await runPhases(h2.deps);
    expect(r2.phases[0].integrations?.map((i) => i.repo)).toEqual(["api"]);
    expect(h2.integrations.find((a) => a.phase === 2)).toMatchObject({ repo: "api", accumulate: true, baseRef: "mar/r1/integration" });
  });
});
