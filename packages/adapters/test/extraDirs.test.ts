import { describe, it, expect } from "vitest";
import { buildClaudeArgs, claudeAdapter } from "../src/claude.js";
import { buildCodexArgs, codexAdapter } from "../src/codex.js";
import type { AdapterInput } from "../src/types.js";

const base: AdapterInput = { taskId: "t", prompt: "p", cwd: "/work/api", model: null, allowedTools: ["Read", "Edit"], signal: new AbortController().signal };

describe("extraDirs", () => {
  it("claude passes one --add-dir per sibling directory", () => {
    const a = buildClaudeArgs({ ...base, extraDirs: ["/run/t/web", "/run/t/docs"] });
    const pairs = a.flatMap((x, i) => (x === "--add-dir" ? [a[i + 1]] : []));
    expect(pairs).toEqual(["/run/t/web", "/run/t/docs"]);
    expect(a.indexOf("--add-dir")).toBeGreaterThan(a.indexOf("--strict-mcp-config"));
  });
  it("claude adds nothing without extraDirs", () => {
    expect(buildClaudeArgs(base)).not.toContain("--add-dir");
    expect(buildClaudeArgs({ ...base, extraDirs: [] })).not.toContain("--add-dir");
  });
  it("codex never turns siblings into writable roots: --add-dir is NOT passed (workspace-write already reads them)", () => {
    const a = buildCodexArgs({ ...base, extraDirs: ["/run/t/web"] });
    expect(a).not.toContain("--add-dir");
    expect(a).toEqual(buildCodexArgs(base));
  });
  it("both adapters declare verified sibling read access", () => {
    expect(claudeAdapter().siblingRead).toBe(true);
    expect(codexAdapter().siblingRead).toBe(true);
  });
});
