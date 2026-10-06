import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadWorkspaceConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function ws(parent?: unknown, children: Record<string, unknown | string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mar-cw-")); roots.push(root);
  if (parent !== undefined) writeFileSync(join(root, ".mar.json"), JSON.stringify(parent));
  const repos = Object.keys(children).map((name) => ({ name, path: join(root, name) }));
  for (const [name, c] of Object.entries(children)) {
    mkdirSync(join(root, name));
    if (c !== undefined) writeFileSync(join(root, name, ".mar.json"), typeof c === "string" ? c : JSON.stringify(c));
  }
  return { root, repos };
}

describe("loadConfig repos key", () => {
  it("accepts repos: string[] with valid names only", () => {
    const { root } = ws({ repos: ["a", "b.c"] });
    expect(loadConfig(root).repos).toEqual(["a", "b.c"]);
    const bad = ws({ repos: ["a b"] });
    expect(() => loadConfig(bad.root)).toThrow(/repos/);
  });
});

describe("loadWorkspaceConfig", () => {
  it("uses defaults for everything when no file exists", () => {
    const { root, repos } = ws(undefined, { a: undefined, b: undefined });
    const w = loadWorkspaceConfig(root, repos);
    expect(w.config.concurrency).toBe(3);
    expect(w.repoConfigs.a).toEqual({ verify: [], verifyTimeoutMinutes: 10, linkPaths: [], ownership: "warn", integrate: true });
    expect(w.notes).toEqual([]);
  });
  it("parent file is the run-level config and the default for repo-scoped keys", () => {
    const { root, repos } = ws({ concurrency: 2, verify: ["pnpm test"], ownership: "enforce" }, { a: undefined });
    const w = loadWorkspaceConfig(root, repos);
    expect(w.config.concurrency).toBe(2);
    expect(w.repoConfigs.a).toMatchObject({ verify: ["pnpm test"], ownership: "enforce" });
  });
  it("child file overrides the parent for repo-scoped keys only (child < parent precedence: child wins)", () => {
    const { root, repos } = ws({ verify: ["parent check"], linkPaths: ["node_modules"], integrate: true }, {
      a: { verify: ["a check"], integrate: false }, b: {},
    });
    const w = loadWorkspaceConfig(root, repos);
    expect(w.repoConfigs.a).toMatchObject({ verify: ["a check"], linkPaths: ["node_modules"], integrate: false });
    expect(w.repoConfigs.b).toMatchObject({ verify: ["parent check"], integrate: true });
  });
  it("an explicit empty verify in the child turns the gate off for that repo", () => {
    const { root, repos } = ws({ verify: ["parent check"] }, { a: { verify: [] } });
    expect(loadWorkspaceConfig(root, repos).repoConfigs.a.verify).toEqual([]);
  });
  it("ignores run-level keys in a child file with one note per file", () => {
    const { root, repos } = ws({ concurrency: 2 }, { a: { concurrency: 9, plannerModel: "x", verify: ["v"] }, b: { maxPhases: 2 } });
    const w = loadWorkspaceConfig(root, repos);
    expect(w.config.concurrency).toBe(2);
    expect(w.repoConfigs.a.verify).toEqual(["v"]);
    expect(w.notes).toEqual([
      "ignored run-level keys in a/.mar.json: concurrency, plannerModel",
      "ignored run-level keys in b/.mar.json: maxPhases",
    ]);
  });
  it("child file errors name the file", () => {
    const bad = ws({}, { a: { verify: "nope" } });
    expect(() => loadWorkspaceConfig(bad.root, bad.repos)).toThrow(/^a\/\.mar\.json: verify/);
    const badJson = ws({}, { a: "{oops" });
    expect(() => loadWorkspaceConfig(badJson.root, badJson.repos)).toThrow(/^a\/\.mar\.json: invalid JSON/);
    const unknown = ws({}, { a: { whatever: 1 } });
    expect(() => loadWorkspaceConfig(unknown.root, unknown.repos)).toThrow(/^a\/\.mar\.json:.*whatever/);
  });
  it("parent file errors keep naming .mar.json", () => {
    const { root, repos } = ws({ nope: 1 }, { a: undefined });
    expect(() => loadWorkspaceConfig(root, repos)).toThrow(/^\.mar\.json:/);
  });
});
