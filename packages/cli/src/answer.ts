import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Dag } from "@mar/core";
import { sanitizeForTerminal as clean } from "./sanitize.js";

export type TaskState = { status: string; detail?: string | null };

// Tasks no other task depends on (leaves of the DAG), in plan order.
export const finalTasks = (dag: Dag) => {
  const depended = new Set(dag.tasks.flatMap((t) => t.dependsOn));
  return dag.tasks.filter((t) => !depended.has(t.id));
};

/**
 * Text printed at the end of a run: the full report of each final task (or its blackboard summary when it has none).
 * If a final task did not finish, say so and also show reports of other done tasks so their work is not hidden.
 * Returns "" when there is nothing to show. Reports are printed as stored, minus terminal escape sequences and control characters.
 */
export function renderAnswer(
  dag: Dag | undefined, statuses: Map<string, TaskState>, reports: Map<string, string>, summaries: Map<string, string>,
): string {
  if (!dag) return "";
  const stateOf = (id: string) => statuses.get(id) ?? { status: "not-run" };
  const parts: string[] = [];
  const shown = new Set<string>();
  let unfinished = false;
  for (const t of finalTasks(dag)) {
    const { status, detail } = stateOf(t.id);
    if (status !== "done") {
      unfinished = true;
      parts.push(`== ${clean(t.id)}: ${clean(status)}${detail ? ` (${clean(detail)})` : ""} ==\n`);
      continue;
    }
    const report = reports.get(t.id);
    const summary = summaries.get(t.id);
    if (report) parts.push(`== Answer: ${clean(t.id)} ==\n${clean(report)}\n`);
    else if (summary) parts.push(`== Answer: ${clean(t.id)} == (summary only)\n${clean(summary)}\n`);
    else continue;
    shown.add(t.id);
  }
  if (unfinished) {
    const partial = dag.tasks.filter((t) => stateOf(t.id).status === "done" && !shown.has(t.id) && reports.get(t.id));
    if (partial.length) {
      parts.push("== Partial results ==\n");
      for (const t of partial) parts.push(`== ${clean(t.id)} ==\n${clean(reports.get(t.id) ?? "")}\n`);
    }
  }
  return parts.join("\n");
}

/** `<repo>/.mar/reports/<runId>/<taskId>.md`, asserted to stay inside `<repo>/.mar/reports/<runId>`. */
export function reportPath(repo: string, runId: string, taskId: string): string {
  const root = resolve(repo, ".mar", "reports");
  const dir = resolve(root, runId);
  const p = resolve(dir, `${taskId}.md`);
  if (!dir.startsWith(root + sep) || !p.startsWith(dir + sep)) throw new Error(`refusing to write a report outside ${dir}`);
  return p;
}

/** Writes every report to disk and returns the paths. A failure on one file does not stop the others. */
export function saveReports(repo: string, runId: string, reports: { task_id: string; body: string }[]): { saved: string[]; errors: string[] } {
  const saved: string[] = [], errors: string[] = [];
  for (const r of reports) {
    try {
      const p = reportPath(repo, runId, r.task_id);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, r.body);
      saved.push(p);
    } catch (e) { errors.push(`${r.task_id}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { saved, errors };
}
