import type { Dag } from "@mar/core";
import type { FlowEdge } from "./derive.js";

// Layered depth = longest dependency chain. Plan edges win; before the plan loads, flow edges stand in.
export function depths(ids: string[], plan: Dag | null, flow: FlowEdge[]): Map<string, number> {
  const deps = new Map<string, Set<string>>(ids.map((i) => [i, new Set<string>()]));
  for (const t of plan?.tasks ?? []) for (const d of t.dependsOn) deps.get(t.id)?.add(d);
  if (!plan) for (const f of flow) deps.get(f.to)?.add(f.from);
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (stack.has(id)) return 0; // defensive: cycles are rejected upstream
    stack.add(id);
    let d = 0;
    for (const p of deps.get(id) ?? []) if (deps.has(p)) d = Math.max(d, visit(p, stack) + 1);
    stack.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const id of ids) visit(id, new Set());
  return memo;
}

export function positions(ids: string[], d: Map<string, number>): Map<string, { x: number; y: number }> {
  const rows = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const depth = d.get(id) ?? 0;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    out.set(id, { x: depth * 280, y: row * 130 });
  }
  return out;
}
