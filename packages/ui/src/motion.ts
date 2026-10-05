// All UI animation goes through here (anime.js). Every helper is a no-op under `prefers-reduced-motion: reduce`
// (and outside a browser) and returns a `stop` function, so callers can always clean up in an effect.
import { animate, stagger } from "animejs";

export type Stop = () => void;
const noop: Stop = () => {};

export const reducedMotion = (): boolean =>
  typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Run an animation, then drop the inline styles anime left behind so CSS stays the source of truth. */
const run = (el: Element | Element[], props: Parameters<typeof animate>[1], clear: string[]): Stop => {
  const els = Array.isArray(el) ? el : [el];
  const done = () => { for (const e of els) if (e instanceof HTMLElement) for (const p of clear) e.style.removeProperty(p); };
  const a = animate(els, { ...props, onComplete: done });
  return () => { a.cancel(); done(); };
};

/** Drawer slides in from the right. */
export function drawerIn(el: Element | null): Stop {
  if (!el || reducedMotion()) return noop;
  return run(el, { translateX: [48, 0], opacity: [0, 1], duration: 320, ease: "outCubic" }, ["transform", "opacity"]);
}

/** A graph node pops in the first time it appears. */
export function nodeIn(el: Element | null): Stop {
  if (!el || reducedMotion()) return noop;
  return run(el, { opacity: [0, 1], scale: [0.9, 1], translateY: [10, 0], duration: 420, ease: "outBack" }, ["transform", "opacity"]);
}

/** A short attention pulse when a node's status changes. */
export function statusFlash(el: Element | null): Stop {
  if (!el || reducedMotion()) return noop;
  return run(el, { scale: [1.06, 1], duration: 380, ease: "outElastic(1, .6)" }, ["transform"]);
}

/** Endless soft ring on a running node; call the returned stop when it stops running. */
export function pulseRing(el: Element | null): Stop {
  if (!el || reducedMotion()) return noop;
  const a = animate(el, { scale: [1, 1.16], opacity: [0.55, 0], duration: 1500, ease: "outQuad", loop: true });
  return () => { a.cancel(); if (el instanceof HTMLElement) { el.style.removeProperty("transform"); el.style.removeProperty("opacity"); } };
}

/** Newly appended list rows slide up and fade in. */
export function rowsIn(rows: Element[]): Stop {
  if (rows.length === 0 || reducedMotion()) return noop;
  return run(rows, { translateY: [10, 0], opacity: [0, 1], duration: 260, ease: "outQuad", delay: stagger(30) }, ["transform", "opacity"]);
}

/** Tween a number; `onValue` receives whole-number steps. Snaps straight to `to` under reduced motion. */
export function countTo(from: number, to: number, onValue: (n: number) => void): Stop {
  if (reducedMotion() || from === to) { onValue(to); return noop; }
  const o = { v: from };
  const a = animate(o, { v: to, duration: 600, ease: "outExpo", onUpdate: () => onValue(Math.round(o.v)), onComplete: () => onValue(to) });
  return () => { a.cancel(); onValue(to); };
}
