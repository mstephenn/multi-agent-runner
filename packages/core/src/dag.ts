import { z } from "zod";
import { TaskSpec } from "./schemas.js";

export type Dag = { tasks: TaskSpec[] };
export class DagError extends Error {}

export function parseDag(input: unknown): Dag {
  const dag = z.object({ tasks: z.array(TaskSpec).min(1) }).parse(input);
  const byId = new Map<string, TaskSpec>();
  for (const t of dag.tasks) {
    if (byId.has(t.id)) throw new DagError(`duplicate task id: ${t.id}`);
    byId.set(t.id, t);
  }
  for (const t of dag.tasks)
    for (const d of t.dependsOn)
      if (!byId.has(d)) throw new DagError(`task ${t.id} depends on unknown task ${d}`);

  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (id: string): Set<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new DagError(`cycle detected at task ${id}`);
    visiting.add(id);
    const set = new Set<string>();
    for (const d of byId.get(id)!.dependsOn) { set.add(d); for (const a of walk(d)) set.add(a); }
    visiting.delete(id);
    ancestors.set(id, set);
    return set;
  };
  for (const t of dag.tasks) walk(t.id);
  for (const t of dag.tasks)
    for (const key of t.needs) {
      const owner = key.split("/")[0];
      if (!ancestors.get(t.id)!.has(owner))
        throw new DagError(`task ${t.id} needs ${key} but ${owner} is a non-ancestor`);
    }
  return dag;
}
