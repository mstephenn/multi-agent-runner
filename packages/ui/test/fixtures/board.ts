// Snapshots that replicate real runs, built relative to `now` so elapsed times and ETAs look right.
// Used by the unit tests and by the Playwright specs (served through page.route; no server needed).
import type { BbEntry, BbKind, Dag, StoredEvent } from "@mar/core";
import type { ReportRow, Snapshot, TaskRow } from "../../src/runClient.js";

export type FixtureRun = { info: { id: string; goal: string; repo: string; created: number }; snap: Snapshot };

class Builder {
  events: StoredEvent[] = [];
  blackboard: BbEntry[] = [];
  private id = 1;
  constructor(readonly runId: string, readonly t0: number) {}
  ev(task: string | null, type: StoredEvent["type"], sec: number, payload: Record<string, unknown> = {}) {
    this.events.push({ id: this.id++, run_id: this.runId, task_id: task, agent_id: task, ts: this.t0 + Math.round(sec * 1000), type, payload });
  }
  call(task: string, sec: number, name: string, input: Record<string, unknown>, output: string | null, isError = false) {
    this.ev(task, "tool_call", sec, { name, input });
    if (output !== null) this.ev(task, "tool_result", sec + 1.2, { name, output, isError });
  }
  bb(task: string, sec: number, key: string, kind: BbKind, body: string) {
    const version = this.blackboard.filter((b) => b.key === key).length + 1;
    this.blackboard.push({ id: this.blackboard.length + 1, run_id: this.runId, key, author_task: task, kind, body, refs: [], version, ts: this.t0 + Math.round(sec * 1000) });
    this.ev(task, "blackboard_write", sec, { key, kind, version });
  }
  start(task: string, sec: number, p: Record<string, unknown>) {
    this.ev(task, "task_started", sec, { worktree: "own", ...p });
  }
}

const WS_REPOS = ["optichat", "r101-frontend", "r101-scheduler", "r101-webservices", "r101-ws-bc"];
const spec = (id: string, role: "implementer" | "reviewer" | "tester", runtime: "claude" | "codex", tier: "low" | "mid" | "high", goal: string,
  extra: { dependsOn?: string[]; needs?: string[]; repo?: string; phase?: number } = {}) =>
  ({ id, role, runtime, tier, goal, dependsOn: extra.dependsOn ?? [], needs: extra.needs ?? [], paths: [], ...(extra.repo ? { repo: extra.repo } : {}), ...(extra.phase ? { phase: extra.phase } : {}) });

/** A 5-repo workspace run in phase 2 of 5: four finished tasks and two codex implementers still running. */
export function workspaceRun(now: number): FixtureRun {
  const t0 = now - 7 * 60_000;
  const b = new Builder("ws1", t0);
  const goal = "Add a /v2/routes endpoint backed by Route53 health checks, validate it end to end and update the frontend to use it";
  b.ev(null, "run_started", 0, { mode: "workspace", root: "/work/r101", repos: WS_REPOS });
  b.ev(null, "phase_started", 1, { phase: 1, maxPhases: 5, tasks: ["p1-route53", "p1-validate", "p1-fe", "p1-review"], remaining: "Fix the webservices handler review findings and document the endpoint" });

  b.start("p1-route53", 5, { role: "implementer", runtime: "codex", tier: "mid", repo: "r101-webservices" });
  b.ev("p1-route53", "prompt_sent", 6, { runtime: "codex", prompt: "Add Route53 health-check lookups to the webservices router.\nOwn: r101-webservices/src/routes.", keys: [], tokens: 410 });
  b.call("p1-route53", 9, "Read", { file_path: "src/routes/index.js", offset: 1, limit: 120 }, "const express = require('express');\n// ...");
  b.call("p1-route53", 14, "Grep", { pattern: "healthCheck", path: "src" }, "src/routes/index.js:44: healthCheck()");
  b.ev("p1-route53", "assistant_text", 20, { text: "The router has no Route53 client yet. Adding a small wrapper and a /v2/routes handler." });
  b.call("p1-route53", 31, "Edit", { file_path: "src/routes/v2.js" }, "ok");
  b.call("p1-route53", 80, "Bash", { command: "node --test" }, "# pass 12\n# fail 0");
  b.ev("p1-route53", "usage", 128, { input: 18400, output: 3100, costUsd: 0.03 });
  b.bb("p1-route53", 129, "p1-route53/summary", "summary", "Added GET /v2/routes backed by a Route53 client wrapper. Handler returns health state per record.");
  b.bb("p1-route53", 129.5, "p1-route53/routes-api", "decision", "Response shape is { name, type, healthy } so the frontend can render it without mapping.");
  b.bb("p1-route53", 130, "p1-route53/files", "file_change", "src/routes/v2.js, src/lib/route53.js, test/routes-v2.test.js");
  b.bb("p1-route53", 130.5, "p1-route53/env", "decision", "AWS region is read from ROUTE53_REGION, default us-east-1.");
  b.bb("p1-route53", 131, "p1-route53/open", "open_question", "Should unhealthy records be cached for 30s? Left uncached.");
  b.ev("p1-route53", "task_finished", 132, { tokens: 21500 });

  b.start("p1-fe", 5, { role: "implementer", runtime: "codex", tier: "mid", repo: "r101-frontend" });
  b.ev("p1-fe", "prompt_sent", 6, { runtime: "codex", prompt: "Render the new routes table in the admin screen.", keys: [], tokens: 380 });
  b.call("p1-fe", 12, "Read", { file_path: "src/admin/Routes.tsx" }, "export function Routes() { return null; }");
  b.call("p1-fe", 60, "Edit", { file_path: "src/admin/Routes.tsx" }, "ok");
  b.call("p1-fe", 120, "Bash", { command: "pnpm test --run" }, "Tests 31 passed");
  b.ev("p1-fe", "usage", 160, { input: 15200, output: 2600, costUsd: 0.02 });
  b.bb("p1-fe", 161, "p1-fe/summary", "summary", "Admin screen now lists routes with a health badge. Uses the /v2/routes shape.");
  b.bb("p1-fe", 161.5, "p1-fe/files", "file_change", "src/admin/Routes.tsx, src/admin/Routes.test.tsx");
  b.bb("p1-fe", 162, "p1-fe/decision", "decision", "Polling interval is 15s; no websocket.");
  b.bb("p1-fe", 162.5, "p1-fe/open", "open_question", "Empty state copy needs product sign-off.");
  b.ev("p1-fe", "task_finished", 164, { tokens: 17800 });

  b.start("p1-validate", 135, { role: "tester", runtime: "codex", tier: "low" });
  b.ev("p1-validate", "blackboard_read", 136, { author: "p1-route53", key: "p1-route53/summary", version: 1, tokens: 36 });
  b.ev("p1-validate", "prompt_sent", 137, { runtime: "codex", prompt: "Validate the new endpoint against the contract.", keys: ["p1-route53/summary"], tokens: 220 });
  b.call("p1-validate", 142, "Bash", { command: "curl -s localhost:3000/v2/routes" }, "[{\"name\":\"api\",\"healthy\":true}]");
  b.ev("p1-validate", "usage", 175, { input: 6400, output: 900, costUsd: 0.01 });
  b.bb("p1-validate", 176, "p1-validate/summary", "summary", "Contract holds: 200 with a JSON array, unhealthy records flagged.");
  b.bb("p1-validate", 176.5, "p1-validate/open", "open_question", "No auth on the endpoint; confirm that is intended.");
  b.bb("p1-validate", 177, "p1-validate/files", "file_change", "test/contract.test.js");
  b.ev("p1-validate", "task_finished", 178, { tokens: 7300 });

  b.start("p1-review", 182, { role: "reviewer", runtime: "claude", tier: "high", worktree: "shared" });
  for (const [from, key] of [["p1-route53", "p1-route53/summary"], ["p1-validate", "p1-validate/summary"], ["p1-fe", "p1-fe/summary"]] as const) b.ev("p1-review", "blackboard_read", 183, { author: from, key, version: 1, tokens: 40 });
  b.ev("p1-review", "prompt_sent", 184, { runtime: "claude", prompt: "Review the combined change.", keys: ["p1-route53/summary", "p1-validate/summary", "p1-fe/summary"], tokens: 900 });
  b.call("p1-review", 190, "Read", { file_path: "src/routes/v2.js" }, "module.exports = ...");
  b.ev("p1-review", "usage", 228, { input: 21000, output: 2400, costUsd: 0.08 });
  b.bb("p1-review", 229, "p1-review/summary", "summary", "Two findings: the handler swallows Route53 errors and the docs are missing. Otherwise correct.");
  b.bb("p1-review", 229.5, "p1-review/finding-1", "decision", "Handler must return 502 when Route53 fails, not an empty list.");
  b.bb("p1-review", 230, "p1-review/finding-2", "open_question", "Where should the endpoint be documented?");
  b.bb("p1-review", 230.5, "p1-review/files", "file_change", "none");
  b.ev("p1-review", "task_finished", 232, { tokens: 23400 });
  b.ev(null, "phase_finished", 378, { phase: 1, done: 4, failed: 0, blocked: 0, tokens: 70000 });

  b.ev(null, "phase_started", 380, { phase: 2, maxPhases: 5, tasks: ["p2-ws-fix", "p2-ws-docs"], remaining: "Update r101-scheduler to call the new endpoint and add release notes" });
  b.start("p2-ws-fix", 384, { role: "implementer", runtime: "codex", tier: "mid", repo: "r101-webservices" });
  for (const key of ["p1-route53/summary", "p1-review/summary"]) b.ev("p2-ws-fix", "blackboard_read", 385, { author: key.split("/")[0], key, version: 1, tokens: 38 });
  b.ev("p2-ws-fix", "prompt_sent", 386, { runtime: "codex", prompt: "Fix the review findings in the webservices handler.", keys: ["p1-route53/summary", "p1-review/summary"], tokens: 520 });
  b.call("p2-ws-fix", 392, "Grep", { pattern: "route53", path: "src" }, "src/routes/v2.js:12");
  b.call("p2-ws-fix", 402, "Edit", { file_path: "src/routes/v2.js" }, "ok");
  b.call("p2-ws-fix", 412, "Read", { file_path: "src/app.js", offset: 1, limit: 80 }, null);
  b.start("p2-ws-docs", 386, { role: "implementer", runtime: "codex", tier: "low", repo: "r101-webservices" });
  b.ev("p2-ws-docs", "blackboard_read", 387, { author: "p1-review", key: "p1-review/summary", version: 1, tokens: 38 });
  b.ev("p2-ws-docs", "prompt_sent", 388, { runtime: "codex", prompt: "Document GET /v2/routes in the webservices README.", keys: ["p1-review/summary"], tokens: 300 });
  b.ev("p2-ws-docs", "assistant_text", 396, { text: "Drafting the README section for the new endpoint." });
  b.call("p2-ws-docs", 414, "Bash", { command: "node --test" }, null);

  const plan: Dag = { tasks: [
    spec("p1-route53", "implementer", "codex", "mid", "Add Route53 lookups", { repo: "r101-webservices", phase: 1 }),
    spec("p1-validate", "tester", "codex", "low", "Validate the endpoint", { dependsOn: ["p1-route53"], needs: ["p1-route53/summary"], phase: 1 }),
    spec("p1-fe", "implementer", "codex", "mid", "Render the routes table", { repo: "r101-frontend", phase: 1 }),
    spec("p1-review", "reviewer", "claude", "high", "Review the combined change", { dependsOn: ["p1-route53", "p1-validate", "p1-fe"], needs: ["p1-route53/summary", "p1-validate/summary", "p1-fe/summary"], phase: 1 }),
    spec("p2-ws-fix", "implementer", "codex", "mid", "Fix the review findings", { dependsOn: ["p1-review"], needs: ["p1-route53/summary", "p1-review/summary"], repo: "r101-webservices", phase: 2 }),
    spec("p2-ws-docs", "implementer", "codex", "low", "Document the endpoint", { dependsOn: ["p1-review"], needs: ["p1-review/summary"], repo: "r101-webservices", phase: 2 }),
  ] };
  const tasks: TaskRow[] = [
    ...["p1-route53", "p1-validate", "p1-fe", "p1-review"].map((task_id) => ({ task_id, status: "done", detail: null })),
    ...["p2-ws-fix", "p2-ws-docs"].map((task_id) => ({ task_id, status: "running", detail: null })),
  ];
  return { info: { id: "ws1", goal, repo: "/work/r101", created: t0 }, snap: { events: b.events, blackboard: b.blackboard, tasks, plan, reports: [] } };
}

/** A finished run with a timed-out task, a dependency merge conflict, a blocked task and a report for a leaf task. */
export function failedRun(now: number): FixtureRun {
  const t0 = now - 25 * 60_000;
  const b = new Builder("fail1", t0);
  b.ev(null, "run_started", 0, { mode: "single", root: "/work/billing" });
  b.ev(null, "phase_started", 1, { phase: 1, maxPhases: 3, tasks: ["p1-schema", "p1-api", "p1-queue", "p1-ui"], remaining: "Write the migration guide" });
  b.start("p1-schema", 2, { role: "implementer", runtime: "claude", tier: "low" });
  b.ev("p1-schema", "usage", 40, { input: 3000, output: 600, costUsd: 0.02 });
  b.bb("p1-schema", 41, "p1-schema/summary", "summary", "Added the queue_status table migration.");
  b.ev("p1-schema", "task_finished", 42, { tokens: 3600 });
  b.start("p1-api", 4, { role: "implementer", runtime: "claude", tier: "mid" });
  b.ev("p1-api", "prompt_sent", 5, { runtime: "claude", prompt: "Expose the queue status API.", keys: [], tokens: 300 });
  b.call("p1-api", 9, "Edit", { file_path: "src/api/queue.ts" }, "ok");
  b.ev("p1-api", "usage", 300, { input: 12000, output: 1800, costUsd: 0.12 });
  b.bb("p1-api", 301, "p1-api/summary", "summary", "Added GET /queue/status. Documented the response in the README.");
  b.ev("p1-api", "task_finished", 302, { tokens: 13800 });
  b.start("p1-queue", 4, { role: "implementer", runtime: "codex", tier: "high" });
  b.ev("p1-queue", "prompt_sent", 5, { runtime: "codex", prompt: "Move the webhook consumer to the new queue.", keys: [], tokens: 450 });
  b.call("p1-queue", 20, "Bash", { command: "pnpm --filter consumer test" }, "Running 140 tests...");
  b.ev("p1-queue", "assistant_text", 400, { text: "Still migrating the retry handlers; the test suite is slow." });
  b.ev("p1-queue", "task_failed", 1200, { error: "failed:timeout" });
  b.start("p1-ui", 4, { role: "implementer", runtime: "codex", tier: "mid" });
  b.ev("p1-ui", "dependency_merge_conflict", 5, { task: "p1-ui", dependency: "p1-schema", files: ["packages/ui/test/smoke.spec.ts", "packages/ui/src/App.tsx"] });
  b.ev("p1-ui", "task_failed", 6, { error: "dependency merge conflict" });
  b.ev(null, "phase_finished", 1210, { phase: 1, done: 2, failed: 2, blocked: 0, tokens: 40000 });
  // p2-docs never started: it is blocked on the failures
  const answer = "# Billing webhooks migration\n\nStatus API: GET /queue/status returns { depth, oldestAgeSeconds }.\n\nNot finished: the consumer move timed out and the UI conflicts with the API change. See the failed tasks.";
  const plan: Dag = { tasks: [
    spec("p1-schema", "implementer", "claude", "low", "Add the queue status table", { phase: 1 }),
    spec("p1-api", "implementer", "claude", "mid", "Expose the queue status API", { phase: 1 }),
    spec("p1-queue", "implementer", "codex", "high", "Move the webhook consumer", { phase: 1 }),
    spec("p1-ui", "implementer", "codex", "mid", "Show queue status in the UI", { dependsOn: ["p1-schema"], phase: 1 }),
    spec("p2-docs", "implementer", "claude", "low", "Write the migration guide", { dependsOn: ["p1-queue", "p1-ui"], phase: 2 }),
  ] };
  const tasks: TaskRow[] = [
    { task_id: "p1-schema", status: "done", detail: null },
    { task_id: "p1-api", status: "done", detail: null },
    { task_id: "p1-queue", status: "failed", detail: "failed:timeout" },
    { task_id: "p1-ui", status: "failed", detail: "dependency merge conflict: p1-schema into p1-ui" },
    { task_id: "p2-docs", status: "blocked", detail: "blocked: dependency failed" },
  ];
  const reports: ReportRow[] = [{ task_id: "p1-api", body: answer }];
  return { info: { id: "fail1", goal: "Migrate the billing webhooks to the new queue", repo: "/work/billing", created: t0 }, snap: { events: b.events, blackboard: b.blackboard, tasks, plan, reports } };
}
