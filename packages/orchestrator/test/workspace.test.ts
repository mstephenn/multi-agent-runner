import { describe, it, expect, vi } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspace } from "../src/workspace.js";
import { initRepo, tmp, tmpWorkspace, useGitEnv } from "./wsHelpers.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
useGitEnv();

describe("resolveWorkspace", () => {
  it("returns repo mode inside a git work tree (root and subfolder)", async () => {
    const root = tmp(); initRepo(root); mkdirSync(join(root, "sub"));
    expect(await resolveWorkspace(root)).toEqual({ kind: "repo", root });
    expect(await resolveWorkspace(join(root, "sub"))).toEqual({ kind: "repo", root: join(root, "sub") });
  });
  it("a repo that merely contains child repos is still repo mode", async () => {
    const root = tmp(); initRepo(root); initRepo(join(root, "nested"));
    expect((await resolveWorkspace(root)).kind).toBe("repo");
  });
  it("finds immediate child repos, sorted by name", async () => {
    const root = tmpWorkspace(["web", "api", "lib.core"]);
    const ws = await resolveWorkspace(root);
    expect(ws).toMatchObject({ kind: "workspace", root });
    if (ws.kind !== "workspace") throw new Error("unreachable");
    expect(ws.repos).toEqual([{ name: "api", path: join(root, "api") }, { name: "lib.core", path: join(root, "lib.core") }, { name: "web", path: join(root, "web") }]);
  });
  it("skips dot-dirs, node_modules, non-git folders, files and symlinks", async () => {
    const root = tmpWorkspace(["api"]);
    initRepo(join(root, ".hidden")); initRepo(join(root, "node_modules")); mkdirSync(join(root, "docs")); writeFileSync(join(root, "file.txt"), "x");
    symlinkSync(join(root, "api"), join(root, "link"));
    const ws = await resolveWorkspace(root);
    if (ws.kind !== "workspace") throw new Error("unreachable");
    expect(ws.repos.map((r) => r.name)).toEqual(["api"]);
  });
  it("accepts a child whose .git is a file (linked worktree / submodule)", async () => {
    const root = tmpWorkspace(["api"]);
    mkdirSync(join(root, "wt")); writeFileSync(join(root, "wt", ".git"), "gitdir: ../api/.git/worktrees/x\n");
    const ws = await resolveWorkspace(root);
    if (ws.kind !== "workspace") throw new Error("unreachable");
    expect(ws.repos.map((r) => r.name)).toEqual(["api", "wt"]);
  });
  it("skips repos with unsupported names, with a warning", async () => {
    const root = tmpWorkspace(["api"]); initRepo(join(root, "my repo"));
    const ws = await resolveWorkspace(root);
    if (ws.kind !== "workspace") throw new Error("unreachable");
    expect(ws.repos.map((r) => r.name)).toEqual(["api"]);
    expect(ws.warnings?.join("\n")).toMatch(/my repo/);
  });
  it("a single child repo is a workspace of one", async () => {
    const root = tmpWorkspace(["only"]);
    const ws = await resolveWorkspace(root);
    expect(ws).toMatchObject({ kind: "workspace" });
    if (ws.kind === "workspace") expect(ws.repos).toHaveLength(1);
  });
  it("errors clearly when there are no repos", async () => {
    const root = tmp(); mkdirSync(join(root, "docs"));
    await expect(resolveWorkspace(root)).rejects.toThrow(`${root} is not a git repository and has no git repositories in its immediate subfolders`);
  });
  it("errors for a missing path", async () => {
    await expect(resolveWorkspace(join(tmp(), "nope"))).rejects.toThrow(/does not exist|not a directory/);
  });
  it("--repos restricts to the named repos (deduped, sorted by discovery order)", async () => {
    const root = tmpWorkspace(["api", "web", "docs"]);
    const ws = await resolveWorkspace(root, { repos: ["web", "api", "web"] });
    if (ws.kind !== "workspace") throw new Error("unreachable");
    expect(ws.repos.map((r) => r.name)).toEqual(["api", "web"]);
  });
  it("an unknown repo name lists the discovered names", async () => {
    const root = tmpWorkspace(["api", "web"]);
    await expect(resolveWorkspace(root, { repos: ["api", "zzz"] })).rejects.toThrow(/unknown repo "zzz".*api, web/);
  });
  it("--repos in a plain repo is an error", async () => {
    const root = tmp(); initRepo(root);
    await expect(resolveWorkspace(root, { repos: ["a"] })).rejects.toThrow(/only applies/);
  });
});
