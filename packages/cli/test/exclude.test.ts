import { describe, it, expect, afterEach } from "vitest";
import { ensureMarExcluded } from "../../orchestrator/src/worktree.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { execFileSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("ensureMarExcluded", () => {
  it("appends .mar/ once so .mar does not dirty the tree", async () => {
    const d = mkdtempSync(join(tmpdir(), "mar-x-")); roots.push(d);
    execFileSync("git", ["init", "-q"], { cwd: d, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    await ensureMarExcluded(d); await ensureMarExcluded(d);
    const ex = readFileSync(join(d, ".git/info/exclude"), "utf8");
    expect(ex.split("\n").filter((l) => l === ".mar/")).toHaveLength(1);
    execFileSync("mkdir", ["-p", join(d, ".mar")]); execFileSync("touch", [join(d, ".mar/mar.db")]);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" })).toBe("");
  });
});
