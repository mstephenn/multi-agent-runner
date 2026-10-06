import Database from "better-sqlite3";
import { MAX_BB_BODY_CHARS, type BbEntry, type BbWrite, type Dag, type NewEvent, type StoredEvent } from "@mar/core";

const MAX_REPORT_CHARS = 100_000;
type EventRow = Omit<StoredEvent, "payload"> & { payload: string };
type BbRow = Omit<BbEntry, "refs"> & { refs: string };
const eventFromRow = (r: EventRow): StoredEvent => {
  let payload: StoredEvent["payload"];
  try { payload = JSON.parse(r.payload) as StoredEvent["payload"]; } catch { payload = { corrupt: true } as StoredEvent["payload"]; }
  return { ...r, payload };
};

export interface PhaseRow { run_id: string; phase: number; dag: Dag; remaining: string; status: string }

export class Store {
  private db: Database.Database;
  private subs = new Set<(e: StoredEvent) => void>();

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, goal TEXT, repo TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, agent_id TEXT, ts INTEGER, type TEXT, payload TEXT);
      CREATE INDEX IF NOT EXISTS ev_run ON events(run_id, id);
      CREATE TABLE IF NOT EXISTS bb_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, key TEXT, author_task TEXT, version INTEGER, ts INTEGER, kind TEXT, body TEXT, refs TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS bb_run_key_version ON bb_entries(run_id, key, version);
      CREATE TABLE IF NOT EXISTS task_status (run_id TEXT, task_id TEXT, status TEXT, detail TEXT, PRIMARY KEY (run_id, task_id));
      CREATE TABLE IF NOT EXISTS plans (run_id TEXT PRIMARY KEY, dag TEXT);
      CREATE TABLE IF NOT EXISTS phases (run_id TEXT, phase INTEGER, dag TEXT, remaining TEXT, status TEXT, PRIMARY KEY (run_id, phase));
      CREATE TABLE IF NOT EXISTS reports (run_id TEXT, task_id TEXT, body TEXT NOT NULL, ts INTEGER, PRIMARY KEY (run_id, task_id));
    `);
  }

  createRun(id: string, goal: string, repo: string) {
    this.db.prepare("INSERT OR IGNORE INTO runs VALUES (?,?,?,?)").run(id, goal, repo, Date.now());
  }
  listRuns() { return this.db.prepare("SELECT id, goal, repo, created FROM runs ORDER BY created DESC").all() as { id: string; goal: string; repo: string; created: number }[]; }

  hasRun(id: string): boolean { return this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(id) !== undefined; }
  close() { this.db.close(); }

  appendEvent(e: NewEvent): StoredEvent {
    const ts = Date.now();
    const payload = e.payload ?? {};
    const r = this.db.prepare("INSERT INTO events (run_id, task_id, agent_id, ts, type, payload) VALUES (?,?,?,?,?,?)")
      .run(e.run_id, e.task_id, e.agent_id, ts, e.type, JSON.stringify(payload));
    const stored = { ...e, payload, id: Number(r.lastInsertRowid), ts };
    for (const cb of this.subs) { try { cb(stored); } catch { /* a failing subscriber must not break the append or starve others */ } }
    return stored;
  }
  /** Events after `afterId` in id order, optionally capped at `limit`. A row with unparseable payload yields `{ corrupt: true }` so one bad row cannot break reads. */
  listEvents(runId: string, afterId = 0, limit = -1): StoredEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id LIMIT ?").all(runId, afterId, limit) as EventRow[];
    return rows.map(eventFromRow);
  }
  /** The most recent `limit` events (ascending) and whether older ones were cut. */
  recentEvents(runId: string, limit: number): { events: StoredEvent[]; truncated: boolean } {
    const rows = this.db.prepare("SELECT * FROM events WHERE run_id=? ORDER BY id DESC LIMIT ?").all(runId, limit + 1) as EventRow[];
    const truncated = rows.length > limit;
    return { events: rows.slice(0, limit).reverse().map(eventFromRow), truncated };
  }
  onEvent(cb: (e: StoredEvent) => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  get subscriberCount() { return this.subs.size; }

  writeBb(w: BbWrite): BbEntry {
    if (w.body.length > MAX_BB_BODY_CHARS) throw new Error(`blackboard body too large (cap ${MAX_BB_BODY_CHARS} chars); use an artifact_ref`);
    const attempt = this.db.transaction((): BbEntry => {
      const ts = Date.now();
      const prev = this.db.prepare("SELECT MAX(version) v FROM bb_entries WHERE run_id=? AND key=?").get(w.run_id, w.key) as { v: number | null };
      const version = (prev.v ?? 0) + 1;
      const r = this.db.prepare("INSERT INTO bb_entries (run_id,key,author_task,version,ts,kind,body,refs) VALUES (?,?,?,?,?,?,?,?)")
        .run(w.run_id, w.key, w.author_task, version, ts, w.kind, w.body, JSON.stringify(w.refs));
      return { ...w, id: Number(r.lastInsertRowid), version, ts };
    });
    try { return attempt.immediate(); } catch (err) {
      // another process won the version race (UNIQUE backstop): re-read the max and retry once
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return attempt.immediate();
      throw err;
    }
  }
  private bbRow(r: BbRow): BbEntry {
    let refs: BbEntry["refs"] = [];
    try { refs = JSON.parse(r.refs) as BbEntry["refs"]; } catch { /* corrupt refs: surface the entry without them */ }
    return { ...r, refs };
  }
  latestBb(runId: string, key: string) {
    const r = this.db.prepare("SELECT * FROM bb_entries WHERE run_id=? AND key=? ORDER BY version DESC LIMIT 1").get(runId, key) as BbRow | undefined;
    return r ? this.bbRow(r) : undefined;
  }
  listBb(runId: string): BbEntry[] {
    return (this.db.prepare("SELECT * FROM bb_entries WHERE run_id=? ORDER BY id").all(runId) as BbRow[]).map((r) => this.bbRow(r));
  }

  setTaskStatus(runId: string, taskId: string, status: string, detail?: string) {
    this.db.prepare("INSERT INTO task_status VALUES (?,?,?,?) ON CONFLICT(run_id,task_id) DO UPDATE SET status=excluded.status, detail=excluded.detail")
      .run(runId, taskId, status, detail ?? null);
  }
  taskStatuses(runId: string) {
    return this.db.prepare("SELECT task_id, status, detail FROM task_status WHERE run_id=?").all(runId) as { task_id: string; status: string; detail: string | null }[];
  }

  /** Long-form task answer, kept outside the blackboard. Upserts (a retry overwrites); capped defensively with a visible marker. */
  saveReport(runId: string, taskId: string, body: string): void {
    const MARK = "…[truncated]";
    const text = body.length > MAX_REPORT_CHARS ? body.slice(0, MAX_REPORT_CHARS - MARK.length) + MARK : body;
    this.db.prepare("INSERT INTO reports (run_id, task_id, body, ts) VALUES (?,?,?,?) ON CONFLICT(run_id,task_id) DO UPDATE SET body=excluded.body, ts=excluded.ts")
      .run(runId, taskId, text, Date.now());
  }
  /** Reports of a run in first-insertion order. */
  listReports(runId: string): { task_id: string; body: string; ts: number }[] {
    return this.db.prepare("SELECT task_id, body, ts FROM reports WHERE run_id=? ORDER BY rowid").all(runId) as { task_id: string; body: string; ts: number }[];
  }

  savePlan(runId: string, dag: Dag): void {
    this.db.prepare("INSERT INTO plans (run_id, dag) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET dag=excluded.dag")
      .run(runId, JSON.stringify(dag));
  }
  loadPlan(runId: string): Dag | undefined {
    const r = this.db.prepare("SELECT dag FROM plans WHERE run_id=?").get(runId) as { dag: string } | undefined;
    if (!r) return undefined;
    try { return JSON.parse(r.dag) as Dag; } catch { throw new Error(`corrupt plan for run ${runId}`); }
  }

  /** One planning phase: its own DAG, the text of the work left after it ("" = nothing), and its status. Upserts. `savePlan` keeps the UNION of all phases. */
  savePhase(runId: string, phase: number, dag: Dag, remaining: string, status: string): void {
    this.db.prepare("INSERT INTO phases (run_id, phase, dag, remaining, status) VALUES (?,?,?,?,?) ON CONFLICT(run_id,phase) DO UPDATE SET dag=excluded.dag, remaining=excluded.remaining, status=excluded.status")
      .run(runId, phase, JSON.stringify(dag), remaining, status);
  }
  listPhases(runId: string): PhaseRow[] {
    const rows = this.db.prepare("SELECT run_id, phase, dag, remaining, status FROM phases WHERE run_id=? ORDER BY phase").all(runId) as (Omit<PhaseRow, "dag"> & { dag: string })[];
    return rows.map((r) => {
      try { return { ...r, dag: JSON.parse(r.dag) as Dag }; } catch { throw new Error(`corrupt phase ${r.phase} for run ${runId}`); }
    });
  }
  setPhaseStatus(runId: string, phase: number, status: string): void {
    this.db.prepare("UPDATE phases SET status=? WHERE run_id=? AND phase=?").run(status, runId, phase);
  }

  /** Sum of input+output tokens of every `usage` event of the run (workers and planner calls). */
  usageTokens(runId: string): number {
    const rows = this.db.prepare("SELECT payload FROM events WHERE run_id=? AND type='usage'").all(runId) as { payload: string }[];
    let total = 0;
    for (const r of rows) {
      let p: { input?: unknown; output?: unknown };
      try { p = JSON.parse(r.payload) as typeof p; } catch { continue; }
      for (const v of [p.input, p.output]) if (typeof v === "number" && Number.isFinite(v) && v > 0) total += v;
    }
    return total;
  }
}
