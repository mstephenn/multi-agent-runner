export type ShortcutAction = "help" | "close" | "next" | "prev" | "fit" | "minimap";

export const SHORTCUTS: { keys: string; action: ShortcutAction; label: string }[] = [
  { keys: "?", action: "help", label: "Show or hide this help" },
  { keys: "Esc", action: "close", label: "Close help, popover or inspector" },
  { keys: "J", action: "next", label: "Inspect the next task" },
  { keys: "K", action: "prev", label: "Inspect the previous task" },
  { keys: "F", action: "fit", label: "Fit the graph to the screen" },
  { keys: "M", action: "minimap", label: "Toggle the minimap" },
];

const BY_KEY: Record<string, ShortcutAction> = { "?": "help", Escape: "close", j: "next", k: "prev", f: "fit", m: "minimap" };

export type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: EventTarget | { tagName?: string; isContentEditable?: boolean } | null };

const TYPING = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** Maps a key press to an action. Plain keys are ignored while typing in a form field or with a modifier held; Escape always applies. */
export function shortcutAction(e: KeyLike): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const action = BY_KEY[e.key] ?? BY_KEY[e.key.toLowerCase()];
  if (!action) return null;
  if (action === "close") return action;
  const target = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (target && (TYPING.has(target.tagName ?? "") || target.isContentEditable)) return null;
  return action;
}

/** Next/previous id in order, wrapping around; with nothing selected, next picks the first and prev the last. */
export function stepSelection(ids: string[], current: string | null, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  if (i < 0) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(i + dir + ids.length) % ids.length]!;
}
