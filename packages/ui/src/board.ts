// Pure derivations behind the task board, the header status line and the problems strip.
// Event payloads are `unknown` (untrusted); every helper is total and returns plain strings for React text nodes.
import type { BbEntry, Dag, StoredEvent } from "@mar/core";
import { deriveSteps } from "./activity.js";
import type { AgentStatus, AgentView, PhaseInfo } from "./derive.js";
import { fmtCostShort, fmtEtaLeft } from "./fmt.js";
import type { ReportRow } from "./runClient.js";

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
export const clipText = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// ---- run state + header summary -------------------------------------------------------------------------------

export type RunState = { kind: "running" | "planning" | "done" | "failed" | "stopped"; label: string };
export type RunStateInput = {
  agents: AgentView[]; phase: PhaseInfo | null;
  /** The clock is ticking: some attempt is open and its task is not terminal (isRunActive). */
  active: boolean;
  /** A live (writable) connection; false for `mar history --ui`. */
  live: boolean;
  /** Server-provided stop reason (when /api/runs supplies it). */
  stop?: { reason: string; message: string } | null;
};

export function deriveRunState(i: RunStateInput): RunState {
  const { agents, phase } = i;
  if (i.stop) return { kind: "stopped", label: `Stopped: ${i.stop.message || i.stop.reason}` };
  const count = (s: AgentStatus) => agents.filter((a) => a.status === s).length;
  const failed = count("failed"), blocked = count("blocked"), pending = count("pending"), running = count("running");
  if (i.active || (i.live && (pending > 0 || running > 0))) return { kind: "running", label: "Running" };
  if (agents.length === 0) return i.live ? { kind: "planning", label: "Planning…" } : { kind: "stopped", label: "Stopped: no tasks were planned" };
  if (agents.some((a) => /abort/i.test(a.detail ?? ""))) return { kind: "stopped", label: "Stopped: the run was stopped" };
  const limitHit = phase !== null && phase.maxPhases !== null && phase.phase >= phase.maxPhases && phase.remaining.trim() !== "";
  if (limitHit) return { kind: "stopped", label: `Stopped: phase limit reached (${phase.phase}/${phase.maxPhases})` };
  if (failed > 0 || blocked > 0) return { kind: "failed", label: "Failed" };
  if (running > 0 || pending > 0) return { kind: "stopped", label: "Stopped: tasks never finished" };
  if (phase !== null && phase.remaining.trim() !== "") {
    return i.live ? { kind: "planning", label: "Planning next phase…" } : { kind: "stopped", label: "Stopped: work remains" };
  }
  return { kind: "done", label: "Done" };
}

export type SummaryInput = { agents: AgentView[]; phase: PhaseInfo | null; state: RunState; costUsd: number | null; etaMs: number | null; partial?: boolean };
/** `Phase 2/5 · 4 of 6 done · 2 running · $0.14 · ~2 min left`; unknowns read "n/a", never NaN. */
export function summarizeRun(i: SummaryInput): { parts: string[]; text: string } {
  const parts: string[] = [];
  const n = (s: AgentStatus) => i.agents.filter((a) => a.status === s).length;
  if (i.phase) parts.push(`Phase ${i.phase.phase}${i.phase.maxPhases !== null ? `/${i.phase.maxPhases}` : ""}`);
  parts.push(i.agents.length === 0 ? "no tasks yet" : `${n("done")} of ${i.agents.length} done`);
  if (n("running")) parts.push(`${n("running")} running`);
  if (n("failed")) parts.push(`${n("failed")} failed`);
  if (n("blocked")) parts.push(`${n("blocked")} blocked`);
  parts.push(i.costUsd === null ? "cost n/a" : `${i.partial ? "≥ " : ""}${fmtCostShort(i.costUsd)}`);
  if (i.state.kind === "running") {
    const active = i.agents.some((a) => a.status === "running" || a.status === "pending");
    // etaMs 0 with work still active means the running tasks are already past the average finished one.
    const eta = i.partial ? "ETA n/a" : i.etaMs === 0 && active ? "finishing up" : fmtEtaLeft(i.etaMs);
    if (eta) parts.push(eta);
  } else parts.push(i.state.label);
  return { parts, text: parts.join(" · ") };
}

// ---- reasons + problems ---------------------------------------------------------------------------------------

/** `failed:timeout` -> "Timed out"; unknown details are shown, minus the status prefix. */
export function reasonText(detail: string | undefined | null, status: AgentStatus = "failed"): string {
  const d = (detail ?? "").trim();
  const rest = d.replace(/^(failed|blocked)\s*:\s*/i, "").trim();
  if (/time-?out/i.test(rest)) return "Timed out";
  if (/abort/i.test(rest)) return "Aborted";
  if (rest === "") return status === "blocked" ? "Blocked by a failed dependency" : "Failed (no reason recorded)";
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export type Problem = {
  id: string; severity: "error" | "warning"; taskId: string | null; title: string; detail: string; files: string[]; moreFiles: number;
};
const MAX_FILES = 6;
const cap = (files: string[], count?: number) => ({ files: files.slice(0, MAX_FILES), moreFiles: Math.max(files.length, count ?? 0) - Math.min(files.length, MAX_FILES) });

export function deriveProblems(events: StoredEvent[], agents: AgentView[], state: RunState): Problem[] {
  // Latest event of each kind per task wins.
  const conflicts = new Map<string, { dependency: string | null; repo: string | null; files: string[] }>();
  const ownership = new Map<string, { files: string[]; count: number; enforced: boolean }>();
  const predicted = new Map<string, { tasks: string[]; files: string[] }>();
  for (const e of events) {
    const p = rec(e.payload);
    const id = e.task_id ?? str(p.task);
    if (!id) continue;
    if (e.type === "dependency_merge_conflict") conflicts.set(id, { dependency: str(p.dependency) ?? null, repo: str(p.repo) ?? null, files: strings(p.files) });
    else if (e.type === "ownership_violation") { const files = strings(p.files); ownership.set(id, { files, count: Math.max(files.length, num(p.count) ?? 0), enforced: p.enforced === true }); }
    else if (e.type === "predicted_conflict") predicted.set(`${id}\0${strings(p.tasks).join(",")}`, { tasks: strings(p.tasks), files: strings(p.files) });
  }
  const errors: Problem[] = [], blocked: Problem[] = [], warnings: Problem[] = [];
  const conflictShown = new Set<string>();
  for (const a of agents) {
    if (a.status !== "failed" && a.status !== "blocked") continue;
    const c = conflicts.get(a.id);
    const reason = reasonText(a.detail, a.status);
    const base = { id: `task:${a.id}`, severity: "error" as const, taskId: a.id };
    let p: Problem;
    if (c) {
      conflictShown.add(a.id);
      p = { ...base, title: a.id, detail: `Merge conflict${c.dependency ? ` merging dependency ${c.dependency}` : ""}${c.repo ? ` in ${c.repo}` : ""}`, ...cap(c.files) };
    } else p = { ...base, title: a.id, detail: reason, files: [], moreFiles: 0 };
    (a.status === "failed" ? errors : blocked).push(p);
  }
  for (const [id, c] of conflicts) {
    if (conflictShown.has(id) || !agents.some((a) => a.id === id)) continue;
    errors.push({ id: `conflict:${id}`, severity: "error", taskId: id, title: id, detail: `Merge conflict${c.dependency ? ` merging dependency ${c.dependency}` : ""}`, ...cap(c.files) });
  }
  for (const [id, o] of ownership) {
    if (!agents.some((a) => a.id === id)) continue;
    warnings.push({ id: `ownership:${id}`, severity: "warning", taskId: id, title: id,
      detail: `Changed ${o.count} ${o.count === 1 ? "file" : "files"} outside its declared paths${o.enforced ? " (task failed)" : ""}`, ...cap(o.files, o.count) });
  }
  for (const a of agents) for (const w of a.siblingWarnings ?? []) {
    warnings.push({ id: `sibling:${a.id}:${w.id}`, severity: "warning", taskId: a.id, title: a.id,
      detail: `Modified sibling repo ${w.repo} (${w.count} ${w.count === 1 ? "file" : "files"}); changes were reverted`, ...cap(w.files, w.count) });
  }
  for (const [key, pc] of predicted) {
    const id = key.split("\0")[0]!;
    warnings.push({ id: `predicted:${key}`, severity: "warning", taskId: agents.some((a) => a.id === id) ? id : null, title: pc.tasks.join(" + ") || id,
      detail: `May conflict when merged (${pc.files.length} shared ${pc.files.length === 1 ? "file" : "files"})`, ...cap(pc.files) });
  }
  const run: Problem[] = state.kind === "stopped"
    ? [{ id: "run:stopped", severity: "error", taskId: null, title: "Run stopped early", detail: state.label.replace(/^Stopped:\s*/, ""), files: [], moreFiles: 0 }] : [];
  return [...run, ...errors, ...blocked, ...warnings];
}

// ---- board ----------------------------------------------------------------------------------------------------

export type BoardChip = "all" | "running" | "failed" | "done";
export const CHIPS: { id: BoardChip; label: string }[] = [{ id: "all", label: "All" }, { id: "running", label: "Running" }, { id: "failed", label: "Failed" }, { id: "done", label: "Done" }];
const RANK: Record<AgentStatus, number> = { running: 0, failed: 1, blocked: 2, pending: 3, done: 4 };
const inChip = (s: AgentStatus, chip: BoardChip) => chip === "all" || (chip === "failed" ? s === "failed" || s === "blocked" : s === chip);

export function chipCounts(agents: AgentView[]): Record<BoardChip, number> {
  const out: Record<BoardChip, number> = { all: agents.length, running: 0, failed: 0, done: 0 };
  for (const a of agents) for (const c of ["running", "failed", "done"] as const) if (inChip(a.status, c)) out[c]++;
  return out;
}
export const matchesQuery = (a: AgentView, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === "" || [a.id, a.repo, a.role, a.runtime, a.tier, a.status, a.detail].some((v) => v !== undefined && v.toLowerCase().includes(q));
};

export type BoardGroup = { key: string; phase: number | null; title: string; summary: string; rows: AgentView[] };
const SUMMARY_ORDER: [AgentStatus, string][] = [["running", "running"], ["failed", "failed"], ["blocked", "blocked"], ["pending", "queued"], ["done", "done"]];
export const phaseSummary = (rows: AgentView[]) => SUMMARY_ORDER.flatMap(([s, w]) => { const n = rows.filter((r) => r.status === s).length; return n ? [`${n} ${w}`] : []; }).join(" · ");

/** Filter, group by phase (only when the run has more than one) and sort: running, failed, blocked, pending, done; stable by start time. */
export function groupBoard(agents: AgentView[], opts: { query?: string; chip?: BoardChip } = {}): BoardGroup[] {
  const phases = new Set(agents.map((a) => a.phase ?? 1));
  const phased = phases.size > 1;
  const order = new Map(agents.map((a, i) => [a.id, i]));
  const kept = agents.filter((a) => inChip(a.status, opts.chip ?? "all") && matchesQuery(a, opts.query ?? ""));
  const cmp = (a: AgentView, b: AgentView) => RANK[a.status] - RANK[b.status]
    || (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || order.get(a.id)! - order.get(b.id)!;
  const keys = phased ? [...phases].sort((a, b) => a - b) : [null];
  return keys.flatMap((phase) => {
    const rows = kept.filter((a) => phase === null || (a.phase ?? 1) === phase).sort(cmp);
    if (rows.length === 0) return [];
    const all = agents.filter((a) => phase === null || (a.phase ?? 1) === phase);
    return [{ key: String(phase ?? "all"), phase, title: phase === null ? "" : `Phase ${phase}`, summary: phaseSummary(all), rows }];
  });
}

// ---- "Now" column ---------------------------------------------------------------------------------------------

const BASHES = new Set(["Bash", "bash", "shell", "command_execution"]);
export const firstSentence = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  return clipText(m?.[1] ?? flat, max);
};

export type NowContext = { events: StoredEvent[]; blackboard: BbEntry[]; reports: ReportRow[]; plan: Dag | null; agents: AgentView[] };
/** One line saying what a task is doing (or did): the latest step, a summary, the reason it failed, what it waits on. */
export function deriveNowText(a: AgentView, taskEvents: StoredEvent[], ctx: Pick<NowContext, "blackboard" | "reports" | "plan" | "agents">): string {
  if (a.status === "running") {
    const steps = deriveSteps(taskEvents.slice(-400), a.id);
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]!;
      if (s.kind === "say") { const t = s.text.replace(/\s+/g, " ").trim(); if (t) return clipText(t, 160); continue; }
      return BASHES.has(s.name) ? `Bash: ${s.summary}` : s.summary ? `${s.name} ${s.summary}` : s.name;
    }
    return "Starting…";
  }
  if (a.status === "done") {
    const mine = ctx.blackboard.filter((b) => b.author_task === a.id);
    const entry = mine.filter((b) => b.kind === "summary" || b.key.endsWith("/summary")).at(-1);
    if (entry && entry.body.trim()) return firstSentence(entry.body);
    if (ctx.reports.some((r) => r.task_id === a.id)) return "Report ready";
    const any = mine.at(-1);
    return any && any.body.trim() ? firstSentence(any.body) : "Finished";
  }
  if (a.status === "failed") return reasonText(a.detail, "failed");
  if (a.status === "blocked") {
    const status = new Map(ctx.agents.map((x) => [x.id, x.status]));
    const deps = (ctx.plan?.tasks.find((t) => t.id === a.id)?.dependsOn ?? []).filter((d) => status.get(d) !== "done");
    return deps.length ? `waiting on ${deps.join(", ")}` : reasonText(a.detail, "blocked");
  }
  return "queued";
}

/** Per-task "Now" strings in one pass over the events (events are grouped by task first, so a big run stays cheap). */
export function deriveNowTexts(ctx: NowContext): Map<string, string> {
  const by = new Map<string, StoredEvent[]>();
  for (const e of ctx.events) if (e.task_id) { const l = by.get(e.task_id); if (l) l.push(e); else by.set(e.task_id, [e]); }
  return new Map(ctx.agents.map((a) => [a.id, deriveNowText(a, by.get(a.id) ?? [], ctx)]));
}

// ---- answer ---------------------------------------------------------------------------------------------------

/** Reports of the final (leaf) tasks: nothing depends on them and no other task `needs` their blackboard keys. Without a plan every report counts. */
export function deriveAnswer(plan: Dag | null, reports: ReportRow[]): ReportRow[] {
  if (reports.length === 0) return [];
  const tasks = plan?.tasks ?? [];
  const consumed = new Set(tasks.flatMap((t) => [...t.dependsOn, ...t.needs.map((n) => n.split("/")[0] ?? n)]));
  const leaves = tasks.filter((t) => !consumed.has(t.id)).map((t) => t.id);
  const picked = tasks.length === 0 ? reports : reports.filter((r) => leaves.includes(r.task_id));
  const rank = new Map(tasks.map((t, i) => [t.id, i]));
  return [...picked].sort((a, b) => (rank.get(a.task_id) ?? 1e9) - (rank.get(b.task_id) ?? 1e9));
}
