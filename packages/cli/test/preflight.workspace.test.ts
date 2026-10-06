import { describe, it, expect } from "vitest";
import { preflightWorkspace, preflight } from "../src/preflight.js";

type R = Record<string, { code: number; out: string }>;
const good: R = {
  "git rev-parse --is-inside-work-tree": { code: 0, out: "true" },
  "git rev-parse --verify HEAD": { code: 0, out: "abc" },
  "git status --porcelain": { code: 0, out: "" },
  "claude --version": { code: 0, out: "1" }, "codex --version": { code: 0, out: "1" },
};
const repos = [{ name: "api", path: "/ws/api" }, { name: "web", path: "/ws/web" }];
const calls: string[] = [];
const runnerFor = (perCwd: Record<string, R>) => (cwd: string) => async (cmd: string, args: string[]) => {
  calls.push(`${cwd}: ${cmd} ${args.join(" ")}`);
  return (perCwd[cwd] ?? good)[`${cmd} ${args.join(" ")}`] ?? good[`${cmd} ${args.join(" ")}`] ?? { code: 1, out: "" };
};

describe("preflightWorkspace", () => {
  it("passes when every repo is clean and the CLIs exist; CLI versions are checked once", async () => {
    calls.length = 0;
    expect(await preflightWorkspace(repos, runnerFor({}))).toEqual([]);
    expect(calls.filter((c) => c.endsWith("claude --version"))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith("codex --version"))).toHaveLength(1);
  });
  it("names the dirty repo", async () => {
    const p = await preflightWorkspace(repos, runnerFor({ "/ws/web": { ...good, "git status --porcelain": { code: 0, out: " M a.ts" } } }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^web: .*uncommitted/);
  });
  it("reports problems of several repos, each prefixed", async () => {
    const p = await preflightWorkspace(repos, runnerFor({
      "/ws/api": { ...good, "git rev-parse --verify HEAD": { code: 128, out: "" } },
      "/ws/web": { ...good, "git status --porcelain": { code: 0, out: "?? new.ts" } },
    }));
    expect(p.map((x) => x.split(":")[0])).toEqual(["api", "web"]);
    expect(p[0]).toMatch(/no commits/);
  });
  it("a dirty repo that is not in the given (scoped) list does not matter", async () => {
    const p = await preflightWorkspace([repos[0]], runnerFor({ "/ws/web": { ...good, "git status --porcelain": { code: 0, out: " M x" } } }));
    expect(p).toEqual([]);
  });
  it("reports a missing CLI once, unprefixed", async () => {
    const p = await preflightWorkspace(repos, runnerFor({ "/ws/api": { ...good, "codex --version": { code: 127, out: "" } } }));
    expect(p).toEqual(["codex CLI not found or not runnable"]);
  });
  it("single-repo preflight is unchanged", async () => {
    expect(await preflight("/r", async (c, a) => good[`${c} ${a.join(" ")}`] ?? { code: 1, out: "" })).toEqual([]);
  });
});
