import { useEffect, useState } from "react";
import { fmtDuration } from "./fmt.js";
import { type AgentView, type PhaseInfo } from "./derive.js";
import { PhasePopover } from "./PhasePopover.js";
import type { Conn } from "./useRun.js";

export type RunInfo = { id: string; goal: string; repo: string; created: number; maxTotalTokens?: number; stop?: { reason: string; message: string } | null };
type Stop = "idle" | "confirm" | "sending" | "sent";

function StopButton({ runId }: { runId: string }) {
  const [state, setState] = useState<Stop>("idle");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setState("idle"); setErr(null); }, [runId]);
  const click = async () => {
    if (state === "idle") { setState("confirm"); return; }
    setState("sending"); setErr(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: { "x-mar": "1" } });
      if (!res.ok) throw new Error(`Stop failed (HTTP ${res.status})`);
      setState("sent");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Stop failed"); setState("idle");
    }
  };
  const label = { idle: "Stop run", confirm: "Confirm stop", sending: "Stopping…", sent: "Stop requested" }[state];
  return (
    <span className="stop">
      <button type="button" className={`danger${state === "confirm" ? " armed" : ""}`} disabled={state === "sending" || state === "sent"} onClick={() => { void click(); }}>{label}</button>
      {state === "confirm" && <button type="button" onClick={() => setState("idle")}>Cancel</button>}
      {err && <span role="alert" className="error">{err}</span>}
    </span>
  );
}

type Props = { repos?: string[]; readOnly?: boolean; runs: RunInfo[]; run: RunInfo | undefined; runId: string; onRun: (id: string) => void; agents: AgentView[]; elapsedMs: number; conn: Conn; partial?: boolean; phase?: PhaseInfo | null; phaseHistory?: PhaseInfo[] };

export function Header({ repos = [], readOnly = false, runs, run, runId, onRun, agents, elapsedMs, conn, phase = null, phaseHistory = [] }: Props) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [runId]);
  return (
    <header className="top">
      <div className="title">
        <label className="visually-hidden" htmlFor="run-select">Run</label>
        <select id="run-select" value={runId} onChange={(e) => onRun(e.target.value)}>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
          {!run && <option value={runId}>{runId}</option>}
        </select>
        <h1 className={expanded ? "goal expanded" : "goal"}>
          <button type="button" aria-expanded={expanded} title={expanded ? "Collapse goal" : "Expand goal"} onClick={() => setExpanded(!expanded)}>{run?.goal ?? "Run"}</button>
        </h1>
        {phase && <PhasePopover key={runId} phase={phase} history={phaseHistory} />}
        {agents.some((a) => a.unsafe) && <span className="badge unsafe" role="status" title="Codex tasks do not map unsafe mode">unsafe mode (Claude workers)</span>}
      </div>
      {repos.length > 0 && <div className="workspace-repos" aria-label="Workspace repositories"><span className="muted">Repos</span>{repos.map((repo) => <span key={repo} className="badge repo-badge" title={repo}>{repo}</span>)}</div>}
      <dl className="stats">
        <div><dt>Elapsed</dt><dd className="mono">{fmtDuration(elapsedMs)}</dd></div>
      </dl>
      <div className="actions">
        {readOnly
          ? <span className="badge history-badge" role="status" data-testid="history-badge" title="Stored run replay: nothing is written and nothing updates live">History (read-only)</span>
          : <>
              <span className={`conn conn-${conn}`} role="status">{conn === "live" ? "● live" : conn === "reconnecting" ? "reconnecting…" : "loading…"}</span>
              <StopButton runId={runId} />
            </>}
      </div>
    </header>
  );
}
