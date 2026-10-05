import type { Adapter, AdapterInput, AgentEvent } from "./types.js";
import { spawnLines } from "./exec.js";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const blocks = (m: any): any[] => (Array.isArray(m?.content) ? m.content : []);

export function normalizeClaudeLine(line: string): AgentEvent[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  if (!j || typeof j !== "object") return [];
  const out: AgentEvent[] = [];
  if (j.type === "assistant") {
    for (const b of blocks(j.message)) {
      if (b?.type === "text" && b.text) out.push({ type: "assistant_text", text: b.text });
      else if (b?.type === "tool_use") out.push({ type: "tool_call", name: b.name, input: b.input });
    }
  } else if (j.type === "user") {
    for (const b of blocks(j.message)) {
      if (b?.type === "tool_result") {
        const output = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        out.push({ type: "tool_result", name: b.tool_use_id ?? "", output, isError: !!b.is_error });
      }
    }
  } else if (j.type === "result") {
    const u = j.usage ?? {};
    out.push({ type: "usage", input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens), costUsd: num(j.total_cost_usd) });
    out.push({ type: "result", text: typeof j.result === "string" ? j.result : "" });
  }
  return out;
}

/** CLI args; the prompt is NOT included, it is delivered on stdin. */
export function buildClaudeArgs(i: AdapterInput): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
  if (i.allowedTools.length > 0) args.push("--allowedTools", i.allowedTools.join(","));
  if (i.model) args.push("--model", i.model);
  if (i.maxBudgetUsd) args.push("--max-budget-usd", String(i.maxBudgetUsd));
  args.push(...(i.unsafe === true ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]));
  return args;
}

export function claudeAdapter(bin = "claude"): Adapter {
  return {
    runtime: "claude",
    async *run(i: AdapterInput) {
      for await (const line of spawnLines(bin, buildClaudeArgs(i), { cwd: i.cwd, signal: i.signal, stdin: i.prompt })) yield* normalizeClaudeLine(line);
    },
  };
}
