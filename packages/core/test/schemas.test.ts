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
  it("TaskResult accepts an optional long report up to 100k chars", () => {
    expect(TaskResultSchema.parse({ summary: "s" }).report).toBeUndefined();
    expect(TaskResultSchema.parse({ summary: "s", report: "x".repeat(100_000) }).report).toHaveLength(100_000);
    expect(() => TaskResultSchema.parse({ summary: "s", report: "x".repeat(100_001) })).toThrow();
  });
});

describe("phase events", () => {
  it("EventTypes includes phase_started and phase_finished", async () => {
    const { EventTypes } = await import("../src/index.js");
    expect(EventTypes).toContain("phase_started");
    expect(EventTypes).toContain("phase_finished");
  });
});
