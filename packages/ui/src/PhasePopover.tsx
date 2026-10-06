import { useEffect, useId, useRef, useState } from "react";
import type { PhaseInfo } from "./derive.js";

export function PhasePopover({ phase, history = [] }: { phase: PhaseInfo; history?: PhaseInfo[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="phase" ref={root} data-testid="phase-indicator" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <span className="badge phase-badge">Phase {phase.phase}{phase.maxPhases !== null ? `/${phase.maxPhases}` : ""}</span>
    <button ref={trigger} type="button" className="phase-remaining" data-testid="phase-remaining" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{phase.remaining || "This phase completes the goal"}</button>
    {open && <section id={id} className="phase-popover" aria-label="Remaining work and phase history">
      <strong>Remaining work after phase {phase.phase}</strong>
      <p>{phase.remaining || "This phase completes the goal"}</p>
      <strong>Phase history</strong>
      <ol>{(history.length ? history : [phase]).map((entry, index) => <li key={index}><strong>Phase {entry.phase}</strong><p>{entry.remaining || "This phase completes the goal"}</p></li>)}</ol>
      <button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Close</button>
    </section>}
  </div>;
}
