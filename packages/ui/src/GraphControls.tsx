import { useEffect } from "react";
import { MiniMap, Panel, useReactFlow } from "@xyflow/react";
import type { AgentView, GraphFilter } from "./derive.js";
import type { Bounds } from "./layout.js";
import { reducedMotion } from "./motion.js";
import { shortcutAction } from "./shortcuts.js";

type Props = {
  agents: AgentView[]; filter: GraphFilter; onFilter: (filter: GraphFilter) => void;
  minimap: boolean; onMinimap: () => void; bounds: Bounds;
};

export function GraphControls({ agents, filter, onFilter, minimap, onMinimap, bounds }: Props) {
  const { zoomIn, zoomOut, fitBounds } = useReactFlow();
  const phases = [...new Set(agents.map((a) => a.phase ?? 1))].sort((a, b) => a - b);
  const repos = [...new Set(agents.flatMap((a) => a.repo === undefined ? [] : [a.repo]))].sort();
  const fit = () => void fitBounds(bounds, { padding: 0.25, duration: reducedMotion() ? 0 : 300 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = shortcutAction(e);
      if (action === "fit" && bounds.width) fitBounds(bounds, { padding: 0.25, duration: reducedMotion() ? 0 : 300 });
      else if (action === "minimap") onMinimap();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bounds, fitBounds, onMinimap]);
  return <>
    <Panel position="top-left" className="graph-controls nodrag nopan" aria-label="Graph controls">
      <button type="button" aria-label="Zoom in" onClick={() => void zoomIn()}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => void zoomOut()}>−</button>
      <button type="button" disabled={!bounds.width} onClick={fit}>Fit</button>
      <button type="button" aria-pressed={minimap} onClick={onMinimap}>Minimap</button>
      <label><input type="checkbox" checked={!!filter.runningFailedOnly} onChange={(e) => onFilter({ ...filter, runningFailedOnly: e.target.checked })} /> Running / failed</label>
      <label>Phase <select value={filter.phase ?? ""} onChange={(e) => onFilter({ ...filter, phase: e.target.value ? Number(e.target.value) : null })}>
        <option value="">All</option>{phases.map((phase) => <option key={phase} value={phase}>{phase}</option>)}
      </select></label>
      <label>Repo <select value={filter.repo == null ? "" : JSON.stringify(filter.repo)} onChange={(e) => onFilter({ ...filter, repo: e.target.value ? JSON.parse(e.target.value) as string : null })}>
        <option value="">All</option>{repos.map((repo) => <option key={repo} value={JSON.stringify(repo)}>{repo === "*" ? "All workspace repos" : repo}</option>)}
      </select></label>
      <button type="button" onClick={() => onFilter({})}>Reset filters</button>
    </Panel>
    {minimap && <MiniMap pannable zoomable ariaLabel="Task graph minimap" nodeColor={(node) => {
      const status = (node.data.agent as AgentView | undefined)?.status;
      return status === "failed" ? "var(--fail, #d55)" : status === "running" ? "var(--accent)" : "var(--muted)";
    }} />}
  </>;
}
