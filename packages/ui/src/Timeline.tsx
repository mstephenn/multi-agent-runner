import { memo } from "react";
import type { AgentView, Lane } from "./derive.js";

type Props = {
  lanes: Lane[]; agents: AgentView[]; now: number; minTs: number; maxTs: number;
  cutoff: number | null; onCutoff: (ts: number | null) => void; onSelect: (id: string) => void;
};

export const Timeline = memo(function Timeline({ lanes, agents, now, minTs, maxTs, cutoff, onCutoff, onSelect }: Props) {
  const status = new Map(agents.map((a) => [a.id, a.status]));
  const t0 = lanes.length ? Math.min(...lanes.map((l) => l.start)) : minTs;
  const t1 = Math.max(t0 + 1, ...lanes.map((l) => l.end ?? now));
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - t0) / (t1 - t0)) * 100));
  return (
    <section className="timeline" aria-label="Timeline">
      <div className="scrub">
        <label htmlFor="scrubber">Replay</label>
        <input id="scrubber" type="range" min={minTs} max={Math.max(minTs, maxTs)} step={1} disabled={maxTs <= minTs}
          value={cutoff ?? Math.max(minTs, maxTs)} onChange={(e) => onCutoff(Number(e.target.value))} aria-valuetext={cutoff === null ? "Live" : new Date(cutoff).toLocaleTimeString()} />
        <button type="button" onClick={() => onCutoff(null)} aria-pressed={cutoff === null}>Live</button>
        <span className="muted">{cutoff === null ? "live" : `replay @ ${new Date(cutoff).toLocaleTimeString()}`}</span>
      </div>
      {lanes.length === 0 ? <p className="muted">No tasks have started.</p> : (
        <ul className="lanes">
          {lanes.map((l) => {
            const s = status.get(l.id) ?? "running";
            const left = pct(l.start), right = pct(l.end ?? now);
            return (
              <li key={l.id}>
                <button type="button" className="mono lane-label" onClick={() => onSelect(l.id)}>{l.id}</button>
                <svg className="lane-svg" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={`${l.id} ${s}`}>
                  <rect className={`bar status-${s}`} x={left} y={1} width={Math.max(0.8, right - left)} height={8} rx={1} />
                </svg>
                <span className="status-text" data-status={s}>{s}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
