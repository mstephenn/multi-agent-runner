// Pure time-axis helpers for the timeline panel (no React, no DOM). Everything is total: odd input never throws or yields NaN.
import type { StoredEvent } from "@mar/core";
import { deriveSegments, type AgentStatus } from "./derive.js";

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
// Human-friendly tick steps (ms).
const STEPS = [S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S, M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, H, 2 * H, 3 * H, 6 * H, 12 * H, D];
const fin = (n: number) => Number.isFinite(n);

/** Tick offsets (ms from t0): first is 0, last <= spanMs, at most `maxTicks` of them, on a nice step. */
export function niceTicks(spanMs: number, maxTicks: number): { stepMs: number; ticks: number[] } {
  if (!fin(spanMs) || spanMs <= 0) return { stepMs: S, ticks: [0] };
  const max = Math.max(2, Math.floor(fin(maxTicks) ? maxTicks : 2));
  let stepMs = STEPS.find((s) => Math.floor(spanMs / s) + 1 <= max);
  stepMs ??= D * Math.ceil(spanMs / D / (max - 1)); // beyond a day: whole-day multiples
  const ticks: number[] = [];
  for (let t = 0; t <= spanMs; t += stepMs) ticks.push(t);
  return { stepMs, ticks };
}

/** `0s`, `45s`, `1m 05s`, `2m`, `1h 02m`. Sub-second values floor; negatives and non-finite values read `0s`. */
export function fmtOffset(ms: number): string {
  const s = fin(ms) ? Math.max(0, Math.floor(ms / S)) : 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (h) return m ? `${h}h ${p(m)}m` : `${h}h`;
  if (m) return sec ? `${m}m ${p(sec)}s` : `${m}m`;
  return `${sec}s`;
}

/** Fraction 0..1 of `ts` within [t0, t1]; 0 for an empty/inverted/non-finite range. */
export function xOf(ts: number, t0: number, t1: number): number {
  if (!fin(ts) || !fin(t0) || !fin(t1) || t1 <= t0) return 0;
  return Math.max(0, Math.min(1, (ts - t0) / (t1 - t0)));
}
/** Inverse of xOf: the timestamp at fraction `frac` (clamped), `t0` for an empty range. */
export function tsOf(frac: number, t0: number, t1: number): number {
  if (!fin(t0)) return 0;
  if (!fin(t1) || t1 <= t0 || !fin(frac)) return t0;
  return Math.round(t0 + Math.max(0, Math.min(1, frac)) * (t1 - t0));
}

export type SegStatus = "done" | "failed" | "running" | "blocked";
export type LaneSegment = { start: number; end: number | null; status: SegStatus; attempt: number };
export type OpenStatus = (taskId: string) => SegStatus;

const asOpen = (s: AgentStatus | undefined): SegStatus => (s === "blocked" || s === "done" || s === "failed" ? s : "running");
/** Map a task's overall status to what an open (end-less) attempt should show. */
export const openStatusOf = (status: ReadonlyMap<string, AgentStatus>): OpenStatus => (id) => asOpen(status.get(id));

/** Per-attempt segments for every task, in one pass, keyed in first-start order. Ends are clamped to `now`. */
export function groupLaneSegments(events: StoredEvent[], now: number, openStatus: OpenStatus = () => "running"): Map<string, LaneSegment[]> {
  const out = new Map<string, LaneSegment[]>();
  for (const s of deriveSegments(events)) {
    const list = out.get(s.id) ?? [];
    out.set(s.id, list);
    list.push({
      start: s.start,
      end: s.end === null ? null : fin(now) ? Math.min(s.end, Math.max(now, s.start)) : s.end,
      status: s.outcome ?? openStatus(s.id),
      attempt: s.attempt,
    });
  }
  return out;
}

/** Attempts of one task (a start after a terminal event is a new attempt, as in deriveLanes). */
export function laneSegments(events: StoredEvent[], taskId: string, now: number, openStatus: SegStatus = "running"): LaneSegment[] {
  return groupLaneSegments(events.filter((e) => e.task_id === taskId), now, () => openStatus).get(taskId) ?? [];
}

export type MarkerKind = "start" | "finish" | "fail" | "write" | "read";
export type LaneMarker = { ts: number; kind: MarkerKind };
const KINDS: Record<string, MarkerKind> = { task_started: "start", task_finished: "finish", task_failed: "fail", blackboard_write: "write", blackboard_read: "read" };

/** Markers for every task in one pass, in event order. */
export function groupLaneMarkers(events: StoredEvent[]): Map<string, LaneMarker[]> {
  const out = new Map<string, LaneMarker[]>();
  for (const e of events) {
    const kind = KINDS[e.type];
    if (!kind || !e.task_id || typeof e.ts !== "number" || !fin(e.ts)) continue;
    const list = out.get(e.task_id) ?? [];
    out.set(e.task_id, list);
    list.push({ ts: e.ts, kind });
  }
  return out;
}

export const laneMarkers = (events: StoredEvent[], taskId: string): LaneMarker[] =>
  groupLaneMarkers(events.filter((e) => e.task_id === taskId)).get(taskId) ?? [];

/** One-line hover text for a bar: `id · done · started +0s · ended +1m 12s · took 1m 12s`, plus attempt and marker counts. */
export function segmentTip(id: string, seg: LaneSegment, attempts: number, t0: number, now: number, markers: LaneMarker[] = []): string {
  const parts = [id, seg.status, `started +${fmtOffset(seg.start - t0)}`];
  if (seg.end !== null) {
    const took = seg.end - seg.start;
    parts.push(`ended +${fmtOffset(seg.end - t0)}`, `took ${took < S ? "<1s" : fmtOffset(took)}`);
  } else if (seg.status === "running") parts.push(`running for ${fmtOffset(now - seg.start)}`);
  if (attempts > 1) parts.push(`attempt ${seg.attempt} of ${attempts}`);
  const upto = seg.end ?? now;
  let writes = 0, reads = 0;
  for (const m of markers) if (m.ts >= seg.start && m.ts <= upto) { if (m.kind === "write") writes++; else if (m.kind === "read") reads++; }
  if (writes) parts.push(`${writes} write${writes > 1 ? "s" : ""}`);
  if (reads) parts.push(`${reads} read${reads > 1 ? "s" : ""}`);
  return parts.join(" · ");
}
