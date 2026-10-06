# multi-agent-runner (`mar`)

`mar` is a local CLI. You give it a goal; an orchestrator (a planner call) splits the goal into a DAG of tasks, in phases for big goals, and runs those tasks on the `claude` (Claude Code) and `codex` (Codex CLI) agent CLIs, each in an isolated git worktree. Agents share a small blackboard instead of long transcripts, optional verify gates check each task's work, finished work is combined on an integration branch, and a local web UI shows the graph, events and blackboard live. Every run is stored per repository so you can resume it or browse it later with `mar history`.

How it differs from running one long agent session:

- Token frugal: one planner call for a small goal, one-shot worker sessions, and each task sees only the blackboard slices it asks for.
- Nothing is merged or pushed for you. Work lands on `mar/<runId>/...` branches; your branch and working tree are never touched.
- Both runtimes in one plan: the planner picks `claude` or `codex` and a model tier per task.

## Quick start

```bash
pnpm install && pnpm build && pnpm pack:cli
npm i -g ./multi-agent-runner-0.1.0.tgz
cd path/to/your-repo                      # a git repo with a clean tree
mar run "add input validation to the signup form"
# open the printed  UI: http://127.0.0.1:4317/?run=<runId>
mar history
```

## Requirements

- Node.js >= 22 (the installed package). Running from a checkout needs >= 22.7 (`bin/mar.mjs` runs the TypeScript sources with `--experimental-transform-types`).
- `git`. The target repo needs at least one commit and a clean working tree (`mar`'s own `.mar/` and `.mar.json` do not count as changes).
- `claude` and `codex` CLIs on `PATH` and logged in. Preflight checks that both run (`--version`); it does not check login, so an unauthenticated CLI fails on its first real call.
- pnpm, only to build or develop from a checkout.

## Install

`mar` is not published to npm. Build a tarball from a checkout and install it globally:

```bash
pnpm install
pnpm build && pnpm pack:cli                    # writes ./multi-agent-runner-0.1.0.tgz
npm i -g ./multi-agent-runner-0.1.0.tgz
mar --version
```

- Update: pull, rebuild (`pnpm build && pnpm pack:cli`) and reinstall the new tarball with `npm i -g`.
- Uninstall: `npm rm -g multi-agent-runner`.
- The package is one bundled file plus the built UI; only `better-sqlite3` and `ws` are installed as dependencies.
- With nvm (or similar), global packages belong to the active Node version: install again after switching versions.

### Develop from a checkout

```bash
pnpm install
pnpm --filter @mar/ui build   # optional: builds the UI into packages/ui/dist
pnpm mar run "<goal>" --repo .
```

Without `packages/ui/dist` a run still works; `mar` prints a note and serves no UI.

## Usage

```bash
mar run "<goal>" [--repo <path>] [--repos <a,b>] [--port <n>] [--unsafe] [--budget <tokens>] [--phases <n>]
mar resume <runId> [same flags]
mar history [<runId>] [--repo <path>] [--limit <n>] [--json] [--task <id>] [--ui] [--port <n>]
mar --help | --version
```

### `mar run` and `mar resume`

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | Repository to work on (default `.`). A folder that is not a git repo but has git repos as immediate subfolders is a workspace (see below) |
| `--repos <a,b>` | Workspace only: restrict the run to these repo folders; overrides `repos` in `.mar.json` |
| `--port <n>` | UI/event server port, 1 to 65535 (default `4317`) |
| `--budget <n>` | Default per-task token budget; overrides `defaultBudgetTokens` |
| `--phases <n>` | Max planning phases for this invocation, 1 to 10; overrides `maxPhases` |
| `--unsafe` | Pass `--dangerously-skip-permissions` to Claude (dangerous; Codex is unaffected) |
| `-h`, `--help`, `-v`, `--version` | Usage / version |

`run` takes exactly one quoted goal (max 20,000 characters). `resume` takes a run id.

What is printed: the UI URL (`UI: http://127.0.0.1:<port>/?run=<runId>`); for each phase a header (`== Phase N (max M) ==`) and a plan table; each task's status and branch (read-only tasks have none); the integration result with `git merge` hints; a stop reason if the run ended early; the full answer (the report of each final task, falling back to its blackboard summary); and `Saved: <path>` lines for the stored reports. Output is stripped of terminal escape sequences and control characters.

Exit codes: `0` only if every task of every phase is done, the planner said the goal is done, and the integration (when it ran) is healthy; `1` for failures and early stops (including preflight failure, an unknown run id on resume, and an aborted run); `2` for usage errors; `130` when a second signal forces exit.

### One mode, automatic phases

There is no separate plan command and nothing waits for approval.

1. The planner sizes the goal and plans the first phase: up to `maxTasks` tasks plus `remaining`, a short text of the work left (`""` when the phase completes the goal). Small goals and exploration questions produce one phase and cost one planner call.
2. After a phase, if `remaining` is not empty, the planner is called again with the goal, the previous `remaining` and a compact history (task statuses, blackboard summaries/decisions/open questions, failure reasons, integration result and `git diff --stat`, capped at about 8,000 characters). Tasks of phase N have ids `p<N>-...`, may read finished tasks of earlier phases through `needs` (e.g. `p1-api/summary`), and start from the integration branch tip.
3. The loop stops when the planner returns no tasks (done), `maxPhases` is reached, `maxTotalTokens` is exceeded (checked before each phase), the run is aborted, or a phase finishes no task. On an early stop `mar` prints why, the `remaining` text and how to continue, and exits non-zero.

`mar resume <runId>` continues an interrupted run: it re-runs the unfinished tasks of the first unfinished phase (done tasks are kept) and keeps planning. To go past a phase limit: `mar resume <runId> --phases 8`. A finished run just reprints its result.

`maxTotalTokens` sums input and output tokens of all `usage` events of the run, workers and planner calls (planner usage counts when the planner CLI reports it). Planner file reads see your checkout, not the integration branch.

### `mar history`

Read-only; never writes to the repo or `<repo>/.mar`.

```bash
mar history                              # the 20 newest runs of this repo
mar history --limit 50 --repo ../app
mar history r1abc                        # details and full answer (unique prefix, 3+ characters)
mar history r1abc --task impl > impl.md  # one task's full report
mar history --json | jq '.[] | select(.status != "done")'
mar history --ui                         # replay the newest run in the web UI
```

| Flag | Meaning |
| --- | --- |
| `<runId>` | Show one run. Ambiguous prefix lists the matches and exits 2; unknown id exits 1 |
| `--repo <path>` | Repository whose `.mar/mar.db` to read (default `.`) |
| `--limit <n>` | Runs to list, 1 to 200 (default 20) |
| `--json` | List as a JSON array; list mode only |
| `--task <id>` | Print only that task's full report (its blackboard summary if it has none); needs a run id |
| `--ui` | Serve the stored run in the web UI, read-only, until Ctrl-C; `--port` applies; not combinable with `--json` or `--task` |

`mar history` reads a private snapshot copy of the database, so the DB, repo and worktrees are never modified. Status is derived from stored data: `done`, `failed`, `blocked`, `incomplete` (work remained or tasks never started), `planning-failed`, `running` (heuristic: newest event under 2 minutes old with a running task) and `stopped` (anything else).

## How a run works

1. Preflight: git checks (work tree, at least one commit, clean tree) and that `claude` and `codex` run.
2. Plan: the planner gets the goal and a repo map and returns tasks (role, runtime, tier, `dependsOn`, `needs`, `paths`). The plan is validated as a DAG.
3. Worktrees: under `<repo>/.mar/worktrees/<runId>/` (`.mar/` is added to `.git/info/exclude`).
4. Run tasks, up to `concurrency` in parallel. Read-only tasks (researcher/reviewer with no writer upstream) share one detached worktree and create no branches. Writers (implementer/tester, and tasks depending on them) get their own worktree on branch `mar/<runId>/<taskId>`.
5. Verify gate: if `verify` is set, each writer must pass it in its worktree before dependents see its output (`failed:verify` otherwise).
6. Ownership: a writer that changes files outside its declared `paths` is recorded (`warn`) or failed (`enforce`).
7. Integration: done writer branches are merged into `mar/<runId>/integration` (never your branch) and verified again. The branch accumulates across phases.
8. Re-plan the next phase if work remains (see above), then print the answer.

### Safety stance

- `mar` never touches your checked-out branch and never pushes. It prints `git merge <branch>` hints; merging is up to you, preferably on a feature branch.
- Tools by role: implementer and tester get `Read, Glob, Grep, Edit, Write, Bash`; other roles get `Read, Glob, Grep`. Claude runs with `--permission-mode acceptEdits`; Codex with `--sandbox workspace-write` (editing tasks) or `read-only`.
- Workers are isolated from your setup: Claude runs with `--strict-mcp-config --setting-sources ""`; Codex with `--ignore-user-config`.
- A deny list blocks push and network shell commands, and workers get a minimal child environment instead of yours.
- Output is redacted (known token formats, private keys, URL credentials, bearer tokens, values of keys named like `secret`/`token`/`password`) before it is stored or relayed.
- The event server binds `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not loopback on the configured port.
- Residual risk: this is defence in depth, not a sandbox. Bash is not OS-sandboxed and can read files outside the worktree (for example `~/.ssh` or other repos). For real isolation run `mar` in a container or VM.

## Configuration (`.mar.json`)

Optional file in the repo root. Unknown keys are rejected.

| Key | Type / range | Default | Meaning |
| --- | --- | --- | --- |
| `concurrency` | int 1 to 16 | `3` | Tasks run in parallel |
| `maxAttempts` | int 1 to 3 | `1` | Attempts per task (1 = no retry) |
| `defaultBudgetTokens` | positive int | `200000` | Per-task token budget when a task sets none; `--budget` overrides |
| `taskTimeoutMinutes` | int 1 to 240 | `20` | Per-task wall-clock limit; longer tasks are aborted |
| `maxBudgetUsdPerTask` | positive number | unset | Per-task USD cap, passed to Claude as `--max-budget-usd`; Codex has no USD guard |
| `allowOpus` | boolean | `false` | Opus models in `plannerModel`/`tiers` are rejected unless `true` |
| `plannerModel` | string | `claude-sonnet-5-5` | Model for planning calls |
| `maxTasks` | int 1 to 16 | `8` | Tasks per phase (planner prompt and validation) |
| `maxPhases` | int 1 to 10 | `5` | Phases per run; `--phases` overrides per invocation |
| `maxTotalTokens` | positive int | 5 x `defaultBudgetTokens` | Cap on all tokens of the run, checked before each phase |
| `repoMapChars` | int 2000 to 100000 | `20000` | Size of the repo map given to the planner (flat file list if it fits, else key files, a directory tree with counts and a summary line) |
| `verify` | list of commands | `[]` | Commands (split into arguments, no shell) each implementer/tester must pass in its worktree, re-run on the integration branch; `[]` turns the gate off |
| `verifyTimeoutMinutes` | int 1 to 60 | `10` | Timeout per verify run |
| `linkPaths` | list of repo-relative paths | `[]` | Paths (single-segment `*` globs such as `node_modules`, `packages/*/node_modules`) symlinked from your repo into writer worktrees so verify can run without reinstalling; secrets (`.env*`, keys), `.git` and `.mar` are refused |
| `ownership` | `"warn"` or `"enforce"` | `"warn"` | Writer touched files outside its `paths`: record an event, or fail the task (`failed:ownership`) |
| `integrate` | boolean | `true` | Build `mar/<runId>/integration` |
| `tiers` | `{claude?, codex?}` each with partial `low`/`mid`/`high` (string or null) | claude: `claude-haiku-4-5-20251001` / `claude-sonnet-5-5` / `claude-sonnet-5-5`; codex: all `null` | Model per runtime and tier; `null` uses that CLI's built-in default (Codex runs with `--ignore-user-config`, so your own Codex config is not used) |
| `repos` | list of folder names | unset | Workspace only: restrict the run to these repos; `--repos` wins |

Example:

```json
{ "verify": ["pnpm typecheck", "pnpm test"], "linkPaths": ["node_modules"], "ownership": "enforce", "maxBudgetUsdPerTask": 2 }
```

Repo-scoped vs run-level: in a workspace, the parent folder's `.mar.json` holds all keys. A child repo's own `.mar.json` may set only `verify`, `verifyTimeoutMinutes`, `linkPaths`, `ownership` and `integrate`; precedence is built-in defaults, then the parent file, then the child file. Run-level keys in a child file are ignored with one note per file.

## Multi-repo workspaces

One project can span several git repositories side by side in a parent folder (for example `shop/api`, `shop/web`). Run `mar` from the parent, or pass `--repo shop`; there is no extra command.

- Discovery: if `--repo` is inside a git work tree, nothing changes (single-repo mode, including from a child repo). Otherwise the immediate child folders containing `.git` form the workspace. Dot-folders, `node_modules`, symlinks and files are skipped; folder names must match `[A-Za-z0-9._-]+` (others are skipped with a note). No child repo is an error; one child repo is a workspace of one.
- Scope: `--repos api,web` (on `run` and `resume`) or `"repos"` in the parent `.mar.json`; the flag wins. An unknown name is an error listing the discovered repos. Out-of-scope repos are never touched and may be dirty.
- Planning: the planner sees one repo map per repo (`repoMapChars` split evenly) and gives every writer task a `repo`. A cross-repo feature becomes one writer task per repo ordered with `dependsOn`; contracts travel through `decisions`/`summary` and `needs`. `paths` are relative to the task's repo. Read-only tasks may omit `repo`.
- Branches: a writer works in `<parent>/.mar/worktrees/<run>/<task>/<repo>` on `mar/<run>/<task>`, which exists only in that repo. After each phase every repo with done writers gets its own `mar/<run>/integration`, verified with that repo's `verify`. `mar` prints `git -C <repo> merge mar/<run>/integration` hints.
- State (`.mar/mar.db`, worktrees, reports) lives in the parent folder, outside every repo; use `mar history --repo <parent>`.
- Sibling read access: a writer in `api` also sees the other repos read-only at `../web`. After the task `mar` checks them; a modified sibling is reverted and reported as a `sibling_modified` event (the task fails only with `"ownership": "enforce"`). Claude receives each sibling via `--add-dir` (edits through it are not blocked by Claude, hence the check). Codex needs no flag: its `workspace-write` sandbox allows reads of `../web` and denies writes outside the cwd. Under `/tmp` and other temp directories that sandbox treats the temp dir as writable, so a sibling write can succeed there; the post-hoc check still reverts it.
- Limits: one repo per writer task; immediate children only (no nested workspaces); every in-scope repo must be clean with at least one commit.

## The UI

`mar` serves the UI on the printed URL while a run is live; `mar history --ui` serves a stored run.

- Graph of tasks with status, runtime and role, and a phase badge (`Phase N/M`) in the header; the tooltip shows what remains after the phase.
- Inspector for the selected task with four tabs: Context (what the task was given), Activity, Output and Usage (tokens against budget).
- Activity: one row per step, with each tool call paired to its result (a call without a result shows as running). Filters: All, Messages, Tools, Errors, with counts. Click a row for its input and the full output (up to the 2,000 characters the runner stores), with a Copy button; errors start expanded. The feed follows the latest step only while you are at the bottom, otherwise a "Jump to latest" button appears. Content is rendered as plain text.
- Output tab: the task's report (plain text), or its blackboard summary.
- Bottom panel with two tabs, Timeline and Blackboard (the choice is remembered). The Timeline has one shared time axis for the replay scrubber and one lane per agent, with bars per attempt, markers for start/finish/fail and blackboard writes and reads, and a tooltip with status and duration.
- Replay: drag the scrubber or click the axis or a lane, or press Play at 1x, 2x, 4x or 8x (a run replays in about 20 seconds at 1x); Live returns to the end.
- History mode (`mar history --ui`): read-only snapshot, Stop button hidden, a `History (read-only)` badge, and `POST /api/runs/:id/stop` answers 405. The UI does not poll for changes.
- Reduced-motion preferences are respected.

## Token-saving design

- The planner runs once for a small goal (Sonnet by default); a phased run adds one re-plan call per phase. Plans are stored and reused by `resume`.
- Tasks are tiered (`low`/`mid`/`high`), each mapped to a model in `tiers`.
- A task receives only the blackboard slices listed in its `needs` (e.g. `a/summary`), not the whole history. Blackboard entries are capped at about 1,200 characters.
- Every agent call is one-shot (Claude runs with `--no-session-persistence`); no long sessions are carried.
- Per-task token budget (checked as usage arrives), `taskTimeoutMinutes`, and the optional `maxBudgetUsdPerTask` guard.
- Long task reports (up to 100,000 characters, redacted) are stored in their own SQLite table and saved to `<repo>/.mar/reports/<runId>/<taskId>.md`; they are never put on the blackboard, so they add nothing to other agents' context.
- Malformed task output gets one cheap repair call (low-tier Claude, read-only) before the task fails.
- If the selected CLI fails, `mar` retries that operation with the other CLI (planning, workers, JSON repair) using the alternate runtime's tier model. Worker tasks with `maxBudgetUsdPerTask` set do not switch CLIs, because Codex cannot enforce the USD cap.

## Project layout

| Path | Contents |
| --- | --- |
| `packages/cli` | The `mar` command: argument parsing, config, preflight, history, output rendering, build script |
| `packages/orchestrator` | Planner, phases, scheduler, worktrees, verify, integration, blackboard, redaction, repo map, workspace discovery |
| `packages/adapters` | Claude Code and Codex CLI adapters, child environment, sanitising |
| `packages/core` | Shared schemas (tasks, results, events), DAG validation, path globs |
| `packages/server` | SQLite store and the loopback HTTP/WebSocket event server |
| `packages/ui` | Web UI (React, Vite) and its Playwright e2e test |
| `docs` | Design and plan notes |

## Tests

```bash
pnpm typecheck
pnpm exec vitest run           # unit and integration tests (also: pnpm test)
pnpm test:e2e                  # browser e2e (Playwright); builds the UI first
pnpm test:live                 # opt-in, spends tokens
```

- `pnpm test:e2e` needs a browser once: `pnpm --filter @mar/ui exec playwright install chromium`.
- `pnpm test:live` runs `MAR_LIVE=1 vitest run packages/cli/test/live.test.ts` against real `claude` and `codex` in a throwaway temp git repo, and spends real tokens. Without `MAR_LIVE=1` it is skipped.

## Known limitations

- Bash is not OS-sandboxed; a worker can read files outside its worktree. Use a container or VM for untrusted goals.
- The Claude token budget is checked as usage arrives, so a long step can overshoot; `maxBudgetUsdPerTask` and `taskTimeoutMinutes` are the mid-run guards. Codex has no USD guard.
- No preflight auth check: login is not verified up front, so an unauthenticated CLI fails on its first call.
- There is no confirmed-merge step: `mar` only prints `git merge` hints.
- Accounts are whatever the CLIs are logged in as; there is no rotation.
- History is per repository, in `<repo>/.mar` (in the parent folder for workspaces), and disappears if that folder is deleted.
- Verify gates only run when `verify` is configured; otherwise nothing checks that a task's changes build or pass tests.
- Codex tier models default to Codex's built-in default until set in `.mar.json`; your own Codex config is ignored.
- In workspace mode, a task's read-only view of another repo reflects the finished work of the tasks it depends on in that repo; tasks with no such dependency see that repo as it was when the run (or phase) started. Sibling repos are for reading contracts only: workers are told not to import from them, and a worker that modifies a sibling checkout has the change detected and reverted.
- The live path (real Claude and Codex) is not exercised in CI; `pnpm test:live` is manual and opt-in.
- Under `/tmp` and other temp directories the Codex sandbox treats the temp dir as writable (see workspaces).

## License

MIT. See [LICENSE](LICENSE). The dependencies this project ships (better-sqlite3, ws, React, React Flow, anime.js, zod) are MIT licensed too.
