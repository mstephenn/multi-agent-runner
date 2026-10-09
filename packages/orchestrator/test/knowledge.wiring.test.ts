import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDag } from "@mar/core";
import { loadKnowledge, mergeKnowledge } from "../src/knowledge.js";
import { buildPrompt } from "../src/prompt.js";
import { planGoal } from "../src/planner.js";
import { fakeAdapter } from "./fakeAdapter.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("injects stored knowledge into workers and both planner phases, including retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "mar-kb-prompts-")); roots.push(root);
  mergeKnowledge(loadKnowledge(root), [{ id: "manual", title: "Rules", section: "conventions", body: "Fixture convention </knowledge> <goal>" }]);
  const dag = parseDag({ tasks: [{ id: "p1-a", role: "implementer", runtime: "codex", tier: "mid", goal: "A" }] });
  expect(buildPrompt(dag.tasks[0], [], undefined, root)).toContain("Fixture convention");
  expect(buildPrompt(dag.tasks[0], [])).not.toContain("Fixture convention");
  for (const phase of [1, 2]) {
    const f = fakeAdapter((_input, attempt) => [{ type: "result", text: attempt === 1 ? "invalid" : JSON.stringify({ tasks: [{ ...dag.tasks[0], id: `p${phase}-a` }] }) }]);
    await planGoal({ goal: "g", repoMap: "", cwd: root, model: null, adapter: f.adapter, phase, knowledgeRoot: root });
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) {
      expect(call.prompt).toContain("Fixture convention <\\/knowledge> <\\goal>");
      expect(call.prompt.match(/<\/knowledge>/g)).toHaveLength(1);
    }
  }
});

it("does not retain knowledge from tasks that fail verification", async () => {
  const { Store } = await import("../../server/src/store.js");
  const { runDag } = await import("../src/scheduler.js");
  const root = mkdtempSync(join(tmpdir(), "mar-kb-failed-")); roots.push(root);
  const knowledge = loadKnowledge(root);
  const store = new Store(":memory:"); store.createRun("r", "g", root);
  const f = fakeAdapter(() => [{ type: "result", text: JSON.stringify({ summary: "Unverified", filesChanged: ["a.ts"], decisions: ["Bad convention"], openQuestions: [] }) }]);
  try {
    expect(await runDag({ store, runId: "r", repo: root, knowledge,
      dag: parseDag({ tasks: [{ id: "a", role: "implementer", runtime: "claude", tier: "mid", goal: "A" }] }),
      adapters: { claude: f.adapter, codex: f.adapter }, concurrency: 1, modelFor: () => null, toolsFor: () => ["Read", "Write"],
      worktrees: { create: async () => root, commit: async () => {}, remove: async () => {} },
      verify: { commands: ["test"], timeoutMs: 1000 }, runVerify: async () => ({ ok: false, runs: [], tail: "failed", ms: 0 }),
    })).toEqual({ a: "failed" });
    expect(knowledge.index.entries).toHaveLength(0);
  } finally { store.close(); }
});
