import { useEffect, useState } from "react";
import type { Problem } from "./taskBoard.js";

type Props = { problems: Problem[]; runId: string; onOpen: (taskId: string) => void };

/** Sits under the header only when something is wrong; collapsible, errors first, scrolls inside (max ~25% of the viewport). */
export function ProblemsStrip({ problems, runId, onOpen }: Props) {
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(true), [runId]);
  if (problems.length === 0) return null;
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.length - errors;
  return (
    <section className="problems" aria-label="Problems" data-testid="problems">
      <button type="button" className="problems-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <strong>Problems</strong>
        <span className="muted">{[errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : "", warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : ""].filter(Boolean).join(" · ")}</span>
      </button>
      {open && <ul className="problems-list">
        {problems.map((p) => (
          <li key={p.id} className={`problem problem-${p.severity}`} data-testid={`problem-${p.id}`}>
            <span className="problem-icon" aria-hidden="true">{p.severity === "error" ? "✕" : "⚠"}</span>
            <span className="problem-text">
              <span className="problem-title mono">{p.title}</span>
              <span className="problem-detail" title={p.detail}>{p.severity === "warning" ? "Warning: " : ""}{p.detail}</span>
              {p.files.length > 0 && <span className="problem-files">
                {p.files.map((f) => <code key={f} title={f}>{f}</code>)}
                {p.moreFiles > 0 && <span className="muted">+{p.moreFiles} more</span>}
              </span>}
            </span>
            {p.taskId !== null && <button type="button" onClick={() => onOpen(p.taskId!)} aria-label={`Open ${p.taskId}`}>Open</button>}
          </li>
        ))}
      </ul>}
    </section>
  );
}
