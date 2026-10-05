import { describe, it, expect } from "vitest";
import { TaskResultSchema, estimateTokens, MAX_BB_BODY_CHARS } from "../src/index.js";

describe("core", () => {
  it("estimates tokens as ceil(chars/4)", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
  it("caps blackboard body size constant at 1200 chars", () => {
    expect(MAX_BB_BODY_CHARS).toBe(1200);
  });
  it("TaskResult requires summary and defaults lists", () => {
    const r = TaskResultSchema.parse({ summary: "done" });
    expect(r.filesChanged).toEqual([]);
    expect(() => TaskResultSchema.parse({})).toThrow();
  });
});
