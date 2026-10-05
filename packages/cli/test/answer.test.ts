import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDag } from "@mar/core";
import { renderAnswer, reportPath, saveReports, finalTasks } from "../src/answer.js";

const T = (id: string, dependsOn: string[] = []) => ({ id, role: "researcher", runtime: "claude", tier: "mid", goal: id, dependsOn });
const st = (o: Record<string, string | [string, string]>) =>
  new Map(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? { status: v[0], detail: v[1] } : { status: v }]));
const m = (o: Record<string, string> = {}) => new Map(Object.entries(o));

describe("renderAnswer", () => {
  it("finds leaves of the DAG", () => {
    expect(finalTasks(parseDag({ tasks: [T("a"), T("b", ["a"]), T("c")] })).map((t) => t.id)).toEqual(["b", "c"]);
  });
  it("prints a 5,000-char report in full", () => {
    const body = "line\n".repeat(1000);
    const out = renderAnswer(parseDag({ tasks: [T("a")] }), st({ a: "done" }), m({ a: body }), m({ a: "short" }));
    expect(out).toContain("== Answer: a ==\n" + body);
    expect(out).not.toContain("short");
    expect(out.length).toBeGreaterThanOrEqual(5000);
  });
  it("prints two leaves as two headed sections in plan order", () => {
    const out = renderAnswer(parseDag({ tasks: [T("root"), T("z", ["root"]), T("a", ["root"])] }), st({ root: "done", z: "done", a: "done" }), m({ z: "ZZ", a: "AA", root: "RR" }), m());
    expect(out.indexOf("== Answer: z ==")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("== Answer: z ==")).toBeLessThan(out.indexOf("== Answer: a =="));
    expect(out).not.toContain("RR");
  });
  it("falls back to the summary when a leaf has no report", () => {
    const out = renderAnswer(parseDag({ tasks: [T("a")] }), st({ a: "done" }), m(), m({ a: "did things" }));
    expect(out).toContain("== Answer: a == (summary only)\ndid things");
  });
  it("shows status and reason for a failed leaf plus partial results of done tasks", () => {
    const dag = parseDag({ tasks: [T("scan"), T("write", ["scan"]), T("side")] });
    const out = renderAnswer(dag, st({ scan: "done", write: ["failed", "failed:timeout"], side: "done" }), m({ scan: "SCAN BODY", side: "SIDE BODY" }), m());
    expect(out).toContain("== write: failed (failed:timeout) ==");
    expect(out).toContain("== Partial results ==");
    expect(out).toContain("== scan ==\nSCAN BODY");
    expect(out).toContain("== Answer: side ==\nSIDE BODY");
    expect(out.match(/SIDE BODY/g)).toHaveLength(1);
  });
  it("shows blocked leaf without parentheses", () => {
    expect(renderAnswer(parseDag({ tasks: [T("a"), T("b", ["a"])] }), st({ a: "failed", b: "blocked" }), m(), m())).toBe("== b: blocked ==\n");
  });
  it("prints nothing when there is neither a report nor a summary", () => {
    expect(renderAnswer(parseDag({ tasks: [T("a")] }), st({ a: "done" }), m(), m())).toBe("");
    expect(renderAnswer(undefined, st({}), m(), m())).toBe("");
  });
});

describe("report files", () => {
  it("writes under .mar/reports/<runId>/<taskId>.md", () => {
    const repo = mkdtempSync(join(tmpdir(), "mar-rep-"));
    const { saved, errors } = saveReports(repo, "r1", [{ task_id: "a", body: "BODY" }]);
    expect(errors).toEqual([]);
    expect(saved).toEqual([join(repo, ".mar", "reports", "r1", "a.md")]);
    expect(readFileSync(saved[0]!, "utf8")).toBe("BODY");
  });
  it("never escapes .mar/reports", () => {
    const repo = mkdtempSync(join(tmpdir(), "mar-rep-"));
    expect(() => reportPath(repo, "r1", "../x")).toThrow(/outside/);
    expect(() => reportPath(repo, "../..", "x")).toThrow(/outside/);
    const { saved, errors } = saveReports(repo, "r1", [{ task_id: "../../../evil", body: "x" }]);
    expect(saved).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(existsSync(join(repo, "evil.md"))).toBe(false);
  });
});
