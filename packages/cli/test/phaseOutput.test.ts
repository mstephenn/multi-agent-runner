import { describe, it, expect } from "vitest";
import { ownershipRows, renderOwnershipWarnings, renderPhaseHeader, renderPhaseSummary, renderPlanTable, renderStop } from "../src/phaseOutput.js";

const t = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "codex", tier: "mid", goal: "do the thing", dependsOn: [], needs: [], paths: [], ...extra }) as never;

describe("renderPhaseHeader", () => {
  it("prints == Phase N (max M) ==", () => { expect(renderPhaseHeader(2, 5)).toBe("== Phase 2 (max 5) =="); });
});

describe("renderPlanTable", () => {
  const shared = (task: { id: string }) => task.id === "q";
  it("has a header row and one aligned row per task with the documented columns", () => {
    const out = renderPlanTable([
      t("p1-api", { paths: ["src/api/**"], goal: "Build the API" }),
      t("q", { role: "researcher", runtime: "claude", tier: "low", dependsOn: ["p1-api"], goal: "Explain" }),
    ], shared);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^id +role +runtime\/tier +depends +paths +worktree +goal$/);
    expect(lines[1]).toMatch(/^p1-api +implementer +codex\/mid +- +src\/api\/\*\* +own +Build the API$/);
    expect(lines[2]).toMatch(/^q +researcher +claude\/low +p1-api +- +shared +Explain$/);
    // columns line up
    expect(lines[1].indexOf("codex/mid")).toBe(lines[0].indexOf("runtime/tier"));
    expect(lines[2].indexOf("claude/low")).toBe(lines[0].indexOf("runtime/tier"));
  });
  it("clips the goal to 70 chars with an ellipsis and flattens newlines", () => {
    const out = renderPlanTable([t("a", { goal: "x".repeat(200) }), t("b", { goal: "line1\nline2" })], () => false);
    const [, a, b] = out.split("\n");
    expect(a.endsWith("x".repeat(69) + "…")).toBe(true);
    expect(a.trimEnd().match(/(x+…)$/)![1].length).toBe(70);
    expect(b.endsWith("line1 line2")).toBe(true);
  });
  it("joins several dependencies and paths with commas", () => {
    const out = renderPlanTable([t("a", { dependsOn: ["x", "y"], paths: ["a/**", "b/*.ts"] })], () => false);
    expect(out).toContain("x,y");
    expect(out).toContain("a/**,b/*.ts");
  });
  it("redacts secrets in goals", () => {
    expect(renderPlanTable([t("a", { goal: "use API_KEY=hunter2xyz" })], () => false)).not.toContain("hunter2xyz");
  });
});

describe("renderPhaseSummary", () => {
  const rows = [
    { id: "a", status: "done", branch: "mar/r1/a" },
    { id: "b", status: "failed", detail: "failed:budget", branch: "mar/r1/b" },
    { id: "q", status: "done", branch: "(shared read-only worktree, no branch)" },
  ];
  it("prints a -- Phase N -- header and the existing `id  status  (why)  branch` lines", () => {
    expect(renderPhaseSummary(2, rows)).toBe([
      "-- Phase 2 --",
      "  a  done  mar/r1/a",
      "  b  failed  (failed:budget)  mar/r1/b",
      "  q  done  (shared read-only worktree, no branch)",
    ].join("\n"));
  });
  it("omits the header for a single-phase run (null)", () => {
    expect(renderPhaseSummary(null, rows).split("\n")[0]).toBe("  a  done  mar/r1/a");
  });
  it("shows the why only for failed tasks", () => {
    expect(renderPhaseSummary(null, [{ id: "a", status: "done", detail: "ignored", branch: "x" }])).toBe("  a  done  x");
  });
});

describe("renderStop", () => {
  it("max_phases: why, remaining text and the resume hint with a higher --phases", () => {
    const out = renderStop({ reason: "max_phases", message: "reached the limit of 5 phases" }, "wire the UI and docs", "r1", 5);
    expect(out).toContain("Stopped early: reached the limit of 5 phases");
    expect(out).toContain("Remaining: wire the UI and docs");
    expect(out).toContain("mar resume r1 --phases 8");
  });
  it("caps the suggested --phases at 10 and says so when already at the maximum", () => {
    expect(renderStop({ reason: "max_phases", message: "m" }, "r", "r1", 9)).toContain("--phases 10");
    const at10 = renderStop({ reason: "max_phases", message: "m" }, "r", "r1", 10);
    expect(at10).not.toContain("--phases 13");
    expect(at10).toMatch(/new run|maximum/i);
  });
  it("other reasons explain how to continue", () => {
    expect(renderStop({ reason: "max_tokens", message: "m" }, "r", "r1", 5)).toMatch(/maxTotalTokens.*mar resume r1/s);
    expect(renderStop({ reason: "no_progress", message: "m" }, "r", "r1", 5)).toContain("mar resume r1");
    expect(renderStop({ reason: "aborted", message: "m" }, "r", "r1", 5)).toContain("mar resume r1");
    expect(renderStop({ reason: "replan_failed", message: "m" }, "r", "r1", 5)).toContain("mar resume r1");
  });
  it("omits the Remaining line when nothing remains and redacts", () => {
    expect(renderStop({ reason: "aborted", message: "m" }, "", "r1", 5)).not.toContain("Remaining:");
    expect(renderStop({ reason: "aborted", message: "m" }, "API_KEY=hunter2xyz", "r1", 5)).not.toContain("hunter2xyz");
  });
});

describe("terminal safety", () => {
  const evil = "x\x1b[2Jy\x1b]0;t\x07z";
  it("renderPhaseSummary and renderStop strip escapes", async () => {
    const { renderPhaseSummary, renderStop } = await import("../src/phaseOutput.js");
    expect(renderPhaseSummary(null, [{ id: "a", status: "failed", detail: evil, branch: "b" }])).toBe("  a  failed  (xyz)  b");
    expect(renderStop({ reason: "aborted", message: evil }, evil, "r1", 3)).toContain("Stopped early: xyz.\nRemaining: xyz");
  });
});

describe("workspace output", () => {
  it("renderPlanTable adds a repo column (* for whole-workspace read-only tasks)", () => {
    const out = renderPlanTable([
      t("p1-api", { repo: "api", goal: "Build" }),
      t("p1-web", { repo: "web", dependsOn: ["p1-api"], goal: "Client" }),
      t("q", { role: "researcher", goal: "Look" }),
    ], (x: { id: string }) => x.id === "q", { workspace: true });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^id +role +repo +runtime\/tier +depends +paths +worktree +goal$/);
    expect(lines[1]).toMatch(/^p1-api +implementer +api +codex\/mid/);
    expect(lines[2]).toMatch(/^p1-web +implementer +web +/);
    expect(lines[3]).toMatch(/^q +researcher +\* +/);
  });
  it("renderPlanTable is unchanged without the workspace option", () => {
    expect(renderPlanTable([t("a")], () => false).split("\n")[0]).toMatch(/^id +role +runtime\/tier/);
  });
});

describe("recovery_stalled and ownership warnings", () => {
  it("renderStop explains recovery_stalled and how to continue", () => {
    const out = renderStop({ reason: "recovery_stalled", message: "recovery phase 2 finished no task" }, "", "r1", 5);
    expect(out).toContain("Stopped early: recovery phase 2 finished no task");
    expect(out).toMatch(/by hand.*mar resume r1/s);
  });
  const ev = (task_id: string | null, payload: Record<string, unknown>) => ({ task_id, payload });
  it("ownershipRows keeps the latest warn-mode event per task and skips enforced ones", () => {
    expect(ownershipRows([
      ev("a", { files: ["x"], count: 1, enforced: false }), ev("a", { files: ["x", "y"], count: 2, enforced: false }),
      ev("b", { files: ["z"], count: 1, enforced: true }), ev(null, { files: ["q"], enforced: false }),
    ])).toEqual([{ task: "a", files: ["x", "y"], count: 2 }]);
  });
  it("renders task -> files, with +N more per task and at most 10 task lines", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ task: `t${i}`, files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"], count: 9 }));
    const out = renderOwnershipWarnings(rows).split("\n");
    expect(out[0]).toMatch(/^Ownership warnings/);
    expect(out[1]).toBe("  t0 -> a.ts, b.ts, c.ts, d.ts, e.ts (+4 more)");
    expect(out).toHaveLength(1 + 10 + 1);
    expect(out.at(-1)).toBe("  ...and 2 more tasks");
  });
  it("is empty without warnings and strips terminal escapes", () => {
    expect(renderOwnershipWarnings([])).toBe("");
    expect(renderOwnershipWarnings([{ task: "a", files: ["x\x1b[2Jy"], count: 1 }])).not.toContain("\x1b");
  });
});
