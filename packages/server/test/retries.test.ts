import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

it("persists attempts across status changes, reopen and read-only snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "mar-retries-"));
  const path = join(dir, "run.db");
  let store = new Store(path);
  try {
    store.setTaskStatus("r", "a", "running");
    const start = (attempt?: number, run_id = "r", task_id = "a") => store.appendEvent({ run_id, task_id, agent_id: task_id, type: "task_started", payload: attempt === undefined ? {} : { attempt } });
    start(); start(); start(4); start(2);
    store.setTaskStatus("r", "a", "done");
    store.setTaskStatus("other", "a", "running"); start(undefined, "other");
    expect(store.taskStatuses("r")[0]).toMatchObject({ status: "done", attempt: 4 });
    expect(store.taskStatuses("other")[0]?.attempt).toBe(1);
    store.close(); store = new Store(path);
    expect(store.taskStatuses("r")[0]?.attempt).toBe(4);
    const snapshot = new Store(path, { readOnly: true });
    try { expect(snapshot.taskStatuses("r")[0]?.attempt).toBe(4); } finally { snapshot.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("backfills old start events once without losing status detail", () => {
  const dir = mkdtempSync(join(tmpdir(), "mar-retries-"));
  const path = join(dir, "old.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT, task_id TEXT, agent_id TEXT, ts INTEGER, type TEXT, payload TEXT);
    CREATE TABLE task_status (run_id TEXT, task_id TEXT, status TEXT, detail TEXT, PRIMARY KEY(run_id,task_id));
    INSERT INTO task_status VALUES ('r','a','failed','timeout');
    INSERT INTO events VALUES (1,'r','a','a',1,'task_started','{}'),(2,'r','a','a',2,'task_started','{"attempt":3}');`);
  db.close();
  try {
    for (let i = 0; i < 2; i++) {
      const store = new Store(path);
      try { expect(store.taskStatuses("r")).toEqual([{ task_id: "a", status: "failed", detail: "timeout", attempt: 3 }]); } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("accepts explicit status attempts and rejects invalid numbers before writing", () => {
  const store = new Store(":memory:");
  try {
    for (const n of [0, -1, 1.5, Infinity, NaN]) expect(() => store.setTaskStatus("r", "a", "done", undefined, n)).toThrow(/positive integer/);
    expect(store.taskStatuses("r")).toEqual([]);
    store.setTaskStatus("r", "a", "running", undefined, 3);
    store.setTaskStatus("r", "a", "done", undefined, 1);
    expect(store.taskStatuses("r")[0]?.attempt).toBe(3);
  } finally { store.close(); }
});
