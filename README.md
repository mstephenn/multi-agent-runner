# multi-agent-runner (`mar`)

A local CLI that takes a goal, has a planner split it into a DAG of tasks (in phases, for big goals), and runs those tasks on the `claude` and `codex` CLIs in isolated git worktrees. A local web UI shows the task graph, events and shared blackboard while it runs. Every run is stored in SQLite so it can be resumed.

## Prerequisites

- Node >= 22.7 (`bin/mar.mjs` runs the TypeScript sources with `--experimental-transform-types`; there is no build step for the CLI)
- pnpm
- `claude` and `codex` CLIs on `PATH` and logged in. Preflight checks that both run (`--version`); it does not check login (preflight auth check: NOT done), so an unauthenticated CLI fails on the first real call.
- The target repo must be a git repo with at least one commit and a clean working tree.

## Install

```bash
pnpm install
pnpm --filter @mar/ui build   # optional: builds the UI into packages/ui/dist
```

Without `packages/ui/dist` the run still works; `mar` prints a note and serves no UI.

## Run

```bash
pnpm mar run "<goal>" --repo .
pnpm mar resume <runId> --repo .
pnpm mar --help
```

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | Repository to work on (default `.`) |
| `--port <n>` | UI/event server port (default `4317`) |
| `--budget <n>` | Default per-task token budget; overrides `defaultBudgetTokens` |
| `--phases <n>` | Max planning phases for this invocation (1 to 10); overrides `maxPhases` |
| `--unsafe` | Disable Claude permission prompts (dangerous; see below) |
| `-h`, `--help` | Show usage |

`mar` prints `UI: http://127.0.0.1:<port>/?run=<runId>` and, at the end, each task's status and branch (read-only tasks have none), grouped by phase. Run state lives in `<repo>/.mar/mar.db`; `.mar/` is added to `.git/info/exclude`. Exit code is 0 only if every task of every phase finished `done` and the last planner call said the goal is done.

### Phases (one mode, no approval gate)

`mar run "<goal>"` handles goals of any size by itself; there is no separate plan command and nothing waits for approval.

1. The planner sizes the goal and plans the first phase: up to `maxTasks` tasks plus `remaining`, a short text of the work left (`""` when this phase completes the goal). Small goals and exploration questions give one task and `remaining: ""`, and cost exactly one planner call.
2. The phase runs (shared read-only worktree, own worktrees for writers, verify gate, ownership, linked paths). The plan is printed (`== Phase N (max M) ==` and a table) and shown in the UI, but never blocks.
3. After every phase with at least one done writer, its writer branches are merged into `mar/<runId>/integration` (never your branch). The integration branch accumulates across phases; a single-phase run only integrates with two or more done writers.
4. If `remaining` is not empty, the planner is called again with the goal, the previous `remaining` and a compact history (per task: status, blackboard summary/decisions/open questions, failure reason and wip branch for failed writers; the integration result and `git diff --stat`; capped at about 8,000 characters, oldest details dropped first). Tasks of phase N use ids `p<N>-...`, may read finished tasks of earlier phases through `needs` (e.g. `p1-api/summary`), and are cut from the integration branch tip, so they see all earlier work. `tasks: []` means done.

The loop stops when the planner says done, when `maxPhases` is reached, when `maxTotalTokens` is exceeded (checked before each phase), on abort, or when a phase finishes no task (it never loops). On an early stop `mar` prints why, the `remaining` text and how to continue, and exits non-zero.

`mar resume <runId>` continues an interrupted run, including the phase loop: it re-runs unfinished tasks of the first unfinished phase (done tasks are kept), then keeps planning. Past a phase limit: `mar resume <runId> --phases 8`. A finished run just reprints its result. Runs created before phases existed resume as a single phase.

Token accounting: `maxTotalTokens` sums input+output of all `usage` events of the run, worker tasks and planner calls (planner usage is recorded when the planner CLI reports it). Planner file reads see your checkout, not the integration branch; the repo map and the history describe the later phases.

## `.mar.json`

Optional, in the repo root. Unknown keys are rejected. Defaults:

```json
{
  "concurrency": 3,
  "maxAttempts": 1,
  "defaultBudgetTokens": 200000,
  "taskTimeoutMinutes": 20,
  "allowOpus": false,
  "plannerModel": "claude-sonnet-5-5",
  "maxTasks": 8,
  "maxPhases": 5,
  "repoMapChars": 20000,
  "verify": [],
  "verifyTimeoutMinutes": 10,
  "linkPaths": [],
  "ownership": "warn",
  "integrate": true,
  "tiers": {
    "claude": { "low": "claude-haiku-4-5-20251001", "mid": "claude-sonnet-5-5", "high": "claude-sonnet-5-5" },
    "codex":  { "low": null, "mid": null, "high": null }
  }
}
```

`maxBudgetUsdPerTask` is optional and has no default (unset, no USD cap); add e.g. `"maxBudgetUsdPerTask": 2` to enable it.

- `concurrency`: tasks run in parallel, 1 to 16.
- `maxAttempts`: attempts per task, 1 to 3. Default 1 means no retry.
- `defaultBudgetTokens`: per-task token budget, used when a task does not set its own. Checked when usage events arrive; a completed result is kept if final usage exceeds the budget, while further work is stopped.
- `taskTimeoutMinutes`: per-task wall-clock limit, 1 to 240 (default 20). A task that runs longer is aborted, which stops hung workers.
- `maxBudgetUsdPerTask`: positive number of USD per task. This is the real mid-run spend guard (passed to Claude as `--max-budget-usd`, so the CLI stops itself; Codex workers have no USD guard, only the timeout and token budget).
- `allowOpus`: default `false`; Opus models in `plannerModel`/`tiers` are rejected unless this is `true`.
- `plannerModel`: model for the planning calls.
- `maxTasks`: tasks per phase, 1 to 16 (default 8); used in the planner prompt and to validate its answer.
- `maxPhases`: phases per run, 1 to 10 (default 5); `--phases <n>` overrides it for one invocation.
- `maxTotalTokens`: positive integer cap on all tokens of the run (default 5 x `defaultBudgetTokens`, so `--budget` moves it too).
- `repoMapChars`: size of the repo map given to the planner, 2000 to 100000 (default 20000). A repo that fits gets the flat file list; a bigger one gets key files, a directory tree with counts, small directories' file names and a `… (+N more files in M dirs)` line.
- `verify`: list of commands (split into arguments, run without a shell) that every implementer/tester task must pass in its worktree before dependents see its output, and that re-run on the integration branch. `[]` (default) turns the gate off. A failure fails the task with `failed:verify`.
- `verifyTimeoutMinutes`: timeout per verify run, 1 to 60 (default 10).
- `linkPaths`: repo-relative paths (single-segment `*` globs, e.g. `node_modules`, `packages/*/node_modules`) symlinked from your repo into writer worktrees so verify can run without reinstalling. Secrets (`.env*`, keys) and `.git`/`.mar` are refused.
- `ownership`: `"warn"` (default) only records an event when a writer changes files outside its declared `paths`; `"enforce"` fails the task (`failed:ownership`).
- `integrate`: default `true`; set `false` to skip building `mar/<runId>/integration`.
- `tiers`: model per runtime and tier (`low`/`mid`/`high`). `null` uses that CLI's default model. For Codex, workers run with `--ignore-user-config`, so "default model" is Codex's built-in default, not the model in your own Codex config.

## Safety model

- Tasks that can write (implementer/tester, and anything that depends on them) run in their own git worktree at `.mar/worktrees/<runId>/<taskId>`, on their own branch `mar/<runId>/<taskId>`. Read-only tasks (researcher/reviewer roles with no writer upstream and no Edit/Write/Bash tools) share ONE detached worktree at `.mar/worktrees/<runId>/.shared` and create no branches, so a pure exploration goal makes one worktree and zero branches. Your checked-out branch is not modified.
- `mar` never touches your branch and never pushes. It builds `mar/<runId>/integration` from the done writer branches and prints `git merge <branch>` hints; taking it is up to you, on a feature branch rather than `main`/`master`/`beta`.
- Tool access depends on role: implementer and tester tasks get `Read, Glob, Grep, Edit, Write, Bash`; other roles get `Read, Glob, Grep`. Claude runs with `--permission-mode acceptEdits`. Codex runs with `--sandbox workspace-write` (tasks that may edit) or `read-only`.
- `--unsafe` is off by default. It only affects Claude (`--dangerously-skip-permissions`); it is deliberately not mapped to Codex. `mar` prints a warning when it is on.
- Tasks run once by default (`maxAttempts: 1`).
- Workers are isolated from your user setup: Claude runs with `--strict-mcp-config --setting-sources ""` (no user MCP servers or settings); Codex runs with `--ignore-user-config`.
- Defence in depth, not a sandbox: a deny list blocks push and network shell commands, and workers get a minimal child environment instead of your full one. These reduce risk but do not contain a determined or prompt-injected agent.
- Bash can still read files outside the worktree (for example `~/.ssh` or other repos). Real isolation needs OS-level sandboxing (container/VM), which `mar` does not provide.
- Secrets: output is passed through a redactor (known token formats, private keys, URL credentials, `Bearer` tokens, and values of keys named like `secret`/`token`/`password`/`api key`) before it is stored, relayed or sent to the JSON-repair call.
- The event server binds `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not loopback on the configured port.

### Task reports (the full answer)

A task may return a long markdown `report` alongside its short `summary`. At the end of a run `mar run` prints the full report of each final task (one no other task depends on), falling back to its blackboard `summary` if it has no report; if a final task failed or was blocked it says so and shows the reports of the tasks that did finish. Every report is also saved to `<repo>/.mar/reports/<runId>/<taskId>.md` (the paths are printed as `Saved:` lines) and shown in the UI's Output tab (as plain text).

Reports are stored (redacted, up to 100,000 characters) in their own SQLite table, not on the blackboard, so they never add to other agents' context. Blackboard entries stay capped at about 1,200 characters.

### Activity tab

The inspector's Activity tab shows one row per step: each tool call is paired with its result (a call with no result yet shows as running), with repo-relative paths, a short result summary and a relative time. Filter chips (All / Messages / Tools / Errors) show counts; click a row to expand its input and the full output (up to the 2,000 characters the runner stores), with a Copy button. Errors start expanded. The feed follows the latest step only while you are at the bottom; scroll up and a "Jump to latest" button appears. All content is rendered as plain text.

The bottom panel has two tabs, Timeline and Blackboard (the choice is remembered). The Timeline shares one time axis (human ticks such as 30s, 1m 30s) between the replay scrubber and one lane per agent, with the full agent id, runtime badge and status, a bar per attempt, markers for start/finish/fail and blackboard writes (◆) and reads (◇), and a hover or focus tooltip with status and duration. The playhead marks the replay cutoff: drag the scrubber, click the axis or a lane, or press Play (1×, 2×, 4× or 8×; a run replays in about 20 seconds at 1×) and Live returns to the end. Click a lane label to open that agent in the inspector.

## How it saves tokens

- A small goal costs one planner call (on the planner model, Sonnet by default); a phased run adds one re-plan call per phase. Plans are stored and reused by `resume`.
- Tasks are tiered (`low`/`mid`/`high`), each mapped to a model in `tiers`.
- A task receives only the blackboard slices listed in its `needs` (e.g. `a/summary`), not the whole history.
- Every agent call is one-shot (Claude uses `--no-session-persistence`); no long conversational sessions are carried.
- Each task has a token budget, checked as usage events arrive. If the final usage exceeds it after the answer is complete, the answer is kept; further work is stopped. `maxBudgetUsdPerTask` is the mid-run USD guard, and `taskTimeoutMinutes` aborts hung workers.
- Malformed task output gets one cheap repair call (low-tier Claude, read-only) before the task is failed.
- If the selected CLI fails, `mar` retries that operation with the other CLI. This applies to planning, worker tasks, and JSON repair; the fallback uses the alternate runtime's configured model tier. Worker tasks with `maxBudgetUsdPerTask` set do not switch CLIs, because Codex cannot enforce the USD cap.

## Tests

```bash
pnpm typecheck
pnpm test                      # all non-live, non-browser tests (vitest workspace)
pnpm test:e2e                  # browser e2e (Playwright), not part of `pnpm test`
pnpm test:live                 # opt-in, see below
```

`pnpm test:e2e` builds the UI and runs `packages/ui/test/smoke.spec.ts`. It needs a browser first: `pnpm --filter @mar/ui exec playwright install chromium`.

`pnpm test:live` runs `MAR_LIVE=1 vitest run packages/cli/test/live.test.ts`. It uses real `claude` and `codex` and spends real tokens (`defaultBudgetTokens: 80000` per task, `concurrency: 2`, `maxAttempts: 1`, never `--unsafe`), in a throwaway temp git repo that is deleted afterwards. Without `MAR_LIVE=1` it is reported as skipped. It fails with a clear message if either CLI is missing.

## Known limitations

- Verify gates only run when `verify` is configured; without it nothing checks that a task's changes build or pass tests.
- The live path (real Claude and Codex) is not exercised in CI; the live smoke test is manual and opt-in.
- Preflight auth check: NOT done. Login is not verified up front; an unauthenticated CLI fails on the first call.
- Merging into your own branch is never done by `mar`; it only prints hints.
- Codex tier models default to Codex's built-in default (`null`) until you set them in `.mar.json`; your own Codex config is ignored.
- Browser e2e tests exist but are not run by `pnpm test` or CI.
