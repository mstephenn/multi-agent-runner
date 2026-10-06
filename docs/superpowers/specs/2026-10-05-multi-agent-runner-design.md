# Multi-Agent Runner — Design

Date: 2026-10-05

## Goal

A local runner that takes a coding goal for a repo, uses an orchestrator to split it into tasks, and runs those tasks on Claude Code and Codex CLI agents. Token use is kept low by design. A live web UI shows which agent is running what, how agents communicate, and exactly what context each one received.

For the author's own use, running locally. Not a hosted multi-user service.

## Prior art (why build)

- Orchestrators: Open-Agents, Agentrooms, Conductor, Orca, CC Mirror. They fan agents out in parallel but do not treat token economy as a design goal.
- Observability UIs: agents-observe, claude-agent-dashboard, multi-agent-workflow. Observe-only; no agent-to-agent context or blackboard view.
- Token techniques (model tiering, bounded subagent jobs, context clearing) are known patterns, not a product.

Nothing combines a token-frugal orchestrator, explicit shared-context flow, and a UI showing it. We borrow the hooks → SQLite → WebSocket → React pipeline idea from agents-observe.

## Decisions

- Runtimes: Claude Code and Codex CLI, behind one adapter interface.
- Tasks: coding in a repo; one git worktree per worker.
- Context model: orchestrator-mediated blackboard. Agents never talk directly.
- Approach: headless CLI wrappers (`claude -p --output-format stream-json`, `codex exec --json`), normalized into one event schema.
- Stack: TypeScript, pnpm monorepo, SQLite (better-sqlite3), React + Vite, zod, Vitest.
- Planner model is configurable and defaults to Sonnet. Workers default to cheaper tiers.

## 1. Architecture

```
packages/
  core/          types + zod schemas: Task, Event, BlackboardEntry, RunConfig
  orchestrator/  planner, scheduler, blackboard, budget tracker
  adapters/      claude.ts, codex.ts: spawn CLI, normalize stream -> Event
  server/        HTTP + WebSocket, SQLite, serves UI (binds 127.0.0.1)
  ui/            React + Vite
  cli/           `mar run "<goal>" --repo .`, `mar resume <run>`
```

Run flow:

1. `mar run` creates a run record and worktree base.
2. Planner (one call) reads a compact repo map and returns a task DAG as JSON. Each task: role, runtime (`claude`|`codex`), model tier, dependencies, `needs` (blackboard keys).
3. Scheduler runs ready tasks in parallel up to a concurrency limit; each gets a worktree and a one-shot adapter process.
4. Adapter builds the prompt from the task plus only the declared blackboard slices, streams normalized events, and parses a structured result.
5. Result goes onto the blackboard (summary, files changed, decisions, open questions); dependents unblock. Reviewers get a diff and summary, never the implementer's transcript.
6. On completion, results stay on per-task branches. Merging is a configurable, confirmed step and never targets `main`/`master`/`beta`.

Boundaries: only adapters know CLI flags; the orchestrator talks to `run(task, prompt, cwd) -> AsyncIterable<Event>`; the server only reads/writes the DB and relays events; the UI is a pure view of the stream.

## 2. Event schema and blackboard

`events` (append-only): `id, run_id, task_id, agent_id, ts, type, payload(JSON)`.

Types: `task_started | task_finished | task_failed | prompt_sent | tool_call | tool_result | assistant_text | blackboard_write | blackboard_read | usage`.

- `prompt_sent` records the exact prompt and the injected blackboard keys.
- `usage` records input/output/cached tokens and cost. Fields a runtime does not report are null.

`bb_entries`: `id, run_id, key, author_task, version, ts, kind, body, refs`.

- `kind`: `summary | decision | file_change | open_question | artifact_ref`.
- Immutable and versioned; a rewrite creates a new version.
- Body capped at ~300 tokens; larger content is an `artifact_ref` (file path/diff) the consumer reads only if needed.
- A task's `needs: [keys]` is the only way it receives context; each injection emits `blackboard_read`.

UI derivations: agent lanes (start/finish events), communication graph (author -> consumer edge per write later read, labelled by key), context inspector (exact prompt, slices, token counts), cost (from `usage`).

Budget tracker sums `usage` per task; exceeding the cap kills the task and marks it `failed:budget`.

## 3. UI

React + Vite, served by the local server, live over WebSocket. Run selector at top.

- Graph (main): task DAG (React Flow). Nodes show role, runtime badge, model, status colour, running token count. Solid dependency edges; animated blackboard-flow edges labelled with the key. Click opens the inspector.
- Inspector (drawer) tabs: Context (exact prompt, injected slices with token counts, what was not given), Activity (live tool calls/text), Output (structured result, entries written), Usage (tokens/cost vs budget).
- Timeline (bottom): lane per agent over time; scrubber replays a finished run from `events`.
- Blackboard panel (toggle): all entries with author, version, readers.
- Run header: total tokens, spend, elapsed, stop button.
- Non-goals v1: editing the DAG, auth, multi-user. Read-only apart from stop.

## 4. Error handling and safety

Failures:

- Worker failure/timeout: marked `failed` with reason. Each task runs **once by default** (`maxAttempts: 1`); an opt-in `maxAttempts` > 1 retries with the error summary (not the transcript). Dependents are then `blocked`; independent branches continue.
- Malformed structured result: one cheap repair call for the JSON; else fail.
- Budget exceeded: process killed, `failed:budget`, shown in UI.
- Invalid planner DAG (cycle, unknown dependency/runtime): zod validation, fail fast before any worker starts.
- CLI missing / not logged in: preflight (`claude --version`, `codex --version`, auth check) with a clear message.
- Orchestrator crash: state in SQLite; `mar resume <run>` skips finished tasks, re-runs interrupted ones.

Safety:

- Workers touch only their own worktree. Per-role tool allowlists via each CLI's flags (reviewers read-only; implementers edit + test).
- No `--dangerously-skip-permissions` equivalent by default; explicit per-run opt-in, surfaced in the UI.
- Never merge to `main`/`master`/`beta`; final merge to a feature branch is a confirmed step.
- `.env` files not copied into worktrees or prompts; event log redacts known secret patterns; server binds `127.0.0.1`.
- Nothing is pushed or deployed.

## 5. Testing

- Unit (Vitest): schemas (valid/invalid events and DAGs, cycles, oversized bodies); scheduler (dependencies, concurrency limit); budget kill; blackboard slicing injects only declared `needs`; retry/block logic. All against a fake adapter with scripted events.
- Adapter fixtures: recorded Claude `stream-json` and Codex `--json` samples replayed through the normalizer and compared to expected events, including missing fields.
- Integration: orchestrator events reach the WebSocket in order; `resume` skips finished tasks (temp SQLite); parallel tasks get isolated worktrees in a throwaway git repo and cleanup works.
- UI: component tests for graph/inspector/timeline from a recorded stream; one Playwright smoke test on a fixture run.
- Live smoke (opt-in, `pnpm test:live`): tiny 2-task goal on real Claude and Codex with a very low budget; skipped by default and in CI.
- Done means typecheck, lint, and the full non-live suite pass; if the live smoke cannot run, that is stated explicitly.

## Open items

- Exact Claude/Codex flag names and stream formats to be confirmed against installed CLI versions during planning.
- Default model tiers per runtime to be set from what the user's logins can access.

## Addendum (2026-10-05, user requirement): parallel + fast + correct for coding

Requirement: the runner is mainly for coding; parallel execution and fast development must not cost correctness. Proposed additions (pending user approval of the plan change):

- **Verify gate per task.** After an implementer finishes, the orchestrator itself (no model tokens) runs the repo's configured commands (`verify: ["pnpm typecheck", "pnpm test"]` in `.mar.json`) inside that task's worktree. A failing gate fails the task immediately by default; with opt-in `maxAttempts` > 1 a trimmed failure tail (<= 1500 chars) is fed back for another attempt. Reviewer tasks only start after the gate passes.
- **Conflict-aware planning.** The planner must give each parallel task a disjoint `paths` ownership list (globs); the DAG validator rejects two tasks without a dependency path between them whose `paths` overlap. Tasks that must touch the same files are serialized by `dependsOn`.
- **Integration step.** After all tasks pass, the orchestrator merges the per-task branches in dependency order into an `mar/<runId>/integration` branch (never main/master/beta), runs the verify gate on the merged result, and reports conflicts or failures in the UI. Landing the integration branch stays a user-confirmed step.
- **Speed.** Default concurrency raised to the number of independent ready tasks up to a configurable cap (default 4); cheap tiers for gate-fix retries; no extra model calls for gating.

## Multi-repo workspaces

One project can span several git repositories that sit side by side in a parent folder (for example `shop/api`, `shop/web`). Run `mar` from the parent (or pass `--repo shop`); there is no extra command or mode.

**Detection.** If `--repo` (default `.`) is inside a git work tree, nothing changes (single-repo mode, including when you run from a child repo). Otherwise the IMMEDIATE child folders that contain `.git` form the workspace. Dot-folders, `node_modules`, symlinks and files are skipped; folder names must match `[A-Za-z0-9._-]+` (others are skipped with a note). No child repo at all is an error. A single child repo is a workspace of one.

**Scoping.** `--repos api,web` (on `run` and `resume`) or `"repos": ["api","web"]` in the parent `.mar.json` restricts the run; the flag wins. An unknown name is an error that lists the discovered repos. Repos outside the scope are never touched and may be dirty.

**Config.** The parent `.mar.json` is the run-level config (all keys, plus `repos`). A child repo's own `.mar.json` may set only `verify`, `verifyTimeoutMinutes`, `linkPaths`, `ownership` and `integrate`; precedence is built-in defaults < parent file < child file. Run-level keys in a child file are ignored with one note per file; errors name the file (`api/.mar.json: ...`).

**Planning.** The planner sees one repo map per repo (`repoMapChars` split evenly) and must give every writer task a `repo`. A cross-repo feature becomes one writer task per repo ordered with `dependsOn`; contracts travel through `decisions`/`summary` and `needs`. `paths` are relative to the task's repo, and the parallel-writer overlap rule applies only between writers of the same repo. Read-only tasks may omit `repo` (they see every repo, read-only).

**Branches and integration.** A writer works in `<parent>/.mar/worktrees/<run>/<task>/<repo>` on branch `mar/<run>/<task>`, which exists only in that repo. Same-repo dependencies are merged into the worktree; cross-repo dependencies only order tasks. After each phase every repo with done writers gets its own `mar/<run>/integration` (verified with that repo's `verify`). Your branches and working trees are never touched; `mar` prints `git -C <repo> merge mar/<run>/integration` hints. State (`.mar/mar.db`, worktrees, reports) lives in the parent folder, outside every repo, so no repo's `.git/info/exclude` is edited. `mar history` shows the repo of each task, per-repo integration results, and `--json` lists `repos`.

**Sibling read access.** A writer in repo `api` also sees the other repos read-only at `../web` (disposable shared checkouts). After the task, `mar` checks them; a modified sibling is reverted and reported as a `sibling_modified` event (the task fails only with `"ownership": "enforce"`).
- Claude: each sibling is passed with `--add-dir` (verified: read works, and it needs the symlink path). Edit through `--add-dir` is NOT blocked by Claude, hence the post-hoc check.
- Codex: no flag needed; the `workspace-write` sandbox lets `../web` be read and denies writes outside the cwd. Codex's own `--add-dir` makes siblings writable, so `mar` does not use it. Caveat: under `/tmp` (and other temp dirs) the sandbox treats the temp dir as writable, so writes to a sibling can succeed there; the post-hoc check still reverts them.

**Limits.** One repo per writer task; immediate children only (no nested workspaces); every in-scope repo must be clean with at least one commit; the DB and history live in the parent folder (run `mar history --repo <parent>`).
