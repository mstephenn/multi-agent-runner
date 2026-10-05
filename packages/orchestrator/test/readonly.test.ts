import { describe, it, expect } from "vitest";
import type { TaskSpec } from "@mar/core";
import { isReadOnlyTask, usesSharedWorktree, WRITER_ROLES } from "../src/readonly.js";

const T = (id: string, role: string, dependsOn: string[] = []) => ({ id, role, runtime: "claude", tier: "low", goal: "g", dependsOn, needs: [] }) as unknown as TaskSpec;
const map = (...ts: TaskSpec[]) => new Map(ts.map((t) => [t.id, t]));
const ro = (ts: TaskSpec[], id: string) => isReadOnlyTask(ts.find((t) => t.id === id)!, map(...ts));

describe("isReadOnlyTask", () => {
  it("writer roles are implementer and tester", () => { expect([...WRITER_ROLES].sort()).toEqual(["implementer", "tester"]); });
  it("researcher-only DAG is read-only", () => {
    const ts = [T("a", "researcher"), T("b", "researcher", ["a"])];
    expect(ts.map((t) => ro(ts, t.id))).toEqual([true, true]);
  });
  it("implementer and tester are not", () => {
    const ts = [T("i", "implementer"), T("t", "tester")];
    expect([ro(ts, "i"), ro(ts, "t")]).toEqual([false, false]);
  });
  it("reviewer depending on implementer is not; a plain reviewer is", () => {
    const ts = [T("i", "implementer"), T("r", "reviewer", ["i"]), T("r2", "reviewer")];
    expect([ro(ts, "r"), ro(ts, "r2")]).toEqual([false, true]);
  });
  it("researcher via reviewer via implementer (transitive) is not", () => {
    const ts = [T("i", "implementer"), T("r", "reviewer", ["i"]), T("s", "researcher", ["r"])];
    expect(ro(ts, "s")).toBe(false);
  });
  it("cycles and unknown dependencies terminate", () => {
    const ts = [T("a", "researcher", ["b", "ghost"]), T("b", "researcher", ["a"])];
    expect(ro(ts, "a")).toBe(true);
    const cyc = [T("a", "researcher", ["b"]), T("b", "reviewer", ["a", "w"]), T("w", "implementer")];
    expect(ro(cyc, "a")).toBe(false);
  });
});

describe("usesSharedWorktree", () => {
  const t = T("a", "researcher");
  it("read-only role with read tools shares", () => { expect(usesSharedWorktree(t, map(t), () => ["Read", "Grep"])).toBe(true); });
  it.each(["Edit", "Write", "Bash"])("a role with %s never shares", (tool) => {
    expect(usesSharedWorktree(t, map(t), () => ["Read", tool])).toBe(false);
  });
});
