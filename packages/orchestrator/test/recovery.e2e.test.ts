import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/src/store.js";
import { planGoal } from "../src/planner.js";
import { runDag } from "../src/scheduler.js";
import { runPhases, type PhasesDeps } from "../src/phases.js";
import { createWorktrees } from "../src/worktree.js";
import { integrate } from "../src/integrate.js";
import { fakeAdapter } from "./fakeAdapter.js";
import type { AdapterInput, AgentEvent } from "../../adapters/src/types.js";

// The exact failure of run rmuwcqki6, with REAL git: parallel writers all append to one shared file outside their
// paths, a dependent task cannot merge them, the planner said `remaining: ""`. The run must recover.
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
afterAll(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
let repo: string;
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const gi = (cwd: string, ...a: string[]) => g(cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a);
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mar-e2e-"));
  g(repo, "init", "-q", "-b", "feat/base"); g(repo, "config", "user.email", "t@t"); g(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "shared.txt"), "base\n"); writeFileSync(join(repo, ".gitignore"), ".mar/\n");
  g(repo, "add", "."); g(repo, "commit", "-qm", "init");
});

const RUN = "r1";
const task = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `goal of ${id}`, paths: [`${id}/**`], ...extra });
const res = (o: unknown): AgentEvent[] => [{ type: "result", text: JSON.stringify(o) }];
const done = (id: string): AgentEvent[] => [{ type: "result", text: JSON.stringify({ summary: `did ${id}`, filesChanged: [], decisions: [], openQuestions: [] }) }];
const phaseOf = (prompt: string) => Number(/plan the NEXT phase \(phase (\d+)\)/.exec(prompt)?.[1] ?? 1);

const phase1 = {
  tasks: [task("p1-a"), task("p1-b"), task("p1-c"), task("p1-polish", { dependsOn: ["p1-a", "p1-b", "p1-c"], paths: [] })],
  remaining: "",
};
const recoveryPlan = { tasks: [task("p2-resolve", { paths: ["shared.txt", "p1-b/**", "p1-c/**"] })], remaining: "" };

interface Opts { plans?: Record<number, unknown>; resolver?: (i: AdapterInput) => AgentEvent[] | Error; limits?: Partial<PhasesDeps["limits"]>; signal?: AbortSignal; onPlan?: (phase: number) => void }

function setup(o: Opts = {}) {
  const store = new Store(":memory:"); store.createRun(RUN, "the goal", repo);
  const append = (i: AdapterInput, id: string) => {
    appendFileSync(join(i.cwd, "shared.txt"), `line from ${id}\n`);
    mkdirSync(join(i.cwd, id), { recursive: true }); writeFileSync(join(i.cwd, id, "out.txt"), id);
  };
  // Resolver: merges the unmerged branches onto the integration tip it started from and resolves shared.txt.
  const defaultResolver = (i: AdapterInput): AgentEvent[] => {
    for (const b of ["p1-b", "p1-c"]) {
      try { gi(i.cwd, "merge", "--no-edit", `mar/${RUN}/${b}`); } catch { /* conflict expected */ }
      writeFileSync(join(i.cwd, "shared.txt"), "base\nline from p1-a\nline from p1-b\nline from p1-c\n");
      gi(i.cwd, "add", "-A"); gi(i.cwd, "commit", "--no-edit", "-m", `resolve ${b}`);
    }
    return done(i.taskId);
  };
  const f = fakeAdapter((i) => {
    if (i.taskId === "planner") { const p = phaseOf(i.prompt); o.onPlan?.(p); return res((o.plans ?? { 1: phase1, 2: recoveryPlan })[p] ?? { tasks: [] }); }
    if (i.taskId === "p1-polish") return done(i.taskId);
    if (/^p1-[abc]$/.test(i.taskId)) { append(i, i.taskId); return done(i.taskId); }
    return (o.resolver ?? defaultResolver)(i);
  });
  const runs: { phase: number; baseRef?: string }[] = [];
  const deps: PhasesDeps = {
    store, runId: RUN, signal: o.signal,
    limits: { maxTasks: 8, maxPhases: 5, maxTotalTokens: 1_000_000, ...o.limits },
    plan: (a) => planGoal({ goal: "the goal", repoMap: "shared.txt", adapter: f.adapter, model: null, cwd: repo, ...a }),
    run: (dag, ctx) => {
      runs.push({ phase: ctx.phase, baseRef: ctx.baseRef });
      return runDag({
        store, runId: RUN, dag, repo, adapters: { claude: f.adapter, codex: f.adapter },
        worktrees: createWorktrees(repo, RUN, { ...(ctx.baseRef ? { baseRef: ctx.baseRef } : {}) }),
        modelFor: () => null, toolsFor: () => ["Read"], concurrency: 3, signal: o.signal,
      });
    },
    integrate: async (a) => ({ result: await integrate({ repo, runId: RUN, branches: a.branches, ...(a.accumulate ? { baseRef: a.baseRef, reset: false } : {}) }) }),
  };
  return { store, f, deps, runs, planPrompts: () => f.calls.filter((c) => c.taskId === "planner").map((c) => c.prompt) };
}
const types = (s: Store, t: string) => s.listEvents(RUN).filter((e) => e.type === t);
const worktreeDirs = () => g(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
const userState = () => ({ head: g(repo, "rev-parse", "HEAD"), branch: g(repo, "rev-parse", "--abbrev-ref", "HEAD"), status: g(repo, "status", "--porcelain"), file: readFileSync(join(repo, "shared.txt"), "utf8") });

describe("recovery after a dependency merge conflict (real git)", () => {
  it("recovers: conflict is reported, a resolver task on the integration tip finishes the run", async () => {
    const before = userState();
    const h = setup();
    const r = await runPhases(h.deps);

    // outcome
    expect(r.stop).toBeUndefined();
    expect(r.complete).toBe(true);
    expect(r.results).toMatchObject({ "p1-a": "done", "p1-b": "done", "p1-c": "done", "p1-polish": "failed", "p2-resolve": "done" });
    expect(h.runs.map((x) => x.phase)).toEqual([1, 2]);
    expect(h.runs[1].baseRef).toBe(`mar/${RUN}/integration`);
    expect(h.planPrompts()).toHaveLength(2);
    expect(h.store.taskStatuses(RUN).find((s) => s.task_id === "p1-polish")!.detail).toMatch(/^dependency p1-[bc]: merge conflict in shared\.txt$/);

    // events
    const dep = types(h.store, "dependency_merge_conflict");
    expect(dep).toHaveLength(1);
    expect(dep[0].payload).toMatchObject({ task: "p1-polish", files: ["shared.txt"] });
    expect(types(h.store, "ownership_violation").length).toBeGreaterThanOrEqual(3);
    const predicted = types(h.store, "predicted_conflict").map((e) => (e.payload.tasks as string[]).join("+")).sort();
    expect(predicted).toEqual(["p1-a+p1-b", "p1-a+p1-c", "p1-b+p1-c"]);
    expect(types(h.store, "phase_started").map((e) => e.payload.phase)).toEqual([1, 2]);

    // the recovery history names the conflicting file, the unmerged branches and the dependency conflict
    const hist = h.planPrompts()[1];
    expect(hist).toContain("The previous phase had failures.");
    expect(hist).toContain("shared.txt");
    expect(hist).toContain("NOT merged into the integration branch");
    expect(hist).toContain(`mar/${RUN}/p1-b`);
    expect(hist).toContain(`mar/${RUN}/p1-c`);
    expect(hist).toMatch(/p1-polish failed: dependency p1-[bc].*shared\.txt/);
    expect(hist).toMatch(/p1-[abc] and p1-[abc]: shared\.txt/);

    // the integration branch now holds everything, resolved
    const tip = `mar/${RUN}/integration`;
    expect(g(repo, "show", `${tip}:shared.txt`)).toBe("base\nline from p1-a\nline from p1-b\nline from p1-c");
    for (const id of ["p1-a", "p1-b", "p1-c"]) expect(g(repo, "show", `${tip}:${id}/out.txt`)).toBe(id);
    expect(types(h.store, "integration").at(-1)!.payload).toMatchObject({ phase: 2, branch: tip });
    expect(types(h.store, "integration").at(-1)!.payload.conflict).toBeUndefined();

    // nothing half-merged, nothing left behind, the user's branch untouched
    expect(worktreeDirs()).toHaveLength(1);
    expect(existsSync(join(repo, ".mar", "worktrees", RUN))).toBe(false);
    expect(g(repo, "branch", "--list", `mar/${RUN}/p1-polish`)).toBe(""); // its never-started branch was removed
    expect(() => g(repo, "rev-parse", "--verify", "-q", "MERGE_HEAD")).toThrow();
    expect(userState()).toEqual(before);
  });

  it("loop protection: a recovery that fails again stops with recovery_stalled (no third phase, no endless loop)", async () => {
    const h = setup({ resolver: () => new Error("resolver exploded"), plans: { 1: phase1, 2: recoveryPlan, 3: { tasks: [task("p3-x")], remaining: "" } } });
    const r = await runPhases(h.deps);
    expect(r.stop?.reason).toBe("recovery_stalled");
    expect(r.complete).toBe(false);
    expect(h.runs.map((x) => x.phase)).toEqual([1, 2]);
    expect(h.planPrompts()).toHaveLength(2);
    expect(worktreeDirs()).toHaveLength(1);
  });

  it("respects maxPhases while recovering", async () => {
    const h = setup({ limits: { maxPhases: 1 } });
    const r = await runPhases(h.deps);
    expect(r.stop?.reason).toBe("max_phases");
    expect(h.runs.map((x) => x.phase)).toEqual([1]);
    expect(h.planPrompts()).toHaveLength(1);
  });

  it("abort: an aborted run does not plan a recovery phase and leaves no worktrees", async () => {
    const ac = new AbortController();
    const h = setup({ signal: ac.signal });
    const deps = { ...h.deps, integrate: async (a: Parameters<NonNullable<PhasesDeps["integrate"]>>[0]) => { const out = await h.deps.integrate!(a); ac.abort(); return out; } };
    const r = await runPhases(deps);
    expect(r.stop?.reason).toBe("aborted");
    expect(h.planPrompts()).toHaveLength(1);
    expect(h.runs.map((x) => x.phase)).toEqual([1]);
    expect(worktreeDirs()).toHaveLength(1);
  });
});
