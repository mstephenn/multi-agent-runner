import { describe, it, expect } from "vitest";
import { Store } from "@mar/server";
import { pendingFeatures } from "../src/features.js";

const ev = (s: Store, type: "feature_requested" | "phase_started", payload: Record<string, unknown> = {}) =>
  s.appendEvent({ run_id: "r", task_id: null, agent_id: null, type, payload });

describe("pendingFeatures", () => {
  it("returns requests made after the last phase start, in order", () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    ev(s, "feature_requested", { text: "old" }); ev(s, "phase_started"); ev(s, "feature_requested", { text: "a" }); ev(s, "feature_requested", { text: "b" });
    expect(pendingFeatures(s, "r")).toEqual(["a", "b"]);
  });
  it("skips requests already folded into the latest stored phase's remaining work", () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    ev(s, "phase_started"); ev(s, "feature_requested", { text: "dark mode" }); ev(s, "feature_requested", { text: "alerts" });
    s.savePhase("r", 1, { tasks: [] }, "left\n- dark mode", "planned");
    expect(pendingFeatures(s, "r")).toEqual(["alerts"]);
  });
});
