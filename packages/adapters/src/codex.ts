import { resolve } from "node:path";
import type { Adapter, AdapterInput, AgentEvent } from "./types.js";
import { AdapterError } from "./types.js";
import { spawnLines } from "./exec.js";
import { workerEnv } from "./env.js";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parse(line: string): any {
  try { const j = JSON.parse(line); return j && typeof j === "object" ? j : null; } catch { return null; }
}

export function normalizeCodexLine(line: string): AgentEvent[] {
  const j = parse(line);
  if (!j) return [];
  if (j.type === "item.completed" && j.item && typeof j.item === "object") {
    const it = j.item;
    if (it.type === "agent_message" && typeof it.text === "string" && it.text) return [{ type: "assistant_text", text: it.text }, { type: "result", text: it.text }];
    if (it.type === "command_execution")
      return [
        { type: "tool_call", name: "shell", input: { command: it.command } },
        { type: "tool_result", name: "shell", output: String(it.aggregated_output ?? ""), isError: (it.exit_code ?? 0) !== 0 },
      ];
  }
  if (j.type === "turn.completed") {
    const u = j.usage && typeof j.usage === "object" ? j.usage : {};
    const input = num(u.input_tokens), cached = num(u.cached_input_tokens);
    // Codex's input_tokens includes cached tokens, Claude's excludes them: report UNCACHED input for both so budgets and totals agree.
    return [{ type: "usage", input: input !== null && cached !== null ? Math.max(0, input - cached) : input, output: num(u.output_tokens), cached, costUsd: null }];
  }
  return [];
}

/**
 * Error message for `turn.failed` / top-level `error` lines, else null.
 * `item.completed` items of type "error" are non-fatal warnings (e.g. config notices) and are ignored.
 */
export function codexFailure(line: string): string | null {
  const j = parse(line);
  if (!j) return null;
  if (j.type === "turn.failed") return typeof j.error?.message === "string" && j.error.message ? j.error.message : "codex turn failed";
  if (j.type === "error") return typeof j.message === "string" && j.message ? j.message : "codex error";
  return null;
}

/** CLI args; the prompt is NOT included, it is delivered on stdin (`-`). `unsafe` is deliberately not mapped. */
export function buildCodexArgs(i: AdapterInput): string[] {
  const writes = i.allowedTools.some((t) => /^(Edit|Write)/.test(t));
  // --ignore-user-config: workers must not inherit the user's MCP servers (verified: `-c mcp_servers={}` does not clear
// them, this flag does; auth still comes from CODEX_HOME). approval_policy "never": `exec` must never wait on a prompt.
  const args = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"',
    "--sandbox", writes ? "workspace-write" : "read-only", "-C", resolve(i.cwd)];
  if (i.model) args.push("-m", i.model);
  args.push("-");
  return args;
}

export function codexAdapter(bin = "codex"): Adapter {
  return {
    // Siblings need no flag: the workspace-write sandbox already lets `../<repo>` be READ, and writes outside the cwd are denied.
    // `extraDirs` is deliberately ignored: codex's --add-dir would make the siblings WRITABLE.
    runtime: "codex", siblingRead: true,
    async *run(i: AdapterInput) {
      let turnFailure: string | null = null;
      let lastError: string | null = null;
      let gotResult = false;
      try {
        for await (const line of spawnLines(bin, buildCodexArgs(i), { cwd: i.cwd, signal: i.signal, stdin: i.prompt, env: workerEnv() })) {
          const f = codexFailure(line);
          if (f !== null) {
            lastError = f;
            if (parse(line)?.type === "turn.failed") turnFailure = f;
          }
          for (const e of normalizeCodexLine(line)) {
            if (e.type === "result") gotResult = true;
            yield e;
          }
        }
      } catch (e) {
        // codex reports its real reason (usage limit, auth...) as JSON on stdout while stderr stays empty: put it in the error.
        if (e instanceof AdapterError && lastError !== null && !e.message.includes(lastError)) throw new AdapterError(`${e.message.trimEnd()} ${lastError}`);
        throw e;
      }
      if (i.signal.aborted) return;
      if (turnFailure !== null) throw new AdapterError(`codex turn failed: ${turnFailure}`);
      if (!gotResult) throw new AdapterError(`codex produced no agent message${lastError ? `: ${lastError}` : ""}`);
    },
  };
}
