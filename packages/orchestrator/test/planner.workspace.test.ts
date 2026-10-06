import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { planGoal, PlanError } from "../src/planner.js";
import { repoMap, workspaceRepoMap } from "../src/repomap.js";
import { fakeAdapter } from "./fakeAdapter.js";
import { initRepo, tmp, useGitEnv } from "./wsHelpers.js";

vi.setConfig({ testTimeout: 30000 });
useGitEnv();

const res = (o: unknown) => [{ type: "result", text: JSON.stringify(o) }];
const W = (id: string, repo?: string, extra: object = {}) => ({ id, role: "implementer", runtime: "codex", tier: "mid", goal: "x", ...(repo ? { repo } : {}), ...extra });
const plan = (script: (i: unknown, n: number) => unknown, extra: object = {}) => {
  const f = fakeAdapter(script as never);
  return { f, p: planGoal({ goal: "g", repoMap: "## repo: api\na.ts", adapter: f.adapter, model: null, cwd: "/r", workspace: ["api", "web"], ...extra }) };
};

describe("planGoal in a workspace", () => {
  it("lists the repos and the cross-repo rules in the prompt (phase 1)", async () => {
    const { f, p } = plan(() => res({ tasks: [W("p1-a", "api")] }));
    await p;
    const prompt = f.calls[0].prompt;
    expect(prompt).toContain("Workspace repos: api, web");
    expect(prompt).toContain('"repo":"<repo folder name>"');
    expect(prompt).toMatch(/every implementer\/tester task MUST set `repo`/);
    expect(prompt).toMatch(/ONE writer task PER REPO/);
    expect(prompt).toMatch(/dependsOn/);
    expect(prompt).toMatch(/`paths` are relative to the task's repo/);
    expect(prompt).toMatch(/may omit `repo`/);
    expect(prompt).toContain("state the exact contract (names, parameters, return values) in the dependent task's goal; do not assume the dependent will import it.");
  });
  it("re-plans carry the workspace rules too", async () => {
    const { f, p } = plan(() => res({ tasks: [W("p2-a", "web")], remaining: "" }), { phase: 2, takenIds: new Set(["p1-a"]), externalIds: new Set(["p1-a"]) });
    await p;
    expect(f.calls[0].prompt).toContain("Workspace repos: api, web");
  });
  it("single-repo plans do not mention workspaces", async () => {
    const f = fakeAdapter((() => res({ tasks: [W("p1-a")] })) as never);
    await planGoal({ goal: "g", repoMap: "a.ts", adapter: f.adapter, model: null, cwd: "/r" });
    expect(f.calls[0].prompt).not.toContain("Workspace repos");
    expect(f.calls[0].prompt).not.toContain("exact contract");
  });
  it("accepts per-repo writers (parallel with identical paths) and read-only tasks without repo", async () => {
    const { p } = plan(() => res({ tasks: [W("p1-a", "api", { paths: ["src/**"] }), W("p1-b", "web", { paths: ["src/**"] }), { id: "p1-r", role: "researcher", runtime: "claude", tier: "low", goal: "look" }] }));
    expect((await p).tasks.map((t) => t.repo)).toEqual(["api", "web", undefined]);
  });
  it("rejects a writer without repo / with an unknown repo (retries, then PlanError), naming the task", async () => {
    const { f, p } = plan(() => res({ tasks: [W("p1-a")] }));
    await expect(p).rejects.toBeInstanceOf(PlanError);
    expect(f.calls[1].prompt).toMatch(/p1-a.*repo/);
    const unknown = plan(() => res({ tasks: [W("p1-a", "ghost")] }));
    await expect(unknown.p).rejects.toThrow(/plan/i);
    expect(unknown.f.calls[1].prompt).toContain("ghost");
  });
  it("phase >= 2 task ids still need the p<N>- prefix", async () => {
    const { p } = plan(() => res({ tasks: [W("api-x", "api")], remaining: "" }), { phase: 2 });
    await expect(p).rejects.toThrow(/p2-/);
  });
});

describe("workspaceRepoMap", () => {
  it("one section per repo with the cap split evenly, each with its own structured fallback", () => {
    const root = tmp();
    const names = ["api", "web", "docs"];
    for (const n of names) {
      initRepo(join(root, n), Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`src/dir${i % 10}/file-${n}-${i}.ts`, "x"])));
    }
    const repos = names.map((name) => ({ name, path: join(root, name) }));
    const map = workspaceRepoMap(repos, 3000);
    for (const n of names) expect(map).toContain(`## repo: ${n}\n`);
    const sections = map.split(/^## repo: /m).filter(Boolean);
    expect(sections).toHaveLength(3);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(1000 + 20);
    expect(map).toContain("more files"); // structured fallback kicked in
    // small repos: flat list
    expect(workspaceRepoMap(repos, 200000)).toContain("src/dir3/file-web-3.ts");
  });
  it("uses the ref only in repos that have it", () => {
    const root = tmp();
    initRepo(join(root, "api"), { "a.ts": "1" }); initRepo(join(root, "web"), { "w.ts": "1" });
    const api = join(root, "api");
    const mapFn = (repo: string, max: number, ref?: string) => repoMap(repo, max, ref);
    // create the ref only in api
    writeFileSync(join(api, "new.ts"), "n");
    execFileSync("git", ["checkout", "-qb", "mar/r/integration"], { cwd: api });
    execFileSync("git", ["add", "-A"], { cwd: api });
    execFileSync("git", ["commit", "-qm", "n"], { cwd: api });
    const map = workspaceRepoMap([{ name: "api", path: api }, { name: "web", path: join(root, "web") }], 20000, mapFn, "mar/r/integration");
    expect(map).toContain("new.ts");
    expect(map).toContain("w.ts");
  });
});
