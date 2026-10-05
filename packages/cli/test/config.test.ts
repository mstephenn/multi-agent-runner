import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const repo = (cfg?: unknown, raw?: string) => {
  const d = mkdtempSync(join(tmpdir(), "mar-c-")); roots.push(d);
  if (raw !== undefined) writeFileSync(join(d, ".mar.json"), raw);
  else if (cfg !== undefined) writeFileSync(join(d, ".mar.json"), JSON.stringify(cfg));
  return d;
};

describe("loadConfig", () => {
  it("returns defaults with no file; planner defaults to sonnet, never opus", () => {
    const c = loadConfig(repo());
    expect(c.plannerModel).toMatch(/sonnet/);
    expect(c.maxAttempts).toBe(1);
    expect(c.allowOpus).toBe(false);
    expect(JSON.stringify({ ...c, allowOpus: undefined })).not.toMatch(/opus/i); // allowOpus is the flag name, not a model
  });
  it("merges overrides and rejects unknown keys", () => {
    expect(loadConfig(repo({ concurrency: 1 })).concurrency).toBe(1);
    expect(() => loadConfig(repo({ nope: 1 }))).toThrow(/\.mar\.json/);
  });
  it("maxAttempts 0 is rejected, 3 accepted", () => {
    expect(() => loadConfig(repo({ maxAttempts: 0 }))).toThrow(/maxAttempts/);
    expect(loadConfig(repo({ maxAttempts: 3 })).maxAttempts).toBe(3);
  });
  it("maxAttempts 4 is rejected", () => { expect(() => loadConfig(repo({ maxAttempts: 4 }))).toThrow(/maxAttempts/); });
  it.each([0, 17, 1.5])("rejects concurrency %s", (n) => { expect(() => loadConfig(repo({ concurrency: n }))).toThrow(/concurrency/); });
  it("accepts concurrency 16", () => { expect(loadConfig(repo({ concurrency: 16 })).concurrency).toBe(16); });
  it("malformed JSON error names the file", () => {
    expect(() => loadConfig(repo(undefined, "{ nope"))).toThrow(/\.mar\.json.*JSON/s);
  });
  it("zod errors name the file and the offending path", () => {
    expect(() => loadConfig(repo({ defaultBudgetTokens: "x" }))).toThrow(/\.mar\.json: .*defaultBudgetTokens/);
  });
  it("partial tiers override merges with defaults", () => {
    const c = loadConfig(repo({ tiers: { claude: { low: "claude-haiku-4-5-20251001" } } }));
    expect(c.tiers.claude.mid).toMatch(/sonnet/);
    expect(c.tiers.codex).toEqual({ low: null, mid: null, high: null });
    const d = loadConfig(repo({ tiers: { codex: { mid: "gpt-x" } } }));
    expect(d.tiers.codex).toEqual({ low: null, mid: "gpt-x", high: null });
    expect(d.tiers.claude.high).toMatch(/sonnet/);
  });
  it("rejects unknown tier keys", () => {
    expect(() => loadConfig(repo({ tiers: { claude: { ultra: "x" } } }))).toThrow(/\.mar\.json/);
  });
  it("plannerModel must be non-empty", () => {
    expect(() => loadConfig(repo({ plannerModel: "" }))).toThrow(/plannerModel/);
  });
  it("rejects opus model ids unless allowOpus is true", () => {
    expect(() => loadConfig(repo({ plannerModel: "claude-opus-4" }))).toThrow(/opus.*allowOpus/i);
    expect(() => loadConfig(repo({ tiers: { claude: { high: "Claude-OPUS-4" } } }))).toThrow(/allowOpus/);
    expect(loadConfig(repo({ plannerModel: "claude-opus-4", allowOpus: true })).plannerModel).toBe("claude-opus-4");
  });
});
