import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { fmtDuration, fmtTokens } from "./fmt.js";
import { countTo } from "./motion.js";
import { type AgentView, type PhaseInfo } from "./derive.js";
import type { RunState } from "./taskBoard.js";
import { useDismiss } from "./usePopover.js";
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

function AddFeature({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setText(""); setState("idle"); setErr(null); }, [runId]);
  const send = async () => {
    setState("sending"); setErr(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/features`, { method: "POST", headers: { "x-mar": "1", "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (res.status === 409) throw new Error("The run has finished planning; start a new run for this.");
      if (!res.ok) throw new Error(`Could not add feature (HTTP ${res.status})`);
      setText(""); setState("sent"); setOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not add feature"); setState("idle"); }
  };
  return (
    <span className="add-feature">
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); setState("idle"); }}>{state === "sent" && !open ? "Feature queued ✓" : "Add feature"}</button>
      {open && (
        <form className="add-feature-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send(); }}>
          <label className="visually-hidden" htmlFor="add-feature-text">Describe the additional feature</label>
          <textarea id="add-feature-text" rows={3} maxLength={4000} value={text} placeholder="Describe the feature to add. It is planned as the next phase, after the current one finishes." onChange={(e) => setText(e.target.value)} />
          <button type="submit" disabled={state === "sending" || text.trim() === ""}>{state === "sending" ? "Adding…" : "Queue feature"}</button>
        </form>
      )}
      {err && <span role="alert" className="error">{err}</span>}
    </span>
  );
}

// More than this many workspace repos collapse into one "N repos" button with a popover.
const MAX_REPO_BADGES = 3;
function RepoBadges({ repos }: { repos: string[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root, trigger);
  if (repos.length === 0) return null;
  const badge = (repo: string) => <span key={repo} className="badge repo-badge" title={repo}>{repo}</span>;
  if (repos.length <= MAX_REPO_BADGES) return <div className="workspace-repos" aria-label="Workspace repositories">{repos.map(badge)}</div>;
  return (
    <div className="workspace-repos" ref={root} aria-label="Workspace repositories" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button ref={trigger} type="button" className="repos-toggle" aria-expanded={open} aria-controls={id} title={repos.join(", ")} onClick={() => setOpen(!open)}>{repos.length} repos</button>
      {open && <section id={id} className="popover repos-popover" aria-label="Workspace repositories list"><strong>Workspace repositories</strong><ul>{repos.map((r) => <li key={r}>{badge(r)}</li>)}</ul></section>}
    </div>
  );
}

export type Budget = { tokens: number | null; partial: boolean; limit: number | null; pct: number | null; over: boolean };
type Props = {
  repos?: string[]; readOnly?: boolean; runs: RunInfo[]; run: RunInfo | undefined; runId: string; onRun: (id: string) => void; agents: AgentView[];
  elapsedMs: number; conn: Conn; phase?: PhaseInfo | null; phaseHistory?: PhaseInfo[];
  /** Summary segments (phase first when there is one) and the run state they end with. */
  summary: string[]; state: RunState; budget: Budget;
};

export function Header({ repos = [], readOnly = false, runs, run, runId, onRun, agents, elapsedMs, conn, phase = null, phaseHistory = [], summary, state, budget }: Props) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [runId]);
  const goal = run?.goal ?? "Run";
  // The token total counts up to its new value (snaps under reduced motion).
  const [shown, setShown] = useState(budget.tokens ?? 0);
  const previous = useRef(budget.tokens ?? 0);
  useEffect(() => {
    if (budget.tokens === null) return;
    const from = previous.current;
    previous.current = budget.tokens;
    return countTo(from, budget.tokens, setShown);
  }, [budget.tokens]);
  const tokensText = budget.tokens === null ? "n/a" : `${budget.partial ? "≥ " : ""}${fmtTokens(shown)}`;
  const segments = (phase ? summary.slice(1) : summary).map((text, i, all) => {
    const last = i === all.length - 1 && state.kind !== "running";
    return <Fragment key={i}><span className={last ? "seg-state" : undefined} data-state={last ? state.kind : undefined}>{text}</span>{" "}</Fragment>;
  });
  const tip = `Elapsed ${fmtDuration(elapsedMs)} · Tokens ${budget.tokens === null ? "n/a" : fmtTokens(budget.tokens)}${budget.limit !== null ? ` of ${fmtTokens(budget.limit)} (${budget.pct}%)` : " (limit unknown)"}${budget.partial ? " · partial: older events were not loaded" : ""}`;
  return (
    <header className="top">
      <label className="visually-hidden" htmlFor="run-select">Run</label>
      <select id="run-select" value={runId} onChange={(e) => onRun(e.target.value)}>
        {runs.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
        {!run && <option value={runId}>{runId}</option>}
      </select>
      <h1 className={expanded ? "goal expanded" : "goal"}>
        <button type="button" aria-expanded={expanded} title={goal} onClick={() => setExpanded(!expanded)}>{goal}</button>
      </h1>
      <div className="status-line" role="group" aria-label="Run status" title={tip}>
        {phase
          ? <PhasePopover key={runId} phase={phase} history={phaseHistory}>{segments}</PhasePopover>
          : segments}
        <span className="tok-chip mono"><span data-testid="total-tokens">{tokensText}</span> tok</span>
      </div>
      {agents.some((a) => a.unsafe) && <span className="badge unsafe" role="status" title="Codex tasks do not map unsafe mode">unsafe mode (Claude workers)</span>}
      <RepoBadges repos={repos} />
      <div className="actions">
        {readOnly
          ? <span className="badge history-badge" role="status" data-testid="history-badge" title="Stored run replay: nothing is written and nothing updates live">History (read-only)</span>
          : <>
              <span className={`conn conn-${conn}`} role="status">{conn === "live" ? "● live" : conn === "reconnecting" ? "reconnecting…" : "loading…"}</span>
              <AddFeature runId={runId} />
              <StopButton runId={runId} />
            </>}
      </div>
      {budget.pct !== null && <progress className={`budget-bar${budget.over ? " over" : ""}`} aria-label="Token budget used" title={tip} max={100} value={Math.min(100, budget.pct)} />}
    </header>
  );
}
