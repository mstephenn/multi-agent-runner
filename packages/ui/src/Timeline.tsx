import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { StoredEvent } from "@mar/core";
import { deriveLanes, type AgentView } from "./derive.js";
import { STATUS_ICON } from "./fmt.js";
import { shimmer } from "./motion.js";
import { fmtOffset, groupLaneMarkers, groupLaneSegments, niceTicks, openStatusOf, segmentTip, tsOf, xOf, type LaneSegment } from "./timescale.js";

type Props = {
  events: StoredEvent[]; allEvents: StoredEvent[]; agents: AgentView[]; now: number; liveEnd: number;
  cutoff: number | null; onCutoff: (ts: number | null) => void; onSelect: (id: string) => void;
};

const SPEEDS = [1, 2, 4, 8];
// Replay advances `speed x (span / REPLAY_SECONDS)` per second, so a long run replays in about 20s at 1x.
const REPLAY_SECONDS = 20;
const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
const GLYPH = { write: "◆", read: "◇" } as const;

function Shimmer() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => shimmer(ref.current), []);
  return <span ref={ref} className="shimmer" aria-hidden="true" />;
}

type Tip = { key: string; text: string; x: number; y: number };

export const Timeline = memo(function Timeline({ events, allEvents, agents, now, liveEnd, cutoff, onCutoff, onSelect }: Props) {
  const status = useMemo(() => new Map(agents.map((a) => [a.id, a.status])), [agents]);
  const runtime = useMemo(() => new Map(agents.map((a) => [a.id, a.runtime])), [agents]);
  const segs = useMemo(() => groupLaneSegments(events, Infinity, openStatusOf(status)), [events, status]);
  const markers = useMemo(() => groupLaneMarkers(events), [events]);

  // One x-scale for the axis, the lanes, the playhead and the scrubber: the whole run, never the replayed slice.
  const full = useMemo(() => deriveLanes(allEvents), [allEvents]);
  const t0 = full.length ? Math.min(...full.map((l) => l.start)) : 0;
  const maxTs = allEvents.reduce((m, e) => (typeof e.ts === "number" && e.ts > m ? e.ts : m), t0);
  const t1 = Math.max(t0 + 1, liveEnd, maxTs);
  const canReplay = full.length > 0 && maxTs > t0;

  const axisRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = axisRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [full.length > 0]);
  const { ticks } = useMemo(() => niceTicks(t1 - t0, Math.max(2, Math.min(8, Math.floor(width / 84)))), [t0, t1, width]);

  // Replay: auto-advance the cutoff; reaching the end returns to live.
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const latest = useRef({ t0, maxTs, speed, cutoff, onCutoff });
  latest.current = { t0, maxTs, speed, cutoff, onCutoff };
  useEffect(() => { if (cutoff === null) setPlaying(false); }, [cutoff]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let pos = latest.current.cutoff ?? latest.current.t0;
    const timer = window.setInterval(() => {
      const n = performance.now(), L = latest.current;
      pos += ((n - last) / 1000) * L.speed * (Math.max(1, L.maxTs - L.t0) / REPLAY_SECONDS);
      last = n;
      if (pos >= L.maxTs) { setPlaying(false); L.onCutoff(null); return; }
      L.onCutoff(Math.round(pos));
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing]);
  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    if (cutoff === null) onCutoff(t0); // from live, start at the beginning
    setPlaying(true);
  };
  const setCut = (ts: number) => { setPlaying(false); onCutoff(ts >= maxTs ? null : ts); };

  const scrubAt = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setCut(tsOf((e.clientX - r.left) / r.width, t0, t1));
  };
  const trackPointer = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => { if (e.button !== 0 || !canReplay) return; e.currentTarget.setPointerCapture(e.pointerId); scrubAt(e); },
    onPointerMove: (e: PointerEvent<HTMLElement>) => { if (canReplay && e.buttons & 1 && e.currentTarget.hasPointerCapture(e.pointerId)) scrubAt(e); },
    onPointerUp: (e: PointerEvent<HTMLElement>) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); },
  };
  const onSliderKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const span = t1 - t0, step = Math.max(1, Math.round(span / 100));
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : e.key === "PageUp" ? step * 10 : e.key === "PageDown" ? -step * 10 : 0;
    if (!d) return;
    e.preventDefault();
    setCut(Math.max(t0, Math.min(maxTs, (cutoff ?? maxTs) + d)));
  };

  const [tip, setTip] = useState<Tip | null>(null);
  const showTip = (key: string, text: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ key, text, x: Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150), y: r.top });
  };
  const hideTip = (key: string) => setTip((t) => (t?.key === key ? null : t));

  const headTs = cutoff ?? t1;
  const headFrac = xOf(headTs, t0, t1);
  // Lanes come from the whole run so the panel does not jump while replaying; a task that has not started yet shows an empty track.
  const rows = useMemo(() => [...new Set(full.map((l) => l.id))].map((id) => [id, segs.get(id) ?? []] as const), [full, segs]);
  const gridRows = rows.length + 1;

  return (
    <div className="timeline" aria-label="Timeline">
      {rows.length === 0 ? <p className="muted tl-empty">No tasks have started.</p> : (
        <div className="tl-grid" onKeyDown={(e) => { if (e.key === "Escape") setTip(null); }}>
          <div className="tl-controls">
            <button type="button" className="tl-play" onClick={togglePlay} disabled={!canReplay}><span aria-hidden="true">{playing ? "❚❚" : "▶"}</span> {playing ? "Pause" : "Play"}</button>
            <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
            <button type="button" onClick={() => { setPlaying(false); onCutoff(null); }} disabled={cutoff === null}>Live</button>
          </div>
          <div className="tl-scrub">
            <label htmlFor="scrubber" className="visually-hidden">Replay</label>
            <input id="scrubber" type="range" min={t0} max={t1} step={1} disabled={!canReplay} value={headTs} onKeyDown={onSliderKey}
              onChange={(e) => setCut(Number(e.target.value))} aria-valuetext={cutoff === null ? "Live" : `+${fmtOffset(cutoff - t0)}`} />
          </div>
          <div className="tl-state">
            {cutoff === null ? <span className="live-pill">live</span> : <span className="replay-pill">replay</span>}
          </div>
          <div ref={axisRef} className="tl-axis" data-testid="axis" {...trackPointer}>
            {ticks.map((t) => <span key={`m${t}`} className="tick-mark" style={{ left: pct(xOf(t0 + t, t0, t1)) }} />)}
            {ticks.map((t) => {
              const f = xOf(t0 + t, t0, t1);
              return <span key={t} className={`tick${f === 0 ? " first" : f > 0.96 ? " last" : ""}`} style={{ left: pct(f) }} data-testid="tick">{fmtOffset(t)}</span>;
            })}
            <span className="ph-stem" style={{ left: pct(headFrac) }} />
            <span className={`ph-label${headFrac < 0.08 ? " left" : headFrac > 0.92 ? " right" : ""}${cutoff === null ? " live" : ""}`} style={{ left: pct(headFrac) }} data-testid="playhead-label">+{fmtOffset(headTs - t0)}</span>
          </div>

          <div className="tl-overlay tl-gridlines" style={{ gridRow: `2 / span ${gridRows}` }} aria-hidden="true">
            {ticks.map((t) => <span key={t} className="gridline" style={{ left: pct(xOf(t0 + t, t0, t1)) }} />)}
          </div>
          <ul className="tl-lanes" role="list" aria-label="Agent lanes">
            {rows.map(([id, list], i) => {
              const s = status.get(id) ?? (list.length ? "running" : "pending");
              const rt = runtime.get(id);
              const mk = markers.get(id) ?? [];
              return (
                <li key={id} role="listitem" className="lane">
                  <div className="lane-head" style={{ gridRow: i + 3 }}>
                    <button type="button" className="mono lane-label" onClick={() => onSelect(id)} title={`Open ${id} in the inspector`}><span className="lane-id">{id}</span></button>
                    <span className="lane-meta">
                      {rt && <span className={`badge rt-${rt}`}>{rt}</span>}
                      <span className="lane-status" data-status={s}><span aria-hidden="true">{STATUS_ICON[s] ?? "○"}</span> {s}</span>
                    </span>
                  </div>
                  <div className="lane-track" style={{ gridRow: i + 3 }} {...trackPointer}>
                    {list.map((seg: LaneSegment) => {
                      const k = `${id}#${seg.attempt}`;
                      const text = segmentTip(id, seg, list.length, t0, now, mk);
                      const end = seg.end ?? Math.min(Math.max(now, seg.start), t1);
                      const left = xOf(seg.start, t0, t1), w = xOf(end, t0, t1) - left;
                      return (
                        <div key={k} className={`seg seg-${seg.status}`} style={{ left: pct(left), width: `max(5px, calc(${pct(w)} - 1px))` }} tabIndex={0} role="button"
                          aria-label={`${id}, ${seg.status}${list.length > 1 ? `, attempt ${seg.attempt}` : ""}`} aria-describedby={tip?.key === k ? "tl-tip" : undefined}
                          onPointerEnter={(e) => showTip(k, text, e.currentTarget)} onPointerLeave={() => hideTip(k)}
                          onFocus={(e) => showTip(k, text, e.currentTarget)} onBlur={() => hideTip(k)}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSelect(id); } }}>
                          {seg.status === "running" && <Shimmer />}
                        </div>
                      );
                    })}
                    {mk.map((m, i) => {
                      const f = xOf(m.ts, t0, t1);
                      return <span key={i} className={`mk mk-${m.kind}`} style={{ left: pct(f) }} aria-hidden="true">{m.kind === "write" || m.kind === "read" ? GLYPH[m.kind] : ""}</span>;
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="tl-overlay tl-playhead" style={{ gridRow: `2 / span ${gridRows}` }} aria-hidden="true">
            <span className={`playhead${cutoff === null ? " live" : ""}`} style={{ left: pct(headFrac) }} data-testid="playhead" />
          </div>
        </div>
      )}
      {tip && <div id="tl-tip" role="tooltip" className="tl-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
});
