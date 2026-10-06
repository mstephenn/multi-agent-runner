import { useEffect, useRef, useState } from "react";
import { fmtCost, fmtDuration, fmtTokens } from "./fmt.js";
import { totals, type AgentView, type PhaseInfo } from "./derive.js";
import { countTo } from "./motion.js";
import type { Conn } from "./useRun.js";

export type RunInfo = { id: string; goal: string; repo: string; created: number };
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

type Props = { readOnly?: boolean; runs: RunInfo[]; run: RunInfo | undefined; runId: string; onRun: (id: string) => void; agents: AgentView[]; elapsedMs: number; conn: Conn; partial?: boolean; phase?: PhaseInfo | null };

// Displays `value`, tweening from the previous value whenever it changes (no tween on first render).
function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    return countTo(from, value, setShown);
  }, [value]);
  return shown;
}

export function Header({ readOnly = false, runs, run, runId, onRun, agents, elapsedMs, conn, partial = false, phase = null }: Props) {
  const t = totals(agents);
  const shownTokens = useCountUp(t.tokens);
  const lead = partial ? "≥ " : "";
  const anyTokens = agents.some((a) => a.tokens !== null);
  return (
    <header className="top">
      <div className="title">
        <label className="visually-hidden" htmlFor="run-select">Run</label>
        <select id="run-select" value={runId} onChange={(e) => onRun(e.target.value)}>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
          {!run && <option value={runId}>{runId}</option>}
        </select>
        <h1 title={run?.goal}>{run?.goal ?? "Run"}</h1>
        {phase && (
          <span className="phase" data-testid="phase-indicator" title={phase.remaining ? `Remaining after this phase: ${phase.remaining}` : "This phase completes the goal"}>
            <span className="badge phase-badge">Phase {phase.phase}{phase.maxPhases !== null ? `/${phase.maxPhases}` : ""}</span>
            {phase.remaining && <span className="phase-remaining" data-testid="phase-remaining">{phase.remaining}</span>}
          </span>
        )}
        {agents.some((a) => a.unsafe) && <span className="badge unsafe" role="status" title="Codex tasks do not map unsafe mode">unsafe mode (Claude workers)</span>}
      </div>
      <dl className="stats">
        <div><dt>Tokens{partial ? " (partial)" : ""}</dt><dd className="mono" data-testid="total-tokens">{anyTokens ? `${lead}${fmtTokens(shownTokens)}` : "n/a"}</dd></div>
        <div><dt>Spend{partial ? " (partial)" : ""}</dt><dd className="mono" data-testid="total-cost">{t.costUsd === null ? fmtCost(t.costUsd) : `${lead}${fmtCost(t.costUsd)}`}</dd></div>
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
