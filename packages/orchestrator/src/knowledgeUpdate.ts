import { createHash } from "node:crypto";
import type { BbEntry, TaskResult } from "@mar/core";
import { getEntry, mergeKnowledge, readEntry, scanRepo, type KnowledgeBase, type KbDraft, type KbOptions, type KbRefreshResult } from "./knowledge.js";
import { redact } from "./redact.js";

export interface CompletedKnowledgeTask { taskId: string; result: TaskResult }
export interface KnowledgeUpdateResult extends KbRefreshResult { skipped: boolean }

const meaningful = (text: string) => text.trim() !== "" && text.trim() !== "(none)";
const clean = (items: string[]) => [...new Set(items.map((s) => s.trim()).filter(meaningful))].sort();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Refresh after completed tasks have been integrated into kb.root. Only these tasks' latest
 * entries in the current run's blackboard are considered (failed/pending tasks must
 * not be passed here).
 * File changes trigger a repository scan; summaries and decisions are retained together
 * in a stable per-task entry. Summary-only tasks without decisions do not change the KB.
 * Repeated identical input performs no writes, including to the index.
 */
export function updateKnowledge(
  kb: KnowledgeBase,
  completed: readonly CompletedKnowledgeTask[],
  blackboard: readonly BbEntry[] = [],
  opts: KbOptions = {},
): KnowledgeUpdateResult {
  const drafts: KbDraft[] = [];
  let filesChanged = false;
  for (const { taskId, result } of completed) {
    const latest = new Map<string, BbEntry>();
    for (const entry of blackboard) {
      if (entry.author_task !== taskId) continue;
      const prior = latest.get(entry.key);
      if (!prior || entry.version > prior.version || (entry.version === prior.version && entry.id > prior.id)) latest.set(entry.key, entry);
    }
    const summary = latest.get(`${taskId}/summary`);
    const decisionsEntry = latest.get(`${taskId}/decisions`);
    const filesEntry = latest.get(`${taskId}/files`);
    const decisions = clean(decisionsEntry ? (meaningful(decisionsEntry.body) ? decisionsEntry.body.split("\n").map((s) => s.replace(/^-\s+/, "")) : []) : result.decisions);
    const files = clean(filesEntry
      ? filesEntry.kind === "artifact_ref" ? filesEntry.refs : [...filesEntry.refs, ...filesEntry.body.split("\n")]
      : result.filesChanged).filter((file) => !/^\.mar\/knowledge(?:\/|$)/.test(file.replace(/^\.\//, "")));
    if (!files.length && !decisions.length) continue;
    filesChanged ||= files.length > 0;
    const parts = [`Task: ${taskId}`, "## Summary", (summary?.body ?? result.summary).trim()];
    if (files.length) parts.push("## Files changed", files.map((f) => `- ${f}`).join("\n"));
    if (decisions.length) parts.push("## Decisions", decisions.map((d) => `- ${d}`).join("\n"));
    drafts.push({ id: `task-${hash(taskId)}`, section: "conventions", title: "Completed task knowledge", body: parts.join("\n\n") });
  }
  if (filesChanged) drafts.unshift(...scanRepo(kb.root));

  // mergeKnowledge records scan timestamps even for identical drafts. Avoid calling it
  // unless content changed, a file is missing, or a hand edit needs promotion to manual.
  const needsMerge = drafts.some((draft) => {
    const prior = getEntry(kb, draft.id);
    if (!prior) return true;
    if (prior.source === "manual") return false;
    const current = readEntry(kb, draft.id);
    const rendered = redact(`# ${draft.title}\n\n${draft.body.trim()}\n`);
    return current === undefined || hash(current) !== prior.hash || hash(rendered) !== prior.hash;
  });
  if (!needsMerge) {
    const draftedIds = new Set(drafts.map((draft) => draft.id));
    return {
      kb, skipped: true, added: [], updated: [],
      unchanged: drafts.filter((draft) => getEntry(kb, draft.id)?.source !== "manual").map((draft) => draft.id),
      preserved: kb.index.entries.filter((entry) => entry.source === "manual" || !draftedIds.has(entry.id)).map((entry) => entry.id),
    };
  }
  return { ...mergeKnowledge(kb, drafts, opts), skipped: false };
}
