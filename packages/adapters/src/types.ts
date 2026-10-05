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
}
export interface Adapter { runtime: Runtime; run(i: AdapterInput): AsyncIterable<AgentEvent>; }
export class AdapterError extends Error {}
