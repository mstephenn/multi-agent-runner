import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";

const SAFE = /^[A-Za-z0-9_-]+$/;
const IDENT = ["-c", "user.name=mar", "-c", "user.email=mar@localhost"];

// All git calls go through execFile (no shell). Failures carry a capped stderr, never the env.
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return res(stdout);
      const detail = (String(stderr || "") || err.message).trim().slice(0, 300);
      rej(new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""} failed: ${detail}`));
    });
  });
}
const ok = (args: string[], cwd: string) => git(args, cwd).then(() => true, () => false);

// Exit code of a git call: 0 / 1 are answers, anything else (128, spawn failure, ...) is an error.
function gitExit(args: string[], cwd: string): Promise<number> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return res(0);
      const code = (err as { code?: unknown }).code;
      if (code === 1) return res(1);
      rej(new Error(`git ${args[0]} failed: ${(String(stderr || "") || err.message).trim().slice(0, 300)}`));
    });
  });
}
// true / false for exit 0 / 1; any other failure is rethrown (never read as "branch missing").
const branchExists = async (name: string, cwd: string) => (await gitExit(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd)) === 0;

export interface Worktrees {
  create(taskId: string, dependsOn?: string[]): Promise<string>;
  commit(taskId: string, message: string): Promise<void>;
  remove(taskId: string): Promise<void>;
  branchFor(taskId: string): string;
  // One detached (branchless) worktree at HEAD shared by all read-only tasks of the run.
  shared: { acquire(): Promise<string>; release(): Promise<void> };
}

// Keep untracked `.mar/` from making the tree "dirty" without touching the tracked .gitignore.
export async function ensureMarExcluded(repo: string): Promise<void> {
  const p = resolve(repo, (await git(["rev-parse", "--git-path", "info/exclude"], repo)).trim());
  const cur = await readFile(p, "utf8").catch(() => "");
  if (cur.split(/\r?\n/).some((l) => l.trim() === ".mar/" || l.trim() === ".mar")) return;
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${cur === "" || cur.endsWith("\n") ? "" : "\n"}.mar/\n`);
}

// Ids are restricted to [A-Za-z0-9_-]. NOTE: ids that differ only by case (`A` / `a`) collide on
// case-insensitive filesystems (macOS/Windows default): same worktree dir and loose branch ref file.
// Planner ids are lowercase (`[a-z0-9_-]+`), so this only matters for hand-written DAGs.
export function createWorktrees(repoPath: string, runId: string): Worktrees {
  if (!SAFE.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const root = resolve(repoPath); // absolute once: git runs with cwd=root, so relative paths must never reach it
  const dirFor = (t: string) => join(root, ".mar", "worktrees", runId, t);
  const branchFor = (t: string) => `mar/${runId}/${t}`;
  const check = (t: string, what = "task") => { if (!SAFE.test(t)) throw new Error(`invalid ${what} id: ${t}`); };

  const ensureExcluded = () => ensureMarExcluded(root);

  async function discard(dir: string) {
    await ok(["worktree", "remove", "--force", "--", dir], root);
    await rm(dir, { recursive: true, force: true });
    await ok(["worktree", "prune"], root);
  }

  async function createOne(taskId: string, dependsOn: string[]): Promise<string> {
    check(taskId);
    for (const d of dependsOn) check(d, "dependency");
    const dir = dirFor(taskId), branch = branchFor(taskId);
    await ensureExcluded();
    await ok(["worktree", "prune"], root);
    await discard(dir); // stale leftover from a crashed run
    const existed = await branchExists(branch, root);
    let createdBranch = false;   // true only if THIS call's `worktree add -b` succeeded
    let preMerge: string | null = null; // HEAD of a resumed branch before any dependency merge
    try {
      if (existed) await git(["worktree", "add", "--", dir, branch], root);
      else { await git(["worktree", "add", "-b", branch, "--", dir, "HEAD"], root); createdBranch = true; }
      if (existed) preMerge = (await git(["rev-parse", "HEAD"], dir)).trim();
      for (const dep of dependsOn) {
        const depBranch = branchFor(dep);
        if (!(await branchExists(depBranch, root))) throw new Error(`dependency ${dep}: branch ${depBranch} not found`);
        try {
          await git([...IDENT, "merge", "--no-edit", depBranch], dir);
        } catch (e) {
          await ok(["merge", "--abort"], dir);
          throw new Error(`dependency ${dep}: merge into ${taskId} failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      // A resumed branch holds earlier work: undo dependency merges that already committed, never delete it.
      if (preMerge) await ok(["reset", "--hard", preMerge], dir);
      await discard(dir);
      if (createdBranch) await ok(["branch", "-D", branch], root);
      throw e;
    }
    return dir;
  }

  // Dot-prefixed: can never match a task id (SAFE has no "."), so it cannot collide with a task worktree.
  const sharedDir = join(root, ".mar", "worktrees", runId, ".shared");
  async function createShared(): Promise<string> {
    await ensureExcluded();
    await ok(["worktree", "prune"], root);
    await discard(sharedDir); // stale leftover from a crashed run
    try { await git(["worktree", "add", "--detach", "--", sharedDir, "HEAD"], root); }
    catch (e) { await discard(sharedDir); throw e; }
    return sharedDir;
  }
  let sharedP: Promise<string> | undefined;

  // Serialised per createWorktrees() instance: concurrent `git worktree add`/prune/exclude edits in one repo race
  // each other. The lock does NOT span instances or processes: use one instance per repo and do not run two
  // runs against the same repo at once.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    branchFor,
    shared: {
      acquire() {
        if (!sharedP) {
          const p = queue.then(createShared);
          queue = p.catch(() => {});
          sharedP = p;
          p.catch(() => { if (sharedP === p) sharedP = undefined; }); // a failed create may be retried
        }
        return sharedP;
      },
      async release() {
        const pending = sharedP;
        sharedP = undefined;
        await pending?.catch(() => {});
        await ok(["worktree", "remove", "--force", "--", sharedDir], root);
        await rm(sharedDir, { recursive: true, force: true });
      },
    },
    create(taskId: string, dependsOn: string[] = []) {
      const p = queue.then(() => createOne(taskId, dependsOn));
      queue = p.catch(() => {});
      return p;
    },
    async commit(taskId: string, message: string) {
      check(taskId);
      const cwd = dirFor(taskId);
      // Never stage env files a worker created (secrets); they are discarded with the worktree.
      await git(["add", "-A", "--", ".", ":(exclude,glob)**/.env*"], cwd);
      if ((await gitExit(["diff", "--cached", "--quiet"], cwd)) === 0) return; // nothing staged
      await git([...IDENT, "commit", "-m", message], cwd);
    },
    async remove(taskId: string) {
      check(taskId);
      await ok(["worktree", "remove", "--force", "--", dirFor(taskId)], root);
      await rm(dirFor(taskId), { recursive: true, force: true });
    },
  };
}
