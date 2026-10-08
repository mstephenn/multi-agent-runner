import { describe, expect, it } from "vitest";
import type { Dag } from "@mar/core";
import { deriveUseCases } from "../src/useCases.js";
import type { AgentView } from "../src/derive.js";

const ag = (id: string, status: AgentView["status"]): AgentView => ({ id, status, tokens: null, costUsd: null, unsafe: false });
const task = (id: string, useCases?: string[]) => ({ id, role: "implementer" as const, runtime: "claude" as const, tier: "mid" as const, goal: "g", dependsOn: [], needs: [], paths: [], ...(useCases ? { useCases } : {}) });
const plan: Dag = {
  tasks: [task("a", ["uc-1"]), task("b", ["uc-1", "uc-2"]), task("c", ["uc-3"]), task("d")],
  useCases: [{ id: "uc-1", title: "One" }, { id: "uc-2", title: "Two" }, { id: "uc-3", title: "Three" }, { id: "uc-4", title: "Four" }],
};

describe("deriveUseCases", () => {
  it("rolls task statuses up per use case", () => {
    const b = deriveUseCases(plan, [ag("a", "done"), ag("b", "running"), ag("c", "failed"), ag("d", "pending")]);
    const by = Object.fromEntries(b.cases.map((c) => [c.id, c]));
    expect(by["uc-1"]).toMatchObject({ status: "running", progress: 0.5 });
    expect(by["uc-2"]!.tasks.map((t) => t.id)).toEqual(["b"]);
    expect(by["uc-3"]!.status).toBe("failed");
    expect(by["uc-4"]).toMatchObject({ status: "uncovered", progress: 0 });
    expect(b.unassigned.map((t) => t.id)).toEqual(["d"]);
  });
  it("is done only when every task is done", () => {
    const b = deriveUseCases(plan, [ag("a", "done"), ag("b", "done"), ag("c", "pending"), ag("d", "done")]);
    expect(b.cases.find((c) => c.id === "uc-1")!.status).toBe("done");
    expect(b.cases.find((c) => c.id === "uc-3")!.status).toBe("pending");
  });
  it("handles no plan / no use cases", () => {
    expect(deriveUseCases(null, [])).toEqual({ cases: [], unassigned: [] });
  });
});
