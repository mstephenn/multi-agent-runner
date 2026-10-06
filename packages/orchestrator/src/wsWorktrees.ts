import { rm, rmdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SAFE, branchExists, createWorktrees, git, ok, type CreateCtx, type Worktrees } from "./worktree.js";
import type { WorkspaceRepo } from "./workspace.js";

const MAX_SIBLING_FILES = 50;

export interface SiblingChange { repo: string; files: string[] }

export interface WorkspaceWorktrees extends Worktrees {
  /** Absolute paths of the sibling symlinks (`<task dir>/<repo>`) the task was given; empty when it got none. */
  siblingDirs(taskId: string): string[];
  /**
   * Which sibling checkouts (shared, read-only by contract) are no longer clean. Each dirty one is reverted
   * (`git reset --hard` + `git clean`) so other tasks keep reading pristine code; the changes are reported.
   */
  checkSiblings(taskId: string): Promise<SiblingChange[]>;
}

export interface WorkspaceWorktreeOpts {
  /** Per repo name: `linkPaths` symlinked into that repo's writer worktrees. */
  linkPaths?: Record<string, string[]>;
  /** Integration branch name (same in every repo): a repo's new worktrees are cut from it when the branch exists there, else from HEAD. */
  baseRef?: string;
}

/**
 * Worktrees for a workspace run (state in `<root>/.mar`, repos are the immediate children of `root`):
 * - a writer task of repo A gets `<root>/.mar/worktrees/<run>/<task>/A` on branch `mar/<run>/<task>` (branch only in A),
 *   plus read-only symlinks `<task dir>/<other>` -> the shared checkout of the other repos when `ctx.siblings`;
 * - read-only tasks share `<root>/.mar/worktrees/<run>/.shared/<repo>` (one detached worktree per repo, no branches).
 */
export function createWorkspaceWorktrees(root: string, runId: string, repos: readonly WorkspaceRepo[], opts: WorkspaceWorktreeOpts = {}): WorkspaceWorktrees {
  if (!SAFE.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const stateRoot = resolve(root);
  const runDir = join(stateRoot, ".mar", "worktrees", runId);
  const sharedRoot = join(runDir, ".shared");
  const taskDir = (t: string) => join(runDir, t);
  const check = (t: string) => { if (!SAFE.test(t)) throw new Error(`invalid task id: ${t}`); };
  const byName = new Map(repos.map((r) => [r.name, r]));
  const need = (name: string | undefined, what: string): WorkspaceRepo => {
    const r = name === undefined ? undefined : byName.get(name);
    if (!r) throw new Error(`${what}: ${name === undefined ? "no repo given" : `unknown repo "${name}"`} (workspace repos: ${repos.map((x) => x.name).join(", ")})`);
    return r;
  };

  const insts = new Map<string, Promise<Worktrees>>();
  const inst = (name: string): Promise<Worktrees> => {
    let p = insts.get(name);
    if (!p) {
      const r = need(name, "worktree");
      p = (async () => createWorktrees(r.path, runId, {
        stateRoot, taskSubdir: name, sharedSubdir: name, linkPaths: opts.linkPaths?.[name] ?? [],
        ...(opts.baseRef && (await branchExists(opts.baseRef, r.path)) ? { baseRef: opts.baseRef } : {}),
      }))();
      insts.set(name, p);
      p.catch(() => { insts.delete(name); });
    }
    return p;
  };

  const taskRepo = new Map<string, string>();
  const siblingsOf = new Map<string, string[]>();
  const repoOf = (taskId: string) => { check(taskId); const n = taskRepo.get(taskId); if (!n) throw new Error(`task ${taskId} has no worktree in this process`); return n; };

  let sharedP: Promise<string> | undefined;
  async function acquireAll(): Promise<string> {
    const done: string[] = [];
    try {
      await Promise.all(repos.map(async (r) => { await (await inst(r.name)).shared.acquire(); done.push(r.name); }));
    } catch (e) {
      for (const n of done) await (await inst(n)).shared.release().catch(() => {});
      throw e;
    }
    return sharedRoot;
  }

  async function linkSiblings(taskId: string, own: string): Promise<void> {
    await acquireShared();
    const links: string[] = [];
    for (const r of repos) {
      if (r.name === own) continue;
      const link = join(taskDir(taskId), r.name);
      await rm(link, { recursive: true, force: true });
      await symlink(join(sharedRoot, r.name), link);
      links.push(link);
    }
    siblingsOf.set(taskId, links);
  }
  const acquireShared = () => (sharedP ??= acquireAll().catch((e) => { sharedP = undefined; throw e; }));

  return {
    branchFor: (t) => `mar/${runId}/${t}`,
    async create(taskId, dependsOn = [], ctx: CreateCtx = {}) {
      check(taskId);
      const r = need(ctx.repo, `task ${taskId}`);
      const cwd = await (await inst(r.name)).create(taskId, dependsOn);
      taskRepo.set(taskId, r.name);
      if (ctx.siblings && repos.length > 1) await linkSiblings(taskId, r.name);
      return cwd;
    },
    async commit(taskId, message) { await (await inst(repoOf(taskId))).commit(taskId, message); },
    async head(taskId) { return (await inst(repoOf(taskId))).head(taskId); },
    async changedFiles(taskId, sinceSha) { return (await inst(repoOf(taskId))).changedFiles(taskId, sinceSha); },
    async link(taskId) { return (await inst(repoOf(taskId))).link(taskId); },
    async remove(taskId) {
      const name = repoOf(taskId);
      await (await inst(name)).remove(taskId);
      await rm(taskDir(taskId), { recursive: true, force: true }); // removes the sibling symlinks, never their targets
      siblingsOf.delete(taskId);
      await rmdir(runDir).catch(() => {});
    },
    siblingDirs: (taskId) => siblingsOf.get(taskId) ?? [],
    async checkSiblings(taskId) {
      const out: SiblingChange[] = [];
      for (const link of siblingsOf.get(taskId) ?? []) {
        const name = link.slice(taskDir(taskId).length + 1);
        const dir = join(sharedRoot, name);
        try {
          const status = (await git(["status", "--porcelain", "--untracked-files=all"], dir)).split("\n").filter(Boolean);
          if (status.length === 0) continue;
          out.push({ repo: name, files: status.map((l) => l.slice(3)).slice(0, MAX_SIBLING_FILES) });
          await git(["reset", "-q", "--hard", "HEAD"], dir);
          await git(["clean", "-fdq"], dir);
        } catch { /* a checkout we cannot inspect is reported by the next task that notices; never fail bookkeeping */ }
      }
      return out;
    },
    shared: {
      acquire: acquireShared,
      async release() {
        const pending = sharedP;
        sharedP = undefined;
        await pending?.catch(() => {});
        for (const r of repos) {
          const w = await inst(r.name).catch(() => undefined);
          await w?.shared.release().catch(() => {});
          await ok(["worktree", "prune"], r.path);
        }
        await rm(sharedRoot, { recursive: true, force: true });
        await rmdir(runDir).catch(() => {});
      },
    },
  };
}

