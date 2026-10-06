import { rm, rmdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IDENT, SAFE, branchExists, createWorktrees, discardWorktree, git, ok, type CreateCtx, type Worktrees } from "./worktree.js";
import type { WorkspaceRepo } from "./workspace.js";

const MAX_SIBLING_FILES = 50;

export interface SiblingChange { repo: string; files: string[] }

export interface WorkspaceWorktrees extends Worktrees {
  /** Absolute paths of the sibling symlinks (`<task dir>/<repo>`) the task was given; empty when it got none. */
  siblingDirs(taskId: string): string[];
  /**
   * Which sibling checkouts (shared or per-task, read-only by contract) are no longer clean. Each dirty one is reverted
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
  // Per-task sibling checkouts (repos whose view includes dependency work): task -> repo name -> checkout dir.
  const ownViews = new Map<string, Map<string, string>>();
  const ownViewRoot = (t: string) => join(runDir, ".sib", t);
  // One `git worktree add` at a time per repo (the per-repo instances serialise their own calls the same way).
  const viewQueues = new Map<string, Promise<unknown>>();
  const serial = <T>(repo: string, f: () => Promise<T>): Promise<T> => {
    const p = (viewQueues.get(repo) ?? Promise.resolve()).then(f);
    viewQueues.set(repo, p.catch(() => {}));
    return p;
  };
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

  /** Detached checkout of `r` at its base ref with the `deps` branches (of that repo) merged in. */
  async function createView(taskId: string, r: WorkspaceRepo, deps: string[]): Promise<string> {
    const dir = join(ownViewRoot(taskId), r.name);
    const base = opts.baseRef && (await branchExists(opts.baseRef, r.path)) ? opts.baseRef : "HEAD";
    return serial(r.name, async () => {
      await discardWorktree(r.path, dir); // stale leftover from a crashed run
      try {
        await git(["worktree", "add", "--detach", "--", dir, base], r.path);
        for (const dep of deps) {
          check(dep);
          const depBranch = `mar/${runId}/${dep}`;
          if (!(await branchExists(depBranch, r.path))) throw new Error(`sibling repo ${r.name}: dependency ${dep}: branch ${depBranch} not found`);
          try { await git([...IDENT, "merge", "--no-edit", depBranch], dir); }
          catch (e) { await ok(["merge", "--abort"], dir); throw new Error(`sibling repo ${r.name}: dependency ${dep}: merge into the sibling view of ${taskId} failed: ${(e as Error).message}`); }
        }
      } catch (e) { await discardWorktree(r.path, dir); throw e; }
      return dir;
    });
  }
  async function dropViews(taskId: string): Promise<void> {
    for (const [name, dir] of ownViews.get(taskId) ?? []) await discardWorktree(need(name, "sibling view").path, dir).catch(() => {});
    ownViews.delete(taskId);
    await rm(ownViewRoot(taskId), { recursive: true, force: true });
    await rmdir(join(runDir, ".sib")).catch(() => {});
  }

  async function linkSiblings(taskId: string, own: string, deps: Record<string, string[]>): Promise<void> {
    await acquireShared();
    const links: string[] = [];
    siblingsOf.set(taskId, links);
    for (const r of repos) {
      if (r.name === own) continue;
      const link = join(taskDir(taskId), r.name);
      await rm(link, { recursive: true, force: true });
      const want = deps[r.name] ?? [];
      let target = join(sharedRoot, r.name);
      if (want.length > 0) {
        target = await createView(taskId, r, want);
        let m = ownViews.get(taskId); if (!m) ownViews.set(taskId, (m = new Map()));
        m.set(r.name, target);
      }
      await symlink(target, link);
      links.push(link);
    }
  }
  const acquireShared = () => (sharedP ??= acquireAll().catch((e) => { sharedP = undefined; throw e; }));

  async function removeTask(taskId: string): Promise<void> {
    const name = repoOf(taskId);
    await (await inst(name)).remove(taskId);
    await rm(taskDir(taskId), { recursive: true, force: true }); // removes the sibling symlinks, never their targets
    await dropViews(taskId);
    siblingsOf.delete(taskId);
    await rmdir(runDir).catch(() => {});
  }

  return {
    branchFor: (t) => `mar/${runId}/${t}`,
    async create(taskId, dependsOn = [], ctx: CreateCtx = {}) {
      check(taskId);
      const r = need(ctx.repo, `task ${taskId}`);
      const existed = await branchExists(`mar/${runId}/${taskId}`, r.path);
      const cwd = await (await inst(r.name)).create(taskId, dependsOn);
      taskRepo.set(taskId, r.name);
      if (ctx.siblings && repos.length > 1) {
        try { await linkSiblings(taskId, r.name, ctx.siblingDeps ?? {}); }
        catch (e) {
          // The scheduler does not remove a task whose create failed; a branch this call created holds no work.
          await removeTask(taskId).catch(() => {});
          if (!existed) await ok(["branch", "-D", `mar/${runId}/${taskId}`], r.path);
          throw e;
        }
      }
      return cwd;
    },
    async commit(taskId, message) { await (await inst(repoOf(taskId))).commit(taskId, message); },
    async head(taskId) { return (await inst(repoOf(taskId))).head(taskId); },
    async changedFiles(taskId, sinceSha) { return (await inst(repoOf(taskId))).changedFiles(taskId, sinceSha); },
    async link(taskId) { return (await inst(repoOf(taskId))).link(taskId); },
    remove: removeTask,
    siblingDirs: (taskId) => siblingsOf.get(taskId) ?? [],
    async checkSiblings(taskId) {
      const out: SiblingChange[] = [];
      for (const link of siblingsOf.get(taskId) ?? []) {
        const name = link.slice(taskDir(taskId).length + 1);
        const dir = ownViews.get(taskId)?.get(name) ?? join(sharedRoot, name);
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

