import type { StoredEvent } from "@mar/core";

export type AgentStatus = "pending" | "running" | "done" | "failed" | "blocked";
export type AgentView = {
  id: string; role?: string; runtime?: string; tier?: string; status: AgentStatus; detail?: string;
  tokens: number | null; costUsd: number | null; startedAt?: number; endedAt?: number; unsafe: boolean;
};
export type FlowEdge = { from: string; to: string; key: string; version: number; tokens: number };
// One segment per attempt (a resumed/retried task yields several); the latest attempt is the only one that can be open-ended.
export type Lane = { id: string; start: number; end: number | null; attempt: number };
export type ActivityItem = { id: number; ts: number; kind: "text" | "tool_call" | "tool_result"; text: string; isError?: boolean };
type TaskRow = { task_id: string; status: string; detail: string | null };

const STATUSES: readonly string[] = ["pending", "running", "done", "failed", "blocked"];
const MAX_TEXT = 500;

// Payload values are `unknown`; these guards keep every derivation total.
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const nonneg = (v: unknown): number | undefined => { const n = num(v); return n === undefined ? undefined : Math.max(0, n); };
const isEnd = (t: string) => t === "task_finished" || t === "task_failed";

// Only true cycles (a value that is its own ancestor) are marked; a repeated, non-circular reference serializes normally.
// JSON.stringify calls the replacer with `this` = the holder, which lets us track the current ancestor chain.
function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  const stack: { orig: object; conv: object }[] = [];
  try {
    const s = JSON.stringify(v, function (this: unknown, _k: string, val: unknown) {
      if (typeof val === "bigint") return val.toString();
      if (typeof val !== "object" || val === null) return val;
      while (stack.length > 0 && stack[stack.length - 1]!.conv !== this) stack.pop();
      if (stack.some((s) => s.orig === val)) return "[Circular]";
      const conv: object = val instanceof Map ? { Map: [...val.entries()] } : val instanceof Set ? { Set: [...val.values()] } : val;
      stack.push({ orig: val, conv });
      return conv;
    });
    return s ?? String(v);
  } catch {
    return "[Unserializable]";
  }
}
// Cut on a code-point boundary: never leave a lone high surrogate before the ellipsis.
const clip = (s: string) => {
  if (s.length <= MAX_TEXT) return s;
  let cut = MAX_TEXT - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return s.slice(0, cut) + "…";
};

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
  const lastEnd = new Map<string, number | undefined>(); // tasks whose latest event-order state is terminal
  for (const ev of events) {
    if (!ev.task_id) continue;
    const v = get(ev.task_id);
    const p = rec(ev.payload);
    const ts = num(ev.ts);
    if (ev.type === "task_started" && lastEnd.has(ev.task_id) && (ts === undefined || lastEnd.get(ev.task_id) === undefined || ts >= lastEnd.get(ev.task_id)!)) {
      // A start after a terminal event (retry/resume) opens a NEW attempt. (A start whose ts is older than the
      // terminal event is treated as out-of-order delivery and handled below instead.)
      lastEnd.delete(ev.task_id);
      derived.set(ev.task_id, "running");
      v.endedAt = undefined;
      v.startedAt = ts;
      v.role = str(p.role) ?? v.role; v.runtime = str(p.runtime) ?? v.runtime; v.tier = str(p.tier) ?? v.tier;
      if (p.unsafe === true) v.unsafe = true;
    } else if (ev.type === "task_started") {
      v.role = str(p.role) ?? v.role; v.runtime = str(p.runtime) ?? v.runtime; v.tier = str(p.tier) ?? v.tier;
      if (p.unsafe === true) v.unsafe = true;
      if (ts !== undefined && (v.startedAt === undefined || ts < v.startedAt)) v.startedAt = ts;
      // a terminal state seen earlier (out-of-order) must not be downgraded to running
      if (!derived.has(ev.task_id)) derived.set(ev.task_id, "running");
    } else if (isEnd(ev.type)) {
      if (ts !== undefined && (v.endedAt === undefined || ts > v.endedAt)) v.endedAt = ts;
      lastEnd.set(ev.task_id, v.endedAt);
      derived.set(ev.task_id, ev.type === "task_finished" ? "done" : "failed");
    } else if (ev.type === "usage") {
      // Each `usage` event is treated as INCREMENTAL and summed. Claude emits a single final usage per run; Codex's
      // per-turn usage is assumed to be non-cumulative (UNVERIFIED; if it is cumulative this double counts).
      // Negative values are clamped to 0 so a bad payload cannot reduce the total.
      const input = nonneg(p.input), output = nonneg(p.output), cost = nonneg(p.costUsd);
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
    out.push({ from, to: e.task_id, key, version, tokens: nonneg(p.tokens) ?? 0 });
  }
  return out;
}

// Reads are emitted BEFORE the prompt_sent they feed, so reads since the previous boundary (prompt_sent or
// task_started) belong to the next prompt_sent; slices reset per prompt and a retry never accumulates attempts.
export function deriveContext(events: StoredEvent[], taskId: string, allKeys?: string[]) {
  let prompt: string | null = null;
  let given: Set<string> | null = null;
  let slices: { key: string; version: number; tokens: number }[] = [];
  let pending: { key: string; version: number; tokens: number }[] = [];
  for (const e of events) {
    if (e.task_id !== taskId) continue;
    const p = rec(e.payload);
    if (e.type === "task_started") {
      pending = [];
    } else if (e.type === "prompt_sent") {
      prompt = str(p.prompt) ?? null;
      given = new Set(Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === "string") : []);
      slices = pending; pending = [];
    } else if (e.type === "blackboard_read") {
      const key = str(p.key), version = num(p.version);
      if (key !== undefined && version !== undefined) pending.push({ key, version, tokens: nonneg(p.tokens) ?? 0 });
    }
  }
  // Before any prompt_sent the reads seen so far are what the upcoming prompt will carry.
  if (prompt === null && given === null) slices = pending;
  // Without a prompt_sent we cannot tell what was injected, so report nothing.
  const notGiven = allKeys && given ? allKeys.filter((k) => !given!.has(k)) : [];
  return { prompt, slices, notGiven };
}

export function deriveLanes(events: StoredEvent[]): Lane[] {
  type Seg = { start: number | undefined; end: number | undefined };
  const segs = new Map<string, Seg[]>();
  const order: string[] = [];
  for (const e of events) {
    if (!e.task_id) continue;
    const ts = num(e.ts);
    if (ts === undefined) continue;
    const isStart = e.type === "task_started";
    if (!isStart && !isEnd(e.type)) continue;
    let list = segs.get(e.task_id);
    if (!list) { list = []; segs.set(e.task_id, list); }
    let cur = list[list.length - 1];
    if (isStart) {
      // A start at/after the current segment's end (by event order) is a new attempt; an older ts is out-of-order delivery.
      if (!cur || (cur.end !== undefined && cur.start !== undefined && ts >= cur.end)) { cur = { start: undefined, end: undefined }; list.push(cur); }
      if (cur.start === undefined) { if (!order.includes(e.task_id)) order.push(e.task_id); }
      if (cur.start === undefined || ts < cur.start) cur.start = ts;
    } else {
      if (!cur) { cur = { start: undefined, end: undefined }; list.push(cur); }
      if (cur.end === undefined || ts > cur.end) cur.end = ts;
    }
  }
  const out: Lane[] = [];
  for (const id of order) {
    let attempt = 0;
    for (const s of segs.get(id)!) {
      if (s.start === undefined) continue;
      out.push({ id, start: s.start, end: s.end === undefined ? null : Math.max(s.end, s.start), attempt: ++attempt });
    }
  }
  return out;
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
