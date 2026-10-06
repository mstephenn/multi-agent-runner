import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { EventEmitter } from "node:events"; import { createServer } from "node:net"; import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Store } from "../../server/src/store.js";
import { startServer } from "../../server/src/server.js";
import { executeRun, parseCli, runMain, UsageError, type MainDeps } from "../src/main.js";
import { loadConfig } from "../src/config.js";
import { fakeAdapter } from "../../orchestrator/test/fakeAdapter.js";
import type { AdapterInput, AgentEvent } from "../../adapters/src/types.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "mar-ph-")); roots.push(d); return d; };
const gitRepo = () => { const d = tmp(); execFileSync("git", ["init", "-q"], { cwd: d }); return d; };
const free = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const wt = { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {}, branchFor: (id: string) => `mar/x/${id}` };

const task = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `goal of ${id}`, paths: [`${id}/**`], ...extra });
const res = (o: unknown): AgentEvent[] => [{ type: "result", text: JSON.stringify(o) }];
const workerOk = (id: string): AgentEvent[] => [
  { type: "usage", input: 10, output: 5, cached: null, costUsd: null },
  { type: "result", text: JSON.stringify({ summary: `did ${id}`, filesChanged: [], decisions: [], openQuestions: [] }) },
];
const phaseOf = (prompt: string) => Number(/plan the NEXT phase \(phase (\d+)\)/.exec(prompt)?.[1] ?? 1);
const plans = (p: Record<number, unknown>, worker?: (i: AdapterInput) => AgentEvent[] | Error) =>
  fakeAdapter((i) => (i.taskId === "planner" ? res(p[phaseOf(i.prompt)] ?? { tasks: [] }) : worker ? worker(i) : workerOk(i.taskId)));

const capture = () => {
  const out: string[] = []; const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  return { out, err, text: () => out.join("\n") };
};
const go = async (argv: string[], f: ReturnType<typeof fakeAdapter>, over: Partial<MainDeps> = {}) => {
  const proc = new EventEmitter() as MainDeps["proc"] & EventEmitter;
  return runMain([...argv, "--port", String(await free())], {
    adapters: () => ({ claude: f.adapter, codex: f.adapter }), preflight: async () => [], proc, exit: () => {}, worktrees: wt, repoMapFn: () => "a.ts", ...over,
  });
};
const twoPhases = { 1: { tasks: [task("p1-api")], remaining: "wire the UI" }, 2: { tasks: [task("p2-ui", { needs: ["p1-api/summary"] })], remaining: "" } };

describe("parseCli --phases", () => {
  it("accepts 1..10 on run and resume", () => {
    expect(parseCli(["run", "g", "--phases", "3"])).toMatchObject({ cmd: "run", phases: 3 });
    expect(parseCli(["resume", "r1", "--phases", "10"])).toMatchObject({ cmd: "resume", phases: 10 });
    expect(parseCli(["run", "g"])).not.toHaveProperty("phases");
  });
  it.each(["0", "11", "-1", "abc", "2.5", ""])("rejects --phases %j", (v) => { expect(() => parseCli(["run", "g", "--phases", v])).toThrow(UsageError); });
  it("--phases without a value is a usage error", () => { expect(() => parseCli(["run", "g", "--phases"])).toThrow(UsageError); });
  it("has no plan/approval flags", () => {
    for (const flag of ["--review", "--plan-file"]) expect(() => parseCli(["run", "g", flag, "x"])).toThrow(UsageError);
    expect(() => parseCli(["plan", "g"])).toThrow(UsageError);
  });
});

describe("runMain: phased runs", () => {
  it("prints the phase headers, plan tables and grouped summaries; exit 0 when the last planner call said done", async () => {
    const c = capture(); const f = plans(twoPhases);
    expect(await go(["run", "big goal", "--repo", gitRepo()], f)).toBe(0);
    const out = c.text();
    expect(out).toContain("== Phase 1 (max 5) ==");
    expect(out).toContain("== Phase 2 (max 5) ==");
    expect(out).toMatch(/id +role +runtime\/tier +depends +paths +worktree +goal/);
    expect(out).toMatch(/p1-api +implementer +claude\/mid +- +p1-api\/\*\* +own +goal of p1-api/);
    expect(out).toContain("-- Phase 1 --\n  p1-api  done  mar/r");
    expect(out).toContain("-- Phase 2 --\n  p2-ui  done  mar/r");
    expect(out.indexOf("== Phase 2")).toBeGreaterThan(out.indexOf("== Phase 1"));
    expect(out).not.toContain("Stopped early");
    expect(f.calls.filter((x) => x.taskId === "planner")).toHaveLength(2);
  });
  it("single-phase run prints one header and no `-- Phase` summary headers", async () => {
    const c = capture(); const f = plans({ 1: { tasks: [task("p1-a")], remaining: "" } });
    expect(await go(["run", "small", "--repo", gitRepo()], f)).toBe(0);
    expect(c.text()).toContain("== Phase 1 (max 5) ==");
    expect(c.text()).not.toContain("-- Phase");
    expect(f.calls.filter((x) => x.taskId === "planner")).toHaveLength(1);
  });
  it("--phases limits this invocation: stops with the reason, remaining text and resume hint; exit 1", async () => {
    const c = capture(); const f = plans(twoPhases);
    expect(await go(["run", "big", "--repo", gitRepo(), "--phases", "1"], f)).toBe(1);
    const out = c.text();
    expect(out).toContain("== Phase 1 (max 1) ==");
    expect(out).toMatch(/Stopped early: reached the limit of 1 phase/);
    expect(out).toContain("Remaining: wire the UI");
    expect(out).toMatch(/mar resume r[a-z0-9]+ --phases 4/);
    expect(out).not.toContain("== Phase 2");
  });
  it("`mar resume <id> --phases 8` continues a run that hit the limit and finishes with exit 0", async () => {
    const repo = gitRepo(); capture();
    expect(await go(["run", "big", "--repo", repo, "--phases", "1"], plans(twoPhases))).toBe(1);
    const runId = new Store(join(repo, ".mar", "mar.db")).listRuns()[0].id;
    const c = capture(); const f2 = plans(twoPhases);
    expect(await go(["resume", runId, "--repo", repo, "--phases", "8"], f2)).toBe(0);
    expect(f2.calls.map((x) => x.taskId)).toEqual(["planner", "p2-ui"]); // phase 1 not re-run
    expect(c.text()).toContain("== Phase 2 (max 8) ==");
    expect(c.text()).toContain("-- Phase 1 --\n  p1-api  done");
    expect(c.text()).toContain("-- Phase 2 --\n  p2-ui  done");
  });
  it("resuming a finished multi-phase run just reprints the result (no adapter calls), exit 0", async () => {
    const repo = gitRepo(); capture();
    expect(await go(["run", "big", "--repo", repo], plans(twoPhases))).toBe(0);
    const runId = new Store(join(repo, ".mar", "mar.db")).listRuns()[0].id;
    const c = capture(); const f2 = plans({});
    expect(await go(["resume", runId, "--repo", repo], f2)).toBe(0);
    expect(f2.calls).toEqual([]);
    expect(c.text()).toContain("-- Phase 2 --");
  });
  it("a phase in which nothing finishes stops with the no-progress message and exits 1 (no loop)", async () => {
    const c = capture();
    const f = plans({ 1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "m2" }, 3: { tasks: [task("p3-a")], remaining: "" } },
      (i) => (i.taskId.startsWith("p2") ? new Error("boom") : workerOk(i.taskId)));
    expect(await go(["run", "g", "--repo", gitRepo()], f)).toBe(1);
    expect(c.text()).toMatch(/Stopped early: phase 2 finished no task/);
    expect(c.text()).toContain("Remaining: m2");
    expect(f.calls.filter((x) => x.taskId === "planner")).toHaveLength(2);
  });
  it("maxTasks and repoMapChars from .mar.json reach the planner prompt and the repo map", async () => {
    capture(); const repo = gitRepo();
    writeFileSync(join(repo, ".mar.json"), JSON.stringify({ maxTasks: 3, repoMapChars: 5000 }));
    const seen: number[] = [];
    const f = plans({ 1: { tasks: [task("p1-a")], remaining: "" } });
    expect(await go(["run", "g", "--repo", repo], f, { repoMapFn: (_r, n) => { seen.push(n); return "a.ts"; } })).toBe(0);
    expect(f.calls[0].prompt).toContain("at most 3 tasks");
    expect(seen).toEqual([5000]);
  });
  it("exit code is 1 when a task failed even though the planner said done", async () => {
    capture();
    const f = plans({ 1: { tasks: [task("p1-a"), task("p1-b")], remaining: "" } }, (i) => (i.taskId === "p1-b" ? new Error("x") : workerOk(i.taskId)));
    expect(await go(["run", "g", "--repo", gitRepo()], f)).toBe(1);
  });
});

describe("executeRun: phases", () => {
  const setup = (cfg: object = {}) => {
    const repo = tmp(); writeFileSync(join(repo, ".mar.json"), JSON.stringify(cfg));
    const store = new Store(":memory:");
    return { repo, store, config: loadConfig(repo) };
  };
  it("maxTotalTokens defaults to 5 x defaultBudgetTokens (also with --budget overrides applied to config)", async () => {
    const a = setup({ defaultBudgetTokens: 5 });
    const f = plans({ 1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "" } });
    const out = await executeRun({ goal: "g", repo: a.repo, store: a.store, config: a.config, adapters: { claude: f.adapter, codex: f.adapter }, worktrees: wt, repoMapFn: () => "a.ts" });
    // 15 tokens used by phase 1 <= 25 (5 x 5): phase 2 runs; 30 > 25 afterwards but the planner already said done
    expect(out.complete).toBe(true);
    const b = setup({ defaultBudgetTokens: 2 });
    const f2 = plans({ 1: { tasks: [task("p1-a")], remaining: "m" }, 2: { tasks: [task("p2-a")], remaining: "" } });
    const out2 = await executeRun({ goal: "g", repo: b.repo, store: b.store, config: b.config, adapters: { claude: f2.adapter, codex: f2.adapter }, worktrees: wt, repoMapFn: () => "a.ts" });
    expect(out2.stop?.reason).toBe("max_tokens"); // 15 > 10
    expect(out2.complete).toBe(false);
  });
  it("integrates after phase 1 (one writer, multi-phase), accumulates in phase 2 and builds phase 2 on the integration branch", async () => {
    const a = setup(); const calls: any[] = []; const wtCalls: any[] = [];
    const f = plans(twoPhases);
    const out = await executeRun({
      goal: "g", repo: a.repo, store: a.store, config: a.config, adapters: { claude: f.adapter, codex: f.adapter }, worktrees: wt, repoMapFn: () => "a.ts", runId: "rid",
      integrateFn: async (o) => { calls.push(o); return { branch: "mar/rid/integration", merged: o.branches }; },
      runDagFn: async (d) => { wtCalls.push(d.dag.tasks.map((t) => t.id)); return Object.fromEntries(d.dag.tasks.map((t) => [t.id, "done" as const])); },
    });
    expect(calls.map((c) => [c.branches, c.reset, c.baseRef])).toEqual([[["mar/rid/p1-api"], undefined, undefined], [["mar/rid/p2-ui"], false, "mar/rid/integration"]]);
    expect(wtCalls).toEqual([["p1-api"], ["p2-ui"]]);
    expect(out.phases).toHaveLength(2);
  });
  it("repoMapFn gets the integration branch for re-plans, falling back to HEAD if it cannot be read", async () => {
    const a = setup(); const refs: (string | undefined)[] = [];
    const f = plans(twoPhases);
    await executeRun({
      goal: "g", repo: a.repo, store: a.store, config: a.config, adapters: { claude: f.adapter, codex: f.adapter }, worktrees: wt, runId: "rid",
      repoMapFn: (_r, _n, ref) => { refs.push(ref); if (ref) throw new Error("bad ref"); return "a.ts"; },
      integrateFn: async (o) => ({ branch: "mar/rid/integration", merged: o.branches }),
    });
    expect(refs).toEqual([undefined, "mar/rid/integration", undefined]);
  });
});
