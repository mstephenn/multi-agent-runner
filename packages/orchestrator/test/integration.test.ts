import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDag } from "@mar/core";
import { Store } from "../../server/src/store.js";
import { runDag } from "../src/scheduler.js";
import { createWorktrees } from "../src/worktree.js";
import type { Adapter } from "../../adapters/src/types.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
afterAll(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_NOSYSTEM", savedEnv.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mar-int-")); roots.push(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-q", "-b", "feat/x"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "1"); writeFileSync(join(dir, ".gitignore"), ".mar/\n");
  g("add", "a.txt", ".gitignore"); g("commit", "-qm", "init");
  return dir;
}
const show = (repo: string, branch: string, file: string) => execFileSync("git", ["show", `${branch}:${file}`], { cwd: repo }).toString();
const T = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `do ${id}`, ...extra });

// Writes `<taskId>.txt` into the worktree, records what upstream files the task could see, then returns `result`.
function writer(seen: Record<string, string[]>, result: (id: string) => string): Adapter {
  return {
    runtime: "claude",
    async *run(i) {
      writeFileSync(join(i.cwd, `${i.taskId}.txt`), `from ${i.taskId}`);
      seen[i.taskId] = ["up.txt", "dn.txt"].filter((f) => existsSync(join(i.cwd, f)) && f !== `${i.taskId}.txt`);
      yield { type: "result", text: result(i.taskId) };
    },
  };
}
const goodResult = JSON.stringify({ summary: "ok", filesChanged: ["x"], decisions: [], openQuestions: [] });

describe("scheduler with real worktrees", () => {
  it("keeps work on mar/<run>/<task> on success and sees upstream files in dependents", async () => {
    const repo = initRepo(), seen: Record<string, string[]> = {};
    const store = new Store(":memory:"); store.createRun("run1", "g", repo);
    const a = writer(seen, () => goodResult);
    const out = await runDag({
      store, runId: "run1", repo, dag: parseDag({ tasks: [T("up"), T("dn", { dependsOn: ["up"], needs: ["up/decisions"] })] }),
      adapters: { claude: a, codex: a }, worktrees: createWorktrees(repo, "run1"),
      modelFor: () => null, toolsFor: () => [], concurrency: 1,
    });
    expect(out).toEqual({ up: "done", dn: "done" });
    expect(show(repo, "mar/run1/up", "up.txt")).toBe("from up");
    expect(show(repo, "mar/run1/dn", "dn.txt")).toBe("from dn");
    expect(seen.dn).toEqual(["up.txt"]);
    expect(show(repo, "mar/run1/dn", "up.txt")).toBe("from up"); // upstream work merged into the dependent's branch
    expect(existsSync(join(repo, ".mar", "worktrees", "run1", "up"))).toBe(false);
  });

  it("keeps partial work on the task branch after a bad-result attempt (I3)", async () => {
    const repo = initRepo(), seen: Record<string, string[]> = {};
    const store = new Store(":memory:"); store.createRun("run2", "g", repo);
    const a = writer(seen, () => "not json");
    const out = await runDag({
      store, runId: "run2", repo, dag: parseDag({ tasks: [T("up")] }),
      adapters: { claude: a, codex: a }, worktrees: createWorktrees(repo, "run2"),
      modelFor: () => null, toolsFor: () => [], concurrency: 1,
    });
    expect(out).toEqual({ up: "failed" });
    expect(show(repo, "mar/run2/up", "up.txt")).toBe("from up");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("1");
    expect(execFileSync("git", ["log", "-1", "--format=%s", "mar/run2/up"], { cwd: repo }).toString().trim()).toBe("mar(up): wip (failed attempt)");
  });
});
