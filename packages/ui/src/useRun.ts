import { useEffect, useState } from "react";
import type { BbEntry, Dag, StoredEvent } from "@mar/core";

export type TaskRow = { task_id: string; status: string; detail: string | null };
export type Snapshot = { events: StoredEvent[]; blackboard: BbEntry[]; tasks: TaskRow[]; plan: Dag | null };
export type Conn = "loading" | "live" | "reconnecting";
export const EMPTY: Snapshot = { events: [], blackboard: [], tasks: [], plan: null };

const DEBOUNCE_MS = 250;
const backoff = (n: number) => Math.min(500 * 2 ** n, 5000);
const REFRESH_ON = new Set(["task_finished", "task_failed", "blackboard_write"]);

// Union by event id; the websocket can be ahead of (or behind) a freshly loaded snapshot.
function merge(prev: StoredEvent[], next: StoredEvent[]): StoredEvent[] {
  if (prev.length === 0) return next;
  const seen = new Set(prev.map((e) => e.id));
  const add = next.filter((e) => !seen.has(e.id));
  if (add.length === 0) return prev.length === next.length ? next : prev;
  return [...prev, ...add].sort((a, b) => a.id - b.id);
}

export function useRun(runId: string | null) {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [conn, setConn] = useState<Conn>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSnap(EMPTY); setError(null); setConn("loading");
    if (!runId) return;
    let alive = true, last = 0, attempt = 0;
    let ws: WebSocket | undefined, retryTimer: number | undefined, reloadTimer: number | undefined;

    const load = async (): Promise<boolean> => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) throw new Error(res.status === 404 ? "Unknown run" : `Server returned ${res.status}`);
        const s = (await res.json()) as Snapshot;
        if (!alive) return false;
        setSnap((p) => ({ ...s, plan: s.plan ?? null, events: merge(p.events, s.events) }));
        last = Math.max(last, s.events.at(-1)?.id ?? 0);
        setError(null);
        return true;
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Cannot reach the server");
        return false;
      }
    };
    const scheduleReload = () => {
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => { void load(); }, DEBOUNCE_MS);
    };
    const retry = () => {
      if (!alive) return;
      setConn("reconnecting");
      retryTimer = window.setTimeout(() => { void connect(); }, backoff(attempt++));
    };
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?run=${encodeURIComponent(runId)}&after=${last}`);
      ws.onopen = () => { if (alive) { attempt = 0; setConn("live"); } };
      ws.onmessage = (m) => {
        if (!alive) return;
        let ev: StoredEvent;
        try { ev = JSON.parse(String(m.data)) as StoredEvent; } catch { return; }
        last = Math.max(last, ev.id);
        setSnap((p) => (p.events.some((x) => x.id === ev.id) ? p : { ...p, events: [...p.events, ev] }));
        if (REFRESH_ON.has(ev.type)) scheduleReload();
      };
      ws.onclose = () => { ws = undefined; retry(); };
    };
    const connect = async () => {
      if (await load()) { if (alive) open(); } else retry();
    };
    void connect();
    return () => {
      alive = false;
      window.clearTimeout(retryTimer); window.clearTimeout(reloadTimer);
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [runId]);

  return { snap, conn, error };
}
