import { TaskResultSchema, estimateTokens, type Dag, type Role, type Runtime, type TaskResult, type TaskSpec, type Tier } from "@mar/core";
import type { Adapter } from "@mar/adapters";
import type { Store } from "../../server/src/store.js";
import { BudgetTracker } from "./budget.js";
import { buildPrompt } from "./prompt.js";
import { injectSlices, publishResult } from "./blackboard.js";
import { redact } from "./redact.js";
import { usesSharedWorktree } from "./readonly.js";

export interface RunDeps {
  store: Store; runId: string; dag: Dag; repo: string;
  adapters: Record<Runtime, Adapter>;
  worktrees: { create(taskId: string, dependsOn?: string[]): Promise<string>; commit(taskId: string, message: string): Promise<void>; remove(taskId: string): Promise<void>;
    // Optional: one detached worktree for read-only tasks (no branch, no commits). Absent = a worktree per task.
    shared?: { acquire(): Promise<string>; release(): Promise<void> } };
  modelFor(runtime: Runtime, tier: Tier): string | null;
  toolsFor(role: Role): string[];
  concurrency: number; defaultBudgetTokens?: number; unsafe?: boolean;
  maxAttempts?: number;                     // attempts per worker task; default 1 (no retry)
  repairResult?: (raw: string) => Promise<string>;
  signal?: AbortSignal;
  // Per-attempt wall-clock limit; undefined = no timeout (the CLI supplies the default). A timeout fails the task
  // with `failed:timeout` (not retried).
  taskTimeoutMs?: number;
  // Forwarded to the adapter as `maxBudgetUsd`. Claude only reports usage at the end of a run, so the token budget
  // (`budgetTokens`) is enforced post-hoc; this USD cap is the only real mid-run guard.
  maxBudgetUsdPerTask?: number;
}
type Outcome = "done" | "failed" | "blocked";
class TaskFailure extends Error { constructor(m: string, public retryable = true) { super(m); } }

const TIMEOUT = Symbol("timeout");
const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
async function parseResult(raw: string, repair?: (r: string) => Promise<string>): Promise<TaskResult> {
  const attempt = (s: string) => TaskResultSchema.parse(JSON.parse(stripFence(s)));
  try { return attempt(raw); } catch {
    // Not retryable: a retry would just reproduce the same unparseable output.
    if (!repair) throw new TaskFailure("bad-result", false);
    try { return attempt(await repair(raw)); } catch { throw new TaskFailure("bad-result", false); }
  }
}

// Redact every string leaf of a JSON-like value (key=value patterns inside quoted JSON strings are
// not caught when the whole document is redacted at once). Values under secret-looking keys are masked
// whatever their type. Anything we cannot inspect (too deep, bigint/function/symbol) is never passed through raw.
const isSecretKey = (k: string) => redact(`${k}=x`) !== `${k}=x`;
const MAX_DEPTH = 20;
function redactJson(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v);
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint" || typeof v === "symbol") return redact(String(v));
  if (typeof v === "function") return "[function]";
  if (typeof v !== "object") return v; // number | boolean
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), isSecretKey(k) ? "[REDACTED]" : redactJson(x, depth + 1)]));
}

const MAX_TOOL_INPUT_CHARS = 4000;
// Redacted tool input, replaced by a marker object when its serialised form is too large (or not serialisable).
function boundedToolInput(input: unknown): unknown {
  const red = redactJson(input);
  let n: number;
  try { n = JSON.stringify(red)?.length ?? 0; } catch { return { truncated: "[TRUNCATED]", chars: null }; }
  return n > MAX_TOOL_INPUT_CHARS ? { truncated: "[TRUNCATED]", chars: n } : red;
}

// Bookkeeping must never take the run down: a failing store write is swallowed here.
const bestEffort = (f: () => void) => { try { f(); } catch { /* store unavailable */ } };

export async function runDag(d: RunDeps): Promise<Record<string, Outcome>> {
  try { return await runDagInner(d); }
  finally {
    // Once, on every exit path. A failed cleanup must not mask the run outcome (same tolerance as per-task remove).
    if (sharedUsedOf.get(d)) await d.worktrees.shared!.release().catch(() => {});
  }
}
const sharedUsedOf = new WeakMap<RunDeps, boolean>();

async function runDagInner(d: RunDeps): Promise<Record<string, Outcome>> {
  const { store, runId } = d;
  const outcome = new Map<string, Outcome>();
  // Resume: only tasks already `done` are seeded; failed/running/blocked ones run again.
  bestEffort(() => { for (const s of store.taskStatuses(runId)) if (s.status === "done") outcome.set(s.task_id, "done"); });
  const byId = new Map(d.dag.tasks.map((t) => [t.id, t]));
  const running = new Map<string, Promise<void>>();
  const emit = (task: TaskSpec, type: any, payload: Record<string, unknown> = {}) =>
    store.appendEvent({ run_id: runId, task_id: task.id, agent_id: task.id, type, payload });

  // Read-only tasks (see usesSharedWorktree: no writer role, no writer ancestor, no Edit/Write/Bash tools) run
  // concurrently in ONE directory, which is safe only because they cannot write. Without `shared`: legacy per-task.
  const useShared = (task: TaskSpec) => d.worktrees.shared !== undefined && usesSharedWorktree(task, byId, d.toolsFor);
  let sharedP: Promise<string> | undefined;
  const acquireShared = () => {
    sharedUsedOf.set(d, true);
    sharedP ??= d.worktrees.shared!.acquire().catch((e) => { sharedP = undefined; throw e; }); // a failed acquire may be retried
    return sharedP;
  };

  async function attemptOnce(task: TaskSpec, extra: string, budget: BudgetTracker): Promise<TaskResult> {
    const { slices, missing } = injectSlices(store, runId, task);
    if (missing.length) throw new TaskFailure(`missing:${missing[0]}`, false);
    const prompt = buildPrompt(task, slices) + extra;
    emit(task, "prompt_sent", { prompt: redact(prompt), keys: slices.map((s) => s.key), tokens: estimateTokens(prompt) });
    const shared = useShared(task);
    const cwd = shared ? await acquireShared() : await d.worktrees.create(task.id, task.dependsOn);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    d.signal?.addEventListener("abort", onAbort);
    if (d.signal?.aborted) ac.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let committed = false;
    try {
      const consume = async (): Promise<string | undefined> => {
        let raw: string | undefined;
        for await (const ev of d.adapters[task.runtime].run({
          taskId: task.id, prompt, cwd, model: d.modelFor(task.runtime, task.tier),
          allowedTools: d.toolsFor(task.role), signal: ac.signal, unsafe: d.unsafe,
          maxBudgetUsd: d.maxBudgetUsdPerTask,
        })) {
          if (ev.type === "usage") { budget.add(ev); emit(task, "usage", { ...ev }); }
          else if (ev.type === "assistant_text") emit(task, "assistant_text", { text: redact(ev.text) });
          else if (ev.type === "tool_call") emit(task, "tool_call", { name: redact(ev.name), input: boundedToolInput(ev.input) });
          else if (ev.type === "tool_result") emit(task, "tool_result", { name: redact(ev.name), output: redact(ev.output).slice(0, 2000), isError: ev.isError ?? false });
          else raw = ev.text;
          // Budget is a hard cap: even if the final `result` event arrives after the cap was crossed, the task fails.
          if (budget.exceeded) { ac.abort(); throw new TaskFailure("failed:budget", false); }
        }
        return raw;
      };
      const work = consume();
      let raw: string | undefined;
      if (d.taskTimeoutMs === undefined) raw = await work;
      else {
        // Race against the timer so an adapter that ignores the abort signal (or never yields) cannot hang the run.
        const timeout = new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => { ac.abort(); res(TIMEOUT); }, d.taskTimeoutMs); });
        work.catch(() => {}); // a late rejection after the timeout won must not be unhandled
        const first = await Promise.race([work, timeout]);
        if (first === TIMEOUT) throw new TaskFailure("failed:timeout", false);
        raw = first;
      }
      if (raw === undefined) throw new TaskFailure("no-result", !d.signal?.aborted);
      const res = await parseResult(raw, d.repairResult);
      if (!shared) await d.worktrees.commit(task.id, `mar(${task.id}): ${task.goal.split("\n")[0].slice(0, 60)}`);
      committed = true;
      return res;
    } catch (e) {
      // Keep partial work on the per-task branch: the worktree is removed below. Best effort: a failing commit
      // (e.g. nothing to add, git error) must not mask the original failure.
      if (!committed && !shared) await d.worktrees.commit(task.id, `mar(${task.id}): wip (failed attempt)`).catch(() => {});
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      d.signal?.removeEventListener("abort", onAbort);
      // A failed worktree cleanup must not mask the task outcome (explicitly tolerated).
      if (!shared) await d.worktrees.remove(task.id).catch(() => {});
    }
  }

  // `budget` is created once per task and shared by all of its attempts (retries do not get a fresh allowance).
  async function runTaskInner(task: TaskSpec) {
    store.setTaskStatus(runId, task.id, "running");
    emit(task, "task_started", { runtime: task.runtime, tier: task.tier, role: task.role, worktree: useShared(task) ? "shared" : "own", unsafe: d.unsafe === true });
    const budget = new BudgetTracker(task.budgetTokens ?? d.defaultBudgetTokens);
    let extra = "";
    const max = d.maxAttempts ?? 1;
    for (let n = 1; n <= max; n++) {
      try {
        const res = await attemptOnce(task, extra, budget);
        // Full report goes to its own table (redacted), never the blackboard. A failed save must not fail a good task.
        let reportSaved = false;
        const report = res.report ? redact(res.report) : "";
        const reportChars = report.length;
        if (report) {
          try { store.saveReport(runId, task.id, report); reportSaved = true; }
          catch { /* report dropped; recorded as reportSaved:false below */ }
        }
        publishResult(store, runId, task.id, res);
        emit(task, "task_finished", { tokens: budget.used, report_chars: reportChars, reportSaved });
        store.setTaskStatus(runId, task.id, "done");
        outcome.set(task.id, "done");
        return;
      } catch (e) {
        const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
        const retryable = !(e instanceof TaskFailure) || e.retryable;
        if (n >= max || !retryable || d.signal?.aborted) {
          outcome.set(task.id, "failed");
          bestEffort(() => emit(task, "task_failed", { reason: msg }));
          bestEffort(() => store.setTaskStatus(runId, task.id, "failed", msg));
          return;
        }
        extra = `\n\nPrevious attempt failed: ${msg}`;
      }
    }
  }

  // Never rejects: a bookkeeping failure for one task marks that task failed (best effort) instead of
  // rejecting runDag and orphaning the other running tasks.
  async function runTask(task: TaskSpec) {
    try { await runTaskInner(task); }
    catch (e) {
      const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
      outcome.set(task.id, "failed");
      bestEffort(() => emit(task, "task_failed", { reason: msg }));
      bestEffort(() => store.setTaskStatus(runId, task.id, "failed", msg));
    }
  }

  const block = (id: string) => { outcome.set(id, "blocked"); bestEffort(() => store.setTaskStatus(runId, id, "blocked")); };

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
