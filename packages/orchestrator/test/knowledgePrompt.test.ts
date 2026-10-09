import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgePrompt, loadKnowledge, mergeKnowledge } from "../src/index.js";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "kb-prompt-"));
  roots.push(path);
  return path;
};
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("knowledgePrompt", () => {
  it("renders all sections deterministically without modifying the KB", () => {
    const path = root(), kb = loadKnowledge(path);
    mergeKnowledge(kb, [
      { id: "commands", section: "commands", title: "Commands", body: "npm test" },
      { id: "stack", section: "stack", title: "Stack", body: "TypeScript" },
      { id: "structure", section: "structure", title: "Structure", body: "src/" },
      { id: "conventions", section: "conventions", title: "Conventions", body: "ES modules" },
      { id: "a-stack", section: "stack", title: "Other stack", body: "Node.js" },
    ]);
    const before = readFileSync(join(kb.dir, "index.json"), "utf8");
    const digest = knowledgePrompt(path);
    expect(digest).toContain("# Repository knowledge base");
    for (const text of ["src/", "TypeScript", "ES modules", "npm test"]) expect(digest).toContain(text);
    expect(digest.indexOf("structure:")).toBeLessThan(digest.indexOf("stack:"));
    expect(digest.indexOf("Other stack")).toBeLessThan(digest.indexOf("Stack"));
    expect(digest.indexOf("conventions:")).toBeLessThan(digest.indexOf("commands:"));
    expect(knowledgePrompt(path)).toBe(digest);
    expect(readFileSync(join(kb.dir, "index.json"), "utf8")).toBe(before);
  });

  it("handles absent, empty, corrupt and invalid indexes without creating files", () => {
    const path = root();
    expect(knowledgePrompt(path)).toBe("");
    expect(existsSync(join(path, ".mar"))).toBe(false);
    const kb = loadKnowledge(path);
    expect(knowledgePrompt(path)).toBe("");
    for (const content of ["{bad", '{"version":2}']) {
      writeFileSync(join(kb.dir, "index.json"), content);
      expect(knowledgePrompt(path)).toBe("");
      expect(readFileSync(join(kb.dir, "index.json"), "utf8")).toBe(content);
    }
  });

  it("skips missing, empty and unsafe entry paths", () => {
    const path = root(), kb = loadKnowledge(path);
    mergeKnowledge(kb, ["missing", "empty", "unsafe", "good"].map(id => ({ id, section: "stack" as const, title: id, body: id })));
    unlinkSync(join(kb.dir, "missing.md"));
    writeFileSync(join(kb.dir, "empty.md"), "  \n");
    writeFileSync(join(path, "outside.md"), "outside content");
    kb.index.entries.find(e => e.id === "unsafe")!.file = "../../outside.md";
    writeFileSync(join(kb.dir, "index.json"), JSON.stringify(kb.index));
    const digest = knowledgePrompt(path);
    expect(digest).toContain("good");
    for (const text of ["missing", "empty", "unsafe", "outside content"]) expect(digest).not.toContain(text);
  });

  it("redacts manual content and titles before applying the complete output cap", () => {
    const path = root(), kb = loadKnowledge(path);
    mergeKnowledge(kb, [{ id: "stack", section: "stack", title: "sk-abcdefghijklmnop", body: "initial" }]);
    writeFileSync(join(kb.dir, "stack.md"), "DB_PASSWORD=supersecret\n" + "😀".repeat(5000));
    const full = knowledgePrompt(path, 20000);
    expect(full).toContain("[REDACTED]");
    expect(full).not.toContain("supersecret");
    expect(full).not.toContain("sk-abcdefghijklmnop");
    expect(knowledgePrompt(path, full.length)).toBe(full);
    expect(knowledgePrompt(path).length).toBeLessThanOrEqual(8000);
    for (const cap of [0, -1, 1, 24, 25, 100, 101, 150.9]) {
      expect(knowledgePrompt(path, cap).length).toBeLessThanOrEqual(Math.max(0, Math.floor(cap)));
    }
    expect(knowledgePrompt(path, 150)).toContain("[Knowledge base truncated]");
    for (const cap of [NaN, Infinity, -Infinity]) expect(() => knowledgePrompt(path, cap)).toThrow(RangeError);
  });
});
