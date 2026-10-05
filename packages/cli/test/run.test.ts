import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../../server/src/store.js";
import { loadConfig } from "../src/config.js";
import { executeRun, makeRepair, parseCli, UsageError } from "../src/main.js";
import { fakeAdapter, ok } from "../../orchestrator/test/fakeAdapter.js";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "mar-r-")); roots.push(d); return d; };

const plan = { tasks: [{ id: "a", role: "implementer", runtime: "claude", tier: "mid", goal: "A" }, { id: "b", role: "reviewer", runtime: "claude", tier: "mid", goal: "B", dependsOn: ["a"], needs: ["a/summary"] }] };
const script = (i: any): any => (i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(plan) }] : ok());
const wt = { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {}, branchFor: (id: string) => `mar/x/${id}` };
const mk = (f: ReturnType<typeof fakeAdapter>, repo: string, store: Store) =>
  ({ goal: "g", repo, store, adapters: { claude: f.adapter, codex: f.adapter }, config: loadConfig(repo), worktrees: wt, repoMapFn: () => "a.ts" });

describe("executeRun", () => {
  it("plans, persists the plan and runs all tasks", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const { runId, results } = await executeRun(mk(f, tmp(), store));
    expect(results).toEqual({ a: "done", b: "done" });
    expect(store.loadPlan(runId)?.tasks).toHaveLength(2);
  });
  it("resume re-runs only non-done tasks", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const base = mk(f, tmp(), store);
    const { runId } = await executeRun(base);
    store.setTaskStatus(runId, "b", "failed");
    f.calls.length = 0;
    await executeRun({ ...base, runId });
    expect(f.calls.map((c) => c.taskId)).toEqual(["b"]);
  });
  it("aborted signal blocks unstarted tasks without throwing", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const ac = new AbortController();
    const p = executeRun({ ...mk(f, tmp(), store), signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toBeTruthy();
  });
  it("abort mid-task: waiting adapter is cancelled, no task left running", async () => {
    const store = new Store(":memory:");
    const adapter = {
      runtime: "claude" as const,
      async *run(i: any) {
        if (i.taskId === "planner") { yield { type: "result", text: JSON.stringify(plan) } as any; return; }
        await new Promise<void>((res) => i.signal.addEventListener("abort", () => res()));
        throw new Error("aborted");
      },
    };
    const ac = new AbortController();
    const p = executeRun({ goal: "g", repo: tmp(), store, adapters: { claude: adapter, codex: adapter }, config: loadConfig(tmp()), worktrees: wt, repoMapFn: () => "a.ts", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const { runId, results } = await p;
    expect(results.a).toBe("failed");
    expect(results.b).toBe("blocked");
    expect(store.taskStatuses(runId).some((s) => s.status === "running")).toBe(false);
  });
  it("passes maxAttempts from config (retries a failing task)", async () => {
    const store = new Store(":memory:");
    const f = fakeAdapter(((i: any, n: number): any => (i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(plan) }] : i.taskId === "a" && n === 1 ? new Error("boom") : ok())));
    const base = mk(f, tmp(), store);
    const { results } = await executeRun({ ...base, config: { ...base.config, maxAttempts: 2 } });
    expect(results).toEqual({ a: "done", b: "done" });
  });
  it("passes unsafe through to adapters", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    await executeRun({ ...mk(f, tmp(), store), unsafe: true });
    expect(f.calls.filter((c) => c.taskId !== "planner").every((c) => c.unsafe === true)).toBe(true);
  });
});

describe("makeRepair", () => {
  it("uses claude low tier, read-only tools, redacts input, returns result text", async () => {
    const f = fakeAdapter(() => [{ type: "result", text: "{\"ok\":1}" }]);
    const cfg = loadConfig(tmp());
    const repair = makeRepair({ claude: f.adapter, codex: f.adapter }, cfg, "/repo");
    expect(await repair("oops password=hunter2xyz")).toBe("{\"ok\":1}");
    const c = f.calls[0];
    expect(c.model).toBe(cfg.tiers.claude.low);
    expect(c.allowedTools).toEqual(["Read"]);
    expect(c.prompt).not.toContain("hunter2xyz");
    expect(c.prompt).toContain("ONLY");
  });
  it("throws when the adapter yields no result", async () => {
    const f = fakeAdapter(() => []);
    const repair = makeRepair({ claude: f.adapter, codex: f.adapter }, loadConfig(tmp()), "/repo");
    await expect(repair("x")).rejects.toThrow();
  });
});

describe("parseCli", () => {
  it("parses run with flags", () => {
    expect(parseCli(["run", "do it", "--port", "5000", "--unsafe", "--budget", "100", "--repo", "x"]))
      .toMatchObject({ cmd: "run", goal: "do it", port: 5000, unsafe: true, budget: 100, repo: "x" });
  });
  it("defaults port 4317 and repo .", () => {
    expect(parseCli(["run", "g"])).toMatchObject({ port: 4317, repo: ".", unsafe: false });
  });
  it("parses resume", () => {
    expect(parseCli(["resume", "r1"])).toMatchObject({ cmd: "resume", runId: "r1" });
  });
  it("help", () => { expect(parseCli(["--help"])).toEqual({ cmd: "help" }); });
  it.each([
    [["run"]], [["run", "  "]], [["run", "x".repeat(20001)]], [["run", "g", "--port", "0"]], [["run", "g", "--port", "abc"]],
    [["run", "g", "--budget", "-5"]], [["run", "g", "--bogus"]], [["nope"]], [[]], [["resume"]], [["run", "a", "b"]],
  ])("rejects %j", (argv) => { expect(() => parseCli(argv as string[])).toThrow(UsageError); });
});
