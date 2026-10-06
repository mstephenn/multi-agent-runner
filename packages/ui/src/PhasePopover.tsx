import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import type { PhaseInfo } from "./derive.js";
import { useDismiss } from "./usePopover.js";

/** The header status line from the phase badge on: `children` are the remaining summary segments; the remaining-work text (last) opens the popover. */
export function PhasePopover({ phase, history = [], children }: { phase: PhaseInfo; history?: PhaseInfo[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root, trigger);
  const remaining = phase.remaining || "This phase completes the goal";
  return <div className="phase" ref={root} data-testid="phase-indicator" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <span className="phase-badge">Phase {phase.phase}{phase.maxPhases !== null ? `/${phase.maxPhases}` : ""}</span>
    {children}
    <button ref={trigger} type="button" className="phase-remaining" data-testid="phase-remaining" title={`Remaining work: ${remaining}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{remaining}</button>
    {open && <section id={id} className="popover phase-popover" aria-label="Remaining work and phase history">
      <strong>Remaining work after phase {phase.phase}</strong>
      <p>{remaining}</p>
      <strong>Phase history</strong>
      <ol>{(history.length ? history : [phase]).map((entry, index) => <li key={index}><strong>Phase {entry.phase}</strong><p>{entry.remaining || "This phase completes the goal"}</p></li>)}</ol>
      <button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Close</button>
    </section>}
  </div>;
}
