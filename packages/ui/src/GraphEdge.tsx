import { memo } from "react";
import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import type { Point } from "./layout.js";

export type GraphEdgeData = { waypoints: Point[]; label?: string };
export type RoutedEdge = Edge<GraphEdgeData, "routed">;

/** Labels sit in the column gutter, or above the graph for long/backward routes. */
export const GraphEdge = memo(function GraphEdge({ id, data, selected, markerEnd, style }: EdgeProps<RoutedEdge>) {
  const points = data?.waypoints;
  if (!points?.length) return null;
  const path = points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const a = points[points.length === 4 ? 1 : 2];
  const b = points[points.length === 4 ? 2 : 3];
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
  return <g className={`graph-edge${selected ? " is-selected" : ""}`}>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={24} />
    {data?.label !== undefined && <>
      <circle className="graph-edge-marker" cx={x} cy={y} r={4} />
      <foreignObject className="graph-edge-label" x={x - 70} y={y - 22} width={140} height={44}>
        <div title={data.label}>{data.label}</div>
      </foreignObject>
    </>}
  </g>;
});
