import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/src/store.js";
import { fakeAdapter } from "../../orchestrator/test/fakeAdapter.js";
import { executeRun } from "../src/main.js";
import { loadConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const enabled of [true, false]) it(`KB lifecycle with kbEnabled=${enabled}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "mar-kb-run-")); roots.push(root);
  writeFileSync(join(root, ".mar.json"), JSON.stringify({ kbEnabled: enabled }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "kb-fixture", scripts: { test: "vitest" } }));
  const checkout = mkdtempSync(join(tmpdir(), "mar-kb-checkout-")); roots.push(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ scripts: { test: "verified-checkout-command" } }));
  const store = new Store(":memory:");
  const adapter = fakeAdapter((input) => [{ type: "result", text: JSON.stringify(input.taskId === "planner"
    ? { tasks: [{ id: "p1-a", role: "implementer", runtime: "claude", tier: "mid", goal: "A" }, { id: "p1-b", role: "implementer", runtime: "claude", tier: "mid", goal: "B", dependsOn: ["p1-a"] }] }
    : { summary: "Completed", filesChanged: ["package.json"], decisions: ["Use the fixture convention"], openQuestions: [] }) }]);
  let removed = 0;
  const opts = { repo: root, goal: "test", store, config: loadConfig(root), adapters: { claude: adapter.adapter, codex: adapter.adapter },
    repoMapFn: () => "package.json", worktrees: { create: async () => checkout, commit: async () => {}, remove: async () => { removed++; } } };
  try {
    const run = await executeRun(opts);
    expect(run.results).toEqual({ "p1-a": "done", "p1-b": "done" });
    expect(removed).toBe(2);
    for (const call of adapter.calls) expect(call.prompt.includes("# Repository knowledge base")).toBe(enabled);
    if (enabled) {
      expect(adapter.calls.find((call) => call.taskId === "p1-b")!.prompt).toContain("Use the fixture convention");
      expect(readFileSync(join(root, ".mar/knowledge/commands.md"), "utf8")).toContain("verified-checkout-command");
      expect(existsSync(join(checkout, ".mar/knowledge"))).toBe(false);
      const index = JSON.parse(readFileSync(join(root, ".mar/knowledge/index.json"), "utf8"));
      expect(index.entries.filter((entry: { id: string }) => entry.id.startsWith("task-"))).toHaveLength(2);
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "resume-command" } }));
      await executeRun({ ...opts, runId: run.runId });
      expect(readFileSync(join(root, ".mar/knowledge/commands.md"), "utf8")).toContain("resume-command");
    } else expect(existsSync(join(root, ".mar/knowledge"))).toBe(false);
  } finally { store.close(); }
});

it("enables KB by default and rejects nonboolean toggles", () => {
  const root = mkdtempSync(join(tmpdir(), "mar-kb-config-")); roots.push(root);
  expect(loadConfig(root).kbEnabled).toBe(true);
  writeFileSync(join(root, ".mar.json"), '{"kbEnabled":"false"}');
  expect(() => loadConfig(root)).toThrow(/kbEnabled/);
});
