import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Dag, Role, Runtime, StoredEvent, TaskSpec, Tier } from "@mar/core";
import { Store, startServer } from "@mar/server";
import { redact } from "@mar/orchestrator";
import { renderAnswer, reportPath } from "./answer.js";
import { renderPlanTable } from "./phaseOutput.js";
import { sanitizeForTerminal } from "./sanitize.js";

/** A signal arriving this soon after the previous one is a duplicate delivery, not a second Ctrl-C. */
export const SIGNAL_DEBOUNCE_MS = 1000;
/** Newest event younger than this AND a task in `running` => the run is shown as `running` (a heuristic, see summarizeRun). */
export const RUNNING_WINDOW_MS = 120_000;
export const MIN_PREFIX = 3;
const MAX_TAIL = 500;

export type RunStatus = "done" | "failed" | "blocked" | "incomplete" | "planning-failed" | "running" | "stopped";

export interface HistoryCli {
  cmd: "history"; repo: string; runId?: string; limit: number; json: boolean; task?: string; ui: boolean; port: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure: status derivation
// ---------------------------------------------------------------------------------------------------------------

export interface SummarizeInput {
  /** Planned phases in order (empty = the run never got a plan). */
  phases: { phase: number; taskIds: readonly string[]; remaining: string }[];
  statuses: ReadonlyMap<string, { status: string; detail?: string | null }>;
  /** Reason of a run-level (task-less) `task_failed` event, i.e. phase 1 planning failed. */
  plannerFailure?: string;
  lastEventTs?: number;
  now: number;
}
export interface RunSummary { status: RunStatus; phases: number; tasksDone: number; tasksTotal: number; remaining: string; stopReason?: string }

/**
 * Derives a run's status from what is stored (nothing records "the run ended", so this is inference).
 * Order: planning-failed (no plan + planner failure) -> running -> failed -> blocked -> incomplete -> done -> stopped.
 * `running` is a HEURISTIC: the newest event is < RUNNING_WINDOW_MS old AND some task is still `running`. A run killed
 * with SIGKILL looks `running` for its last 2 minutes; after that its dangling `running` task makes it `stopped`.
 * The stop reason is only known when it can be read back: planner failure text, an "abort" in a task reason, or the
 * phase limit (everything done but work remains; the cause, phase or token limit, is not stored).
 */
export function summarizeRun(i: SummarizeInput): RunSummary {
  const ids = [...new Set(i.phases.flatMap((p) => p.taskIds))];
  const stat = (id: string) => i.statuses.get(id)?.status ?? "not-run";
  const count = (s: string) => ids.filter((id) => stat(id) === s).length;
  const done = count("done"), failed = count("failed"), blocked = count("blocked"), running = count("running");
  const remaining = i.phases.at(-1)?.remaining.trim() ?? "";
  const base = { phases: i.phases.length, tasksDone: done, tasksTotal: ids.length, remaining };
  const aborted = ids.some((id) => /abort/i.test(i.statuses.get(id)?.detail ?? ""));
  const withReason = (status: RunStatus, stopReason?: string): RunSummary => ({ status, ...base, ...(stopReason ? { stopReason } : {}) });

  if (ids.length === 0) return i.plannerFailure ? withReason("planning-failed", i.plannerFailure) : withReason("stopped");
  const fresh = i.lastEventTs !== undefined && i.now - i.lastEventTs < RUNNING_WINDOW_MS;
  if (running > 0 && fresh) return withReason("running");
  if (failed > 0) return withReason("failed", aborted ? "aborted" : undefined);
  if (blocked > 0) return withReason("blocked", aborted ? "aborted" : undefined);
  if (done === ids.length) return remaining ? withReason("incomplete", "limit reached with work remaining") : withReason("done");
  if (running > 0) return withReason("stopped");
  return withReason("incomplete", "run stopped before all tasks started");
}

// ---------------------------------------------------------------------------------------------------------------
// Pure: formatting, prefix resolution, list rendering
// ---------------------------------------------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, "0");
/** Local time, `YYYY-MM-DD HH:mm`. */
export const formatDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
export const relativeTime = (ms: number, now: number): string => {
  const s = Math.floor((now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};
export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${p2(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${p2(m % 60)}m`;
};
export const formatTokens = (n: number | null): string => (n === null ? "n/a" : n.toLocaleString("en-US"));

const flat = (s: string) => sanitizeForTerminal(redact(s)).replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…");

export type Resolve = { kind: "ok"; id: string } | { kind: "ambiguous"; matches: string[] } | { kind: "unknown" } | { kind: "short" };
/** Exact id, else a UNIQUE prefix of at least MIN_PREFIX characters. */
export function resolveRunId(ids: readonly string[], query: string): Resolve {
  if (ids.includes(query)) return { kind: "ok", id: query };
  if (query.length < MIN_PREFIX) return ids.some((id) => id.startsWith(query)) ? { kind: "short" } : { kind: "unknown" };
  const matches = ids.filter((id) => id.startsWith(query));
  if (matches.length === 1) return { kind: "ok", id: matches[0]! };
  return matches.length ? { kind: "ambiguous", matches } : { kind: "unknown" };
}

export interface ListRow {
  id: string; goal: string; created: number; status: RunStatus; phases: number; tasksDone: number; tasksTotal: number;
  tokens: number | null; remaining: string; stopReason?: string;
  /** Workspace runs: the repo folder names (empty for a single-repo run). */
  repos?: string[];
}
const MIN_GOAL = 10;
const GAP = "  ";

export function renderRunTable(rows: readonly ListRow[], columns: number, now: number): string {
  const cells = rows.map((r) => [
    sanitizeForTerminal(r.id), `${formatDate(r.created)} (${relativeTime(r.created, now)})`, r.status, String(r.phases),
    `${r.tasksDone}/${r.tasksTotal}`, formatTokens(r.tokens),
  ]);
  const head = ["ID", "DATE", "STATUS", "PHASES", "TASKS", "TOKENS"];
  const widths = head.map((h, c) => Math.max(h.length, ...cells.map((r) => r[c]!.length)));
  const goalWidth = Math.max(MIN_GOAL, columns - widths.reduce((a, w) => a + w + GAP.length, 0));
  const fmt = (r: string[], goal: string) => r.map((v, c) => (c === 5 ? v.padStart(widths[c]!) : v.padEnd(widths[c]!))).join(GAP) + GAP + goal;
  return [fmt(head, "GOAL"), ...rows.map((r, i) => fmt(cells[i]!, clip(flat(r.goal), goalWidth)))].join("\n");
}

/** Stable machine-readable list: no table, no footer. */
export const listJson = (rows: readonly ListRow[]): string =>
  JSON.stringify(rows.map((r) => ({
    id: r.id, goal: r.goal, created: new Date(r.created).toISOString(), status: r.status, phases: r.phases,
    tasksDone: r.tasksDone, tasksTotal: r.tasksTotal, tokens: r.tokens, remaining: r.remaining, stopReason: r.stopReason ?? null,
    repos: r.repos ?? [],
  })), null, 2);

// ---------------------------------------------------------------------------------------------------------------
// Loading (read-only Store; corrupt rows degrade to a note)
// ---------------------------------------------------------------------------------------------------------------

interface PhaseData { phase: number; tasks: TaskSpec[]; remaining: string; status: string }
interface RunRow { id: string; goal: string; repo: string; created: number }
interface Loaded {
  repos: string[];
  run: RunRow; phases: PhaseData[]; summary: RunSummary; tokens: number | null; notes: string[];
  statuses: Map<string, { status: string; detail: string | null }>;
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Tolerates hand-edited or damaged plans: only entries with a string id survive, missing fields get placeholders. */
function normTasks(dag: Dag | undefined): TaskSpec[] {
  const raw: unknown = dag && (dag as unknown as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return [];
  const out: TaskSpec[] = [];
  for (const t of raw as unknown[]) {
    if (!isRec(t) || typeof t.id !== "string") continue;
    out.push({
      ...(t as unknown as TaskSpec), id: t.id, role: str(t.role, "?") as Role, runtime: str(t.runtime, "?") as Runtime, tier: str(t.tier, "?") as Tier,
      goal: str(t.goal), dependsOn: strs(t.dependsOn), needs: strs(t.needs), paths: strs(t.paths),
    });
  }
  return out;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

function loadPhases(store: Store, runId: string, notes: string[]): PhaseData[] {
  let rows: ReturnType<Store["listPhases"]> = [];
  try { rows = store.listPhases(runId); } catch (e) { notes.push(`phase rows are unreadable (${errText(e)}); showing the stored plan instead`); }
  if (rows.length) return rows.map((r) => ({ phase: r.phase, tasks: normTasks(r.dag), remaining: str(r.remaining), status: str(r.status) }));
  // Runs from before phases existed (or with damaged phase rows): the single plan is one phase with nothing remaining.
  try {
    const dag = store.loadPlan(runId);
    if (dag) return [{ phase: 1, tasks: normTasks(dag), remaining: "", status: "" }];
  } catch (e) { notes.push(`the stored plan is unreadable (${errText(e)})`); }
  return [];
}

function load(store: Store, run: RunRow, now: number): Loaded {
  const notes: string[] = [];
  const phases = loadPhases(store, run.id, notes);
  const statuses = new Map(store.taskStatuses(run.id).map((s) => [s.task_id, { status: s.status, detail: s.detail }]));
  const failure = store.eventsOfType(run.id, ["task_failed"]).filter((e) => e.task_id === null).at(-1);
  const summary = summarizeRun({
    phases: phases.map((p) => ({ phase: p.phase, taskIds: p.tasks.map((t) => t.id), remaining: p.remaining })), statuses,
    ...(failure ? { plannerFailure: flat(str(failure.payload.reason, "planning failed")) } : {}),
    ...(store.lastEventTs(run.id) !== undefined ? { lastEventTs: store.lastEventTs(run.id) } : {}), now,
  });
  const used = store.usageTokens(run.id);
  return { run, phases, summary, tokens: used > 0 ? used : null, notes, statuses, repos: workspaceRepos(store, run.id) };
}

/** Repo folder names of a workspace run (from its `run_started` event); [] for a single-repo run. */
function workspaceRepos(store: Store, runId: string): string[] {
  try {
    const p = store.eventsOfType(runId, ["run_started"]).at(-1)?.payload;
    return p && p.mode === "workspace" ? strs(p.repos) : [];
  } catch { return []; }
}

const toRow = (l: Loaded): ListRow => ({
  repos: l.repos,
  id: l.run.id, goal: l.run.goal, created: l.run.created, status: l.summary.status, phases: l.summary.phases,
  tasksDone: l.summary.tasksDone, tasksTotal: l.summary.tasksTotal, tokens: l.tokens, remaining: l.summary.remaining,
  ...(l.summary.stopReason ? { stopReason: l.summary.stopReason } : {}),
});

// ---------------------------------------------------------------------------------------------------------------
// Detail rendering
// ---------------------------------------------------------------------------------------------------------------

function integrationLines(events: readonly StoredEvent[], phase: number): string[] {
  const ofPhase = events.filter((x) => (typeof x.payload.phase === "number" ? x.payload.phase : 1) === phase);
  // One result per repo (the last one); a single-repo run has a single, unlabelled group.
  const groups = new Map<string, StoredEvent>();
  for (const e of ofPhase) groups.set(typeof e.payload.repo === "string" ? e.payload.repo : "", e);
  return [...groups].flatMap(([repo, e]) => oneIntegration(e, repo));
}

function oneIntegration(e: StoredEvent, repo: string): string[] {
  const p = e.payload;
  const tag = repo ? ` [${flat(repo)}]` : "";
  if (typeof p.branch !== "string") return [`  Integration failed${tag}: ${flat(str(p.error, "unknown error"))}`];
  const merged = strs(p.merged).map((b) => b.split("/").pop()).join(", ") || "nothing";
  const lines: string[] = [];
  if (isRec(p.conflict)) {
    lines.push(`  Integration stopped${tag} at ${flat(str(p.conflict.branch))}: conflict in ${strs(p.conflict.files).map(flat).join(", ") || "(unknown files)"}`);
    lines.push(`    Merged so far (kept on ${flat(p.branch)}): ${merged}`);
    return lines;
  }
  const v = isRec(p.verify) ? p.verify : undefined;
  if (v && v.ok === false) {
    const f = isRec(v.failed) ? v.failed : undefined;
    lines.push(`  Integration${tag}: ${flat(p.branch)} (merged ${merged}; verify failed (${flat(str(f?.command, "unknown"))}${f?.timedOut === true ? ", timed out" : ""}))`);
    const tail = sanitizeForTerminal(redact(str(v.tail))).slice(-MAX_TAIL);
    if (tail) lines.push(...tail.split("\n").map((l) => `    | ${l}`));
  } else lines.push(`  Integration${tag}: ${flat(p.branch)} (merged ${merged}${v ? "; verify passed" : ""})`);
  return lines;
}

export type BranchExists = (repo: string, branch: string) => Promise<boolean>;
/** Best effort and read-only: `git rev-parse --verify`; any failure (no git, not a repo, no such branch) reads as "no". */
export const gitBranchExists: BranchExists = (repo, branch) =>
  new Promise((done) => {
    try {
      execFile("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err) => done(!err));
    } catch { done(false); }
  });

async function renderDetail(store: Store, l: Loaded, now: number, branchExists: BranchExists): Promise<string> {
  const { run, phases, summary } = l;
  const out: string[] = [];
  const last = store.lastEventTs(run.id);
  const limit = store.eventsOfType(run.id, ["phase_started"]).at(-1)?.payload.maxPhases;
  out.push(`Run ${run.id}`);
  out.push(`Goal:      ${sanitizeForTerminal(run.goal)}`);
  out.push(`Repo:      ${flat(run.repo)}`);
  if (l.repos.length) out.push(`Repos:     ${l.repos.map(flat).join(", ")}`);
  out.push(`Started:   ${formatDate(run.created)} (${relativeTime(run.created, now)})`);
  out.push(`Duration:  ${last !== undefined && last >= run.created ? formatDuration(last - run.created) : "n/a"}`);
  out.push(`Status:    ${summary.status}${summary.stopReason ? ` (${flat(summary.stopReason)})` : ""}`);
  out.push(`Phases:    ${summary.phases}${typeof limit === "number" ? ` (limit ${limit})` : ""}`);
  out.push(`Tasks:     ${summary.tasksDone}/${summary.tasksTotal} done`);
  out.push(`Tokens:    ${formatTokens(l.tokens)}`);
  if (summary.remaining) out.push(`Remaining: ${flat(summary.remaining)}`);
  for (const n of l.notes) out.push(`Note:      ${n}`);

  const integrations = store.eventsOfType(run.id, ["integration"]);
  const shared = new Map(store.eventsOfType(run.id, ["task_started"]).flatMap((e) => (e.task_id ? [[e.task_id, e.payload.worktree === "shared"] as const] : [])));
  const multi = phases.length > 1;
  for (const p of phases) {
    out.push("", `== Phase ${p.phase} ==`);
    if (p.tasks.length === 0) { out.push("(no tasks)"); continue; }
    out.push(renderPlanTable(p.tasks, (t) => shared.get(t.id) === true, { workspace: l.repos.length > 0 }));
    const branches = await Promise.all(p.tasks.map(async (t) => {
      const name = `mar/${run.id}/${t.id}`;
      // Workspace runs: the branch lives in the task's repo folder under the run root.
      const where = l.repos.length > 0 ? (t.repo !== undefined ? join(run.repo, t.repo) : undefined) : run.repo;
      return where !== undefined && (await branchExists(where, name)) ? name : undefined;
    }));
    p.tasks.forEach((t, i) => {
      const s = l.statuses.get(t.id);
      out.push(`  ${flat(t.id)}  ${s?.status ?? "not-run"}${s?.detail ? ` (${flat(s.detail)})` : ""}${branches[i] ? `  ${l.repos.length > 0 && t.repo ? `${flat(t.repo)}:` : ""}${flat(branches[i]!)}` : ""}`);
    });
    out.push(...integrationLines(integrations, p.phase));
    if (p.remaining.trim()) out.push(`  Remaining after this phase: ${flat(p.remaining)}`);
  }

  const reports = new Map(store.listReports(run.id).map((r) => [r.task_id, r.body]));
  const states = new Map([...l.statuses]);
  let any = false;
  for (const p of phases) {
    const summaries = new Map(p.tasks.flatMap((t) => { const b = store.latestBb(run.id, `${t.id}/summary`)?.body; return b ? [[t.id, b] as const] : []; }));
    const answer = renderAnswer({ tasks: p.tasks }, states, reports, summaries);
    if (!answer) continue;
    if (!any) out.push("", "ANSWER");
    any = true;
    out.push(`${multi ? `-- Phase ${p.phase} --\n` : ""}${answer}`);
  }
  if (!any) out.push("", "No reports or summaries were stored for this run.");
  const saved = [...reports.keys()].flatMap((id) => { try { const f = reportPath(run.repo, run.id, id); return existsSync(f) ? [f] : []; } catch { return []; } });
  if (saved.length) out.push("", "Saved reports:", ...saved.map((f) => `  ${sanitizeForTerminal(f)}`));
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------------------------

type Server = Awaited<ReturnType<typeof startServer>>;
export interface HistoryDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => number;
  columns?: number;
  branchExists?: BranchExists;
  startServer?: (store: Store, opts: Parameters<typeof startServer>[1]) => Promise<Server>;
  uiDist?: string | undefined;
  proc?: Pick<NodeJS.Process, "on" | "off">;
  exit?: (code: number) => void;
  forceExitTimeoutMs?: number;
}

export const NO_RUNS = (repo: string) => `No mar runs found in ${repo} (no .mar/mar.db).`;

/** `mar history`: reads `<repo>/.mar/mar.db` through a read-only snapshot. Never writes to the DB, the repo or the worktrees. */
export async function runHistory(cli: HistoryCli, d: HistoryDeps = {}): Promise<number> {
  const out = d.out ?? ((l: string) => console.log(l));
  const err = d.err ?? ((l: string) => console.error(l));
  const now = (d.now ?? Date.now)();
  const repo = resolve(cli.repo);
  const dbPath = join(repo, ".mar", "mar.db");
  const show = (text: string) => out(sanitizeForTerminal(text));

  if (!existsSync(dbPath)) {
    if (cli.runId !== undefined) { err(`mar: no run "${sanitizeForTerminal(cli.runId)}" in ${repo} (no .mar/mar.db)`); return 1; }
    out(cli.json ? "[]" : NO_RUNS(repo));
    return 0;
  }
  let store: Store;
  try { store = new Store(dbPath, { readOnly: true }); } catch (e) {
    err(`mar: cannot read ${dbPath}: ${redact(errText(e))}`);
    return 1;
  }
  let keepOpen = false;
  try {
    let runs: RunRow[];
    try { runs = store.listRuns(); } catch (e) { err(`mar: cannot read ${dbPath}: ${redact(errText(e))}`); return 1; }
    let target: RunRow | undefined;
    if (cli.runId !== undefined) {
      const r = resolveRunId(runs.map((x) => x.id), cli.runId);
      const q = sanitizeForTerminal(cli.runId);
      if (r.kind === "short") { err(`mar: run id prefix "${q}" is too short (at least ${MIN_PREFIX} characters)`); return 2; }
      if (r.kind === "unknown") { err(`mar: no run "${q}" in ${repo}; list runs with \`mar history\``); return 1; }
      if (r.kind === "ambiguous") {
        err(`mar: "${q}" matches ${r.matches.length} runs; use a longer prefix:`);
        for (const id of r.matches) err(`  ${sanitizeForTerminal(id)}`);
        return 2;
      }
      target = runs.find((x) => x.id === r.id);
    } else target = runs[0];

    if (cli.ui) {
      if (!target) { out(NO_RUNS(repo)); return 0; }
      keepOpen = true;
      return await serve(store, target.id, cli, d, out, err);
    }

    if (cli.task !== undefined) {
      if (!target) { err(`mar: no run in ${repo}`); return 1; }
      const body = store.listReports(target.id).find((r) => r.task_id === cli.task)?.body ?? store.latestBb(target.id, `${cli.task}/summary`)?.body;
      if (body === undefined) { err(`mar: run ${target.id} has no report or summary for task "${sanitizeForTerminal(cli.task)}"`); return 1; }
      out(sanitizeForTerminal(body));
      return 0;
    }

    if (target && cli.runId !== undefined) {
      show(await renderDetail(store, load(store, target, now), now, d.branchExists ?? gitBranchExists));
      return 0;
    }

    if (runs.length === 0) { out(cli.json ? "[]" : NO_RUNS(repo)); return 0; }
    const shown = runs.slice(0, cli.limit).map((r) => toRow(load(store, r, now)));
    if (cli.json) { out(sanitizeForTerminal(listJson(shown))); return 0; }
    show(renderRunTable(shown, d.columns ?? process.stdout.columns ?? 100, now));
    out("");
    out(`${shown.length} run${shown.length === 1 ? "" : "s"} shown (${runs.length} total). Details: mar history <id>`);
    return 0;
  } catch (e) {
    err(`mar: ${redact(errText(e))}`);
    return 1;
  } finally {
    if (!keepOpen) { try { store.close(); } catch { /* already closed */ } }
  }
}

async function serve(store: Store, runId: string, cli: HistoryCli, d: HistoryDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const proc = d.proc ?? process;
  const exit = d.exit ?? ((c: number) => process.exit(c));
  const now = d.now ?? Date.now;
  let server: Server;
  try { server = await (d.startServer ?? startServer)(store, { port: cli.port, staticDir: d.uiDist, readOnly: true }); }
  catch (e) {
    store.close();
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") err(`mar: port ${cli.port} is already in use; pick another with --port`);
    else err(`mar: could not start server: ${redact(errText(e))}`);
    return 1;
  }
  out(`UI: http://127.0.0.1:${server.port}/?run=${encodeURIComponent(runId)}`);
  if (!d.uiDist) out("Note: UI is not built (packages/ui/dist missing); only the API is served.");
  out("Read-only history view. Press Ctrl-C to stop.");
  const closeAll = async () => {
    await server.close().catch(() => {});
    try { store.close(); } catch { /* already closed */ }
  };
  await new Promise<void>((resolveDone) => {
    let signals = 0, lastAt = 0;
    const onSignal = () => {
      const t = now();
      if (signals > 0 && t - lastAt < SIGNAL_DEBOUNCE_MS) return;
      lastAt = t;
      if (++signals === 1) { void closeAll().then(() => { cleanup(); resolveDone(); }); return; }
      const timeout = new Promise<void>((r) => setTimeout(r, d.forceExitTimeoutMs ?? 2000).unref());
      void Promise.race([closeAll(), timeout]).finally(() => exit(130));
    };
    const cleanup = () => { for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) proc.off(s, onSignal); };
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) proc.on(s, onSignal);
  });
  return 0;
}
