import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Background, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Dag } from "@mar/core";
import { matchesGraphFilter, taskDuration, phaseBadge, planPhases, type GraphFilter, type AgentView, type FlowEdge } from "./derive.js";
import { fmtDuration, fmtTokens, STATUS_ICON } from "./fmt.js";
import { layoutGraph, type Bounds } from "./layout.js";
import { GraphEdge, type RoutedEdge } from "./GraphEdge.js";
import { GraphControls, useFit } from "./GraphControls.js";
import "./graph.css";
import { nodeIn, pulseRing, statusFlash } from "./motion.js";

// Cards keep a readable size: the fit never zooms out below 0.6 (see GraphControls), so the graph pans instead of shrinking.
export const NODE_W = 232, NODE_H = 132;
type NodeData = { agent: AgentView; selected: boolean; phaseCount: number };

const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<NodeData>>) {
  const a = data.agent;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (a.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [a.status, a.startedAt]);
  const root = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const prevStatus = useRef(a.status);
  useEffect(() => nodeIn(root.current), []); // first appearance only
  useEffect(() => {
    if (prevStatus.current === a.status) return;
    prevStatus.current = a.status;
    return statusFlash(root.current);
  }, [a.status]);
  useEffect(() => (a.status === "running" ? pulseRing(ring.current) : undefined), [a.status]);
  return (
    <div ref={root} className={`agent status-${a.status}${data.selected ? " selected" : ""}`} data-testid={`node-${a.id}`}>
      {a.status === "running" && <span ref={ring} className="pulse-ring" aria-hidden="true" />}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button type="button" className="agent-btn" aria-pressed={data.selected} aria-label={`Inspect ${a.id}, ${a.status}`}>
        <span className="agent-id mono">{a.id}</span>
        <span className="agent-meta">
          {a.runtime && <span className={`badge rt-${a.runtime}`}>{a.runtime}</span>}
          {a.tier && <span className="badge tier">{a.tier}</span>}
          {a.role && <span className="role">{a.role}</span>}
          {phaseBadge(a.phase, data.phaseCount) && <span className="badge phase-tag" data-testid={`phase-${a.id}`}>{phaseBadge(a.phase, data.phaseCount)}</span>}
        </span>
        {(a.repo || a.siblingWarnings?.length) && <span className="agent-repo">
          {a.repo && <span className="badge repo-badge" title={a.repo === "*" ? "All workspace repositories" : `Repository: ${a.repo}`}>{a.repo === "*" ? "All repos" : a.repo}</span>}
          {!!a.siblingWarnings?.length && <span className="sibling-indicator" title="Sibling repository modified; inspect task for details" aria-label="Sibling repository modified">⚠ sibling modified</span>}
        </span>}
        <span className="agent-duration mono">{a.status === "running" ? "Elapsed" : "Duration"}: {fmtDuration(taskDuration(a, now))}</span>
        <span className="agent-foot">
          <span className="status-text" data-status={a.status}><span aria-hidden="true">{STATUS_ICON[a.status]}</span> {a.status}</span>
          <span className="mono tok">{fmtTokens(a.tokens)} tok</span>
        </span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
// Passive background band: a phase column or a repository swimlane. Decorative, so hidden from assistive tech.
type BandData = { label: string; kind: "phase" | "repo" };
const BandNode = memo(function BandNode({ data }: NodeProps<Node<BandData>>) {
  return <div className={`band band-${data.kind}`} data-testid={`band-${data.kind}-${data.label}`} aria-hidden="true"><span>{data.kind === "phase" ? `Phase ${data.label}` : data.label === "*" ? "All repos" : data.label}</span></div>;
});
const nodeTypes = { agent: AgentNode, band: BandNode };
const edgeTypes = { routed: GraphEdge };

// Frames the graph on first paint and again whenever the graph changes or its pane is resized (e.g. the details panel opens), so no node is lost.
function FitController({ bounds }: { bounds: Bounds }) {
  const fit = useFit(bounds);
  const host = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => { fit(!first.current); first.current = false; }, [fit]);
  useEffect(() => {
    const pane = host.current?.closest(".graph");
    if (!pane || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => fit(), 80); });
    ro.observe(pane);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [fit]);
  return <div ref={host} hidden />;
}

type Props = { agents: AgentView[]; plan: Dag | null; flow: FlowEdge[]; selected: string | null; onSelect: (id: string) => void };

export function GraphView({ agents, plan, flow, selected, onSelect }: Props) {
  const [filter, setFilter] = useState<GraphFilter>({});
  const [minimap, setMinimap] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const visible = useMemo(() => agents.filter((a) => matchesGraphFilter(a, filter)), [agents, filter]);
  const graph = useMemo(() => {
    const known = new Set(visible.map((a) => a.id));
    const links = new Map<string, { id: string; source: string; target: string; label?: string }>();
    // A flow edge (a blackboard read) already implies the dependency: drawing both stacks two lines on one route.
    const flowPairs = new Set(flow.map((f) => JSON.stringify([f.from, f.to])));
    for (const t of plan?.tasks ?? []) for (const d of t.dependsOn) {
      const id = JSON.stringify(["dep", d, t.id]);
      if (known.has(d) && known.has(t.id) && !flowPairs.has(JSON.stringify([d, t.id]))) links.set(id, { id, source: d, target: t.id });
    }
    // One edge per task pair: its label lists every blackboard key passed along it (a line per key buries the graph).
    const keys = new Map<string, { from: string; to: string; keys: string[] }>();
    for (const f of flow) {
      if (!known.has(f.from) || !known.has(f.to)) continue;
      const pair = keys.get(JSON.stringify([f.from, f.to])) ?? { from: f.from, to: f.to, keys: [] };
      if (!pair.keys.includes(f.key)) pair.keys.push(f.key);
      keys.set(JSON.stringify([f.from, f.to]), pair);
    }
    for (const p of keys.values()) {
      const id = JSON.stringify(["flow", p.from, p.to]);
      links.set(id, { id, source: p.from, target: p.to, label: p.keys.join("\n") });
    }
    const layout = layoutGraph(visible, [...links.values()], {
      nodeWidth: NODE_W, nodeHeight: NODE_H, columnGap: 110, rowGap: 14, laneGap: 10, padding: 12, edgeOffset: 24, layers: true, labelSpace: 18,
      swimlanes: agents.some((a) => a.repo !== undefined),
    });
    return { layout, links };
  }, [visible, agents, plan, flow]);
  const bands = useMemo<Node<BandData>[]>(() => [
    ...(graph.layout.columns.length > 1 ? graph.layout.columns.map((c) => ({ id: `band-phase-${c.phase}`, label: String(c.phase), kind: "phase" as const, b: c })) : []),
    ...(graph.layout.lanes.length > 1 ? graph.layout.lanes.map((l) => ({ id: `band-repo-${l.repo}`, label: l.repo, kind: "repo" as const, b: l })) : []),
  ].map(({ id, label, kind, b }) => ({
    id, type: "band", position: { x: b.x, y: b.y }, data: { label, kind }, style: { width: b.width, height: b.height },
    draggable: false, selectable: false, focusable: false, zIndex: -1,
  })), [graph]);
  const nodes = useMemo<(Node<NodeData> | Node<BandData>)[]>(() => [...bands, ...visible.map((agent) => ({
    id: agent.id, type: "agent", position: graph.layout.positions.get(agent.id)!,
    style: { width: NODE_W, height: NODE_H },
    data: { agent, selected: agent.id === selected, phaseCount: planPhases(plan) },
  }))], [bands, visible, graph, selected, plan]);
  const edges = useMemo<RoutedEdge[]>(() => graph.layout.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, type: "routed", markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: graph.links.get(edge.id)?.label === undefined ? "#8b949e" : "#6e9bff" },
    selected: edge.id === selectedEdge,
    animated: graph.links.get(edge.id)?.label !== undefined,
    ariaLabel: graph.links.get(edge.id)?.label ?? `Dependency from ${edge.source} to ${edge.target}`,
    // Long edges (routed over the top of the graph) fade out unless they touch the selected task or edge, so one line never reads as spanning phases.
    className: [graph.links.get(edge.id)?.label === undefined ? "dep" : "flow", edge.waypoints.length > 4 ? (selected !== null && (edge.source === selected || edge.target === selected) ? "long hot" : "long") : ""].join(" ").trim(),
    data: { waypoints: edge.waypoints, label: graph.links.get(edge.id)?.label },
  })), [graph, selectedEdge, selected]);

  if (agents.length === 0) return <div className="empty" role="status"><span className="spinner" aria-hidden="true" /><span>No agents yet. Waiting for the planner.</span></div>;
  return (
    <ReactFlowProvider>
    <div className="graph" aria-label="Task graph">
      <GraphControls agents={agents} filter={filter} onFilter={setFilter} minimap={minimap} onMinimap={() => setMinimap((value) => !value)} bounds={graph.layout.bounds} />
      <div className="graph-canvas">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} panOnScroll zoomOnScroll={false}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable edgesFocusable proOptions={{ hideAttribution: true }}
        onEdgeClick={(_e, edge) => setSelectedEdge(edge.id)} onPaneClick={() => setSelectedEdge(null)}
        onNodeClick={(_e, n) => onSelect(n.id)} minZoom={0.05}
      >
        <Background gap={20} />
        <FitController bounds={graph.layout.bounds} />
        {minimap && <MiniMap pannable zoomable ariaLabel="Task graph minimap" nodeColor={(node) => {
          if (node.type === "band") return "transparent";
          const status = (node.data.agent as AgentView | undefined)?.status;
          return status === "failed" ? "var(--err)" : status === "running" ? "var(--accent)" : "var(--muted)";
        }} />}
        {!visible.length && <div className="graph-no-matches" role="status">No tasks match these filters.</div>}
      </ReactFlow>
      </div>
    </div>
    </ReactFlowProvider>
  );
}
