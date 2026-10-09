import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/src/store.js";
import { executeRun, runMain, type MainDeps } from "../src/main.js";
import { loadConfig } from "../src/config.js";
import { fakeAdapter, ok } from "../../orchestrator/test/fakeAdapter.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const repo = (config: object = {}) => {
  const root = mkdtempSync(join(tmpdir(), "mar-heal-wire-")); roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".mar.json"), JSON.stringify({ integrate: false, ...config }));
  return root;
};
const plan = { tasks: [{ id: "a", role: "implementer", runtime: "claude", tier: "low", goal: "A" }] };
const worktrees = { create: async () => "/wt/a", commit: async () => {}, remove: async () => {} };

describe("run self-heal wiring", () => {
  it.each([
    [{}, 3],
    [{ maxRetries: 1, escalateOnRetry: false }, 2],
    [{ maxRetries: 0, maxAttempts: 3 }, 1],
    [{ healEnabled: false, maxRetries: 10, maxAttempts: 3 }, 1],
  ] as const)("passes validated settings %j to the scheduler", async (overrides, attempts) => {
    const root = repo(overrides);
    const store = new Store(":memory:"); stores.push(store);
    const f = fakeAdapter((input) => input.taskId === "planner"
      ? [{ type: "result", text: JSON.stringify(plan) }] : new Error("worker failure"));
    const config = loadConfig(root);
    const { runId, results } = await executeRun({
      goal: "g", repo: root, store, config, adapters: { claude: f.adapter, codex: f.adapter },
      worktrees, repoMapFn: () => "", runDagFn: async (deps) => {
        expect(deps).toMatchObject({ maxRetries: config.maxRetries, escalateOnRetry: config.escalateOnRetry, healEnabled: config.healEnabled });
        const { runDag } = await import("../../orchestrator/src/scheduler.js");
        return runDag(deps);
      },
    });
    expect(results.a).toBe("failed");
    expect(store.eventsOfType(runId, ["prompt_sent"]).filter((e) => e.task_id === "a")).toHaveLength(attempts);
    expect(store.eventsOfType(runId, ["task_failed"])[0].payload.attempt).toBe(attempts);
  });

  it.each([true, false])("applies CLI override on run and resume with healEnabled=%s", async (healEnabled) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = repo({ maxRetries: 0, healEnabled, escalateOnRetry: false, maxBudgetUsdPerTask: 1 });
    const f = fakeAdapter((input, attempt) => input.taskId === "planner"
      ? [{ type: "result", text: JSON.stringify(plan) }]
      : attempt === 1 ? new Error("first failure") : ok());
    const deps = {
      adapters: () => ({ claude: f.adapter, codex: f.adapter }), preflight: async () => [],
      proc: new EventEmitter() as unknown as MainDeps["proc"], worktrees, repoMapFn: () => "",
      startServer: async () => ({ port: 7777, address: () => ({ address: "127.0.0.1", family: "IPv4", port: 7777 }), close: async () => {} }),
    };
    expect(await runMain(["run", "g", "--repo", root, "--max-retries", "1"], deps)).toBe(healEnabled ? 0 : 1);
    expect(f.calls.filter((c) => c.taskId === "a")).toHaveLength(healEnabled ? 2 : 1);
    const store = new Store(join(root, ".mar", "mar.db")); stores.push(store);
    const runId = store.listRuns()[0].id;
    store.setTaskStatus(runId, "a", "failed");
    const retry = fakeAdapter((input, attempt) => input.taskId === "planner"
      ? [{ type: "result", text: JSON.stringify({ tasks: [] }) }]
      : attempt === 1 ? new Error("resume failure") : ok());
    expect(await runMain(["resume", runId, "--repo", root, "--max-retries", "1"], {
      ...deps, adapters: () => ({ claude: retry.adapter, codex: retry.adapter }),
    })).toBe(healEnabled ? 0 : 1);
    expect(retry.calls.filter((c) => c.taskId === "a")).toHaveLength(healEnabled ? 2 : 1);
  });
});
