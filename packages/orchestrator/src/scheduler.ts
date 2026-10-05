import { TaskResultSchema, estimateTokens, type Dag, type Role, type Runtime, type TaskResult, type TaskSpec, type Tier } from "@mar/core";
import type { Adapter } from "@mar/adapters";
import type { Store } from "../../server/src/store.js";
import { BudgetTracker } from "./budget.js";
import { buildPrompt } from "./prompt.js";
import { injectSlices, publishResult } from "./blackboard.js";
import { redact } from "./redact.js";

export interface RunDeps {
  store: Store; runId: string; dag: Dag; repo: string;
  adapters: Record<Runtime, Adapter>;
  worktrees: { create(taskId: string): Promise<string>; commit(taskId: string, message: string): Promise<void>; remove(taskId: string): Promise<void> };
  modelFor(runtime: Runtime, tier: Tier): string | null;
  toolsFor(role: Role): string[];
  concurrency: number; defaultBudgetTokens?: number; unsafe?: boolean;
  maxAttempts?: number;                     // attempts per worker task; default 1 (no retry)
  repairResult?: (raw: string) => Promise<string>;
  signal?: AbortSignal;
}
type Outcome = "done" | "failed" | "blocked";
class TaskFailure extends Error { constructor(m: string, public retryable = true) { super(m); } }

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
async function parseResult(raw: string, repair?: (r: string) => Promise<string>): Promise<TaskResult> {
  const attempt = (s: string) => TaskResultSchema.parse(JSON.parse(stripFence(s)));
  try { return attempt(raw); } catch {
    if (!repair) throw new TaskFailure("bad-result");
    try { return attempt(await repair(raw)); } catch { throw new TaskFailure("bad-result"); }
  }
}

// Redact every string leaf of a JSON-like value (key=value patterns inside quoted JSON strings are
// not caught when the whole document is redacted at once). Values under secret-looking keys are masked.
const isSecretKey = (k: string) => redact(`${k}=x`) !== `${k}=x`;
function redactJson(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v);
  if (depth > 20 || v === null || typeof v !== "object") return v ?? null;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" && isSecretKey(k) ? "[REDACTED]" : redactJson(x, depth + 1)]));
}

export async function runDag(d: RunDeps): Promise<Record<string, Outcome>> {
  const { store, runId } = d;
  const outcome = new Map<string, Outcome>();
  // Resume: only tasks already `done` are seeded; failed/running/blocked ones run again.
  for (const s of store.taskStatuses(runId)) if (s.status === "done") outcome.set(s.task_id, "done");
  const byId = new Map(d.dag.tasks.map((t) => [t.id, t]));
  const running = new Map<string, Promise<void>>();
  const emit = (task: TaskSpec, type: any, payload: Record<string, unknown> = {}) =>
    store.appendEvent({ run_id: runId, task_id: task.id, agent_id: task.id, type, payload });

  async function attemptOnce(task: TaskSpec, extra: string, budget: BudgetTracker): Promise<TaskResult> {
    const { slices, missing } = injectSlices(store, runId, task);
    if (missing.length) throw new TaskFailure(`missing:${missing[0]}`, false);
    const prompt = buildPrompt(task, slices) + extra;
    emit(task, "prompt_sent", { prompt: redact(prompt), keys: slices.map((s) => s.key), tokens: estimateTokens(prompt) });
    const cwd = await d.worktrees.create(task.id);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    d.signal?.addEventListener("abort", onAbort);
    if (d.signal?.aborted) ac.abort();
    try {
      let raw: string | undefined;
      for await (const ev of d.adapters[task.runtime].run({
        taskId: task.id, prompt, cwd, model: d.modelFor(task.runtime, task.tier),
        allowedTools: d.toolsFor(task.role), signal: ac.signal, unsafe: d.unsafe,
      })) {
        if (ev.type === "usage") { budget.add(ev); emit(task, "usage", { ...ev }); }
        else if (ev.type === "assistant_text") emit(task, "assistant_text", { text: redact(ev.text) });
        else if (ev.type === "tool_call") emit(task, "tool_call", { name: redact(ev.name), input: redactJson(ev.input) });
        else if (ev.type === "tool_result") emit(task, "tool_result", { name: redact(ev.name), output: redact(ev.output).slice(0, 2000), isError: ev.isError ?? false });
        else raw = ev.text;
        if (budget.exceeded) { ac.abort(); throw new TaskFailure("failed:budget", false); }
      }
      if (raw === undefined) throw new TaskFailure("no-result", !d.signal?.aborted);
      const res = await parseResult(raw, d.repairResult);
      await d.worktrees.commit(task.id, `mar(${task.id}): ${task.goal.split("\n")[0].slice(0, 60)}`);
      return res;
    } finally {
      d.signal?.removeEventListener("abort", onAbort);
      // A failed worktree cleanup must not mask the task outcome (explicitly tolerated).
      await d.worktrees.remove(task.id).catch(() => {});
    }
  }

  async function runTask(task: TaskSpec) {
    store.setTaskStatus(runId, task.id, "running");
    emit(task, "task_started", { runtime: task.runtime, tier: task.tier, role: task.role });
    const budget = new BudgetTracker(task.budgetTokens ?? d.defaultBudgetTokens);
    let extra = "";
    const max = d.maxAttempts ?? 1;
    for (let n = 1; n <= max; n++) {
      try {
        const res = await attemptOnce(task, extra, budget);
        publishResult(store, runId, task.id, res);
        emit(task, "task_finished", { tokens: budget.used });
        store.setTaskStatus(runId, task.id, "done");
        outcome.set(task.id, "done");
        return;
      } catch (e) {
        const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
        const retryable = !(e instanceof TaskFailure) || e.retryable;
        if (n >= max || !retryable || d.signal?.aborted) {
          emit(task, "task_failed", { reason: msg });
          store.setTaskStatus(runId, task.id, "failed", msg);
          outcome.set(task.id, "failed");
          return;
        }
        extra = `\n\nPrevious attempt failed: ${msg}`;
      }
    }
  }

  const block = (id: string) => { outcome.set(id, "blocked"); store.setTaskStatus(runId, id, "blocked"); };

  while (outcome.size < byId.size) {
    // Propagate failed/blocked to transitive dependents (to a fixpoint, independent of declaration order).
    for (let changed = true; changed;) {
      changed = false;
      for (const t of byId.values()) {
        if (outcome.has(t.id) || running.has(t.id)) continue;
        if (t.dependsOn.some((x) => outcome.get(x) === "failed" || outcome.get(x) === "blocked")) { block(t.id); changed = true; }
      }
    }
    const ready = [...byId.values()].filter(
      (t) => !outcome.has(t.id) && !running.has(t.id) && t.dependsOn.every((x) => outcome.get(x) === "done"),
    );
    for (const t of ready) {
      if (running.size >= d.concurrency || d.signal?.aborted) break;
      const p = runTask(t).finally(() => running.delete(t.id));
      running.set(t.id, p);
    }
    if (running.size === 0) {
      // Nothing running and nothing startable: run was aborted (or the graph is stuck); block the rest.
      for (const t of byId.values()) if (!outcome.has(t.id)) block(t.id);
      break;
    }
    await Promise.race(running.values());
  }
  return Object.fromEntries(outcome);
}
