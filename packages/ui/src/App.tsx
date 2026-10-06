import { useCallback, useEffect, useMemo, useState } from "react";
import type { BbEntry } from "@mar/core";
import { deriveAgents, deriveWorkspaceRepos, deriveFlow, deriveLanes, derivePhase, isRunActive, type AgentView } from "./derive.js";
import { useRun } from "./useRun.js";
import { Header, type RunInfo } from "./Header.js";
import { GraphView } from "./GraphView.js";
import { Inspector } from "./Inspector.js";
import { BottomPanel } from "./BottomPanel.js";

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
  const lanes = useMemo(() => deriveLanes(events), [events]);

  const maxTs = snap.events.at(-1)?.ts ?? 0;
  const running = readOnly !== true && isRunActive(lanes, agents, { error, notFound }); // a stored run is frozen at its last event
  const clock = useNow(running);
  const now = cutoff ?? (running ? clock : maxTs || clock); // a finished/stopped run freezes at its last event
  const liveEnd = running ? Math.max(clock, maxTs) : maxTs; // right edge of the timeline while live
  const run = runs?.find((r) => r.id === runId);
  const startTs = snap.events[0]?.ts ?? run?.created ?? now;
  const endTs = running || cutoff !== null ? now : events.at(-1)?.ts ?? now;
  const agent = agents.find((a) => a.id === selected) ?? null;

  if (runsError) return <div className="state" role="alert">Cannot reach the runner server: {runsError}</div>;
  if (runs === null || readOnly === null) return <div className="state" role="status">Loading runs…</div>;
  if (!runId) return <div className="state">No runs yet. Start one with <code>mar run</code>.</div>;
  if (notFound) return <div className="state" role="alert">Run <code>{runId}</code> was not found. It may have been created in a different repository or deleted.</div>;
  return (
    <div className="app">
      <Header repos={repos} readOnly={readOnly === true} runs={runs} run={run} runId={runId} onRun={chooseRun} agents={agents} elapsedMs={endTs - startTs} conn={conn} partial={truncated} phase={phase} />
      {error && <div className="banner" role="alert">{error}. {conn === "reconnecting" ? "Retrying…" : ""}</div>}
      {truncated && <div className="banner info" role="status" data-testid="truncated-banner">Showing the latest {snap.events.length.toLocaleString("en-US")} events of a longer run — token totals and early context may be incomplete.</div>}
      {cutoff !== null && <div className="banner info" role="status">Replaying: views show state as of the scrubber position.</div>}
      <main className="main">
        <GraphView agents={agents} plan={snap.plan} flow={flow} selected={selected} onSelect={setSelected} />
        {agent && <Inspector key={agent.id} agent={agent} events={events} blackboard={blackboard} plan={snap.plan} reports={snap.reports} width={inspectorWidth} onWidthChange={setInspectorWidth} onClose={() => setSelected(null)} />}
      </main>
      <BottomPanel events={events} allEvents={snap.events} agents={agents} blackboard={blackboard} flow={flow} now={now} liveEnd={liveEnd} cutoff={cutoff} onCutoff={setCutoff} onSelect={setSelected} />
    </div>
  );
}
