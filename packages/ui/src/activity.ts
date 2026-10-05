// Pure derivation of the Activity feed: pairs tool calls with their results and builds human one-liners.
// Payloads are `unknown` (untrusted); every helper is total.
import type { StoredEvent } from "@mar/core";
import { safeStringify } from "./derive.js";

export type SayStep = { kind: "say"; id: number; ts: number; text: string };
export type ToolStep = {
  kind: "tool"; id: number; ts: number; name: string; summary: string; input: unknown;
  output?: string; resultMeta?: string; isError: boolean; done: boolean; ms?: number;
};
export type Step = SayStep | ToolStep;

const MAX_SAY = 8000;
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clipTo = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + "…");

// The per-run worktree prefix (`…/.mar/worktrees/<id>/(.shared|<repo>)/`) is noise: show repo-relative paths.
const WT_PREFIX = /^.*\/\.mar\/worktrees\/[^/]+\/(?:\.shared|[^/]+)\//;
const WT_INLINE = /[^\s"'`=:(]*\/\.mar\/worktrees\/[^/\s]+\/(?:\.shared|[^/\s]+)\//g;
const relPath = (p: string) => p.replace(WT_PREFIX, "");
const stripInline = (s: string) => s.replace(WT_INLINE, "");

const BASH = new Set(["Bash", "shell", "bash", "command_execution"]);
const FILE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function summarizeTool(name: string, input: unknown): string {
  const i = rec(input);
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  if (name === "Read" && path !== undefined) {
    const off = num(i.offset), lim = num(i.limit);
    const p = relPath(path);
    if (lim !== undefined) return `${p} (lines ${off ?? 1}–${(off ?? 1) + lim - 1})`;
    if (off !== undefined) return `${p} (from line ${off})`;
    return p;
  }
  if (name === "Grep" && str(i.pattern) !== undefined) {
    const glob = str(i.glob), p = str(i.path), mode = str(i.output_mode);
    let s = `/${i.pattern as string}/ in ${p !== undefined ? relPath(p) : glob ?? "."}`;
    if (p !== undefined && glob !== undefined) s += ` [${glob}]`;
    if (mode !== undefined && mode !== "content") s += ` [${mode}]`;
    return s;
  }
  if (name === "Glob" && str(i.pattern) !== undefined) {
    const p = str(i.path);
    return `${i.pattern as string}${p !== undefined ? ` in ${relPath(p)}` : ""}`;
  }
  if (BASH.has(name)) {
    const cmd = str(i.command) ?? (Array.isArray(i.command) ? i.command.filter((c): c is string => typeof c === "string").join(" ") : undefined);
    if (cmd !== undefined) return clipTo(stripInline(cmd.split("\n")[0] ?? ""), 140);
  }
  if (FILE.has(name) && path !== undefined) return relPath(path);
  if (input === undefined || input === null || (typeof input === "object" && Object.keys(input).length === 0)) return "";
  return clipTo(stripInline(safeStringify(input)), 120);
}

const lines = (s: string) => s.split("\n").filter((l) => l.trim() !== "");
const firstLine = (s: string) => clipTo(lines(s)[0] ?? "", 100);

export function resultMeta(name: string, output: unknown, isError: boolean): string {
  const text = typeof output === "string" ? output : output === undefined || output === null ? "" : safeStringify(output);
  if (isError) return firstLine(text) || "error";
  if (name === "Grep" || name === "Glob") {
    if (text.trim() === "" || /^no (matches|files) found/i.test(text.trim())) return "no matches";
  }
  if (BASH.has(name)) return "exit ok";
  const n = lines(text).length;
  return n === 0 ? "no output" : n === 1 ? "1 line" : `${n} lines`;
}

/** Task start: its first `task_started` event, else its first event, else 0. */
export function taskStart(events: StoredEvent[], taskId: string): number {
  let first: number | undefined;
  for (const e of events) {
    if (e.task_id !== taskId) continue;
    const ts = num(e.ts);
    if (e.type === "task_started" && ts !== undefined) return ts;
    if (first === undefined && ts !== undefined) first = ts;
  }
  return first ?? 0;
}

export function relTime(ts: number, startTs: number): string {
  const s = Math.max(0, Math.floor((ts - startTs) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `+${h}h ${pad(m)}m` : m ? `+${m}m ${pad(sec)}s` : `+${sec}s`;
}

export function deriveSteps(events: StoredEvent[], taskId: string): Step[] {
  let list = events;
  for (let k = 1; k < events.length; k++) if (events[k]!.id < events[k - 1]!.id) { list = [...events].sort((a, b) => a.id - b.id); break; }
  const out: Step[] = [];
  // FIFO queue of open calls per tool name; `head` avoids O(n) shifts.
  const open = new Map<string, { q: ToolStep[]; head: number }>();
  for (const e of list) {
    if (e.task_id !== taskId) continue;
    const p = rec(e.payload);
    const ts = num(e.ts) ?? 0;
    if (e.type === "assistant_text") {
      const raw = str(p.text) ?? safeStringify(p.text ?? "");
      out.push({ kind: "say", id: e.id, ts, text: raw.length > MAX_SAY ? raw.slice(0, MAX_SAY) + " …(clipped)" : raw });
    } else if (e.type === "tool_call") {
      const name = str(p.name) ?? "tool";
      const step: ToolStep = { kind: "tool", id: e.id, ts, name, summary: summarizeTool(name, p.input), input: p.input, isError: false, done: false };
      out.push(step);
      let b = open.get(name);
      if (!b) { b = { q: [], head: 0 }; open.set(name, b); }
      b.q.push(step);
    } else if (e.type === "tool_result") {
      const name = str(p.name) ?? "tool";
      const output = str(p.output) ?? (p.output === undefined || p.output === null ? "" : safeStringify(p.output));
      const isError = p.isError === true;
      const b = open.get(name);
      let step = b && b.head < b.q.length ? b.q[b.head++] : undefined;
      if (step) { if (ts && step.ts) step.ms = Math.max(0, ts - step.ts); }
      else { step = { kind: "tool", id: e.id, ts, name, summary: "", input: undefined, isError, done: true }; out.push(step); }
      step.output = output; step.isError = isError; step.done = true; step.resultMeta = resultMeta(name, output, isError);
    }
  }
  return out;
}
