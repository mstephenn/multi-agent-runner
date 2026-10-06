import { z } from "zod";
import { TaskSpec, WRITER_ROLES } from "./schemas.js";
import { globsOverlap } from "./globs.js";

export type Dag = { tasks: TaskSpec[] };
export class DagError extends Error {}

// Keys the blackboard publishes for every finished task (see orchestrator publishResult).
const NEEDS_SUFFIXES = new Set(["summary", "decisions", "open_questions", "files"]);

const badPath = (p: string): string | null => {
  if (p === "") return "is empty";
  if (p.includes("\\")) return "contains a backslash";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "is absolute";
  const segs = p.split("/");
  if (segs.includes("..")) return 'contains a ".." segment';
  if (segs.includes(".")) return 'contains a "." segment';
  if (segs[0] === ".mar" || segs[0] === ".git") return "points into .mar/ or .git/";
  return null;
};

export interface ParseDagOpts {
  /** Ids of tasks finished in EARLIER phases: their blackboard keys may be listed in `needs` without a `dependsOn`. */
  external?: ReadonlySet<string>;
}

export function parseDag(input: unknown, opts: ParseDagOpts = {}): Dag {
  const external = opts.external ?? new Set<string>();
  const dag = z.object({ tasks: z.array(TaskSpec).min(1) }).parse(input);
  const byId = new Map<string, TaskSpec>();
  for (const t of dag.tasks) {
    if (byId.has(t.id)) throw new DagError(`duplicate task id: ${t.id}`);
    byId.set(t.id, t);
  }
  for (const t of dag.tasks)
    for (const d of t.dependsOn)
      if (!byId.has(d)) {
        if (external.has(d)) throw new DagError(`task ${t.id} depends on ${d}, a task of an earlier phase: dependsOn may only reference tasks of this phase; use needs ("${d}/summary") instead`);
        throw new DagError(`task ${t.id} depends on unknown task ${d}`);
      }

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
      const [owner, suffix, ...rest] = key.split("/");
      if (suffix === undefined || rest.length || !NEEDS_SUFFIXES.has(suffix))
        throw new DagError(`task ${t.id} needs "${key}": suffix must be one of ${[...NEEDS_SUFFIXES].join("|")}`);
      if (!byId.has(owner) && external.has(owner)) continue;
      if (!ancestors.get(t.id)!.has(owner))
        throw new DagError(`task ${t.id} needs ${key} but ${owner} is a non-ancestor`);
    }
  for (const t of dag.tasks)
    for (const p of t.paths) {
      const why = badPath(p);
      if (why) throw new DagError(`task ${t.id}: invalid path ${JSON.stringify(p)} (${why}); paths must be repo-relative globs`);
    }

  // Writers with no dependency path between them run in parallel: they must declare disjoint paths.
  const writers = dag.tasks.filter((t) => WRITER_ROLES.has(t.role));
  for (let i = 0; i < writers.length; i++)
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i], b = writers[j];
      if (ancestors.get(a.id)!.has(b.id) || ancestors.get(b.id)!.has(a.id)) continue;
      const missing = [a, b].filter((t) => t.paths.length === 0).map((t) => t.id);
      if (missing.length)
        throw new DagError(`tasks ${a.id} and ${b.id} can run in parallel but ${missing.join(" and ")} declare${missing.length === 1 ? "s" : ""} no paths: list repo-relative paths, or make one depend on the other`);
      for (const pa of a.paths) for (const pb of b.paths)
        if (globsOverlap(pa, pb))
          throw new DagError(`tasks ${a.id} and ${b.id} can run in parallel but their paths overlap (${pa} vs ${pb}): make paths disjoint or make one depend on the other`);
    }
  return dag;
}
