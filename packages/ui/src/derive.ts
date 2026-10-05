import type { StoredEvent } from "@mar/core";

export type AgentStatus = "pending" | "running" | "done" | "failed" | "blocked";
export type AgentView = {
  id: string; role?: string; runtime?: string; tier?: string; status: AgentStatus; detail?: string;
  tokens: number | null; costUsd: number | null; startedAt?: number; endedAt?: number; unsafe: boolean;
};
export type FlowEdge = { from: string; to: string; key: string; version: number; tokens: number };
export type Lane = { id: string; start: number; end: number | null };
export type ActivityItem = { id: number; ts: number; kind: "text" | "tool_call" | "tool_result"; text: string; isError?: boolean };
type TaskRow = { task_id: string; status: string; detail: string | null };

const STATUSES: readonly string[] = ["pending", "running", "done", "failed", "blocked"];
const MAX_TEXT = 500;

// Payload values are `unknown`; these guards keep every derivation total.
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isEnd = (t: string) => t === "task_finished" || t === "task_failed";

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  const seen = new WeakSet<object>();
  try {
    const s = JSON.stringify(v, (_k, val: unknown) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
    return s ?? String(v);
  } catch {
    return "[Unserializable]";
  }
}
const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + "…" : s);

export function deriveAgents(events: StoredEvent[], tasks: TaskRow[]): AgentView[] {
  const m = new Map<string, AgentView>();
  const derived = new Map<string, AgentStatus>();
  const get = (id: string) => {
    let v = m.get(id);
    if (!v) { v = { id, status: "pending", tokens: null, costUsd: null, unsafe: false }; m.set(id, v); }
    return v;
  };
  const fromStore = new Map<string, AgentStatus>();
  for (const t of tasks) {
    const v = get(t.task_id);
    if (STATUSES.includes(t.status)) fromStore.set(t.task_id, t.status as AgentStatus);
    if (t.detail) v.detail = t.detail;
  }
  for (const ev of events) {
    if (!ev.task_id) continue;
    const v = get(ev.task_id);
    const p = rec(ev.payload);
    const ts = num(ev.ts);
    if (ev.type === "task_started") {
      v.role = str(p.role) ?? v.role; v.runtime = str(p.runtime) ?? v.runtime; v.tier = str(p.tier) ?? v.tier;
      if (p.unsafe === true) v.unsafe = true;
      if (ts !== undefined && (v.startedAt === undefined || ts < v.startedAt)) v.startedAt = ts;
      // a terminal state seen earlier (out-of-order) must not be downgraded to running
      if (!derived.has(ev.task_id)) derived.set(ev.task_id, "running");
    } else if (isEnd(ev.type)) {
      if (ts !== undefined && (v.endedAt === undefined || ts > v.endedAt)) v.endedAt = ts;
      derived.set(ev.task_id, ev.type === "task_finished" ? "done" : "failed");
    } else if (ev.type === "usage") {
      const input = num(p.input), output = num(p.output), cost = num(p.costUsd);
      if (input !== undefined || output !== undefined) v.tokens = (v.tokens ?? 0) + (input ?? 0) + (output ?? 0);
      if (cost !== undefined) v.costUsd = (v.costUsd ?? 0) + cost;
    }
  }
  for (const v of m.values()) v.status = fromStore.get(v.id) ?? derived.get(v.id) ?? "pending";
  return [...m.values()];
}

export function deriveFlow(events: StoredEvent[]): FlowEdge[] {
  const out: FlowEdge[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== "blackboard_read" || !e.task_id) continue;
    const p = rec(e.payload);
    const from = str(p.author), key = str(p.key), version = num(p.version);
    if (from === undefined || key === undefined || version === undefined) continue;
    const sig = JSON.stringify([from, e.task_id, key, version]);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ from, to: e.task_id, key, version, tokens: num(p.tokens) ?? 0 });
  }
  return out;
}

export function deriveContext(events: StoredEvent[], taskId: string, allKeys?: string[]) {
  let prompt: string | null = null;
  let given: Set<string> | null = null;
  const slices: { key: string; version: number; tokens: number }[] = [];
  for (const e of events) {
    if (e.task_id !== taskId) continue;
    const p = rec(e.payload);
    if (e.type === "prompt_sent") {
      prompt = str(p.prompt) ?? null;
      given = new Set(Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === "string") : []);
    } else if (e.type === "blackboard_read") {
      const key = str(p.key), version = num(p.version);
      if (key !== undefined && version !== undefined) slices.push({ key, version, tokens: num(p.tokens) ?? 0 });
    }
  }
  // Without a prompt_sent we cannot tell what was injected, so report nothing.
  const notGiven = allKeys && given ? allKeys.filter((k) => !given!.has(k)) : [];
  return { prompt, slices, notGiven };
}

export function deriveLanes(events: StoredEvent[]): Lane[] {
  const lanes = new Map<string, { start: number | undefined; end: number | undefined }>();
  const order: string[] = [];
  for (const e of events) {
    if (!e.task_id) continue;
    const ts = num(e.ts);
    if (ts === undefined) continue;
    const isStart = e.type === "task_started";
    if (!isStart && !isEnd(e.type)) continue;
    let l = lanes.get(e.task_id);
    if (!l) { l = { start: undefined, end: undefined }; lanes.set(e.task_id, l); }
    if (isStart) {
      if (l.start === undefined) order.push(e.task_id);
      if (l.start === undefined || ts < l.start) l.start = ts;
    } else if (l.end === undefined || ts > l.end) l.end = ts;
  }
  return order.map((id) => {
    const l = lanes.get(id)!;
    const start = l.start!;
    return { id, start, end: l.end === undefined ? null : Math.max(l.end, start) };
  });
}

export function deriveActivity(events: StoredEvent[], taskId: string): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const e of events) {
    if (e.task_id !== taskId) continue;
    const p = rec(e.payload);
    const base = { id: e.id, ts: num(e.ts) ?? 0 };
    if (e.type === "assistant_text") out.push({ ...base, kind: "text", text: clip(str(p.text) ?? safeStringify(p.text ?? "")) });
    else if (e.type === "tool_call") out.push({ ...base, kind: "tool_call", text: clip(`${str(p.name) ?? "tool"} ${safeStringify(p.input ?? {})}`) });
    else if (e.type === "tool_result") {
      const item: ActivityItem = { ...base, kind: "tool_result", text: clip(str(p.output) ?? safeStringify(p.output ?? "")) };
      if (p.isError === true) item.isError = true;
      out.push(item);
    }
  }
  return out;
}

export function totals(agents: AgentView[]): { tokens: number; costUsd: number | null } {
  let tokens = 0;
  let costUsd: number | null = null;
  for (const a of agents) {
    if (a.tokens !== null) tokens += a.tokens;
    if (a.costUsd !== null) costUsd = (costUsd ?? 0) + a.costUsd;
  }
  return { tokens, costUsd };
}
