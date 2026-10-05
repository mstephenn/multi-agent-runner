// Unknown values render as "n/a", never NaN / undefined / $0.00.
export const fmtTokens = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "n/a");
export const fmtCost = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "n/a");
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
export const STATUS_ICON: Record<string, string> = { pending: "○", running: "◐", done: "✓", failed: "✕", blocked: "⊘" };
