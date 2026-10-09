import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbEntry, TaskResult } from "@mar/core";
import { loadKnowledge, mergeKnowledge, readEntry, refreshKnowledge, updateKnowledge } from "../src/index.js";

const roots: string[] = [];
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "kb-update-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  return root;
};
const result = (changes: Partial<TaskResult> = {}): TaskResult => ({ summary: "Added a build command", filesChanged: [], decisions: [], openQuestions: [], ...changes });
const bb = (key: string, kind: BbEntry["kind"], body: string, version = 1, refs: string[] = []): BbEntry => ({ id: version, run_id: "run", author_task: key.split("/")[0]!, key, kind, body, version, refs, ts: version });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("post-run knowledge update", () => {
  it("skips empty and summary-only results without rewriting the index", () => {
    const kb = loadKnowledge(repo(), { now: () => 1 });
    const before = readFileSync(join(kb.dir, "index.json"), "utf8");
    expect(updateKnowledge(kb, [], [], { now: () => 2 }).skipped).toBe(true);
    expect(updateKnowledge(kb, [{ taskId: "read", result: result() }]).skipped).toBe(true);
    expect(updateKnowledge(kb, [{ taskId: "kb", result: result({ filesChanged: [".mar/knowledge/stack.md"] }) }]).skipped).toBe(true);
    expect(readFileSync(join(kb.dir, "index.json"), "utf8")).toBe(before);
  });

  it("rescans changed files, retains task knowledge, and skips an identical replay", () => {
    const root = repo();
    const kb = refreshKnowledge(root, { now: () => 1 }).kb;
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const tasks = [{ taskId: "build", result: result({ filesChanged: ["package.json"], decisions: ["Compile with tsc"] }) }];
    const first = updateKnowledge(kb, tasks, [], { now: () => 2 });
    expect(first.updated).toContain("commands");
    expect(readEntry(kb, "commands")).toContain("npm run build");
    const taskId = first.added.find((id) => id.startsWith("task-"))!;
    expect(readEntry(kb, taskId)).toContain("Compile with tsc");
    expect(readEntry(kb, taskId)).toContain("package.json");
    const before = readFileSync(join(kb.dir, "index.json"), "utf8");
    expect(updateKnowledge(kb, tasks, [], { now: () => 3 }).skipped).toBe(true);
    expect(readFileSync(join(kb.dir, "index.json"), "utf8")).toBe(before);
    const changed = updateKnowledge(kb, [{ taskId: "build", result: result({ decisions: ["Compile with strict mode"] }) }], [], { now: () => 4 });
    expect(changed.updated).toContain(taskId);
    expect(kb.index.entries.find((e) => e.id === taskId)?.createdAt).toBe(2);
    expect(readEntry(kb, taskId)).toContain("Compile with strict mode");
  });

  it("uses latest completed-task blackboard values, supports artifact refs, and redacts", () => {
    const kb = loadKnowledge(repo());
    const entries = [
      bb("done/decisions", "decision", "- obsolete"),
      bb("done/decisions", "decision", "- Use --token=sk-abcdefghijklmnop", 2),
      bb("done/summary", "summary", "Adopted the new build"),
      bb("done/files", "artifact_ref", "30 files changed; see refs", 1, ["package.json"]),
      bb("failed/decisions", "decision", "- Never retain failed work"),
    ];
    const updated = updateKnowledge(kb, [{ taskId: "done", result: result() }], entries);
    const text = readEntry(kb, updated.added.find((id) => id.startsWith("task-"))!)!;
    expect(text).toContain("Adopted the new build");
    expect(text).toContain("package.json");
    expect(text).not.toContain("obsolete");
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("failed work");
    expect(updateKnowledge(kb, [{ taskId: "done", result: result({ decisions: ["stale fallback"] }) }], [bb("done/decisions", "decision", "(none)")]).skipped).toBe(true);
  });

  it("preserves manual entries, hand edits, and unrelated existing knowledge", () => {
    const kb = refreshKnowledge(repo()).kb;
    mergeKnowledge(kb, [{ id: "custom", section: "conventions", title: "Custom", body: "Keep me" }]);
    const tasks = [{ taskId: "decision", result: result({ decisions: ["Use modules"] }) }];
    const first = updateKnowledge(kb, tasks);
    const id = first.added[0]!;
    writeFileSync(join(kb.dir, `${id}.md`), "# Hand edited\n");
    const second = updateKnowledge(kb, tasks);
    expect(second.preserved).toContain(id);
    expect(second.preserved).toContain("custom");
    expect(kb.index.entries.find((e) => e.id === id)?.source).toBe("manual");
    expect(readEntry(kb, id)).toBe("# Hand edited\n");
    expect(readEntry(kb, "custom")).toContain("Keep me");
    expect(updateKnowledge(kb, tasks).skipped).toBe(true);
  });
});
