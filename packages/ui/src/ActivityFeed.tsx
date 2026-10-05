import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StoredEvent } from "@mar/core";
import { deriveSteps, relTime, taskStart, type Step, type ToolStep } from "./activity.js";
import type { AgentStatus } from "./derive.js";
import { rowsIn } from "./motion.js";

const MAX_STEPS = 500;
const FOLLOW_SLACK = 24; // px from the bottom that still counts as "at the bottom"
const FILTERS = ["All", "Messages", "Tools", "Errors"] as const;
type Filter = (typeof FILTERS)[number];

const family = (name: string): "read" | "write" | "shell" | "other" =>
  /^(Read|Grep|Glob|LS|WebFetch|WebSearch|NotebookRead)$/.test(name) ? "read"
  : /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|file_change)$/.test(name) ? "write"
  : /^(Bash|bash|shell|command_execution)$/.test(name) ? "shell" : "other";

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const pretty = (v: unknown): string => {
  if (v === undefined) return "(none)";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return "[Unserializable]"; }
};

type Props = { id: string; events: StoredEvent[]; status: AgentStatus };

export function ActivityFeed({ id, events, status }: Props) {
  const all = useMemo(() => deriveSteps(events, id), [events, id]);
  const start = useMemo(() => taskStart(events, id), [events, id]);
  const [filter, setFilter] = useState<Filter>("All");
  const counts = useMemo(() => {
    let say = 0, tool = 0, err = 0;
    for (const s of all) { if (s.kind === "say") say++; else { tool++; if (s.isError) err++; } }
    return { All: all.length, Messages: say, Tools: tool, Errors: err };
  }, [all]);
  const matching = useMemo(
    () => all.filter((s) => filter === "All" || (filter === "Messages" ? s.kind === "say" : filter === "Tools" ? s.kind === "tool" : s.kind === "tool" && s.isError)),
    [all, filter],
  );
  const items = matching.length > MAX_STEPS ? matching.slice(-MAX_STEPS) : matching;

  const list = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const seenLen = useRef(0);            // steps the user has been "caught up" with
  const seenIds = useRef<Set<number> | null>(null); // rows already on screen; only rows appended later animate
  const [away, setAway] = useState(false);
  const [behind, setBehind] = useState(0);

  const toBottom = useCallback(() => {
    const el = list.current; if (!el) return;
    el.scrollTop = el.scrollHeight;
    following.current = true; seenLen.current = items.length; setAway(false); setBehind(0);
  }, [items.length]);

  const onScroll = () => {
    const el = list.current; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    following.current = atBottom;
    if (atBottom) seenLen.current = items.length;
    setAway(!atBottom);
    setBehind(atBottom ? 0 : Math.max(0, items.length - seenLen.current));
  };

  useLayoutEffect(() => {
    if (following.current) toBottom();
    else setBehind(Math.max(0, items.length - seenLen.current));
  }, [items.length, toBottom]);

  useEffect(() => {
    const el = list.current; if (!el) return;
    const rows = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
    const fresh: Element[] = [];
    const prev = seenIds.current;
    const next = new Set<number>();
    for (const r of rows) {
      const rid = Number(r.dataset.id); next.add(rid);
      if (prev && !prev.has(rid)) fresh.push(r);
    }
    seenIds.current = next;
    return rowsIn(fresh);
  }, [items]);

  const pick = (f: Filter) => { seenIds.current = null; following.current = true; setFilter(f); };

  if (all.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <div className="feed">
      <div className="feed-bar">
        <div className="chips" role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => pick(f)}>
              {f} <span className="chip-n">{counts[f]}</span>
            </button>
          ))}
        </div>
        {status === "running" && <span className="live-pill"><span className="dot-run" aria-hidden="true" />live</span>}
      </div>
      {matching.length > items.length && <p className="muted feed-note">Showing the latest {MAX_STEPS} of {matching.length}.</p>}
      <div className="feed-body">
        <ol className="feed-list" ref={list} onScroll={onScroll} aria-label="Activity steps">
          {items.length === 0 && <li className="muted feed-empty">No matching steps.</li>}
          {items.map((s) => (s.kind === "say" ? <SayRow key={s.id} s={s} start={start} /> : <ToolRow key={s.id} s={s} start={start} />))}
        </ol>
        {away && (
          <button type="button" className="jump" aria-label="Jump to latest" onClick={toBottom}>
            ↓ {behind > 0 ? `${behind} new` : "Latest"}
          </button>
        )}
      </div>
    </div>
  );
}

function SayRow({ s, start }: { s: Extract<Step, { kind: "say" }>; start: number }) {
  return (
    <li className="step say" data-id={s.id}>
      <div className="say-head"><span className="say-label">Agent</span><time className="step-time">{relTime(s.ts, start)}</time></div>
      <div className="say-text">{s.text}</div>
    </li>
  );
}

function ToolRow({ s, start }: { s: ToolStep; start: number }) {
  const state = !s.done ? "running" : s.isError ? "error" : "done";
  const [copied, setCopied] = useState<"" | "Copied" | "Copy unavailable">("");
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(s.output ?? "");
      setCopied("Copied");
    } catch { setCopied("Copy unavailable"); }
    setTimeout(() => setCopied(""), 1800);
  };
  return (
    <li className={`step tool st-${state}`} data-id={s.id} data-state={state}>
      <details open={s.isError || undefined}>
        <summary>
          {state === "running" ? <span className="dot-run st-icon" role="img" aria-label="running" />
            : <span className="st-icon" role="img" aria-label={state === "error" ? "error" : "done"}>{state === "error" ? "✕" : "✓"}</span>}
          <span className={`tool-badge fam-${family(s.name)}`}>{s.name}</span>
          <span className="tool-summary mono">{s.summary}</span>
          <span className="tool-meta">
            {s.resultMeta && <span className={s.isError ? "meta-err" : undefined}>{s.resultMeta}</span>}
            {s.ms !== undefined && <span>{fmtMs(s.ms)}</span>}
            <time>{relTime(s.ts, start)}</time>
          </span>
        </summary>
        <div className="tool-body">
          <h4>Input</h4>
          <pre className="io">{pretty(s.input)}</pre>
          <div className="out-head">
            <h4>Output</h4>
            {s.done && <button type="button" className="copy" onClick={copy}>Copy</button>}
            <span className="copied" aria-live="polite">{copied}</span>
          </div>
          {s.done ? <pre className="io out">{s.output}</pre> : <p className="muted">Waiting for the result…</p>}
        </div>
      </details>
    </li>
  );
}
