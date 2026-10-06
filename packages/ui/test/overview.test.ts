import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@mar/core";
import { deriveAgents, deriveBranchSummary, deriveRunOverview, deriveVerifyResult, matchesGraphFilter, taskDuration, type AgentView } from "../src/derive.js";
import { budgetUsage, fmtDuration } from "../src/fmt.js";
const event = (type: StoredEvent["type"], payload: unknown = {}, task_id: string | null = null, ts = 0): StoredEvent =>
  ({ id: 1, run_id: "r", agent_id: task_id, task_id, type, payload: payload as Record<string, unknown>, ts });
const agent = (status: AgentView["status"], fields: Partial<AgentView> = {}): AgentView =>
  ({ id: "a", status, tokens: null, costUsd: null, unsafe: false, ...fields });

describe("overview and timing", () => {
  it("includes planner usage, ignores cached tokens and malformed usage", () => {
    const events = [event("usage", { input: 10, output: 5, cached: 9, costUsd: 0.1 }, "a"), event("usage", { input: 20, planner: true }), event("usage", { input: -3, output: Infinity, costUsd: NaN }), event("usage", null)];
    expect(deriveRunOverview(events, [], 0, { maxTotalTokens: 30 })).toEqual({ tokens: 35, costUsd: 0.1, maxTotalTokens: 30, remainingTokens: 0, etaMs: 0, limitStopReason: null });
    expect(deriveRunOverview([], [], 0)).toMatchObject({ costUsd: null, maxTotalTokens: null, remainingTokens: null });
  });
  it("estimates known remaining work and subtracts running elapsed time", () => {
    const agents = [agent("done", { startedAt: 0, endedAt: 100 }), agent("done", { startedAt: 0, endedAt: 300 }), agent("running", { startedAt: 100 }), agent("pending"), agent("failed")];
    expect(deriveRunOverview([], agents, 150).etaMs).toBe(350);
    expect(deriveRunOverview([], [agent("pending")], 0).etaMs).toBeNull();
    expect(deriveRunOverview([], agents, 150, { stop: { reason: "max_tokens", message: "Token limit reached" } })).toMatchObject({ etaMs: null, limitStopReason: "Token limit reached" });
    expect(deriveRunOverview([], agents, 150, { stop: { reason: "aborted", message: "Stopped" } }).limitStopReason).toBeNull();
  });
  it("uses latest attempt, clamps skew and never ticks terminal tasks without ends", () => {
    const events = [event("task_started", {}, "a", 0), event("task_failed", {}, "a", 100), event("task_started", {}, "a", 200)];
    const [a] = deriveAgents(events, []);
    expect(taskDuration(a!, 250)).toBe(50);
    expect(taskDuration(a!, 150)).toBe(0);
    expect(taskDuration(agent("failed", { startedAt: 0 }), 250)).toBeNull();
    expect(taskDuration(agent("done", { startedAt: 0, endedAt: 100 }), 250)).toBe(100);
    expect(taskDuration(agent("running", { startedAt: NaN }), 250)).toBeNull();
  });
});

describe("verification and branches", () => {
  it("uses the latest verification and resets on retry", () => {
    const events = [event("verify_started", {}, "a"), event("verify_failed", { ms: 15, code: 1, timedOut: true, command: "test", tail: "error" }, "a")];
    expect(deriveVerifyResult(events, "a")).toEqual({ status: "failed", durationMs: 15, code: 1, timedOut: true, command: "test", tail: "error" });
    expect(deriveVerifyResult(events, "b")).toBeNull();
    expect(deriveVerifyResult([...events, event("task_started", {}, "a")], "a")).toBeNull();
    expect(deriveVerifyResult([...events, event("verify_passed", { ms: 20 }, "a")], "a")).toMatchObject({ status: "passed", code: null, tail: "" });
    expect(deriveVerifyResult([event("verify_started", null, "a")], "a")).toMatchObject({ status: "running", durationMs: null });
  });
  it("keeps latest outcomes separately per repo, including errors and conflicts", () => {
    const events = [event("integration", { repo: "api", branch: "old", merged: ["a"] }), event("integration", { repo: "web", branch: "web-result", merged: ["b", 3], conflict: { branch: "c", files: ["x", null] }, verify: { ok: false } }), event("integration", { repo: "api", error: "failed" })];
    const before = JSON.stringify(events);
    expect(deriveBranchSummary(events)).toEqual([
      { repo: "api", branch: null, merged: [], conflict: null, verify: null, error: "failed" },
      { repo: "web", branch: "web-result", merged: ["b"], conflict: { branch: "c", files: ["x"] }, verify: "failed", error: null },
    ]);
    expect(JSON.stringify(events)).toBe(before);
    expect(deriveBranchSummary([event("integration", { branch: "result", verify: { ok: true } })])[0]).toMatchObject({ repo: null, verify: "passed" });
  });
});

it("intersects graph filters with default phase one and exact repo matching", () => {
  const a = agent("running", { repo: "api" });
  expect(matchesGraphFilter(a)).toBe(true);
  expect(matchesGraphFilter(a, { runningFailedOnly: true, phase: 1, repo: "api" })).toBe(true);
  expect(matchesGraphFilter(a, { phase: 2 })).toBe(false);
  expect(matchesGraphFilter(a, { repo: "*" })).toBe(false);
  for (const status of ["pending", "done", "blocked"] as const) expect(matchesGraphFilter(agent(status), { runningFailedOnly: true })).toBe(false);
  expect(matchesGraphFilter(agent("failed"), { runningFailedOnly: true })).toBe(true);
});

it("formats unknown durations and validates budgets without hiding small overruns", () => {
  for (const ms of [null, undefined, NaN, Infinity]) expect(fmtDuration(ms)).toBe("n/a");
  expect(fmtDuration(-1)).toBe("0s");
  expect(fmtDuration(61_000)).toBe("1m 1s");
  expect(fmtDuration(3_660_000)).toBe("1h 1m");
  for (const budget of [0, -1, NaN, Infinity, undefined]) expect(budgetUsage(1, budget)).toBeNull();
  expect(budgetUsage(1001, 1000)).toEqual({ pct: 100, over: true });
});
