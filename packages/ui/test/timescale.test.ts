import { describe, it, expect } from "vitest";
import { niceTicks, fmtOffset, xOf, tsOf, laneSegments, laneMarkers, groupLaneSegments, segmentTip } from "../src/timescale.js";

let id = 0;
const e = (task: string | null, type: string, ts: number, payload: object = {}) => ({ id: ++id, run_id: "r", task_id: task, agent_id: task, ts, type, payload }) as any;
const S = 1000, M = 60 * S, H = 60 * M;

describe("niceTicks", () => {
  it("picks a human step so a 3s span has 1s ticks", () => {
    expect(niceTicks(3 * S, 8)).toEqual({ stepMs: S, ticks: [0, S, 2 * S, 3 * S] });
  });
  it("47s -> 10s steps, first tick 0, last <= span", () => {
    const t = niceTicks(47 * S, 8);
    expect(t.stepMs).toBe(10 * S);
    expect(t.ticks).toEqual([0, 10 * S, 20 * S, 30 * S, 40 * S]);
  });
  it("4m -> 1m steps; 3h -> 30m steps", () => {
    expect(niceTicks(4 * M, 8).stepMs).toBe(M);
    const h = niceTicks(3 * H, 8);
    expect(h.stepMs).toBe(30 * M);
    expect(h.ticks.at(-1)).toBe(3 * H);
  });
  it("keeps tick counts in a readable range and respects maxTicks", () => {
    for (const span of [S, 7 * S, 59 * S, 2 * M, 13 * M, 90 * M, 5 * H, 30 * H, 400 * H]) {
      for (const max of [3, 5, 8]) {
        const { ticks, stepMs } = niceTicks(span, max);
        expect(ticks.length).toBeLessThanOrEqual(max);
        expect(ticks[0]).toBe(0);
        expect(ticks.at(-1)!).toBeLessThanOrEqual(span);
        expect(stepMs).toBeGreaterThan(0);
      }
    }
  });
  it("is total for zero, negative, NaN and tiny maxTicks", () => {
    expect(niceTicks(0, 8)).toEqual({ stepMs: S, ticks: [0] });
    expect(niceTicks(-5 * S, 8)).toEqual({ stepMs: S, ticks: [0] });
    expect(niceTicks(NaN, 8).ticks).toEqual([0]);
    expect(niceTicks(Infinity, 8).ticks).toEqual([0]);
    expect(niceTicks(10 * S, 0).ticks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("fmtOffset", () => {
  it("formats compact human offsets", () => {
    expect(fmtOffset(0)).toBe("0s");
    expect(fmtOffset(45 * S)).toBe("45s");
    expect(fmtOffset(30 * S)).toBe("30s");
    expect(fmtOffset(65 * S)).toBe("1m 05s");
    expect(fmtOffset(90 * S)).toBe("1m 30s");
    expect(fmtOffset(2 * M)).toBe("2m");
    expect(fmtOffset(H + 2 * M)).toBe("1h 02m");
    expect(fmtOffset(H)).toBe("1h");
  });
  it("floors sub-second values and never prints NaN or negatives", () => {
    expect(fmtOffset(999)).toBe("0s");
    expect(fmtOffset(-5000)).toBe("0s");
    expect(fmtOffset(NaN)).toBe("0s");
    expect(fmtOffset(Infinity)).toBe("0s");
  });
});

describe("xOf / tsOf", () => {
  it("maps and clamps", () => {
    expect(xOf(150, 100, 200)).toBe(0.5);
    expect(xOf(50, 100, 200)).toBe(0);
    expect(xOf(900, 100, 200)).toBe(1);
    expect(tsOf(0.5, 100, 200)).toBe(150);
    expect(tsOf(-1, 100, 200)).toBe(100);
    expect(tsOf(2, 100, 200)).toBe(200);
  });
  it("never yields NaN or Infinity for empty/inverted/non-finite ranges", () => {
    for (const [a, b] of [[100, 100], [200, 100], [NaN, 5], [0, NaN]] as const) {
      expect(Number.isFinite(xOf(150, a, b))).toBe(true);
      expect(Number.isFinite(tsOf(0.5, a, b))).toBe(true);
    }
    expect(xOf(NaN, 0, 10)).toBe(0);
    expect(tsOf(NaN, 0, 10)).toBe(0);
  });
});

describe("laneSegments", () => {
  it("returns one done segment for a finished task and ignores other tasks", () => {
    const evs = [e("a", "task_started", 100), e("b", "task_started", 120), e("a", "task_finished", 200)];
    expect(laneSegments(evs, "a", 500)).toEqual([{ start: 100, end: 200, status: "done", attempt: 1 }]);
  });
  it("a start after a terminal event begins a new attempt (retry)", () => {
    const evs = [e("a", "task_started", 100), e("a", "task_failed", 200), e("a", "task_started", 300), e("a", "task_finished", 400)];
    expect(laneSegments(evs, "a", 500)).toEqual([
      { start: 100, end: 200, status: "failed", attempt: 1 },
      { start: 300, end: 400, status: "done", attempt: 2 },
    ]);
  });
  it("a resumed task has an open running segment after a finished one", () => {
    const evs = [e("a", "task_started", 100), e("a", "task_finished", 200), e("a", "task_started", 300)];
    const s = laneSegments(evs, "a", 500);
    expect(s[1]).toEqual({ start: 300, end: null, status: "running", attempt: 2 });
    expect(laneSegments(evs, "a", 500, "blocked")[1]!.status).toBe("blocked");
  });
  it("clamps ends to now and skips tasks that never started or lack timestamps", () => {
    expect(laneSegments([e("a", "task_started", 100), e("a", "task_finished", 900)], "a", 400)[0]).toMatchObject({ start: 100, end: 400 });
    expect(laneSegments([e("b", "task_failed", 5)], "b", 10)).toEqual([]);
    expect(laneSegments([e("a", "task_started", NaN as any)], "a", 10)).toEqual([]);
  });
  it("groups every task in one pass, in first-start order", () => {
    const evs = [e("b", "task_started", 100), e("a", "task_started", 150), e("b", "task_failed", 160)];
    const g = groupLaneSegments(evs, 500, () => "running");
    expect([...g.keys()]).toEqual(["b", "a"]);
    expect(g.get("a")![0]!.status).toBe("running");
  });
  it("does not mutate its input and is fast on large input", () => {
    const evs = Array.from({ length: 20000 }, (_, i) => e(`t${i % 20}`, i % 7 === 0 ? "task_started" : "assistant_text", i));
    const snap = JSON.stringify(evs);
    const t0 = performance.now();
    groupLaneSegments(evs, 1e6, () => "running"); laneMarkers(evs, "t3");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(JSON.stringify(evs)).toBe(snap);
  });
});

describe("laneMarkers", () => {
  it("lists start/finish/fail/write/read markers for one task in event order", () => {
    const evs = [
      e("a", "task_started", 100), e("b", "blackboard_write", 110), e("a", "blackboard_read", 120, { key: "x" }),
      e("a", "blackboard_write", 130), e("a", "task_failed", 140), e("a", "task_started", 150), e("a", "task_finished", 160), e("a", "usage", 165),
    ];
    expect(laneMarkers(evs, "a")).toEqual([
      { ts: 100, kind: "start" }, { ts: 120, kind: "read" }, { ts: 130, kind: "write" }, { ts: 140, kind: "fail" }, { ts: 150, kind: "start" }, { ts: 160, kind: "finish" },
    ]);
  });
  it("tolerates odd payloads and bad timestamps", () => {
    const evs = [e("a", "blackboard_read", 5, null as any), e("a", "blackboard_write", "x" as any), e(null, "task_started", 3)];
    expect(laneMarkers(evs, "a")).toEqual([{ ts: 5, kind: "read" }]);
  });
});

describe("segmentTip", () => {
  it("describes a finished bar with status, start, end and duration", () => {
    const seg = { start: 1000, end: 73000, status: "done" as const, attempt: 1 };
    expect(segmentTip("investigate_sow_sprint_plan", seg, 1, 1000, 99999)).toBe("investigate_sow_sprint_plan · done · started +0s · ended +1m 12s · took 1m 12s");
  });
  it("describes running bars, retries and blackboard activity", () => {
    const seg = { start: 0, end: null, status: "running" as const, attempt: 2 };
    const tip = segmentTip("a", seg, 2, 0, 5000, [{ ts: 10, kind: "write" }, { ts: 20, kind: "read" }, { ts: 30, kind: "read" }, { ts: 9000, kind: "read" }]);
    expect(tip).toBe("a · running · started +0s · running for 5s · attempt 2 of 2 · 1 write · 2 reads");
    expect(segmentTip("a", { start: 0, end: 20, status: "failed", attempt: 1 }, 1, 0, 5000)).toContain("took <1s");
  });
});
