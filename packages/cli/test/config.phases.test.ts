import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { effectiveMaxTotalTokens, loadConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const repo = (cfg?: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "mar-cp-")); roots.push(d);
  if (cfg !== undefined) writeFileSync(join(d, ".mar.json"), JSON.stringify(cfg));
  return d;
};

describe("phase limits in .mar.json", () => {
  it("defaults", () => {
    const c = loadConfig(repo());
    expect(c).toMatchObject({ maxTasks: 8, maxPhases: 5, repoMapChars: 20000 });
    expect(c.maxTotalTokens).toBeUndefined();
    expect(effectiveMaxTotalTokens(c)).toBe(5 * 200000);
  });
  it("maxTotalTokens defaults to 5 x defaultBudgetTokens and follows it", () => {
    expect(effectiveMaxTotalTokens(loadConfig(repo({ defaultBudgetTokens: 1000 })))).toBe(5000);
    expect(effectiveMaxTotalTokens({ ...loadConfig(repo()), defaultBudgetTokens: 10 })).toBe(50); // e.g. after --budget
    expect(effectiveMaxTotalTokens(loadConfig(repo({ maxTotalTokens: 12345 })))).toBe(12345);
  });
  it.each([
    ["maxTasks", [1, 16], [0, 17, 1.5]], ["maxPhases", [1, 10], [0, 11, 2.5]], ["repoMapChars", [2000, 100000], [1999, 100001]],
    ["maxTotalTokens", [1, 9_000_000], [0, -5, 1.5]],
  ] as const)("%s accepts its bounds and rejects out-of-range values", (key, good, bad) => {
    for (const v of good) expect(loadConfig(repo({ [key]: v }))[key]).toBe(v);
    for (const v of bad) expect(() => loadConfig(repo({ [key]: v }))).toThrow(new RegExp(key));
  });
});
