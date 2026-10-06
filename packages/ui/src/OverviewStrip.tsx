import { useEffect, useRef, useState } from "react";
import { countTo } from "./motion.js";
import type { RunOverview } from "./derive.js";
import { budgetUsage, fmtCost, fmtDuration, fmtTokens } from "./fmt.js";

export function OverviewStrip({ overview, partial = false, hasUsage = true }: { overview: RunOverview; partial?: boolean; hasUsage?: boolean }) {
  const [shownTokens, setShownTokens] = useState(overview.tokens);
  const previous = useRef(overview.tokens);
  useEffect(() => {
    const from = previous.current;
    previous.current = overview.tokens;
    return countTo(from, overview.tokens, setShownTokens);
  }, [overview.tokens]);
  const usage = budgetUsage(hasUsage ? overview.tokens : null, overview.maxTotalTokens ?? undefined);
  const lead = partial ? "≥ " : "";
  return <>
    <dl className="stats overview-strip" aria-label="Run overview">
      <div><dt>Cost{partial ? " (partial)" : ""}</dt><dd className="mono" data-testid="total-cost">{overview.costUsd === null ? "n/a" : `${lead}${fmtCost(overview.costUsd)}`}</dd></div>
      <div><dt>Token budget{partial ? " (partial)" : ""}</dt><dd className="mono"><span data-testid="total-tokens">{hasUsage ? `${lead}${fmtTokens(shownTokens)}` : "n/a"}</span> / {overview.maxTotalTokens === null ? "limit unknown" : fmtTokens(overview.maxTotalTokens)}
        {usage && <><span className={usage.over ? "budget-over" : "muted"}> ({partial ? "≥ " : ""}{usage.pct}%)</span><progress aria-label="Token budget used" max={100} value={Math.min(100, usage.pct)} /></>}
      </dd></div>
      <div><dt>ETA (remaining)</dt><dd className="mono" title="Serial estimate from completed tasks; excludes unknown future phases">{partial ? "n/a" : fmtDuration(overview.etaMs)}</dd></div>
    </dl>
    {overview.limitStopReason !== null && <div className="banner limit-stop" role="alert" data-testid="limit-stop-banner"><strong>Run stopped — limit reached.</strong> {overview.limitStopReason}</div>}
  </>;
}
