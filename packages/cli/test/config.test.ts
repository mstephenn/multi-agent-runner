import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { loadConfig } from "../src/config.js";
describe("loadConfig", () => {
  it("returns defaults with no file; planner defaults to sonnet, never opus", () => {
    const c = loadConfig(mkdtempSync(join(tmpdir(), "mar-c-")));
    expect(c.plannerModel).toMatch(/sonnet/);
    expect(c.maxAttempts).toBe(1);
    expect(JSON.stringify(c)).not.toMatch(/opus/i);
  });
  it("merges overrides and rejects unknown keys", () => {
    const d = mkdtempSync(join(tmpdir(), "mar-c-"));
    writeFileSync(join(d, ".mar.json"), JSON.stringify({ concurrency: 1 }));
    expect(loadConfig(d).concurrency).toBe(1);
    writeFileSync(join(d, ".mar.json"), JSON.stringify({ nope: 1 }));
    expect(() => loadConfig(d)).toThrow();
  });
});
