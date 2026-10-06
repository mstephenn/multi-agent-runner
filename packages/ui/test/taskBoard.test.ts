import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@mar/core";
import { chipCounts, deriveAnswer, deriveNowText, deriveNowTexts, deriveProblems, deriveRunState, firstSentence, groupBoard, phaseSummary, reasonText, summarizeRun } from "../src/taskBoard.js";
import { deriveAgents, derivePhase, deriveRunOverview, type AgentView } from "../src/derive.js";
import { fmtCostShort, fmtEtaLeft } from "../src/fmt.js";
import { failedRun, workspaceRun } from "./fixtures/board.js";

const NOW = 1_800_000_000_000;
const ag = (id: string, status: AgentView["status"], extra: Partial<AgentView> = {}): AgentView => ({ id, status, tokens: null, costUsd: null, unsafe: false, ...extra });
const ev = (id: number, task: string | null, type: string, payload: Record<string, unknown> = {}, ts = id * 1000): StoredEvent => ({ id, run_id: "r", task_id: task, agent_id: task, ts, type: type as StoredEvent["type"], payload });

describe("fmtEtaLeft / fmtCostShort", () => {
  it("never prints NaN and says n/a for unknowns", () => {
    expect(fmtEtaLeft(null)).toBe("ETA n/a");
    expect(fmtEtaLeft(Number.NaN)).toBe("ETA n/a");
    expect(fmtEtaLeft(Infinity)).toBe("ETA n/a");
    expect(fmtEtaLeft(0)).toBe("");
    expect(fmtEtaLeft(20_000)).toBe("<1 min left");
    expect(fmtEtaLeft(125_000)).toBe("~2 min left");
    expect(fmtEtaLeft(3_900_000)).toBe("~1h 5m left");
    expect(fmtEtaLeft(3_600_000)).toBe("~1h left");
    expect(fmtCostShort(0.14)).toBe("$0.14");
    expect(fmtCostShort(0.004)).toBe("<$0.01");
    expect(fmtCostShort(null)).toBe("n/a");
  });
});

describe("deriveRunState + summarizeRun", () => {
  const phase = { phase: 2, maxPhases: 5, remaining: "docs" };
  it("builds the live status line from existing data", () => {
    const { snap } = workspaceRun(NOW);
    const agents = deriveAgents(snap.events, snap.tasks, snap.plan);
    const state = deriveRunState({ agents, phase: derivePhase(snap.events), active: true, live: true });
    const overview = deriveRunOverview(snap.events, agents, NOW);
    expect(state.kind).toBe("running");
    const s = summarizeRun({ agents, phase: derivePhase(snap.events), state, costUsd: overview.costUsd, etaMs: overview.etaMs });
    expect(s.parts.slice(0, 4)).toEqual(["Phase 2/5", "4 of 6 done", "2 running", "$0.14"]);
    expect(s.text).toMatch(/^Phase 2\/5 · 4 of 6 done · 2 running · \$0\.14 · ~\d+ min left$/);
    expect(summarizeRun({ agents, phase: null, state, costUsd: 0.14, etaMs: 0 }).parts.at(-1)).toBe("finishing up");
  });
  it("shows n/a honestly for unknown cost and ETA", () => {
    const agents = [ag("a", "running")];
    const s = summarizeRun({ agents, phase: null, state: { kind: "running", label: "Running" }, costUsd: null, etaMs: null });
    expect(s.text).toBe("0 of 1 done · 1 running · cost n/a · ETA n/a");
    expect(s.text).not.toMatch(/NaN|undefined/);
    expect(summarizeRun({ agents, phase: null, state: { kind: "running", label: "Running" }, costUsd: 0.5, etaMs: 60_000, partial: true }).text).toBe("0 of 1 done · 1 running · ≥ $0.50 · ETA n/a");
  });
  it("replaces the ETA with Done / Failed / Stopped once the run ended", () => {
    const done = [ag("a", "done")];
    expect(deriveRunState({ agents: done, phase: null, active: false, live: true })).toEqual({ kind: "done", label: "Done" });
    expect(summarizeRun({ agents: done, phase: null, state: { kind: "done", label: "Done" }, costUsd: 0.2, etaMs: 0 }).text).toBe("1 of 1 done · $0.20 · Done");
    const failed = [ag("a", "done"), ag("b", "failed", { detail: "failed:timeout" })];
    expect(deriveRunState({ agents: failed, phase: null, active: false, live: false }).label).toBe("Failed");
    expect(summarizeRun({ agents: failed, phase: null, state: { kind: "failed", label: "Failed" }, costUsd: null, etaMs: null }).text).toBe("1 of 2 done · 1 failed · cost n/a · Failed");
  });
  it("derives why a run stopped", () => {
    expect(deriveRunState({ agents: [ag("a", "failed", { detail: "failed:aborted" })], phase: null, active: false, live: false }).label).toBe("Stopped: the run was stopped");
    expect(deriveRunState({ agents: [ag("a", "done")], phase: { phase: 5, maxPhases: 5, remaining: "more" }, active: false, live: false }).label).toBe("Stopped: phase limit reached (5/5)");
    expect(deriveRunState({ agents: [ag("a", "done")], phase, active: false, live: false }).label).toBe("Stopped: work remains");
    expect(deriveRunState({ agents: [ag("a", "done")], phase, active: false, live: true }).kind).toBe("planning");
    expect(deriveRunState({ agents: [ag("a", "done")], phase: null, active: false, live: true, stop: { reason: "max_tokens", message: "used 9 tokens, over the limit" } }).label).toBe("Stopped: used 9 tokens, over the limit");
    expect(deriveRunState({ agents: [ag("a", "pending")], phase: null, active: false, live: false }).kind).toBe("stopped");
    expect(deriveRunState({ agents: [], phase: null, active: false, live: true }).kind).toBe("planning");
  });
});

describe("reasonText", () => {
  it("humanises task details", () => {
    expect(reasonText("failed:timeout")).toBe("Timed out");
    expect(reasonText("failed:aborted")).toBe("Aborted");
    expect(reasonText("failed:sibling")).toBe("Sibling");
    expect(reasonText(undefined)).toBe("Failed (no reason recorded)");
    expect(reasonText(null, "blocked")).toBe("Blocked by a failed dependency");
    expect(reasonText("verify failed")).toBe("Verify failed");
  });
});

describe("deriveProblems", () => {
  const f = failedRun(NOW);
  const agents = deriveAgents(f.snap.events, f.snap.tasks, f.snap.plan);
  const state = deriveRunState({ agents, phase: derivePhase(f.snap.events), active: false, live: false });
  const problems = deriveProblems(f.snap.events, agents, state);
  it("lists failed and blocked tasks with reasons, errors first", () => {
    expect(problems.map((p) => p.taskId)).toEqual(["p1-queue", "p1-ui", "p2-docs"]);
    expect(problems[0]).toMatchObject({ severity: "error", detail: "Timed out" });
    expect(problems[2]!.detail).toBe("Dependency failed");
  });
  it("shows the conflicting files of a dependency merge conflict", () => {
    const ui = problems.find((p) => p.taskId === "p1-ui")!;
    expect(ui.detail).toContain("Merge conflict merging dependency p1-schema");
    expect(ui.files).toEqual(["packages/ui/test/smoke.spec.ts", "packages/ui/src/App.tsx"]);
  });
  it("has nothing to say for a healthy run and one run-level line for an early stop", () => {
    const ws = workspaceRun(NOW);
    const wa = deriveAgents(ws.snap.events, ws.snap.tasks, ws.snap.plan);
    expect(deriveProblems(ws.snap.events, wa, { kind: "running", label: "Running" })).toEqual([]);
    const stopped = deriveProblems([], [ag("a", "done")], { kind: "stopped", label: "Stopped: phase limit reached (5/5)" });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ taskId: null, title: "Run stopped early", detail: "phase limit reached (5/5)" });
  });
  it("turns sibling, ownership and predicted-conflict events into concise warnings after the errors", () => {
    const events = [
      ev(1, "a", "task_started", { repo: "api" }),
      ev(2, "a", "sibling_modified", { repo: "web", files: ["src/x.ts", "src/y.ts"], count: 5 }),
      ev(3, "a", "ownership_violation", { files: ["docs/z.md"], count: 1, enforced: false }),
      ev(4, "a", "predicted_conflict", { tasks: ["a", "b"], files: ["shared.ts"] }),
      ev(5, "b", "task_started", {}), ev(6, "b", "task_failed", {}),
    ];
    const as = deriveAgents(events, [{ task_id: "b", status: "failed", detail: "failed:ownership" }]);
    const ps = deriveProblems(events, as, { kind: "running", label: "Running" });
    expect(ps.map((p) => p.severity)).toEqual(["error", "warning", "warning", "warning"]);
    expect(ps[1]!.detail).toBe("Changed 1 file outside its declared paths");
    const sib = ps.find((p) => p.id.startsWith("sibling"))!;
    expect(sib.detail).toBe("Modified sibling repo web (5 files); changes were reverted");
    expect(sib.moreFiles).toBe(3);
    expect(ps.find((p) => p.id.startsWith("predicted"))!.title).toBe("a + b");
  });
});

describe("board grouping, sorting and filtering", () => {
  const rows = [
    ag("d1", "done", { phase: 1, startedAt: 10 }), ag("r1", "running", { phase: 1, startedAt: 30 }), ag("r0", "running", { phase: 1, startedAt: 20 }),
    ag("f1", "failed", { phase: 1, startedAt: 5, repo: "api" }), ag("b1", "blocked", { phase: 2 }), ag("p1", "pending", { phase: 2 }), ag("d2", "done", { phase: 2, startedAt: 1 }),
  ];
  it("groups by phase only when there are several and sorts running, failed, blocked, pending, done (stable by start)", () => {
    const g = groupBoard(rows);
    expect(g.map((x) => x.title)).toEqual(["Phase 1", "Phase 2"]);
    expect(g[0]!.rows.map((r) => r.id)).toEqual(["r0", "r1", "f1", "d1"]);
    expect(g[1]!.rows.map((r) => r.id)).toEqual(["b1", "p1", "d2"]);
    expect(g[0]!.summary).toBe("2 running · 1 failed · 1 done");
    expect(g[1]!.summary).toBe("1 blocked · 1 queued · 1 done");
    const single = groupBoard(rows.slice(0, 2));
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ title: "", phase: null });
  });
  it("filters by chip and query and counts chips independently of the query", () => {
    expect(chipCounts(rows)).toEqual({ all: 7, running: 2, failed: 2, done: 2 });
    expect(groupBoard(rows, { chip: "failed" }).flatMap((g) => g.rows.map((r) => r.id))).toEqual(["f1", "b1"]);
    expect(groupBoard(rows, { query: "API" }).flatMap((g) => g.rows.map((r) => r.id))).toEqual(["f1"]);
    expect(groupBoard(rows, { query: "zzz" })).toEqual([]);
    expect(phaseSummary([])).toBe("");
  });
});

describe("now text", () => {
  const ws = workspaceRun(NOW);
  const agents = deriveAgents(ws.snap.events, ws.snap.tasks, ws.snap.plan);
  const texts = deriveNowTexts({ events: ws.snap.events, blackboard: ws.snap.blackboard, reports: ws.snap.reports, plan: ws.snap.plan, agents });
  it("shows the latest tool step for running tasks", () => {
    expect(texts.get("p2-ws-fix")).toBe("Read src/app.js (lines 1–80)");
    expect(texts.get("p2-ws-docs")).toBe("Bash: node --test");
  });
  it("falls back to the last assistant text, then to Starting", () => {
    const events = [ev(1, "a", "task_started"), ev(2, "a", "assistant_text", { text: "Thinking   about\nthe plan" })];
    expect(deriveNowText(ag("a", "running"), events, { blackboard: [], reports: [], plan: null, agents: [] })).toBe("Thinking about the plan");
    expect(deriveNowText(ag("a", "running"), [], { blackboard: [], reports: [], plan: null, agents: [] })).toBe("Starting…");
  });
  it("uses the summary's first sentence for done, Report ready without one", () => {
    expect(texts.get("p1-route53")).toBe("Added GET /v2/routes backed by a Route53 client wrapper.");
    const none = { blackboard: [], reports: [{ task_id: "x", body: "r" }], plan: null, agents: [] };
    expect(deriveNowText(ag("x", "done"), [], none)).toBe("Report ready");
    expect(deriveNowText(ag("y", "done"), [], none)).toBe("Finished");
  });
  it("uses the reason for failed, the unmet dependencies for blocked and queued for pending", () => {
    const f = failedRun(NOW);
    const fa = deriveAgents(f.snap.events, f.snap.tasks, f.snap.plan);
    const ft = deriveNowTexts({ events: f.snap.events, blackboard: f.snap.blackboard, reports: f.snap.reports, plan: f.snap.plan, agents: fa });
    expect(ft.get("p1-queue")).toBe("Timed out");
    expect(ft.get("p2-docs")).toBe("waiting on p1-queue, p1-ui");
    expect(deriveNowText(ag("q", "pending"), [], { blackboard: [], reports: [], plan: null, agents: [] })).toBe("queued");
  });
  it("clips a long first sentence", () => {
    expect(firstSentence("One. Two.")).toBe("One.");
    expect(firstSentence("x".repeat(300)).length).toBe(160);
  });
});

describe("deriveAnswer", () => {
  it("returns reports of leaf tasks only, in plan order", () => {
    const f = failedRun(NOW);
    expect(deriveAnswer(f.snap.plan, f.snap.reports).map((r) => r.task_id)).toEqual(["p1-api"]);
    const plan = { tasks: [
      { id: "a", role: "implementer", runtime: "codex", tier: "mid", goal: "g", dependsOn: [], needs: [], paths: [] },
      { id: "b", role: "reviewer", runtime: "claude", tier: "mid", goal: "g", dependsOn: [], needs: ["a/summary"], paths: [] },
    ] } as const;
    expect(deriveAnswer(plan as never, [{ task_id: "a", body: "x" }, { task_id: "b", body: "y" }]).map((r) => r.task_id)).toEqual(["b"]);
    expect(deriveAnswer(plan as never, [{ task_id: "a", body: "x" }])).toEqual([]);
    expect(deriveAnswer(null, [{ task_id: "z", body: "x" }])).toHaveLength(1);
    expect(deriveAnswer(null, [])).toEqual([]);
  });
});
