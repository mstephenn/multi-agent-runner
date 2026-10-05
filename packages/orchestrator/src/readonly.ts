import { WRITER_ROLES, type TaskSpec } from "@mar/core";

// Roles whose tasks write code (see `toolsFor` in the CLI: implementer/tester get Edit/Write/Bash): defined in core.
export { WRITER_ROLES };
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "Bash"]);

/**
 * True when the task can neither write nor depend (transitively) on a task that can. Such a task needs no branch
 * and no committed changes merged in, so it may share one detached worktree with other read-only tasks.
 * A reviewer/researcher with a writer ancestor is NOT read-only here: it needs that writer's commits merged
 * into its own worktree. Cycle-safe (visited set); unknown dependency ids are ignored.
 */
export function isReadOnlyTask(task: TaskSpec, byId: Map<string, TaskSpec>): boolean {
  if (WRITER_ROLES.has(task.role)) return false;
  const seen = new Set<string>([task.id]);
  const stack = [...task.dependsOn];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = byId.get(id);
    if (!dep) continue;
    if (WRITER_ROLES.has(dep.role)) return false;
    stack.push(...dep.dependsOn);
  }
  return true;
}

/**
 * Whether a task runs in the shared worktree. Safety guard: concurrent tasks in ONE directory are only safe because
 * they cannot write, so a role whose tools include Edit/Write/Bash always gets its own worktree, whatever its name.
 */
export function usesSharedWorktree(task: TaskSpec, byId: Map<string, TaskSpec>, toolsFor: (role: TaskSpec["role"]) => string[]): boolean {
  return isReadOnlyTask(task, byId) && !toolsFor(task.role).some((t) => WRITE_TOOLS.has(t));
}
