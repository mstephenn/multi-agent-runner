import type { TaskSpec } from "@mar/core";
import { redact, type PhaseStop } from "@mar/orchestrator";
import { sanitizeForTerminal as clean } from "./sanitize.js";

export const GOAL_COLUMN_CHARS = 70;
const MAX_PHASES_LIMIT = 10;

export const renderPhaseHeader = (phase: number, maxPhases: number) => `== Phase ${phase} (max ${maxPhases}) ==`;

const flat = (s: string) => clean(redact(s)).replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** Plan of one phase as an aligned text table: id, role, runtime/tier, depends, paths, worktree (shared|own), goal (clipped). */
export function renderPlanTable(tasks: readonly TaskSpec[], isShared: (t: TaskSpec) => boolean, opts: { workspace?: boolean } = {}): string {
  const ws = opts.workspace === true;
  const rows: string[][] = [ws ? ["id", "role", "repo", "runtime/tier", "depends", "paths", "worktree", "goal"] : ["id", "role", "runtime/tier", "depends", "paths", "worktree", "goal"]];
  for (const t of tasks) rows.push([
    t.id, t.role, ...(ws ? [clean(t.repo ?? "*")] : []), `${t.runtime}/${t.tier}`, t.dependsOn.length ? t.dependsOn.join(",") : "-", t.paths.length ? t.paths.map(flat).join(",") : "-",
    isShared(t) ? "shared" : "own", clip(flat(t.goal), GOAL_COLUMN_CHARS),
  ]);
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  ")).join("\n");
}

export interface SummaryRow { id: string; status: string; detail?: string | null; branch: string }

/** `-- Phase N --` header (omitted when `phase` is null, i.e. a single-phase run) and one `  id  status  (why)  branch` line per task. */
export function renderPhaseSummary(phase: number | null, rows: readonly SummaryRow[]): string {
  const lines = rows.map((r) => `  ${clean(r.id)}  ${clean(r.status)}${r.status === "failed" && r.detail ? `  (${clean(r.detail)})` : ""}  ${clean(r.branch)}`);
  return (phase === null ? lines : [`-- Phase ${phase} --`, ...lines]).join("\n");
}

/** Why the run stopped early, the work that is left and how to continue. */
export function renderStop(stop: PhaseStop, remaining: string, runId: string, maxPhases: number): string {
  const out = [`Stopped early: ${clean(redact(stop.message))}.`];
  if (remaining) out.push(`Remaining: ${flat(remaining)}`);
  const resume = `mar resume ${runId}`;
  switch (stop.reason) {
    case "max_phases":
      out.push(maxPhases < MAX_PHASES_LIMIT
        ? `Continue with: ${resume} --phases ${Math.min(MAX_PHASES_LIMIT, maxPhases + 3)}`
        : `The phase limit is already at its maximum (${MAX_PHASES_LIMIT}); start a new run for the remaining work.`);
      break;
    case "max_tokens": out.push(`Raise maxTotalTokens in .mar.json, then continue with: ${resume}`); break;
    case "no_progress": out.push(`Fix the cause (see the failed tasks above), then continue with: ${resume}`); break;
    case "aborted": out.push(`Continue with: ${resume}`); break;
    case "replan_failed": out.push(`Retry planning with: ${resume}`); break;
    case "recovery_stalled": out.push(`Recovery made no progress. Resolve the failures or conflicts by hand (see the tasks and the integration above; the work is on the mar/${runId}/... branches), then continue with: ${resume}`); break;
  }
  return out.join("\n");
}

export interface OwnershipRow { task: string; files: string[]; count: number }
const MAX_OWNERSHIP_LINES = 10;
const MAX_OWNERSHIP_FILES = 5;

/** One row per task from `ownership_violation` events (the latest per task); enforced ones already failed the task and are skipped. */
export function ownershipRows(events: readonly { task_id: string | null; payload: Record<string, unknown> }[]): OwnershipRow[] {
  const byTask = new Map<string, OwnershipRow>();
  for (const e of events) {
    if (e.task_id === null || e.payload.enforced === true) continue;
    const files = Array.isArray(e.payload.files) ? e.payload.files.filter((f): f is string => typeof f === "string") : [];
    byTask.set(e.task_id, { task: e.task_id, files, count: typeof e.payload.count === "number" ? e.payload.count : files.length });
  }
  return [...byTask.values()];
}

/** `Ownership warnings:` block (task -> files outside its declared paths, at most 10 lines), or "" when there are none. */
export function renderOwnershipWarnings(rows: readonly OwnershipRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.slice(0, MAX_OWNERSHIP_LINES).map((r) => {
    const shown = r.files.slice(0, MAX_OWNERSHIP_FILES).map(flat).join(", ");
    const extra = Math.max(r.count, r.files.length) - Math.min(r.files.length, MAX_OWNERSHIP_FILES);
    return `  ${clean(r.task)} -> ${shown}${extra > 0 ? ` (+${extra} more)` : ""}`;
  });
  if (rows.length > MAX_OWNERSHIP_LINES) lines.push(`  ...and ${rows.length - MAX_OWNERSHIP_LINES} more tasks`);
  return ["Ownership warnings (files changed outside the task's declared paths; parallel tasks that do this can conflict; set \"ownership\": \"enforce\" to fail them instead):", ...lines].join("\n");
}
