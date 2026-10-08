import type { UseCaseBoard } from "./useCases.js";
import { STATUS_ICON } from "./fmt.js";

type Props = { board: UseCaseBoard; selected: string | null; onSelect: (id: string) => void };

export function UseCases({ board, selected, onSelect }: Props) {
  const { cases, unassigned } = board;
  if (cases.length === 0) return <div className="empty" role="status"><span>No use cases in this plan. Single-purpose goals may not define any.</span></div>;
  const done = cases.filter((c) => c.status === "done").length;
  return (
    <div className="usecases" aria-label="Use cases">
      <p className="uc-summary">{done} of {cases.length} use cases done</p>
      <ul className="uc-grid">
        {cases.map((c) => (
          <li key={c.id} className="uc-card" data-testid={`uc-${c.id}`} data-status={c.status}>
            <div className="uc-head">
              <span className="c-status" data-status={c.status === "uncovered" ? "pending" : c.status}>
                <span aria-hidden="true">{STATUS_ICON[c.status === "uncovered" ? "pending" : c.status]}</span><span>{c.status === "uncovered" ? "no tasks yet" : c.status}</span>
              </span>
              <h3 className="uc-title">{c.title}</h3>
              <span className="mono uc-id">{c.id}</span>
            </div>
            {c.description && <p className="uc-desc">{c.description}</p>}
            <div className="uc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(c.progress * 100)} aria-label={`${c.title} progress`}>
              <span style={{ width: `${c.progress * 100}%` }} />
            </div>
            <ul className="uc-tasks">
              {c.tasks.map((t) => (
                <li key={t.id}>
                  <button type="button" className={`uc-task${selected === t.id ? " selected" : ""}`} data-status={t.status} aria-pressed={selected === t.id} onClick={() => onSelect(t.id)}>
                    <span aria-hidden="true">{STATUS_ICON[t.status]}</span><span className="mono">{t.id}</span>{t.role && <span className="role">{t.role}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {unassigned.length > 0 && (
        <p className="uc-unassigned">Not tied to a use case: {unassigned.map((t) => t.id).join(", ")}</p>
      )}
    </div>
  );
}
