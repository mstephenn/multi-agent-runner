import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../server/src/store.js";
import { parseDag } from "@mar/core";
import { runDag } from "../src/scheduler.js";
import { createWorkspaceWorktrees } from "../src/wsWorktrees.js";
import { fakeAdapter, ok } from "./fakeAdapter.js";
import { g, tmpWorkspace, useGitEnv } from "./wsHelpers.js";
import type { AdapterInput, AgentEvent } from "../../adapters/src/types.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
useGitEnv();

const T = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `do ${id}`, ...extra });
const REPOS = ["api", "web", "docs"];
const WRITE = ["Read", "Edit", "Write", "Bash"];

function harness(tasks: object[], script: (i: AdapterInput, n: number) => AgentEvent[] | Error, over: Record<string, unknown> = {}, names = REPOS) {
  const root = tmpWorkspace(names);
  const repos = names.map((name) => ({ name, path: join(root, name) }));
  const store = new Store(":memory:"); store.createRun("r", "g", root);
  const f = fakeAdapter(script);
  const worktrees = createWorkspaceWorktrees(root, "r", repos);
  const deps = {
    store, runId: "r", dag: parseDag({ tasks }, { repos: names }), repo: root, workspace: { repos: names },
    adapters: { claude: f.adapter, codex: f.adapter }, worktrees, modelFor: () => null,
    toolsFor: (role: string) => (role === "implementer" || role === "tester" ? WRITE : ["Read"]), concurrency: 3, ...over,
  };
  return { root, repos, store, f, deps, worktrees };
}
const branches = (repo: string) => g(repo, "branch", "--list", "mar/*").split("\n").map((l) => l.replace(/^[* +]+/, "").trim()).filter(Boolean);
const eventsOf = (store: Store, type: string) => store.listEvents("r").filter((e) => e.type === type);

describe("runDag in a workspace", () => {
  it("API writer then client writer: branches only in their repos, deps across repos merge nothing, needs flow via the blackboard", async () => {
    const h = harness(
      [T("api", { repo: "api", paths: ["src/**"] }), T("web", { repo: "web", dependsOn: ["api"], needs: ["api/summary"] })],
      (i) => {
        writeFileSync(join(i.cwd, `${i.taskId}.txt`), i.taskId);
        return ok(i.taskId === "api" ? "CONTRACT: GET /users" : "client done");
      },
    );
    expect(await runDag(h.deps)).toEqual({ api: "done", web: "done" });
    expect(branches(h.repos[0].path)).toEqual(["mar/r/api"]);
    expect(branches(h.repos[1].path)).toEqual(["mar/r/web"]);
    expect(branches(h.repos[2].path)).toEqual([]);
    expect(h.f.calls.find((c) => c.taskId === "web")!.prompt).toContain("CONTRACT: GET /users");
    // cwd is <run dir>/<task>/<repo>
    expect(h.f.calls.find((c) => c.taskId === "api")!.cwd).toBe(join(h.root, ".mar", "worktrees", "r", "api", "api"));
    expect(g(h.repos[1].path, "show", "mar/r/web:web.txt")).toBe("web");
    expect(() => g(h.repos[1].path, "show", "mar/r/web:api.txt")).toThrow(); // no merge across repos
    expect(eventsOf(h.store, "task_started").map((e) => e.payload.repo)).toEqual(["api", "web"]);
    expect(existsSync(join(h.root, ".mar", "worktrees", "r"))).toBe(false); // everything cleaned up
  });
  it("same-repo dependencies are merged in the worktree", async () => {
    const h = harness([T("a", { repo: "api" }), T("b", { repo: "api", dependsOn: ["a"] })], (i) => {
      if (i.taskId === "b") expect(readFileSync(join(i.cwd, "a.txt"), "utf8")).toBe("a");
      else writeFileSync(join(i.cwd, "a.txt"), "a");
      return ok();
    });
    expect(await runDag(h.deps)).toEqual({ a: "done", b: "done" });
  });
  it("runs each repo's own verify commands in that repo's worktree", async () => {
    const calls: { cwd: string; commands: string[] }[] = [];
    const h = harness([T("a", { repo: "api" }), T("b", { repo: "web" })], () => ok(), {
      verifyFor: (repo?: string) => (repo === "api" ? { commands: ["api check"], timeoutMs: 1000 } : repo === "web" ? { commands: ["web check", "web lint"], timeoutMs: 1000 } : undefined),
      runVerify: async (cwd: string, commands: string[]) => { calls.push({ cwd, commands }); return { ok: true, tail: "", ms: 1 }; },
    });
    expect(await runDag(h.deps)).toEqual({ a: "done", b: "done" });
    const byCmd = Object.fromEntries(calls.map((c) => [c.commands[0], c.cwd]));
    expect(byCmd["api check"]).toBe(join(h.root, ".mar", "worktrees", "r", "a", "api"));
    expect(byCmd["web check"]).toBe(join(h.root, ".mar", "worktrees", "r", "b", "web"));
    expect(calls.find((c) => c.commands[0] === "web check")!.commands).toEqual(["web check", "web lint"]);
  });
  it("a failing verify in one repo fails only that task; ownership uses the task repo's mode", async () => {
    const h = harness([T("a", { repo: "api", paths: ["src/**"] }), T("b", { repo: "web", paths: ["src/**"] })], (i) => { writeFileSync(join(i.cwd, "outside.txt"), "x"); return ok(); }, {
      ownershipFor: (repo?: string) => (repo === "api" ? "enforce" : "warn"),
    });
    expect(await runDag(h.deps)).toEqual({ a: "failed", b: "done" });
    expect(eventsOf(h.store, "ownership_violation").map((e) => [e.task_id, e.payload.enforced])).toEqual(expect.arrayContaining([["a", true], ["b", false]]));
  });
  it("read-only tasks share one workspace view with every repo; task_started repo is * and no branches are created", async () => {
    const seen: string[][] = [];
    const h = harness([T("r1", { role: "researcher" }), T("r2", { role: "researcher", repo: "web" })], (i) => {
      seen.push(REPOS.filter((n) => existsSync(join(i.cwd, n, "src/index.ts"))));
      return ok();
    });
    expect(await runDag(h.deps)).toEqual({ r1: "done", r2: "done" });
    expect(seen).toEqual([REPOS, REPOS]);
    expect(h.f.calls[0].cwd).toBe(join(h.root, ".mar", "worktrees", "r", ".shared"));
    expect(Object.fromEntries(eventsOf(h.store, "task_started").map((e) => [e.task_id, e.payload.repo]))).toEqual({ r1: "*", r2: "web" });
    for (const r of h.repos) { expect(branches(r.path)).toEqual([]); expect(g(r.path, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1); }
  });
  it("writers get sibling dirs (extraDirs) and the workspace prompt paragraph; read-only tasks do not", async () => {
    const h = harness([T("a", { repo: "api" }), T("r", { role: "researcher" })], () => ok());
    await runDag(h.deps);
    const a = h.f.calls.find((c) => c.taskId === "a")!;
    expect(a.extraDirs?.map((d) => d.slice(d.lastIndexOf("/") + 1)).sort()).toEqual(["docs", "web"]);
    expect(a.prompt).toContain("Workspace: you are working in repo `api` (your cwd).");
    expect(a.prompt).toContain("READ-ONLY at `../docs`, `../web`");
    expect(h.f.calls.find((c) => c.taskId === "r")!.extraDirs).toBeUndefined();
    expect(h.f.calls.find((c) => c.taskId === "r")!.prompt).not.toContain("you are working in repo");
  });
  it("no sibling links or paragraph for a runtime without verified sibling read", async () => {
    const h = harness([T("a", { repo: "api" })], () => ok());
    (h.deps.adapters.claude as { siblingRead?: boolean }).siblingRead = false;
    await runDag(h.deps);
    const a = h.f.calls[0];
    expect(a.extraDirs).toBeUndefined();
    expect(a.prompt).not.toContain("Workspace:");
  });
  it("a sibling modified by a writer is reported (sibling_modified), reverted, and the task still succeeds in warn mode", async () => {
    const h = harness([T("a", { repo: "api" })], (i) => {
      writeFileSync(join(i.cwd, "..", "web", "README.md"), "tampered");
      return ok();
    });
    expect(await runDag(h.deps)).toEqual({ a: "done" });
    const ev = eventsOf(h.store, "sibling_modified");
    expect(ev).toHaveLength(1);
    expect(ev[0].task_id).toBe("a");
    expect(ev[0].payload).toMatchObject({ repo: "web", files: ["README.md"] });
    expect(g(h.repos[1].path, "status", "--porcelain")).toBe("");
    expect(branches(h.repos[1].path)).toEqual([]);
  });
  it("ownership enforce makes a sibling modification fail the task", async () => {
    const h = harness([T("a", { repo: "api" })], (i) => { writeFileSync(join(i.cwd, "..", "web", "README.md"), "tampered"); return ok(); }, { ownershipFor: () => "enforce" });
    expect(await runDag(h.deps)).toEqual({ a: "failed" });
    expect(h.store.taskStatuses("r")[0].detail).toMatch(/sibling/);
  });
  it("a task that needs a repo but has none fails clearly", async () => {
    const h = harness([T("a", { repo: "api" })], () => ok());
    h.deps.dag = { tasks: [{ ...h.deps.dag.tasks[0], repo: undefined }] };
    expect(await runDag(h.deps)).toEqual({ a: "failed" });
    expect(h.store.taskStatuses("r")[0].detail).toMatch(/repo/);
  });
  it("a single-repo workspace needs no repo on the task (defaulted by parseDag)", async () => {
    const h = harness([T("a")], () => ok(), {}, ["only"]);
    expect(await runDag(h.deps)).toEqual({ a: "done" });
    expect(branches(h.repos[0].path)).toEqual(["mar/r/a"]);
    expect(h.f.calls[0].extraDirs).toBeUndefined(); // nothing to be a sibling
  });
});
