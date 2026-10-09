import { TaskResultSchema, WRITER_ROLES, estimateTokens, matchesAnyGlob, type Dag, type EventType, type Role, type Runtime, type TaskResult, type TaskSpec, type Tier } from "@mar/core";
import type { Adapter } from "@mar/adapters";
import type { Store } from "../../server/src/store.js";
import { BudgetTracker } from "./budget.js";
import { buildPrompt, type WorkspacePrompt } from "./prompt.js";
import { DependencyMergeConflict, type CreateCtx, type PendingMerge } from "./worktree.js";
import { injectSlices, publishResult } from "./blackboard.js";
import { redact } from "./redact.js";
import { usesSharedWorktree } from "./readonly.js";
import type { KnowledgeBase } from "./knowledge.js";
import { updateKnowledge } from "./knowledgeUpdate.js";
import { runVerify } from "./verify.js";

export interface RunDeps {
  /** Shared persistent KB, supplied only when enabled. */
  knowledge?: KnowledgeBase;
  store: Store; runId: string; dag: Dag; repo: string;
  adapters: Record<Runtime, Adapter>;
  worktrees: { pendingMerges?(taskId: string): PendingMerge | undefined; create(taskId: string, dependsOn?: string[], ctx?: CreateCtx): Promise<string>; commit(taskId: string, message: string): Promise<void>; remove(taskId: string): Promise<void>;
    // Optional: writer-task helpers. Absent = no dependency links / no ownership enforcement.
    link?(taskId: string): Promise<string[]>;                              // symlink configured dependency paths (node_modules...)
    head?(taskId: string): Promise<string>;                                // HEAD sha of the task's worktree
    changedFiles?(taskId: string, sinceSha: string): Promise<string[]>;    // files changed on the task branch since a sha
    // Optional: one detached worktree for read-only tasks (no branch, no commits). Absent = a worktree per task.
    shared?: { acquire(): Promise<string>; release(): Promise<void> };
    // Optional (workspace runs): sibling symlinks of a writer, and the post-hoc check that they were left untouched (dirty ones are reverted).
    siblingDirs?(taskId: string): string[];
    checkSiblings?(taskId: string): Promise<{ repo: string; files: string[] }[]> };
  /** Workspace run (parent folder of several git repos): the repo folder names. Absent = a single repo. */
  workspace?: { repos: readonly string[] };
  /** Per-repo overrides of `verify` / `ownership` (workspace runs; `repo` is the task's repo, undefined for none). */
  verifyFor?: (repo: string | undefined) => { commands: string[]; timeoutMs: number } | undefined;
  ownershipFor?: (repo: string | undefined) => "warn" | "enforce";
  modelFor(runtime: Runtime, tier: Tier): string | null;
  /** Try the other CLI when the selected runtime fails, unless a USD cap is configured. Defaults to false for library callers. */
  fallbackRuntime?: boolean;
  toolsFor(role: Role): string[];
  concurrency: number; defaultBudgetTokens?: number; unsafe?: boolean;
  maxAttempts?: number;                     // attempts per worker task; default 1 (no retry)
  // Self-healing: retries after the first attempt (attempts = maxRetries + 1; wins over maxAttempts). Timeouts and
  // unparseable results become retryable, partial worktree work is kept, and the final retry escalates tier (or
  // switches runtime when already at "high").
  maxRetries?: number;
  /** Disable final-retry escalation (default true). */
  escalateOnRetry?: boolean;
  /** Disable all retries, including legacy maxAttempts (default true). */
  healEnabled?: boolean;
  repairResult?: (raw: string) => Promise<string>;
  signal?: AbortSignal;
  // Per-attempt wall-clock limit; undefined = no timeout (the CLI supplies the default). A timeout fails the task
  // with `failed:timeout` (not retried).
  taskTimeoutMs?: number;
  // Forwarded to the adapter as `maxBudgetUsd`. Claude only reports usage at the end of a run, so the token budget
  // (`budgetTokens`) is enforced post-hoc; this USD cap is the only real mid-run guard.
  maxBudgetUsdPerTask?: number;
  // Verify gate: writer tasks (implementer/tester) must pass these commands in their own worktree before dependents see
  // their output. Empty/absent = gate off. `runVerify` is injectable for tests.
  verify?: { commands: string[]; timeoutMs: number };
  runVerify?: typeof runVerify;
  // What to do when a writer changed files outside its declared `paths`: "warn" (default) only emits an event.
  ownership?: "warn" | "enforce";
}
export type Outcome = "done" | "failed" | "blocked";
// `note` replaces the generic "Previous attempt failed" text in the retry prompt.
class TaskFailure extends Error { constructor(m: string, public retryable = true, public note?: string) { super(m); } }
const VERIFY_TAIL_CHARS = 1500;
const MAX_VIOLATION_FILES = 50;

const TIMEOUT = Symbol("timeout");
const RETRY_OUTPUT_CHARS = 1500;
const NEXT_TIER: Record<Tier, Tier | undefined> = { low: "mid", mid: "high", high: undefined };
const LIMIT_ERROR = /usage limit|rate limit|quota|credits/i;
const mergeNote = (m: PendingMerge) => `\n\n## Resolve a merge conflict first\nMerging dependency branch \`${m.branch}\` into this worktree conflicted in: ${m.files.join(", ")}. The merge is in progress. Before your own work: open each conflicted file, combine BOTH sides' intent (keep every route/export/migration from both; never just pick one side), remove all conflict markers, \`git add\` them and run \`git commit --no-edit\`.${m.remaining.length ? ` Then merge the remaining dependency branches one at a time (${m.remaining.map((b) => `\`git merge --no-edit ${b}\``).join(", ")}) resolving any conflicts the same way.` : ""} Your task fails if any conflict marker remains or a dependency branch is left unmerged.`;
const RESUME_NOTE = "\n\n## Resumed task\nAn earlier attempt at this task was interrupted, timed out or failed. Its partial work is already in this worktree (see `git log` and `git status`). Inspect it and continue from there; do not redo or discard work that is already correct.";
const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
async function parseResult(raw: string, repair?: (r: string) => Promise<string>, healing = false): Promise<TaskResult> {
  const attempt = (s: string) => TaskResultSchema.parse(JSON.parse(stripFence(s)));
  try { return attempt(raw); } catch {
    // Not retryable: a retry would just reproduce the same unparseable output.
    if (!repair) throw new TaskFailure("bad-result", healing);
    try { return attempt(await repair(raw)); } catch { throw new TaskFailure("bad-result", healing); }
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
  // Only tasks of THIS dag count: the store also holds the tasks of other phases.
  const byId = new Map(d.dag.tasks.map((t) => [t.id, t]));
  bestEffort(() => {
    for (const s of store.taskStatuses(runId)) {
      if (!byId.has(s.task_id)) continue;
      if (s.status === "done") outcome.set(s.task_id, "done");
      // Stale failed/blocked/running rows of an earlier attempt: these tasks are about to run again, so they wait as pending.
      else store.setTaskStatus(runId, s.task_id, "pending");
    }
  });
  const running = new Map<string, Promise<void>>();
  const attempts = new Map<string, number>();
  const emitEvent = (task: TaskSpec, type: EventType, payload: Record<string, unknown> = {}) =>
    store.appendEvent({ run_id: runId, task_id: task.id, agent_id: task.id, type, payload: { attempt: attempts.get(task.id) ?? 1, ...payload } });

  const emit = emitEvent;

  // Read-only tasks (see usesSharedWorktree: no writer role, no writer ancestor, no Edit/Write/Bash tools) run
  // concurrently in ONE directory, which is safe only because they cannot write. Without `shared`: legacy per-task.
  const useShared = (task: TaskSpec) => d.worktrees.shared !== undefined && usesSharedWorktree(task, byId, d.toolsFor);
  // Workspace: only same-repo writer branches are merged into a task's worktree; cross-repo dependencies are ordering only.
  const sameRepoDeps = (task: TaskSpec) => task.dependsOn.filter((id) => { const dep = byId.get(id); return dep !== undefined && dep.repo === task.repo && !useShared(dep); });
  // Workspace: per OTHER repo, the writer tasks of that repo this task depends on (transitively), dependencies first.
  // The task's sibling view of that repo must include their work (their branches are merged into a per-task checkout).
  const siblingDepsOf = (task: TaskSpec): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const dep = byId.get(id);
      if (!dep) return;
      dep.dependsOn.forEach(visit);
      if (dep.repo !== undefined && dep.repo !== task.repo && WRITER_ROLES.has(dep.role) && !useShared(dep)) (out[dep.repo] ??= []).push(id);
    };
    task.dependsOn.forEach(visit);
    return out;
  };
  let sharedP: Promise<string> | undefined;
  const acquireShared = () => {
    sharedUsedOf.set(d, true);
    sharedP ??= d.worktrees.shared!.acquire().catch((e) => { sharedP = undefined; throw e; }); // a failed acquire may be retried
    return sharedP;
  };

  const limited = new Map<Runtime, string>(); // runtimes that reported a usage limit during this run, with the message
  const startShaOf = new Map<string, string>();
  // Runtime conflict prediction: parallel writers (no dependency path between them, same repo) that stray into the same file.
  const strays = new Map<string, string[]>();
  const predictedPairs = new Set<string>();
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.dependsOn ?? []).some((x) => x === to || reaches(x, to, seen));
  };
  function predictConflicts(task: TaskSpec, outside: string[]) {
    strays.set(task.id, outside);
    for (const other of byId.values()) {
      if (other.id === task.id || !WRITER_ROLES.has(other.role) || other.repo !== task.repo) continue;
      if (reaches(task.id, other.id) || reaches(other.id, task.id)) continue;
      const pair = [task.id, other.id].sort();
      if (predictedPairs.has(pair.join("\0"))) continue;
      const theirs = strays.get(other.id) ?? [];
      const files = new Set<string>();
      for (const f of outside) if (theirs.includes(f) || (other.paths.length > 0 && matchesAnyGlob(f, other.paths))) files.add(f);
      for (const f of theirs) if (task.paths.length > 0 && matchesAnyGlob(f, task.paths)) files.add(f);
      if (files.size === 0) continue;
      predictedPairs.add(pair.join("\0"));
      bestEffort(() => emit(task, "predicted_conflict", { tasks: pair, files: [...files].slice(0, MAX_VIOLATION_FILES).map(redact) }));
    }
  }
  // Post-hoc path ownership: files this writer changed (committed) outside every declared glob.
  async function checkOwnership(task: TaskSpec, startSha: string | undefined) {
    if (task.paths.length === 0 || startSha === undefined || !d.worktrees.changedFiles) return;
    const enforce = (d.ownershipFor ? d.ownershipFor(task.repo) : d.ownership) === "enforce";
    let outside: string[];
    try { outside = (await d.worktrees.changedFiles(task.id, startSha)).filter((f) => !matchesAnyGlob(f, task.paths)); }
    catch (e) { if (enforce) throw e; return; } // advisory mode never fails a task over bookkeeping
    if (outside.length === 0) return;
    emit(task, "ownership_violation", { files: outside.slice(0, MAX_VIOLATION_FILES).map(redact), count: outside.length, paths: task.paths, enforced: enforce });
    predictConflicts(task, outside);
    if (enforce)
      throw new TaskFailure("failed:ownership", true,
        `\n\nYou changed files outside your declared paths (${task.paths.join(", ")}): ${outside.slice(0, 20).map(redact).join(", ")}. Only change files matching your paths.`);
  }

  // Siblings are read-only checkouts shared by all tasks; a worker that wrote to one is reported and the checkout reverted.
  async function checkSiblings(task: TaskSpec, mayFail: boolean) {
    if (!d.worktrees.checkSiblings) return;
    const found = await d.worktrees.checkSiblings(task.id).catch(() => []);
    if (found.length === 0) return;
    for (const c of found) emit(task, "sibling_modified", { repo: c.repo, files: c.files.slice(0, MAX_VIOLATION_FILES).map(redact), count: c.files.length });
    const enforce = (d.ownershipFor ? d.ownershipFor(task.repo) : d.ownership) === "enforce";
    if (mayFail && enforce)
      throw new TaskFailure("failed:sibling", true,
        `\n\nYou modified read-only sibling repos (${found.map((c) => c.repo).join(", ")}); those changes were discarded. Only change files in your own repo.`);
  }

  async function runGate(task: TaskSpec, cwd: string, signal: AbortSignal) {
    const v = d.verifyFor ? d.verifyFor(task.repo) : d.verify;
    if (!v || v.commands.length === 0) return;
    emit(task, "verify_started", { commands: v.commands.map(redact) });
    let r: Awaited<ReturnType<typeof runVerify>>;
    try { r = await (d.runVerify ?? runVerify)(cwd, v.commands, { signal, timeoutMs: v.timeoutMs }); }
    catch (e) { r = { ok: false, failed: { command: v.commands[0], code: null, timedOut: false }, tail: redact(e instanceof Error ? e.message : String(e)), ms: 0 }; }
    if (r.ok) { emit(task, "verify_passed", { ms: r.ms }); return; }
    const command = redact(r.failed?.command ?? v.commands[0]);
    const tail = redact(r.tail).slice(-VERIFY_TAIL_CHARS);
    const timedOut = r.failed?.timedOut ?? false;
    emit(task, "verify_failed", { command, code: r.failed?.code ?? null, timedOut, tail, ms: r.ms });
    // Not retried on timeout (it would just time out again).
    throw new TaskFailure("failed:verify", !timedOut || d.maxRetries !== undefined, `\n\nVerification failed (${command}):\n${tail}`);
  }

  async function attemptOnce(task: TaskSpec, extra: string, budget: BudgetTracker, attempt: number): Promise<TaskResult> {
    // Capture the attempt: a timed-out adapter may still emit while the next attempt is running.
    const emit: typeof emitEvent = (t, type, payload = {}) => emitEvent(t, type, { ...payload, attempt });
    const { slices, missing } = injectSlices(store, runId, task, attempt);
    if (missing.length) throw new TaskFailure(`missing:${missing[0]}`, false);
    const ws = d.workspace;
    const shared = useShared(task);
    // Workspace: a writer sees the other repos read-only at ../<name> (only for runtimes where that was verified).
    const siblingNames = ws && !shared && task.repo !== undefined && d.adapters[task.runtime].siblingRead !== false ? ws.repos.filter((n) => n !== task.repo).sort() : [];
    const wsPrompt: WorkspacePrompt | undefined = !ws ? undefined : shared ? { all: [...ws.repos].sort() } : { repo: task.repo, siblings: siblingNames };
    let prompt = buildPrompt(task, slices, wsPrompt, d.knowledge?.root) + extra;
    if (ws && !shared && task.repo === undefined) throw new TaskFailure("failed:no-repo", false);
    if (siblingNames.length > 0) sharedUsedOf.set(d, true); // the sibling symlinks point into the shared view: release it at the end of the run
    let cwd: string;
    try {
      cwd = shared ? await acquireShared()
        : ws ? await d.worktrees.create(task.id, sameRepoDeps(task), { repo: task.repo, siblings: siblingNames.length > 0, ...(siblingNames.length > 0 ? { siblingDeps: siblingDepsOf(task) } : {}) })
        : await d.worktrees.create(task.id, task.dependsOn.filter((id) => { const dep = byId.get(id); return dep !== undefined && !useShared(dep); })); // read-only deps ran in the shared worktree: no branch to merge
    } catch (e) {
      if (!(e instanceof DependencyMergeConflict)) throw e;
      // Not retryable: the same merge would conflict again. The files go to the event and the re-planner's history.
      bestEffort(() => emit(task, "dependency_merge_conflict", { task: task.id, dependency: e.dependency, ...(e.repo ? { repo: e.repo } : {}), files: e.files.slice(0, MAX_VIOLATION_FILES).map(redact) }));
      throw new TaskFailure(e.message, false);
    }
    const pm = d.worktrees.pendingMerges?.(task.id);
    if (pm) {
      bestEffort(() => emit(task, "dependency_merge_conflict", { task: task.id, dependency: pm.branch, resolving: true, files: pm.files.slice(0, MAX_VIOLATION_FILES).map(redact) }));
      prompt += mergeNote(pm);
    }
    emit(task, "prompt_sent", { prompt: redact(prompt), keys: slices.map((s) => s.key), tokens: estimateTokens(prompt), runtime: task.runtime });
    const extraDirs = siblingNames.length > 0 ? d.worktrees.siblingDirs?.(task.id) ?? [] : [];
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    d.signal?.addEventListener("abort", onAbort);
    if (d.signal?.aborted) ac.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let committed = false;
    let siblingsChecked = false;
    const gated = !shared && WRITER_ROLES.has(task.role);
    try {
      // Writers get the configured dependency links, and remember where their branch started (for ownership checks).
      let startSha: string | undefined;
      if (gated) {
        await d.worktrees.link?.(task.id).catch(() => {}); // best effort: the task may still work without links
        // Kept across retries: a retry resumes the same branch, so earlier out-of-bounds commits must stay visible.
        startSha = startShaOf.get(task.id) ?? await d.worktrees.head?.(task.id).catch(() => undefined);
        if (startSha !== undefined) startShaOf.set(task.id, startSha);
      }
      const consume = async (runtime: Runtime): Promise<string | undefined> => {
        let raw: string | undefined;
        let overBudget = false;
        for await (const ev of d.adapters[runtime].run({
          taskId: task.id, prompt, cwd, model: d.modelFor(runtime, task.tier),
          allowedTools: d.toolsFor(task.role), signal: ac.signal, unsafe: d.unsafe,
          maxBudgetUsd: d.maxBudgetUsdPerTask, ...(extraDirs.length ? { extraDirs } : {}),
        })) {
          // A final usage event can arrive adjacent to a completed result. Keep that result, but stop
          // if the agent tries to do any further work after the cap was crossed.
          if (overBudget && ev.type !== "result") { ac.abort(); throw new TaskFailure("failed:budget", false); }
          if (ev.type === "usage") { budget.add(ev); emit(task, "usage", { ...ev }); }
          else if (ev.type === "assistant_text") emit(task, "assistant_text", { text: redact(ev.text) });
          else if (ev.type === "tool_call") emit(task, "tool_call", { name: redact(ev.name), input: boundedToolInput(ev.input) });
          else if (ev.type === "tool_result") emit(task, "tool_result", { name: redact(ev.name), output: redact(ev.output).slice(0, 2000), isError: ev.isError ?? false });
          else raw = ev.text;
          if (budget.exceeded) overBudget = true;
        }
        if (overBudget && raw === undefined) throw new TaskFailure("failed:budget", false);
        return raw;
      };
      const work = (async () => {
        // A runtime that hit its usage limit earlier in this run stays unavailable: go straight to the other CLI.
        if (d.fallbackRuntime && d.maxBudgetUsdPerTask === undefined && limited.has(task.runtime)) {
          const alternate: Runtime = task.runtime === "claude" ? "codex" : "claude";
          emit(task, "runtime_fallback", { from: task.runtime, to: alternate, reason: limited.get(task.runtime) });
          return consume(alternate);
        }
        try { return await consume(task.runtime); }
        catch (e) {
          // Codex cannot enforce maxBudgetUsd; switching CLIs would bypass a configured spend cap.
          if (!d.fallbackRuntime || d.maxBudgetUsdPerTask !== undefined || budget.exceeded || ac.signal.aborted || d.signal?.aborted) throw e;
          const alternate: Runtime = task.runtime === "claude" ? "codex" : "claude";
          const reason = redact(e instanceof Error ? e.message : String(e)).slice(0, 500);
          if (LIMIT_ERROR.test(reason)) limited.set(task.runtime, reason);
          emit(task, "runtime_fallback", { from: task.runtime, to: alternate, reason });
          return consume(alternate);
        }
      })();
      let raw: string | undefined;
      if (d.taskTimeoutMs === undefined) raw = await work;
      else {
        // Race against the timer so an adapter that ignores the abort signal (or never yields) cannot hang the run.
        const timeout = new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => { ac.abort(); res(TIMEOUT); }, d.taskTimeoutMs); });
        work.catch(() => {}); // a late rejection after the timeout won must not be unhandled
        const first = await Promise.race([work, timeout]);
        if (first === TIMEOUT) throw new TaskFailure("failed:timeout", d.maxRetries !== undefined && !d.signal?.aborted);
        raw = first;
      }
      if (raw === undefined) throw new TaskFailure("no-result", !d.signal?.aborted);
      const res = await parseResult(raw, d.repairResult, d.maxRetries !== undefined);
      if (!shared) await d.worktrees.commit(task.id, `mar(${task.id}): ${task.goal.split("\n")[0].slice(0, 60)}`);
      committed = true;
      if (gated) {
        siblingsChecked = true;
        await checkSiblings(task, true);
        await checkOwnership(task, startSha);
        await runGate(task, cwd, ac.signal); // before publishResult: dependents never see unverified output
      }
      if (d.knowledge) {
        // Scan the verified task checkout before cleanup; persist into the run root's KB.
        // Knowledge bookkeeping must not fail a successful task.
        bestEffort(() => {
          const updated = updateKnowledge({ ...d.knowledge!, root: cwd }, [{ taskId: `${runId}/${task.id}`, result: res }]);
          d.knowledge!.index = updated.kb.index;
        });
      }
      return res;
    } catch (e) {
      // Keep partial work on the per-task branch: the worktree is removed below. Best effort: a failing commit
      // (e.g. nothing to add, git error) must not mask the original failure.
      if (!committed && !shared) await d.worktrees.commit(task.id, `mar(${task.id}): wip (failed attempt)`).catch(() => {});
      if (gated && !siblingsChecked) await checkSiblings(task, false).catch(() => {});
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
    // A task that already started in this run (timed out, failed or interrupted) left its partial work on its branch; the worktree reuses it.
    const resumed = !useShared(task) && store.eventsOfType(runId, ["task_started"]).some((e) => e.task_id === task.id);
    attempts.set(task.id, 1);
    store.setTaskStatus(runId, task.id, "running");
    emit(task, "task_started", { runtime: task.runtime, tier: task.tier, role: task.role, worktree: useShared(task) ? "shared" : "own", unsafe: d.unsafe === true, ...(d.workspace ? { repo: task.repo ?? "*" } : {}) });
    const budget = new BudgetTracker(task.budgetTokens ?? d.defaultBudgetTokens);
    let extra = resumed ? RESUME_NOTE : "";
    const max = d.healEnabled === false ? 1 : d.maxRetries !== undefined ? Math.max(0, Math.floor(d.maxRetries)) + 1 : d.maxAttempts ?? 1;
    let lastReason = "";
    for (let n = 1; n <= max; n++) {
      attempts.set(task.id, n);
      // Final retry of a self-healing task: a stronger tier, or the other runtime when already at the top tier.
      let current = task;
      if (d.maxRetries !== undefined && d.escalateOnRetry !== false && n > 1 && n === max) {
        const tier = NEXT_TIER[task.tier];
        if (tier) current = { ...task, tier };
        else if (d.maxBudgetUsdPerTask === undefined) current = { ...task, runtime: task.runtime === "claude" ? "codex" : "claude" };
      }
      if (n > 1) bestEffort(() => emit(task, "task_retry", { attempt: n, max, reason: lastReason, escalated: current !== task, tier: current.tier, runtime: current.runtime }));
      if (n > 1) bestEffort(() => emit(current, "heal_started", { reason: lastReason, tier: current.tier, runtime: current.runtime }));
      try {
        const res = await attemptOnce(current, extra, budget, n);
        // Full report goes to its own table (redacted), never the blackboard. A failed save must not fail a good task.
        let reportSaved = false;
        const report = res.report ? redact(res.report) : "";
        const reportChars = report.length;
        if (report) {
          try { store.saveReport(runId, task.id, report); reportSaved = true; }
          catch { /* report dropped; recorded as reportSaved:false below */ }
        }
        publishResult(store, runId, task.id, res, n);
        emit(task, "task_finished", { tokens: budget.used, report_chars: reportChars, reportSaved });
        store.setTaskStatus(runId, task.id, "done");
        outcome.set(task.id, "done");
        if (n > 1) bestEffort(() => emit(current, "heal_finished"));
        return;
      } catch (e) {
        const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
        if (n > 1) bestEffort(() => emit(current, "heal_failed", { reason: msg }));
        const retryable = !(e instanceof TaskFailure) || e.retryable;
        if (n >= max || !retryable || d.signal?.aborted) {
          outcome.set(task.id, "failed");
          bestEffort(() => emit(task, "task_failed", { reason: msg }));
          bestEffort(() => store.setTaskStatus(runId, task.id, "failed", msg));
          return;
        }
        lastReason = msg;
        const detail = redact(e instanceof Error ? e.message : String(e)).slice(-RETRY_OUTPUT_CHARS);
        extra = (e instanceof TaskFailure && e.note ? e.note : `\n\nPrevious attempt failed: ${detail}`)
          + (d.maxRetries !== undefined ? RESUME_NOTE : ""); // partial work was committed to the branch: continue from it
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
