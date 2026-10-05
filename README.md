# multi-agent-runner (`mar`)

A local CLI that takes a goal, has a planner split it into a DAG of tasks, and runs those tasks on the `claude` and `codex` CLIs in isolated git worktrees. A local web UI shows the task graph, events and shared blackboard while it runs. Every run is stored in SQLite so it can be resumed.

## Prerequisites

- Node >= 24 (`bin/mar.mjs` runs the TypeScript sources with `--experimental-transform-types`; there is no build step for the CLI)
- pnpm
- `claude` and `codex` CLIs on `PATH` and logged in. Preflight checks that both run (`--version`); it does not check login, which fails on the first real call.
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

`mar` prints `UI: http://127.0.0.1:<port>/?run=<runId>` and, at the end, each task's status and branch. `resume` re-runs only tasks that are not `done`, using the stored plan. Run state lives in `<repo>/.mar/mar.db`; `.mar/` is added to `.git/info/exclude`. Exit code is 0 only if every task finished `done`.

## `.mar.json`

Optional, in the repo root. Unknown keys are rejected. Defaults:

```json
{
  "concurrency": 3,
  "maxAttempts": 1,
  "defaultBudgetTokens": 200000,
  "plannerModel": "claude-sonnet-5-5",
  "tiers": {
    "claude": { "low": "claude-haiku-4-5-20251001", "mid": "claude-sonnet-5-5", "high": "claude-sonnet-5-5" },
    "codex":  { "low": null, "mid": null, "high": null }
  }
}
```

- `concurrency`: tasks run in parallel (positive integer).
- `maxAttempts`: attempts per task, 1 to 3. Default 1 means no retry.
- `defaultBudgetTokens`: per-task token budget, used when a task does not set its own. A task that exceeds it is aborted and fails.
- `plannerModel`: model for the single planning call.
- `tiers`: model per runtime and tier (`low`/`mid`/`high`). `null` uses that CLI's own default model (Codex by default).

## Safety model

- Each task runs in its own git worktree at `.mar/worktrees/<runId>/<taskId>`, on its own branch `mar/<runId>/<taskId>`. Your checked-out branch is not modified.
- `mar` never merges, and never pushes. When tasks finish it prints `git merge <branch>` suggestions; integrating is up to you, on a feature branch rather than `main`/`master`/`beta`.
- Tool access depends on role: implementer and tester tasks get `Read, Glob, Grep, Edit, Write, Bash`; other roles get `Read, Glob, Grep`. Claude runs with `--permission-mode acceptEdits`. Codex runs with `--sandbox workspace-write` (tasks that may edit) or `read-only`.
- `--unsafe` is off by default. It only affects Claude (`--dangerously-skip-permissions`); it is deliberately not mapped to Codex. `mar` prints a warning when it is on.
- Tasks run once by default (`maxAttempts: 1`).
- Secrets: output is passed through a redactor (known token formats, private keys, URL credentials, `Bearer` tokens, and values of keys named like `secret`/`token`/`password`/`api key`) before it is stored, relayed or sent to the JSON-repair call.
- The event server binds `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not loopback on the configured port.

## How it saves tokens

- The planner runs once per run (on the planner model, Sonnet by default). The plan is stored and reused by `resume`.
- Tasks are tiered (`low`/`mid`/`high`), each mapped to a model in `tiers`.
- A task receives only the blackboard slices listed in its `needs` (e.g. `a/summary`), not the whole history.
- Every agent call is one-shot (Claude uses `--no-session-persistence`); no long conversational sessions are carried.
- Each task has a token budget and is aborted when it exceeds it.
- Malformed task output gets one cheap repair call (low-tier Claude, read-only) before the task is failed.

## Tests

```bash
pnpm typecheck
pnpm test                      # all non-live tests (vitest workspace)
pnpm test:live                 # opt-in, see below
```

`pnpm test:live` runs `MAR_LIVE=1 vitest run packages/cli/test/live.test.ts`. It uses real `claude` and `codex` and spends real tokens (`defaultBudgetTokens: 30000` per task, `concurrency: 2`, `maxAttempts: 1`, never `--unsafe`), in a throwaway temp git repo that is deleted afterwards. Without `MAR_LIVE=1` it is reported as skipped. It fails with a clear message if either CLI is missing.

A Playwright dependency exists in `packages/ui`, but no browser e2e suite is checked in yet.

## Known limitations

- Task 14 is proposed, not built: verify gates, path ownership between tasks, and an integration branch. Today nothing checks that a task's changes build or pass tests, and parallel tasks may touch the same files.
- The live path (real Claude and Codex) is not exercised in CI; the live smoke test is manual and opt-in.
- Login is not verified up front; an unauthenticated CLI fails on the first call.
- Codex tier models default to the CLI's own default (`null`) until you set them in `.mar.json`.
- No browser e2e tests yet.
