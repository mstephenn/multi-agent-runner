import type { Adapter, AdapterInput, AgentEvent } from "./types.js";
import { AdapterError } from "./types.js";
import { spawnLines } from "./exec.js";
import { sanitizeDiagnostic } from "./sanitize.js";
import { workerEnv } from "./env.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const blocks = (m: unknown): Rec[] => (isRec(m) && Array.isArray(m.content) ? m.content.filter(isRec) : []);
function parse(line: string): Rec | null {
  try { const j: unknown = JSON.parse(line); return isRec(j) ? j : null; } catch { return null; }
}

export function normalizeClaudeLine(line: string): AgentEvent[] {
  return normalizeWith(line, new Map());
}

/** Stateful variant of `normalizeClaudeLine`: remembers tool_use id -> name so `tool_result.name` is the real tool name. */
export function createClaudeNormalizer(): (line: string) => AgentEvent[] {
  const names = new Map<string, string>();
  return (line) => normalizeWith(line, names);
}

function normalizeWith(line: string, names: Map<string, string>): AgentEvent[] {
  const j = parse(line);
  if (!j) return [];
  const out: AgentEvent[] = [];
  if (j.type === "assistant") {
    for (const b of blocks(j.message)) {
      if (b.type === "text" && typeof b.text === "string" && b.text) out.push({ type: "assistant_text", text: b.text });
      else if (b.type === "tool_use") {
        if (typeof b.id === "string") names.set(b.id, String(b.name));
        out.push({ type: "tool_call", name: String(b.name), input: b.input });
      }
    }
  } else if (j.type === "user") {
    for (const b of blocks(j.message)) {
      if (b.type === "tool_result") {
        const output = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
        out.push({ type: "tool_result", name: names.get(id) ?? id, output, isError: !!b.is_error });
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
 * Always-on deny list (defence in depth: callers' `allowedTools` may include a bare `Bash`). Deny rules take
 * precedence over allow rules. Workers must not push, rewire remotes/config, or reach the network. `git reset`
 * is deliberately NOT denied: workers may legitimately reset inside their own worktree.
 * Pattern matching on shell commands is best-effort (e.g. `bash -c "curl ..."` is not caught); it is not a sandbox,
 * see `workerEnv` for the residual risk.
 */
export const CLAUDE_DENIED_TOOLS: readonly string[] = [
  "Bash(git push:*)", "Bash(git remote:*)", "Bash(git config:*)", "Bash(git branch -f:*)", "Bash(git branch -D:*)",
  "Bash(git checkout main:*)", "Bash(git switch main:*)",
  "Bash(curl:*)", "Bash(wget:*)", "Bash(ssh:*)", "Bash(scp:*)", "Bash(nc:*)",
  "Bash(rm -rf /:*)", "Bash(sudo:*)",
];

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
  args.push("--disallowedTools", CLAUDE_DENIED_TOOLS.join(","));
  args.push("--strict-mcp-config", "--setting-sources", "");
  // Sibling repos (read-only checkouts): --add-dir grants tool access; Edit/Write there is not blocked, so the orchestrator checks them afterwards.
  for (const d of i.extraDirs ?? []) args.push("--add-dir", d);
  if (i.model) args.push("--model", i.model);
  if (i.maxBudgetUsd != null) args.push("--max-budget-usd", String(i.maxBudgetUsd));
  args.push(...(i.unsafe === true ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]));
  return args;
}

export function claudeAdapter(bin = "claude"): Adapter {
  return {
    runtime: "claude", siblingRead: true,
    async *run(i: AdapterInput) {
      let gotResult = false;
      const normalize = createClaudeNormalizer();
      for await (const line of spawnLines(bin, buildClaudeArgs(i), { cwd: i.cwd, signal: i.signal, stdin: i.prompt, env: workerEnv() })) {
        const evs = normalize(line);
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
