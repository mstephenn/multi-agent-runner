import { useMemo, useState, type KeyboardEvent } from "react";
import type { BbEntry, StoredEvent } from "@mar/core";
import type { AgentView, FlowEdge } from "./derive.js";
import { Timeline } from "./Timeline.js";
import { BlackboardPanel } from "./BlackboardPanel.js";

type TabId = "timeline" | "blackboard";
const TABS: TabId[] = ["timeline", "blackboard"];
const KEY = "mar.dock.tab";

// localStorage can throw (private window, blocked site data); the panel must work without it.
const loadTab = (): TabId => {
  try { const v = localStorage.getItem(KEY); return v === "blackboard" ? "blackboard" : "timeline"; } catch { return "timeline"; }
};
const saveTab = (t: TabId) => { try { localStorage.setItem(KEY, t); } catch { /* ignore */ } };

type Props = {
  events: StoredEvent[]; allEvents: StoredEvent[]; agents: AgentView[]; blackboard: BbEntry[]; flow: FlowEdge[];
  now: number; liveEnd: number; cutoff: number | null; onCutoff: (ts: number | null) => void; onSelect: (id: string) => void;
};

export function BottomPanel({ blackboard, flow, agents, ...tl }: Props) {
  const [tab, setTab] = useState<TabId>(loadTab);
  const choose = (t: TabId) => { setTab(t); saveTab(t); };
  const label = (t: TabId) => (t === "timeline" ? "Timeline" : `Blackboard (${blackboard.length})`);
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault(); choose(TABS[next]!);
    document.getElementById(`dock-tab-${TABS[next]}`)?.focus();
  };
  const summary = useMemo(() => {
    const c = { running: 0, done: 0, failed: 0 };
    for (const a of agents) if (a.status === "running" || a.status === "done" || a.status === "failed") c[a.status]++;
    return `${agents.length} agent${agents.length === 1 ? "" : "s"} · ${c.running} running · ${c.done} done${c.failed ? ` · ${c.failed} failed` : ""}`;
  }, [agents]);
  return (
    <section className="dock" aria-label="Run details">
      <div className="dock-head">
        <div role="tablist" aria-label="Bottom panel" className="dock-tabs" onKeyDown={onKey}>
          {TABS.map((t) => (
            <button key={t} id={`dock-tab-${t}`} type="button" role="tab" aria-selected={tab === t} aria-controls={tab === t ? `dock-panel-${t}` : undefined} tabIndex={tab === t ? 0 : -1} onClick={() => choose(t)}>{label(t)}</button>
          ))}
        </div>
        <span className="muted dock-summary">{summary}</span>
      </div>
      <div id={`dock-panel-${tab}`} role="tabpanel" aria-labelledby={`dock-tab-${tab}`} className="dock-body">
        {tab === "timeline" ? <Timeline agents={agents} {...tl} /> : <BlackboardPanel entries={blackboard} flow={flow} />}
      </div>
    </section>
  );
}
