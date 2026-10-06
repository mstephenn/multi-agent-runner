import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import type { AgentView, GraphFilter } from "./derive.js";
import { fitViewport, type Bounds } from "./layout.js";
import { reducedMotion } from "./motion.js";
import { shortcutAction } from "./shortcuts.js";
import { useDismiss } from "./usePopover.js";

/** Fit never zooms below this: past it the graph is panned, not shrunk. */
export const FIT_MIN_ZOOM = 0.6;

/** One "fit to screen" for every path (first paint, pane resize, the Fit button, the F key). */
export function useFit(bounds: Bounds) {
  const { setViewport } = useReactFlow();
  const store = useStoreApi();
  const { x, y, width, height } = bounds;
  return useCallback((animate = true) => {
    const { width: w, height: h } = store.getState();
    if (!width || !w || !h) return;
    void setViewport(fitViewport({ x, y, width, height }, { width: w, height: h }, { minZoom: FIT_MIN_ZOOM, maxZoom: 1 }), { duration: animate && !reducedMotion() ? 300 : 0 });
  }, [setViewport, store, x, y, width, height]);
}

type Props = {
  agents: AgentView[]; filter: GraphFilter; onFilter: (filter: GraphFilter) => void;
  minimap: boolean; onMinimap: () => void; bounds: Bounds;
};

/** A single small "⋯" button; zoom, fit, minimap and the phase/repo filters live in its popover. */
export function GraphControls({ agents, filter, onFilter, minimap, onMinimap, bounds }: Props) {
  const { zoomIn, zoomOut } = useReactFlow();
  const fit = useFit(bounds);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root, trigger);
  const phases = [...new Set(agents.map((a) => a.phase ?? 1))].sort((a, b) => a - b);
  const repos = [...new Set(agents.flatMap((a) => a.repo === undefined ? [] : [a.repo]))].sort();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = shortcutAction(e);
      if (action === "fit") fit();
      else if (action === "minimap") onMinimap();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fit, onMinimap]);
  const filtered = !!filter.runningFailedOnly || filter.phase != null || filter.repo != null;
  return (
    <div className="graph-options" ref={root}>
      <button ref={trigger} type="button" className={`graph-options-toggle${filtered ? " active" : ""}`} aria-label="Graph options" title="Graph options: zoom, fit, minimap, filters" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>⋯{filtered && <span className="visually-hidden"> (filters active)</span>}</button>
      {open && <div id={id} role="group" className="popover graph-controls" aria-label="Graph controls">
        <div className="gc-row">
          <button type="button" aria-label="Zoom in" onClick={() => void zoomIn()}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => void zoomOut()}>−</button>
          <button type="button" disabled={!bounds.width} onClick={() => fit()}>Fit</button>
          <button type="button" aria-pressed={minimap} onClick={onMinimap}>Minimap</button>
        </div>
        <label><input type="checkbox" checked={!!filter.runningFailedOnly} onChange={(e) => onFilter({ ...filter, runningFailedOnly: e.target.checked })} /> Running / failed</label>
        <label>Phase <select aria-label="Phase" value={filter.phase ?? ""} onChange={(e) => onFilter({ ...filter, phase: e.target.value ? Number(e.target.value) : null })}>
          <option value="">All</option>{phases.map((phase) => <option key={phase} value={phase}>{phase}</option>)}
        </select></label>
        <label>Repo <select aria-label="Repo" value={filter.repo == null ? "" : JSON.stringify(filter.repo)} onChange={(e) => onFilter({ ...filter, repo: e.target.value ? JSON.parse(e.target.value) as string : null })}>
          <option value="">All</option>{repos.map((repo) => <option key={repo} value={JSON.stringify(repo)}>{repo === "*" ? "All workspace repos" : repo}</option>)}
        </select></label>
        <button type="button" onClick={() => onFilter({})}>Reset filters</button>
      </div>}
    </div>
  );
}
