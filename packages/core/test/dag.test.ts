import { describe, it, expect } from "vitest";
import { parseDag } from "../src/index.js";

const t = (id: string, extra: object = {}) => ({
  id, role: "implementer", runtime: "claude", tier: "mid", goal: "g", ...extra,
});

describe("parseDag", () => {
  it("accepts a valid DAG and defaults dependsOn/needs", () => {
    const dag = parseDag({ tasks: [t("a"), t("b", { dependsOn: ["a"], needs: ["a/summary"] })] });
    expect(dag.tasks[0].dependsOn).toEqual([]);
    expect(dag.tasks[1].needs).toEqual(["a/summary"]);
  });
  it("rejects cycles", () => {
    expect(() => parseDag({ tasks: [t("a", { dependsOn: ["b"] }), t("b", { dependsOn: ["a"] })] })).toThrow(/cycle/i);
  });
  it("rejects unknown dependency", () => {
    expect(() => parseDag({ tasks: [t("a", { dependsOn: ["zzz"] })] })).toThrow(/zzz/);
  });
  it("rejects duplicate ids", () => {
    expect(() => parseDag({ tasks: [t("a"), t("a")] })).toThrow(/duplicate/i);
  });
  it("rejects needs that reference a non-ancestor", () => {
    expect(() => parseDag({ tasks: [t("a"), t("b", { needs: ["a/summary"] })] })).toThrow(/non-ancestor|ancestor/i);
  });
  it("rejects unknown runtime", () => {
    expect(() => parseDag({ tasks: [t("a", { runtime: "gpt" })] })).toThrow();
  });
  it("rejects needs keys with an unknown suffix, naming task and key", () => {
    expect(() => parseDag({ tasks: [t("a"), t("b", { dependsOn: ["a"], needs: ["a/diff"] })] })).toThrow(/task b.*a\/diff/);
    expect(() => parseDag({ tasks: [t("a"), t("b", { dependsOn: ["a"], needs: ["a"] })] })).toThrow(/task b.*"a"/);
  });
  it("accepts every known needs suffix", () => {
    const needs = ["summary", "decisions", "open_questions", "files"].map((s) => `a/${s}`);
    expect(parseDag({ tasks: [t("a"), t("b", { dependsOn: ["a"], needs })] }).tasks[1].needs).toEqual(needs);
  });
});
