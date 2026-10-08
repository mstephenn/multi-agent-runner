import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { nodeRunner } from "../src/preflight.js";
import { ensureInitialCommit, initIfNoRepo } from "../src/bootstrap.js";

const tmp = () => mkdtempSync(join(tmpdir(), "mar-boot-"));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

describe("bootstrap", () => {
  it("empty folder: git init + empty initial commit, then idempotent", async () => {
    const d = tmp();
    try {
      expect(await initIfNoRepo(d, nodeRunner(d))).toBe(true);
      expect(await ensureInitialCommit(nodeRunner(d))).toBe(true);
      expect(git(d, "rev-parse", "--verify", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
      expect(await initIfNoRepo(d, nodeRunner(d))).toBe(false);
      expect(await ensureInitialCommit(nodeRunner(d))).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("leaves a parent folder of repos alone (workspace)", async () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "a")); git(join(d, "a"), "init", "-q");
      expect(await initIfNoRepo(d, nodeRunner(d))).toBe(false);
      expect(() => git(d, "rev-parse", "--git-dir")).toThrow();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("commits existing files so the tree is clean (respecting .gitignore)", async () => {
    const d = tmp();
    try {
      git(d, "init", "-q"); writeFileSync(join(d, "x.txt"), "hi"); writeFileSync(join(d, ".gitignore"), "secret\n"); writeFileSync(join(d, "secret"), "s");
      await ensureInitialCommit(nodeRunner(d));
      expect(git(d, "status", "--porcelain")).toBe("");
      expect(git(d, "ls-files").split("\n")).toEqual([".gitignore", "x.txt"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
