import type { Runtime } from "@mar/core";

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError?: boolean }
  | { type: "usage"; input: number | null; output: number | null; cached: number | null; costUsd: number | null }
  | { type: "result"; text: string };            // final raw text (JSON per output contract)
export interface AdapterInput {
  taskId: string; prompt: string; cwd: string; model: string | null;
  allowedTools: string[]; signal: AbortSignal; maxBudgetUsd?: number; unsafe?: boolean;
  /** Workspace runs: absolute paths of read-only sibling repos the worker may read next to its cwd (`../<repo>`). */
  extraDirs?: string[];
}
export interface Adapter {
  runtime: Runtime; run(i: AdapterInput): AsyncIterable<AgentEvent>;
  /** True when a worker can READ sibling repos (`../<repo>`) without being able to write them (verified per CLI, see README). */
  siblingRead?: boolean;
}
export class AdapterError extends Error {}
