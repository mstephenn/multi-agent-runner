import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Background, Handle, Position, ReactFlow, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Dag } from "@mar/core";
import { matchesGraphFilter, taskDuration, phaseBadge, planPhases, type GraphFilter, type AgentView, type FlowEdge } from "./derive.js";
import { fmtDuration, fmtTokens, STATUS_ICON } from "./fmt.js";
import { layoutGraph, type Bounds } from "./layout.js";
import { GraphEdge, type RoutedEdge } from "./GraphEdge.js";
import { GraphControls } from "./GraphControls.js";
import "./graph.css";
import { nodeIn, pulseRing, reducedMotion, statusFlash } from "./motion.js";

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
const nodeTypes = { agent: AgentNode };
const edgeTypes = { routed: GraphEdge };

// Re-centres the graph whenever its pane is resized (e.g. the inspector drawer opens or closes), so no node ends up hidden.
function RefitOnResize({ bounds }: { bounds: Bounds }) {
  const { fitBounds } = useReactFlow();
  const host = useRef<HTMLDivElement>(null);
  const { x, y, width, height } = bounds;
  useEffect(() => {
    const pane = host.current?.closest(".graph");
    if (!pane || !width || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { void fitBounds({ x, y, width, height }, { padding: 0.25, duration: reducedMotion() ? 0 : 300 }); }, 80);
    });
    ro.observe(pane);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, [fitBounds, x, y, width, height]);
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
    for (const t of plan?.tasks ?? []) for (const d of t.dependsOn) {
      const id = JSON.stringify(["dep", d, t.id]);
      if (known.has(d) && known.has(t.id)) links.set(id, { id, source: d, target: t.id });
    }
    for (const f of flow) {
      const id = JSON.stringify(["flow", f.from, f.to, f.key]);
      if (known.has(f.from) && known.has(f.to)) links.set(id, { id, source: f.from, target: f.to, label: f.key });
    }
    const layout = layoutGraph(visible, [...links.values()], {
      nodeWidth: 250, nodeHeight: 160, columnGap: 180, rowGap: 40, edgeOffset: 28,
      swimlanes: agents.some((a) => a.repo !== undefined),
    });
    return { layout, links };
  }, [visible, agents, plan, flow]);
  const nodes = useMemo<Node<NodeData>[]>(() => visible.map((agent) => ({
    id: agent.id, type: "agent", position: graph.layout.positions.get(agent.id)!,
    style: { width: 250, height: 160 },
    data: { agent, selected: agent.id === selected, phaseCount: planPhases(plan) },
  })), [visible, graph, selected, plan]);
  const edges = useMemo<RoutedEdge[]>(() => graph.layout.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, type: "routed",
    selected: edge.id === selectedEdge,
    animated: graph.links.get(edge.id)?.label !== undefined,
    ariaLabel: graph.links.get(edge.id)?.label ?? `Dependency from ${edge.source} to ${edge.target}`,
    className: graph.links.get(edge.id)?.label === undefined ? "dep" : "flow",
    data: { waypoints: edge.waypoints, label: graph.links.get(edge.id)?.label },
  })), [graph, selectedEdge]);

  if (agents.length === 0) return <div className="empty">No agents yet. Waiting for the planner.</div>;
  return (
    <div className="graph" aria-label="Task graph">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable edgesFocusable proOptions={{ hideAttribution: true }}
        onEdgeClick={(_e, edge) => setSelectedEdge(edge.id)} onPaneClick={() => setSelectedEdge(null)}
        onNodeClick={(_e, n) => onSelect(n.id)} minZoom={0.05}
      >
        <Background gap={20} />
        <RefitOnResize bounds={graph.layout.bounds} />
        <GraphControls agents={agents} filter={filter} onFilter={setFilter} minimap={minimap} onMinimap={() => setMinimap((value) => !value)} bounds={graph.layout.bounds} />
        {!visible.length && <div className="graph-no-matches" role="status">No tasks match these filters.</div>}
      </ReactFlow>
    </div>
  );
}
