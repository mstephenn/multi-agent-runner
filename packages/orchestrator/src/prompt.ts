import type { TaskSpec } from "@mar/core";

type Slice = { key: string; version: number; body: string; tokens: number };

/** Workspace runs (parent folder of several git repos): what the worker's directory layout looks like. */
export interface WorkspacePrompt {
  /** Writers: the repo the cwd is (`repo`) and the sibling repos readable at `../<name>`. */
  repo?: string; siblings?: readonly string[];
  /** Read-only tasks of the shared view: every repo as a folder of the cwd. */
  all?: readonly string[];
}

const workspaceNote = (w: WorkspacePrompt, task: TaskSpec): string => {
  if (w.repo !== undefined && w.siblings?.length)
    return `\nWorkspace: you are working in repo \`${w.repo}\` (your cwd). Other repos of this project are available READ-ONLY at ${w.siblings.map((n) => `\`../${n}\``).join(", ")} \u2014 read them for contracts; do not modify them.\n`;
  if (w.all?.length)
    return `\nWorkspace: your cwd holds one read-only checkout per repo of this project (${w.all.map((n) => `\`${n}\``).join(", ")}).${task.repo ? ` This task concerns repo \`${task.repo}\`.` : ""} Do not modify anything.\n`;
  return "";
};

export function buildPrompt(task: TaskSpec, slices: Slice[], workspace?: WorkspacePrompt): string {
  const ctx = slices.length
    ? `\n## Context from earlier tasks\n${slices.map((s) => `### ${s.key}\n${s.body}`).join("\n\n")}\n`
    : "";
  return `You are a ${task.role} working in an isolated git worktree. Do only this task.

## Task
${task.goal}
${workspace ? workspaceNote(workspace, task) : ""}${ctx}
## Output contract
When finished, reply with ONLY a JSON object: {"summary": string (<=900 chars), "report"?: string, "filesChanged": string[], "decisions": string[], "openQuestions": string[]}.
Keep summary and the lists terse; do not restate the task or paste code.
If the task asks you to explain, investigate, analyse or answer a question, put your COMPLETE answer in \`report\` as markdown (headings, bullet lists, file:line references; no size limit within reason) and keep \`summary\` to a short abstract. Do not put code diffs or file contents in \`report\`.`;
}
