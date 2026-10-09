import { afterEach, describe, expect, it } from "vitest";
import { parseDag } from "@mar/core";
import { Store } from "../../server/src/store.js";
import { runDag, type RunDeps } from "../src/scheduler.js";
import { fakeAdapter, ok, type Script } from "./fakeAdapter.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function harness(script: Script, options: Partial<RunDeps> = {}) {
  const store = new Store(":memory:"); stores.push(store); store.createRun("r", "g", "/repo");
  const claude = fakeAdapter(script);
  const codex = fakeAdapter(script, "codex");
  const deps: RunDeps = {
    store, runId: "r", repo: "/repo",
    dag: parseDag({ tasks: [{ id: "a", role: "implementer", runtime: "claude", tier: "low", goal: "A" }] }),
    adapters: { claude: claude.adapter, codex: codex.adapter },
    worktrees: { create: async () => "/wt/a", commit: async () => {}, remove: async () => {} },
    modelFor: (_runtime, tier) => tier, toolsFor: () => ["Read"], concurrency: 1,
    maxRetries: 2, ...options,
  };
  return { store, claude, codex, deps, events: () => store.listEvents("r") };
}

describe("heal controls and task event attempts", () => {
  it.each([{ maxRetries: 2 }, { maxAttempts: 3, maxRetries: undefined }])("disabled healing overrides retry settings %j", async (options) => {
    const h = harness(() => new Error("failure"), { ...options, healEnabled: false });
    expect(await runDag(h.deps)).toEqual({ a: "failed" });
    expect(h.claude.calls).toHaveLength(1);
    expect(h.events().some((e) => e.type.startsWith("heal_") || e.type === "task_retry")).toBe(false);
    expect(h.events().find((e) => e.type === "task_failed")?.payload.attempt).toBe(1);
  });

  it.each(["low", "high"] as const)("can disable tier and runtime escalation at %s", async (tier) => {
    const h = harness((_input, n) => n < 3 ? new Error("failure") : ok(), { escalateOnRetry: false });
    h.deps.dag.tasks[0].tier = tier;
    expect(await runDag(h.deps)).toEqual({ a: "done" });
    expect(h.claude.calls.map((c) => c.model)).toEqual([tier, tier, tier]);
    expect(h.codex.calls).toHaveLength(0);
    expect(h.events().filter((e) => e.type === "task_retry").map((e) => e.payload.escalated)).toEqual([false, false]);
  });

  it("pairs each retry with heal success/failure and labels task events", async () => {
    const h = harness((_input, n) => n < 3 ? new Error("failure") : ok());
    expect(await runDag(h.deps)).toEqual({ a: "done" });
    expect(h.events().filter((e) => e.type.startsWith("heal_")).map((e) => [e.type, e.payload.attempt])).toEqual([
      ["heal_started", 2], ["heal_failed", 2], ["heal_started", 3], ["heal_finished", 3],
    ]);
    expect(h.events().filter((e) => e.type === "prompt_sent").map((e) => e.payload.attempt)).toEqual([1, 2, 3]);
    expect(h.events().find((e) => e.type === "task_started")?.payload.attempt).toBe(1);
    expect(h.events().find((e) => e.type === "task_finished")?.payload.attempt).toBe(3);
    expect(h.events().filter((e) => e.type === "blackboard_write").every((e) => e.payload.attempt === 3)).toBe(true);
    expect(h.events().every((e) => Number.isInteger(e.payload.attempt) && Number(e.payload.attempt) > 0)).toBe(true);
  });

  it("closes the final failed retry before task_failed and redacts reasons", async () => {
    const h = harness(() => new Error("api_key=secret-value"), { maxRetries: 1 });
    expect(await runDag(h.deps)).toEqual({ a: "failed" });
    const events = h.events().filter((e) => e.type.startsWith("heal_") || e.type === "task_failed");
    expect(events.map((e) => [e.type, e.payload.attempt])).toEqual([["heal_started", 2], ["heal_failed", 2], ["task_failed", 2]]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("keeps late output from a timed-out adapter on its original attempt", async () => {
    const h = harness(() => ok(), { maxRetries: 1, escalateOnRetry: false, taskTimeoutMs: 10 });
    let calls = 0;
    let emitLate: () => void = () => {};
    let lateDone: () => void = () => {};
    const late = new Promise<void>((resolve) => { lateDone = resolve; });
    h.deps.adapters.claude = {
      runtime: "claude",
      async *run() {
        if (++calls === 1) {
          await new Promise<void>((resolve) => { emitLate = resolve; });
          yield { type: "assistant_text", text: "late first attempt" };
          lateDone();
          return;
        }
        emitLate();
        await late;
        yield* ok();
      },
    };
    expect(await runDag(h.deps)).toEqual({ a: "done" });
    expect(h.events().find((e) => e.type === "assistant_text")?.payload.attempt).toBe(1);
    expect(h.events().find((e) => e.type === "task_finished")?.payload.attempt).toBe(2);
  });

  it.each([0, 2])("does not emit heal events when no retry occurs (maxRetries=%i)", async (maxRetries) => {
    const h = harness(() => maxRetries === 0 ? new Error("failure") : ok(), { maxRetries });
    await runDag(h.deps);
    expect(h.events().filter((e) => e.type.startsWith("heal_"))).toEqual([]);
  });
});
