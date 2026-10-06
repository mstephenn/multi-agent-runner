import { describe, it, expect, afterEach, vi, beforeAll } from "vitest";
import { EventEmitter } from "node:events"; import { createServer } from "node:net"; import { execFileSync } from "node:child_process";
import { Store } from "../../server/src/store.js";
import { loadConfig } from "../src/config.js";
import { executeRun, makeRepair, parseCli, runMain, UsageError, MAX_REPAIR_INPUT, type MainDeps } from "../src/main.js";
import { startServer } from "../../server/src/server.js";
import { fakeAdapter, ok } from "../../orchestrator/test/fakeAdapter.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

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
    let started = false;
    const adapter = { runtime: "claude" as const, async *run(i: any) { started = true; await new Promise<void>((r) => i.signal.addEventListener("abort", () => r())); throw new Error("killed"); } };
    const ac = new AbortController();
    const p = executeRun({ ...mk(fakeAdapter(script), tmp(), store), adapters: { claude: adapter, codex: adapter }, runId: "ry", signal: ac.signal });
    await vi.waitFor(() => expect(started).toBe(true)); ac.abort();
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
  it("falls back to Codex when Claude planning fails", async () => {
    const store = new Store(":memory:");
    const claude = fakeAdapter((i: any) => i.taskId === "planner" ? new Error("You've hit your session limit") : ok());
    const codex = fakeAdapter((i: any) => i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(plan) }] : ok(), "codex");
    const base = mk(claude, tmp(), store);
    const { results } = await executeRun({ ...base, adapters: { claude: claude.adapter, codex: codex.adapter } });
    expect(results).toEqual({ a: "done", b: "done" });
    expect(codex.calls[0]).toMatchObject({ taskId: "planner", model: null });
  });
  it("retries a Codex model-list timeout before giving up on planning", async () => {
    const store = new Store(":memory:");
    const claude = fakeAdapter(() => new Error("session limit"));
    const codex = fakeAdapter((i, attempt) => i.taskId === "planner" && attempt === 1
      ? new Error("codex exited 1: failed to refresh available models: request timed out")
      : [{ type: "result", text: JSON.stringify(plan) }], "codex");
    const base = mk(claude, tmp(), store);
    const { runId } = await executeRun({ ...base, adapters: { claude: claude.adapter, codex: codex.adapter }, runDagFn: async () => ({}) });
    expect(codex.calls).toHaveLength(2);
    expect(store.loadPlan(runId)).toBeDefined();
  });
  it("reports both CLI failures without retrying a non-transient Codex error", async () => {
    const store = new Store(":memory:");
    const claude = fakeAdapter(() => new Error("session limit"));
    const codex = fakeAdapter(() => new Error("authentication failed"), "codex");
    const base = mk(claude, tmp(), store);
    await expect(executeRun({ ...base, adapters: { claude: claude.adapter, codex: codex.adapter } }))
      .rejects.toThrow(/Claude: session limit; Codex: authentication failed/);
    expect(codex.calls).toHaveLength(1);
  });
  it("abort mid-task: waiting adapter is cancelled, no task left running", async () => {
    const store = new Store(":memory:");
    let taskStarted = false; let res: () => void = () => {};
    const adapter = {
      runtime: "claude" as const,
      async *run(i: any) {
        if (i.taskId === "planner") { yield { type: "result", text: JSON.stringify(plan) } as any; return; }
        i.signal.addEventListener("abort", () => res());
        taskStarted = true;
        await new Promise<void>((r) => { res = r; });
        throw new Error("aborted");
      },
    };
    const ac = new AbortController();
    const p = executeRun({ goal: "g", repo: tmp(), store, adapters: { claude: adapter, codex: adapter }, config: loadConfig(tmp()), worktrees: wt, repoMapFn: () => "a.ts", signal: ac.signal });
    await vi.waitFor(() => expect(taskStarted).toBe(true));
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

describe("executeRun wiring and redaction", () => {
  it("passes taskTimeoutMs and maxBudgetUsdPerTask to runDag", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script); const repo = tmp();
    writeFileSync(join(repo, ".mar.json"), JSON.stringify({ taskTimeoutMinutes: 7, maxBudgetUsdPerTask: 1.5 }));
    let seen: any;
    await executeRun({ ...mk(f, repo, store), runDagFn: async (d) => { seen = d; return {}; } });
    expect(seen.taskTimeoutMs).toBe(7 * 60_000);
    expect(seen.maxBudgetUsdPerTask).toBe(1.5);
  });
  it("defaults to a 20 minute timeout and no USD cap", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    let seen: any;
    await executeRun({ ...mk(f, tmp(), store), runDagFn: async (d) => { seen = d; return {}; } });
    expect(seen.taskTimeoutMs).toBe(20 * 60_000);
    expect(seen.maxBudgetUsdPerTask).toBeUndefined();
  });
  it("redacts secrets in the goal before storing and before the planner prompt", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const { runId } = await executeRun({ ...mk(f, tmp(), store), goal: "deploy with API_KEY=abc123xyz now" });
    expect(JSON.stringify(store.listRuns())).not.toContain("abc123xyz");
    expect(store.listRuns().find((r) => r.id === runId)?.goal).toContain("deploy");
    expect(f.calls.find((c) => c.taskId === "planner")?.prompt).not.toContain("abc123xyz");
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
  it("falls back to Codex when Claude repair fails", async () => {
    const claude = fakeAdapter(() => new Error("session limit"));
    const codex = fakeAdapter(() => [{ type: "result", text: "{\"ok\":1}" }], "codex");
    const repair = makeRepair({ claude: claude.adapter, codex: codex.adapter }, loadConfig(tmp()), "/repo");
    expect(await repair("x")).toBe("{\"ok\":1}");
    expect(codex.calls[0].model).toBeNull();
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
  it("read-only run prints no branches and no git merge hints", async () => {
    const c = capture();
    const roPlan = { tasks: [{ id: "q", role: "researcher", runtime: "claude", tier: "low", goal: "Q" }] };
    const f = fakeAdapter((i: any) => (i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(roPlan) }] : ok()));
    const h = harness({ adapters: () => ({ claude: f.adapter, codex: f.adapter }), worktrees: { ...wt, shared: { acquire: async () => "/wt/.shared", release: async () => {} } } });
    const code = await runMain(["run", "explain", "--repo", gitRepo(), "--port", String(await free())], h.deps);
    const out = c.out.join("\n");
    expect(code).toBe(0);
    expect(out).toContain("No branches were created: all tasks were read-only.");
    expect(out).not.toContain("git merge");
    expect(out).not.toMatch(/mar\/r[a-z0-9]+\/q/);
  });
  it("prints the final task's full report before the status table and saves it under .mar/reports", async () => {
    const c = capture();
    const report = "# Findings\n" + "detail line\n".repeat(500);
    const plan = { tasks: [{ id: "q", role: "researcher", runtime: "claude", tier: "low", goal: "Q" }] };
    const f = fakeAdapter((i: any) => (i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(plan) }]
      : [{ type: "result", text: JSON.stringify({ summary: "abstract", report, filesChanged: [], decisions: [], openQuestions: [] }) }]));
    const h = harness({ adapters: () => ({ claude: f.adapter, codex: f.adapter }), worktrees: { ...wt, shared: { acquire: async () => "/wt/.shared", release: async () => {} } } });
    const repo = gitRepo();
    expect(await runMain(["run", "explain", "--repo", repo, "--port", String(await free())], h.deps)).toBe(0);
    const out = c.out.join("\n");
    expect(out).toContain("== Answer: q ==\n" + report);
    expect(out).not.toContain("(summary only)");
    expect(out.indexOf("== Answer: q ==")).toBeLessThan(out.indexOf("Run r"));
    const m = out.match(/Saved: (.+\.mar\/reports\/(r[a-z0-9]+)\/q\.md)/);
    expect(m).not.toBeNull();
    expect(out.indexOf("Saved:")).toBeGreaterThan(out.indexOf("No branches were created"));
    expect(readFileSync(m![1]!, "utf8")).toBe(report);
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
    let started = false;
    const adapter = { runtime: "claude" as const, async *run(i: any) { started = true; await new Promise<void>((r) => i.signal.addEventListener("abort", () => r())); throw new Error("x"); } };
    const h = harness({ adapters: () => ({ claude: adapter, codex: adapter }) });
    const p = runMain(["run", "g", "--repo", gitRepo(), "--port", String(await free())], h.deps);
    await vi.waitFor(() => expect(h.proc!.listenerCount("SIGINT")).toBeGreaterThan(0), { timeout: 10000 });
    await vi.waitFor(() => expect(started).toBe(true));
    h.proc!.emit("SIGINT");
    expect(await p).toBe(1);
    expect(c.err.join("\n")).toMatch(/aborted during planning/);
    expect(h.closed).toEqual({ server: 1, db: 1 });
    expect(h.proc!.listenerCount("SIGINT")).toBe(0);
  });
  it("second signal force-exits 130 after closing server and DB", async () => {
    capture();
    const adapter = { runtime: "claude" as const, async *run() { await new Promise(() => {}); } }; // ignores the abort signal
    let t = 1000;
    const h = harness({ adapters: () => ({ claude: adapter, codex: adapter }), now: () => t });
    void runMain(["run", "g", "--repo", gitRepo(), "--port", String(await free())], h.deps);
    await vi.waitFor(() => expect(h.proc!.listenerCount("SIGINT")).toBeGreaterThan(0), { timeout: 10000 });
    h.proc!.emit("SIGINT");
    expect(h.exits).toEqual([]);
    t += 1500; // a distinct second Ctrl-C, well after the debounce window
    h.proc!.emit("SIGINT");
    await vi.waitFor(() => expect(h.exits).toEqual([130]));
    expect(h.closed).toEqual({ server: 1, db: 1 });
  });
  it("a duplicate signal within the debounce window does not force-exit", async () => {
    capture();
    const adapter = { runtime: "claude" as const, async *run() { await new Promise(() => {}); } };
    let t = 1000;
    const h = harness({ adapters: () => ({ claude: adapter, codex: adapter }), now: () => t, forceExitTimeoutMs: 10 });
    void runMain(["run", "g", "--repo", gitRepo(), "--port", String(await free())], h.deps);
    await vi.waitFor(() => expect(h.proc!.listenerCount("SIGINT")).toBeGreaterThan(0), { timeout: 10000 });
    h.proc!.emit("SIGINT");
    t += 200; h.proc!.emit("SIGINT"); h.proc!.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    expect(h.exits).toEqual([]);
    t += 5000; h.proc!.emit("SIGINT");
    await vi.waitFor(() => expect(h.exits).toEqual([130]));
  });
});


describe("executeRun: verify, ownership and integration wiring", () => {
  const twoWriters = { tasks: [
    { id: "a", role: "implementer", runtime: "claude", tier: "mid", goal: "A", paths: ["a/**"] },
    { id: "b", role: "tester", runtime: "claude", tier: "mid", goal: "B", paths: ["b/**"] },
    { id: "c", role: "reviewer", runtime: "claude", tier: "mid", goal: "C", dependsOn: ["a", "b"] },
  ] };
  const planScript = (p: unknown) => (i: any): any => (i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(p) }] : ok());
  const setup = (cfg: object = {}, p: unknown = twoWriters) => {
    const repo = tmp(); writeFileSync(join(repo, ".mar.json"), JSON.stringify(cfg));
    const store = new Store(":memory:"); const f = fakeAdapter(planScript(p));
    return { repo, store, base: mk(f, repo, store) };
  };

  it("passes verify and ownership to runDag, omitting verify when empty", async () => {
    let seen: any;
    const a = setup({ verify: ["pnpm test"], verifyTimeoutMinutes: 2, ownership: "enforce" });
    await executeRun({ ...a.base, runDagFn: async (d) => { seen = d; return {}; } });
    expect(seen.verify).toEqual({ commands: ["pnpm test"], timeoutMs: 120_000 });
    expect(seen.ownership).toBe("enforce");
    const b = setup();
    await executeRun({ ...b.base, runDagFn: async (d) => { seen = d; return {}; } });
    expect(seen.verify).toBeUndefined();
    expect(seen.ownership).toBe("warn");
  });
  it("creates real worktrees with the configured linkPaths when none are injected", async () => {
    const a = setup({ linkPaths: ["node_modules"] });
    const { worktrees: _omit, ...noWt } = a.base;
    let seen: any;
    await executeRun({ ...noWt, runDagFn: async (d) => { seen = d; return {}; } });
    expect(typeof seen.worktrees.link).toBe("function");
    expect(typeof seen.worktrees.head).toBe("function");
  });
  it("integrates when two or more writers are done: topological order, verify wired, one event, result returned", async () => {
    const a = setup({ verify: ["pnpm test"], linkPaths: ["node_modules"] });
    const calls: any[] = [];
    const out = await executeRun({
      ...a.base, runDagFn: async () => ({ a: "done", b: "done", c: "done" }), // (the real gate would run in fake /wt dirs)
      integrateFn: async (o) => { calls.push(o); return { branch: "mar/rid/integration", merged: o.branches, verify: { ok: true, tail: "" } }; }, runId: "rid",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: "rid", branches: ["mar/rid/a", "mar/rid/b"], verify: { commands: ["pnpm test"], timeoutMs: 600_000 }, linkPaths: ["node_modules"] });
    expect(out.integration).toEqual({ result: { branch: "mar/rid/integration", merged: ["mar/rid/a", "mar/rid/b"], verify: { ok: true, tail: "" } } });
    const evs = a.store.listEvents("rid").filter((e) => e.type === "integration");
    expect(evs).toHaveLength(1);
    expect(evs[0].task_id).toBeNull();
    expect(evs[0].payload).toMatchObject({ branch: "mar/rid/integration", merged: ["mar/rid/a", "mar/rid/b"], verify: { ok: true } });
  });
  it("orders branches topologically even when the plan lists dependents first", async () => {
    const p = { tasks: [
      { id: "z", role: "implementer", runtime: "claude", tier: "mid", goal: "Z", dependsOn: ["y"] },
      { id: "y", role: "implementer", runtime: "claude", tier: "mid", goal: "Y" },
    ] };
    const a = setup({}, p);
    let branches: string[] = [];
    await executeRun({ ...a.base, integrateFn: async (o) => { branches = o.branches; return { branch: "i", merged: o.branches }; } });
    expect(branches.map((b) => b.split("/").pop())).toEqual(["y", "z"]);
  });
  it("does not integrate with one done writer, when disabled, or when a signal already aborted", async () => {
    const fn = vi.fn(async () => ({ branch: "i", merged: [] as string[] }));
    const one = setup({}, { tasks: [twoWriters.tasks[0]] });
    expect((await executeRun({ ...one.base, integrateFn: fn })).integration).toBeUndefined();
    const off = setup({ integrate: false });
    expect((await executeRun({ ...off.base, integrateFn: fn })).integration).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
  it("only merges DONE writers (failed ones are left out)", async () => {
    const a = setup();
    let branches: string[] = [];
    await executeRun({
      ...a.base, runDagFn: async () => ({ a: "done", b: "failed", c: "blocked" }),
      integrateFn: async (o) => { branches = o.branches; return { branch: "i", merged: o.branches }; },
    });
    expect(branches).toEqual([]); // one done writer: no integration at all
    const fn = vi.fn(async (o: any) => ({ branch: "i", merged: o.branches as string[] }));
    await executeRun({ ...a.base, runId: "r2", runDagFn: async () => ({ a: "done", b: "done", c: "blocked" }), integrateFn: fn });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("catches integration errors: result carries a redacted, capped message and an integration event", async () => {
    const a = setup();
    const out = await executeRun({ ...a.base, runId: "rerr", integrateFn: async () => { throw new Error("boom API_KEY=hunter2 " + "x".repeat(600)); } });
    expect(out.results).toEqual({ a: "done", b: "done", c: "done" });
    expect(out.integration?.result).toBeUndefined();
    expect(out.integration?.error).not.toContain("hunter2");
    expect(out.integration!.error!.length).toBeLessThanOrEqual(300);
    expect(a.store.listEvents("rerr").some((e) => e.type === "integration" && String(e.payload.error).includes("boom"))).toBe(true);
  });
  it("skips real integration when worktrees were injected (fakes have no branches)", async () => {
    const a = setup();
    const out = await executeRun(a.base);
    expect(out.integration).toBeUndefined();
  });
});

describe("runMain: integration printout and exit code", () => {
  beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
  const gitRepo = () => { const d = tmp(); execFileSync("git", ["init", "-q"], { cwd: d }); return d; };
  const free = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
  const twoWriters = { tasks: [
    { id: "a", role: "implementer", runtime: "claude", tier: "mid", goal: "A", paths: ["a/**"] },
    { id: "b", role: "implementer", runtime: "claude", tier: "mid", goal: "B", paths: ["b/**"] },
  ] };
  const f = fakeAdapter((i: any) => (i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(twoWriters) }] : ok()));
  const go = async (integrateFn: NonNullable<MainDeps["integrateFn"]>) => {
    const out: string[] = []; const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
    const proc = new EventEmitter() as MainDeps["proc"] & EventEmitter;
    const code = await runMain(["run", "g", "--repo", gitRepo(), "--port", String(await free())], {
      adapters: () => ({ claude: f.adapter, codex: f.adapter }), preflight: async () => [], proc, exit: () => {},
      worktrees: wt, repoMapFn: () => "a.ts", integrateFn,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it("success: prints the integration branch, merged tasks, verify result and the merge hint; exit 0", async () => {
    const r = await go(async (o) => ({ branch: `mar/${o.runId}/integration`, merged: o.branches, verify: { ok: true, tail: "" } }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Integration: mar\/r[a-z0-9]+\/integration \(merged a, b; verify passed\)/);
    expect(r.out).toMatch(/To take it: git merge mar\/r[a-z0-9]+\/integration \(on a feature branch, never main\)/);
    expect(r.out).not.toContain("Nothing was merged");
  });
  it("no verify configured: no verify text", async () => {
    const r = await go(async (o) => ({ branch: `mar/${o.runId}/integration`, merged: o.branches }));
    expect(r.out).toMatch(/Integration: mar\/r[a-z0-9]+\/integration \(merged a, b\)/);
    expect(r.out).not.toMatch(/verify (passed|failed)/);
  });
  it("conflict: names the branch and files, exit 1, no take-it hint", async () => {
    const r = await go(async (o) => ({ branch: `mar/${o.runId}/integration`, merged: [o.branches[0]!], conflict: { branch: o.branches[1]!, files: ["x.ts", "y.ts"] } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Integration stopped at mar\/r[a-z0-9]+\/b: conflict in x\.ts, y\.ts/);
    expect(r.out).not.toContain("To take it");
  });
  it("verify failure: prints the command and the redacted tail, exit 1", async () => {
    const r = await go(async (o) => ({ branch: `mar/${o.runId}/integration`, merged: o.branches,
      verify: { ok: false, failed: { command: "pnpm test", code: 1, timedOut: false }, tail: "1 failed API_KEY=hunter2" } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/verify failed \(pnpm test\)/);
    expect(r.out).toContain("1 failed API_KEY=[REDACTED]");
    expect(r.out).not.toContain("hunter2");
    expect(r.out).not.toContain("To take it");
  });
  it("integration error: printed, redacted and capped, never crashes reporting; exit 1", async () => {
    const r = await go(async () => { throw new Error("git exploded API_KEY=hunter2 " + "y".repeat(500)); });
    expect(r.code).toBe(1);
    const line = r.out.split("\n").find((l) => l.startsWith("Integration failed:"))!;
    expect(line).toBeDefined();
    expect(line).not.toContain("hunter2");
    expect(line.length).toBeLessThanOrEqual("Integration failed: ".length + 300);
    expect(r.out).toMatch(/a {2}done/); // the normal task table is still printed
  });
});
