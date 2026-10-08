import { describe, expect, it } from "vitest";
import { fitViewport, layoutGraph, positions, depths, type Bounds, type LayoutEdge, type Point } from "../src/layout.js";

const edge = (source: string, target: string): LayoutEdge => ({ id: `${source}>${target}`, source, target });
const inside = (p: Point, b: Bounds) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

describe("layoutGraph", () => {
  it("returns an empty layout for no nodes and ignores dangling edges", () => {
    expect(layoutGraph([], [edge("missing", "other")])).toEqual({
      positions: new Map(), columns: [], lanes: [], edges: [], bounds: { x: 0, y: 0, width: 0, height: 0 },
    });
    expect(layoutGraph([{ id: "a" }], [edge("a", "missing")]).edges).toEqual([]);
  });

  it("uses numerically ordered observed phases, defaulting unphased tasks to phase 1", () => {
    const nodes = [{ id: "last", phase: 10 }, { id: "a" }, { id: "b", phase: 1 }, { id: "middle", phase: 3 }];
    const result = layoutGraph(nodes, [edge("a", "b")]);
    expect(result.columns.map((c) => c.phase)).toEqual([1, 3, 10]);
    expect(result.positions.get("a")!.x).toBe(result.positions.get("b")!.x);
    expect(result.positions.get("a")!.y).not.toBe(result.positions.get("b")!.y);
    for (const column of result.columns) for (const id of column.nodeIds) {
      const p = result.positions.get(id)!;
      expect(inside(p, column)).toBe(true);
      expect(inside({ x: p.x + 210, y: p.y + 100 }, column)).toBe(true);
    }
    expect(result.lanes).toEqual([]);
  });

  it("removes a crossing with stable, deterministic ordering without mutating inputs", () => {
    const nodes = Object.freeze([
      { id: "a", phase: 1 }, { id: "b", phase: 1 }, { id: "c", phase: 2 }, { id: "d", phase: 2 },
    ].map((value) => Object.freeze(value)));
    const edges = Object.freeze([edge("a", "d"), edge("b", "c")].map((value) => Object.freeze(value)));
    const result = layoutGraph(nodes, edges);
    const y = (id: string) => result.positions.get(id)!.y;
    expect((y("a") - y("b")) * (y("d") - y("c"))).toBeGreaterThan(0);
    expect(layoutGraph(nodes, edges)).toEqual(result);
    expect(layoutGraph(nodes, []).columns.map((c) => c.nodeIds)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("creates disjoint repo lanes spanning all columns only when requested", () => {
    const nodes = [
      { id: "web", repo: "web" }, { id: "api", repo: "api" }, { id: "api2", repo: "api" },
      { id: "review", phase: 2 }, { id: "all", repo: "*", phase: 2 }, { id: "web2", repo: "web", phase: 2 },
    ];
    expect(layoutGraph(nodes, []).lanes).toEqual([]);
    const result = layoutGraph(nodes, [edge("web", "api"), edge("api", "web2")], { swimlanes: true });
    expect(result.lanes.map((l) => l.repo)).toEqual(["*", "api", "web"]);
    expect(result.lanes[0].nodeIds).toEqual(["review", "all"]);
    result.lanes.forEach((lane, i) => {
      if (i) expect(lane.y).toBeGreaterThan(result.lanes[i - 1].y + result.lanes[i - 1].height);
      for (const id of lane.nodeIds) {
        const p = result.positions.get(id)!;
        expect(inside(p, lane)).toBe(true);
        expect(inside({ x: p.x + 210, y: p.y + 100 }, lane)).toBe(true);
      }
    });
  });

  it("routes adjacent, skipped, backward, same-phase, cross-repo and self edges clear of nodes", () => {
    const nodes = [
      { id: "a", repo: "api" }, { id: "b", repo: "web" },
      { id: "c", repo: "api", phase: 2 }, { id: "d", repo: "web", phase: 2 },
      { id: "e", repo: "api", phase: 3 },
    ];
    const edges = [edge("a", "d"), edge("a", "e"), edge("e", "b"), edge("a", "b"), edge("c", "c")];
    const w = 80, h = 40, offset = 25;
    const result = layoutGraph(nodes, edges, {
      swimlanes: true, nodeWidth: w, nodeHeight: h, edgeOffset: offset, columnGap: 10, padding: 10,
    });
    expect(result.edges).toHaveLength(edges.length);
    for (const route of result.edges) {
      const p = route.waypoints, source = result.positions.get(route.source)!, target = result.positions.get(route.target)!;
      expect(p[0]).toEqual({ x: source.x + w, y: source.y + h / 2 });
      expect(p.at(-1)).toEqual({ x: target.x, y: target.y + h / 2 });
      expect(p[1].x - p[0].x).toBeGreaterThanOrEqual(offset);
      expect(p.at(-1)!.x - p.at(-2)!.x).toBeGreaterThanOrEqual(offset);
      for (const point of p) expect(inside(point, result.bounds)).toBe(true);
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const box of result.positions.values()) {
          const hits = a.x === b.x
            ? a.x > box.x && a.x < box.x + w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + h
            : a.y > box.y && a.y < box.y + h && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + w;
          expect(hits).toBe(false);
        }
      }
    }
  });

  it("rejects ambiguous identities and invalid geometry", () => {
    expect(() => layoutGraph([{ id: "a" }, { id: "a" }], [])).toThrow(/Duplicate/);
    expect(() => layoutGraph([{ id: "a" }], [edge("a", "a"), edge("a", "a")])).toThrow(/Duplicate/);
    for (const phase of [0, -1, 1.5, Infinity, NaN])
      expect(() => layoutGraph([{ id: "a", phase }], [])).toThrow(/phase/);
    for (const nodeWidth of [0, -1, Infinity, NaN])
      expect(() => layoutGraph([{ id: "a" }], [], { nodeWidth })).toThrow(/nodeWidth/);
  });
});

it("preserves the existing dependency-depth and position helpers", () => {
  const ids = ["a", "b"];
  const d = depths(ids, null, [{ from: "a", to: "b", key: "k", version: 1, tokens: 0 }]);
  expect(positions(ids, d)).toEqual(new Map([["a", { x: 0, y: 0 }], ["b", { x: 280, y: 0 }]]));
});

describe("layoutGraph with dependency layers", () => {
  const nodes = [{ id: "a", phase: 1 }, { id: "b", phase: 1 }, { id: "c", phase: 1 }, { id: "d", phase: 2 }];
  const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("c", "d")];
  const opts = { layers: true, nodeWidth: 100, nodeHeight: 40, columnGap: 40, padding: 10, edgeOffset: 10 };
  it("puts a task right of its same-phase dependencies and lets a phase band span its layers", () => {
    const r = layoutGraph(nodes, edges, opts);
    const x = (id: string) => r.positions.get(id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
    expect(x("c")).toBeLessThan(x("d"));
    const [p1, p2] = r.columns;
    expect(p1!.phase).toBe(1);
    expect(p1!.width).toBe(3 * 100 + 2 * 40);
    expect(p1!.nodeIds.sort()).toEqual(["a", "b", "c"]);
    expect(p2!.x).toBeGreaterThanOrEqual(p1!.x + p1!.width);
    // a same-phase chain no longer loops over the top: only the skipped a>c edge needs a track above the nodes
    expect(r.edges.filter((e) => e.waypoints.some((p) => p.y < 0)).map((e) => e.id)).toEqual(["a>c"]);
  });
  it("is the default-off: without `layers` a phase stays one column", () => {
    const r = layoutGraph(nodes, edges, { ...opts, layers: false });
    expect(r.positions.get("a")!.x).toBe(r.positions.get("c")!.x);
  });
  it("survives a dependency cycle without hanging", () => {
    const r = layoutGraph([{ id: "x" }, { id: "y" }], [edge("x", "y"), edge("y", "x")], { layers: true });
    expect(r.positions.size).toBe(2);
  });
});

describe("swimlanes only for repos that have tasks", () => {
  it("never creates a lane for an unused repo and keeps lane padding small", () => {
    const nodes = [{ id: "a", repo: "r101-webservices" }, { id: "b", repo: "r101-frontend" }, { id: "c" }];
    const r = layoutGraph(nodes, [], { swimlanes: true, nodeHeight: 100, padding: 12, laneGap: 10 });
    expect(r.lanes.map((l) => l.repo)).toEqual(["*", "r101-frontend", "r101-webservices"]);
    for (const lane of r.lanes) expect(lane.height).toBe(100 + 2 * 12);
    expect(r.bounds.height).toBe(3 * 124 + 2 * 10);
  });
});

describe("fitViewport", () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 500 };
  it("centres a graph that fits and never zooms in past maxZoom", () => {
    const v = fitViewport(bounds, { width: 2000, height: 1000 });
    expect(v.zoom).toBe(1);
    expect(v.x).toBe(500);
    expect(v.y).toBe(250);
    expect(fitViewport(bounds, { width: 1032, height: 532 }).zoom).toBe(1);
    expect(fitViewport(bounds, { width: 800, height: 600 }).zoom).toBeCloseTo((800 - 32) / 1000);
  });
  it("never shrinks nodes below 0.6: a bigger graph is anchored top-left and panned instead", () => {
    const v = fitViewport({ x: -20, y: -50, width: 3000, height: 1500 }, { width: 1000, height: 600 });
    expect(v.zoom).toBe(0.6);
    expect(v).toEqual({ x: 16 + 20 * 0.6, y: 16 + 50 * 0.6, zoom: 0.6 });
    expect(fitViewport(bounds, { width: 500, height: 300 }, { minZoom: 0.3 }).zoom).toBeCloseTo(0.468, 3);
  });
  it("is total for empty bounds or a zero-size pane", () => {
    expect(fitViewport({ x: 0, y: 0, width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(fitViewport(bounds, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("labelSpace", () => {
  it("reserves room above the first lane and below every swimlane without changing the default layout", () => {
    const nodes = [{ id: "a", repo: "x" }, { id: "b", repo: "y" }];
    const base = layoutGraph(nodes, [], { swimlanes: true, nodeHeight: 100, padding: 10 });
    const spaced = layoutGraph(nodes, [], { swimlanes: true, nodeHeight: 100, padding: 10, labelSpace: 20 });
    expect(spaced.positions.get("a")!.y).toBe(base.positions.get("a")!.y + 20);
    expect(spaced.lanes[0]!.height).toBe(base.lanes[0]!.height + 40);
    expect(spaced.lanes[1]!.height).toBe(base.lanes[1]!.height + 20);
    expect(() => layoutGraph(nodes, [], { labelSpace: -1 })).toThrow(/labelSpace/);
  });
});

describe("long edge tracks", () => {
  it("every long edge gets its own track", () => {
    const nodes = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, phase: i + 1 }));
    const r = layoutGraph(nodes, [edge("a", "c"), edge("d", "f"), edge("a", "f")], { nodeWidth: 100, nodeHeight: 40, columnGap: 40, padding: 10, edgeOffset: 10 });
    expect(new Set(r.edges.map((e) => e.waypoints[2]!.y)).size).toBe(3);
  });
});
