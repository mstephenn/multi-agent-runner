import { type KeyboardEvent, type ReactNode } from "react";

export type MainTabId = "board" | "usecases" | "answer" | "graph" | "timeline" | "blackboard";
export const MAIN_TAB_KEY = "mar.main.tab";
const ALL: MainTabId[] = ["board", "usecases", "answer", "graph", "timeline", "blackboard"];

// localStorage can throw (private window, blocked site data); the tabs must work without it.
export const loadMainTab = (): MainTabId => {
  try { const v = localStorage.getItem(MAIN_TAB_KEY); return ALL.find((t) => t === v) ?? "board"; } catch { return "board"; }
};
export const saveMainTab = (t: MainTabId) => { try { localStorage.setItem(MAIN_TAB_KEY, t); } catch { /* ignore */ } };

export type TabSpec = { id: MainTabId; label: string };
type Props = { tabs: TabSpec[]; active: MainTabId; onChange: (id: MainTabId) => void; children: ReactNode };

export function MainTabs({ tabs, active, onChange, children }: Props) {
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + last) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    onChange(id);
    document.getElementById(`main-tab-${id}`)?.focus();
  };
  return (
    <section className="work" aria-label="Run views">
      <div role="tablist" aria-label="Run views" className="main-tabs" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} id={`main-tab-${t.id}`} type="button" role="tab" aria-selected={active === t.id} aria-controls={`main-panel-${t.id}`} tabIndex={active === t.id ? 0 : -1} onClick={() => onChange(t.id)}>{t.label}</button>
        ))}
      </div>
      <div id={`main-panel-${active}`} role="tabpanel" aria-labelledby={`main-tab-${active}`} className="tab-body">{children}</div>
    </section>
  );
}
