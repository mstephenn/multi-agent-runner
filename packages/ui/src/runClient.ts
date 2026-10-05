import type { BbEntry, Dag, StoredEvent } from "@mar/core";

export type TaskRow = { task_id: string; status: string; detail: string | null };
export type Snapshot = { events: StoredEvent[]; blackboard: BbEntry[]; tasks: TaskRow[]; plan: Dag | null; reports: ReportRow[]; truncated?: boolean };
export type ReportRow = { task_id: string; body: string };
export type Conn = "loading" | "live" | "reconnecting";
export type ClientState = { snap: Snapshot; conn: Conn; error: string | null; notFound: boolean };
export const EMPTY: Snapshot = { events: [], blackboard: [], tasks: [], plan: null, reports: [] };
export const INITIAL: ClientState = { snap: EMPTY, conn: "loading", error: null, notFound: false };

export const DEBOUNCE_MS = 250;
// The server caps `?limit=` at this; used once when the default window comes back truncated.
export const MAX_EVENT_LIMIT = 50000;
export const backoff = (n: number) => Math.min(500 * 2 ** n, 5000);
export const REFRESH_ON = new Set(["task_finished", "task_failed", "blackboard_write"]);

export const wsUrl = (loc: { protocol: string; host: string }, runId: string, after: number) =>
  `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws?run=${encodeURIComponent(runId)}&after=${after}`;

// Union-by-id event buffer. add() is amortised O(1); the sort only happens when something arrived out of order
// (the websocket can be ahead of, or behind, a freshly loaded snapshot). snapshot() copies once per flush.
export class EventLog {
  private events: StoredEvent[] = [];
  private seen = new Set<number>();
  private cache: StoredEvent[] | null = [];
  private unsorted = false;
  lastId = 0;
  add(ev: StoredEvent): boolean {
    if (this.seen.has(ev.id)) return false;
    this.seen.add(ev.id);
    if (ev.id < this.lastId) this.unsorted = true; else this.lastId = ev.id;
    this.events.push(ev);
    this.cache = null;
    return true;
  }
  addAll(evs: StoredEvent[]): boolean {
    let changed = false;
    for (const e of evs) if (this.add(e)) changed = true;
    return changed;
  }
  snapshot(): StoredEvent[] {
    if (this.cache) return this.cache;
    if (this.unsorted) { this.events.sort((a, b) => a.id - b.id); this.unsorted = false; }
    return (this.cache = this.events.slice());
  }
  get size() { return this.events.length; }
}

export type SocketLike = {
  onopen: ((ev: unknown) => void) | null; onclose: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
};
export type Deps = {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  WebSocket: new (url: string) => SocketLike;
  location: { protocol: string; host: string };
  raf: (cb: () => void) => number;
  caf: (id: number) => void;
};

type LoadResult = "ok" | "fail" | "notfound" | "stale";

// Framework-free run connection: snapshot load, resume-aware websocket, rAF-batched state emission.
export function createRunClient(runId: string, deps: Deps, onState: (s: ClientState) => void): () => void {
  let alive = true, attempt = 0, seq = 0, frame: number | undefined;
  let ws: SocketLike | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined, reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const log = new EventLog();
  const state: ClientState = { snap: EMPTY, conn: "loading", error: null, notFound: false };
  let rest = { blackboard: EMPTY.blackboard, tasks: EMPTY.tasks, plan: EMPTY.plan as Dag | null, reports: [] as ReportRow[], truncated: false };
  let limit: number | null = null; // null = server default window; set to the max once a load comes back truncated

  const flush = () => {
    frame = undefined;
    if (!alive) return;
    onState({ ...state, snap: { events: log.snapshot(), ...rest } });
  };
  const schedule = () => { if (alive && frame === undefined) frame = deps.raf(flush); };

  const load = async (): Promise<LoadResult> => {
    const mine = ++seq; // a slower, older response must never overwrite a newer one
    try {
      const res = await deps.fetch(`/api/runs/${encodeURIComponent(runId)}${limit === null ? "" : `?limit=${limit}`}`);
      if (!alive || mine !== seq) return "stale";
      if (res.status === 404) { state.notFound = true; state.error = "Run not found"; schedule(); return "notfound"; }
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const s = (await res.json()) as Snapshot;
      if (!alive || mine !== seq) return "stale";
      log.addAll(s.events);
      rest = { blackboard: s.blackboard, tasks: s.tasks, plan: s.plan ?? null, reports: s.reports ?? [], truncated: s.truncated === true };
      state.error = null;
      schedule();
      if (rest.truncated && limit === null) { limit = MAX_EVENT_LIMIT; return load(); } // ask for the widest window, once
      return "ok";
    } catch (e) {
      if (!alive || mine !== seq) return "stale";
      state.error = e instanceof Error ? e.message : "Cannot reach the server";
      schedule();
      return "fail";
    }
  };
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { void load(); }, DEBOUNCE_MS);
  };
  const retry = () => {
    if (!alive || state.notFound) return;
    state.conn = "reconnecting"; schedule();
    retryTimer = setTimeout(() => { void connect(); }, backoff(attempt++));
  };
  const open = () => {
    const sock = new deps.WebSocket(wsUrl(deps.location, runId, log.lastId));
    ws = sock;
    sock.onopen = () => { if (alive) { attempt = 0; state.conn = "live"; schedule(); } };
    sock.onmessage = (m) => {
      if (!alive) return;
      let ev: StoredEvent;
      try { ev = JSON.parse(String(m.data)) as StoredEvent; } catch { return; }
      if (typeof ev?.id !== "number") return;
      if (log.add(ev)) schedule();
      if (REFRESH_ON.has(ev.type)) scheduleReload();
    };
    sock.onclose = () => { ws = undefined; retry(); };
  };
  const connect = async () => {
    const r = await load();
    if (!alive || r === "notfound") return;
    if (r === "ok" || r === "stale") { if (!ws) open(); } else retry();
  };
  void connect();
  return () => {
    alive = false;
    clearTimeout(retryTimer); clearTimeout(reloadTimer);
    if (frame !== undefined) deps.caf(frame);
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onopen = null; ws.close(); ws = undefined; }
  };
}
