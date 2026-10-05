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

export interface Worktrees {
  create(taskId: string, dependsOn?: string[]): Promise<string>;
  commit(taskId: string, message: string): Promise<void>;
  remove(taskId: string): Promise<void>;
  branchFor(taskId: string): string;
}

// Keep untracked `.mar/` from making the tree "dirty" without touching the tracked .gitignore.
export async function ensureMarExcluded(repo: string): Promise<void> {
  const p = resolve(repo, (await git(["rev-parse", "--git-path", "info/exclude"], repo)).trim());
  const cur = await readFile(p, "utf8").catch(() => "");
  if (cur.split(/\r?\n/).some((l) => l.trim() === ".mar/" || l.trim() === ".mar")) return;
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${cur === "" || cur.endsWith("\n") ? "" : "\n"}.mar/\n`);
}

export function createWorktrees(repo: string, runId: string): Worktrees {
  if (!SAFE.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const dirFor = (t: string) => join(repo, ".mar", "worktrees", runId, t);
  const branchFor = (t: string) => `mar/${runId}/${t}`;
  const check = (t: string, what = "task") => { if (!SAFE.test(t)) throw new Error(`invalid ${what} id: ${t}`); };

  const ensureExcluded = () => ensureMarExcluded(repo);

  async function discard(dir: string) {
    await ok(["worktree", "remove", "--force", dir], repo);
    await rm(dir, { recursive: true, force: true });
    await ok(["worktree", "prune"], repo);
  }

  async function createOne(taskId: string, dependsOn: string[]): Promise<string> {
    check(taskId);
    for (const d of dependsOn) check(d, "dependency");
    const dir = dirFor(taskId), branch = branchFor(taskId);
    await ensureExcluded();
    await ok(["worktree", "prune"], repo);
    await discard(dir); // stale leftover from a crashed run
    const existed = await ok(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    try {
      await git(existed ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"], repo);
      for (const dep of dependsOn) {
        const depBranch = branchFor(dep);
        if (!(await ok(["rev-parse", "--verify", "--quiet", `refs/heads/${depBranch}`], repo)))
          throw new Error(`dependency ${dep}: branch ${depBranch} not found`);
        try {
          await git([...IDENT, "merge", "--no-edit", depBranch], dir);
        } catch (e) {
          await ok(["merge", "--abort"], dir);
          throw new Error(`dependency ${dep}: merge into ${taskId} failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      await discard(dir);
      if (!existed) await ok(["branch", "-D", branch], repo);
      throw e;
    }
    return dir;
  }

  // Serialised: concurrent `git worktree add`/prune/exclude edits in one repo race each other.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    branchFor,
    create(taskId: string, dependsOn: string[] = []) {
      const p = queue.then(() => createOne(taskId, dependsOn));
      queue = p.catch(() => {});
      return p;
    },
    async commit(taskId: string, message: string) {
      check(taskId);
      const cwd = dirFor(taskId);
      await git(["add", "-A"], cwd);
      if (!(await git(["status", "--porcelain"], cwd)).trim()) return;
      await git([...IDENT, "commit", "-m", message], cwd);
    },
    async remove(taskId: string) {
      check(taskId);
      await ok(["worktree", "remove", "--force", dirFor(taskId)], repo);
      await rm(dirFor(taskId), { recursive: true, force: true });
    },
  };
}
