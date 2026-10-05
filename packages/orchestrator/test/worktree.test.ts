import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createWorktrees } from "../src/worktree.js";

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
    await expect(w.create("c", ["a", "b"])).rejects.toThrow(/\bb\b.*failed/);
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
