import { WRITER_ROLES, type Dag, type TaskSpec } from "@mar/core";
import type { Store } from "../../server/src/store.js";
import { buildHistory, type HistoryDepConflict, type HistoryIntegration, type HistoryPhase, type HistoryPredicted, type HistoryTask, type HistoryUnmerged } from "./history.js";
import type { IntegrateResult } from "./integrate.js";
import type { Plan } from "./planner.js";
import { redact } from "./redact.js";
import type { Outcome } from "./scheduler.js";

/** `result` is set when the integration branch was built (possibly stopped by a conflict / failed verify); `error` when it could not run. */
export interface IntegrationOutcome { result?: IntegrateResult; error?: string; /** Workspace runs: the repo (folder name) this integration branch lives in. */ repo?: string }

export interface PhaseLimits {
  /** Tasks per phase. */
  maxTasks: number;
  /** Phases per run (per invocation: `mar resume --phases n` raises it). */
  maxPhases: number;
  /** Cap on input+output tokens of all `usage` events of the run, checked before each phase starts. */
  maxTotalTokens: number;
}

export interface PhasePlanArgs {
  phase: number; maxTasks: number;
  previousRemaining: string; history: string;
  /** Re-plan after a phase with failed/blocked tasks or a stopped integration (the planner said nothing remained). */
  recovery: boolean;
  takenIds: ReadonlySet<string>; externalIds: ReadonlySet<string>;
  /** Existing integration branch (phase >= 2), if any: what the repo map should describe. */
  integrationBranch?: string;
  onUsage: (u: { input: number | null; output: number | null }) => void;
}

export interface PhasesDeps {
  store: Store; runId: string; limits: PhaseLimits; signal?: AbortSignal;
  /** Plans phase `a.phase`. Phase 1 failures propagate; a failing re-plan stops the loop (`replan_failed`). */
  plan(a: PhasePlanArgs): Promise<Plan>;
  /** Runs one phase's DAG. `baseRef` is the integration branch from phase 2 on (undefined = the repo's HEAD). */
  run(dag: Dag, ctx: { phase: number; baseRef?: string }): Promise<Record<string, Outcome>>;
  /** Merges done writer branches (topological order). Absent = integration off. `accumulate`: continue the existing integration branch. */
  integrate?(a: { phase: number; branches: string[]; baseRef?: string; accumulate: boolean; /** Workspace runs: integrate the writer branches of this repo. */ repo?: string }): Promise<IntegrationOutcome>;
  /** Workspace runs: whether `repo` takes part in integration (its own `integrate` setting). Default: yes. */
  integrates?(repo: string): boolean;
  /** `git diff --stat` of the integration branch vs the run's base commit, for the re-planner (`repo` in workspace runs). */
  diffStat?(branch: string, repo?: string): Promise<string>;
  onPhaseStart?(p: { phase: number; maxPhases: number; dag: Dag; remaining: string }): void;
}

/** `integration` is the (last) integration outcome of the phase; `integrations` lists every one (one per repo in a workspace run). */
export interface PhaseRec { phase: number; dag: Dag; remaining: string; integration?: IntegrationOutcome; integrations?: IntegrationOutcome[] }
export type StopReason = "max_phases" | "max_tokens" | "no_progress" | "aborted" | "replan_failed" | "recovery_stalled";
export interface PhaseStop { reason: StopReason; message: string }
export interface PhasesResult {
  phases: PhaseRec[];
  /** Outcome of every task of every phase (tasks that never started are absent). */
  results: Record<string, Outcome>;
  /** Work left after the last phase ("" = the planner considers the goal done). */
  remaining: string;
  /** Every task of every phase is done AND the last planner call said done (no stop, nothing remaining). */
  complete: boolean;
  stop?: PhaseStop;
  /** The most recent integration attempt, if any. */
  integration?: IntegrationOutcome;
}

const isIntegrationStuck = (i: IntegrationOutcome): boolean => i.error !== undefined || i.result?.conflict !== undefined || (i.result?.verify !== undefined && !i.result.verify.ok);
const normGoal = (g: string) => g.toLowerCase().replace(/\s+/g, " ").trim();
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface StallPhase { phase: number; remaining: string; tasks: { id: string; goal: string; repo?: string; paths: readonly string[]; status: string }[] }
/**
 * Whether the LAST of `phases` is a recovery phase (planned after one that said nothing remained) that went nowhere:
 * it finished no task, or one of its failed tasks is goal-equivalent (same goal, or same repo and paths) to a failed task
 * of the recovery phase before it. Returns the message, or undefined.
 */
export function recoveryStall(phases: readonly StallPhase[]): string | undefined {
  const i = phases.length - 1;
  const isRec = (k: number) => k > 0 && phases[k - 1]!.remaining === "";
  if (!isRec(i)) return undefined;
  const cur = phases[i]!;
  if (cur.tasks.length > 0 && !cur.tasks.some((t) => t.status === "done")) return `recovery phase ${cur.phase} finished no task, so another recovery would repeat it`;
  if (!isRec(i - 1)) return undefined;
  const sig = (t: StallPhase["tasks"][number]) => (t.paths.length ? `${t.repo ?? ""}|${[...t.paths].sort().join(",")}` : undefined);
  for (const t of cur.tasks.filter((x) => x.status === "failed"))
    for (const u of phases[i - 1]!.tasks.filter((x) => x.status === "failed"))
      if (normGoal(t.goal) === normGoal(u.goal) || (sig(t) !== undefined && sig(t) === sig(u))) return `${u.id} and ${t.id} are the same work and both failed in consecutive recovery phases (failed again)`;
  return undefined;
}

/** Tasks in dependency order (dependencies first, plan order otherwise). Cycle-safe. */
export function topoOrder(dag: Dag): string[] {
  const byId = new Map(dag.tasks.map((t) => [t.id, t]));
  const seen = new Set<string>(); const out: string[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) visit(d);
    out.push(id);
  };
  for (const t of dag.tasks) visit(t.id);
  return out;
}

const bestEffort = (f: () => void) => { try { f(); } catch { /* bookkeeping must never take the run down */ } };
const msg = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
const stamp = (dag: Dag, phase: number): Dag => ({ ...dag, tasks: dag.tasks.map((t): TaskSpec => ({ ...t, phase })) });

/**
 * The phased loop: plan a phase, run it, integrate, re-plan from the results, until the planner says done or a limit
 * stops it. Resumable: stored phases are replayed (finished ones skipped, `runDag` skips done tasks), then the loop
 * continues. Never loops forever: `maxPhases`, `maxTotalTokens` and "a phase with zero done tasks" all stop it.
 */
export async function runPhases(d: PhasesDeps): Promise<PhasesResult> {
  const { store, runId, limits } = d;
  const phases: PhaseRec[] = [];
  const results: Record<string, Outcome> = {};
  let integrationBranch: string | undefined;
  const integratedRepos = new Set<string>(); // "" = the single repo of a non-workspace run
  let lastIntegration: IntegrationOutcome | undefined;
  let stop: PhaseStop | undefined;

  const emit = (type: "phase_started" | "phase_finished" | "integration" | "usage", payload: Record<string, unknown>, agent: string | null = null) =>
    bestEffort(() => { store.appendEvent({ run_id: runId, task_id: null, agent_id: agent, type, payload }); });
  const aborted = () => d.signal?.aborted === true;

  // --- load stored state (resume) -----------------------------------------------------------------------------
  const storedPhases = store.listPhases(runId);
  const legacy = storedPhases.length === 0 ? store.loadPlan(runId) : undefined;
  if (legacy) phases.push({ phase: 1, dag: stamp(legacy, 1), remaining: "" }); // pre-phases run: one plan, nothing remaining
  for (const p of storedPhases) phases.push({ phase: p.phase, dag: stamp(p.dag, p.phase), remaining: p.remaining });
  for (const s of store.taskStatuses(runId))
    if (s.status === "done" || s.status === "failed" || s.status === "blocked") results[s.task_id] = s.status;
  const integrations = store.listEvents(runId).filter((e) => e.type === "integration");
  for (const e of integrations) {
    const p = e.payload as { phase?: unknown; repo?: unknown; branch?: unknown; merged?: unknown; conflict?: IntegrateResult["conflict"]; verify?: IntegrateResult["verify"]; error?: unknown };
    const phase = typeof p.phase === "number" ? p.phase : 1;
    const rec = phases.find((x) => x.phase === phase);
    const outcome: IntegrationOutcome = typeof p.branch === "string"
      ? { result: { branch: p.branch, merged: Array.isArray(p.merged) ? p.merged.map(String) : [], ...(p.conflict ? { conflict: p.conflict } : {}), ...(p.verify ? { verify: p.verify } : {}) } }
      : { error: typeof p.error === "string" ? p.error : "integration failed" };
    if (typeof p.repo === "string") outcome.repo = p.repo;
    if (rec) { rec.integration = outcome; (rec.integrations ??= []).push(outcome); }
    lastIntegration = outcome;
    if (outcome.result) { integrationBranch = outcome.result.branch; integratedRepos.add(outcome.repo ?? ""); }
  }

  // A phase planned after one that said "nothing remains" can only be a recovery from failures (a normal next phase needs remaining work).
  const isRecovery = (idx: number) => idx > 0 && phases[idx - 1].remaining === "";
  // The latest integration outcome per repo, across phases: a stuck one (conflict, failed verify, error) still needs fixing.
  const integrationStuck = () => {
    const latest = new Map<string, IntegrationOutcome>();
    for (const p of phases) for (const i of p.integrations ?? (p.integration ? [p.integration] : [])) latest.set(i.repo ?? "", i);
    return [...latest.values()].some(isIntegrationStuck);
  };
  const hasFailures = (rec: PhaseRec) => rec.dag.tasks.some((t) => results[t.id] === "failed" || results[t.id] === "blocked") || integrationStuck();

  const planned = () => ({ tasks: phases.flatMap((p) => p.dag.tasks) });
  const doneCount = (r: PhaseRec) => r.dag.tasks.filter((t) => results[t.id] === "done").length;
  const allDone = (r: PhaseRec) => doneCount(r) === r.dag.tasks.length;
  const tokens = () => { try { return store.usageTokens(runId); } catch { return 0; } };

  const guard = (phase: number): PhaseStop | undefined => {
    if (phase > limits.maxPhases) return { reason: "max_phases", message: `reached the limit of ${limits.maxPhases} phase${limits.maxPhases === 1 ? "" : "s"}` };
    const used = tokens();
    if (used > limits.maxTotalTokens) return { reason: "max_tokens", message: `used ${used.toLocaleString("en-US")} tokens, over the limit of ${limits.maxTotalTokens.toLocaleString("en-US")} (maxTotalTokens)` };
    return undefined;
  };

  // --- one phase ------------------------------------------------------------------------------------------------
  async function maybeIntegrate(rec: PhaseRec): Promise<void> {
    if (!d.integrate || aborted()) return;
    const writers = new Set(rec.dag.tasks.filter((t) => WRITER_ROLES.has(t.role) && results[t.id] === "done").map((t) => t.id));
    const multi = rec.phase > 1 || rec.remaining !== "" || phases.length > 1;
    // Writer branches per repo (workspace runs); a single repo is one group with key "".
    const byRepo = new Map<string, string[]>();
    for (const id of topoOrder(rec.dag)) {
      if (!writers.has(id)) continue;
      const repo = rec.dag.tasks.find((t) => t.id === id)?.repo ?? "";
      (byRepo.get(repo) ?? byRepo.set(repo, []).get(repo)!).push(`mar/${runId}/${id}`);
    }
    for (const [repo, branches] of byRepo) {
      if (aborted()) return;
      // A single-phase run keeps the original rule (two or more done writers); in a multi-phase run every phase with a done writer integrates.
      if (branches.length < (multi ? 1 : 2)) continue;
      if (repo !== "" && d.integrates && !d.integrates(repo)) continue;
      const accumulate = integratedRepos.has(repo);
      let outcome: IntegrationOutcome;
      try {
        outcome = await d.integrate({ phase: rec.phase, branches, accumulate, ...(accumulate && integrationBranch ? { baseRef: integrationBranch } : {}), ...(repo ? { repo } : {}) });
      } catch (e) { outcome = { error: msg(e) }; }
      if (repo) outcome = { ...outcome, repo };
      rec.integration = outcome; (rec.integrations ??= []).push(outcome); lastIntegration = outcome;
      if (outcome.result) { integrationBranch = outcome.result.branch; integratedRepos.add(repo); }
      const r = outcome.result;
      emit("integration", r ? {
        phase: rec.phase, ...(repo ? { repo } : {}), branch: r.branch, merged: r.merged, ...(r.conflict ? { conflict: r.conflict } : {}),
        ...(r.verify ? { verify: { ok: r.verify.ok, ...(r.verify.failed ? { failed: { ...r.verify.failed, command: redact(r.verify.failed.command) } } : {}), tail: redact(r.verify.tail) } } : {}),
      } : { phase: rec.phase, ...(repo ? { repo } : {}), error: outcome.error });
    }
  }

  async function execute(rec: PhaseRec): Promise<void> {
    emit("phase_started", { phase: rec.phase, maxPhases: limits.maxPhases, tasks: rec.dag.tasks.map((t) => t.id), remaining: rec.remaining });
    bestEffort(() => d.onPhaseStart?.({ phase: rec.phase, maxPhases: limits.maxPhases, dag: rec.dag, remaining: rec.remaining }));
    const before = tokens();
    bestEffort(() => store.setPhaseStatus(runId, rec.phase, "running"));
    let out: Record<string, Outcome>;
    try { out = await d.run(rec.dag, { phase: rec.phase, ...(integrationBranch ? { baseRef: integrationBranch } : {}) }); }
    catch (e) { bestEffort(() => store.setPhaseStatus(runId, rec.phase, "incomplete")); throw e; }
    Object.assign(results, out);
    await maybeIntegrate(rec);
    const count = (o: Outcome) => rec.dag.tasks.filter((t) => results[t.id] === o).length;
    emit("phase_finished", { phase: rec.phase, done: count("done"), failed: count("failed"), blocked: count("blocked"), tokens: Math.max(0, tokens() - before) });
    bestEffort(() => store.setPhaseStatus(runId, rec.phase, allDone(rec) ? "done" : "incomplete"));
  }

  // What to stop on after a phase ran: abort, or no task finished while work remains (re-planning would just repeat).
  const afterPhase = (rec: PhaseRec): PhaseStop | undefined => {
    if (aborted()) return { reason: "aborted", message: "the run was stopped" };
    const idx = phases.indexOf(rec);
    const stalled = recoveryStall(phases.slice(0, idx + 1).map((p) => ({ phase: p.phase, remaining: p.remaining, tasks: p.dag.tasks.map((t) => ({ id: t.id, goal: t.goal, ...(t.repo ? { repo: t.repo } : {}), paths: t.paths, status: results[t.id] ?? "not-run" })) })));
    if (stalled) return { reason: "recovery_stalled", message: stalled };
    if (doneCount(rec) === 0 && rec.remaining !== "") return { reason: "no_progress", message: `phase ${rec.phase} finished no task, so re-planning would repeat it` };
    return undefined;
  };

  // --- history for the re-planner -----------------------------------------------------------------------------
  async function historyFor(): Promise<string> {
    const statuses = new Map(store.taskStatuses(runId).map((s) => [s.task_id, s]));
    const bb = (id: string, suffix: string) => store.latestBb(runId, `${id}/${suffix}`)?.body;
    const histIntegration = (i: IntegrationOutcome): HistoryIntegration => {
      const r = i.result;
      return {
        ...(i.repo ? { repo: i.repo } : {}),
        branch: r?.branch, merged: r?.merged ?? [], conflict: r?.conflict, error: i.error,
        verify: r?.verify ? { ok: r.verify.ok, command: r.verify.failed?.command, tail: r.verify.tail } : undefined,
      };
    };
    const hist: HistoryPhase[] = phases.map((p) => {
      const tasks: HistoryTask[] = p.dag.tasks.map((t) => {
        const status = results[t.id] ?? statuses.get(t.id)?.status ?? "not-run";
        const detail = statuses.get(t.id)?.detail ?? undefined;
        return {
          id: t.id, role: t.role, status, ...(t.repo ? { repo: t.repo } : {}),
          ...(status === "failed" ? { reason: detail ?? "failed" } : status === "blocked" ? { reason: detail ?? "a dependency failed or the run was stopped" } : {}),
          ...(status === "done" ? { summary: bb(t.id, "summary"), decisions: bb(t.id, "decisions"), openQuestions: bb(t.id, "open_questions") } : {}),
          ...(status === "failed" && WRITER_ROLES.has(t.role) ? { branch: `mar/${runId}/${t.id}` } : {}),
        };
      });
      const all = p.integrations ?? (p.integration ? [p.integration] : []);
      const workspace = all.some((i) => i.repo !== undefined);
      return {
        phase: p.phase, tasks,
        ...(all.length && !workspace ? { integration: histIntegration(all[0]) } : {}),
        ...(workspace ? { integrations: all.map(histIntegration) } : {}),
      };
    });
    const last = hist.at(-1);
    // Recovery context: events recorded by the scheduler, and done writer branches the integration branch does not contain.
    const phaseOf = (taskId: string) => phases.find((p) => p.dag.tasks.some((t) => t.id === taskId))?.phase;
    const at = (n: number | undefined) => hist.find((h) => h.phase === n);
    let events: ReturnType<Store["eventsOfType"]> = [];
    try { events = store.eventsOfType(runId, ["dependency_merge_conflict", "predicted_conflict"]); } catch { /* optional context */ }
    for (const e of events) {
      const pl = e.payload;
      if (e.type === "dependency_merge_conflict" && typeof pl.task === "string" && typeof pl.dependency === "string") {
        const h = at(phaseOf(pl.task));
        const c: HistoryDepConflict = { task: pl.task, dependency: pl.dependency, ...(typeof pl.repo === "string" ? { repo: pl.repo } : {}), files: strList(pl.files) };
        if (h) (h.depConflicts ??= []).push(c);
      } else if (e.type === "predicted_conflict") {
        const tasks = strList(pl.tasks);
        const h = at(phaseOf(tasks[0] ?? ""));
        const c: HistoryPredicted = { tasks, files: strList(pl.files) };
        if (h && tasks.length) (h.predicted ??= []).push(c);
      }
    }
    if (last && d.integrate) {
      const outcomes = phases.flatMap((p) => p.integrations ?? (p.integration ? [p.integration] : []));
      const merged = new Set(outcomes.flatMap((o) => o.result?.merged ?? []));
      const conflictAt = new Map(outcomes.flatMap((o) => (o.result?.conflict ? [[o.result.conflict.branch, o.result.conflict.files] as const] : [])));
      const unmerged: HistoryUnmerged[] = [];
      for (const p of phases) for (const id of topoOrder(p.dag)) {
        const t = p.dag.tasks.find((x) => x.id === id)!;
        if (!WRITER_ROLES.has(t.role) || results[id] !== "done") continue;
        if (t.repo && d.integrates && !d.integrates(t.repo)) continue;
        const branch = `mar/${runId}/${id}`;
        if (merged.has(branch)) continue;
        const files = conflictAt.get(branch);
        unmerged.push({ task: id, branch, ...(t.repo ? { repo: t.repo } : {}), ...(files ? { conflictFiles: files } : {}) });
      }
      if (unmerged.length) last.unmerged = unmerged;
    }
    if (d.diffStat) {
      for (const i of last?.integrations ?? (last?.integration ? [last.integration] : [])) {
        if (!i.branch) continue;
        try { i.diffStat = await d.diffStat(i.branch, i.repo); } catch { /* optional context */ }
      }
    }
    return buildHistory(hist);
  }

  // --- 1. replay stored phases that are not finished (resume) -------------------------------------------------------
  for (const [i, rec] of phases.slice().entries()) {
    if (allDone(rec) && rec.dag.tasks.length > 0) continue;
    if (i + 1 < phases.length && isRecovery(i + 1)) continue; // a recovery phase was planned after it: its failures were handed over, never re-run them
    stop = guard(rec.phase);
    if (stop) break;
    await execute(rec);
    stop = afterPhase(rec);
    if (stop) break;
  }

  // --- 2. plan and run further phases --------------------------------------------------------------------------------
  while (!stop) {
    const last = phases.at(-1);
    const failures = last !== undefined && hasFailures(last);
    // The planner said this phase completes the goal: done, unless it ended with failures or a stuck integration.
    const recovery = failures && last!.remaining === "" && !aborted();
    if (last && last.remaining === "" && !recovery) break;
    const phase = (last?.phase ?? 0) + 1;
    if (last) {
      if (aborted()) { stop = { reason: "aborted", message: "the run was stopped" }; break; }
      stop = guard(phase);
      if (stop) break;
    } else {
      stop = guard(phase);
      if (stop) break;
    }
    const args: PhasePlanArgs = {
      phase, maxTasks: limits.maxTasks, previousRemaining: last?.remaining ?? "", recovery: failures,
      history: last ? await historyFor() : "",
      takenIds: new Set(phases.flatMap((p) => p.dag.tasks.map((t) => t.id))),
      externalIds: new Set(phases.flatMap((p) => p.dag.tasks.filter((t) => results[t.id] === "done").map((t) => t.id))),
      ...(integrationBranch ? { integrationBranch } : {}),
      onUsage: (u) => emit("usage", { input: u.input, output: u.output, cached: null, costUsd: null, planner: true }, "planner"),
    };
    let plan: Plan;
    if (!last) plan = await d.plan(args); // phase 1: the caller records and rethrows planning failures
    else {
      try { plan = await d.plan(args); }
      catch (e) {
        stop = aborted() ? { reason: "aborted", message: "the run was stopped while re-planning" } : { reason: "replan_failed", message: `re-planning failed: ${msg(e)}` };
        break;
      }
      if (plan.tasks.length === 0 && recovery) { // nothing planned although the last phase has unresolved failures
        stop = { reason: "recovery_stalled", message: `the planner proposed no recovery work although phase ${last.phase} has unresolved failures` };
        break;
      }
      if (plan.tasks.length === 0) { // the planner says the goal is done
        last.remaining = "";
        bestEffort(() => store.savePhase(runId, last.phase, last.dag, "", allDone(last) ? "done" : "incomplete"));
        break;
      }
    }
    const rec: PhaseRec = { phase, dag: stamp({ tasks: plan.tasks }, phase), remaining: plan.remaining };
    phases.push(rec);
    store.savePhase(runId, phase, rec.dag, rec.remaining, "planned");
    store.savePlan(runId, planned());
    await execute(rec);
    stop = afterPhase(rec);
  }

  const lastPhase = phases.at(-1);
  const remaining = lastPhase?.remaining ?? "";
  const tasks = phases.flatMap((p) => p.dag.tasks);
  // Failures of earlier phases are superseded when the final phase is a recovery phase that finished everything.
  const recovered = lastPhase !== undefined && isRecovery(phases.length - 1) && allDone(lastPhase);
  const complete = !stop && remaining === "" && tasks.length > 0 && (recovered || tasks.every((t) => results[t.id] === "done"));
  return { phases, results, remaining, complete, ...(stop ? { stop } : {}), ...(lastIntegration ? { integration: lastIntegration } : {}) };
}
