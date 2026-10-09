import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnowledge, refreshKnowledge, readEntry } from "../src/index.js";

const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "kb-"));
  writeFileSync(join(d, "package.json"), JSON.stringify({ type: "module", scripts: { test: "vitest run", deploy: "x --token=sk-abcdefghijklmnop" }, dependencies: { zod: "1" } }));
  writeFileSync(join(d, "pnpm-lock.yaml"), "");
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["add", "-A"], { cwd: d });
  return d;
};

describe("knowledge base", () => {
  it("creates, scans, redacts, and is idempotent", () => {
    const d = repo();
    const r1 = refreshKnowledge(d, { now: () => 1 });
    expect(r1.added.sort()).toEqual(["commands", "conventions", "stack", "structure"]);
    expect(readEntry(r1.kb, "commands")).toContain("pnpm run test");
    expect(readEntry(r1.kb, "commands")).not.toContain("sk-abcdefghijklmnop");
    const r2 = refreshKnowledge(d, { now: () => 2 });
    expect(r2.updated).toEqual([]);
    expect(r2.unchanged.length).toBe(4);
    expect(r2.kb.index.entries[0]!.updatedAt).toBe(1);
  });
  it("updates changed scan entries, keeps manual edits and orphans", () => {
    const d = repo();
    refreshKnowledge(d, { now: () => 1 });
    writeFileSync(join(d, ".mar/knowledge/stack.md"), "# Mine\n");
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const r = refreshKnowledge(d, { now: () => 3 });
    expect(r.preserved).toContain("stack");
    expect(r.updated).toContain("commands");
    expect(readFileSync(join(d, ".mar/knowledge/stack.md"), "utf8")).toBe("# Mine\n");
    expect(loadKnowledge(d).index.entries.find((e) => e.id === "commands")!.createdAt).toBe(1);
  });
  it("recovers from a corrupt index", () => {
    const d = repo();
    refreshKnowledge(d);
    writeFileSync(join(d, ".mar/knowledge/index.json"), "{bad");
    const kb = loadKnowledge(d);
    expect(kb.index.entries.length).toBe(4);
    expect(existsSync(join(d, ".mar/knowledge/index.json"))).toBe(true);
  });
});
