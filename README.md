# multi-agent-runner (`mar`)

A local CLI that takes a goal, has a planner split it into a DAG of tasks, and runs those tasks on the `claude` and `codex` CLIs in isolated git worktrees. A local web UI shows the task graph, events and shared blackboard while it runs. Every run is stored in SQLite so it can be resumed.

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
| `--unsafe` | Disable Claude permission prompts (dangerous; see below) |
| `-h`, `--help` | Show usage |

`mar` prints `UI: http://127.0.0.1:<port>/?run=<runId>` and, at the end, each task's status and branch (read-only tasks have none). `resume` re-runs only tasks that are not `done`, using the stored plan. Run state lives in `<repo>/.mar/mar.db`; `.mar/` is added to `.git/info/exclude`. Exit code is 0 only if every task finished `done`.

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
  "tiers": {
    "claude": { "low": "claude-haiku-4-5-20251001", "mid": "claude-sonnet-5-5", "high": "claude-sonnet-5-5" },
    "codex":  { "low": null, "mid": null, "high": null }
  }
}
```

`maxBudgetUsdPerTask` is optional and has no default (unset, no USD cap); add e.g. `"maxBudgetUsdPerTask": 2` to enable it.

- `concurrency`: tasks run in parallel, 1 to 16.
- `maxAttempts`: attempts per task, 1 to 3. Default 1 means no retry.
- `defaultBudgetTokens`: per-task token budget, used when a task does not set its own. Checked when usage events arrive; Claude reports usage at the end of a call, so this is not a mid-run guard.
- `taskTimeoutMinutes`: per-task wall-clock limit, 1 to 240 (default 20). A task that runs longer is aborted, which stops hung workers.
- `maxBudgetUsdPerTask`: positive number of USD per task. This is the real mid-run spend guard (passed to Claude as `--max-budget-usd`, so the CLI stops itself; Codex workers have no USD guard, only the timeout and token budget).
- `allowOpus`: default `false`; Opus models in `plannerModel`/`tiers` are rejected unless this is `true`.
- `plannerModel`: model for the single planning call.
- `tiers`: model per runtime and tier (`low`/`mid`/`high`). `null` uses that CLI's default model. For Codex, workers run with `--ignore-user-config`, so "default model" is Codex's built-in default, not the model in your own Codex config.

## Safety model

- Tasks that can write (implementer/tester, and anything that depends on them) run in their own git worktree at `.mar/worktrees/<runId>/<taskId>`, on their own branch `mar/<runId>/<taskId>`. Read-only tasks (researcher/reviewer roles with no writer upstream and no Edit/Write/Bash tools) share ONE detached worktree at `.mar/worktrees/<runId>/.shared` and create no branches, so a pure exploration goal makes one worktree and zero branches. Your checked-out branch is not modified.
- `mar` never merges, and never pushes. When tasks finish it prints `git merge <branch>` suggestions for branches that exist (or says no branches were created); integrating is up to you, on a feature branch rather than `main`/`master`/`beta`.
- Tool access depends on role: implementer and tester tasks get `Read, Glob, Grep, Edit, Write, Bash`; other roles get `Read, Glob, Grep`. Claude runs with `--permission-mode acceptEdits`. Codex runs with `--sandbox workspace-write` (tasks that may edit) or `read-only`.
- `--unsafe` is off by default. It only affects Claude (`--dangerously-skip-permissions`); it is deliberately not mapped to Codex. `mar` prints a warning when it is on.
- Tasks run once by default (`maxAttempts: 1`).
- Workers are isolated from your user setup: Claude runs with `--strict-mcp-config --setting-sources ""` (no user MCP servers or settings); Codex runs with `--ignore-user-config`.
- Defence in depth, not a sandbox: a deny list blocks push and network shell commands, and workers get a minimal child environment instead of your full one. These reduce risk but do not contain a determined or prompt-injected agent.
- Bash can still read files outside the worktree (for example `~/.ssh` or other repos). Real isolation needs OS-level sandboxing (container/VM), which `mar` does not provide.
- Secrets: output is passed through a redactor (known token formats, private keys, URL credentials, `Bearer` tokens, and values of keys named like `secret`/`token`/`password`/`api key`) before it is stored, relayed or sent to the JSON-repair call.
- The event server binds `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not loopback on the configured port.

## How it saves tokens

- The planner runs once per run (on the planner model, Sonnet by default). The plan is stored and reused by `resume`.
- Tasks are tiered (`low`/`mid`/`high`), each mapped to a model in `tiers`.
- A task receives only the blackboard slices listed in its `needs` (e.g. `a/summary`), not the whole history.
- Every agent call is one-shot (Claude uses `--no-session-persistence`); no long conversational sessions are carried.
- Each task has a token budget, checked as usage events arrive (Claude reports usage at the end of a call, so this is a coarse after-the-fact limit). `maxBudgetUsdPerTask` is the mid-run USD guard, and `taskTimeoutMinutes` aborts hung workers.
- Malformed task output gets one cheap repair call (low-tier Claude, read-only) before the task is failed.

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

- Task 14 is proposed, not built: verify gates, path ownership between tasks, and an integration branch. Today nothing checks that a task's changes build or pass tests, and parallel tasks may touch the same files.
- The live path (real Claude and Codex) is not exercised in CI; the live smoke test is manual and opt-in.
- Preflight auth check: NOT done. Login is not verified up front; an unauthenticated CLI fails on the first call.
- Confirmed merge step: NOT implemented. `mar` only prints `git merge <branch>` hints and never merges.
- Codex tier models default to Codex's built-in default (`null`) until you set them in `.mar.json`; your own Codex config is ignored.
- Browser e2e tests exist but are not run by `pnpm test` or CI.
