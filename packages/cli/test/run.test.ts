import { describe, it, expect, afterEach, vi, beforeAll } from "vitest";
import { EventEmitter } from "node:events"; import { createServer } from "node:net"; import { execFileSync } from "node:child_process";
import { Store } from "../../server/src/store.js";
import { loadConfig } from "../src/config.js";
import { executeRun, makeRepair, parseCli, runMain, UsageError, MAX_REPAIR_INPUT, type MainDeps } from "../src/main.js";
import { startServer } from "../../server/src/server.js";
import { fakeAdapter, ok } from "../../orchestrator/test/fakeAdapter.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

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
  it("pre-aborted run with a saved plan: no adapter calls, all tasks blocked", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const base = mk(f, tmp(), store);
    const { runId } = await executeRun(base);
    store.setTaskStatus(runId, "a", "failed"); store.setTaskStatus(runId, "b", "failed");
    f.calls.length = 0;
    const ac = new AbortController(); ac.abort();
    const { results } = await executeRun({ ...base, runId, signal: ac.signal });
    expect(f.calls).toEqual([]);
    expect(results).toEqual({ a: "blocked", b: "blocked" });
  });
  it("pre-aborted run without a plan: planning skipped, durable event, clear error", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const ac = new AbortController(); ac.abort();
    await expect(executeRun({ ...mk(f, tmp(), store), runId: "rx", signal: ac.signal })).rejects.toThrow(/aborted during planning/);
    expect(f.calls).toEqual([]);
    expect(store.loadPlan("rx")).toBeUndefined();
    const ev = store.listEvents("rx");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "task_failed", task_id: null, payload: { reason: "aborted during planning" } });
  });
  it("abort while the planner is running records the event and throws", async () => {
    const store = new Store(":memory:");
    const adapter = { runtime: "claude" as const, async *run(i: any) { await new Promise<void>((r) => i.signal.addEventListener("abort", () => r())); throw new Error("killed"); } };
    const ac = new AbortController();
    const p = executeRun({ ...mk(fakeAdapter(script), tmp(), store), adapters: { claude: adapter, codex: adapter }, runId: "ry", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 30)); ac.abort();
    await expect(p).rejects.toThrow(/aborted during planning/);
    expect(store.listEvents("ry")[0]).toMatchObject({ type: "task_failed", task_id: null });
  });
  it("planner failure is recorded durably with a redacted reason and rethrown", async () => {
    const store = new Store(":memory:");
    const f = fakeAdapter((i: any) => (i.taskId === "planner" ? new Error("bad password=hunter2xyz") : ok()));
    await expect(executeRun({ ...mk(f, tmp(), store), runId: "rz" })).rejects.toThrow(/planning failed/);
    const ev = store.listEvents("rz");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "task_failed", task_id: null });
    expect(JSON.stringify(ev[0].payload)).toMatch(/planning failed/);
    expect(JSON.stringify(ev[0].payload)).not.toContain("hunter2xyz");
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

describe("makeRepair (signal + cap)", () => {
  it("threads the run's signal and caps redacted input", async () => {
    const f = fakeAdapter(() => [{ type: "result", text: "{}" }]);
    const ac = new AbortController();
    const repair = makeRepair({ claude: f.adapter, codex: f.adapter }, loadConfig(tmp()), "/repo", ac.signal);
    await repair("x".repeat(MAX_REPAIR_INPUT * 3));
    expect(f.calls[0].signal).toBe(ac.signal);
    expect(f.calls[0].prompt.length).toBeLessThan(MAX_REPAIR_INPUT + 1000);
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
  it("accepts port 65535", () => { expect(parseCli(["run", "g", "--port", "65535"])).toMatchObject({ port: 65535 }); });
  it("parses resume", () => {
    expect(parseCli(["resume", "r1"])).toMatchObject({ cmd: "resume", runId: "r1" });
  });
  it("help", () => { expect(parseCli(["--help"])).toEqual({ cmd: "help" }); });
  it.each([
    [["run"]], [["run", "  "]], [["run", "x".repeat(20001)]], [["run", "g", "--port", "0"]], [["run", "g", "--port", "65536"]], [["run", "g", "--port", "99999999"]], [["run", "g", "--port", "abc"]],
    [["run", "g", "--budget", "-5"]], [["run", "g", "--bogus"]], [["nope"]], [[]], [["resume"]], [["run", "a", "b"]],
  ])("rejects %j", (argv) => { expect(() => parseCli(argv as string[])).toThrow(UsageError); });
});

describe("runMain", () => {
  beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
  const gitRepo = () => { const d = tmp(); execFileSync("git", ["init", "-q"], { cwd: d }); return d; };
  const free = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
  const harness = (over: Partial<MainDeps> = {}) => {
    const proc = new EventEmitter() as MainDeps["proc"] & EventEmitter;
    const closed = { server: 0, db: 0 }; const exits: number[] = [];
    const f = fakeAdapter(script);
    const deps: MainDeps = {
      adapters: () => ({ claude: f.adapter, codex: f.adapter }), preflight: async () => [], proc, exit: (c) => { exits.push(c); },
      startServer: async (st, o) => { const sv = await startServer(st, o); return { ...sv, close: async () => { closed.server++; await sv.close(); } }; },
      closeStore: (st) => { closed.db++; (st as unknown as { db: { close(): void } }).db.close(); },
      worktrees: wt, repoMapFn: () => "a.ts", ...over,
    };
    return { deps, closed, exits, proc, f };
  };
  const capture = () => {
    const out: string[] = []; const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
    return { out, err };
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it("happy path: exit 0, prints the bound port, closes server and DB", async () => {
    const c = capture(); const h = harness(); const repo = gitRepo();
    const code = await runMain(["run", "do it", "--repo", repo, "--port", String(await free())], h.deps);
    expect(code).toBe(0);
    expect(c.out.join("\n")).toMatch(/UI: http:\/\/127\.0\.0\.1:\d+\/\?run=r/);
    expect(h.closed).toEqual({ server: 1, db: 1 });
  });
  it("prints the real bound port when --port is not the bound one (fake server)", async () => {
    const c = capture();
    const h = harness({ startServer: async () => ({ port: 5555, close: async () => {} } as Awaited<ReturnType<typeof startServer>>) });
    await runMain(["run", "g", "--repo", gitRepo(), "--port", "4317"], h.deps);
    expect(c.out.join("\n")).toContain("http://127.0.0.1:5555/");
  });
  it("--unsafe prints the warning", async () => {
    const c = capture();
    await runMain(["run", "g", "--unsafe", "--repo", gitRepo(), "--port", String(await free())], harness().deps);
    expect(c.out.join("\n")).toMatch(/WARNING: --unsafe/);
  });
  it("EADDRINUSE: clear message, exit 1, DB closed", async () => {
    const c = capture();
    const blocker = createServer(); await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const h = harness();
    try { expect(await runMain(["run", "g", "--repo", gitRepo(), "--port", String(port)], h.deps)).toBe(1); }
    finally { blocker.close(); }
    expect(c.err.join("\n")).toMatch(/already in use/);
    expect(h.closed.db).toBe(1);
  });
  it("resume of a missing run: exit 1 with a clear message", async () => {
    const c = capture(); const h = harness();
    expect(await runMain(["resume", "nope", "--repo", gitRepo(), "--port", String(await free())], h.deps)).toBe(1);
    expect(c.err.join("\n")).toMatch(/no run "nope"/);
    expect(h.closed.db).toBe(1);
  });
  it("resume of a run whose planning failed points at the failure event", async () => {
    const c = capture(); const repo = gitRepo();
    const bad = harness({ adapters: () => { const f = fakeAdapter((i: any) => (i.taskId === "planner" ? new Error("boom") : ok())); return { claude: f.adapter, codex: f.adapter }; } });
    expect(await runMain(["run", "g", "--repo", repo, "--port", String(await free())], bad.deps)).toBe(1);
    expect(c.err.join("\n")).toMatch(/mar: planning failed: .*boom/);
    const runId = new Store(join(repo, ".mar", "mar.db")).listRuns()[0].id;
    c.err.length = 0;
    expect(await runMain(["resume", runId, "--repo", repo, "--port", String(await free())], harness().deps)).toBe(1);
    expect(c.err.join("\n")).toMatch(/has no plan.*planning failed.*boom/s);
  });
  it("usage error exits 2; help exits 0", async () => {
    capture();
    expect(await runMain(["run"], harness().deps)).toBe(2);
    expect(await runMain(["--help"], harness().deps)).toBe(0);
  });
  it("invalid .mar.json and preflight failure: exit 1, no stack, DB not leaked", async () => {
    const c = capture(); const repo = gitRepo();
    writeFileSync(join(repo, ".mar.json"), "{ nope");
    expect(await runMain(["run", "g", "--repo", repo], harness().deps)).toBe(1);
    expect(c.err.join("\n")).toMatch(/mar: .mar.json/);
    rmSync(join(repo, ".mar.json"));
    c.err.length = 0;
    const h = harness({ preflight: async () => ["claude CLI not found or not runnable"] });
    expect(await runMain(["run", "g", "--repo", repo], h.deps)).toBe(1);
    expect(c.err.join("\n")).toMatch(/preflight failed[\s\S]*claude CLI/);
  });
  it("a throwing preflight/ensure step is caught: mar: <msg>, exit 1, no raw stack, capped and redacted", async () => {
    const c = capture();
    const h = harness({ preflight: async () => { throw new Error("kaboom password=hunter2xyz " + "x".repeat(2000)); } });
    expect(await runMain(["run", "g", "--repo", gitRepo()], h.deps)).toBe(1);
    const text = c.err.join("\n");
    expect(text).toMatch(/^mar: kaboom/);
    expect(text).not.toContain("hunter2xyz");
    expect(text).not.toMatch(/\n\s+at /);
    expect(text.length).toBeLessThan(600);
  });
  it("abort during planning exits non-zero with 'aborted during planning'; server and DB closed", async () => {
    const c = capture();
    const adapter = { runtime: "claude" as const, async *run(i: any) { await new Promise<void>((r) => i.signal.addEventListener("abort", () => r())); throw new Error("x"); } };
    const h = harness({ adapters: () => ({ claude: adapter, codex: adapter }) });
    const p = runMain(["run", "g", "--repo", gitRepo(), "--port", String(await free())], h.deps);
    await vi.waitFor(() => expect(h.proc!.listenerCount("SIGINT")).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    h.proc!.emit("SIGINT");
    expect(await p).toBe(1);
    expect(c.err.join("\n")).toMatch(/aborted during planning/);
    expect(h.closed).toEqual({ server: 1, db: 1 });
    expect(h.proc!.listenerCount("SIGINT")).toBe(0);
  });
  it("second signal force-exits 130 after closing server and DB", async () => {
    capture();
    const adapter = { runtime: "claude" as const, async *run() { await new Promise(() => {}); } }; // ignores the abort signal
    const h = harness({ adapters: () => ({ claude: adapter, codex: adapter }) });
    void runMain(["run", "g", "--repo", gitRepo(), "--port", String(await free())], h.deps);
    await vi.waitFor(() => expect(h.proc!.listenerCount("SIGINT")).toBeGreaterThan(0));
    h.proc!.emit("SIGINT");
    expect(h.exits).toEqual([]);
    h.proc!.emit("SIGINT");
    await vi.waitFor(() => expect(h.exits).toEqual([130]));
    expect(h.closed).toEqual({ server: 1, db: 1 });
  });
});
