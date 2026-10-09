import { describe, expect, it } from "vitest";
import { EventTypes, TaskSpec, type NewEvent } from "../src/index.js";

const task = { id: "writer", role: "implementer", runtime: "claude", tier: "low", goal: "fix" };

describe("self-heal schemas", () => {
  it("registers heal lifecycle events", () => {
    for (const type of ["heal_started", "heal_finished", "heal_failed"] as const) {
      expect(EventTypes).toContain(type);
      const event: NewEvent = { run_id: "run", task_id: "writer", agent_id: null, type, payload: { attempt: 2 } };
      expect(event.payload.attempt).toBe(2);
    }
    expect(new Set(EventTypes).size).toBe(EventTypes.length);
  });
  it("preserves an optional one-based attempt without changing existing tasks", () => {
    expect(TaskSpec.parse(task).attempt).toBeUndefined();
    expect(TaskSpec.parse({ ...task, attempt: 1 }).attempt).toBe(1);
    expect(TaskSpec.parse({ ...task, attempt: 3 }).attempt).toBe(3);
  });
  it.each([0, -1, 1.5, "1", null, Infinity, NaN])("rejects invalid attempt %j", (attempt) => {
    expect(TaskSpec.safeParse({ ...task, attempt }).success).toBe(false);
  });
});
