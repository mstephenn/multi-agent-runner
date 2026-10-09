import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadWorkspaceConfig } from "../src/config.js";
import { parseCli } from "../src/main.js";

const roots: string[] = [];
const repo = (config?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "mar-heal-"));
  roots.push(root);
  if (config !== undefined) writeFileSync(join(root, ".mar.json"), JSON.stringify(config));
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("self-heal configuration", () => {
  it("defaults and accepts explicit overrides", () => {
    expect(loadConfig(repo())).toMatchObject({ maxRetries: 2, escalateOnRetry: true, healEnabled: true });
    expect(loadConfig(repo({ maxRetries: 0, escalateOnRetry: false, healEnabled: false })))
      .toMatchObject({ maxRetries: 0, escalateOnRetry: false, healEnabled: false });
    expect(loadConfig(repo({ maxRetries: 10 })).maxRetries).toBe(10);
  });
  it.each([-1, 11, 1.5, "2", null])("rejects invalid maxRetries %j", (maxRetries) => {
    expect(() => loadConfig(repo({ maxRetries }))).toThrow(/maxRetries/);
  });
  it.each(["escalateOnRetry", "healEnabled"])("requires boolean %s", (key) => {
    for (const value of [0, "true", null]) expect(() => loadConfig(repo({ [key]: value }))).toThrow(key);
  });
  it("treats self-heal settings as run-level in workspaces", () => {
    const child = repo({ maxRetries: 0, escalateOnRetry: false, healEnabled: false });
    const loaded = loadWorkspaceConfig(repo({ maxRetries: 4 }), [{ name: "child", path: child }]);
    expect(loaded.config.maxRetries).toBe(4);
    expect(loaded.notes.join(" ")).toMatch(/maxRetries, escalateOnRetry, healEnabled/);
    expect(loaded.repoConfigs.child).not.toHaveProperty("maxRetries");
  });
});

describe("--max-retries", () => {
  it.each(["run", "resume"])("accepts bounds for %s", (cmd) => {
    for (const maxRetries of [0, 10]) expect(parseCli([cmd, "goal-or-run", "--max-retries", String(maxRetries)]))
      .toMatchObject({ cmd, maxRetries });
    expect(parseCli([cmd, "goal-or-run"])).not.toHaveProperty("maxRetries");
  });
  it.each(["-1", "11", "1.5", "2x", "", "Infinity", "9007199254740992"])("rejects %j", (value) => {
    expect(() => parseCli(["run", "goal", `--max-retries=${value}`])).toThrow(/max-retries/);
  });
  it("rejects missing values and history usage", () => {
    expect(() => parseCli(["run", "goal", "--max-retries"])).toThrow(/max-retries/);
    expect(() => parseCli(["history", "--max-retries", "0"])).toThrow(/does not apply to history/);
  });
});
