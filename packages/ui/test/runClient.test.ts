import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StoredEvent } from "@mar/core";
import { backoff, createRunClient, EventLog, wsUrl, type ClientState, type Deps, type SocketLike } from "../src/runClient.js";

const ev = (id: number, type = "usage"): StoredEvent => ({ id, run_id: "r", task_id: "t", agent_id: "t", ts: id, type, payload: {} }) as StoredEvent;
const snapshot = (events: StoredEvent[], extra: object = {}) => ({ events, blackboard: [], tasks: [], plan: null, ...extra });

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  onopen: SocketLike["onopen"] = null; onclose: SocketLike["onclose"] = null; onmessage: SocketLike["onmessage"] = null;
  closed = false;
  constructor(public url: string) { FakeSocket.all.push(this); }
  close() { this.closed = true; }
  send(ev: StoredEvent) { this.onmessage?.({ data: JSON.stringify(ev) }); }
}

type Resp = { ok: boolean; status: number; json(): Promise<unknown> };
const ok = (body: unknown): Resp => ({ ok: true, status: 200, json: async () => body });
let fetchImpl: (url: string) => Promise<Resp>;
const calls: string[] = [];
const deps = (): Deps => ({
  fetch: (u) => { calls.push(u); return fetchImpl(u); },
  WebSocket: FakeSocket,
  location: { protocol: "http:", host: "h:1" },
  raf: (cb) => setTimeout(cb, 16) as unknown as number,
  caf: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
});
const settle = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

let states: ClientState[];
const last = () => states.at(-1)!;
beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; calls.length = 0; states = []; fetchImpl = async () => ok(snapshot([ev(1), ev(2)])); });
afterEach(() => { vi.useRealTimers(); });

describe("EventLog", () => {
  it("dedupes by id, tracks lastId and sorts only when out of order", () => {
    const l = new EventLog();
    expect(l.addAll([ev(1), ev(2), ev(2)])).toBe(true);
    expect(l.add(ev(2))).toBe(false);
    expect(l.addAll([ev(5), ev(3)])).toBe(true);
    expect(l.lastId).toBe(5);
    expect(l.snapshot().map((e) => e.id)).toEqual([1, 2, 3, 5]);
    expect(l.snapshot()).toBe(l.snapshot()); // cached identity until something changes
  });
  it("appending 50k events stays linear", () => {
    const l = new EventLog();
    const t0 = performance.now();
    for (let i = 1; i <= 50_000; i++) l.add(ev(i));
    expect(l.snapshot()).toHaveLength(50_000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("pure helpers", () => {
  it("builds the resume URL with after=", () => {
    expect(wsUrl({ protocol: "http:", host: "h:1" }, "a b", 7)).toBe("ws://h:1/ws?run=a%20b&after=7");
    expect(wsUrl({ protocol: "https:", host: "h" }, "r", 0)).toBe("wss://h/ws?run=r&after=0");
  });
  it("backs off exponentially, capped at 5s", () => {
    expect([0, 1, 2, 3, 4, 10].map(backoff)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });
});

describe("createRunClient", () => {
  it("loads a snapshot, opens the socket with after=<last id>, dedupes and batches per frame", async () => {
    const dispose = createRunClient("r1", deps(), (s) => states.push(s));
    await settle(20);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.url).toContain("after=2");
    FakeSocket.all[0]!.onopen?.({});
    const n = states.length;
    for (const id of [2, 3, 4, 5]) FakeSocket.all[0]!.send(ev(id)); // 2 is a duplicate
    expect(states.length).toBe(n); // nothing emitted synchronously
    await settle(20);
    expect(states.length).toBe(n + 1); // one emission for the whole burst
    expect(last().snap.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(last().conn).toBe("live");
    dispose();
  });

  it("reconnects with backoff and resumes after the last seen id", async () => {
    createRunClient("r1", deps(), (s) => states.push(s));
    await settle(20);
    const s1 = FakeSocket.all[0]!;
    s1.onopen?.({}); s1.send(ev(9)); await settle(20);
    s1.onclose?.({});
    await settle(16); // the batched (raf) flush emits the reconnecting state
    expect(last().conn).toBe("reconnecting");
    await settle(483); // 499ms after the close: the 500ms backoff has not elapsed yet
    expect(FakeSocket.all).toHaveLength(1);
    fetchImpl = async () => ok(snapshot([ev(1), ev(2), ev(9)]));
    await settle(10); // the 500ms backoff elapses, then snapshot reload, then reopen
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]!.url).toContain("after=9");
    s1.onclose?.({}); // already detached sockets must not matter
  });

  it("unmount closes the socket and cancels every timer", async () => {
    const dispose = createRunClient("r1", deps(), (s) => states.push(s));
    await settle(20);
    const sock = FakeSocket.all[0]!;
    sock.onopen?.({});
    sock.send(ev(7, "task_finished")); // schedules a debounced reload and a frame
    dispose();
    expect(sock.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const n = states.length, f = calls.length;
    await settle(10_000);
    expect(states.length).toBe(n);
    expect(calls.length).toBe(f);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("drops a stale snapshot reload that resolves after a newer one", async () => {
    const resolvers: ((r: Resp) => void)[] = [];
    createRunClient("r1", deps(), (s) => states.push(s));
    await settle(20);
    const sock = FakeSocket.all[0]!;
    sock.onopen?.({});
    fetchImpl = () => new Promise<Resp>((res) => { resolvers.push(res); });
    sock.send(ev(3, "blackboard_write")); await settle(300); // reload #1 in flight
    sock.send(ev(4, "blackboard_write")); await settle(300); // reload #2 in flight
    expect(resolvers).toHaveLength(2);
    resolvers[1]!(ok(snapshot([ev(1), ev(2), ev(3), ev(4)], { tasks: [{ task_id: "t", status: "done", detail: "new" }] })));
    await settle(20);
    resolvers[0]!(ok(snapshot([ev(1), ev(2), ev(3)], { tasks: [{ task_id: "t", status: "running", detail: "stale" }] })));
    await settle(20);
    expect(last().snap.tasks[0]!.detail).toBe("new");
  });

  it("carries truncated through and re-requests the widest window once", async () => {
    fetchImpl = async (u) => ok(snapshot([ev(1), ev(2)], { truncated: !u.includes("limit=") || u.includes("limit=50000") }));
    createRunClient("r1", deps(), (s) => states.push(s));
    await settle(20);
    expect(calls).toEqual(["/api/runs/r1", "/api/runs/r1?limit=50000"]); // once, not a loop
    expect(last().snap.truncated).toBe(true); // still truncated at the max: banner stays
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("does not re-request when the default window is complete", async () => {
    createRunClient("r1", deps(), (s) => states.push(s));
    await settle(20);
    expect(calls).toEqual(["/api/runs/r1"]);
    expect(last().snap.truncated).toBe(false);
  });

  it("treats a 404 as terminal: not found, no retry loop, no socket", async () => {
    fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    createRunClient("nope", deps(), (s) => states.push(s));
    await settle(30_000);
    expect(last()).toMatchObject({ notFound: true, error: "Run not found" });
    expect(calls).toHaveLength(1);
    expect(FakeSocket.all).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failing snapshot (server down) with backoff", async () => {
    fetchImpl = async () => { throw new Error("boom"); };
    createRunClient("r1", deps(), (s) => states.push(s));
    await settle(20);
    expect(last()).toMatchObject({ conn: "reconnecting", error: "boom", notFound: false });
    await settle(500); await settle(1000);
    expect(calls.length).toBe(3);
  });
});
