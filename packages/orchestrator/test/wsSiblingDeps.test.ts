import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceWorktrees, type WorkspaceWorktrees } from "../src/wsWorktrees.js";
import { integrate } from "../src/integrate.js";
import { g, tmpWorkspace, useGitEnv } from "./wsHelpers.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
useGitEnv();

const setup = (names = ["api", "web", "docs"]) => {
  const root = tmpWorkspace(names);
  const repos = names.map((name) => ({ name, path: join(root, name) }));
  return { root, repos, api: join(root, "api"), web: join(root, "web"), docs: join(root, "docs") };
};
const branches = (repo: string) => g(repo, "branch", "--list").split("\n").map((l) => l.replace(/^[* +]+/, "").trim()).filter(Boolean);
const worktreeCount = (repo: string) => g(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
const taskDir = (root: string, t: string, run = "r1") => join(root, ".mar", "worktrees", run, t);

/** Creates task `id` in `repo`, writes `file`, commits, removes the worktree (the branch stays). */
async function finish(w: WorkspaceWorktrees, id: string, repo: string, file: string, content = id) {
  const cwd = await w.create(id, [], { repo });
  writeFileSync(join(cwd, file), content);
  await w.commit(id, `mar(${id}): ${file}`);
  await w.remove(id);
}

describe("sibling views with cross-repo dependencies", () => {
  it("the sibling symlink points to a per-task detached checkout that contains the upstream task's work", async () => {
    const { root, repos, api } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w, "p1-api", "api", "users.ts", "export const getUser = 1;\n");
    await w.create("p1-web", [], { repo: "web", siblings: true, siblingDeps: { api: ["p1-api"] } });
    const link = join(taskDir(root, "p1-web"), "api");
    const target = readlinkSync(link);
    expect(target).not.toBe(join(root, ".mar", "worktrees", "r1", ".shared", "api"));
    expect(realpathSync(link)).toBe(realpathSync(target));
    expect(readFileSync(join(link, "users.ts"), "utf8")).toContain("getUser");
    expect(g(link, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD"); // detached
    expect(branches(api)).toEqual(["main", "mar/r1/p1-api"]); // no new branch
    expect(w.siblingDirs("p1-web")).toEqual([link]);
  });
  it("a task without cross-repo deps still uses the shared checkout (same path), which lacks the upstream work", async () => {
    const { root, repos } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w, "p1-api", "api", "users.ts");
    await w.create("other", [], { repo: "web", siblings: true });
    expect(readlinkSync(join(taskDir(root, "other"), "api"))).toBe(join(root, ".mar", "worktrees", "r1", ".shared", "api"));
    expect(existsSync(join(taskDir(root, "other"), "api", "users.ts"))).toBe(false);
  });
  it("only repos with dependencies get a per-task checkout; the others stay shared", async () => {
    const { root, repos } = setup();
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w, "a1", "api", "a1.txt");
    await w.create("t", [], { repo: "web", siblings: true, siblingDeps: { api: ["a1"] } });
    expect(existsSync(join(taskDir(root, "t"), "api", "a1.txt"))).toBe(true);
    expect(readlinkSync(join(taskDir(root, "t"), "docs"))).toBe(join(root, ".mar", "worktrees", "r1", ".shared", "docs"));
  });
  it("two cross-repo deps in the same repo are both merged", async () => {
    const { root, repos } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w, "a1", "api", "a1.txt");
    await finish(w, "a2", "api", "a2.txt");
    await w.create("t", [], { repo: "web", siblings: true, siblingDeps: { api: ["a1", "a2"] } });
    const api = join(taskDir(root, "t"), "api");
    expect(existsSync(join(api, "a1.txt"))).toBe(true);
    expect(existsSync(join(api, "a2.txt"))).toBe(true);
  });
  it("a conflicting dependency merge fails clearly (naming repo and dep) and leaves nothing behind", async () => {
    const { root, repos, api, web } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w, "a1", "api", "same.txt", "one\n");
    await finish(w, "a2", "api", "same.txt", "two\n");
    await expect(w.create("t", [], { repo: "web", siblings: true, siblingDeps: { api: ["a1", "a2"] } })).rejects.toThrow(/repo api.*dependency a2/s);
    expect(worktreeCount(api)).toBe(2); // main + shared view
    await w.shared.release();
    expect(worktreeCount(api)).toBe(1); expect(worktreeCount(web)).toBe(1);
    expect(existsSync(taskDir(root, "t"))).toBe(false);
    expect(branches(api)).toEqual(["main", "mar/r1/a1", "mar/r1/a2"]);
  });
  it("a missing dependency branch fails clearly", async () => {
    const { root, repos, api, web } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await expect(w.create("t", [], { repo: "web", siblings: true, siblingDeps: { api: ["ghost"] } })).rejects.toThrow(/repo api.*dependency ghost.*not found/s);
    await w.shared.release();
    expect(worktreeCount(api)).toBe(1); expect(worktreeCount(web)).toBe(1);
    expect(branches(web)).toEqual(["main"]);
  });
  it("remove cleans the per-task checkout: git worktree list clean in every repo, no new branches", async () => {
    const { root, repos, api, web, docs } = setup();
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w, "a1", "api", "a1.txt");
    await w.create("t", [], { repo: "web", siblings: true, siblingDeps: { api: ["a1"] } });
    expect(worktreeCount(api)).toBe(3); // main + shared + per-task
    await w.remove("t");
    await w.shared.release();
    for (const r of [api, web, docs]) expect(worktreeCount(r)).toBe(1);
    expect(branches(api)).toEqual(["main", "mar/r1/a1"]);
    expect(branches(docs)).toEqual(["main"]);
    expect(existsSync(join(root, ".mar", "worktrees", "r1"))).toBe(false);
  });
  it("detects and reverts a modification of the per-task sibling checkout (not the committed merge)", async () => {
    const { root, repos } = setup(["api", "web"]);
    const w = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w, "a1", "api", "a1.txt", "A");
    await w.create("t", [], { repo: "web", siblings: true, siblingDeps: { api: ["a1"] } });
    const api = join(taskDir(root, "t"), "api");
    writeFileSync(join(api, "a1.txt"), "tampered"); writeFileSync(join(api, "new.txt"), "x");
    expect(await w.checkSiblings("t")).toEqual([{ repo: "api", files: expect.arrayContaining(["a1.txt", "new.txt"]) }]);
    expect(readFileSync(join(api, "a1.txt"), "utf8")).toBe("A");
    expect(existsSync(join(api, "new.txt"))).toBe(false);
    expect(await w.checkSiblings("t")).toEqual([]);
    await w.remove("t"); await w.shared.release();
  });
  it("phase 2: the per-task checkout is cut from the integration tip, plus the dependency", async () => {
    const { root, repos, api } = setup(["api", "web"]);
    const w1 = createWorkspaceWorktrees(root, "r1", repos);
    await finish(w1, "a", "api", "p1.txt", "1");
    await integrate({ repo: api, runId: "r1", branches: ["mar/r1/a"], stateRoot: root, repoName: "api" });
    const w2 = createWorkspaceWorktrees(root, "r1", repos, { baseRef: "mar/r1/integration" });
    await finish(w2, "p2-a", "api", "p2.txt", "2");
    await w2.create("p2-w", [], { repo: "web", siblings: true, siblingDeps: { api: ["p2-a"] } });
    const sib = join(taskDir(root, "p2-w"), "api");
    expect(existsSync(join(sib, "p1.txt"))).toBe(true); // integration tip
    expect(existsSync(join(sib, "p2.txt"))).toBe(true); // dependency
    await w2.remove("p2-w"); await w2.shared.release();
  });
});
