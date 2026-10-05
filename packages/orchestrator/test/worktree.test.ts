import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktrees } from "../src/worktree.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
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
});
