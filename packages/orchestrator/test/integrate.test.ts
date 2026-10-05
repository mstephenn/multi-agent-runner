import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { integrate } from "../src/integrate.js";
import type { VerifyResult } from "../src/verify.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
afterAll(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

let repo: string;
const g = (...a: string[]) => execFileSync("git", a, { cwd: repo }).toString().trim();
// Commits `files` on a new branch `name` forked from `from` (default: the main branch), then returns to the feature branch.
function branch(name: string, files: Record<string, string>, from = "feat/base") {
  g("checkout", "-q", "-b", name, from);
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), body); g("add", f); }
  g("commit", "-qm", `work on ${name}`);
  g("checkout", "-q", "feat/base");
}
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mar-int-")); roots.push(repo);
  g("init", "-q", "-b", "feat/base"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "1\n"); writeFileSync(join(repo, ".gitignore"), ".mar/\n");
  g("add", "."); g("commit", "-qm", "init");
});
const snapshot = () => ({ head: g("rev-parse", "HEAD"), branch: g("rev-parse", "--abbrev-ref", "HEAD"), status: g("status", "--porcelain") });
const wtDir = (runId: string) => join(repo, ".mar", "worktrees", runId, ".integration");

describe("integrate", () => {
  it("merges disjoint branches into mar/<run>/integration without touching the current branch", async () => {
    branch("t-a", { "x/a.ts": "A" }); branch("t-b", { "y/b.ts": "B" });
    const before = snapshot();
    const r = await integrate({ repo, runId: "run1", branches: ["t-a", "t-b"] });
    expect(r).toEqual({ branch: "mar/run1/integration", merged: ["t-a", "t-b"] });
    expect(g("show", "mar/run1/integration:x/a.ts")).toBe("A");
    expect(g("show", "mar/run1/integration:y/b.ts")).toBe("B");
    expect(g("log", "--merges", "--format=%an <%ae>", "mar/run1/integration")).toContain("mar <mar@localhost>");
    expect(snapshot()).toEqual(before);
    expect(existsSync(wtDir("run1"))).toBe(false);          // temp worktree removed
    expect(g("worktree", "list", "--porcelain")).not.toContain(".integration");
    expect(g("branch", "--list", "mar/run1/integration")).toContain("mar/run1/integration"); // branch kept
    expect(g("rev-parse", "feat/base")).toBe(before.head);
  });
  it("stops at the first conflict, aborts the merge, keeps earlier branches and does not merge later ones", async () => {
    branch("t-a", { "ok/a.ts": "A" });
    branch("t-b", { "a.txt": "B\n" });
    branch("t-c", { "a.txt": "C\n" });
    branch("t-d", { "d/d.ts": "D" });
    const before = snapshot();
    const r = await integrate({ repo, runId: "run1", branches: ["t-a", "t-b", "t-c", "t-d"] });
    expect(r.merged).toEqual(["t-a", "t-b"]);
    expect(r.conflict).toEqual({ branch: "t-c", files: ["a.txt"] });
    expect(r.verify).toBeUndefined();
    expect(g("show", "mar/run1/integration:ok/a.ts")).toBe("A");
    expect(g("show", "mar/run1/integration:a.txt")).toBe("B");
    expect(() => g("show", "mar/run1/integration:d/d.ts")).toThrow();
    // nothing half-merged: the integration branch tip is a clean commit and no MERGE_HEAD is left anywhere
    expect(g("status", "--porcelain")).toBe(before.status);
    expect(existsSync(wtDir("run1"))).toBe(false);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
    expect(snapshot()).toEqual(before);
  });
  it("does not verify after a conflict and keeps the earlier merge as a clean tip", async () => {
    branch("t-b", { "a.txt": "B\n" }); branch("t-c", { "a.txt": "C\n" });
    const runVerify = async () => { throw new Error("must not verify after a conflict"); };
    const r = await integrate({ repo, runId: "run1", branches: ["t-b", "t-c"], verify: { commands: ["x"], timeoutMs: 1000 }, runVerify });
    expect(r.conflict?.branch).toBe("t-c");
    expect(g("log", "--format=%s", "-1", "mar/run1/integration")).toMatch(/Merge branch 't-b'/);
  });
  it("merges chained branches (b already contains a)", async () => {
    branch("t-a", { "a.new": "A" });
    branch("t-b", { "b.new": "B" }, "t-a");
    const r = await integrate({ repo, runId: "run1", branches: ["t-a", "t-b"] });
    expect(r.conflict).toBeUndefined();
    expect(r.merged).toEqual(["t-a", "t-b"]);
    expect(g("show", "mar/run1/integration:b.new")).toBe("B");
    expect(g("show", "mar/run1/integration:a.new")).toBe("A");
  });
  it("runs verify on the merged worktree and reports a failure", async () => {
    branch("t-a", { "a.new": "A" });
    const calls: { cwd: string; commands: string[]; sawFile: boolean }[] = [];
    const fail: VerifyResult = { ok: false, failed: { command: "pnpm test", code: 1, timedOut: false }, tail: "boom", ms: 3 };
    const r = await integrate({
      repo, runId: "run1", branches: ["t-a"], verify: { commands: ["pnpm test"], timeoutMs: 5000 },
      runVerify: async (cwd, commands) => { calls.push({ cwd, commands, sawFile: existsSync(join(cwd, "a.new")) }); return fail; },
    });
    expect(calls).toEqual([{ cwd: wtDir("run1"), commands: ["pnpm test"], sawFile: true }]);
    expect(r.verify).toEqual({ ok: false, failed: fail.failed, tail: "boom" });
    expect(r.conflict).toBeUndefined();
    expect(existsSync(wtDir("run1"))).toBe(false);
  });
  it("reports verify success; no verify block when no commands", async () => {
    branch("t-a", { "a.new": "A" });
    const okr: VerifyResult = { ok: true, tail: "", ms: 1 };
    const r = await integrate({ repo, runId: "run1", branches: ["t-a"], verify: { commands: ["x"], timeoutMs: 1 }, runVerify: async () => okr });
    expect(r.verify).toEqual({ ok: true, tail: "" });
    const r2 = await integrate({ repo, runId: "run2", branches: ["t-a"], verify: { commands: [], timeoutMs: 1 }, runVerify: async () => { throw new Error("no"); } });
    expect(r2.verify).toBeUndefined();
  });
  it("removes the temp worktree even when verify throws", async () => {
    branch("t-a", { "a.new": "A" });
    await expect(integrate({ repo, runId: "run1", branches: ["t-a"], verify: { commands: ["x"], timeoutMs: 1 }, runVerify: async () => { throw new Error("kaboom"); } })).rejects.toThrow(/kaboom/);
    expect(existsSync(wtDir("run1"))).toBe(false);
    expect(g("worktree", "list", "--porcelain")).not.toContain(".integration");
  });
  it("re-running recreates the branch from the current HEAD (idempotent for resume)", async () => {
    branch("t-a", { "a.new": "A" });
    await integrate({ repo, runId: "run1", branches: ["t-a"] });
    const first = g("rev-parse", "mar/run1/integration");
    // HEAD advances, then integrate again with a different set
    writeFileSync(join(repo, "later.txt"), "L"); g("add", "later.txt"); g("commit", "-qm", "later");
    branch("t-b", { "b.new": "B" }, "feat/base");
    const r = await integrate({ repo, runId: "run1", branches: ["t-b"] });
    expect(r.merged).toEqual(["t-b"]);
    expect(g("rev-parse", "mar/run1/integration")).not.toBe(first);
    expect(g("show", "mar/run1/integration:later.txt")).toBe("L");
    expect(() => g("show", "mar/run1/integration:a.new")).toThrow(); // reset, not appended
    const again = await integrate({ repo, runId: "run1", branches: ["t-b"] });
    expect(again.merged).toEqual(["t-b"]);
  });
  it("a branch that does not exist is a clear error and creates nothing", async () => {
    branch("t-a", { "a.new": "A" });
    await expect(integrate({ repo, runId: "run1", branches: ["t-a", "ghost"] })).rejects.toThrow(/ghost.*not found/);
    expect(g("branch", "--list", "mar/run1/integration")).toBe("");
    expect(existsSync(wtDir("run1"))).toBe(false);
  });
  it("rejects unsafe run ids and branch names", async () => {
    await expect(integrate({ repo, runId: "../x", branches: [] })).rejects.toThrow(/invalid run id/);
    await expect(integrate({ repo, runId: "r", branches: ["--upload-pack=x"] })).rejects.toThrow(/invalid branch/);
    await expect(integrate({ repo, runId: "r", branches: ["a b"] })).rejects.toThrow(/invalid branch/);
  });
  it("refuses when the integration branch is the current branch", async () => {
    g("checkout", "-q", "-b", "mar/run1/integration");
    branch("t-a", { "a.new": "A" }, "mar/run1/integration");
    g("checkout", "-q", "mar/run1/integration");
    const before = snapshot();
    await expect(integrate({ repo, runId: "run1", branches: ["t-a"] })).rejects.toThrow(/current branch/);
    expect(snapshot()).toEqual(before);
  });
  it("works with a relative repo path", async () => {
    branch("t-a", { "a.new": "A" });
    const r = await integrate({ repo: relative(process.cwd(), repo), runId: "run1", branches: ["t-a"] });
    expect(r.merged).toEqual(["t-a"]);
    expect(g("show", "mar/run1/integration:a.new")).toBe("A");
  });
  it("links dependency paths into the integration worktree when verify commands exist", async () => {
    branch("t-a", { "a.new": "A" });
    mkdirSync(join(repo, "node_modules")); writeFileSync(join(repo, "node_modules", "m.js"), "1");
    let linked = false;
    await integrate({
      repo, runId: "run1", branches: ["t-a"], linkPaths: ["node_modules"], verify: { commands: ["x"], timeoutMs: 1 },
      runVerify: async (cwd) => { linked = lstatSync(join(cwd, "node_modules")).isSymbolicLink() && readFileSync(join(cwd, "node_modules", "m.js"), "utf8") === "1"; return { ok: true, tail: "", ms: 0 }; },
    });
    expect(linked).toBe(true);
    expect(existsSync(join(repo, "node_modules", "m.js"))).toBe(true);
  });
  it("stops merging when aborted", async () => {
    branch("t-a", { "a.new": "A" });
    const ac = new AbortController(); ac.abort();
    await expect(integrate({ repo, runId: "run1", branches: ["t-a"], signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(existsSync(wtDir("run1"))).toBe(false);
  });
  it("does not skip repo hooks: a failing pre-merge-commit hook fails the integration (merge aborted, worktree removed)", async () => {
    branch("t-a", { "a.new": "A" });
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(integrate({ repo, runId: "run1", branches: ["t-a"] })).rejects.toThrow(/t-a/);
    expect(existsSync(wtDir("run1"))).toBe(false);
  });
});
