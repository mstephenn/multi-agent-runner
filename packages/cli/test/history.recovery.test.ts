import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@mar/server";
import { runMain } from "../src/main.js";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const T = (id: string, goal = `do ${id}`) => ({ id, role: "implementer", runtime: "codex", tier: "mid", goal, dependsOn: [], needs: [], paths: [`${id}/**`] }) as never;

function seed(): string {
  const repo = mkdtempSync(join(tmpdir(), "mar-hist-rec-")); tmps.push(repo);
  mkdirSync(join(repo, ".mar"), { recursive: true });
  const s = new Store(join(repo, ".mar", "mar.db"));
  const ev = (run: string, task: string | null, type: Parameters<Store["appendEvent"]>[0]["type"], payload: Record<string, unknown>) => s.appendEvent({ run_id: run, task_id: task, agent_id: task, type, payload });
  // rrecover1: phase 1 failed (dependency merge conflict) with remaining "", recovery phase 2 finished it
  s.createRun("rrecover1", "Nine UI enhancements", repo);
  const p1 = { tasks: [T("p1-a"), T("p1-b"), T("p1-polish")] }, p2 = { tasks: [T("p2-resolve")] };
  s.savePhase("rrecover1", 1, p1, "", "incomplete"); s.savePhase("rrecover1", 2, p2, "", "done"); s.savePlan("rrecover1", { tasks: [...p1.tasks, ...p2.tasks] });
  for (const t of ["p1-a", "p1-b", "p2-resolve"]) s.setTaskStatus("rrecover1", t, "done");
  s.setTaskStatus("rrecover1", "p1-polish", "failed", "dependency p1-b: merge conflict in shared.txt");
  ev("rrecover1", "p1-a", "ownership_violation", { files: ["shared.txt", "styles.css"], count: 2, paths: ["a/**"], enforced: false });
  ev("rrecover1", "p1-b", "ownership_violation", { files: ["shared.txt"], count: 1, paths: ["b/**"], enforced: false });
  // rstalled1: the recovery phase finished nothing
  s.createRun("rstalled1", "Another goal", repo);
  const q1 = { tasks: [T("p1-a"), T("p1-b")] }, q2 = { tasks: [T("p2-fix")] };
  s.savePhase("rstalled1", 1, q1, "", "incomplete"); s.savePhase("rstalled1", 2, q2, "", "incomplete"); s.savePlan("rstalled1", { tasks: [...q1.tasks, ...q2.tasks] });
  s.setTaskStatus("rstalled1", "p1-a", "done"); s.setTaskStatus("rstalled1", "p1-b", "failed", "boom"); s.setTaskStatus("rstalled1", "p2-fix", "failed", "boom again");
  s.close();
  return repo;
}
const repo = seed();

async function mar(args: string[]) {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  const code = await runMain(["history", ...args, "--repo", repo], { history: { columns: 140 } });
  vi.restoreAllMocks();
  return { code, out: out.join("\n") };
}

describe("mar history with recovery phases", () => {
  it("shows a recovered run as done and lists the ownership warnings", async () => {
    const { code, out } = await mar(["rrecover1"]);
    expect(code).toBe(0);
    expect(out).toMatch(/Status:\s+done/);
    expect(out).toContain("dependency p1-b: merge conflict in shared.txt");
    expect(out).toContain("Ownership warnings");
    expect(out).toMatch(/p1-a -> shared\.txt, styles\.css/);
    expect(out).toMatch(/p1-b -> shared\.txt/);
  });
  it("shows a stalled recovery as failed (recovery_stalled), with no ownership block when there are no warnings", async () => {
    const { out } = await mar(["rstalled1"]);
    expect(out).toMatch(/Status:\s+failed \(recovery_stalled\)/);
    expect(out).not.toContain("Ownership warnings");
  });
  it("the list shows the recovered run as done", async () => {
    const { out } = await mar([]);
    expect(out).toMatch(/rrecover1.*done/);
    expect(out).toMatch(/rstalled1.*failed/);
  });
});
