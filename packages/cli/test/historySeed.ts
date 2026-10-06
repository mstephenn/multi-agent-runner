import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRaw } from "../../server/test/rawDb.js";
import { Store } from "@mar/server";
import type { Dag } from "@mar/core";

const T = (id: string, o: Partial<Dag["tasks"][number]> = {}): Dag["tasks"][number] =>
  ({ id, role: "implementer", runtime: "codex", tier: "mid", goal: `do ${id}`, dependsOn: [], needs: [], paths: [], ...o }) as Dag["tasks"][number];
const dag = (...tasks: Dag["tasks"]): Dag => ({ tasks });

export const HOUR = 3_600_000;
export const ESC_REPORT = "# Findings\n\nAll good.\x1b[2J\x1b]0;pwned\x07 end\u009b31m";

/** A temp "repo" (just a directory with `.mar/mar.db`) holding realistic runs, built through the real Store. Returns the repo path. */
export function seedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mar-hist-"));
  mkdirSync(join(repo, ".mar"), { recursive: true });
  const dbPath = join(repo, ".mar", "mar.db");
  const s = new Store(dbPath);
  const ev = (run: string, task: string | null, type: Parameters<Store["appendEvent"]>[0]["type"], payload: Record<string, unknown> = {}) =>
    s.appendEvent({ run_id: run, task_id: task, agent_id: task, type, payload });
  const usage = (run: string, task: string, input: number, output: number) => ev(run, task, "usage", { input, output, cached: null, costUsd: null });
  const report = (run: string, task: string, body: string) => {
    s.saveReport(run, task, body);
    mkdirSync(join(repo, ".mar", "reports", run), { recursive: true });
    writeFileSync(join(repo, ".mar", "reports", run, `${task}.md`), body);
  };

  // rsingle1: one phase, done, with a report and a blackboard summary for the leaf
  s.createRun("rsingle1", "Add a health endpoint\nand cover it with tests", repo);
  const single = dag(T("research", { role: "researcher", runtime: "claude" }), T("impl", { dependsOn: ["research"] }));
  s.savePhase("rsingle1", 1, single, "", "done"); s.savePlan("rsingle1", single);
  ev("rsingle1", null, "phase_started", { phase: 1, maxPhases: 5, tasks: ["research", "impl"], remaining: "" });
  for (const t of ["research", "impl"]) { ev("rsingle1", t, "task_started", { worktree: t === "research" ? "shared" : "own" }); usage("rsingle1", t, 1000, 234); ev("rsingle1", t, "task_finished", { tokens: 1234 }); s.setTaskStatus("rsingle1", t, "done"); }
  s.writeBb({ run_id: "rsingle1", key: "impl/summary", author_task: "impl", kind: "summary", body: "added GET /health", refs: [] });
  report("rsingle1", "impl", "Added `GET /health`.\n\n- returns 200\n- 日本語 ✓ 🚀\n");

  // rthree3x: three phases, integration with a failing verify whose tail carries an escape sequence
  s.createRun("rthree3x", "Build the billing module in three steps", repo);
  const p1 = dag(T("api")); const p2 = dag(T("ui", { needs: ["api/summary"] })); const p3 = dag(T("docs", { role: "researcher" }));
  s.savePhase("rthree3x", 1, p1, "wire the UI", "done"); s.savePhase("rthree3x", 2, p2, "write the docs", "done"); s.savePhase("rthree3x", 3, p3, "", "done");
  s.savePlan("rthree3x", dag(...p1.tasks, ...p2.tasks, ...p3.tasks));
  for (const [i, t] of ["api", "ui", "docs"].entries()) {
    ev("rthree3x", null, "phase_started", { phase: i + 1, maxPhases: 5, tasks: [t], remaining: "" });
    ev("rthree3x", t, "task_started", { worktree: "own" }); usage("rthree3x", t, 500, 500); ev("rthree3x", t, "task_finished", {}); s.setTaskStatus("rthree3x", t, "done");
  }
  ev("rthree3x", null, "integration", { phase: 1, branch: "mar/integrate/rthree3x", merged: ["mar/rthree3x/api"], verify: { ok: true, tail: "" } });
  ev("rthree3x", null, "integration", { phase: 2, branch: "mar/integrate/rthree3x", merged: ["mar/rthree3x/ui"], verify: { ok: false, failed: { command: "pnpm test", timedOut: false }, tail: `${"x".repeat(900)}\nFAIL billing.test.ts\x1b[2J\x1b]0;evil\x07` } });
  report("rthree3x", "docs", ESC_REPORT);
  report("rthree3x", "api", "API report");

  // rfailed4: a failed task and a blocked dependent
  s.createRun("rfailed4", "Migrate the schema", repo);
  const f = dag(T("migrate"), T("verify", { dependsOn: ["migrate"] }));
  s.savePhase("rfailed4", 1, f, "", "incomplete"); s.savePlan("rfailed4", f);
  ev("rfailed4", "migrate", "task_started", {}); ev("rfailed4", "migrate", "task_failed", { reason: "boom: exit 1" });
  s.setTaskStatus("rfailed4", "migrate", "failed", "boom: exit 1"); s.setTaskStatus("rfailed4", "verify", "blocked");

  // rabort55: stopped by the user while 2 tasks still waited; nothing running any more
  s.createRun("rabort55", "Refactor the auth layer", repo);
  const a = dag(T("scan", { role: "researcher" }), T("edit", { dependsOn: ["scan"] }), T("test", { dependsOn: ["edit"] }));
  s.savePhase("rabort55", 1, a, "", "incomplete"); s.savePlan("rabort55", a);
  ev("rabort55", "scan", "task_started", {}); ev("rabort55", "scan", "task_finished", {}); s.setTaskStatus("rabort55", "scan", "done");
  ev("rabort55", "edit", "task_started", {}); ev("rabort55", "edit", "task_failed", { reason: "aborted" }); s.setTaskStatus("rabort55", "edit", "failed", "aborted"); s.setTaskStatus("rabort55", "test", "blocked");

  // rold00001: pre-phases run: a single plan, no phases rows
  s.createRun("rold00001", "Old style run", repo);
  const o = dag(T("only", { role: "researcher", runtime: "claude" }));
  s.savePlan("rold00001", o);
  ev("rold00001", "only", "task_started", {}); ev("rold00001", "only", "task_finished", {}); s.setTaskStatus("rold00001", "only", "done");
  s.writeBb({ run_id: "rold00001", key: "only/summary", author_task: "only", kind: "summary", body: "old summary", refs: [] });

  // rcorrupt1: damaged rows (bad phase JSON, bad plan JSON, bad event payload) must never crash the viewer
  s.createRun("rcorrupt1", "Run with damaged rows", repo);
  ev("rcorrupt1", "x", "task_started", {});
  // rplanfail: planning failed before any plan existed
  s.createRun("rplanfail", "Plan that never was", repo);
  ev("rplanfail", null, "task_failed", { reason: "planning failed: Claude: timeout; Codex: no auth" });
  s.close();

  const raw = openRaw(dbPath);
  const base = Date.now();
  const age: Record<string, number> = { rsingle1: 2 * HOUR, rthree3x: 5 * HOUR, rfailed4: 26 * HOUR, rabort55: 3 * 24 * HOUR, rold00001: 10 * 24 * HOUR, rcorrupt1: 11 * 24 * HOUR, rplanfail: 12 * 24 * HOUR };
  for (const [id, ms] of Object.entries(age)) {
    raw.prepare("UPDATE runs SET created = created - ? WHERE id=?").run(ms, id);
    // shift events into the past too, so nothing looks like it is running now
    raw.prepare("UPDATE events SET ts = ts - ? WHERE run_id=?").run(ms, id);
  }
  raw.prepare("INSERT INTO phases VALUES ('rcorrupt1', 1, '{not json', 'x', 'done')").run();
  raw.prepare("INSERT INTO plans VALUES ('rcorrupt1', '{also not json')").run();
  raw.prepare("INSERT INTO events (run_id, task_id, agent_id, ts, type, payload) VALUES ('rcorrupt1','x','x',?, 'usage', '{{{')").run(base - 11 * 24 * HOUR);
  raw.close();
  return repo;
}
