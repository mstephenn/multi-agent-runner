import { useCallback, useEffect, useMemo, useState } from "react";
import type { BbEntry } from "@mar/core";
import { deriveRunOverview, deriveAgents, deriveWorkspaceRepos, deriveFlow, deriveLanes, derivePhase, isRunActive, type AgentView } from "./derive.js";
import { useRun } from "./useRun.js";
import { Header, type RunInfo } from "./Header.js";
import { OverviewStrip } from "./OverviewStrip.js";
import { GraphView } from "./GraphView.js";
import { Inspector } from "./Inspector.js";
import { BottomPanel } from "./BottomPanel.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { shortcutAction, stepSelection } from "./shortcuts.js";

const initialRun = () => new URLSearchParams(location.search).get("run");

// One shared ticking clock, only while something is running in the live view.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function App() {
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRun);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState<number | null>(null);
  const [cutoff, setCutoff] = useState<number | null>(null);
  // null until /api/meta answered; an older server without it counts as a live (writable) one.
  const [readOnly, setReadOnly] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/meta").then((r) => (r.ok ? r.json() as Promise<{ readOnly?: unknown }> : {}))
      .then((m) => { if (alive) setReadOnly((m as { readOnly?: unknown }).readOnly === true); })
      .catch(() => { if (alive) setReadOnly(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/runs").then((r) => { if (!r.ok) throw new Error(`Server returned ${r.status}`); return r.json() as Promise<RunInfo[]>; })
      .then((rs) => { if (alive) { setRuns(rs); setRunId((cur) => cur ?? rs[0]?.id ?? null); } })
      .catch((e: unknown) => { if (alive) setRunsError(e instanceof Error ? e.message : "Cannot reach the server"); });
    return () => { alive = false; };
  }, []);

  const { snap, conn, error, notFound } = useRun(readOnly === null ? null : runId, readOnly === true);
  const truncated = snap.truncated === true;
  const chooseRun = useCallback((id: string) => {
    setRunId(id); setSelected(null); setCutoff(null);
    history.replaceState(null, "", `?run=${encodeURIComponent(id)}`);
  }, []);

  const events = useMemo(() => (cutoff === null ? snap.events : snap.events.filter((e) => e.ts <= cutoff)), [snap.events, cutoff]);
  const blackboard = useMemo<BbEntry[]>(() => (cutoff === null ? snap.blackboard : snap.blackboard.filter((b) => b.ts <= cutoff)), [snap.blackboard, cutoff]);
  const agents = useMemo<AgentView[]>(() => {
    return deriveAgents(events, cutoff === null ? snap.tasks : [], snap.plan);
  }, [events, snap.tasks, snap.plan, cutoff]);
  const repos = useMemo(() => deriveWorkspaceRepos(snap.events), [snap.events]);
  const flow = useMemo(() => deriveFlow(events), [events]);
  const phase = useMemo(() => derivePhase(events), [events]);
  const phaseHistory = useMemo(() => events.filter((e) => e.type === "phase_started").flatMap((e) => { const p = derivePhase([e]); return p ? [p] : []; }), [events]);
  const lanes = useMemo(() => deriveLanes(events), [events]);

  const maxTs = snap.events.at(-1)?.ts ?? 0;
  const running = readOnly !== true && isRunActive(lanes, agents, { error, notFound }); // a stored run is frozen at its last event
  const clock = useNow(running);
  const now = cutoff ?? (running ? clock : maxTs || clock); // a finished/stopped run freezes at its last event
  const liveEnd = running ? Math.max(clock, maxTs) : maxTs; // right edge of the timeline while live
  const run = runs?.find((r) => r.id === runId);
  const overview = deriveRunOverview(events, agents, now, { maxTotalTokens: run?.maxTotalTokens, stop: cutoff === null ? run?.stop : null });
  const hasUsage = events.some((e) => { const p = e.payload as { input?: unknown; output?: unknown } | null; return e.type === "usage" && [p?.input, p?.output].some((n) => typeof n === "number" && Number.isFinite(n)); });
  const startTs = snap.events[0]?.ts ?? run?.created ?? now;
  const endTs = running || cutoff !== null ? now : events.at(-1)?.ts ?? now;
  const agent = agents.find((a) => a.id === selected) ?? null;
  const [help, setHelp] = useState(false);
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // e.g. the phase popover already used this Escape
      const action = shortcutAction(e);
      if (action === "help") setHelp((open) => !open);
      else if (action === "close") { if (help) setHelp(false); else setSelected(null); }
      else if (action === "next" || action === "prev") setSelected((cur) => stepSelection(agentIds, cur, action === "next" ? 1 : -1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [help, agentIds]);

  if (runsError) return <div className="state state-error" role="alert"><strong>Cannot reach the runner server</strong><span>{runsError}</span></div>;
  if (runs === null || readOnly === null) return <div className="state" role="status"><span className="spinner" aria-hidden="true" />Loading runs…</div>;
  if (!runId) return <div className="state"><strong>No runs yet</strong><span>Start one with <code>mar run</code>.</span></div>;
  if (notFound) return <div className="state state-error" role="alert"><strong>Run not found</strong><span>Run <code>{runId}</code> was not found. It may have been created in a different repository or deleted.</span></div>;
  const offline = conn === "reconnecting";
  return (
    <div className={`app${offline ? " offline" : ""}`} data-conn={conn}>
      <Header repos={repos} readOnly={readOnly === true} runs={runs} run={run} runId={runId} onRun={chooseRun} agents={agents} elapsedMs={endTs - startTs} conn={conn} partial={truncated} phase={phase} phaseHistory={phaseHistory} />
      <OverviewStrip overview={overview} partial={truncated} hasUsage={hasUsage} />
      {offline && <div className="banner offline-banner" role="alert" data-testid="offline-banner"><strong>Connection lost.</strong> Showing the last known state{error ? ` (${error})` : ""}. Retrying…</div>}
      {error && !offline && <div className="banner" role="alert">{error}.</div>}
      {truncated && <div className="banner info" role="status" data-testid="truncated-banner">Showing the latest {snap.events.length.toLocaleString("en-US")} events of a longer run — token totals and early context may be incomplete.</div>}
      {cutoff !== null && <div className="banner info" role="status">Replaying: views show state as of the scrubber position.</div>}
      <main className="main">
        <GraphView agents={agents} plan={snap.plan} flow={flow} selected={selected} onSelect={setSelected} />
        {agent && <Inspector key={agent.id} agent={agent} events={events} blackboard={blackboard} plan={snap.plan} reports={snap.reports} width={inspectorWidth} onWidthChange={setInspectorWidth} onClose={() => setSelected(null)} />}
      </main>
      <BottomPanel events={events} allEvents={snap.events} agents={agents} blackboard={blackboard} flow={flow} now={now} liveEnd={liveEnd} cutoff={cutoff} onCutoff={setCutoff} onSelect={setSelected} />
      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}
