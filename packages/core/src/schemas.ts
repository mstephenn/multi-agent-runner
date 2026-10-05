import { z } from "zod";

export const Runtime = z.enum(["claude", "codex"]);
export const Tier = z.enum(["low", "mid", "high"]);
export const Role = z.enum(["implementer", "reviewer", "tester", "researcher"]);
// Roles whose tasks write code (they get Edit/Write/Bash and their own worktree + branch).
export const WRITER_ROLES: ReadonlySet<string> = new Set(["implementer", "tester"]);

export const TaskSpec = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "task id must be lowercase [a-z0-9_-]"),
  role: Role,
  runtime: Runtime,
  tier: Tier,
  goal: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  needs: z.array(z.string()).default([]),
  // Repo-relative globs this task will modify (see globs.ts). Validated in parseDag so errors name the task.
  paths: z.array(z.string()).default([]),
  budgetTokens: z.number().int().positive().optional(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
export type Runtime = z.infer<typeof Runtime>;
export type Tier = z.infer<typeof Tier>;
export type Role = z.infer<typeof Role>;

export const TaskResultSchema = z.object({
  summary: z.string().min(1),
  report: z.string().max(100_000).optional(), // long-form markdown answer; stored outside the blackboard
  filesChanged: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const EventTypes = [
  "task_started", "task_finished", "task_failed", "prompt_sent", "tool_call",
  "tool_result", "assistant_text", "blackboard_write", "blackboard_read", "usage", "runtime_fallback",
  "verify_started", "verify_passed", "verify_failed", "ownership_violation", "integration",
] as const;
export type EventType = (typeof EventTypes)[number];

export interface NewEvent {
  run_id: string;
  task_id: string | null;
  agent_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
}
export type StoredEvent = NewEvent & { id: number; ts: number };

export type BbKind = "summary" | "decision" | "file_change" | "open_question" | "artifact_ref";
export interface BbWrite {
  run_id: string; key: string; author_task: string; kind: BbKind; body: string; refs: string[];
}
export type BbEntry = BbWrite & { id: number; version: number; ts: number };
