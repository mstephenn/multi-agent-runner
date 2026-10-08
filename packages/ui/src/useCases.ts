// Pure derivation behind the Use cases tab: each use case with the tasks that serve it and a rolled-up status.
import type { Dag } from "@mar/core";
import type { AgentStatus, AgentView } from "./derive.js";

export type UseCaseView = {
  id: string; title: string; description?: string;
  tasks: AgentView[];
  counts: Record<AgentStatus, number>;
  /** Rolled up: failed/blocked beats running beats pending; done only when every task is done; "uncovered" = no task serves it (yet). */
  status: AgentStatus | "uncovered";
  /** 0..1 share of tasks that are done. */
  progress: number;
};
export type UseCaseBoard = { cases: UseCaseView[]; unassigned: AgentView[] };

const zero = (): Record<AgentStatus, number> => ({ pending: 0, running: 0, done: 0, failed: 0, blocked: 0 });

export function deriveUseCases(plan: Dag | null, agents: AgentView[]): UseCaseBoard {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const cases = (plan?.useCases ?? []).map((u): UseCaseView => {
    const tasks = (plan?.tasks ?? []).filter((t) => t.useCases?.includes(u.id)).flatMap((t) => byId.get(t.id) ?? []);
    const counts = zero();
    for (const t of tasks) counts[t.status]++;
    const status: UseCaseView["status"] =
      tasks.length === 0 ? "uncovered" : counts.failed + counts.blocked > 0 ? "failed" : counts.running > 0 ? "running"
        : counts.done === tasks.length ? "done" : "pending";
    return { id: u.id, title: u.title, ...(u.description ? { description: u.description } : {}), tasks, counts, status, progress: tasks.length ? counts.done / tasks.length : 0 };
  });
  const unassigned = (plan?.tasks ?? []).filter((t) => !t.useCases?.length).flatMap((t) => byId.get(t.id) ?? []);
  return { cases, unassigned };
}
