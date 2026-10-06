import { redact } from "./redact.js";

/** Cap of the whole `<history>` text handed to the re-planner (the oldest phases lose their details first). */
export const HISTORY_MAX_CHARS = 8000;
const VERIFY_TAIL_CHARS = 500;
const DIFF_STAT_CHARS = 3000;

export interface HistoryTask {
  id: string; role: string; status: string;
  /** Workspace runs: the repo the task worked in. */
  repo?: string;
  /** Why a failed/blocked task did not finish (`failed:budget`, `failed:timeout`, `failed:verify`, ...). */
  reason?: string;
  /** Blackboard texts (already capped by the blackboard). */
  summary?: string; decisions?: string; openQuestions?: string;
  /** wip branch of a FAILED writer (`mar/<runId>/<id>`). */
  branch?: string;
}
export interface HistoryIntegration {
  /** Workspace runs: the repo this integration branch lives in. */
  repo?: string;
  branch?: string; merged: string[];
  conflict?: { branch: string; files: string[] };
  verify?: { ok: boolean; command?: string; tail: string };
  error?: string;
  /** `git diff --stat` of the integration branch vs the run's base commit. */
  diffStat?: string;
}
/** A DONE writer branch that is not part of the integration branch. `conflictFiles`: the integration stopped at exactly this branch. */
export interface HistoryUnmerged { task: string; branch: string; repo?: string; conflictFiles?: string[] }
/** A task that could not start because merging one of its dependency branches conflicted. */
export interface HistoryDepConflict { task: string; dependency: string; repo?: string; files: string[] }
/** Two parallel writers that both changed the same files outside their declared paths. */
export interface HistoryPredicted { tasks: string[]; files: string[] }
/** `integrations` (one per repo) is used by workspace runs instead of `integration`. */
export interface HistoryPhase {
  phase: number; tasks: HistoryTask[]; integration?: HistoryIntegration; integrations?: HistoryIntegration[];
  /** Recovery context (the latest phase): done writer branches missing from the integration branch. */
  unmerged?: HistoryUnmerged[];
  depConflicts?: HistoryDepConflict[]; predicted?: HistoryPredicted[];
}

const MAX_ENTRIES = 20;
const MAX_FILES = 20;

const one = (s: string) => redact(s).replace(/\r/g, "");
const indent = (s: string, pad: string) => one(s).split("\n").map((l) => pad + l).join("\n");

function renderTask(t: HistoryTask): string {
  const out = [`- ${t.id} [${t.role}${t.repo ? ` @${t.repo}` : ""}] ${t.status}${t.reason ? ` (${one(t.reason)})` : ""}`];
  if (t.summary) out.push(`  summary:\n${indent(t.summary, "    ")}`);
  if (t.decisions && t.decisions !== "(none)") out.push(`  decisions:\n${indent(t.decisions, "    ")}`);
  if (t.openQuestions && t.openQuestions !== "(none)") out.push(`  open_questions:\n${indent(t.openQuestions, "    ")}`);
  if (t.branch) out.push(`  partial work is on that branch; a continuation task may inspect it with \`git diff\`/\`git show\` (it is committed there, for example \`git diff <base>...<branch>\`): ${t.branch}`);
  return out.join("\n");
}

function renderIntegration(i: HistoryIntegration): string {
  const out: string[] = [];
  const label = i.repo ? `Integration of repo ${i.repo}` : "Integration";
  if (i.error) out.push(`${label}: failed (${one(i.error)})`);
  else {
    out.push(`${i.repo ? `Integration branch of repo ${i.repo}` : "Integration branch"} ${i.branch ?? "(none)"}: merged ${i.merged.length ? i.merged.join(", ") : "nothing"}`);
    if (i.conflict) out.push(`  conflict at ${i.conflict.branch}: ${i.conflict.files.join(", ") || "(unknown files)"}`);
    if (i.verify) out.push(i.verify.ok ? "  verify passed" : `  verify failed${i.verify.command ? ` (${one(i.verify.command)})` : ""}:\n${indent(redact(i.verify.tail).slice(-VERIFY_TAIL_CHARS), "    | ")}`);
  }
  if (i.diffStat) out.push(`Diff stat of the integration branch vs the run's base commit:\n${indent(redact(i.diffStat).slice(0, DIFF_STAT_CHARS), "  ")}`);
  return out.join("\n");
}

const fileList = (files: string[]) => {
  const shown = files.slice(0, MAX_FILES).map(one).join(", ") || "(unknown files)";
  return files.length > MAX_FILES ? `${shown} (+${files.length - MAX_FILES} more)` : shown;
};
const more = (n: number, shown: number) => (n > shown ? [`  ...and ${n - shown} more`] : []);

function renderRecovery(p: HistoryPhase): string[] {
  const out: string[] = [];
  const un = p.unmerged ?? [];
  if (un.length) {
    out.push("Done writer branches NOT merged into the integration branch (re-apply them on top of its tip, resolving conflicts):");
    for (const u of un.slice(0, MAX_ENTRIES))
      out.push(`- ${one(u.branch)}${u.repo ? ` @${one(u.repo)}` : ""}${u.conflictFiles ? ` (integration stopped here: conflict in ${fileList(u.conflictFiles)})` : ""}`);
    out.push(...more(un.length, MAX_ENTRIES));
  }
  const dc = p.depConflicts ?? [];
  if (dc.length) {
    out.push("Tasks that could not start because merging a dependency branch conflicted:");
    for (const c of dc.slice(0, MAX_ENTRIES))
      out.push(`- ${one(c.task)} failed: dependency ${one(c.dependency)}${c.repo ? ` (sibling repo ${one(c.repo)})` : ""} conflicted in ${fileList(c.files)}`);
    out.push(...more(dc.length, MAX_ENTRIES));
  }
  const pr = p.predicted ?? [];
  if (pr.length) {
    out.push("Parallel tasks that both changed the same files outside their declared paths:");
    for (const c of pr.slice(0, MAX_ENTRIES)) out.push(`- ${c.tasks.map(one).join(" and ")}: ${fileList(c.files)}`);
    out.push(...more(pr.length, MAX_ENTRIES));
  }
  return out;
}

const header = (p: HistoryPhase) => {
  const n = (s: string) => p.tasks.filter((t) => t.status === s).length;
  return `## Phase ${p.phase} (${n("done")} done, ${n("failed")} failed, ${n("blocked")} blocked)`;
};
const full = (p: HistoryPhase) => [header(p), ...p.tasks.map(renderTask), ...(p.integrations ?? (p.integration ? [p.integration] : [])).map(renderIntegration), ...renderRecovery(p)].join("\n");
// One line: the task ids by outcome, no details.
const compact = (p: HistoryPhase) => `${header(p)} details omitted: ${p.tasks.map((t) => `${t.id} ${t.status}`).join(", ")}`;

/**
 * Compact text of everything finished so far, oldest phase first, capped at `maxChars`. When it is too long the OLDEST
 * phases lose their details first (collapsed to one line, then dropped); the latest phase is kept and only clipped as a
 * last resort. Redacted; the caller must still defang it before embedding it in a prompt.
 */
export function buildHistory(phases: HistoryPhase[], maxChars = HISTORY_MAX_CHARS): string {
  if (phases.length === 0) return "";
  const parts: (string | null)[] = phases.map(full); // null = dropped
  const render = () => parts.filter((p): p is string => p !== null).join("\n\n");
  const lastIdx = phases.length - 1;
  for (let i = 0; i < lastIdx && render().length > maxChars; i++) parts[i] = compact(phases[i]);
  for (let i = 0; i < lastIdx && render().length > maxChars; i++) parts[i] = null;
  let text = render();
  if (parts.slice(0, lastIdx).some((p) => p === null)) text = "(earlier phases omitted)\n\n" + text;
  if (text.length > maxChars) {
    const note = "\n…(truncated)";
    text = text.slice(0, Math.max(0, maxChars - note.length)) + note;
  }
  return text;
}
