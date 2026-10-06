import { describe, it, expect } from "vitest";
import { parseDag, EventTypes } from "../src/index.js";

const t = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: "g", ...extra });
const R = (id: string, extra: object = {}) => t(id, { role: "researcher", ...extra });
const repos = ["api", "web"];

describe("parseDag with workspace repos", () => {
  it("requires writers to set repo when there are 2+ repos", () => {
    expect(() => parseDag({ tasks: [t("a")] }, { repos })).toThrow(/task a.*repo/);
  });
  it("rejects an unknown repo naming task and repo", () => {
    expect(() => parseDag({ tasks: [t("a", { repo: "nope" })] }, { repos })).toThrow(/task a.*"nope"|task a.*nope/);
    expect(() => parseDag({ tasks: [R("r", { repo: "nope" })] }, { repos })).toThrow(/task r.*nope/);
  });
  it("read-only tasks may omit repo or name one", () => {
    const dag = parseDag({ tasks: [R("r1"), R("r2", { repo: "web" })] }, { repos });
    expect(dag.tasks[0].repo).toBeUndefined();
    expect(dag.tasks[1].repo).toBe("web");
  });
  it("a reviewer that depends on a writer must name its repo", () => {
    expect(() => parseDag({ tasks: [t("a", { repo: "api" }), R("r", { dependsOn: ["a"] })] }, { repos })).toThrow(/task r.*repo/);
    expect(parseDag({ tasks: [t("a", { repo: "api" }), R("r", { dependsOn: ["a"], repo: "api" })] }, { repos }).tasks).toHaveLength(2);
  });
  it("with exactly one repo, repo is optional and defaults for writers", () => {
    const dag = parseDag({ tasks: [t("a"), R("r")] }, { repos: ["only"] });
    expect(dag.tasks[0].repo).toBe("only");
    expect(dag.tasks[1].repo).toBeUndefined();
  });
  it("allows parallel writers in different repos with identical paths", () => {
    const dag = parseDag({ tasks: [t("a", { repo: "api", paths: ["src/**"] }), t("b", { repo: "web", paths: ["src/**"] })] }, { repos });
    expect(dag.tasks).toHaveLength(2);
  });
  it("allows parallel writers in different repos without paths", () => {
    expect(() => parseDag({ tasks: [t("a", { repo: "api" }), t("b", { repo: "web" })] }, { repos })).not.toThrow();
  });
  it("rejects overlapping paths and missing paths between parallel writers of the SAME repo", () => {
    expect(() => parseDag({ tasks: [t("a", { repo: "api", paths: ["src/**"] }), t("b", { repo: "api", paths: ["src/x.ts"] })] }, { repos })).toThrow(/overlap/);
    expect(() => parseDag({ tasks: [t("a", { repo: "api" }), t("b", { repo: "api", paths: ["x"] })] }, { repos })).toThrow(/no paths/);
  });
  it("dependsOn may cross repos", () => {
    const dag = parseDag({ tasks: [t("a", { repo: "api" }), t("b", { repo: "web", dependsOn: ["a"], needs: ["a/summary"] })] }, { repos });
    expect(dag.tasks[1].dependsOn).toEqual(["a"]);
  });
  it("rejects a malformed repo name in the schema", () => {
    expect(() => parseDag({ tasks: [t("a", { repo: "../x" })] })).toThrow();
  });
  it("without repos option nothing changes (repo is accepted but not validated)", () => {
    expect(parseDag({ tasks: [t("a", { repo: "x" })] }).tasks[0].repo).toBe("x");
  });
  it("EventTypes include run_started and sibling_modified", () => {
    expect(EventTypes).toContain("run_started");
    expect(EventTypes).toContain("sibling_modified");
  });
});
