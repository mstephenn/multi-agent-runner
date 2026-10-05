import type { Adapter, AdapterInput, AgentEvent } from "./types.js";
import { AdapterError } from "./types.js";
import { spawnLines } from "./exec.js";
import { sanitizeDiagnostic } from "./sanitize.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const blocks = (m: unknown): Rec[] => (isRec(m) && Array.isArray(m.content) ? m.content.filter(isRec) : []);
function parse(line: string): Rec | null {
  try { const j: unknown = JSON.parse(line); return isRec(j) ? j : null; } catch { return null; }
}

export function normalizeClaudeLine(line: string): AgentEvent[] {
  const j = parse(line);
  if (!j) return [];
  const out: AgentEvent[] = [];
  if (j.type === "assistant") {
    for (const b of blocks(j.message)) {
      if (b.type === "text" && typeof b.text === "string" && b.text) out.push({ type: "assistant_text", text: b.text });
      else if (b.type === "tool_use") out.push({ type: "tool_call", name: String(b.name), input: b.input });
    }
  } else if (j.type === "user") {
    for (const b of blocks(j.message)) {
      if (b.type === "tool_result") {
        const output = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        out.push({ type: "tool_result", name: typeof b.tool_use_id === "string" ? b.tool_use_id : "", output, isError: !!b.is_error });
      }
    }
  } else if (j.type === "result") {
    const u = isRec(j.usage) ? j.usage : {};
    out.push({ type: "usage", input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens), costUsd: num(j.total_cost_usd) });
    out.push({ type: "result", text: typeof j.result === "string" ? j.result : "" });
  }
  return out;
}

/** For a `result` line that reports failure (`is_error` or an `error_*` subtype): subtype + sanitized message, else null. */
export function claudeFailure(line: string): { subtype: string; message: string } | null {
  const j = parse(line);
  if (!j || j.type !== "result") return null;
  const rawSubtype = typeof j.subtype === "string" ? j.subtype : "";
  if (j.is_error !== true && !rawSubtype.startsWith("error")) return null;
  const subtype = rawSubtype || "error";
  const parts: string[] = [];
  if (typeof j.result === "string" && j.result) parts.push(j.result);
  if (Array.isArray(j.errors)) for (const e of j.errors) parts.push(typeof e === "string" ? e : isRec(e) && typeof e.message === "string" ? e.message : JSON.stringify(e));
  return { subtype, message: sanitizeDiagnostic(parts.join("; ")) };
}

/** `--tools` takes tool names only: reduce permission patterns like `Bash(git *)` to `Bash`, de-duplicated. */
const toolNames = (allowed: string[]): string[] => [...new Set(allowed.map((t) => t.replace(/\(.*$/s, "").trim()).filter(Boolean))];

/**
 * CLI args; the prompt is NOT included, it is delivered on stdin.
 * - `--tools` restricts the AVAILABLE tools (`--allowedTools` only pre-approves, and acceptEdits auto-approves
 *   Edit/Write); an empty list yields `--tools ""` (everything disabled), never "omit" (= all tools).
 * - `--strict-mcp-config` without `--mcp-config` => no MCP servers; `--setting-sources ""` => no user/project/local settings.
 */
export function buildClaudeArgs(i: AdapterInput): string[] {
  if (i.maxBudgetUsd != null && !(Number.isFinite(i.maxBudgetUsd) && i.maxBudgetUsd > 0))
    throw new AdapterError(`invalid maxBudgetUsd: ${String(i.maxBudgetUsd)} (must be a finite number > 0)`);
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
  args.push("--tools", toolNames(i.allowedTools).join(","));
  if (i.allowedTools.length > 0) args.push("--allowedTools", i.allowedTools.join(","));
  args.push("--strict-mcp-config", "--setting-sources", "");
  if (i.model) args.push("--model", i.model);
  if (i.maxBudgetUsd != null) args.push("--max-budget-usd", String(i.maxBudgetUsd));
  args.push(...(i.unsafe === true ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]));
  return args;
}

export function claudeAdapter(bin = "claude"): Adapter {
  return {
    runtime: "claude",
    async *run(i: AdapterInput) {
      let gotResult = false;
      for await (const line of spawnLines(bin, buildClaudeArgs(i), { cwd: i.cwd, signal: i.signal, stdin: i.prompt })) {
        const evs = normalizeClaudeLine(line);
        const f = claudeFailure(line);
        if (f) {
          for (const e of evs) if (e.type === "usage") yield e; // keep the cost of a failed run
          throw new AdapterError(`claude ${f.subtype}${f.message ? `: ${f.message}` : ""}`);
        }
        for (const e of evs) { if (e.type === "result") gotResult = true; yield e; }
      }
      if (!gotResult && !i.signal.aborted) throw new AdapterError("claude produced no result");
    },
  };
}
