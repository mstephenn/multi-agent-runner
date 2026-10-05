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
  it("keeps goals with quotes/unicode/newlines verbatim", () => {
    const g = 'Fix "naïve" bug\nin `x y/z`';
    expect(buildPrompt({ ...t, goal: g }, [])).toContain(g);
  });
});
