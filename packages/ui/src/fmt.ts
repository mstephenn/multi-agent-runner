// Unknown values render as "n/a", never NaN / undefined / $0.00.
export const fmtTokens = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "n/a");
export const fmtCost = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "n/a");
export function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "n/a";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
export const STATUS_ICON: Record<string, string> = { pending: "○", running: "◐", done: "✓", failed: "✕", blocked: "⊘" };
// Budget usage: the bar is capped at 100 but the percentage and `over` flag are not.
export function budgetUsage(tokens: number | null, budget: number | undefined): { pct: number; over: boolean } | null {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0 || budget === undefined || !Number.isFinite(budget) || budget <= 0) return null;
  const pct = Math.round((tokens / budget) * 100);
  return { pct, over: tokens > budget };
}
// Header cost: two decimals ("$0.14"); a sub-cent amount reads "<$0.01" rather than a misleading "$0.00".
export const fmtCostShort = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`) : "n/a");
// "~2 min left"; unknown (null / not finite) is "ETA n/a"; nothing left is "" so callers can drop the segment.
export function fmtEtaLeft(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "ETA n/a";
  if (ms <= 0) return "";
  if (ms < 60_000) return "<1 min left";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `~${min} min left`;
  const h = Math.floor(min / 60), m = min % 60;
  return `~${h}h${m ? ` ${m}m` : ""} left`;
}
