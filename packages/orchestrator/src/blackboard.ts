import { MAX_BB_BODY_CHARS, estimateTokens, type BbEntry, type TaskResult, type TaskSpec } from "@mar/core";
import { redact } from "./redact.js";
import type { Store } from "../../server/src/store.js";

export const clip = (s: string) => (s.length <= MAX_BB_BODY_CHARS ? s : s.slice(0, MAX_BB_BODY_CHARS - 1) + "…");

// Whole items only; if any are dropped, end with "…(+N more)" (marker included in the cap).
export function fitList(items: string[]): string {
  const n = items.length;
  for (let k = n; k >= 0; k--) {
    const kept = items.slice(0, k).join("\n");
    const body = k === n ? kept : `${kept}${k ? "\n" : ""}…(+${n - k} more)`;
    if (body.length <= MAX_BB_BODY_CHARS) return body;
  }
  return clip(`…(+${n} more)`);
}

export function publishResult(store: Store, runId: string, taskId: string, r: TaskResult, attempt?: number): BbEntry[] {
  const out: BbEntry[] = [];
  const put = (suffix: string, kind: BbEntry["kind"], body: string, refs: string[] = []) => {
    const e = store.writeBb({ run_id: runId, key: `${taskId}/${suffix}`, author_task: taskId, kind, body: clip(redact(body)), refs });
    store.appendEvent({ run_id: runId, task_id: taskId, agent_id: taskId, type: "blackboard_write", payload: { key: e.key, version: e.version, kind, ...(attempt === undefined ? {} : { attempt }) } });
    out.push(e);
  };
  // Every key is ALWAYS written (explicit "(none)" for empty lists) so a dependent's `needs` never misses a key
  // that the planner and parseDag allow it to ask for.
  const NONE = "(none)";
  put("summary", "summary", r.summary);
  put("decisions", "decision", r.decisions.length ? fitList(r.decisions.map((d) => `- ${redact(d)}`)) : NONE);
  put("open_questions", "open_question", r.openQuestions.length ? fitList(r.openQuestions.map((q) => `- ${redact(q)}`)) : NONE);
  const list = r.filesChanged.join("\n");
  if (!r.filesChanged.length) put("files", "file_change", NONE);
  else if (list.length <= MAX_BB_BODY_CHARS) put("files", "file_change", list, r.filesChanged);
  else put("files", "artifact_ref", `${r.filesChanged.length} files changed; see refs`, r.filesChanged.slice(0, 20));
  return out;
}

export function injectSlices(store: Store, runId: string, task: TaskSpec, attempt?: number) {
  const slices: { key: string; version: number; body: string; tokens: number }[] = [];
  const missing: string[] = [];
  for (const key of task.needs) {
    const e = store.latestBb(runId, key);
    if (!e) { missing.push(key); continue; }
    const tokens = estimateTokens(e.body);
    slices.push({ key, version: e.version, body: e.body, tokens });
    store.appendEvent({ run_id: runId, task_id: task.id, agent_id: task.id, type: "blackboard_read", payload: { key, version: e.version, tokens, author: e.author_task, ...(attempt === undefined ? {} : { attempt }) } });
  }
  return { slices, missing };
}
