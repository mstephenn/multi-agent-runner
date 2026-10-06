import type { Dag } from "@mar/core";
import type { FlowEdge } from "./derive.js";

export type Point = { x: number; y: number };
export type Bounds = Point & { width: number; height: number };
export type LayoutNode = { id: string; phase?: number; repo?: string };
export type LayoutEdge = { id: string; source: string; target: string };
export type LayoutOptions = {
  /** Enable repository swimlanes for workspace runs. Missing repos share the '*' lane. */
  swimlanes?: boolean;
  nodeWidth?: number;
  nodeHeight?: number;
  columnGap?: number;
  rowGap?: number;
  laneGap?: number;
  padding?: number;
  /** Minimum distance from a node border to an edge's first/last bend. */
  edgeOffset?: number;
};
export type GraphLayout = {
  positions: Map<string, Point>;
  columns: (Bounds & { phase: number; nodeIds: string[] })[];
  lanes: (Bounds & { repo: string; nodeIds: string[] })[];
  edges: (LayoutEdge & { waypoints: Point[] })[];
  /** Includes routing tracks, which may extend above and beside the columns. */
  bounds: Bounds;
};

/** Pure layout in top-left coordinates, with uniform node dimensions.
 * Columns represent observed phases (missing phase = 1), not dependency depth.
 * Input order breaks ordering ties. Unknown edge endpoints are omitted.
 */
export function layoutGraph(
  nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: LayoutOptions = {},
): GraphLayout {
  const size = (name: keyof LayoutOptions, fallback: number): number => {
    const value = options[name] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new RangeError(`${name} must be a positive finite number`);
    return value;
  };
  const w = size("nodeWidth", 210), h = size("nodeHeight", 100);
  const offset = size("edgeOffset", 16), padding = size("padding", 24);
  const gap = Math.max(size("columnGap", 70), 2 * offset);
  const rowGap = size("rowGap", 30), laneGap = size("laneGap", 32);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("Duplicate layout node id");
  for (const n of nodes) if (n.phase !== undefined && (!Number.isSafeInteger(n.phase) || n.phase < 1))
    throw new RangeError("phase must be a positive safe integer");
  const validEdges = edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  if (new Set(validEdges.map((e) => e.id)).size !== validEdges.length) throw new Error("Duplicate layout edge id");
  const phases = [...new Set(nodes.map((n) => n.phase ?? 1))].sort((a, b) => a - b);
  const repos = options.swimlanes ? [...new Set(nodes.map((n) => n.repo ?? "*"))].sort() : ["*"];
  const columnOf = new Map(nodes.map((n) => [n.id, phases.indexOf(n.phase ?? 1)]));
  const groups = phases.map((phase) => repos.map((repo) => nodes
    .filter((n) => (n.phase ?? 1) === phase && (!options.swimlanes || (n.repo ?? "*") === repo))
    .map((n) => n.id)));
  const neighbors = new Map(nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of validEdges) {
    neighbors.get(e.source)!.add(e.target);
    neighbors.get(e.target)!.add(e.source);
  }
  const ranks = () => new Map(groups.flatMap((column) => column.flat().map((id, row) => [id, row] as const)));
  // Adjacent-column inversions give an objective for retaining only improved sweeps.
  const crossingCount = () => {
    const rank = ranks();
    let count = 0;
    for (let c = 0; c < phases.length - 1; c++) {
      const pairs = validEdges.flatMap((e) => {
        const a = columnOf.get(e.source)!, b = columnOf.get(e.target)!;
        return a === c && b === c + 1 ? [[e.source, e.target]]
          : b === c && a === c + 1 ? [[e.target, e.source]] : [];
      });
      for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++)
        if ((rank.get(pairs[i][0])! - rank.get(pairs[j][0])!) *
            (rank.get(pairs[i][1])! - rank.get(pairs[j][1])!) < 0) count++;
    }
    return count;
  };
  let best = groups.map((c) => c.map((g) => [...g])), bestCount = crossingCount();
  for (let sweep = 0; sweep < 8; sweep++) {
    const forward = sweep % 2 === 0;
    for (let step = 0; step < groups.length; step++) {
      const c = forward ? step : groups.length - 1 - step;
      const rank = ranks();
      for (const group of groups[c]) {
        const score = new Map(group.map((id) => {
          const adjacent = [...neighbors.get(id)!].filter((n) => columnOf.get(n) === c + (forward ? -1 : 1));
          return [id, adjacent.length ? adjacent.reduce((sum, n) => sum + rank.get(n)!, 0) / adjacent.length : rank.get(id)!];
        }));
        group.sort((a, b) => score.get(a)! - score.get(b)!);
      }
    }
    const count = crossingCount();
    if (count < bestCount) { bestCount = count; best = groups.map((c) => c.map((g) => [...g])); }
  }
  const result: GraphLayout = { positions: new Map(), columns: [], lanes: [], edges: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
  if (!nodes.length) return result;
  const width = 2 * padding + phases.length * w + (phases.length - 1) * gap;
  let y = 0;
  for (let lane = 0; lane < repos.length; lane++) {
    const rows = Math.max(...best.map((c) => c[lane].length));
    const height = 2 * padding + rows * h + Math.max(0, rows - 1) * rowGap;
    const nodeIds: string[] = [];
    best.forEach((column, c) => column[lane].forEach((id, row) => {
      result.positions.set(id, { x: padding + c * (w + gap), y: y + padding + row * (h + rowGap) });
      nodeIds.push(id);
    }));
    if (options.swimlanes) result.lanes.push({ repo: repos[lane], x: 0, y, width, height, nodeIds });
    y += height + laneGap;
  }
  const height = y - laneGap;
  result.columns = phases.map((phase, c) => ({ phase, x: padding + c * (w + gap), y: 0,
    width: w, height, nodeIds: best[c].flat() }));
  let track = 0;
  result.edges = validEdges.map((edge) => {
    const source = result.positions.get(edge.source)!, target = result.positions.get(edge.target)!;
    const start = { x: source.x + w, y: source.y + h / 2 };
    const end = { x: target.x, y: target.y + h / 2 };
    let waypoints: Point[];
    if (columnOf.get(edge.target)! === columnOf.get(edge.source)! + 1) {
      const x = (start.x + end.x) / 2;
      waypoints = [start, { x, y: start.y }, { x, y: end.y }, end];
    } else {
      // Vertical legs occupy column gutters; horizontal legs stay above every node.
      const top = -offset * ++track;
      waypoints = [start, { x: start.x + offset, y: start.y }, { x: start.x + offset, y: top },
        { x: end.x - offset, y: top }, { x: end.x - offset, y: end.y }, end];
    }
    return { ...edge, waypoints };
  });
  const points = result.edges.flatMap((e) => e.waypoints);
  const minX = Math.min(0, ...points.map((p) => p.x)), minY = Math.min(0, ...points.map((p) => p.y));
  result.bounds = { x: minX, y: minY, width: Math.max(width, ...points.map((p) => p.x)) - minX,
    height: Math.max(height, ...points.map((p) => p.y)) - minY };
  return result;
}

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
