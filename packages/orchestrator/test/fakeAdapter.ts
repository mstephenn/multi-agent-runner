import type { Adapter, AdapterInput, AgentEvent } from "../../adapters/src/types.js";

export type Script = (i: AdapterInput, attempt: number) => AgentEvent[] | Error;
export function fakeAdapter(script: Script, runtime: "claude" | "codex" = "claude") {
  const attempts = new Map<string, number>(); const calls: AdapterInput[] = [];
  const adapter: Adapter = {
    runtime,
    async *run(i) {
      calls.push(i);
      const n = (attempts.get(i.taskId) ?? 0) + 1; attempts.set(i.taskId, n);
      const out = script(i, n);
      if (out instanceof Error) throw out;
      for (const e of out) { if (i.signal.aborted) return; yield e; }
    },
  };
  return { adapter, calls, attempts };
}
export const ok = (summary = "done") => [
  { type: "usage", input: 10, output: 5, cached: null, costUsd: null },
  { type: "result", text: JSON.stringify({ summary, filesChanged: [], decisions: [], openQuestions: [] }) },
] as AgentEvent[];
