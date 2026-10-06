import { describe, it, expect, vi } from "vitest";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceWorktrees } from "../src/wsWorktrees.js";
import { integrate } from "../src/integrate.js";
import { g, tmpWorkspace, useGitEnv } from "./wsHelpers.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
useGitEnv();

const setup = (names = ["api", "web", "docs"]) => {
  const root = tmpWorkspace(names);
  const repos = names.map((name) => ({ name, path: join(root, name) }));
  return { root, repos, api: join(root, "api"), web: join(root, "web"), docs: join(root, "docs") };
};
const branches = (repo: string) => g(repo, "branch", "--list", "mar/*").split("\n").map((l) => l.replace(/^[* +]+/, "").trim()).filter(Boolean);
const worktreeCount = (repo: string) => g(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

describe("workspace worktrees", () => {
  it("a writer gets <run>/<task>/<repo> on a branch that exists only in its repo", async () => {
    const { root, repos, api, web, docs } = setup();
    const w = createWorkspaceWorktrees(root, "r1", repos);
    const cwd = await w.create("t1", [], { repo: "api" });
    expect(cwd).toBe(join(root, ".mar", "worktrees", "r1", "t1", "api"));
    expect(existsSync(join(cwd, "src/index.ts"))).toBe(true);
    expect(g(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("mar/r1/t1");
    expect(branches(api)).toEqual(["mar/r1/t1"]);
    expect(branches(web)).toEqual([]); expect(branches(docs)).toEqual([]);
    expect(w.branchFor("t1")).toBe("mar/r1/t1");
  });
  it("does not edit .git/info/exclude of any repo and creates nothing inside a repo folder", async () => {
    const { root, repos, api } = setup(["api", "web"]);
    const before = readFileSync(join(api, ".git/info/exclude"), "utf8");
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await w.create("t1", [], { repo: "api", siblings: true });
    expect(readFileSync(join(api, ".git/info/exclude"), "utf8")).toBe(before);
    expect(readdirSync(api).sort()).toEqual([".git", "README.md", "src"]);
    expect(g(api, "status", "--porcelain")).toBe("");
  });
  it("symlinks the other repos next to the task repo (read-only sibling view) and lists them", async () => {
    const { root, repos } = setup();
    const w = createWorkspaceWorktrees(root, "r1", repos);
    const cwd = await w.create("t1", [], { repo: "api", siblings: true });
    const dir = join(root, ".mar", "worktrees", "r1", "t1");
    for (const o of ["web", "docs"]) {
      expect(lstatSync(join(dir, o)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, o))).toBe(join(root, ".mar", "worktrees", "r1", ".shared", o));
      expect(existsSync(join(cwd, "..", o, "src/index.ts"))).toBe(true); // ../web works from the cwd
    }
    expect(existsSync(join(dir, "api"))).toBe(true);
    expect(lstatSync(join(dir, "api")).isSymbolicLink()).toBe(false);
    expect(w.siblingDirs("t1").sort()).toEqual([join(dir, "docs"), join(dir, "web")]);
  });
  it("no sibling links without ctx.siblings", async () => {
    const { root, repos } = setup();
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await w.create("t1", [], { repo: "api" });
    expect(readdirSync(join(root, ".mar", "worktrees", "r1", "t1"))).toEqual(["api"]);
    expect(w.siblingDirs("t1")).toEqual([]);
  });
  it("rejects a missing or unknown repo", async () => {
    const { root, repos } = setup();
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await expect(w.create("t1", [], {})).rejects.toThrow(/task t1.*no repo/);
    await expect(w.create("t1", [], { repo: "zzz" })).rejects.toThrow(/unknown repo "zzz"/);
  });
  it("the shared view holds every repo side by side; release leaves git worktree list clean in EVERY repo and no branches", async () => {
    const { root, repos, api, web, docs } = setup();
    const w = createWorkspaceWorktrees(root, "r1", repos);
    const cwd = await w.shared.acquire();
    expect(cwd).toBe(join(root, ".mar", "worktrees", "r1", ".shared"));
    for (const n of ["api", "web", "docs"]) expect(existsSync(join(cwd, n, "src/index.ts"))).toBe(true);
    expect(await w.shared.acquire()).toBe(cwd); // idempotent
    expect(worktreeCount(api)).toBe(2);
    await w.shared.release();
    for (const r of [api, web, docs]) { expect(worktreeCount(r)).toBe(1); expect(branches(r)).toEqual([]); }
    expect(existsSync(join(root, ".mar", "worktrees", "r1"))).toBe(false);
  });
  it("remove deletes the task dir (and its symlinks) but keeps the branch and the shared checkouts", async () => {
    const { root, repos, api, web } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await w.create("t1", [], { repo: "api", siblings: true });
    await w.remove("t1");
    expect(existsSync(join(root, ".mar", "worktrees", "r1", "t1"))).toBe(false);
    expect(existsSync(join(root, ".mar", "worktrees", "r1", ".shared", "web", "src/index.ts"))).toBe(true);
    expect(branches(api)).toEqual(["mar/r1/t1"]);
    await w.shared.release();
    expect(worktreeCount(api)).toBe(1); expect(worktreeCount(web)).toBe(1);
  });
  it("commit/head/changedFiles/link work per task repo", async () => {
    const { root, repos, api } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos, { linkPaths: { api: ["node_modules"] } });
    const cwd = await w.create("t1", [], { repo: "api" });
    const start = await w.head("t1");
    writeFileSync(join(cwd, "new.ts"), "x");
    await w.commit("t1", "mar(t1): add");
    expect(await w.changedFiles("t1", start)).toEqual(["new.ts"]);
    expect(g(api, "log", "--format=%s", "-1", "mar/r1/t1").trim()).toBe("mar(t1): add");
    expect(await w.link("t1")).toEqual([]); // no node_modules in api
  });
  it("same-repo dependencies are merged into the worktree", async () => {
    const { root, repos } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    const a = await w.create("a", [], { repo: "api" });
    writeFileSync(join(a, "from-a.txt"), "A"); await w.commit("a", "mar(a): x"); await w.remove("a");
    const b = await w.create("b", ["a"], { repo: "api" });
    expect(readFileSync(join(b, "from-a.txt"), "utf8")).toBe("A");
  });
  it("a dependency whose branch is in another repo is not found (callers pass same-repo deps only)", async () => {
    const { root, repos, web } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    const a = await w.create("a", [], { repo: "api" });
    writeFileSync(join(a, "from-a.txt"), "A"); await w.commit("a", "mar(a): x"); await w.remove("a");
    await expect(w.create("b", ["a"], { repo: "web" })).rejects.toThrow(/dependency a/);
    expect(branches(web)).toEqual([]);
    const c = await w.create("c", [], { repo: "web" }); // cross-repo ordering merges nothing
    expect(existsSync(join(c, "from-a.txt"))).toBe(false);
  });
  it("phase 2: new worktrees are cut from the integration tip in the repos that have it, HEAD elsewhere", async () => {
    const { root, repos, api, web } = setup(["api", "web"]);
    const w1 = createWorkspaceWorktrees(root, "r1", repos);
    const a = await w1.create("a", [], { repo: "api" });
    writeFileSync(join(a, "p1.txt"), "1"); await w1.commit("a", "mar(a): p1"); await w1.remove("a");
    await integrate({ repo: api, runId: "r1", branches: ["mar/r1/a"], stateRoot: root, repoName: "api" });
    expect(branches(api)).toContain("mar/r1/integration");
    const w2 = createWorkspaceWorktrees(root, "r1", repos, { baseRef: "mar/r1/integration" });
    const a2 = await w2.create("p2-a", [], { repo: "api" });
    const w2b = await w2.create("p2-w", [], { repo: "web" });
    expect(existsSync(join(a2, "p1.txt"))).toBe(true);
    expect(existsSync(join(w2b, "README.md"))).toBe(true);
    expect(branches(web)).toEqual(["mar/r1/p2-w"]);
    // shared view of api also follows the integration tip
    const shared = await w2.shared.acquire();
    expect(existsSync(join(shared, "api", "p1.txt"))).toBe(true);
    await w2.shared.release();
  });
  it("detects a modified sibling, reports it, and reverts the shared checkout", async () => {
    const { root, repos } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await w.create("t1", [], { repo: "api", siblings: true });
    expect(await w.checkSiblings("t1")).toEqual([]);
    const shared = join(root, ".mar", "worktrees", "r1", ".shared", "web");
    writeFileSync(join(shared, "README.md"), "hacked"); writeFileSync(join(shared, "new.txt"), "n");
    const found = await w.checkSiblings("t1");
    expect(found).toHaveLength(1);
    expect(found[0].repo).toBe("web");
    expect(found[0].files.sort()).toEqual(["README.md", "new.txt"]);
    expect(readFileSync(join(shared, "README.md"), "utf8")).toBe("web\n");
    expect(existsSync(join(shared, "new.txt"))).toBe(false);
    expect(await w.checkSiblings("t1")).toEqual([]);
  });
});

describe("integrate in workspace mode", () => {
  it("writes its temp worktree under the parent .mar, never edits the repo's exclude file, keeps the user's branch", async () => {
    const { root, api } = setup(["api", "web"]);
    const before = readFileSync(join(api, ".git/info/exclude"), "utf8");
    const repos = [{ name: "api", path: api }, { name: "web", path: join(root, "web") }];
    const w = createWorkspaceWorktrees(root, "r1", repos);
    for (const t of ["a", "b"]) { const d = await w.create(t, [], { repo: "api" }); writeFileSync(join(d, `${t}.txt`), t); await w.commit(t, `mar(${t}): x`); await w.remove(t); }
    const r = await integrate({ repo: api, runId: "r1", branches: ["mar/r1/a", "mar/r1/b"], stateRoot: root, repoName: "api" });
    expect(r.merged).toEqual(["mar/r1/a", "mar/r1/b"]);
    expect(g(api, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(g(api, "ls-tree", "--name-only", "mar/r1/integration").split("\n")).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
    expect(readFileSync(join(api, ".git/info/exclude"), "utf8")).toBe(before);
    expect(worktreeCount(api)).toBe(1);
    expect(branches(join(root, "web"))).toEqual([]);
  });
});
