import type { TaskSpec } from "@mar/core";

type Slice = { key: string; version: number; body: string; tokens: number };

export function buildPrompt(task: TaskSpec, slices: Slice[]): string {
  const ctx = slices.length
    ? `\n## Context from earlier tasks\n${slices.map((s) => `### ${s.key}\n${s.body}`).join("\n\n")}\n`
    : "";
  return `You are a ${task.role} working in an isolated git worktree. Do only this task.

## Task
${task.goal}
${ctx}
## Output contract
When finished, reply with ONLY a JSON object: {"summary": string (<=900 chars), "report"?: string, "filesChanged": string[], "decisions": string[], "openQuestions": string[]}.
Keep summary and the lists terse; do not restate the task or paste code.
If the task asks you to explain, investigate, analyse or answer a question, put your COMPLETE answer in \`report\` as markdown (headings, bullet lists, file:line references; no size limit within reason) and keep \`summary\` to a short abstract. Do not put code diffs or file contents in \`report\`.`;
}
