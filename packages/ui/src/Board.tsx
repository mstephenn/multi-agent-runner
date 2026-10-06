import { useEffect, useRef, useState } from "react";
import { CHIPS, type BoardChip, type BoardGroup } from "./taskBoard.js";
import { taskDuration, type AgentView } from "./derive.js";
import { fmtDuration, fmtTokens, STATUS_ICON } from "./fmt.js";
import { rowsIn } from "./motion.js";

type Props = {
  groups: BoardGroup[]; total: number; counts: Record<BoardChip, number>; chip: BoardChip; onChip: (c: BoardChip) => void;
  query: string; onQuery: (q: string) => void; selected: string | null; onSelect: (id: string) => void; now: number; nowTexts: Map<string, string>;
};

const tokensText = (a: AgentView) => (a.status === "running" ? "reported when done" : a.status === "pending" || a.status === "blocked" ? "—" : fmtTokens(a.tokens));
const timeText = (a: AgentView, now: number) => (a.status === "pending" || (a.status === "blocked" && a.startedAt === undefined) ? "—" : fmtDuration(taskDuration(a, now)));

function Row({ a, now, text, selected, onSelect }: { a: AgentView; now: number; text: string; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <li className="board-item" data-testid={`row-${a.id}`} data-status={a.status}>
      <button type="button" className={`board-row${selected ? " selected" : ""}`} aria-pressed={selected} onClick={() => onSelect(a.id)}>
        <span className="c-status" data-status={a.status}>
          {a.status === "running" ? <span className="dot-run" aria-hidden="true" /> : <span aria-hidden="true">{STATUS_ICON[a.status]}</span>}
          <span>{a.status}</span>
        </span>
        <span className="c-id mono" title={a.id}>{a.id}{!!a.siblingWarnings?.length && <span className="sibling-indicator" title="Sibling repository modified" aria-label="Sibling repository modified"> ⚠</span>}</span>
        <span className="c-repo">{a.repo && <span className="badge repo-badge" title={a.repo === "*" ? "All workspace repositories" : `Repository: ${a.repo}`}>{a.repo === "*" ? "All repos" : a.repo}</span>}</span>
        <span className="c-badges">
          {a.runtime && <span className={`badge rt-${a.runtime}`}>{a.runtime}</span>}
          {a.tier && <span className="badge tier">{a.tier}</span>}
          {a.role && <span className="role">{a.role}</span>}
        </span>
        <span className="c-now" title={text}>{text}</span>
        <span className="c-time mono">{timeText(a, now)}</span>
        <span className="c-tok mono">{tokensText(a)}</span>
      </button>
    </li>
  );
}

export function Board({ groups, total, counts, chip, onChip, query, onQuery, selected, onSelect, now, nowTexts }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const known = useRef<Set<string> | null>(null);
  const rows = groups.flatMap((g) => g.rows);
  const runningIds = rows.filter((r) => r.status === "running").map((r) => r.id).join("\0");
  // Rows that are new AND running slide in; the first render and a status change of a known row never animate.
  useEffect(() => {
    const seen = known.current;
    known.current = new Set(rows.map((r) => r.id));
    if (seen === null) return;
    const fresh = rows.filter((r) => r.status === "running" && !seen.has(r.id)).map((r) => list.current?.querySelector(`[data-testid="row-${CSS.escape(r.id)}"]`)).filter((e): e is Element => !!e);
    return rowsIn(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningIds, rows.length]);
  useEffect(() => {
    if (selected) list.current?.querySelector(".board-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  if (total === 0) return <div className="empty" role="status"><span className="spinner" aria-hidden="true" /><span>No tasks yet. Waiting for the planner.</span></div>;
  const toggle = (key: string) => setCollapsed((cur) => { const n = new Set(cur); if (!n.delete(key)) n.add(key); return n; });
  return (
    <div className={`board${rows.some((r) => r.repo !== undefined) ? "" : " no-repo"}`} ref={list} aria-label="Task board">
      <div className="board-head">
      <div className="board-bar">
        <label className="visually-hidden" htmlFor="board-filter">Filter tasks</label>
        <input id="board-filter" type="search" className="board-search" placeholder="filter tasks…" value={query} autoComplete="off" onChange={(e) => onQuery(e.target.value)} />
        <div className="chips" role="group" aria-label="Filter by status">
          {CHIPS.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={chip === c.id} title={c.id === "failed" ? "Failed or blocked tasks" : undefined} onClick={() => onChip(c.id)}>{c.label} <span className="chip-n">{counts[c.id]}</span></button>
          ))}
        </div>
      </div>
      <div className="board-cols" aria-hidden="true">
        <span>Status</span><span>Task</span><span className="c-repo">Repo</span><span className="c-badges">Agent</span><span>Now</span><span className="c-time">Time</span><span className="c-tok">Tokens</span>
      </div>
      </div>
      {groups.length === 0 && <p className="muted board-none" role="status">No tasks match.</p>}
      {groups.map((g) => {
        const open = g.phase === null || !collapsed.has(g.key);
        return (
          <section key={g.key} className="board-group" aria-label={g.title || "Tasks"}>
            {g.phase !== null && (
              <h2 className="board-phase">
                <button type="button" aria-expanded={open} onClick={() => toggle(g.key)}><span aria-hidden="true">{open ? "▾" : "▸"}</span> <strong>{g.title}</strong> <span className="muted">· {g.summary}</span></button>
              </h2>
            )}
            {open && <ul className="board-list">{g.rows.map((a) => <Row key={a.id} a={a} now={now} text={nowTexts.get(a.id) ?? ""} selected={a.id === selected} onSelect={onSelect} />)}</ul>}
          </section>
        );
      })}
    </div>
  );
}
