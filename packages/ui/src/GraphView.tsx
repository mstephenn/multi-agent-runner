import { memo, useMemo } from "react";
import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Dag } from "@mar/core";
import type { AgentView, FlowEdge } from "./derive.js";
import { fmtTokens, STATUS_ICON } from "./fmt.js";
import { depths, positions } from "./layout.js";

type NodeData = { agent: AgentView; selected: boolean };

const AgentNode = memo(function AgentNode({ data }: NodeProps<Node<NodeData>>) {
  const a = data.agent;
  return (
    <div className={`agent status-${a.status}${data.selected ? " selected" : ""}`} data-testid={`node-${a.id}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button type="button" className="agent-btn" aria-pressed={data.selected} aria-label={`Inspect ${a.id}, ${a.status}`}>
        <span className="agent-id mono">{a.id}</span>
        <span className="agent-meta">
          {a.runtime && <span className={`badge rt-${a.runtime}`}>{a.runtime}</span>}
          {a.tier && <span className="badge tier">{a.tier}</span>}
          {a.role && <span className="role">{a.role}</span>}
        </span>
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

type Props = { agents: AgentView[]; plan: Dag | null; flow: FlowEdge[]; selected: string | null; onSelect: (id: string) => void };

export function GraphView({ agents, plan, flow, selected, onSelect }: Props) {
  const nodes = useMemo<Node<NodeData>[]>(() => {
    const ids = agents.map((a) => a.id);
    const pos = positions(ids, depths(ids, plan, flow));
    return agents.map((agent) => ({
      id: agent.id, type: "agent", position: pos.get(agent.id) ?? { x: 0, y: 0 },
      data: { agent, selected: agent.id === selected },
    }));
  }, [agents, plan, flow, selected]);

  const edges = useMemo<Edge[]>(() => {
    const known = new Set(agents.map((a) => a.id));
    const out: Edge[] = [];
    for (const t of plan?.tasks ?? [])
      for (const d of t.dependsOn)
        if (known.has(d) && known.has(t.id)) out.push({ id: `dep:${d}>${t.id}`, source: d, target: t.id, className: "dep" });
    const seen = new Set<string>();
    for (const f of flow) {
      const id = `flow:${f.from}>${f.to}:${f.key}`;
      if (seen.has(id) || !known.has(f.from) || !known.has(f.to)) continue;
      seen.add(id);
      out.push({ id, source: f.from, target: f.to, animated: true, label: f.key, className: "flow", labelBgPadding: [6, 3], labelBgBorderRadius: 4 });
    }
    return out;
  }, [agents, plan, flow]);

  if (agents.length === 0) return <div className="empty">No agents yet. Waiting for the planner.</div>;
  return (
    <div className="graph" aria-label="Task graph">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, n) => onSelect(n.id)} minZoom={0.3}
      >
        <Background gap={20} />
      </ReactFlow>
    </div>
  );
}
