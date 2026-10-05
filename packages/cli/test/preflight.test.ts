import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { preflight, nodeRunner } from "../src/preflight.js";

const runner = (map: Record<string, { code: number; out: string }>) => async (cmd: string, args: string[]) => map[`${cmd} ${args.join(" ")}`] ?? { code: 1, out: "" };
const good = {
  "git rev-parse --is-inside-work-tree": { code: 0, out: "true" },
  "git rev-parse --verify HEAD": { code: 0, out: "abc123" },
  "git status --porcelain": { code: 0, out: "" },
  "claude --version": { code: 0, out: "2.1.289" }, "codex --version": { code: 0, out: "0.156.1" },
};

describe("preflight", () => {
  it("passes when everything is present", async () => { expect(await preflight("/r", runner(good))).toEqual([]); });
  it("fails for a non-git directory", async () => {
    expect((await preflight("/r", runner({ ...good, "git rev-parse --is-inside-work-tree": { code: 128, out: "" } }))).join()).toMatch(/not a git/i);
  });
  it("fails for a dirty tree", async () => {
    expect((await preflight("/r", runner({ ...good, "git status --porcelain": { code: 0, out: " M a.ts" } }))).join()).toMatch(/uncommitted|dirty/i);
  });
  it("treats a failed git status as a problem, not as clean", async () => {
    expect((await preflight("/r", runner({ ...good, "git status --porcelain": { code: 128, out: "" } }))).join()).toMatch(/git status/i);
  });
  it("ignores untracked .mar/ and .mar.json but not other untracked files", async () => {
    expect(await preflight("/r", runner({ ...good, "git status --porcelain": { code: 0, out: "?? .mar/\n?? .mar.json\n" } }))).toEqual([]);
    expect((await preflight("/r", runner({ ...good, "git status --porcelain": { code: 0, out: "?? .mar/\n?? a.ts\n" } }))).join()).toMatch(/uncommitted/);
    expect((await preflight("/r", runner({ ...good, "git status --porcelain": { code: 0, out: " M .mar.json\n" } }))).join()).toMatch(/uncommitted/);
  });
  it("rejects a bare repo (is-inside-work-tree prints false with exit 0)", async () => {
    expect((await preflight("/r", runner({ ...good, "git rev-parse --is-inside-work-tree": { code: 0, out: "false\n" } }))).join()).toMatch(/work tree|bare/i);
  });
  it("fails for a repo with no commits", async () => {
    expect((await preflight("/r", runner({ ...good, "git rev-parse --verify HEAD": { code: 128, out: "" } }))).join()).toMatch(/no commits/i);
  });
  it("reports each missing CLI", async () => {
    const p = await preflight("/r", runner({ ...good, "claude --version": { code: 127, out: "" }, "codex --version": { code: 127, out: "" } }));
    expect(p.join()).toMatch(/claude/); expect(p.join()).toMatch(/codex/);
  });
});

describe("nodeRunner", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mar-nr-"));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));
  it("returns code 0 and stdout on success", async () => {
    const r = await nodeRunner(cwd)(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(r).toEqual({ code: 0, out: "hi" });
  });
  it("returns the exit code on failure without throwing", async () => {
    const r = await nodeRunner(cwd)(process.execPath, ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });
  it("returns 127 for a missing binary", async () => {
    expect((await nodeRunner(cwd)("mar-definitely-not-a-binary", [])).code).toBe(127);
  });
  it("does not use a shell", async () => {
    const r = await nodeRunner(cwd)(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "$(echo x);y"]);
    expect(r.out).toBe("$(echo x);y");
  });
  it("times out hung commands, kills the child and returns 124", async () => {
    const t0 = Date.now();
    const r = await nodeRunner(cwd, 200)(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    expect(r.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
