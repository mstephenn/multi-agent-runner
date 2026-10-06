# multi-agent-runner (`mar`)

A local CLI that takes a goal, has a planner split it into a DAG of tasks (in phases, for big goals), and runs those tasks on the `claude` and `codex` CLIs in isolated git worktrees. A local web UI shows the task graph, events and shared blackboard while it runs. Every run is stored in SQLite so it can be resumed.

## Prerequisites

- Node >= 22 (>= 22.7 when running from a checkout: `bin/mar.mjs` runs the TypeScript sources with `--experimental-transform-types`)
- pnpm (only to build or develop from a checkout)
- `claude` and `codex` CLIs on `PATH` and logged in. Preflight checks that both run (`--version`); it does not check login (preflight auth check: NOT done), so an unauthenticated CLI fails on the first real call.
- The target repo must be a git repo with at least one commit and a clean working tree.

## Install

`mar` is not published to npm. Build a tarball from a checkout and install it globally:

```bash
pnpm install
pnpm build && pnpm pack:cli                    # writes ./multi-agent-runner-0.1.0.tgz
npm i -g ./multi-agent-runner-0.1.0.tgz
mar --version                                  # 0.1.0
```

Then, inside any git repo, `mar run "<goal>"` (the repo defaults to `.`) and `mar resume <runId>` work from any directory.

- Update: pull, rebuild (`pnpm build && pnpm pack:cli`) and reinstall the new tarball with `npm i -g`.
- Uninstall: `npm rm -g multi-agent-runner`.
- The package is a single bundled file plus the built UI; only `better-sqlite3` and `ws` are installed as dependencies.

## Develop from a checkout

```bash
pnpm install
pnpm --filter @mar/ui build   # optional: builds the UI into packages/ui/dist
```

Without `packages/ui/dist` the run still works; `mar` prints a note and serves no UI.

## Run

```bash
pnpm mar run "<goal>" --repo .
pnpm mar resume <runId> --repo .
pnpm mar history
pnpm mar --help
```

When installed globally, use `mar` instead of `pnpm mar`.

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

## History (`mar history`)

Every run is kept in the repository it ran in. `mar history` reads that back; it never writes.

```bash
mar history                          # the 20 newest runs of this repo
mar history --limit 50 --repo ~/src/app
mar history r1abc                    # details and the full answer of one run (unique prefix, 3+ characters)
mar history r1abc --task impl > impl.md   # only that task's full report, ready to pipe
mar history --json | jq '.[] | select(.status != "done")'
mar history --ui                     # replay the newest run in the web UI (or: mar history --ui r1abc)
```

| Flag | Meaning |
| --- | --- |
| `<runId>` | Show one run. A unique prefix of at least 3 characters works; an ambiguous prefix lists the matches and exits 2, an unknown id exits 1 |
| `--repo <path>` | Repository whose `.mar/mar.db` to read (default `.`) |
| `--limit <n>` | Runs to list, 1 to 200 (default 20) |
| `--json` | List as a JSON array (`id`, `goal`, `created`, `status`, `phases`, `tasksDone`, `tasksTotal`, `tokens`, `remaining`, `stopReason`); no table, no footer |
| `--task <id>` | Print only the full report of that task (its blackboard summary if it has none); needs a run id |
| `--ui` | Serve the stored run in the web UI, read-only, until Ctrl-C; not combinable with `--json` or `--task`; `--port` applies |

The list shows `ID  DATE  STATUS  PHASES  TASKS  TOKENS  GOAL` (local time with a relative suffix, `done/total` tasks, input+output tokens of all usage events or `n/a`, the goal clipped to the terminal width). The detail view shows the goal, repo, start, duration, status, tokens and, per phase, the plan table, each task with its status, reason and branch (only if the branch still exists), the integration result and what remained, then the answer exactly as `mar run` printed it and the saved report files.

**Scope.** History is per repository: only the runs in `<repo>/.mar/mar.db` are listed, and it lasts only while `<repo>/.mar/` exists (delete the folder and the history is gone).

**STATUS** is derived from what is stored, because nothing records that a run ended:

| Status | Meaning |
| --- | --- |
| `done` | every task of every phase is done and nothing remained after the last phase |
| `failed` | at least one task failed (a task failing with "aborted" means you stopped the run) |
| `blocked` | some task was blocked and none failed |
| `incomplete` | all tasks done but work remained (the phase or token limit was reached), or tasks never started because the run stopped |
| `planning-failed` | the run has no plan and the planner failed |
| `running` | heuristic: the newest event is under 2 minutes old and a task is still `running`; a run killed hard looks `running` for its last 2 minutes |
| `stopped` | anything else (no plan, or a task left `running` long ago) |

**Read-only guarantee.** `mar history` opens a private snapshot copy of the database (including committed rows still in its `-wal`), so the DB file, the repo, `.mar/` and the worktrees are never modified and no `-wal`/`-shm` files appear. A run that is being written while you look is shown as of the moment you started. `--ui` serves that snapshot with the Stop button hidden, a `History (read-only)` badge and `POST /api/runs/:id/stop` answering 405; the UI does not poll for changes.

**Terminal safety.** Everything printed from stored text (goals, reports, summaries, reasons, verify output), by `mar history` and by `mar run`, has ANSI/OSC escape sequences and other control characters removed (newlines and tabs are kept), so a hostile report cannot rewrite your terminal.

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
