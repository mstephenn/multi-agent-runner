import { describe, it, expect } from "vitest";
import { cmdShimArgv, dirLinkType, envGet } from "../src/platform.js";
import { workerEnv } from "../src/env.js";

describe("windows support helpers", () => {
  it("keeps Path/USERPROFILE on Windows regardless of key casing, drops secrets", () => {
    const env = workerEnv({ Path: "C:\\bin", UserProfile: "C:\\u", SystemRoot: "C:\\Windows", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "k" }, true);
    expect(env).toEqual({ Path: "C:\\bin", UserProfile: "C:\\u", SystemRoot: "C:\\Windows", ANTHROPIC_API_KEY: "k" });
  });
  it("does not widen the allowlist on POSIX", () => {
    expect(workerEnv({ Path: "x", PATH: "y", USERPROFILE: "z" }, false)).toEqual({ PATH: "y" });
  });
  it("envGet is case-insensitive", () => expect(envGet({ Path: "p" }, "PATH")).toBe("p"));
  it("builds a cmd.exe line that quotes and caret-escapes metacharacters", () => {
    const [d, s, c, line] = cmdShimArgv("C:\\npm\\codex.cmd", ["exec", 'approval_policy="never"', "a&b"]);
    expect([d, s, c]).toEqual(["/d", "/s", "/c"]);
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    expect(line).toContain("a^&b"); // the & cannot terminate the command
    expect(line).not.toMatch(/[^^]&/);
  });
  it("uses junctions for directory links on Windows", () => {
    expect(dirLinkType("win32")).toBe("junction");
    expect(dirLinkType("linux")).toBe("dir");
  });
});
