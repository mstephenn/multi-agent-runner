import { describe, it, expect } from "vitest";
import { formatDate, formatTokens, listJson, relativeTime, renderRunTable, resolveRunId, summarizeRun, type ListRow, type SummarizeInput } from "../src/history.js";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const st = (o: Record<string, string | [string, string]>) =>
  new Map(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? { status: v[0], detail: v[1] } : { status: v, detail: null as string | null }]));
const input = (o: Partial<SummarizeInput> & { statuses?: SummarizeInput["statuses"] }): SummarizeInput => ({
  phases: [{ phase: 1, taskIds: ["a", "b"], remaining: "" }], statuses: st({ a: "done", b: "done" }), now: NOW, lastEventTs: NOW - 3_600_000, ...o,
});

describe("summarizeRun status table", () => {
  it("done: every task done, last phase has nothing remaining", () => {
    expect(summarizeRun(input({}))).toMatchObject({ status: "done", phases: 1, tasksDone: 2, tasksTotal: 2, remaining: "" });
    expect(summarizeRun(input({}))).not.toHaveProperty("stopReason");
  });
  it("done across three phases counts all tasks", () => {
    const r = summarizeRun(input({ phases: [{ phase: 1, taskIds: ["a"], remaining: "x" }, { phase: 2, taskIds: ["b"], remaining: "y" }, { phase: 3, taskIds: ["c"], remaining: "" }], statuses: st({ a: "done", b: "done", c: "done" }) }));
    expect(r).toMatchObject({ status: "done", phases: 3, tasksDone: 3, tasksTotal: 3 });
  });
  it("failed: at least one failed task wins over blocked; exposes aborted as stop reason", () => {
    expect(summarizeRun(input({ statuses: st({ a: ["failed", "boom"], b: "blocked" }) })).status).toBe("failed");
    expect(summarizeRun(input({ statuses: st({ a: ["failed", "aborted by user"], b: "blocked" }) })).stopReason).toMatch(/abort/i);
  });
  it("blocked: some blocked, none failed", () => {
    expect(summarizeRun(input({ statuses: st({ a: "done", b: "blocked" }) })).status).toBe("blocked");
  });
  it("incomplete: all done but work remains (limit reached)", () => {
    const r = summarizeRun(input({ phases: [{ phase: 1, taskIds: ["a", "b"], remaining: "wire the UI" }] }));
    expect(r).toMatchObject({ status: "incomplete", remaining: "wire the UI" });
    expect(r.stopReason).toMatch(/limit/i);
  });
  it("incomplete: tasks never started because the run stopped", () => {
    const r = summarizeRun(input({ statuses: st({ a: "done" }) }));
    expect(r.status).toBe("incomplete");
    expect(r.tasksDone).toBe(1);
    expect(r.stopReason).toMatch(/stopped|aborted/i);
  });
  it("planning-failed: no plan and a planner failure event", () => {
    const r = summarizeRun({ phases: [], statuses: new Map(), plannerFailure: "planning failed: Claude: x", now: NOW, lastEventTs: NOW - 1000 });
    expect(r).toMatchObject({ status: "planning-failed", phases: 0, tasksTotal: 0 });
    expect(r.stopReason).toContain("planning failed");
  });
  it("stopped: no plan and no failure, or stale running tasks", () => {
    expect(summarizeRun({ phases: [], statuses: new Map(), now: NOW }).status).toBe("stopped");
    expect(summarizeRun(input({ statuses: st({ a: "done", b: "running" }), lastEventTs: NOW - 10 * 60_000 })).status).toBe("stopped");
  });
  it("running heuristic: newest event < 2 minutes old AND a task is running", () => {
    const base = { statuses: st({ a: "done", b: "running" }) };
    expect(summarizeRun(input({ ...base, lastEventTs: NOW - 119_000 })).status).toBe("running");
    expect(summarizeRun(input({ ...base, lastEventTs: NOW - 121_000 })).status).toBe("stopped");
    expect(summarizeRun(input({ ...base, lastEventTs: undefined })).status).toBe("stopped");
    // fresh events but nothing running is not "running"
    expect(summarizeRun(input({ lastEventTs: NOW - 1000 })).status).toBe("done");
  });
});

describe("formatting", () => {
  it("formats the date in local time as YYYY-MM-DD HH:mm", () => {
    const d = new Date(2026, 0, 5, 7, 4);
    expect(formatDate(d.getTime())).toBe("2026-01-05 07:04");
  });
  it("relative suffix", () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW + 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });
  it("tokens use thousands separators, n/a when unknown", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(null)).toBe("n/a");
  });
});

describe("resolveRunId", () => {
  const ids = ["r1abc", "r1abd", "rzz999", "r1"];
  it("exact id wins even when it is a prefix of others or short", () => { expect(resolveRunId(ids, "r1")).toEqual({ kind: "ok", id: "r1" }); });
  it("unique prefix (>= 3 chars)", () => { expect(resolveRunId(ids, "rzz")).toEqual({ kind: "ok", id: "rzz999" }); });
  it("ambiguous prefix lists matches", () => { expect(resolveRunId(ids, "r1a")).toEqual({ kind: "ambiguous", matches: ["r1abc", "r1abd"] }); });
  it("unknown", () => { expect(resolveRunId(ids, "nope")).toEqual({ kind: "unknown" }); });
  it("prefix shorter than 3 chars is rejected unless exact", () => { expect(resolveRunId(ids, "rz")).toEqual({ kind: "short" }); });
});

const row = (o: Partial<ListRow> = {}): ListRow => ({
  id: "r1abc", goal: "Add a health endpoint\nand tests", created: NOW - 2 * 3_600_000, status: "done", phases: 2, tasksDone: 3, tasksTotal: 4, tokens: 12345, remaining: "", ...o,
});

describe("renderRunTable", () => {
  it("renders header and one aligned row with date, relative suffix, tasks and tokens", () => {
    const lines = renderRunTable([row()], 120, NOW).split("\n");
    expect(lines[0]).toMatch(/^ID\s+DATE\s+STATUS\s+PHASES\s+TASKS\s+TOKENS\s+GOAL$/);
    expect(lines[1]).toMatch(/^r1abc\s+\d{4}-\d\d-\d\d \d\d:\d\d \(2h ago\)\s+done\s+2\s+3\/4\s+12,345\s+Add a health endpoint and tests$/);
    expect(lines).toHaveLength(2);
  });
  it("shows n/a for runs without usage", () => { expect(renderRunTable([row({ tokens: null })], 120, NOW)).toContain("n/a"); });
  it.each([80, 100, 140])("clips the goal to a single line that fits %i columns", (cols) => {
    const long = row({ goal: "word ".repeat(200) });
    const lines = renderRunTable([long, row({ id: "r2", goal: "short" })], cols, NOW).split("\n");
    for (const l of lines.slice(1)) expect(l.length).toBeLessThanOrEqual(cols);
    expect(lines[1]).toMatch(/…$/);
    expect(lines[2]).not.toContain("…");
  });
  it("never produces a goal narrower than 10 chars on a tiny terminal", () => {
    const l = renderRunTable([row({ goal: "x".repeat(100) })], 20, NOW).split("\n")[1]!;
    expect(l).toMatch(/x{9}…$/);
  });
  it("strips terminal escapes from goals", () => {
    expect(renderRunTable([row({ goal: "a\x1b[2Jb\x1b]0;t\x07c" })], 120, NOW)).not.toMatch(/\x1b|\x07/);
  });
});

describe("listJson", () => {
  it("has a stable shape with the full goal, ISO date and null tokens", () => {
    const out = JSON.parse(listJson([row({ goal: "full\ngoal ".repeat(50), tokens: null, remaining: "more" })]));
    expect(Object.keys(out[0])).toEqual(["id", "goal", "created", "status", "phases", "tasksDone", "tasksTotal", "tokens", "remaining", "stopReason", "repos"]);
    expect(out[0].repos).toEqual([]); // [] for single-repo runs
    expect(out[0]).toMatchObject({ id: "r1abc", created: new Date(NOW - 2 * 3_600_000).toISOString(), status: "done", phases: 2, tasksDone: 3, tasksTotal: 4, tokens: null, remaining: "more", stopReason: null });
    expect(out[0].goal.length).toBeGreaterThan(300);
  });
  it("empty list is []", () => { expect(JSON.parse(listJson([]))).toEqual([]); });
});

describe("summarizeRun with recovery phases", () => {
  const g = (id: string, extra: object = {}) => ({ id, goal: `goal ${id}`, paths: [`${id}/**`], ...extra });
  it("a recovery phase that finished everything supersedes the earlier failures: done", () => {
    const r = summarizeRun(input({
      phases: [{ phase: 1, taskIds: ["a", "b"], remaining: "" }, { phase: 2, taskIds: ["c"], remaining: "" }],
      statuses: st({ a: "done", b: ["failed", "dependency p1-x: merge conflict in shared.txt"], c: "done" }),
    }));
    expect(r).toMatchObject({ status: "done", phases: 2, tasksDone: 2, tasksTotal: 3 });
  });
  it("a normal (remaining non-empty) next phase does not hide failures", () => {
    const r = summarizeRun(input({
      phases: [{ phase: 1, taskIds: ["a", "b"], remaining: "more" }, { phase: 2, taskIds: ["c"], remaining: "" }],
      statuses: st({ a: "done", b: "failed", c: "done" }),
    }));
    expect(r.status).toBe("failed");
  });
  it("a recovery phase with no done task reads as failed (recovery_stalled)", () => {
    const r = summarizeRun(input({
      phases: [{ phase: 1, taskIds: ["a", "b"], remaining: "", tasks: [g("a"), g("b")] }, { phase: 2, taskIds: ["c"], remaining: "", tasks: [g("c")] }],
      statuses: st({ a: "done", b: "failed", c: "failed" }),
    }));
    expect(r).toMatchObject({ status: "failed", stopReason: "recovery_stalled" });
  });
  it("the same work failing in two consecutive recovery phases reads as recovery_stalled", () => {
    const r = summarizeRun(input({
      phases: [
        { phase: 1, taskIds: ["a"], remaining: "", tasks: [g("a")] },
        { phase: 2, taskIds: ["b", "c"], remaining: "", tasks: [g("b"), g("c", { goal: "Fix  it" })] },
        { phase: 3, taskIds: ["d", "e"], remaining: "", tasks: [g("d"), g("e", { goal: "fix it" })] },
      ],
      statuses: st({ a: "failed", b: "done", c: "failed", d: "done", e: "failed" }),
    }));
    expect(r).toMatchObject({ status: "failed", stopReason: "recovery_stalled" });
  });
});
