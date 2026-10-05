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
When finished, reply with ONLY a JSON object: {"summary": string (<=900 chars), "filesChanged": string[], "decisions": string[], "openQuestions": string[]}.
Keep it terse; do not restate the task or paste code.`;
}
