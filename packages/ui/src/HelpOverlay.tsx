import { useEffect, useRef } from "react";
import { SHORTCUTS } from "./shortcuts.js";

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="help-backdrop" onClick={onClose}>
      <section className="help" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="help-title">Keyboard shortcuts</h2>
        <dl>
          {SHORTCUTS.map((s) => <div key={s.action}><dt><kbd>{s.keys}</kbd></dt><dd>{s.label}</dd></div>)}
        </dl>
        <button ref={close} type="button" onClick={onClose}>Close</button>
      </section>
    </div>
  );
}
