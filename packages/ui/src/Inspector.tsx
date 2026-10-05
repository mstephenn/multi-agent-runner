import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { BbEntry, Dag, StoredEvent } from "@mar/core";
import { deriveActivity, deriveContext, type AgentView } from "./derive.js";
import { budgetUsage, fmtCost, fmtTokens } from "./fmt.js";
import type { ReportRow } from "./runClient.js";
import { drawerIn, rowsIn } from "./motion.js";

const TABS = ["Context", "Activity", "Output", "Usage"] as const;
type Tab = (typeof TABS)[number];
const MAX_ACTIVITY = 500;

type Props = { agent: AgentView; events: StoredEvent[]; blackboard: BbEntry[]; plan: Dag | null; reports?: ReportRow[]; onClose: () => void };

export function Inspector({ agent, events, blackboard, plan, reports = [], onClose }: Props) {
  const [tab, setTab] = useState<Tab>("Context");
  const spec = plan?.tasks.find((t) => t.id === agent.id);
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault(); setTab(TABS[next]!);
    document.getElementById(`tab-${TABS[next]}`)?.focus();
  };
  const aside = useRef<HTMLElement>(null);
  useEffect(() => drawerIn(aside.current), []);
  return (
    <aside ref={aside} className="inspector" aria-label={`Inspector for ${agent.id}`}>
      <header className="insp-head">
        <div><h2 className="mono">{agent.id}</h2><span className="status-text" data-status={agent.status}>{agent.status}{agent.detail ? `: ${agent.detail}` : ""}</span></div>
        <button type="button" onClick={onClose} aria-label="Close inspector">Close</button>
      </header>
      {spec && <p className="goal">{spec.goal}</p>}
      <div role="tablist" aria-label="Inspector sections" className="tabs" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button key={t} id={`tab-${t}`} role="tab" type="button" aria-selected={tab === t} aria-controls={`panel-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="panel">
        {tab === "Context" && <ContextTab id={agent.id} events={events} blackboard={blackboard} />}
        {tab === "Activity" && <ActivityTab id={agent.id} events={events} />}
        {tab === "Output" && <OutputTab id={agent.id} blackboard={blackboard} reports={reports} />}
        {tab === "Usage" && <UsageTab agent={agent} budget={spec?.budgetTokens} />}
      </div>
    </aside>
  );
}

function ContextTab({ id, events, blackboard }: { id: string; events: StoredEvent[]; blackboard: BbEntry[] }) {
  const ctx = useMemo(() => deriveContext(events, id, [...new Set(blackboard.map((b) => b.key))]), [events, id, blackboard]);
  if (ctx.prompt === null && ctx.slices.length === 0) return <p className="muted">No prompt sent yet.</p>;
  return (
    <>
      <h3>Prompt</h3>
      <pre className="prompt">{ctx.prompt ?? "(not recorded)"}</pre>
      <h3>Injected slices</h3>
      {ctx.slices.length === 0 ? <p className="muted">None.</p> : (
        <table><thead><tr><th>Key</th><th>Version</th><th>Tokens</th></tr></thead>
          <tbody>{ctx.slices.map((s) => <tr key={`${s.key}@${s.version}`}><td className="mono">{s.key}</td><td>v{s.version}</td><td>{fmtTokens(s.tokens)}</td></tr>)}</tbody></table>
      )}
      <h3>Not given</h3>
      {ctx.notGiven.length === 0 ? <p className="muted">Nothing withheld.</p> : <ul className="keys">{ctx.notGiven.map((k) => <li key={k} className="mono">{k}</li>)}</ul>}
    </>
  );
}

function ActivityTab({ id, events }: { id: string; events: StoredEvent[] }) {
  const all = useMemo(() => deriveActivity(events, id), [events, id]);
  const items = all.length > MAX_ACTIVITY ? all.slice(-MAX_ACTIVITY) : all;
  const box = useRef<HTMLOListElement>(null);
  const shown = useRef(items.length); // rows already on screen; only rows appended later animate
  useEffect(() => {
    const el = box.current; if (!el) return;
    const fresh = items.length > shown.current ? Array.from(el.children).slice(shown.current - items.length) : [];
    shown.current = items.length;
    el.scrollTop = el.scrollHeight;
    return rowsIn(fresh);
  }, [items.length]);
  if (all.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <>
      {all.length > items.length && <p className="muted">Showing the latest {MAX_ACTIVITY} of {all.length}.</p>}
      <ol className="activity" ref={box}>
        {items.map((a) => (
          <li key={a.id} className={`kind-${a.kind}${a.isError ? " err" : ""}`}>
            <span className="act-kind">{a.kind === "text" ? "say" : a.kind === "tool_call" ? "call" : a.isError ? "error" : "result"}</span>
            <span className="act-text">{a.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function OutputTab({ id, blackboard, reports }: { id: string; blackboard: BbEntry[]; reports: ReportRow[] }) {
  const mine = useMemo(() => blackboard.filter((b) => b.author_task === id), [blackboard, id]);
  const report = reports.find((r) => r.task_id === id);
  if (mine.length === 0 && !report) return <p className="muted">No entries written.</p>;
  // The report is untrusted model output: rendered strictly as text, never as HTML or markdown.
  return <>{report && <section className="entry"><h3>Report</h3><pre className="report" data-testid="report">{report.body}</pre></section>}{mine.map((b) => <section key={b.id} className="entry"><h3><span className="mono">{b.key}</span> <span className="muted">v{b.version} · {b.kind}</span></h3><pre>{b.body}</pre></section>)}</>;
}

function UsageTab({ agent, budget }: { agent: AgentView; budget: number | undefined }) {
  const u = budgetUsage(agent.tokens, budget);
  return (
    <dl className="usage">
      <dt>Tokens</dt><dd>{fmtTokens(agent.tokens)}</dd>
      <dt>Budget</dt><dd>{budget ? fmtTokens(budget) : "no per-task budget set (default applies)"}</dd>
      <dt>Cost</dt><dd>{fmtCost(agent.costUsd)}</dd>
      {u && <><dt>Used</dt><dd className={u.over ? "over-budget" : undefined}><div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, u.pct)} aria-label="Budget used"><div style={{ width: `${Math.min(100, u.pct)}%` }} /></div> {u.over ? `over budget (${u.pct}%)` : `${u.pct}%`}</dd></>}
    </dl>
  );
}
