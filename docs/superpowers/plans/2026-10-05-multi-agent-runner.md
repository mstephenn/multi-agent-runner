# Multi-Agent Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local runner (`mar`) where an orchestrator splits a coding goal into a task DAG, runs tasks on Claude Code / Codex CLI agents in isolated git worktrees with token-frugal context passing, and a live web UI shows agents, communication and shared context.

**Architecture:** TypeScript pnpm monorepo. Adapters wrap `claude -p --output-format stream-json` and `codex exec --json`, normalizing both into one event schema persisted in SQLite and relayed over WebSocket to a React UI. Agents never talk directly; they read/write an orchestrator-mediated blackboard.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, zod, better-sqlite3, ws, React + Vite, @xyflow/react (React Flow), Playwright (one smoke test).

**Spec:** `docs/superpowers/specs/2026-10-05-multi-agent-runner-design.md`

## Global Constraints

- Runtimes: Claude Code and Codex CLI behind one adapter interface.
- One git worktree per worker; workers touch only their own worktree.
- Blackboard bodies capped at ~300 tokens (`MAX_BB_BODY_CHARS = 1200`, tokens estimated as `ceil(chars/4)`); larger content is an `artifact_ref`.
- A task receives context only via its `needs` keys.
- Never merge to `main`/`master`/`beta`; never push or deploy.
- No `--dangerously-skip-permissions` equivalent unless explicit per-run opt-in.
- `.env` files never copied into worktrees or prompts; event log redacts secret patterns.
- Server binds `127.0.0.1` only.
- Planner model configurable, default Sonnet; model ids default to `claude-haiku-4-5-20251001` (low), `claude-sonnet-5-5` (mid and high). Never default to Opus. Codex tiers default to the CLI's own default model unless configured.
- Dependencies are the set listed in Tech Stack. **Ask the user before adding any other.**
- Git: work on branch `feat/multi-agent-runner`; Conventional Commits; commit only after the user has approved execution.

## Review Focus

- Goal or repo path containing spaces/quotes/unicode: spawn with an args array (never a shell string); paths survive intact.
- Planner returns tasks whose `needs` reference a task that is not an ancestor: rejected at validation (agent would read nothing or a racing value).
- Worker emits no `usage` event (Codex/aborted run): budget tracker treats it as 0 and the run still completes; UI shows "n/a", not NaN.
- Two tasks writing the same blackboard key: second gets `version: 2`; readers receive the latest version at injection time and the event records the version.
- Non-git directory or dirty working tree passed as `--repo`: fail fast in preflight with a clear message, before the planner call.

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts, .gitignore
packages/core/src/{schemas.ts,dag.ts,tokens.ts,types.ts,index.ts}
packages/orchestrator/src/{blackboard.ts,prompt.ts,scheduler.ts,budget.ts,planner.ts,worktree.ts,redact.ts,index.ts}
packages/adapters/src/{types.ts,claude.ts,codex.ts,exec.ts,index.ts}
packages/server/src/{store.ts,server.ts,index.ts}
packages/cli/src/{main.ts,preflight.ts,config.ts}
packages/ui/src/{main.tsx,App.tsx,derive.ts,useRun.ts,GraphView.tsx,Inspector.tsx,Timeline.tsx,BlackboardPanel.tsx}
tests live beside each package in `test/`; fixtures in `packages/adapters/test/fixtures/`
```

---

### Task 1: Monorepo scaffold and core schemas

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `vitest.workspace.ts`
- Create: `packages/core/{package.json,tsconfig.json}`, `packages/core/src/{schemas.ts,dag.ts,tokens.ts,index.ts}`
- Test: `packages/core/test/schemas.test.ts`, `packages/core/test/dag.test.ts`

**Interfaces:**
- Produces:
  - `Runtime = 'claude' | 'codex'`, `Tier = 'low'|'mid'|'high'`, `Role = 'implementer'|'reviewer'|'tester'|'researcher'`
  - `TaskSpec` (zod + type): `{ id, role, runtime, tier, goal, dependsOn: string[], needs: string[], budgetTokens?: number }`
  - `parseDag(input: unknown): Dag` where `Dag = { tasks: TaskSpec[] }` — throws `DagError` (message names the offending task) on cycle, duplicate id, unknown dependency, or `needs` referencing a non-ancestor
  - `EventType` union, `NewEvent = { run_id, task_id: string|null, agent_id: string|null, type: EventType, payload: Record<string, unknown> }`, `StoredEvent = NewEvent & { id: number, ts: number }`
  - `BbKind`, `BbWrite = { run_id, key, author_task, kind, body, refs: string[] }`, `BbEntry = BbWrite & { id: number, version: number, ts: number }`
  - `TaskResult = { summary: string, filesChanged: string[], decisions: string[], openQuestions: string[] }` (+ `TaskResultSchema`)
  - `MAX_BB_BODY_CHARS = 1200`, `estimateTokens(s: string): number`

- [ ] **Step 1: Scaffold workspace**

```bash
cd <repo>
git init && git checkout -b feat/multi-agent-runner
```

`package.json`:
```json
{
  "name": "multi-agent-runner",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b packages/core packages/adapters packages/orchestrator packages/server packages/cli",
    "test:live": "MAR_LIVE=1 vitest run packages/cli/test/live.test.ts"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
}
```
`pnpm-workspace.yaml`: `packages:\n  - "packages/*"`
`tsconfig.base.json`: `{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"declaration":true,"composite":true,"skipLibCheck":true,"outDir":"dist"}}`
`vitest.workspace.ts`: `export default ["packages/*"];`
`.gitignore`: `node_modules\ndist\n.env\n.env.*\n.mar/\n`
`packages/core/package.json`: name `@mar/core`, `"type":"module"`, `"main":"src/index.ts"`, dependency `zod`.
`packages/core/tsconfig.json`: extends base, `include: ["src","test"]`.

Run: `pnpm install` (installs typescript, vitest, zod). Expected: success.

- [ ] **Step 2: Write failing tests**

`packages/core/test/dag.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseDag } from "../src/index.js";

const t = (id: string, extra: object = {}) => ({
  id, role: "implementer", runtime: "claude", tier: "mid", goal: "g", ...extra,
});

describe("parseDag", () => {
  it("accepts a valid DAG and defaults dependsOn/needs", () => {
    const dag = parseDag({ tasks: [t("a"), t("b", { dependsOn: ["a"], needs: ["a/summary"] })] });
    expect(dag.tasks[0].dependsOn).toEqual([]);
    expect(dag.tasks[1].needs).toEqual(["a/summary"]);
  });
  it("rejects cycles", () => {
    expect(() => parseDag({ tasks: [t("a", { dependsOn: ["b"] }), t("b", { dependsOn: ["a"] })] })).toThrow(/cycle/i);
  });
  it("rejects unknown dependency", () => {
    expect(() => parseDag({ tasks: [t("a", { dependsOn: ["zzz"] })] })).toThrow(/zzz/);
  });
  it("rejects duplicate ids", () => {
    expect(() => parseDag({ tasks: [t("a"), t("a")] })).toThrow(/duplicate/i);
  });
  it("rejects needs that reference a non-ancestor", () => {
    expect(() => parseDag({ tasks: [t("a"), t("b", { needs: ["a/summary"] })] })).toThrow(/non-ancestor|ancestor/i);
  });
  it("rejects unknown runtime", () => {
    expect(() => parseDag({ tasks: [t("a", { runtime: "gpt" })] })).toThrow();
  });
});
```
`packages/core/test/schemas.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TaskResultSchema, estimateTokens, MAX_BB_BODY_CHARS } from "../src/index.js";

describe("core", () => {
  it("estimates tokens as ceil(chars/4)", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
  it("caps blackboard body size constant at 1200 chars", () => {
    expect(MAX_BB_BODY_CHARS).toBe(1200);
  });
  it("TaskResult requires summary and defaults lists", () => {
    const r = TaskResultSchema.parse({ summary: "done" });
    expect(r.filesChanged).toEqual([]);
    expect(() => TaskResultSchema.parse({})).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/core`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

`packages/core/src/tokens.ts`:
```ts
export const MAX_BB_BODY_CHARS = 1200;
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);
```
`packages/core/src/schemas.ts`:
```ts
import { z } from "zod";

export const Runtime = z.enum(["claude", "codex"]);
export const Tier = z.enum(["low", "mid", "high"]);
export const Role = z.enum(["implementer", "reviewer", "tester", "researcher"]);

export const TaskSpec = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "task id must be lowercase [a-z0-9_-]"),
  role: Role,
  runtime: Runtime,
  tier: Tier,
  goal: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  needs: z.array(z.string()).default([]),
  budgetTokens: z.number().int().positive().optional(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
export type Runtime = z.infer<typeof Runtime>;
export type Tier = z.infer<typeof Tier>;
export type Role = z.infer<typeof Role>;

export const TaskResultSchema = z.object({
  summary: z.string().min(1),
  filesChanged: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const EventTypes = [
  "task_started", "task_finished", "task_failed", "prompt_sent", "tool_call",
  "tool_result", "assistant_text", "blackboard_write", "blackboard_read", "usage",
] as const;
export type EventType = (typeof EventTypes)[number];

export interface NewEvent {
  run_id: string;
  task_id: string | null;
  agent_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
}
export type StoredEvent = NewEvent & { id: number; ts: number };

export type BbKind = "summary" | "decision" | "file_change" | "open_question" | "artifact_ref";
export interface BbWrite {
  run_id: string; key: string; author_task: string; kind: BbKind; body: string; refs: string[];
}
export type BbEntry = BbWrite & { id: number; version: number; ts: number };
```
`packages/core/src/dag.ts`:
```ts
import { z } from "zod";
import { TaskSpec } from "./schemas.js";

export type Dag = { tasks: TaskSpec[] };
export class DagError extends Error {}

export function parseDag(input: unknown): Dag {
  const dag = z.object({ tasks: z.array(TaskSpec).min(1) }).parse(input);
  const byId = new Map<string, TaskSpec>();
  for (const t of dag.tasks) {
    if (byId.has(t.id)) throw new DagError(`duplicate task id: ${t.id}`);
    byId.set(t.id, t);
  }
  for (const t of dag.tasks)
    for (const d of t.dependsOn)
      if (!byId.has(d)) throw new DagError(`task ${t.id} depends on unknown task ${d}`);

  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (id: string): Set<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new DagError(`cycle detected at task ${id}`);
    visiting.add(id);
    const set = new Set<string>();
    for (const d of byId.get(id)!.dependsOn) { set.add(d); for (const a of walk(d)) set.add(a); }
    visiting.delete(id);
    ancestors.set(id, set);
    return set;
  };
  for (const t of dag.tasks) walk(t.id);
  for (const t of dag.tasks)
    for (const key of t.needs) {
      const owner = key.split("/")[0];
      if (!ancestors.get(t.id)!.has(owner))
        throw new DagError(`task ${t.id} needs ${key} but ${owner} is a non-ancestor`);
    }
  return dag;
}
```
`packages/core/src/index.ts`: `export * from "./schemas.js"; export * from "./dag.js"; export * from "./tokens.js";`

- [ ] **Step 5: Run tests, typecheck**

Run: `pnpm vitest run packages/core && pnpm tsc -b packages/core`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit** (after user approval of execution)

```bash
git add -A && git commit -m "feat(core): add workspace scaffold, schemas and dag validation"
```

---

### Task 2: SQLite store

**Files:**
- Create: `packages/server/{package.json,tsconfig.json}`, `packages/server/src/store.ts`
- Test: `packages/server/test/store.test.ts`

**Interfaces:**
- Consumes: `NewEvent, StoredEvent, BbWrite, BbEntry` from `@mar/core`
- Produces: `class Store` — `constructor(path: string)` (`":memory:"` allowed); `createRun(id: string, goal: string, repo: string): void`; `appendEvent(e: NewEvent): StoredEvent`; `listEvents(runId: string, afterId?: number): StoredEvent[]`; `writeBb(w: BbWrite): BbEntry` (auto-increments `version` per `run_id+key`; throws if `body.length > MAX_BB_BODY_CHARS`); `latestBb(runId: string, key: string): BbEntry | undefined`; `listBb(runId: string): BbEntry[]`; `setTaskStatus(runId, taskId, status, detail?)`; `taskStatuses(runId): {task_id, status, detail}[]`; `listRuns(): {id, goal, repo, created}[]`; `onEvent(cb: (e: StoredEvent) => void): () => void`

- [ ] **Step 1: Failing test** `packages/server/test/store.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";

const mk = () => { const s = new Store(":memory:"); s.createRun("r1", "goal", "/repo"); return s; };

describe("Store", () => {
  it("appends events with increasing ids and returns them after a cursor", () => {
    const s = mk();
    const a = s.appendEvent({ run_id: "r1", task_id: "t", agent_id: "t", type: "task_started", payload: {} });
    const b = s.appendEvent({ run_id: "r1", task_id: "t", agent_id: "t", type: "usage", payload: { input: 1 } });
    expect(b.id).toBeGreaterThan(a.id);
    expect(s.listEvents("r1", a.id).map((e) => e.id)).toEqual([b.id]);
    expect(b.payload).toEqual({ input: 1 });
  });
  it("versions blackboard entries per key and returns the latest", () => {
    const s = mk();
    const w = { run_id: "r1", key: "a/summary", author_task: "a", kind: "summary" as const, body: "v1", refs: [] };
    expect(s.writeBb(w).version).toBe(1);
    expect(s.writeBb({ ...w, body: "v2" }).version).toBe(2);
    expect(s.latestBb("r1", "a/summary")?.body).toBe("v2");
    expect(s.listBb("r1")).toHaveLength(2);
  });
  it("rejects oversize blackboard bodies", () => {
    const s = mk();
    expect(() => s.writeBb({ run_id: "r1", key: "a/summary", author_task: "a", kind: "summary", body: "x".repeat(1201), refs: [] })).toThrow(/too large|cap/i);
  });
  it("notifies subscribers and supports unsubscribe", () => {
    const s = mk(); const seen: number[] = [];
    const off = s.onEvent((e) => seen.push(e.id));
    s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started", payload: {} });
    off();
    s.appendEvent({ run_id: "r1", task_id: null, agent_id: null, type: "task_started", payload: {} });
    expect(seen).toHaveLength(1);
  });
  it("persists task statuses", () => {
    const s = mk();
    s.setTaskStatus("r1", "a", "running"); s.setTaskStatus("r1", "a", "failed", "failed:budget");
    expect(s.taskStatuses("r1")).toEqual([{ task_id: "a", status: "failed", detail: "failed:budget" }]);
  });
});
```

- [ ] **Step 2: Verify fail**: `pnpm vitest run packages/server` → FAIL.

- [ ] **Step 3: Implement.** Add `better-sqlite3` and `@types/better-sqlite3` to `packages/server/package.json` (`pnpm --filter @mar/server add better-sqlite3 && pnpm --filter @mar/server add -D @types/better-sqlite3`; also depend on `@mar/core: workspace:*`).

`packages/server/src/store.ts`:
```ts
import Database from "better-sqlite3";
import { MAX_BB_BODY_CHARS, type BbEntry, type BbWrite, type NewEvent, type StoredEvent } from "@mar/core";

export class Store {
  private db: Database.Database;
  private subs = new Set<(e: StoredEvent) => void>();

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, goal TEXT, repo TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, agent_id TEXT, ts INTEGER, type TEXT, payload TEXT);
      CREATE INDEX IF NOT EXISTS ev_run ON events(run_id, id);
      CREATE TABLE IF NOT EXISTS bb_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, key TEXT, author_task TEXT, version INTEGER, ts INTEGER, kind TEXT, body TEXT, refs TEXT);
      CREATE TABLE IF NOT EXISTS task_status (run_id TEXT, task_id TEXT, status TEXT, detail TEXT, PRIMARY KEY (run_id, task_id));
    `);
  }

  createRun(id: string, goal: string, repo: string) {
    this.db.prepare("INSERT OR IGNORE INTO runs VALUES (?,?,?,?)").run(id, goal, repo, Date.now());
  }
  listRuns() { return this.db.prepare("SELECT id, goal, repo, created FROM runs ORDER BY created DESC").all() as { id: string; goal: string; repo: string; created: number }[]; }

  appendEvent(e: NewEvent): StoredEvent {
    const ts = Date.now();
    const r = this.db.prepare("INSERT INTO events (run_id, task_id, agent_id, ts, type, payload) VALUES (?,?,?,?,?,?)")
      .run(e.run_id, e.task_id, e.agent_id, ts, e.type, JSON.stringify(e.payload));
    const stored = { ...e, id: Number(r.lastInsertRowid), ts };
    for (const cb of this.subs) cb(stored);
    return stored;
  }
  listEvents(runId: string, afterId = 0): StoredEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id").all(runId, afterId) as any[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  onEvent(cb: (e: StoredEvent) => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }

  writeBb(w: BbWrite): BbEntry {
    if (w.body.length > MAX_BB_BODY_CHARS) throw new Error(`blackboard body too large (cap ${MAX_BB_BODY_CHARS} chars); use an artifact_ref`);
    const ts = Date.now();
    const prev = this.db.prepare("SELECT MAX(version) v FROM bb_entries WHERE run_id=? AND key=?").get(w.run_id, w.key) as { v: number | null };
    const version = (prev.v ?? 0) + 1;
    const r = this.db.prepare("INSERT INTO bb_entries (run_id,key,author_task,version,ts,kind,body,refs) VALUES (?,?,?,?,?,?,?,?)")
      .run(w.run_id, w.key, w.author_task, version, ts, w.kind, w.body, JSON.stringify(w.refs));
    return { ...w, id: Number(r.lastInsertRowid), version, ts };
  }
  private bbRow(r: any): BbEntry { return { ...r, refs: JSON.parse(r.refs) }; }
  latestBb(runId: string, key: string) {
    const r = this.db.prepare("SELECT * FROM bb_entries WHERE run_id=? AND key=? ORDER BY version DESC LIMIT 1").get(runId, key);
    return r ? this.bbRow(r) : undefined;
  }
  listBb(runId: string): BbEntry[] {
    return (this.db.prepare("SELECT * FROM bb_entries WHERE run_id=? ORDER BY id").all(runId) as any[]).map((r) => this.bbRow(r));
  }

  setTaskStatus(runId: string, taskId: string, status: string, detail?: string) {
    this.db.prepare("INSERT INTO task_status VALUES (?,?,?,?) ON CONFLICT(run_id,task_id) DO UPDATE SET status=excluded.status, detail=excluded.detail")
      .run(runId, taskId, status, detail ?? null);
  }
  taskStatuses(runId: string) {
    return this.db.prepare("SELECT task_id, status, detail FROM task_status WHERE run_id=?").all(runId) as { task_id: string; status: string; detail: string | null }[];
  }
}
```
Note: `detail` is returned as `null` when unset; the test above sets it for the asserted row.

- [ ] **Step 4: Verify pass**: `pnpm vitest run packages/server && pnpm tsc -b packages/server` → PASS.
- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat(server): add sqlite store for events and blackboard"`

---

### Task 3: Blackboard slicing, prompt builder, redaction

**Files:**
- Create: `packages/orchestrator/{package.json,tsconfig.json}`, `src/{blackboard.ts,prompt.ts,redact.ts,index.ts}`
- Test: `packages/orchestrator/test/{blackboard.test.ts,prompt.test.ts,redact.test.ts}`

**Interfaces:**
- Consumes: `Store` (Task 2), `TaskSpec`, `TaskResult`, `estimateTokens`, `MAX_BB_BODY_CHARS`
- Produces:
  - `publishResult(store: Store, runId: string, taskId: string, r: TaskResult): BbEntry[]` — writes `<taskId>/summary` (kind `summary`), `<taskId>/decisions`, `<taskId>/open_questions` (only if non-empty), `<taskId>/files` (kind `file_change`, body = file list; if > cap becomes `artifact_ref` with the first 20 paths in `refs` and body `"N files changed; see refs"`); emits `blackboard_write` event per entry; truncates summary at cap with `…`.
  - `injectSlices(store: Store, runId: string, task: TaskSpec): { slices: { key: string; version: number; body: string; tokens: number }[]; missing: string[] }` — latest version of each `needs` key; emits one `blackboard_read` event per slice (payload `{key, version, tokens}`).
  - `buildPrompt(task: TaskSpec, slices: ReturnType<typeof injectSlices>["slices"]): string` — fixed template: role + goal + `## Context from earlier tasks` (only if slices) + output contract telling the agent to end with the JSON result shape.
  - `redact(s: string): string` — masks `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, and `KEY=value` for names matching `/(SECRET|TOKEN|PASSWORD|API_?KEY)/i` with `[REDACTED]`.

- [ ] **Step 1: Failing tests**

`blackboard.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Store } from "../../server/src/store.js";
import { publishResult, injectSlices } from "../src/index.js";

const setup = () => { const s = new Store(":memory:"); s.createRun("r", "g", "/x"); return s; };
const task = (needs: string[]) => ({ id: "b", role: "reviewer", runtime: "claude", tier: "mid", goal: "g", dependsOn: ["a"], needs }) as any;

describe("blackboard", () => {
  it("publishes summary and skips empty lists", () => {
    const s = setup();
    const e = publishResult(s, "r", "a", { summary: "did it", filesChanged: ["x.ts"], decisions: [], openQuestions: [] });
    expect(e.map((x) => x.key).sort()).toEqual(["a/files", "a/summary"]);
    expect(s.listEvents("r").filter((x) => x.type === "blackboard_write")).toHaveLength(2);
  });
  it("truncates over-long summaries to the cap", () => {
    const s = setup();
    const [sum] = publishResult(s, "r", "a", { summary: "x".repeat(5000), filesChanged: [], decisions: [], openQuestions: [] });
    expect(sum.body.length).toBeLessThanOrEqual(1200);
    expect(sum.body.endsWith("…")).toBe(true);
  });
  it("turns huge file lists into an artifact_ref", () => {
    const s = setup();
    const files = Array.from({ length: 400 }, (_, i) => `src/file-${i}.ts`);
    const e = publishResult(s, "r", "a", { summary: "s", filesChanged: files, decisions: [], openQuestions: [] });
    const f = e.find((x) => x.key === "a/files")!;
    expect(f.kind).toBe("artifact_ref");
    expect(f.refs).toHaveLength(20);
  });
  it("injects only needed keys, latest version, and logs reads", () => {
    const s = setup();
    publishResult(s, "r", "a", { summary: "v1", filesChanged: [], decisions: ["d"], openQuestions: [] });
    publishResult(s, "r", "a", { summary: "v2", filesChanged: [], decisions: ["d"], openQuestions: [] });
    const { slices, missing } = injectSlices(s, "r", task(["a/summary", "a/nope"]));
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ key: "a/summary", version: 2, body: "v2" });
    expect(missing).toEqual(["a/nope"]);
    const reads = s.listEvents("r").filter((x) => x.type === "blackboard_read");
    expect(reads).toHaveLength(1);
    expect(reads[0].payload).toMatchObject({ key: "a/summary", version: 2 });
  });
});
```
`prompt.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/index.js";
const t = { id: "b", role: "reviewer", runtime: "claude", tier: "mid", goal: "Review the diff", dependsOn: [], needs: [] } as any;

describe("buildPrompt", () => {
  it("omits context section when there are no slices", () => {
    expect(buildPrompt(t, [])).not.toContain("Context from earlier tasks");
  });
  it("includes only given slices and the output contract", () => {
    const p = buildPrompt(t, [{ key: "a/summary", version: 1, body: "added foo()", tokens: 3 }]);
    expect(p).toContain("a/summary");
    expect(p).toContain("added foo()");
    expect(p).toContain("Review the diff");
    expect(p).toMatch(/summary.*filesChanged.*decisions.*openQuestions/s);
  });
  it("keeps goals with quotes/unicode/newlines verbatim", () => {
    const g = 'Fix "naïve" bug\nin `x y/z`';
    expect(buildPrompt({ ...t, goal: g }, [])).toContain(g);
  });
});
```
`redact.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { redact } from "../src/index.js";
describe("redact", () => {
  it("masks common secret shapes", () => {
    const out = redact("key sk-abc1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAABCDEFGHIJKLMNOP Bearer abc.def.ghi DB_PASSWORD=hunter2 name=bob");
    expect(out).not.toMatch(/sk-abc|ghp_abc|AKIAABC|abc\.def|hunter2/);
    expect(out).toContain("name=bob");
  });
});
```

- [ ] **Step 2: Verify fail**: `pnpm vitest run packages/orchestrator` → FAIL.

- [ ] **Step 3: Implement**

`redact.ts`:
```ts
const PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY)[A-Z0-9_]*)=\S+/gi, "$1=[REDACTED]"],
];
export const redact = (s: string): string => PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), s);
```
`blackboard.ts`:
```ts
import { MAX_BB_BODY_CHARS, estimateTokens, type BbEntry, type TaskResult, type TaskSpec } from "@mar/core";
import type { Store } from "../../server/src/store.js";

const clip = (s: string) => (s.length <= MAX_BB_BODY_CHARS ? s : s.slice(0, MAX_BB_BODY_CHARS - 1) + "…");

export function publishResult(store: Store, runId: string, taskId: string, r: TaskResult): BbEntry[] {
  const out: BbEntry[] = [];
  const put = (suffix: string, kind: BbEntry["kind"], body: string, refs: string[] = []) => {
    const e = store.writeBb({ run_id: runId, key: `${taskId}/${suffix}`, author_task: taskId, kind, body: clip(body), refs });
    store.appendEvent({ run_id: runId, task_id: taskId, agent_id: taskId, type: "blackboard_write", payload: { key: e.key, version: e.version, kind } });
    out.push(e);
  };
  put("summary", "summary", r.summary);
  if (r.decisions.length) put("decisions", "decision", r.decisions.map((d) => `- ${d}`).join("\n"));
  if (r.openQuestions.length) put("open_questions", "open_question", r.openQuestions.map((q) => `- ${q}`).join("\n"));
  if (r.filesChanged.length) {
    const list = r.filesChanged.join("\n");
    if (list.length <= MAX_BB_BODY_CHARS) put("files", "file_change", list, r.filesChanged);
    else put("files", "artifact_ref", `${r.filesChanged.length} files changed; see refs`, r.filesChanged.slice(0, 20));
  }
  return out;
}

export function injectSlices(store: Store, runId: string, task: TaskSpec) {
  const slices: { key: string; version: number; body: string; tokens: number }[] = [];
  const missing: string[] = [];
  for (const key of task.needs) {
    const e = store.latestBb(runId, key);
    if (!e) { missing.push(key); continue; }
    const tokens = estimateTokens(e.body);
    slices.push({ key, version: e.version, body: e.body, tokens });
    store.appendEvent({ run_id: runId, task_id: task.id, agent_id: task.id, type: "blackboard_read", payload: { key, version: e.version, tokens, author: e.author_task } });
  }
  return { slices, missing };
}
```
`prompt.ts`:
```ts
import type { TaskSpec } from "@mar/core";

type Slice = { key: string; version: number; body: string; tokens: number };

export function buildPrompt(task: TaskSpec, slices: Slice[]): string {
  const ctx = slices.length
    ? `\n## Context from earlier tasks\n${slices.map((s) => `### ${s.key}\n${s.body}`).join("\n\n")}\n`
    : "";
  return `You are a ${task.role} working in an isolated git worktree. Do only this task.

## Task
${task.goal}
${ctx}
## Output contract
When finished, reply with ONLY a JSON object: {"summary": string (<=900 chars), "filesChanged": string[], "decisions": string[], "openQuestions": string[]}.
Keep it terse; do not restate the task or paste code.`;
}
```
`index.ts` re-exports blackboard, prompt, redact. Add `@mar/core` dep to orchestrator package.json.

- [ ] **Step 4: Verify pass**: `pnpm vitest run packages/orchestrator` → PASS.
- [ ] **Step 5: Commit**: `git commit -am "feat(orchestrator): blackboard slicing, prompt builder, redaction"` (after `git add -A`).

---

### Task 4: Adapter interface, budget tracker, scheduler (fake adapter)

**Files:**
- Create: `packages/adapters/{package.json,tsconfig.json}`, `packages/adapters/src/{types.ts,index.ts}`
- Create: `packages/orchestrator/src/{budget.ts,scheduler.ts}`
- Test: `packages/orchestrator/test/{budget.test.ts,scheduler.test.ts}`, helper `packages/orchestrator/test/fakeAdapter.ts`

**Interfaces:**
- Consumes: `Store`, `parseDag`/`Dag`, `publishResult`, `injectSlices`, `buildPrompt`, `redact`, `TaskResultSchema`
- Produces (`@mar/adapters` `types.ts`):
```ts
export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError?: boolean }
  | { type: "usage"; input: number | null; output: number | null; cached: number | null; costUsd: number | null }
  | { type: "result"; text: string };            // final raw text (JSON per output contract)
export interface AdapterInput {
  taskId: string; prompt: string; cwd: string; model: string | null;
  allowedTools: string[]; signal: AbortSignal; maxBudgetUsd?: number; unsafe?: boolean;
}
export interface Adapter { runtime: Runtime; run(i: AdapterInput): AsyncIterable<AgentEvent>; }
export class AdapterError extends Error {}
```
- Produces (`budget.ts`): `class BudgetTracker { constructor(capTokens: number | undefined); add(u: {input: number|null; output: number|null}): void; get used(): number; get exceeded(): boolean }` — nulls count 0; cap `undefined` never exceeds.
- Produces (`scheduler.ts`):
```ts
export interface RunDeps {
  store: Store; runId: string; dag: Dag; repo: string;
  adapters: Record<Runtime, Adapter>;
  worktrees: { create(taskId: string): Promise<string>; commit(taskId: string, message: string): Promise<void>; remove(taskId: string): Promise<void> };
  modelFor(runtime: Runtime, tier: Tier): string | null;
  toolsFor(role: Role): string[];
  concurrency: number; defaultBudgetTokens?: number; unsafe?: boolean;
  maxAttempts?: number;                     // attempts per worker task; default 1 (no retry)
  repairResult?: (raw: string) => Promise<string>;   // cheap JSON-repair call; optional
  signal?: AbortSignal;
}
export async function runDag(d: RunDeps): Promise<Record<string, "done"|"failed"|"blocked">>
```
Behavior: ready = all `dependsOn` done; run up to `concurrency` at once. Per task: status `running`; emit `task_started`; compute slices (a `missing` key fails the task with detail `missing:<key>`); emit `prompt_sent` `{prompt: redact(prompt), keys, tokens}`; consume adapter events → `assistant_text|tool_call|tool_result|usage` events (text/output redacted); on budget exceeded abort the task's AbortController and fail with detail `failed:budget` (no retry); on `result` parse JSON with `TaskResultSchema` (strip ```json fences); if invalid and `repairResult` provided, one repair attempt; else fail `bad-result`. Success → `publishResult`, `task_finished`, status `done`. Each worker task gets `maxAttempts` attempts (default **1: a task runs once, no retry**; opt-in via config). With `maxAttempts` > 1 a retry appends `\n\nPrevious attempt failed: <short error>` (error ≤ 300 chars). Final failure → `task_failed`, status `failed`. Dependents of failed/blocked tasks → status `blocked`, never started; independent branches continue. Worktree removed in `finally`. Already-`done` tasks in the store (resume) are skipped and treated as done.

- [ ] **Step 1: Write fake adapter + failing tests**

`test/fakeAdapter.ts`:
```ts
import type { Adapter, AdapterInput, AgentEvent } from "../../adapters/src/types.js";

export type Script = (i: AdapterInput, attempt: number) => AgentEvent[] | Error;
export function fakeAdapter(script: Script, runtime: "claude" | "codex" = "claude") {
  const attempts = new Map<string, number>(); const calls: AdapterInput[] = [];
  const adapter: Adapter = {
    runtime,
    async *run(i) {
      calls.push(i);
      const n = (attempts.get(i.taskId) ?? 0) + 1; attempts.set(i.taskId, n);
      const out = script(i, n);
      if (out instanceof Error) throw out;
      for (const e of out) { if (i.signal.aborted) return; yield e; }
    },
  };
  return { adapter, calls, attempts };
}
export const ok = (summary = "done") => [
  { type: "usage", input: 10, output: 5, cached: null, costUsd: null },
  { type: "result", text: JSON.stringify({ summary, filesChanged: [], decisions: [], openQuestions: [] }) },
] as AgentEvent[];
```
`budget.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { BudgetTracker } from "../src/budget.js";
describe("BudgetTracker", () => {
  it("sums usage and flags exceed", () => {
    const b = new BudgetTracker(100);
    b.add({ input: 60, output: 30 }); expect(b.exceeded).toBe(false);
    b.add({ input: 5, output: 10 }); expect(b.exceeded).toBe(true);
  });
  it("treats nulls as zero and undefined cap as unlimited", () => {
    const b = new BudgetTracker(undefined);
    b.add({ input: null, output: null }); b.add({ input: 1e9, output: 1e9 });
    expect(b.exceeded).toBe(false);
    expect(new BudgetTracker(10).used).toBe(0);
  });
});
```
`scheduler.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Store } from "../../server/src/store.js";
import { parseDag } from "@mar/core";
import { runDag } from "../src/scheduler.js";
import { fakeAdapter, ok } from "./fakeAdapter.js";

const T = (id: string, extra: object = {}) => ({ id, role: "implementer", runtime: "claude", tier: "mid", goal: `do ${id}`, ...extra });
function harness(tasks: any[], script: any, over: object = {}) {
  const store = new Store(":memory:"); store.createRun("r", "g", "/repo");
  const f = fakeAdapter(script);
  const deps = {
    store, runId: "r", dag: parseDag({ tasks }), repo: "/repo",
    adapters: { claude: f.adapter, codex: f.adapter },
    worktrees: { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {} },
    modelFor: () => null, toolsFor: () => ["Read"], concurrency: 2, ...over,
  };
  return { store, f, deps };
}

describe("runDag", () => {
  it("runs in dependency order and passes only needed slices", async () => {
    const { store, f, deps } = harness([T("a"), T("b", { dependsOn: ["a"], needs: ["a/summary"] })], () => ok("A-RESULT"));
    const res = await runDag(deps);
    expect(res).toEqual({ a: "done", b: "done" });
    const bPrompt = f.calls.find((c) => c.taskId === "b")!.prompt;
    expect(bPrompt).toContain("A-RESULT");
    expect(f.calls.find((c) => c.taskId === "a")!.prompt).not.toContain("Context from earlier tasks");
    expect(store.listEvents("r").some((e) => e.type === "blackboard_read" && e.task_id === "b")).toBe(true);
  });
  it("respects the concurrency limit", async () => {
    let live = 0, peak = 0;
    const { deps } = harness([T("a"), T("b"), T("c"), T("d")], (i: any) => { live++; peak = Math.max(peak, live); queueMicrotask(() => {}); return ok(); }, { concurrency: 2 });
    const orig = deps.adapters.claude.run.bind(deps.adapters.claude);
    deps.adapters.claude = { runtime: "claude", async *run(i: any) { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); yield* orig(i); live--; } } as any;
    await runDag(deps);
    expect(peak).toBeLessThanOrEqual(2);
  });
  it("runs a task once by default (no retry)", async () => {
    const { f, deps } = harness([T("a")], () => new Error("boom"));
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(f.calls).toHaveLength(1);
  });
  it("retries with the error summary when maxAttempts is 2", async () => {
    const { f, deps } = harness([T("a")], (_i: any, n: number) => (n === 1 ? new Error("boom") : ok()), { maxAttempts: 2 });
    expect(await runDag(deps)).toEqual({ a: "done" });
    expect(f.calls[1].prompt).toContain("Previous attempt failed: boom");
  });
  it("fails on the single attempt, blocks dependents, runs independents", async () => {
    const { store, deps } = harness([T("a"), T("b", { dependsOn: ["a"] }), T("c")], (i: any) => (i.taskId === "a" ? new Error("nope") : ok()));
    expect(await runDag(deps)).toEqual({ a: "failed", b: "blocked", c: "done" });
    expect(store.taskStatuses("r").find((s) => s.task_id === "b")?.status).toBe("blocked");
  });
  it("kills on budget with failed:budget and does not retry", async () => {
    const big = [{ type: "usage", input: 500, output: 500, cached: null, costUsd: null }, { type: "assistant_text", text: "more" }];
    const { store, f, deps } = harness([T("a", { budgetTokens: 100 })], () => big as any);
    expect(await runDag(deps)).toEqual({ a: "failed" });
    expect(f.calls).toHaveLength(1);
    expect(store.taskStatuses("r")[0].detail).toBe("failed:budget");
  });
  it("commits the worktree before removing it, and a commit failure fails the task", async () => {
    const order: string[] = [];
    const wt = { create: async (id: string) => `/wt/${id}`, commit: async (id: string) => { order.push(`commit:${id}`); }, remove: async (id: string) => { order.push(`remove:${id}`); } };
    expect(await runDag(harness([T("a")], () => ok(), { worktrees: wt }).deps)).toEqual({ a: "done" });
    expect(order).toEqual(["commit:a", "remove:a"]);
    const bad = { ...wt, commit: async () => { throw new Error("commit failed"); } };
    expect(await runDag(harness([T("a")], () => ok(), { worktrees: bad }).deps)).toEqual({ a: "failed" });
  });
  it("works when the adapter reports no usage at all", async () => {
    const { deps } = harness([T("a", { budgetTokens: 5 })], () => [{ type: "result", text: JSON.stringify({ summary: "s" }) }] as any);
    expect(await runDag(deps)).toEqual({ a: "done" });
  });
  it("repairs a malformed result once, else fails", async () => {
    const bad = () => [{ type: "result", text: "not json" }] as any;
    const fixed = harness([T("a")], bad, { repairResult: async () => JSON.stringify({ summary: "fixed" }) });
    expect(await runDag(fixed.deps)).toEqual({ a: "done" });
    const unfixed = harness([T("a")], bad);
    expect(await runDag(unfixed.deps)).toEqual({ a: "failed" });
  });
  it("accepts results wrapped in a json code fence", async () => {
    const fenced = () => [{ type: "result", text: "```json\n{\"summary\":\"s\"}\n```" }] as any;
    expect(await runDag(harness([T("a")], fenced).deps)).toEqual({ a: "done" });
  });
  it("skips tasks already done in the store (resume)", async () => {
    const { store, f, deps } = harness([T("a"), T("b", { dependsOn: ["a"] })], () => ok());
    store.setTaskStatus("r", "a", "done");
    expect(await runDag(deps)).toEqual({ a: "done", b: "done" });
    expect(f.calls.map((c) => c.taskId)).toEqual(["b"]);
  });
  it("redacts secrets in logged prompts", async () => {
    const { store, deps } = harness([T("a", { goal: "use DB_PASSWORD=hunter2" })], () => ok());
    await runDag(deps);
    const p = store.listEvents("r").find((e) => e.type === "prompt_sent")!;
    expect(JSON.stringify(p.payload)).not.toContain("hunter2");
  });
});
```

- [ ] **Step 2: Verify fail**: `pnpm vitest run packages/orchestrator` → FAIL.

- [ ] **Step 3: Implement**

`packages/adapters/src/types.ts`: as in Interfaces above (import `Runtime` from `@mar/core`). `index.ts`: `export * from "./types.js";` (extended in Tasks 5/6).

`budget.ts`:
```ts
export class BudgetTracker {
  private total = 0;
  constructor(private cap: number | undefined) {}
  add(u: { input: number | null; output: number | null }) { this.total += (u.input ?? 0) + (u.output ?? 0); }
  get used() { return this.total; }
  get exceeded() { return this.cap !== undefined && this.total > this.cap; }
}
```
`scheduler.ts`:
```ts
import { TaskResultSchema, estimateTokens, type Dag, type Role, type Runtime, type TaskResult, type TaskSpec, type Tier } from "@mar/core";
import type { Adapter } from "@mar/adapters";
import type { Store } from "../../server/src/store.js";
import { BudgetTracker } from "./budget.js";
import { buildPrompt } from "./prompt.js";
import { injectSlices, publishResult } from "./blackboard.js";
import { redact } from "./redact.js";

export interface RunDeps {
  store: Store; runId: string; dag: Dag; repo: string;
  adapters: Record<Runtime, Adapter>;
  worktrees: { create(taskId: string): Promise<string>; commit(taskId: string, message: string): Promise<void>; remove(taskId: string): Promise<void> };
  modelFor(runtime: Runtime, tier: Tier): string | null;
  toolsFor(role: Role): string[];
  concurrency: number; defaultBudgetTokens?: number; unsafe?: boolean;
  maxAttempts?: number;                     // attempts per worker task; default 1 (no retry)
  repairResult?: (raw: string) => Promise<string>;
  signal?: AbortSignal;
}
type Outcome = "done" | "failed" | "blocked";
class TaskFailure extends Error { constructor(m: string, public retryable = true) { super(m); } }

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
async function parseResult(raw: string, repair?: (r: string) => Promise<string>): Promise<TaskResult> {
  const attempt = (s: string) => TaskResultSchema.parse(JSON.parse(stripFence(s)));
  try { return attempt(raw); } catch (e) {
    if (!repair) throw new TaskFailure("bad-result");
    try { return attempt(await repair(raw)); } catch { throw new TaskFailure("bad-result"); }
  }
}

export async function runDag(d: RunDeps): Promise<Record<string, Outcome>> {
  const { store, runId } = d;
  const outcome = new Map<string, Outcome>();
  for (const s of store.taskStatuses(runId)) if (s.status === "done") outcome.set(s.task_id, "done");
  const byId = new Map(d.dag.tasks.map((t) => [t.id, t]));
  const running = new Map<string, Promise<void>>();
  const emit = (task: TaskSpec, type: any, payload: Record<string, unknown> = {}) =>
    store.appendEvent({ run_id: runId, task_id: task.id, agent_id: task.id, type, payload });

  async function attemptOnce(task: TaskSpec, extra: string, budget: BudgetTracker): Promise<TaskResult> {
    const { slices, missing } = injectSlices(store, runId, task);
    if (missing.length) throw new TaskFailure(`missing:${missing[0]}`, false);
    const prompt = buildPrompt(task, slices) + extra;
    emit(task, "prompt_sent", { prompt: redact(prompt), keys: slices.map((s) => s.key), tokens: estimateTokens(prompt) });
    const cwd = await d.worktrees.create(task.id);
    const ac = new AbortController();
    d.signal?.addEventListener("abort", () => ac.abort());
    try {
      let raw: string | undefined;
      for await (const ev of d.adapters[task.runtime].run({
        taskId: task.id, prompt, cwd, model: d.modelFor(task.runtime, task.tier),
        allowedTools: d.toolsFor(task.role), signal: ac.signal, unsafe: d.unsafe,
      })) {
        if (ev.type === "usage") { budget.add(ev); emit(task, "usage", { ...ev }); }
        else if (ev.type === "assistant_text") emit(task, "assistant_text", { text: redact(ev.text) });
        else if (ev.type === "tool_call") emit(task, "tool_call", { name: ev.name, input: JSON.parse(redact(JSON.stringify(ev.input ?? null))) });
        else if (ev.type === "tool_result") emit(task, "tool_result", { name: ev.name, output: redact(ev.output).slice(0, 2000), isError: ev.isError ?? false });
        else raw = ev.text;
        if (budget.exceeded) { ac.abort(); throw new TaskFailure("failed:budget", false); }
      }
      if (raw === undefined) throw new TaskFailure("no-result");
      const res = await parseResult(raw, d.repairResult);
      await d.worktrees.commit(task.id, `mar(${task.id}): ${task.goal.split("\n")[0].slice(0, 60)}`);
      return res;
    } finally {
      await d.worktrees.remove(task.id).catch(() => {});
    }
  }

  async function runTask(task: TaskSpec) {
    store.setTaskStatus(runId, task.id, "running");
    emit(task, "task_started", { runtime: task.runtime, tier: task.tier, role: task.role });
    const budget = new BudgetTracker(task.budgetTokens ?? d.defaultBudgetTokens);
    let extra = "";
    const max = d.maxAttempts ?? 1;
    for (let n = 1; n <= max; n++) {
      try {
        const res = await attemptOnce(task, extra, budget);
        publishResult(store, runId, task.id, res);
        emit(task, "task_finished", { tokens: budget.used });
        store.setTaskStatus(runId, task.id, "done");
        outcome.set(task.id, "done");
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = !(e instanceof TaskFailure) || e.retryable;
        if (n >= max || !retryable) {
          emit(task, "task_failed", { reason: msg.slice(0, 300) });
          store.setTaskStatus(runId, task.id, "failed", msg.slice(0, 300));
          outcome.set(task.id, "failed");
          return;
        }
        extra = `\n\nPrevious attempt failed: ${msg.slice(0, 300)}`;
      }
    }
  }

  while (outcome.size < byId.size) {
    for (const t of byId.values()) {
      if (outcome.has(t.id) || running.has(t.id)) continue;
      if (t.dependsOn.some((x) => outcome.get(x) === "failed" || outcome.get(x) === "blocked")) {
        outcome.set(t.id, "blocked");
        store.setTaskStatus(runId, t.id, "blocked");
      }
    }
    const ready = [...byId.values()].filter(
      (t) => !outcome.has(t.id) && !running.has(t.id) && t.dependsOn.every((x) => outcome.get(x) === "done"),
    );
    for (const t of ready) {
      if (running.size >= d.concurrency || d.signal?.aborted) break;
      const p = runTask(t).finally(() => running.delete(t.id));
      running.set(t.id, p);
    }
    if (running.size === 0) {
      if (d.signal?.aborted) for (const t of byId.values()) if (!outcome.has(t.id)) outcome.set(t.id, "blocked");
      if (outcome.size < byId.size && ready.length === 0 && running.size === 0) break;
      continue;
    }
    await Promise.race(running.values());
  }
  return Object.fromEntries(outcome);
}
```
`orchestrator/src/index.ts`: also export `budget`, `scheduler`. Add `@mar/adapters` dep.

- [ ] **Step 4: Verify pass**: `pnpm vitest run packages/orchestrator && pnpm tsc -b packages/orchestrator` → PASS. If the concurrency test is flaky, increase the delay; do not weaken the assertion.
- [ ] **Step 5: Commit**: `feat(orchestrator): add scheduler, budget tracker and adapter interface`

---

### Task 5: Claude adapter (fixture-driven)

**Files:**
- Create: `packages/adapters/src/{exec.ts,claude.ts}`, `packages/adapters/test/fixtures/claude-basic.jsonl`
- Test: `packages/adapters/test/claude.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `AdapterInput`, `AgentEvent`, `AdapterError`
- Produces:
  - `exec.ts`: `spawnLines(cmd: string, args: string[], opts: { cwd: string; signal: AbortSignal; stdin?: string }): AsyncIterable<string>` — spawns **without a shell**, yields stdout lines, kills child on abort, throws `AdapterError` (with last 300 chars of stderr) on non-zero exit when not aborted.
  - `claude.ts`: `normalizeClaudeLine(line: string): AgentEvent[]` (pure) and `claudeAdapter(bin = "claude"): Adapter`.
  - CLI args: `-p <prompt> --output-format stream-json --verbose --no-session-persistence --allowedTools <csv> [--model m] [--max-budget-usd n] [--permission-mode acceptEdits]`; `unsafe` adds `--dangerously-skip-permissions` (only then). Output schema is requested in the prompt contract (Task 3), not via `--json-schema`, so one code path serves both runtimes.

- [ ] **Step 1: Capture a real fixture** (tiny call; cost well under $0.01):

```bash
cd /tmp && mkdir -p mar-fixture && cd mar-fixture && git init -q 2>/dev/null
claude -p 'Reply with ONLY {"summary":"ok"}' --output-format stream-json --verbose --no-session-persistence --model claude-haiku-4-5-20251001 \
  > <repo>/packages/adapters/test/fixtures/claude-basic.jsonl
```
Open the file and confirm: an `assistant` line with `message.content[].type == "text"` and `message.usage`, and a final `{"type":"result", "result": "...", "usage": {...}, "total_cost_usd": ...}` line. If field names differ, adjust `normalizeClaudeLine` below to match the fixture before continuing. Redact anything sensitive from the fixture (session ids are fine).

- [ ] **Step 2: Failing tests** `claude.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeClaudeLine } from "../src/claude.js";

const lines = readFileSync(new URL("./fixtures/claude-basic.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);

describe("normalizeClaudeLine", () => {
  it("emits exactly one result event with the final text", () => {
    const evs = lines.flatMap(normalizeClaudeLine);
    const results = evs.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect((results[0] as any).text).toContain("summary");
  });
  it("emits a usage event with numeric tokens", () => {
    const u = lines.flatMap(normalizeClaudeLine).find((e) => e.type === "usage") as any;
    expect(typeof u.input === "number" || u.input === null).toBe(true);
    expect("cached" in u && "costUsd" in u).toBe(true);
  });
  it("maps tool_use and tool_result blocks", () => {
    const use = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } });
    const res = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body", is_error: false }] } });
    expect(normalizeClaudeLine(use)).toEqual([{ type: "tool_call", name: "Read", input: { file_path: "a.ts" } }]);
    expect(normalizeClaudeLine(res)).toMatchObject([{ type: "tool_result", output: "file body", isError: false }]);
  });
  it("ignores blank, non-JSON and unknown lines without throwing", () => {
    expect(normalizeClaudeLine("")).toEqual([]);
    expect(normalizeClaudeLine("garbage")).toEqual([]);
    expect(normalizeClaudeLine('{"type":"system","subtype":"init"}')).toEqual([]);
  });
});
```
Also `packages/adapters/test/exec.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { spawnLines } from "../src/exec.js";

describe("spawnLines", () => {
  it("passes args verbatim without a shell (spaces, quotes, unicode)", async () => {
    const arg = `it's "tricky" ñ $HOME; echo pwned`;
    const out: string[] = [];
    for await (const l of spawnLines("node", ["-e", "console.log(process.argv[1])", arg], { cwd: process.cwd(), signal: new AbortController().signal })) out.push(l);
    expect(out).toEqual([arg]);
  });
  it("throws AdapterError with stderr on non-zero exit", async () => {
    const run = async () => { for await (const _ of spawnLines("node", ["-e", "console.error('bad'); process.exit(3)"], { cwd: process.cwd(), signal: new AbortController().signal })); };
    await expect(run()).rejects.toThrow(/bad/);
  });
  it("kills the child on abort", async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 50);
    const start = Date.now();
    for await (const _ of spawnLines("node", ["-e", "setTimeout(()=>{},10000)"], { cwd: process.cwd(), signal: ac.signal }));
    clearTimeout(t);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
```

- [ ] **Step 3: Verify fail**: `pnpm vitest run packages/adapters` → FAIL.

- [ ] **Step 4: Implement**

`exec.ts`:
```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AdapterError } from "./types.js";

export async function* spawnLines(cmd: string, args: string[], opts: { cwd: string; signal: AbortSignal; stdin?: string }): AsyncIterable<string> {
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stderr = "";
  child.stderr.on("data", (b) => { stderr = (stderr + b.toString()).slice(-2000); });
  const onAbort = () => child.kill("SIGTERM");
  if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true });
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin); else child.stdin.end();
  const exit = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
  child.on("error", () => {});
  try {
    for await (const line of createInterface({ input: child.stdout })) yield line;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  const code = await exit;
  if (code !== 0 && !opts.signal.aborted) throw new AdapterError(`${cmd} exited ${code}: ${stderr.slice(-300)}`);
}
```
`claude.ts`:
```ts
import type { Adapter, AdapterInput, AgentEvent } from "./types.js";
import { spawnLines } from "./exec.js";

const num = (v: unknown) => (typeof v === "number" ? v : null);

export function normalizeClaudeLine(line: string): AgentEvent[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  if (!j || typeof j !== "object") return [];
  const out: AgentEvent[] = [];
  if (j.type === "assistant") {
    for (const b of j.message?.content ?? []) {
      if (b.type === "text" && b.text) out.push({ type: "assistant_text", text: b.text });
      else if (b.type === "tool_use") out.push({ type: "tool_call", name: b.name, input: b.input });
    }
  } else if (j.type === "user") {
    for (const b of j.message?.content ?? []) {
      if (b.type === "tool_result") {
        const output = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        out.push({ type: "tool_result", name: b.tool_use_id ?? "", output, isError: !!b.is_error });
      }
    }
  } else if (j.type === "result") {
    const u = j.usage ?? {};
    out.push({ type: "usage", input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens), costUsd: num(j.total_cost_usd) });
    out.push({ type: "result", text: typeof j.result === "string" ? j.result : "" });
  }
  return out;
}

export function claudeAdapter(bin = "claude"): Adapter {
  return {
    runtime: "claude",
    async *run(i: AdapterInput) {
      const args = ["-p", i.prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence",
        "--allowedTools", i.allowedTools.join(",")];
      if (i.model) args.push("--model", i.model);
      if (i.maxBudgetUsd) args.push("--max-budget-usd", String(i.maxBudgetUsd));
      args.push(...(i.unsafe ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]));
      for await (const line of spawnLines(bin, args, { cwd: i.cwd, signal: i.signal })) yield* normalizeClaudeLine(line);
    },
  };
}
```
Export both from `adapters/src/index.ts`.

- [ ] **Step 5: Verify pass**: `pnpm vitest run packages/adapters && pnpm tsc -b packages/adapters` → PASS.
- [ ] **Step 6: Commit**: `feat(adapters): add claude adapter and shell-free process runner`

---

### Task 6: Codex adapter (fixture-driven)

**Files:**
- Create: `packages/adapters/src/codex.ts`, `packages/adapters/test/fixtures/codex-basic.jsonl`
- Test: `packages/adapters/test/codex.test.ts`

**Interfaces:**
- Produces: `normalizeCodexLine(line: string): AgentEvent[]`, `codexAdapter(bin = "codex"): Adapter`.
- CLI args: `exec --json --skip-git-repo-check --sandbox <read-only|workspace-write> -C <cwd> [-m model] <prompt>`; sandbox is `read-only` when `allowedTools` contains no `Edit`/`Write`, else `workspace-write`. `unsafe` is **not** mapped for Codex (never passes `--dangerously-bypass-approvals-and-sandbox`); unsupported for v1.

- [ ] **Step 1: Capture fixture** (tiny call):

```bash
cd /tmp/mar-fixture && codex exec --json --skip-git-repo-check --sandbox read-only 'Reply with ONLY {"summary":"ok"}' \
  > <repo>/packages/adapters/test/fixtures/codex-basic.jsonl
```
Inspect: expect an `item.completed` line with `item.type == "agent_message"` and `item.text`, and a `turn.completed` line with `usage.{input_tokens,cached_input_tokens,output_tokens}`. If names differ, adapt the normalizer to the fixture.

- [ ] **Step 2: Failing tests** `codex.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeCodexLine } from "../src/codex.js";

const lines = readFileSync(new URL("./fixtures/codex-basic.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);

describe("normalizeCodexLine", () => {
  it("emits a result from the last agent message", () => {
    const evs = lines.flatMap(normalizeCodexLine);
    const r = evs.filter((e) => e.type === "result");
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect((r.at(-1) as any).text).toContain("summary");
  });
  it("emits usage with cached tokens when reported", () => {
    const u = lines.flatMap(normalizeCodexLine).find((e) => e.type === "usage") as any;
    expect(u).toBeTruthy();
    expect(u.costUsd).toBeNull();
  });
  it("maps command_execution items to tool_call/tool_result", () => {
    const l = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "a\nb", exit_code: 0 } });
    expect(normalizeCodexLine(l)).toMatchObject([{ type: "tool_call", name: "shell" }, { type: "tool_result", output: "a\nb", isError: false }]);
  });
  it("ignores garbage and unknown events", () => {
    expect(normalizeCodexLine("")).toEqual([]);
    expect(normalizeCodexLine("{")).toEqual([]);
    expect(normalizeCodexLine('{"type":"thread.started"}')).toEqual([]);
  });
});
```
The scheduler treats the **last** `result` event as final (Task 4 loop assigns `raw` on every `result`, so later ones overwrite earlier ones).

- [ ] **Step 3: Verify fail**; **Step 4: Implement** `codex.ts`:

```ts
import type { Adapter, AdapterInput, AgentEvent } from "./types.js";
import { spawnLines } from "./exec.js";

const num = (v: unknown) => (typeof v === "number" ? v : null);

export function normalizeCodexLine(line: string): AgentEvent[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  if (!j || typeof j !== "object") return [];
  if (j.type === "item.completed" && j.item) {
    const it = j.item;
    if (it.type === "agent_message" && it.text) return [{ type: "assistant_text", text: it.text }, { type: "result", text: it.text }];
    if (it.type === "command_execution")
      return [
        { type: "tool_call", name: "shell", input: { command: it.command } },
        { type: "tool_result", name: "shell", output: String(it.aggregated_output ?? ""), isError: (it.exit_code ?? 0) !== 0 },
      ];
  }
  if (j.type === "turn.completed") {
    const u = j.usage ?? {};
    return [{ type: "usage", input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cached_input_tokens), costUsd: null }];
  }
  return [];
}

export function codexAdapter(bin = "codex"): Adapter {
  return {
    runtime: "codex",
    async *run(i: AdapterInput) {
      const writes = i.allowedTools.some((t) => /^(Edit|Write)/.test(t));
      const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", writes ? "workspace-write" : "read-only", "-C", i.cwd];
      if (i.model) args.push("-m", i.model);
      args.push(i.prompt);
      for await (const line of spawnLines(bin, args, { cwd: i.cwd, signal: i.signal })) yield* normalizeCodexLine(line);
    },
  };
}
```
Export from index.

- [ ] **Step 5: Verify pass**: `pnpm vitest run packages/adapters` → PASS. **Step 6: Commit**: `feat(adapters): add codex adapter`

---

### Task 7: Worktree manager, config, preflight

**Files:**
- Create: `packages/orchestrator/src/worktree.ts`, `packages/cli/{package.json,tsconfig.json}`, `packages/cli/src/{config.ts,preflight.ts}`
- Test: `packages/orchestrator/test/worktree.test.ts`, `packages/cli/test/{preflight.test.ts,config.test.ts}`

**Interfaces:**
- Produces:
  - `createWorktrees(repo: string, runId: string): { create(taskId): Promise<string>; commit(taskId, message): Promise<void>; remove(taskId): Promise<void>; branchFor(taskId): string }` — branch `mar/<runId>/<taskId>`; dir `<repo>/.mar/worktrees/<runId>/<taskId>` (`.mar/` is gitignored); `remove` removes the **directory** only and keeps the branch (results stay on per-task branches). Never copies `.env*`. Throws if `runId`/`taskId` fail `/^[A-Za-z0-9_-]+$/`.
  - `loadConfig(repo: string): MarConfig` — optional `<repo>/.mar.json`; defaults: `{ concurrency: 3, maxAttempts: 1, defaultBudgetTokens: 200000, plannerModel: "claude-sonnet-5-5", tiers: { claude: { low: "claude-haiku-4-5-20251001", mid: "claude-sonnet-5-5", high: "claude-sonnet-5-5" }, codex: { low: null, mid: null, high: null } } }`; validated with zod; unknown keys rejected.
  - `preflight(repo: string, run: (cmd, args) => Promise<{code:number; out:string}>): Promise<string[]>` — returns a list of problems (empty = OK): repo not a git work tree; working tree dirty (`git status --porcelain` non-empty); `claude --version` / `codex --version` fail. (Auth is verified lazily by the first call; documented.)

- [ ] **Step 1: Failing tests**

`worktree.test.ts` (real git in a temp repo):
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktrees } from "../src/worktree.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mar-wt-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  g("init", "-q", "-b", "feat/x"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "1"); writeFileSync(join(repo, ".env"), "SECRET=1"); writeFileSync(join(repo, ".gitignore"), ".env\n.mar/\n");
  g("add", "a.txt", ".gitignore"); g("commit", "-qm", "init");
});

describe("worktrees", () => {
  it("creates isolated worktrees on per-task branches and never copies .env", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a"), b = await w.create("b");
    expect(a).not.toBe(b);
    expect(existsSync(join(a, "a.txt"))).toBe(true);
    expect(existsSync(join(a, ".env"))).toBe(false);
    writeFileSync(join(a, "only-a.txt"), "x");
    expect(existsSync(join(b, "only-a.txt"))).toBe(false);
  });
  it("remove deletes the dir but keeps the branch", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a");
    await w.remove("a");
    expect(existsSync(a)).toBe(false);
    expect(execFileSync("git", ["branch", "--list", "mar/run1/a"], { cwd: repo }).toString()).toContain("mar/run1/a");
  });
  it("commit saves worktree changes to the task branch so remove does not lose them; clean tree is a no-op", async () => {
    const w = createWorktrees(repo, "run1");
    const a = await w.create("a");
    await w.commit("a", "noop");
    expect(execFileSync("git", ["rev-list", "--count", "mar/run1/a"], { cwd: repo }).toString().trim()).toBe("1");
    writeFileSync(join(a, "only-a.txt"), "x");
    await w.commit("a", "mar(a): add file");
    await w.remove("a");
    expect(execFileSync("git", ["show", "mar/run1/a:only-a.txt"], { cwd: repo }).toString()).toBe("x");
  });
  it("rejects unsafe ids", async () => {
    const w = createWorktrees(repo, "run1");
    await expect(w.create("../evil")).rejects.toThrow(/invalid/i);
  });
  it("handles repo paths with spaces", async () => {
    const spaced = join(mkdtempSync(join(tmpdir(), "mar sp-")), "my repo");
    execFileSync("mkdir", ["-p", spaced]);
    const g = (...a: string[]) => execFileSync("git", a, { cwd: spaced });
    g("init", "-q", "-b", "feat/x"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(spaced, "a.txt"), "1"); writeFileSync(join(spaced, ".gitignore"), ".mar/\n"); g("add", "."); g("commit", "-qm", "i");
    const dir = await createWorktrees(spaced, "r").create("a");
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
  });
});
```
`preflight.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { preflight } from "../src/preflight.js";

const runner = (map: Record<string, { code: number; out: string }>) => async (cmd: string, args: string[]) => map[`${cmd} ${args.join(" ")}`] ?? { code: 1, out: "" };
const good = {
  "git rev-parse --is-inside-work-tree": { code: 0, out: "true" },
  "git status --porcelain": { code: 0, out: "" },
  "claude --version": { code: 0, out: "2.1.289" }, "codex --version": { code: 0, out: "0.156.1" },
};

describe("preflight", () => {
  it("passes when everything is present", async () => { expect(await preflight("/r", runner(good))).toEqual([]); });
  it("fails for a non-git directory", async () => {
    expect((await preflight("/r", runner({ ...good, "git rev-parse --is-inside-work-tree": { code: 128, out: "" } }))).join()).toMatch(/not a git/i);
  });
  it("fails for a dirty tree", async () => {
    expect((await preflight("/r", runner({ ...good, "git status --porcelain": { code: 0, out: " M a.ts" } }))).join()).toMatch(/uncommitted|dirty/i);
  });
  it("reports each missing CLI", async () => {
    const p = await preflight("/r", runner({ ...good, "claude --version": { code: 127, out: "" }, "codex --version": { code: 127, out: "" } }));
    expect(p.join()).toMatch(/claude/); expect(p.join()).toMatch(/codex/);
  });
});
```
`config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { loadConfig } from "../src/config.js";
describe("loadConfig", () => {
  it("returns defaults with no file; planner defaults to sonnet, never opus", () => {
    const c = loadConfig(mkdtempSync(join(tmpdir(), "mar-c-")));
    expect(c.plannerModel).toMatch(/sonnet/);
    expect(JSON.stringify(c)).not.toMatch(/opus/i);
  });
  it("merges overrides and rejects unknown keys", () => {
    const d = mkdtempSync(join(tmpdir(), "mar-c-"));
    writeFileSync(join(d, ".mar.json"), JSON.stringify({ concurrency: 1 }));
    expect(loadConfig(d).concurrency).toBe(1);
    writeFileSync(join(d, ".mar.json"), JSON.stringify({ nope: 1 }));
    expect(() => loadConfig(d)).toThrow();
  });
});
```

- [ ] **Step 2: Verify fail**. **Step 3: Implement**

`worktree.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const run = promisify(execFile);
const SAFE = /^[A-Za-z0-9_-]+$/;

export function createWorktrees(repo: string, runId: string) {
  if (!SAFE.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const dirFor = (t: string) => join(repo, ".mar", "worktrees", runId, t);
  const branchFor = (t: string) => `mar/${runId}/${t}`;
  const check = (t: string) => { if (!SAFE.test(t)) throw new Error(`invalid task id: ${t}`); };
  return {
    branchFor,
    async create(taskId: string) {
      check(taskId);
      const dir = dirFor(taskId);
      await run("git", ["worktree", "add", "-b", branchFor(taskId), dir, "HEAD"], { cwd: repo });
      return dir;
    },
    async commit(taskId: string, message: string) {
      check(taskId);
      const cwd = dirFor(taskId);
      await run("git", ["add", "-A"], { cwd });
      const { stdout } = await run("git", ["status", "--porcelain"], { cwd });
      if (!stdout.trim()) return;
      await run("git", ["-c", "user.name=mar", "-c", "user.email=mar@localhost", "commit", "-m", message], { cwd });
    },
    async remove(taskId: string) {
      check(taskId);
      await run("git", ["worktree", "remove", "--force", dirFor(taskId)], { cwd: repo }).catch(() => {});
      await rm(dirFor(taskId), { recursive: true, force: true });
    },
  };
}
```
`config.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const tiers = z.object({ low: z.string().nullable(), mid: z.string().nullable(), high: z.string().nullable() }).strict();
const Schema = z.object({
  concurrency: z.number().int().positive().default(3),
  maxAttempts: z.number().int().min(1).max(3).default(1),
  defaultBudgetTokens: z.number().int().positive().default(200000),
  plannerModel: z.string().default("claude-sonnet-5-5"),
  tiers: z.object({ claude: tiers, codex: tiers }).strict().default({
    claude: { low: "claude-haiku-4-5-20251001", mid: "claude-sonnet-5-5", high: "claude-sonnet-5-5" },
    codex: { low: null, mid: null, high: null },
  }),
}).strict();
export type MarConfig = z.infer<typeof Schema>;

export function loadConfig(repo: string): MarConfig {
  const p = join(repo, ".mar.json");
  return Schema.parse(existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
}
```
`preflight.ts`:
```ts
type Runner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

export async function preflight(repo: string, run: Runner): Promise<string[]> {
  const problems: string[] = [];
  const inRepo = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.code !== 0) problems.push(`${repo} is not a git repository`);
  else {
    const st = await run("git", ["status", "--porcelain"]);
    if (st.out.trim()) problems.push("working tree has uncommitted changes; commit or stash first");
  }
  for (const bin of ["claude", "codex"]) {
    const r = await run(bin, ["--version"]);
    if (r.code !== 0) problems.push(`${bin} CLI not found or not runnable`);
  }
  return problems;
}
```
(The CLI's real runner passes `cwd: repo`; the `Runner` signature is cwd-bound by the caller in Task 10.)

- [ ] **Step 4: Verify pass**: `pnpm vitest run packages/orchestrator packages/cli` → PASS. **Step 5: Commit**: `feat: worktrees, config and preflight`

---

### Task 8: Planner

**Files:**
- Create: `packages/orchestrator/src/planner.ts`
- Test: `packages/orchestrator/test/planner.test.ts`

**Interfaces:**
- Consumes: `parseDag`, `Dag`, `Adapter`
- Produces:
  - `repoMap(repo: string, maxChars = 6000): string` — `git ls-files` output (via `execFileSync`, no shell), trimmed to `maxChars` with a trailing `… (+N more files)` line; excludes lockfiles and `*.min.*`.
  - `planGoal(args: { goal: string; repoMap: string; adapter: Adapter; model: string | null; cwd: string; signal?: AbortSignal }): Promise<Dag>` — one call to the Claude adapter with a fixed planner prompt (task schema + rules: ≤8 tasks, prefer `claude` for planning/review and `codex` for bulk implementation, give each task a `needs` list limited to ancestors' `<id>/summary` or `<id>/files`, no extra prose), read-only tools (`Read`, `Glob`, `Grep`); parses the final `result` text with fence stripping and `parseDag`; on invalid output, one repair retry feeding the validation error (≤300 chars) back; then throws `PlanError`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { planGoal } from "../src/planner.js";
import { fakeAdapter } from "./fakeAdapter.js";

const valid = { tasks: [{ id: "impl", role: "implementer", runtime: "codex", tier: "mid", goal: "x" }, { id: "rev", role: "reviewer", runtime: "claude", tier: "mid", goal: "y", dependsOn: ["impl"], needs: ["impl/summary"] }] };
const run = (script: any) => { const f = fakeAdapter(script); return { f, p: planGoal({ goal: 'add "x" feature', repoMap: "a.ts", adapter: f.adapter, model: null, cwd: "/r" }) }; };

describe("planGoal", () => {
  it("returns a validated DAG", async () => {
    const { p } = run(() => [{ type: "result", text: JSON.stringify(valid) }]);
    expect((await p).tasks.map((t) => t.id)).toEqual(["impl", "rev"]);
  });
  it("accepts fenced JSON", async () => {
    const { p } = run(() => [{ type: "result", text: "```json\n" + JSON.stringify(valid) + "\n```" }]);
    await expect(p).resolves.toBeTruthy();
  });
  it("retries once with the validation error, then succeeds", async () => {
    const bad = { tasks: [{ ...valid.tasks[0], dependsOn: ["ghost"] }] };
    const { f, p } = run((_i: any, n: number) => [{ type: "result", text: JSON.stringify(n === 1 ? bad : valid) }]);
    await p;
    expect(f.calls[1].prompt).toContain("ghost");
  });
  it("throws PlanError after the retry also fails", async () => {
    const { p } = run(() => [{ type: "result", text: "nonsense" }]);
    await expect(p).rejects.toThrow(/plan/i);
  });
  it("only allows read-only tools and includes the goal verbatim", async () => {
    const { f, p } = run(() => [{ type: "result", text: JSON.stringify(valid) }]);
    await p;
    expect(f.calls[0].allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(f.calls[0].prompt).toContain('add "x" feature');
  });
});
```

- [ ] **Step 2: Verify fail**. **Step 3: Implement** `planner.ts`:

```ts
import { execFileSync } from "node:child_process";
import { parseDag, type Dag } from "@mar/core";
import type { Adapter } from "@mar/adapters";

export class PlanError extends Error {}

export function repoMap(repo: string, maxChars = 6000): string {
  const files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })
    .split("\n").filter((f) => f && !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(f) && !/\.min\./.test(f));
  let out = "", i = 0;
  for (; i < files.length; i++) { if (out.length + files[i].length + 1 > maxChars) break; out += files[i] + "\n"; }
  return i < files.length ? `${out}… (+${files.length - i} more files)` : out.trimEnd();
}

const stripFence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

const plannerPrompt = (goal: string, map: string, err?: string) => `You are a planning agent. Break the goal into a small DAG of tasks for coding agents. Output ONLY JSON, no prose.

Schema: {"tasks":[{"id":"[a-z0-9_-]+","role":"implementer|reviewer|tester|researcher","runtime":"claude|codex","tier":"low|mid|high","goal":"string","dependsOn":["id"],"needs":["<ancestorId>/summary"|"<ancestorId>/files"|"<ancestorId>/decisions"|"<ancestorId>/open_questions"]}]}
Rules: at most 8 tasks; use "codex" for bulk implementation and "claude" for planning/review; "needs" may only reference tasks listed in the task's (transitive) dependsOn; keep each goal self-contained and under 80 words; use the lowest tier that can do the job.

## Repo files
${map}

## Goal
${goal}${err ? `\n\nYour previous output was rejected: ${err.slice(0, 300)}\nReturn corrected JSON only.` : ""}`;

export async function planGoal(a: { goal: string; repoMap: string; adapter: Adapter; model: string | null; cwd: string; signal?: AbortSignal }): Promise<Dag> {
  let err: string | undefined;
  for (let n = 1; n <= 2; n++) {
    let raw = "";
    for await (const ev of a.adapter.run({
      taskId: "planner", prompt: plannerPrompt(a.goal, a.repoMap, err), cwd: a.cwd, model: a.model,
      allowedTools: ["Read", "Glob", "Grep"], signal: a.signal ?? new AbortController().signal,
    })) if (ev.type === "result") raw = ev.text;
    try { return parseDag(JSON.parse(stripFence(raw))); }
    catch (e) { err = e instanceof Error ? e.message : String(e); }
  }
  throw new PlanError(`planner produced an invalid plan: ${err}`);
}
```
Export from `index.ts`.

- [ ] **Step 4: Verify pass**: `pnpm vitest run packages/orchestrator` → PASS. **Step 5: Commit**: `feat(orchestrator): add planner with validation retry`

---

### Task 9: Server (HTTP + WebSocket)

**Files:**
- Create: `packages/server/src/{server.ts,index.ts}`
- Test: `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: `Store`
- Produces: `startServer(store: Store, opts: { port: number; staticDir?: string; onStop?: (runId: string) => void }): Promise<{ port: number; close(): Promise<void> }>` — binds `127.0.0.1` only. Routes: `GET /api/runs`; `GET /api/runs/:id` → `{ events, blackboard, tasks }`; `POST /api/runs/:id/stop` → calls `onStop`, 204; WebSocket `/ws?run=<id>&after=<eventId>` → replays events after the cursor then streams live ones as JSON text frames; any other path serves `staticDir` (SPA fallback to `index.html`) or 404. Add dependency `ws` + `@types/ws` (approved in Tech Stack).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { Store } from "../src/store.js";
import { startServer } from "../src/server.js";

let srv: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });
const ev = (s: Store, type: any = "task_started") => s.appendEvent({ run_id: "r", task_id: "a", agent_id: "a", type, payload: {} });

describe("server", () => {
  it("lists runs and returns a run snapshot", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x"); ev(s);
    srv = await startServer(s, { port: 0 });
    const runs = await (await fetch(`http://127.0.0.1:${srv.port}/api/runs`)).json();
    expect(runs[0].id).toBe("r");
    const snap = await (await fetch(`http://127.0.0.1:${srv.port}/api/runs/r`)).json();
    expect(snap.events).toHaveLength(1);
  });
  it("replays after cursor then streams live events in order", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    const e1 = ev(s); ev(s, "usage");
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r&after=${e1.id}`);
    const got: any[] = [];
    await new Promise<void>((res) => { ws.on("message", (m) => { got.push(JSON.parse(m.toString())); if (got.length === 2) res(); }); ws.on("open", () => setTimeout(() => ev(s, "task_finished"), 20)); });
    expect(got.map((g) => g.type)).toEqual(["usage", "task_finished"]);
    ws.close();
  });
  it("only delivers events for the subscribed run", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x"); s.createRun("other", "g", "/x");
    srv = await startServer(s, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?run=r`);
    const got: any[] = [];
    ws.on("message", (m) => got.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on("open", r));
    s.appendEvent({ run_id: "other", task_id: null, agent_id: null, type: "task_started", payload: {} });
    ev(s);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
    ws.close();
  });
  it("stop endpoint calls onStop and unknown run snapshot is 404", async () => {
    const s = new Store(":memory:"); s.createRun("r", "g", "/x");
    let stopped = "";
    srv = await startServer(s, { port: 0, onStop: (id) => { stopped = id; } });
    expect((await fetch(`http://127.0.0.1:${srv.port}/api/runs/r/stop`, { method: "POST" })).status).toBe(204);
    expect(stopped).toBe("r");
    expect((await fetch(`http://127.0.0.1:${srv.port}/api/runs/nope`)).status).toBe(404);
  });
  it("binds to loopback only", async () => {
    srv = await startServer(new Store(":memory:"), { port: 0 });
    expect((srv as any).host ?? "127.0.0.1").toBe("127.0.0.1");
  });
});
```

- [ ] **Step 2: Verify fail**. **Step 3: Implement** `server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import type { Store } from "./store.js";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

export async function startServer(store: Store, opts: { port: number; staticDir?: string; onStop?: (runId: string) => void }) {
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = url.pathname.match(/^\/api\/runs\/([^/]+)(\/stop)?$/);
    if (url.pathname === "/api/runs") return json(res, 200, store.listRuns());
    if (m && m[2] && req.method === "POST") { opts.onStop?.(decodeURIComponent(m[1])); res.writeHead(204); return res.end(); }
    if (m && !m[2]) {
      const id = decodeURIComponent(m[1]);
      if (!store.listRuns().some((r) => r.id === id)) return json(res, 404, { error: "unknown run" });
      return json(res, 200, { events: store.listEvents(id), blackboard: store.listBb(id), tasks: store.taskStatuses(id) });
    }
    if (opts.staticDir) {
      const root = normalize(opts.staticDir);
      let f = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
      if (!f.startsWith(root) || !existsSync(f) || !statSync(f).isFile()) f = join(root, "index.html");
      if (existsSync(f)) { res.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream" }); return res.end(readFileSync(f)); }
    }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const run = url.searchParams.get("run") ?? "";
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      let last = after;
      const send = (e: { id: number }) => { if (e.id > last && ws.readyState === ws.OPEN) { last = e.id; ws.send(JSON.stringify(e)); } };
      const off = store.onEvent((e) => { if (e.run_id === run) send(e); });
      for (const e of store.listEvents(run, after)) send(e);
      ws.on("close", off);
    });
  });

  await new Promise<void>((r) => http.listen(opts.port, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  return {
    port, host: "127.0.0.1",
    close: () => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); http.close(() => r()); }),
  };
}
```
`index.ts`: `export * from "./store.js"; export * from "./server.js";`

- [ ] **Step 4: Verify pass**: `pnpm vitest run packages/server` → PASS. **Step 5: Commit**: `feat(server): http + websocket event relay`

---

### Task 10: CLI (`mar run`, `mar resume`)

**Files:**
- Create: `packages/cli/src/main.ts`, `packages/cli/bin/mar.js` (`#!/usr/bin/env node` + `import "../dist/main.js"` or `tsx` shim)
- Test: `packages/cli/test/run.test.ts` (wiring with fake adapter)

**Interfaces:**
- Consumes: everything above.
- Produces: `executeRun(o: { goal: string; repo: string; store: Store; adapters: Record<Runtime, Adapter>; config: MarConfig; runId?: string; unsafe?: boolean; signal?: AbortSignal }): Promise<{ runId: string; results: Record<string, string> }>` — creates/continues the run, calls the planner (skipped on resume: the DAG is reloaded from the `plans` table — see below), then `runDag`. And `main()` parsing: `mar run "<goal>" [--repo .] [--port 4317] [--unsafe] [--budget N]` and `mar resume <runId> [--repo .]`.
- Plan persistence: add table `plans (run_id TEXT PRIMARY KEY, dag TEXT)` to `Store` with `savePlan(runId, dag: Dag)` / `loadPlan(runId): Dag | undefined` (extend Task 2's class and test: round-trips JSON). `resume` loads this plan and calls `runDag`, which skips `done` tasks.
- `modelFor = (rt, tier) => config.tiers[rt][tier]`; `toolsFor`: implementer/tester → `["Read","Glob","Grep","Edit","Write","Bash"]`, reviewer/researcher → `["Read","Glob","Grep"]`.
- `main` flow: preflight (print problems and exit 1) → `startServer(store, { port, staticDir: ui dist, onStop })` → print `UI: http://127.0.0.1:<port>/?run=<id>` → `executeRun` → print per-task status table and branch names (`mar/<runId>/<taskId>`) → exit code 0 only if all tasks done. If `--unsafe`, print a loud warning line. Never merges; prints `git merge mar/<runId>/<id>` hints on a feature branch only.

- [ ] **Step 1: Failing tests** (`run.test.ts`): (a) with the fake adapter returning a valid plan for the planner call (`taskId === "planner"`) and `ok()` for workers, `executeRun` returns all `done` and the store has a saved plan; (b) a second `executeRun` with the same `runId` after marking one task `failed` re-runs only non-`done` tasks (assert via call log); (c) an aborted `signal` leaves unstarted tasks `blocked` and does not throw. Also add to `store.test.ts`: `savePlan`/`loadPlan` round-trip and `loadPlan` returns `undefined` for unknown runs.

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../../server/src/store.js";
import { loadConfig } from "../src/config.js";
import { executeRun } from "../src/main.js";
import { fakeAdapter, ok } from "../../orchestrator/test/fakeAdapter.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const plan = { tasks: [{ id: "a", role: "implementer", runtime: "claude", tier: "mid", goal: "A" }, { id: "b", role: "reviewer", runtime: "claude", tier: "mid", goal: "B", dependsOn: ["a"], needs: ["a/summary"] }] };
const script = (i: any) => (i.taskId === "planner" ? [{ type: "result", text: JSON.stringify(plan) }] : ok());

describe("executeRun", () => {
  it("plans, persists the plan and runs all tasks", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const repo = mkdtempSync(join(tmpdir(), "mar-r-"));
    const { runId, results } = await executeRun({ goal: "g", repo, store, adapters: { claude: f.adapter, codex: f.adapter }, config: loadConfig(repo), worktrees: { create: async (id) => `/wt/${id}`, remove: async () => {}, commit: async () => {} }, repoMapFn: () => "a.ts" });
    expect(results).toEqual({ a: "done", b: "done" });
    expect(store.loadPlan(runId)?.tasks).toHaveLength(2);
  });
  it("resume re-runs only non-done tasks", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const repo = mkdtempSync(join(tmpdir(), "mar-r-"));
    const base = { goal: "g", repo, store, adapters: { claude: f.adapter, codex: f.adapter }, config: loadConfig(repo), worktrees: { create: async (id: string) => `/wt/${id}`, remove: async () => {}, commit: async () => {} }, repoMapFn: () => "a.ts" };
    const { runId } = await executeRun(base);
    store.setTaskStatus(runId, "b", "failed");
    f.calls.length = 0;
    await executeRun({ ...base, runId });
    expect(f.calls.map((c) => c.taskId)).toEqual(["b"]);
  });
  it("aborted signal blocks unstarted tasks without throwing", async () => {
    const store = new Store(":memory:"); const f = fakeAdapter(script);
    const repo = mkdtempSync(join(tmpdir(), "mar-r-"));
    const ac = new AbortController();
    const p = executeRun({ goal: "g", repo, store, adapters: { claude: f.adapter, codex: f.adapter }, config: loadConfig(repo), worktrees: { create: async (id) => `/wt/${id}`, remove: async () => {}, commit: async () => {} }, repoMapFn: () => "a.ts", signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toBeTruthy();
  });
});
```
(`executeRun` therefore also accepts injectable `worktrees` and `repoMapFn` — defaults are the real `createWorktrees(repo, runId)` and `repoMap(repo)`.)

- [ ] **Step 2: Verify fail**. **Step 3: Implement** `main.ts` per the flow above: `executeRun` = `runId ??= "r" + Date.now().toString(36)`; `store.createRun`; `dag = store.loadPlan(runId) ?? await planGoal({...adapter: adapters.claude, model: config.plannerModel...})` then `store.savePlan`; build `RunDeps` (concurrency/defaultBudgetTokens from config; `repairResult` is a cheap Claude call on the `low` tier that returns only valid JSON for the given text — implement as a small function that runs `adapters.claude` with a "fix this into valid JSON, output JSON only" prompt, read-only tools) and `return { runId, results: await runDag(deps) }`. `main()` uses `process.argv` with `node:util` `parseArgs`; the real preflight runner uses `execFile` with `cwd: repo`; SIGINT aborts the shared `AbortController` (kills children via the adapters' abort handling) and exits after `runDag` returns.

- [ ] **Step 4: Verify pass**: `pnpm vitest run && pnpm typecheck` → PASS. **Step 5: Commit**: `feat(cli): add run/resume commands and plan persistence`

---

### Task 11: UI derivations (pure logic, unit-tested)

**Files:**
- Create: `packages/ui/{package.json,tsconfig.json,vite.config.ts,index.html}`, `packages/ui/src/derive.ts`
- Test: `packages/ui/test/derive.test.ts`

**Interfaces:**
- Consumes: `StoredEvent`, `BbEntry` (type-only from `@mar/core`)
- Produces (`derive.ts`):
  - `deriveAgents(events: StoredEvent[], tasks: {task_id; status; detail}[]): AgentView[]` where `AgentView = { id: string; role?: string; runtime?: string; tier?: string; status: "pending"|"running"|"done"|"failed"|"blocked"; detail?: string; tokens: number | null; costUsd: number | null; startedAt?: number; endedAt?: number }` — `tokens` is `null` when no `usage` events were seen (UI renders "n/a").
  - `deriveFlow(events: StoredEvent[]): FlowEdge[]` where `FlowEdge = { from: string; to: string; key: string; version: number; tokens: number }` — one edge per `blackboard_read` (`author` → reader).
  - `deriveContext(events: StoredEvent[], taskId: string): { prompt: string | null; slices: { key: string; version: number; tokens: number }[] }`.
  - `deriveLanes(events: StoredEvent[]): { id: string; start: number; end: number | null }[]` for the timeline.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { deriveAgents, deriveFlow, deriveContext, deriveLanes } from "../src/derive.js";

let id = 0;
const e = (task: string | null, type: string, payload: object = {}, ts = 1000 + id) => ({ id: ++id, run_id: "r", task_id: task, agent_id: task, ts, type, payload }) as any;

describe("derive", () => {
  it("builds agent views with tokens null when no usage was reported", () => {
    const a = deriveAgents([e("a", "task_started", { runtime: "codex", tier: "mid", role: "implementer" })], [{ task_id: "a", status: "running", detail: null }]);
    expect(a[0]).toMatchObject({ id: "a", runtime: "codex", status: "running", tokens: null });
  });
  it("sums usage across events and keeps failure detail", () => {
    const a = deriveAgents([
      e("a", "task_started"), e("a", "usage", { input: 10, output: 5, costUsd: 0.01 }), e("a", "usage", { input: 1, output: null, costUsd: null }),
    ], [{ task_id: "a", status: "failed", detail: "failed:budget" }]);
    expect(a[0]).toMatchObject({ tokens: 16, costUsd: 0.01, status: "failed", detail: "failed:budget" });
  });
  it("derives flow edges from blackboard_read events", () => {
    const f = deriveFlow([e("b", "blackboard_read", { key: "a/summary", version: 2, tokens: 40, author: "a" })]);
    expect(f).toEqual([{ from: "a", to: "b", key: "a/summary", version: 2, tokens: 40 }]);
  });
  it("derives the context a task actually received", () => {
    const c = deriveContext([e("b", "prompt_sent", { prompt: "P", keys: ["a/summary"], tokens: 9 }), e("b", "blackboard_read", { key: "a/summary", version: 1, tokens: 7, author: "a" })], "b");
    expect(c.prompt).toBe("P"); expect(c.slices).toEqual([{ key: "a/summary", version: 1, tokens: 7 }]);
  });
  it("returns an empty context for a task that has not started", () => {
    expect(deriveContext([], "zzz")).toEqual({ prompt: null, slices: [] });
  });
  it("derives timeline lanes with open end for running tasks", () => {
    const l = deriveLanes([e("a", "task_started", {}, 100), e("a", "task_finished", {}, 200), e("b", "task_started", {}, 150)]);
    expect(l).toEqual([{ id: "a", start: 100, end: 200 }, { id: "b", start: 150, end: null }]);
  });
});
```

- [ ] **Step 2: Verify fail**. **Step 3: Implement** `derive.ts`:

```ts
import type { StoredEvent } from "@mar/core";

export type AgentView = { id: string; role?: string; runtime?: string; tier?: string; status: "pending" | "running" | "done" | "failed" | "blocked"; detail?: string; tokens: number | null; costUsd: number | null; startedAt?: number; endedAt?: number };
export type FlowEdge = { from: string; to: string; key: string; version: number; tokens: number };
type TaskRow = { task_id: string; status: string; detail: string | null };

export function deriveAgents(events: StoredEvent[], tasks: TaskRow[]): AgentView[] {
  const m = new Map<string, AgentView>();
  const get = (id: string) => { let v = m.get(id); if (!v) { v = { id, status: "pending", tokens: null, costUsd: null }; m.set(id, v); } return v; };
  for (const t of tasks) { const v = get(t.task_id); v.status = t.status as AgentView["status"]; if (t.detail) v.detail = t.detail; }
  for (const ev of events) {
    if (!ev.task_id) continue;
    const v = get(ev.task_id); const p = ev.payload as any;
    if (ev.type === "task_started") { v.role = p.role; v.runtime = p.runtime; v.tier = p.tier; v.startedAt = ev.ts; }
    if (ev.type === "task_finished" || ev.type === "task_failed") v.endedAt = ev.ts;
    if (ev.type === "usage") {
      v.tokens = (v.tokens ?? 0) + (p.input ?? 0) + (p.output ?? 0);
      if (typeof p.costUsd === "number") v.costUsd = (v.costUsd ?? 0) + p.costUsd;
    }
  }
  return [...m.values()];
}

export const deriveFlow = (events: StoredEvent[]): FlowEdge[] =>
  events.filter((e) => e.type === "blackboard_read" && e.task_id).map((e) => {
    const p = e.payload as any;
    return { from: p.author, to: e.task_id!, key: p.key, version: p.version, tokens: p.tokens };
  });

export function deriveContext(events: StoredEvent[], taskId: string) {
  const mine = events.filter((e) => e.task_id === taskId);
  const prompt = (mine.filter((e) => e.type === "prompt_sent").at(-1)?.payload as any)?.prompt ?? null;
  const slices = mine.filter((e) => e.type === "blackboard_read").map((e) => {
    const p = e.payload as any; return { key: p.key, version: p.version, tokens: p.tokens };
  });
  return { prompt, slices };
}

export function deriveLanes(events: StoredEvent[]) {
  const lanes = new Map<string, { id: string; start: number; end: number | null }>();
  for (const e of events) {
    if (!e.task_id) continue;
    if (e.type === "task_started" && !lanes.has(e.task_id)) lanes.set(e.task_id, { id: e.task_id, start: e.ts, end: null });
    if ((e.type === "task_finished" || e.type === "task_failed") && lanes.has(e.task_id)) lanes.get(e.task_id)!.end = e.ts;
  }
  return [...lanes.values()];
}
```
Add UI deps: `react`, `react-dom`, `@xyflow/react`, `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom` to `packages/ui/package.json`. The UI test runs under Vitest in node (derive.ts is pure; no DOM needed).

- [ ] **Step 4: Verify pass**: `pnpm vitest run packages/ui` → PASS. **Step 5: Commit**: `feat(ui): add pure derivations for agents, flow, context, lanes`

---

### Task 12: UI components and Playwright smoke test

**Files:**
- Create: `packages/ui/src/{main.tsx,App.tsx,useRun.ts,GraphView.tsx,Inspector.tsx,Timeline.tsx,BlackboardPanel.tsx,styles.css}`
- Test: `packages/ui/test/smoke.spec.ts` (Playwright), fixture `packages/ui/test/fixtures/run.json`

**Interfaces:**
- Consumes: `derive.ts`, server API (`GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/stop`, WS `/ws?run=&after=`).
- Produces: a Vite app built to `packages/ui/dist` (served by the server's `staticDir`).

- [ ] **Step 1: Hook** `useRun.ts` — loads the snapshot, opens the WebSocket with `after = lastEventId`, appends events (dedup by `id`), reconnects with backoff on close:

```ts
import { useEffect, useRef, useState } from "react";
import type { BbEntry, StoredEvent } from "@mar/core";

export type Snapshot = { events: StoredEvent[]; blackboard: BbEntry[]; tasks: { task_id: string; status: string; detail: string | null }[] };

export function useRun(runId: string | null) {
  const [snap, setSnap] = useState<Snapshot>({ events: [], blackboard: [], tasks: [] });
  const last = useRef(0);
  useEffect(() => {
    if (!runId) return;
    let ws: WebSocket | undefined, closed = false, retry = 500;
    const load = async () => {
      const s: Snapshot = await (await fetch(`/api/runs/${runId}`)).json();
      last.current = s.events.at(-1)?.id ?? 0; setSnap(s);
    };
    const open = () => {
      ws = new WebSocket(`ws://${location.host}/ws?run=${runId}&after=${last.current}`);
      ws.onmessage = (m) => {
        const ev: StoredEvent = JSON.parse(m.data); last.current = ev.id;
        setSnap((p) => (p.events.some((x) => x.id === ev.id) ? p : { ...p, events: [...p.events, ev] }));
        if (["task_finished", "task_failed", "blackboard_write"].includes(ev.type)) load();
      };
      ws.onclose = () => { if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 5000))); };
    };
    load().then(open);
    return () => { closed = true; ws?.close(); };
  }, [runId]);
  return snap;
}
```

- [ ] **Step 2: Components.**
  - `App.tsx`: reads `?run=` (or picks the newest from `/api/runs`); header shows run goal, total tokens (sum of `AgentView.tokens ?? 0`), spend, elapsed, a **Stop** button (`POST /api/runs/:id/stop`), and an "unsafe mode" badge if any `task_started` payload has `unsafe: true`; layout = Graph (main), Inspector (right drawer), Timeline (bottom), Blackboard toggle.
  - `GraphView.tsx`: `@xyflow/react`; nodes from `deriveAgents` (label: id, role, runtime badge, tier, `tokens ?? "n/a"`; class by status), simple layered positions computed from `dependsOn` depth (from the stored plan — add `plan` to the snapshot: server `GET /api/runs/:id` returns `plan: store.loadPlan(id)` — extend Task 9 + its test accordingly); solid edges for dependencies; animated edges for `deriveFlow` with the key as label; `onNodeClick` selects the agent.
  - `Inspector.tsx`: tabs **Context** (`deriveContext`: prompt in a `<pre>`, slices table with key/version/tokens, and a "Not given" list = blackboard keys that exist but were not injected), **Activity** (events for the task of types `assistant_text|tool_call|tool_result`, newest at bottom, auto-scroll), **Output** (its `bb_entries` where `author_task == id`), **Usage** (tokens vs `budgetTokens` from the plan, bar; "n/a" when null).
  - `Timeline.tsx`: `deriveLanes`; SVG with one row per agent, x scaled to `[min start, max(end ?? now)]`; running lanes grow with a ticking `now`; a range input scrubs `cutoff` and passes `events.filter(ts <= cutoff)` to the views (replay).
  - `BlackboardPanel.tsx`: table of all entries (key, version, kind, author, body, readers = distinct `to` from `deriveFlow` for that key).
  Keep each file under ~150 lines; style with plain CSS and CSS variables (light/dark via `prefers-color-scheme`).

- [ ] **Step 3: Playwright smoke test.** Add `@playwright/test`; `packages/ui/test/smoke.spec.ts` starts `startServer` against an in-memory `Store` pre-seeded from `fixtures/run.json` (plan with tasks `impl`(codex) → `rev`(claude), events incl. `task_started`, `prompt_sent`, `blackboard_write`, `blackboard_read` impl→rev, `usage`, `task_finished`), builds/serves `dist`, then asserts: both nodes render with runtime badges; an animated flow edge labelled `impl/summary` exists; clicking `rev` shows the Context tab with the injected key `impl/summary` and its token count; a task with no usage shows `n/a` (not `NaN`).

- [ ] **Step 4: Run**: `pnpm --filter @mar/ui build && pnpm exec playwright test packages/ui` → PASS. Also `pnpm typecheck` (UI included via `tsc --noEmit -p packages/ui`).
- [ ] **Step 5: Commit**: `feat(ui): graph, inspector, timeline and blackboard views`

---

### Task 13: Live smoke test (opt-in) and README

**Files:**
- Create: `packages/cli/test/live.test.ts`, `README.md`

**Interfaces:** consumes `executeRun`, real adapters.

- [ ] **Step 1: Write the live test**, skipped unless `MAR_LIVE=1`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { Store } from "../../server/src/store.js";
import { claudeAdapter, codexAdapter } from "../../adapters/src/index.js";
import { loadConfig } from "../src/config.js";
import { executeRun } from "../src/main.js";

describe.skipIf(!process.env.MAR_LIVE)("live smoke", () => {
  it("runs a tiny two-task goal on real Claude and Codex within a low budget", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mar-live-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    g("init", "-q", "-b", "feat/live"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "# demo\n"); writeFileSync(join(repo, ".gitignore"), ".mar/\n"); g("add", "."); g("commit", "-qm", "init");
    const config = { ...loadConfig(repo), defaultBudgetTokens: 30000, concurrency: 2 };
    const { results } = await executeRun({ goal: "Add a one-line greeting function in hello.js, then review it.", repo, store: new Store(":memory:"), adapters: { claude: claudeAdapter(), codex: codexAdapter() }, config });
    expect(Object.values(results).every((r) => r === "done")).toBe(true);
  }, 600_000);
});
```
- [ ] **Step 2: Run when logged in**: `pnpm test:live`. If CLIs aren't authenticated or you do not want to spend tokens, skip and **report it as not run**; do not claim it passed.
- [ ] **Step 3: README** — how to install (`pnpm install && pnpm build`), run (`pnpm mar run "<goal>" --repo .`), `.mar.json` options, the safety model (no merge to main, worktree isolation, unsafe flag), and the token-saving design (planner once, tiering, `needs` slices, one-shot sessions, budgets).
- [ ] **Step 4: Final verification**: `pnpm typecheck && pnpm test` (non-live) — all green; Playwright smoke green.
- [ ] **Step 5: Commit**: `docs: add readme and opt-in live smoke test`

---

## Self-Review

**Spec coverage:** architecture/run flow → Tasks 4, 7, 8, 10; event schema + blackboard + budgets → Tasks 1–4; adapters for both runtimes → Tasks 5–6; UI graph/inspector/timeline/blackboard/header/stop/replay → Tasks 11–12; error handling (retry, repair, budget, invalid DAG, preflight, resume, crash) → Tasks 1, 4, 7, 8, 10; safety (worktrees, tool allowlists, no unsafe default, never merge to main, `.env`, redaction, loopback) → Tasks 3, 5, 6, 7, 9, 10; testing tiers (unit, fixtures, integration, UI smoke, live) → every task + Task 13. Spec open items resolved: flags confirmed against Claude Code 2.1.289 and Codex 0.156.1; tier defaults set in `config.ts`.

**Known gaps to confirm at execution:** Codex tier model ids default to the CLI's own default (`null`) until you choose; the Codex `--json` event field names are verified against a captured fixture in Task 6 Step 1 before the normalizer is trusted.

---

### Task 14 (PROPOSED, pending user OK): verify gates, path ownership, integration branch

**Files:** Modify `packages/core/src/{schemas.ts,dag.ts}`, `packages/orchestrator/src/{scheduler.ts,planner.ts}`, `packages/cli/src/{config.ts,main.ts}`; Create `packages/orchestrator/src/{verify.ts,integrate.ts}`; Tests beside each.

- [ ] `TaskSpec.paths: string[]` (default `[]`); `parseDag` rejects two tasks with no dependency path between them whose `paths` globs overlap (test: overlapping parallel tasks rejected; overlapping but dependent tasks accepted; empty `paths` never conflicts).
- [ ] `MarConfig.verify: string[]` (default `[]`); `runVerify(cwd, commands, signal): Promise<{ok: boolean; tail: string}>` runs each command via argv split (no shell), stops at first failure, returns last 1500 chars of output (test with real `node -e` commands: pass, fail, tail truncation, abort).
- [ ] Scheduler: after a worker's result is parsed and before publishing, run the verify gate in its worktree; on failure, only if `maxAttempts` > 1, retry the task with `Verify failed:\n<tail>` appended (default: fail immediately), emit `verify_started`/`verify_passed`/`verify_failed` events (add to `EventTypes`); the final failure fails the task (`failed:verify`). Implementer/tester tasks only (reviewers/researchers skip). Tests with the fake adapter and a fake verifier.
- [ ] `integrate(repo, runId, order: string[]): Promise<{branch: string; conflicts: string[]}>` merges task branches in topological order into `mar/<runId>/integration` using a temporary worktree; on conflict, aborts that merge and reports the files; then runs the verify gate on the result. Tests in a throwaway repo: clean merge, conflicting merge reported, never touches `main`/`master`/`beta`.
- [ ] Planner prompt asks for `paths` and prefers parallelizing only disjoint work; UI shows gate status on nodes and the integration result in the run header (extend `derive.ts` + tests).
