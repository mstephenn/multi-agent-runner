import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/index.js";
const t = { id: "b", role: "reviewer", runtime: "claude", tier: "mid", goal: "Review the diff", dependsOn: [], needs: [] } as any;

describe("buildPrompt", () => {
  it("omits context section when there are no slices", () => {
    expect(buildPrompt(t, [])).not.toContain("Context from earlier tasks");
  });
  it("includes only given slices and the output contract", () => {
    const p = buildPrompt(t, [{ key: "a/summary", version: 1, body: "added foo()", tokens: 3 }]);
    expect(p).toContain("a/summary");
    expect(p).toContain("added foo()");
    expect(p).toContain("Review the diff");
    expect(p).toMatch(/summary.*filesChanged.*decisions.*openQuestions/s);
  });
  it("documents the optional report field and when to use it", () => {
    const p = buildPrompt(t, []);
    expect(p).toContain('"report"?: string');
    expect(p).toContain("COMPLETE answer in `report` as markdown");
    expect(p).toContain("Do not put code diffs or file contents in `report`");
    expect(p).toContain("<=900 chars");
  });
  it("keeps goals with quotes/unicode/newlines verbatim", () => {
    const g = 'Fix "naïve" bug\nin `x y/z`';
    expect(buildPrompt({ ...t, goal: g }, [])).toContain(g);
  });
  it("workspace writer note keeps the read-only text and adds the sibling contract-only rule; the shared view does not", () => {
    const w = buildPrompt(t, [], { repo: "web", siblings: ["api"] });
    expect(w).toContain("READ-ONLY at `../api` \u2014 read them for contracts; do not modify them.");
    expect(w).toContain("Sibling repos reflect the finished work of the tasks you depend on.");
    expect(w).toContain("do NOT import or require files from a sibling repo");
    expect(buildPrompt(t, [], { all: ["api", "web"] })).not.toContain("Sibling repos reflect");
    expect(buildPrompt(t, [], { repo: "web", siblings: [] })).not.toContain("Sibling repos reflect");
    expect(buildPrompt(t, [])).not.toContain("Sibling repos reflect");
  });
});
