import { useEffect, useMemo, useState } from "react";
import type { StoredEvent } from "@mar/core";
import { deriveVerifyResult, taskDuration, type AgentView } from "./derive.js";
import { fmtDuration } from "./fmt.js";

type Props = { agent: AgentView; events: StoredEvent[]; hasReport: boolean; onOpenReport: () => void };

export function InspectorSummary({ agent, events, hasReport, onOpenReport }: Props) {
  const [now, setNow] = useState(Date.now);
  const running = agent.status === "running";
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [agent.id, agent.startedAt, running]);
  const verify = useMemo(() => deriveVerifyResult(events, agent.id), [events, agent.id]);
  const branch = useMemo(() => {
    const start = events.filter((e) => e.task_id === agent.id && e.type === "task_started").at(-1);
    const payload = start?.payload;
    if (!payload || typeof payload !== "object") return "Not recorded";
    if ("worktree" in payload && payload.worktree === "shared") return "Shared worktree (no task branch)";
    // Own worktrees use this branch convention in both single-repo and workspace runs.
    if ("worktree" in payload && payload.worktree === "own" && start?.run_id) return `mar/${start.run_id}/${agent.id}`;
    return "Not recorded";
  }, [events, agent.id]);
  const finished = agent.status === "done" || agent.status === "failed";
  return (
    <section className="inspector-summary" aria-label="Task summary">
      <dl className="usage">
        <dt>Status</dt><dd><span className="status-text" data-status={agent.status}>{agent.status}{agent.detail ? `: ${agent.detail}` : ""}</span></dd>
        <dt>Runtime</dt><dd>{agent.runtime ?? "Not recorded"}</dd>
        <dt>{running ? "Elapsed" : "Duration"}</dt><dd role={running ? "timer" : undefined}>{fmtDuration(taskDuration(agent, now))}</dd>
        <dt>Branch</dt><dd>{branch}</dd>
        <dt>Verify</dt><dd>{verify ? `${verify.status}${verify.timedOut ? " (timed out)" : ""}${verify.durationMs !== null ? ` · ${fmtDuration(verify.durationMs)}` : ""}` : "Not recorded"}</dd>
      </dl>
      {running && <p className="muted">Usage is reported when the task finishes.</p>}
      {finished && hasReport && <button type="button" onClick={onOpenReport}>Open report</button>}
    </section>
  );
}
