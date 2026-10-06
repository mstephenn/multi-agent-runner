import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../../server/src/store.js";
import { parseCli, runMain, UsageError, type MainDeps } from "../src/main.js";
import { fakeAdapter } from "../../orchestrator/test/fakeAdapter.js";
import type { AdapterInput, AgentEvent } from "../../adapters/src/types.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
afterAll(() => { for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
function workspace(names = ["api", "web", "docs"], cfg: Record<string, unknown> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mar-wsrun-"))); roots.push(root);
  for (const n of names) {
    const d = join(root, n); mkdirSync(join(d, "src"), { recursive: true });
    g(d, "init", "-q", "-b", "main"); g(d, "config", "user.email", "t@t"); g(d, "config", "user.name", "t");
    writeFileSync(join(d, "src/index.ts"), `// ${n}\n`); writeFileSync(join(d, `${n}-marker`), "");
    // each repo's verify command only passes in a checkout of THAT repo
    writeFileSync(join(d, ".mar.json"), JSON.stringify({ verify: [`node -e "process.exit(require('fs').existsSync('${n}-marker')?0:1)"`], ...cfg }));
    g(d, "add", "-A"); g(d, "commit", "-qm", "init");
  }
  return root;
}
const branches = (repo: string) => g(repo, "branch", "--list", "mar/*").split("\n").map((l) => l.replace(/^[* +]+/, "").trim()).filter(Boolean);
const free = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const capture = () => {
  const out: string[] = []; const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  return { out, err, text: () => out.join("\n") };
};
const T = (id: string, repo: string | undefined, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `goal ${id}`, ...(repo ? { repo } : {}), ...extra });
const PLAN = { tasks: [
  T("p1-api", "api", { paths: ["src/**"] }), T("p1-api2", "api", { dependsOn: ["p1-api"] }),
  T("p1-web", "web", { dependsOn: ["p1-api"], needs: ["p1-api/summary"] }),
], remaining: "" };
const done = (summary: string): AgentEvent[] => [{ type: "result", text: JSON.stringify({ summary, filesChanged: [], decisions: [], openQuestions: [] }) }];
const adapter = (plan: unknown, worker?: (i: AdapterInput) => AgentEvent[] | Error) => fakeAdapter((i) => {
  if (i.taskId === "planner") return [{ type: "result", text: JSON.stringify(plan) }];
  if (worker) { const w = worker(i); if (w) return w; }
  writeFileSync(join(i.cwd, `${i.taskId}.txt`), i.taskId);
  return done(i.taskId === "p1-api" ? "CONTRACT GET /users" : `did ${i.taskId}`);
});
const go = async (argv: string[], f: ReturnType<typeof fakeAdapter>, over: Partial<MainDeps> = {}) => {
  const proc = new EventEmitter() as MainDeps["proc"] & EventEmitter;
  return runMain([...argv, "--port", String(await free())], {
    adapters: () => ({ claude: f.adapter, codex: f.adapter }), proc, exit: () => {},
    preflight: async () => [], ...over,
  });
};

describe("parseCli --repos", () => {
  it("parses a comma list on run and resume (deduped)", () => {
    expect(parseCli(["run", "g", "--repos", "a,b,a"])).toMatchObject({ repos: ["a", "b"] });
    expect(parseCli(["resume", "r1", "--repos", "x.y"])).toMatchObject({ repos: ["x.y"] });
    expect(parseCli(["run", "g"])).not.toHaveProperty("repos");
  });
  it.each(["", "a,,b", "a b", "../x", "a,"])("rejects --repos %j", (v) => { expect(() => parseCli(["run", "g", "--repos", v])).toThrow(UsageError); });
  it("does not apply to history", () => { expect(() => parseCli(["history", "--repos", "a"])).toThrow(UsageError); });
});

describe("mar run on a 3-repo workspace (real git, fake adapters)", () => {
  it("API writer then client writer: branches only in touched repos, per-repo verify cwd, output, exit 0", async () => {
    const root = workspace();
    const before = ["api", "web", "docs"].map((n) => g(join(root, n), "rev-parse", "main").trim());
    const f = adapter(PLAN);
    const c = capture();
    expect(await go(["run", "ship it", "--repo", root], f)).toBe(0);
    const out = c.text();
    expect(branches(join(root, "api")).sort()).toEqual(["mar/" + out.match(/Run (r\w+)/)![1] + "/integration", ...["p1-api", "p1-api2"].map((t) => `mar/${out.match(/Run (r\w+)/)![1]}/${t}`)].sort());
    const runId = out.match(/Run (r\w+)/)![1];
    expect(branches(join(root, "web"))).toEqual([`mar/${runId}/p1-web`]);
    expect(branches(join(root, "docs"))).toEqual([]);
    // user branches and working trees untouched
    expect(["api", "web", "docs"].map((n) => g(join(root, n), "rev-parse", "main").trim())).toEqual(before);
    for (const n of ["api", "web", "docs"]) { expect(g(join(root, n), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main"); expect(g(join(root, n), "status", "--porcelain")).toBe(""); }
    // state in the parent, nothing inside the repos' .mar
    expect(existsSync(join(root, ".mar", "mar.db"))).toBe(true);
    expect(existsSync(join(root, "api", ".mar"))).toBe(false);
    expect(existsSync(join(root, ".mar", "worktrees", runId))).toBe(false);
    // output lines
    expect(out).toMatch(/^id +role +repo +runtime\/tier/m);
    expect(out).toContain(`  p1-api  done  api:mar/${runId}/p1-api`);
    expect(out).toContain(`  p1-web  done  web:mar/${runId}/p1-web`);
    expect(out).toContain(`Integration [api]: mar/${runId}/integration (merged p1-api, p1-api2; verify passed)`);
    expect(out).toContain(`git -C ${join(root, "api")} merge mar/${runId}/integration`);
    expect(out).toContain(`git -C ${join(root, "web")} merge mar/${runId}/p1-web`);
    expect(out).not.toContain("No branches were created");
    // needs crossed repos through the blackboard; writer prompts carry the workspace paragraph
    expect(f.calls.find((x) => x.taskId === "p1-web")!.prompt).toContain("CONTRACT GET /users");
    expect(f.calls.find((x) => x.taskId === "p1-web")!.prompt).toContain("Workspace: you are working in repo `web`");
    expect(f.calls.find((x) => x.taskId === "p1-web")!.cwd).toBe(join(root, ".mar", "worktrees", runId, "p1-web", "web"));
    // the planner saw every repo
    expect(f.calls[0].prompt).toContain("## repo: docs");
    // run_started and task_started.repo
    const st = new Store(join(root, ".mar", "mar.db"), { readOnly: true });
    expect(st.listEvents(runId).find((e) => e.type === "run_started")!.payload).toEqual({ root, repos: ["api", "docs", "web"], mode: "workspace" });
    expect(st.listEvents(runId).filter((e) => e.type === "task_started").map((e) => e.payload.repo)).toEqual(["api", "api", "web"]);
    expect(st.listEvents(runId).filter((e) => e.type === "integration").map((e) => e.payload.repo)).toEqual(["api"]);
    st.close();
  });
  it("a failing verify in one repo's own command fails that task and the run exits 1", async () => {
    const root = workspace(["api", "web"], {});
    writeFileSync(join(root, "web", ".mar.json"), JSON.stringify({ verify: ["node -e \"process.exit(3)\""] }));
    g(join(root, "web"), "commit", "-qam", "strict verify");
    const f = adapter({ tasks: [T("p1-api", "api", { paths: ["src/**"] }), T("p1-web", "web", { paths: ["src/**"] })], remaining: "" });
    const c = capture();
    expect(await go(["run", "g", "--repo", root], f)).toBe(1);
    expect(c.text()).toMatch(/p1-api {2}done/);
    expect(c.text()).toMatch(/p1-web {2}failed/);
  });
  it("a dirty child repo blocks the run, naming it; --repos excludes it", async () => {
    const root = workspace();
    writeFileSync(join(root, "web", "dirty.txt"), "x");
    const f = adapter({ tasks: [T("p1-api", "api")], remaining: "" });
    const c = capture();
    const pre = async (r: string) => (execFileSync("git", ["status", "--porcelain"], { cwd: r, encoding: "utf8" }).trim() ? ["working tree has uncommitted changes; commit or stash first"] : []);
    expect(await go(["run", "g", "--repo", root], f, { preflight: pre })).toBe(1);
    expect(c.err.join("\n")).toMatch(/- web: working tree has uncommitted changes/);
    expect(f.calls).toEqual([]);
    expect(await go(["run", "g", "--repo", root, "--repos", "api,docs"], f, { preflight: pre })).toBe(0);
    expect(f.calls[0].prompt).not.toContain("## repo: web");
  });
  it("unknown --repos name exits 1 listing discovered repos", async () => {
    const root = workspace(["api", "web"]);
    const c = capture();
    expect(await go(["run", "g", "--repo", root, "--repos", "api,zzz"], adapter(PLAN))).toBe(1);
    expect(c.err.join("\n")).toMatch(/unknown repo "zzz".*api, web/);
  });
  it("parent .mar.json repos scopes the run; --repos wins", async () => {
    const root = workspace();
    writeFileSync(join(root, ".mar.json"), JSON.stringify({ repos: ["docs"] }));
    const f = adapter({ tasks: [T("p1-d", "docs")], remaining: "" });
    capture();
    expect(await go(["run", "g", "--repo", root], f)).toBe(0);
    expect(f.calls[0].prompt).toContain("## repo: docs");
    expect(f.calls[0].prompt).not.toContain("## repo: api");
    const f2 = adapter({ tasks: [T("p1-a", "api")], remaining: "" });
    expect(await go(["run", "g", "--repo", root, "--repos", "api"], f2)).toBe(0);
    expect(f2.calls[0].prompt).toContain("## repo: api");
  });
  it("read-only run over the workspace creates no branches and prints a note", async () => {
    const root = workspace();
    const f = adapter({ tasks: [{ id: "p1-q", role: "researcher", runtime: "claude", tier: "low", goal: "explain" }], remaining: "" });
    const c = capture();
    expect(await go(["run", "explain", "--repo", root], f)).toBe(0);
    for (const n of ["api", "web", "docs"]) { expect(branches(join(root, n))).toEqual([]); expect(g(join(root, n), "worktree", "list").trim().split("\n")).toHaveLength(1); }
    expect(c.text()).toContain("No branches were created: all tasks were read-only.");
    expect(c.text()).toMatch(/p1-q +researcher +\* /);
  });
  it("child .mar.json run-level keys are noted and ignored", async () => {
    const root = workspace(["api"], { concurrency: 9 });
    const c = capture();
    expect(await go(["run", "g", "--repo", root], adapter({ tasks: [T("p1-a", "api")], remaining: "" }))).toBe(0);
    expect(c.text()).toContain("Note: ignored run-level keys in api/.mar.json: concurrency");
  });
  it("a plain repo behaves as before (single mode, state in the repo)", async () => {
    const root = workspace(["only"]);
    const repo = join(root, "only");
    const f = adapter({ tasks: [T("p1-a", undefined, { paths: ["src/**"] })], remaining: "" });
    const c = capture();
    expect(await go(["run", "g", "--repo", repo], f)).toBe(0);
    expect(existsSync(join(repo, ".mar", "mar.db"))).toBe(true);
    expect(c.text()).not.toMatch(/repo +runtime/);
    expect(f.calls.find((x) => x.taskId === "p1-a")!.prompt).not.toContain("Workspace:");
  });
});

describe("resume of a workspace run", () => {
  it("re-discovers the workspace, reruns only unfinished tasks, and errors when a recorded repo disappeared", async () => {
    const root = workspace(["api", "web"]);
    const plan = { tasks: [T("p1-api", "api", { paths: ["src/**"] }), T("p1-web", "web", { paths: ["src/**"] })], remaining: "" };
    const f1 = adapter(plan, (i) => (i.taskId === "p1-web" ? new Error("boom") : (undefined as never)));
    const c = capture();
    expect(await go(["run", "g", "--repo", root], f1)).toBe(1);
    const runId = c.text().match(/Run (r\w+)/)![1];
    const f2 = adapter(plan);
    expect(await go(["resume", runId, "--repo", root], f2)).toBe(0);
    expect(f2.calls.map((x) => x.taskId)).toEqual(["p1-web"]);
    expect(branches(join(root, "web"))).toContain(`mar/${runId}/p1-web`);
    // a recorded repo vanished
    rmSync(join(root, "web"), { recursive: true, force: true });
    const c2 = capture();
    expect(await go(["resume", runId, "--repo", root], adapter(plan))).toBe(1);
    expect(c2.err.join("\n")).toMatch(new RegExp(`used repo "web", which is missing`));
  });
});

describe("mar history on a workspace run", () => {
  it("detail shows repos, repo per task and per-repo integration; --json has repos", async () => {
    const root = workspace();
    const c = capture();
    expect(await go(["run", "g", "--repo", root], adapter(PLAN))).toBe(0);
    const runId = c.text().match(/Run (r\w+)/)![1];
    const out: string[] = []; const json: string[] = [];
    expect(await runMain(["history", runId, "--repo", root], { history: { out: (l) => out.push(l), columns: 160 } })).toBe(0);
    const d = out.join("\n");
    expect(d).toContain("Repos:     api, docs, web");
    expect(d).toMatch(/^id +role +repo +/m);
    expect(d).toContain(`  p1-web  done  web:mar/${runId}/p1-web`);
    expect(d).toContain(`Integration [api]: mar/${runId}/integration`);
    expect(await runMain(["history", "--json", "--repo", root], { history: { out: (l) => json.push(l) } })).toBe(0);
    expect(JSON.parse(json.join("\n"))[0].repos).toEqual(["api", "docs", "web"]);
  });
});
