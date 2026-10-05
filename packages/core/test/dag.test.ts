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

describe("parseDag path ownership", () => {
  const w = (id: string, paths?: string[], extra: object = {}) => t(id, { ...(paths ? { paths } : {}), ...extra });
  it("defaults paths to []", () => {
    expect(parseDag({ tasks: [t("a")] }).tasks[0].paths).toEqual([]);
  });
  it("accepts parallel writers with disjoint paths", () => {
    expect(() => parseDag({ tasks: [w("a", ["src/a/**"]), w("b", ["src/b/**"])] })).not.toThrow();
    expect(() => parseDag({ tasks: [w("a", ["src/a/*"]), w("b", ["src/b/*"])] })).not.toThrow();
    expect(() => parseDag({ tasks: [w("a", ["*.md"]), w("b", ["docs/*.md"])] })).not.toThrow();
  });
  it("rejects parallel writers with overlapping paths, naming both tasks and patterns", () => {
    expect(() => parseDag({ tasks: [w("a", ["src/**"]), w("b", ["src/x.ts"])] })).toThrow(/a.*b.*src\/\*\*.*src\/x\.ts/s);
  });
  it("rejects parallel writers when one has no paths", () => {
    expect(() => parseDag({ tasks: [w("a", ["src/a/**"]), w("b")] })).toThrow(/b declares no paths/);
    expect(() => parseDag({ tasks: [w("a"), w("b")] })).toThrow(/paths/);
  });
  it("accepts serialised writers without paths, also transitively", () => {
    expect(() => parseDag({ tasks: [w("a"), w("b", undefined, { dependsOn: ["a"] })] })).not.toThrow();
    expect(() => parseDag({ tasks: [w("a"), w("b", undefined, { dependsOn: ["a"] }), w("c", undefined, { dependsOn: ["b"] })] })).not.toThrow();
  });
  it("accepts overlapping paths when the writers are ordered", () => {
    expect(() => parseDag({ tasks: [w("a", ["src/**"]), w("b", ["src/**"], { dependsOn: ["a"] })] })).not.toThrow();
  });
  it("exempts non-writers", () => {
    expect(() => parseDag({ tasks: [w("a"), t("r", { role: "reviewer" }), t("s", { role: "researcher", paths: ["src/**"] })] })).not.toThrow();
  });
  it("rejects bad path forms naming the task", () => {
    for (const bad of ["/abs/x", "../x", "a/../b", "", "a\\b", ".mar/x", ".git/config", ".git", "C:/x"])
      expect(() => parseDag({ tasks: [w("a", [bad])] }), bad).toThrow(/task a.*path/s);
  });
});
