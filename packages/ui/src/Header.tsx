import { useEffect, useState } from "react";
import { fmtCost, fmtDuration, fmtTokens } from "./fmt.js";
import { totals, type AgentView } from "./derive.js";
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

type Props = { runs: RunInfo[]; run: RunInfo | undefined; runId: string; onRun: (id: string) => void; agents: AgentView[]; elapsedMs: number; conn: Conn; partial?: boolean };

export function Header({ runs, run, runId, onRun, agents, elapsedMs, conn, partial = false }: Props) {
  const t = totals(agents);
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
        {agents.some((a) => a.unsafe) && <span className="badge unsafe" role="status" title="Codex tasks do not map unsafe mode">unsafe mode (Claude workers)</span>}
      </div>
      <dl className="stats">
        <div><dt>Tokens{partial ? " (partial)" : ""}</dt><dd className="mono" data-testid="total-tokens">{anyTokens ? `${lead}${fmtTokens(t.tokens)}` : "n/a"}</dd></div>
        <div><dt>Spend{partial ? " (partial)" : ""}</dt><dd className="mono" data-testid="total-cost">{t.costUsd === null ? fmtCost(t.costUsd) : `${lead}${fmtCost(t.costUsd)}`}</dd></div>
        <div><dt>Elapsed</dt><dd className="mono">{fmtDuration(elapsedMs)}</dd></div>
      </dl>
      <div className="actions">
        <span className={`conn conn-${conn}`} role="status">{conn === "live" ? "● live" : conn === "reconnecting" ? "reconnecting…" : "loading…"}</span>
        <StopButton runId={runId} />
      </div>
    </header>
  );
}
