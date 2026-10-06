import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createWorktrees, linkPathProblem } from "../src/worktree.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
// Tests must not depend on the developer's global/system git config.
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
afterAll(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_NOSYSTEM", savedEnv.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const roots: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function initRepo(dir: string, gitignore: string | null = ".env\n.mar/\n") {
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-q", "-b", "feat/x"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "1");
  const files = ["a.txt"];
  if (gitignore !== null) { writeFileSync(join(dir, ".gitignore"), gitignore); files.push(".gitignore"); }
  writeFileSync(join(dir, ".env"), "SECRET=1");
  g("add", ...files); g("commit", "-qm", "init");
}

let repo: string;
beforeEach(() => { repo = tmp("mar-wt-"); initRepo(repo); });

describe("worktrees", () => {
  it("creates isolated worktrees on per-task branches and never copies .env", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a"), b = await w.create("b");
    expect(a).not.toBe(b);
    expect(existsSync(join(a, "a.txt"))).toBe(true);
    expect(existsSync(join(a, ".env"))).toBe(false);
    writeFileSync(join(a, "only-a.txt"), "x");
    expect(existsSync(join(b, "only-a.txt"))).toBe(false);
  });
  it("remove deletes the dir but keeps the branch", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a");
    await w.remove("a");
    expect(existsSync(a)).toBe(false);
    expect(execFileSync("git", ["branch", "--list", "mar/run1/a"], { cwd: repo }).toString()).toContain("mar/run1/a");
  });
  it("commit saves worktree changes to the task branch so remove does not lose them; clean tree is a no-op", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a");
    await w.commit("a", "noop");
    expect(execFileSync("git", ["rev-list", "--count", "mar/run1/a"], { cwd: repo }).toString().trim()).toBe("1");
    writeFileSync(join(a, "only-a.txt"), "x");
    await w.commit("a", "mar(a): add file");
    await w.remove("a");
    expect(execFileSync("git", ["show", "mar/run1/a:only-a.txt"], { cwd: repo }).toString()).toBe("x");
  });
  it("rejects unsafe ids", async () => {
    const w = createWorktrees(repo, "run1");
    await expect(w.create("../evil")).rejects.toThrow(/invalid/i);
    await expect(w.create("a", ["../evil"])).rejects.toThrow(/invalid/i);
    await expect(w.commit("../evil", "m")).rejects.toThrow(/invalid/i);
    await expect(w.remove("../evil")).rejects.toThrow(/invalid/i);
    expect(() => createWorktrees(repo, "../r")).toThrow(/invalid/i);
  });
  it("handles repo paths with spaces", async () => {
    const spaced = join(tmp("mar sp-"), "my repo");
    mkdirSync(spaced);
    initRepo(spaced, ".mar/\n");
    const dir = await createWorktrees(spaced, "r").create("a");
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
  });

  it("dependent worktree contains the dependency's committed file", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a");
    writeFileSync(join(a, "from-a.txt"), "A");
    await w.commit("a", "mar(a): file");
    await w.remove("a");
    const b = await w.create("b", ["a"]);
    expect(readFileSync(join(b, "from-a.txt"), "utf8")).toBe("A");
  });
  it("merges several dependencies", async () => {
    const w = createWorktrees(repo, "run1");
    for (const t of ["a", "b"]) {
      const d = await w.create(t);
      writeFileSync(join(d, `${t}.new`), t);
      await w.commit(t, "c"); await w.remove(t);
    }
    const c = await w.create("c", ["a", "b"]);
    expect(existsSync(join(c, "a.new"))).toBe(true);
    expect(existsSync(join(c, "b.new"))).toBe(true);
  });
  it("conflicting deps throw naming the dep and leave no worktree dir", async () => {
    const w = createWorktrees(repo, "run1");
    for (const [t, v] of [["a", "AAA"], ["b", "BBB"]]) {
      const d = await w.create(t);
      writeFileSync(join(d, "a.txt"), v);
      await w.commit(t, "c"); await w.remove(t);
    }
    await expect(w.create("c", ["a", "b"])).rejects.toThrow(/\bb\b/);
    expect(existsSync(join(repo, ".mar", "worktrees", "run1", "c"))).toBe(false);
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString()).not.toContain("/c\n");
  });
  it("unknown dependency branch throws and leaves no worktree dir", async () => {
    const w = createWorktrees(repo, "run1");
    await expect(w.create("c", ["ghost"])).rejects.toThrow(/ghost/);
    expect(existsSync(join(repo, ".mar", "worktrees", "run1", "c"))).toBe(false);
  });
  const branches = (r: string) => execFileSync("git", ["branch", "--list", "mar/*"], { cwd: r }).toString();
  const rev = (r: string, ref: string) => execFileSync("git", ["rev-parse", ref], { cwd: r }).toString().trim();
  async function commitFile(w: ReturnType<typeof createWorktrees>, t: string, file: string, body: string) {
    const d = await w.create(t);
    writeFileSync(join(d, file), body);
    await w.commit(t, `mar(${t}): ${file}`); await w.remove(t);
  }

  it("failed create of a NEW branch deletes the branch it made", async () => {
    const w = createWorktrees(repo, "run1");
    await expect(w.create("c", ["ghost"])).rejects.toThrow(/ghost/);
    expect(branches(repo)).not.toContain("mar/run1/c");
  });
  it("failed create on a RESUMED branch keeps the branch and its prior commits", async () => {
    const w = createWorktrees(repo, "run1");
    await commitFile(w, "c", "prior.txt", "P");
    const before = rev(repo, "mar/run1/c");
    await expect(w.create("c", ["ghost"])).rejects.toThrow(/ghost/);
    expect(rev(repo, "mar/run1/c")).toBe(before);
  });
  it("failed dependency merge on a resumed branch resets earlier dep merges", async () => {
    const w = createWorktrees(repo, "run1");
    await commitFile(w, "a", "a.new", "A");
    await commitFile(w, "b", "a.txt", "BBB");          // b edits a.txt
    await commitFile(w, "c", "a.txt", "CCC");          // c (resumed below) also edits a.txt -> conflicts with b
    const before = rev(repo, "mar/run1/c");
    await expect(w.create("c", ["a", "b"])).rejects.toThrow(/dependency b: merge conflict in a\.txt/);
    expect(rev(repo, "mar/run1/c")).toBe(before);       // a's merge was rolled back
    expect(execFileSync("git", ["ls-tree", "-r", "--name-only", "mar/run1/c"], { cwd: repo }).toString()).not.toContain("a.new");
    expect(existsSync(join(repo, ".mar", "worktrees", "run1", "c"))).toBe(false);
  });
  it("queue recovers after a rejected create", async () => {
    const w = createWorktrees(repo, "run1");
    await expect(w.create("x", ["ghost"])).rejects.toThrow(/ghost/);
    const d = await w.create("y");
    expect(existsSync(join(d, "a.txt"))).toBe(true);
  });
  it("concurrent creates all succeed with distinct dirs, even with a failing one in the mix", async () => {
    const w = createWorktrees(repo, "run1");
    const res = await Promise.allSettled([w.create("a"), w.create("b", ["ghost"]), w.create("c"), w.create("d"), w.create("e")]);
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
    const dirs = res.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
    expect(new Set(dirs).size).toBe(4);
    for (const d of dirs) expect(existsSync(join(d, "a.txt"))).toBe(true);
  });
  it("works with a relative repo path (create/commit/remove)", async () => {
    const rel = relative(process.cwd(), repo);
    expect(rel.startsWith("/")).toBe(false);
    const w = createWorktrees(rel, "run1");
    const a = await w.create("a");
    expect(a).toBe(join(repo, ".mar", "worktrees", "run1", "a"));
    writeFileSync(join(a, "n.txt"), "n");
    await w.commit("a", "mar(a): n");
    await w.remove("a");
    expect(existsSync(a)).toBe(false);
    expect(execFileSync("git", ["show", "mar/run1/a:n.txt"], { cwd: repo }).toString()).toBe("n");
  });
  it("works when the repo is itself a linked worktree", async () => {
    const linked = join(tmp("mar-linked-"), "lw");
    execFileSync("git", ["worktree", "add", "-q", "-b", "side", linked], { cwd: repo });
    const w = createWorktrees(linked, "run1");
    const a = await w.create("a");
    expect(existsSync(join(a, "a.txt"))).toBe(true);
    writeFileSync(join(a, "n.txt"), "n");
    await w.commit("a", "mar(a): n");
    await w.remove("a");
    expect(execFileSync("git", ["show", "mar/run1/a:n.txt"], { cwd: linked }).toString()).toBe("n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: linked }).toString()).toBe("");
  });
  it("commit never stages .env* files a worker created", async () => {
    const r = tmp("mar-env-");
    initRepo(r, ".mar/\n"); rmSync(join(r, ".env"));
    const w = createWorktrees(r, "run1");
    const a = await w.create("a");
    mkdirSync(join(a, "sub"));
    for (const f of [".env", ".env.local", "sub/.env.production"]) writeFileSync(join(a, f), "SECRET=1");
    writeFileSync(join(a, "keep.txt"), "k");
    await w.commit("a", "mar(a): files");
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "mar/run1/a"], { cwd: r }).toString();
    expect(files).toContain("keep.txt");
    expect(files).not.toMatch(/\.env/);
    // only env files changed -> nothing to commit, no error
    const b = await w.create("b");
    writeFileSync(join(b, ".env"), "SECRET=2");
    await w.commit("b", "noop");
    expect(execFileSync("git", ["rev-list", "--count", "mar/run1/b"], { cwd: r }).toString().trim()).toBe("1");
  });
  it("create after remove for the same task reuses the branch (resume)", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a");
    writeFileSync(join(a, "keep.txt"), "k");
    await w.commit("a", "c");
    await w.remove("a");
    const again = await w.create("a");
    expect(readFileSync(join(again, "keep.txt"), "utf8")).toBe("k");
  });
  it("create tolerates a stale leftover directory", async () => {
    const w = createWorktrees(repo, "run1");
    const stale = join(repo, ".mar", "worktrees", "run1", "a");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "junk"), "j");
    const a = await w.create("a");
    expect(existsSync(join(a, "a.txt"))).toBe(true);
    expect(existsSync(join(a, "junk"))).toBe(false);
  });
  it("keeps the working tree clean even when .gitignore does not list .mar/", async () => {
    const r = tmp("mar-wt2-");
    initRepo(r, null);
    rmSync(join(r, ".env"));
    await createWorktrees(r, "run1").create("a");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: r }).toString()).toBe("");
    await createWorktrees(r, "run1").create("b");
    const ex = readFileSync(join(r, ".git", "info", "exclude"), "utf8");
    expect(ex.split("\n").filter((l) => l === ".mar/")).toHaveLength(1);
  });

  describe("shared detached worktree", () => {
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd }).toString().trim();
    it("concurrent acquire returns one detached worktree at HEAD with no branch", async () => {
      const w = createWorktrees(repo, "run1");
      const [a, b] = await Promise.all([w.shared.acquire(), w.shared.acquire()]);
      expect(a).toBe(b);
      expect(a).toBe(join(repo, ".mar", "worktrees", "run1", ".shared"));
      expect(existsSync(join(a, "a.txt"))).toBe(true);
      expect(git(a, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(git(repo, "branch", "--list", "mar/*")).toBe("");
      expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(2);
      expect(git(repo, "status", "--porcelain")).toBe("");
    });
    it("release removes the dir, is idempotent, and leaves the main repo clean", async () => {
      const w = createWorktrees(repo, "run1");
      const a = await w.shared.acquire();
      await w.shared.release();
      expect(existsSync(a)).toBe(false);
      await w.shared.release();
      expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
      expect(git(repo, "status", "--porcelain")).toBe("");
    });
    it("recreates over a stale leftover directory", async () => {
      const w1 = createWorktrees(repo, "run1");
      const a = await w1.shared.acquire();
      const w2 = createWorktrees(repo, "run1"); // e.g. resume after a crash: no release happened
      expect(await w2.shared.acquire()).toBe(a);
      expect(existsSync(join(a, "a.txt"))).toBe(true);
      await w2.shared.release();
    });
    it("works with a relative repo path and coexists with task worktrees", async () => {
      const w = createWorktrees(relative(process.cwd(), repo), "run1");
      const s = await w.shared.acquire(), t = await w.create("a");
      expect(s).not.toBe(t);
      expect(git(repo, "branch", "--list", "mar/*")).toContain("mar/run1/a");
      await w.shared.release(); await w.remove("a");
    });
  });
});

describe("run folder tidy-up", () => {
  it("removes the empty per-run folder after the last worktree is gone, but not while another remains", async () => {
    const { existsSync } = await import("node:fs");
    const w = createWorktrees(repo, "tidy"); // `repo` is the initialised temp repo from beforeEach
    const runDir = join(repo, ".mar", "worktrees", "tidy");
    await w.shared.acquire();
    const a = await w.create("a");
    await w.shared.release();
    expect(existsSync(runDir)).toBe(true);   // task "a" still has its worktree
    await w.remove("a");
    expect(existsSync(a)).toBe(false);
    expect(existsSync(runDir)).toBe(false);  // last one gone -> folder tidied
    await w.shared.release();                // idempotent, still fine
  }, 60000);
});

describe("head / changedFiles", () => {
  it("lists files changed on the task branch since the start sha (adds, edits, deletes, renames)", async () => {
    const w = createWorktrees(repo, "cf");
    const a = await w.create("a");
    const start = await w.head("a");
    expect(start).toMatch(/^[0-9a-f]{40}$/);
    expect(await w.changedFiles("a", start)).toEqual([]);
    mkdirSync(join(a, "src"));
    writeFileSync(join(a, "src", "new.ts"), "x");
    writeFileSync(join(a, "a.txt"), "changed");
    await w.commit("a", "mar(a): work");
    expect((await w.changedFiles("a", start)).sort()).toEqual(["a.txt", "src/new.ts"]);
    execFileSync("git", ["mv", "a.txt", "moved.txt"], { cwd: a });
    await w.commit("a", "mar(a): mv");
    expect((await w.changedFiles("a", start)).sort()).toEqual(["a.txt", "moved.txt", "src/new.ts"].sort());
  });
  it("a start sha taken after merging dependencies excludes the dependency's files", async () => {
    const w = createWorktrees(repo, "cf");
    const a = await w.create("a"); writeFileSync(join(a, "from-a.txt"), "A"); await w.commit("a", "c"); await w.remove("a");
    const b = await w.create("b", ["a"]);
    const start = await w.head("b");
    writeFileSync(join(b, "b.txt"), "B"); await w.commit("b", "c");
    expect(await w.changedFiles("b", start)).toEqual(["b.txt"]);
  });
  it("validates ids and shas", async () => {
    const w = createWorktrees(repo, "cf");
    await w.create("a");
    await expect(w.head("../x")).rejects.toThrow(/invalid/i);
    await expect(w.changedFiles("../x", "abc1234")).rejects.toThrow(/invalid/i);
    await expect(w.changedFiles("a", "--output=/tmp/x")).rejects.toThrow(/invalid/i);
  });
});

describe("linked dependency paths", () => {
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd }).toString();
  function depsRepo() {
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports=1");
    for (const p of ["a", "b"]) {
      mkdirSync(join(repo, "packages", p), { recursive: true });
      writeFileSync(join(repo, "packages", p, "package.json"), "{}");
    }
    mkdirSync(join(repo, "packages", "a", "node_modules"));
    writeFileSync(join(repo, "packages", "a", "node_modules", "x.js"), "1");
    sh(repo, "add", "-f", "packages"); sh(repo, "commit", "-qm", "pkgs");
  }
  it("symlinks existing paths (absolute target) into a created worktree and never commits them", async () => {
    depsRepo();
    // trailing-slash rule: does NOT ignore a symlink named node_modules, so only our exclusion keeps it out
    writeFileSync(join(repo, ".gitignore"), ".env\n.mar/\nnode_modules/\n"); sh(repo, "add", ".gitignore"); sh(repo, "commit", "-qm", "ign");
    const w = createWorktrees(repo, "lk", { linkPaths: ["node_modules", "packages/*/node_modules", "missing"] });
    const a = await w.create("a");
    expect(await w.link("a")).toEqual(["node_modules"]); // packages/a/node_modules is tracked: skipped
    expect(lstatSync(join(a, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(a, "node_modules"))).toBe(join(repo, "node_modules"));
    expect(readFileSync(join(a, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports=1");
    writeFileSync(join(a, "real.txt"), "r");
    await w.commit("a", "mar(a): real");
    const tree = sh(repo, "ls-tree", "-r", "--name-only", "mar/lk/a");
    expect(tree).toContain("real.txt");
    expect(tree).not.toMatch(/^node_modules/m);
    await w.remove("a"); // removing the worktree must not delete the main repo's deps
    expect(existsSync(join(repo, "node_modules", "dep", "index.js"))).toBe(true);
  });
  it("expands single-segment globs against the main repo and links only paths that exist there", async () => {
    mkdirSync(join(repo, "pkgs", "a", "node_modules"), { recursive: true });
    mkdirSync(join(repo, "pkgs", "b"), { recursive: true });
    writeFileSync(join(repo, "pkgs", "a", "node_modules", "x"), "1");
    writeFileSync(join(repo, "pkgs", "a", "keep"), "k"); writeFileSync(join(repo, "pkgs", "b", "keep"), "k");
    sh(repo, "add", "pkgs/a/keep", "pkgs/b/keep"); sh(repo, "commit", "-qm", "pk");
    const w = createWorktrees(repo, "lk", { linkPaths: ["pkgs/*/node_modules"] });
    const a = await w.create("a");
    expect(await w.link("a")).toEqual(["pkgs/a/node_modules"]);
    expect(lstatSync(join(a, "pkgs", "a", "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(a, "pkgs", "b", "node_modules"))).toBe(false);
    writeFileSync(join(a, "z.txt"), "z"); await w.commit("a", "c");
    expect(sh(repo, "ls-tree", "-r", "--name-only", "mar/lk/a")).not.toContain("node_modules");
  });
  it("skips a destination that already exists in the worktree (tracked)", async () => {
    depsRepo();
    const w = createWorktrees(repo, "lk", { linkPaths: ["packages/*/node_modules"] });
    const a = await w.create("a");
    expect(await w.link("a")).toEqual([]);
    expect(lstatSync(join(a, "packages", "a", "node_modules")).isSymbolicLink()).toBe(false);
  });
  it("link is a no-op without configured paths, and never touches the shared read-only worktree", async () => {
    depsRepo();
    const none = createWorktrees(repo, "lk");
    await none.create("a");
    expect(await none.link("a")).toEqual([]);
    const w = createWorktrees(repo, "lk2", { linkPaths: ["node_modules"] });
    const s = await w.shared.acquire();
    expect(existsSync(join(s, "node_modules"))).toBe(false);
    await w.shared.release();
  });
  it.each(["/etc", "../x", "a/../b", ".git", "x/.git", ".env", ".env.local", "a/.env", "keys/server.pem", "id_rsa", "id_rsa.pub", "", "**", "a/**/b", "a\\b", ".mar"])(
    "rejects unsafe link path %j", (p) => {
      expect(linkPathProblem(p)).toEqual(expect.any(String));
      expect(() => createWorktrees(repo, "lk", { linkPaths: [p] })).toThrow(/link/i);
    });
  it.each(["node_modules", "packages/*/node_modules", "apps/*/.next"])("accepts %j", (p) => expect(linkPathProblem(p)).toBeNull());
  it("never links secret-ish names that a glob expands to", async () => {
    mkdirSync(join(repo, "cfg"));
    writeFileSync(join(repo, "cfg", "a.pem"), "k"); writeFileSync(join(repo, "cfg", "a.txt"), "t");
    sh(repo, "add", "cfg/a.txt"); sh(repo, "commit", "-qm", "cfg"); // cfg/ exists in the worktree
    const w = createWorktrees(repo, "lk", { linkPaths: ["cfg/*"] });
    await w.create("a");
    expect(await w.link("a")).toEqual([]); // a.txt tracked (skipped), a.pem never linked
  });
  it("link validates the task id", async () => {
    await expect(createWorktrees(repo, "lk").link("../x")).rejects.toThrow(/invalid/i);
  });
});

describe("dependency merge conflicts", () => {
  const g = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir }).toString().trim();
  async function branchWith(w: ReturnType<typeof createWorktrees>, id: string, file: string, body: string) {
    const d = await w.create(id);
    writeFileSync(join(d, file), body);
    await w.commit(id, `work ${id}`);
    await w.remove(id);
  }
  it("throws a typed error listing the conflicted files, leaves nothing half-merged and removes the worktree and new branch", async () => {
    const { DependencyMergeConflict } = await import("../src/worktree.js");
    const w = createWorktrees(repo, "run1");
    await branchWith(w, "a", "shared.txt", "from a\n");
    await branchWith(w, "b", "shared.txt", "from b\n");
    const err = await w.create("c", ["a", "b"]).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyMergeConflict);
    const e = err as InstanceType<typeof DependencyMergeConflict>;
    expect(e.task).toBe("c");
    expect(e.dependency).toBe("b");
    expect(e.files).toEqual(["shared.txt"]);
    expect(e.message).toBe("dependency b: merge conflict in shared.txt");
    expect(existsSync(join(repo, ".mar", "worktrees", "run1", "c"))).toBe(false);
    expect(g(repo, "branch", "--list", "mar/run1/c")).toBe("");
    expect(g(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    expect(g(repo, "status", "--porcelain")).toBe("");
  });
});
