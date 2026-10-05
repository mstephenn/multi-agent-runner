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

- Worker failure/timeout: marked `failed` with reason; one retry with the error summary (not the transcript); then dependents `blocked`; independent branches continue.
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
