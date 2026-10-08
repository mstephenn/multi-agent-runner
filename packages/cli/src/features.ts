import type { Store } from "@mar/server";

/**
 * Features the user added to a run (`feature_requested` events) that no stored phase has folded into its plan yet.
 * Used on resume, so requests queued before a stop or crash are not lost. A request counts as planned when it came
 * before the latest `phase_started`, or its text is already in the latest stored phase's remaining work.
 */
export function pendingFeatures(store: Store, runId: string): string[] {
  const events = store.listEvents(runId);
  const lastPhaseStart = events.filter((e) => e.type === "phase_started").at(-1)?.id ?? 0;
  const remaining = store.listPhases(runId).at(-1)?.remaining ?? "";
  return events
    .filter((e) => e.type === "feature_requested" && e.id > lastPhaseStart)
    .flatMap((e) => (typeof e.payload.text === "string" ? [e.payload.text] : []))
    .filter((t) => !remaining.includes(t));
}
