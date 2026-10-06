import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktrees } from "../src/worktree.js";
import { integrate } from "../src/integrate.js";

// REAL git, temp repos: later phases build on the accumulating integration branch.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
afterAll(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
let repo: string;
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });
const g = (...a: string[]) => execFileSync("git", a, { cwd: repo }).toString().trim();
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mar-ph-"));
  g("init", "-q", "-b", "feat/base"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "1\n"); writeFileSync(join(repo, ".gitignore"), ".mar/\n");
  g("add", "."); g("commit", "-qm", "init");
});
const snapshot = () => ({ head: g("rev-parse", "HEAD"), branch: g("rev-parse", "--abbrev-ref", "HEAD"), status: g("status", "--porcelain") });
// Writes a file in a task's worktree and commits it on the task branch.
async function work(w: ReturnType<typeof createWorktrees>, id: string, file: string, body: string, deps: string[] = []) {
  const dir = await w.create(id, deps);
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), body);
  await w.commit(id, `work ${id}`);
  await w.remove(id);
}

describe("phased worktrees and integration (real git)", () => {
  it("phase 2 writer worktree contains the phase-1 writer's file via the integration base", async () => {
    const before = snapshot();
    const p1 = createWorktrees(repo, "run1");
    await work(p1, "p1-api", "src/api.ts", "API");
    const i1 = await integrate({ repo, runId: "run1", branches: ["mar/run1/p1-api"] });
    expect(i1.merged).toEqual(["mar/run1/p1-api"]);

    const p2 = createWorktrees(repo, "run1", { baseRef: "mar/run1/integration" });
    const dir = await p2.create("p2-ui");
    expect(readFileSync(join(dir, "src/api.ts"), "utf8")).toBe("API");
    // without baseRef the worktree would not see it
    const plain = await createWorktrees(repo, "run1").create("plain");
    expect(existsSync(join(plain, "src/api.ts"))).toBe(false);
    await createWorktrees(repo, "run1").remove("plain");
    await p2.remove("p2-ui");
    expect(snapshot()).toEqual(before);
  });
  it("the shared read-only worktree of phase 2 is based on the integration tip", async () => {
    const p1 = createWorktrees(repo, "run1");
    await work(p1, "p1-api", "src/api.ts", "API");
    await integrate({ repo, runId: "run1", branches: ["mar/run1/p1-api"] });
    const p2 = createWorktrees(repo, "run1", { baseRef: "mar/run1/integration" });
    const shared = await p2.shared.acquire();
    expect(readFileSync(join(shared, "src/api.ts"), "utf8")).toBe("API");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: shared }).toString().trim()).toBe(g("rev-parse", "mar/run1/integration"));
    await p2.shared.release();
    // default (no baseRef) still uses HEAD
    const plain = await createWorktrees(repo, "run1").shared.acquire();
    expect(existsSync(join(plain, "src/api.ts"))).toBe(false);
    await createWorktrees(repo, "run1").shared.release();
  });
  it("rejects a baseRef that is not a safe ref name", () => {
    expect(() => createWorktrees(repo, "run1", { baseRef: "--evil" })).toThrow(/baseRef/);
    expect(() => createWorktrees(repo, "run1", { baseRef: "a..b" })).toThrow(/baseRef/);
  });
  it("integrate accumulates across phases without resetting, and never touches the user's branch", async () => {
    const before = snapshot();
    const p1 = createWorktrees(repo, "run1");
    await work(p1, "p1-api", "src/api.ts", "API");
    const r1 = await integrate({ repo, runId: "run1", branches: ["mar/run1/p1-api"] }); // phase 1: from HEAD (as before)
    const tip1 = g("rev-parse", r1.branch);

    const p2 = createWorktrees(repo, "run1", { baseRef: r1.branch });
    await work(p2, "p2-ui", "src/ui.ts", "UI");
    const r2 = await integrate({ repo, runId: "run1", branches: ["mar/run1/p2-ui"], baseRef: r1.branch, reset: false });
    expect(r2.merged).toEqual(["mar/run1/p2-ui"]);
    expect(g("show", `${r2.branch}:src/api.ts`)).toBe("API"); // phase 1 work kept
    expect(g("show", `${r2.branch}:src/ui.ts`)).toBe("UI");
    expect(g("merge-base", "--is-ancestor", tip1, r2.branch) ?? "").toBe(""); // old tip is an ancestor (exit 0)
    // a third phase on top, again without reset
    const p3 = createWorktrees(repo, "run1", { baseRef: r2.branch });
    await work(p3, "p3-x", "src/x.ts", "X");
    await integrate({ repo, runId: "run1", branches: ["mar/run1/p3-x"], baseRef: r2.branch, reset: false });
    for (const f of ["api", "ui", "x"]) expect(g("show", `mar/run1/integration:src/${f}.ts`)).toBeTruthy();
    expect(snapshot()).toEqual(before);
    expect(g("rev-parse", "feat/base")).toBe(before.head);
    expect(existsSync(join(repo, ".mar", "worktrees", "run1", ".integration"))).toBe(false);
  });
  it("reset (default) still recreates the integration branch from HEAD", async () => {
    const p1 = createWorktrees(repo, "run1");
    await work(p1, "p1-api", "src/api.ts", "API");
    await integrate({ repo, runId: "run1", branches: ["mar/run1/p1-api"] });
    await work(p1, "p1-other", "src/o.ts", "O");
    await integrate({ repo, runId: "run1", branches: ["mar/run1/p1-other"] });
    expect(() => g("cat-file", "-e", "mar/run1/integration:src/api.ts")).toThrow();
  });
  it("reset:false with no existing integration branch creates it from baseRef/HEAD", async () => {
    const p1 = createWorktrees(repo, "run1");
    await work(p1, "p1-api", "src/api.ts", "API");
    const r = await integrate({ repo, runId: "run1", branches: ["mar/run1/p1-api"], reset: false });
    expect(r.merged).toEqual(["mar/run1/p1-api"]);
    expect(g("show", "mar/run1/integration:src/api.ts")).toBe("API");
  });
  it("a conflict in a later phase keeps the earlier accumulated work and aborts the merge", async () => {
    const p1 = createWorktrees(repo, "run1");
    await work(p1, "p1-a", "src/a.ts", "A");
    const r1 = await integrate({ repo, runId: "run1", branches: ["mar/run1/p1-a"] });
    const tip1 = g("rev-parse", r1.branch);
    // conflicting branch cut from the ORIGINAL base editing a.txt, while integration also changes it
    const alt = createWorktrees(repo, "run1");
    await work(alt, "p2-c1", "a.txt", "C1\n");
    await work(alt, "p2-c2", "a.txt", "C2\n");
    const r2 = await integrate({ repo, runId: "run1", branches: ["mar/run1/p2-c1", "mar/run1/p2-c2"], baseRef: r1.branch, reset: false });
    expect(r2.conflict?.branch).toBe("mar/run1/p2-c2");
    expect(r2.merged).toEqual(["mar/run1/p2-c1"]);
    expect(g("show", `${r2.branch}:src/a.ts`)).toBe("A");
    expect(g("merge-base", "--is-ancestor", tip1, r2.branch)).toBe("");
  });
});
