import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { appendFile, lstat, mkdir, readFile, readdir, rm, rmdir, stat, symlink } from "node:fs/promises";

export const SAFE = /^[A-Za-z0-9_-]+$/;
export const IDENT = ["-c", "user.name=mar", "-c", "user.email=mar@localhost"];

// All git calls go through execFile (no shell). Failures carry a capped stderr, never the env.
export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return res(stdout);
      const detail = (String(stderr || "") || err.message).trim().slice(0, 300);
      rej(new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""} failed: ${detail}`));
    });
  });
}
/** A dependency branch could not be merged into a new worktree: `files` are the conflicted paths (read before the merge was aborted). */
export class DependencyMergeConflict extends Error {
  constructor(public task: string, public dependency: string, public files: string[], public repo?: string) {
    super(`${repo ? `sibling repo ${repo}: ` : ""}dependency ${dependency}: merge conflict in ${files.join(", ")}`);
    this.name = "DependencyMergeConflict";
  }
}
/** Conflicted files of the merge in progress in `dir` (empty when the merge failed for another reason). */
export const conflictedFiles = async (dir: string): Promise<string[]> =>
  (await git(["diff", "--name-only", "--diff-filter=U"], dir).catch(() => "")).split("\n").filter(Boolean);
export const ok = (args: string[], cwd: string) => git(args, cwd).then(() => true, () => false);

// Exit code of a git call: 0 / 1 are answers, anything else (128, spawn failure, ...) is an error.
export function gitExit(args: string[], cwd: string): Promise<number> {
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
export const branchExists = async (name: string, cwd: string) => (await gitExit(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd)) === 0;

// --- dependency links (node_modules and friends) -------------------------------------------------------------------

// Names that must never be linked into a worktree: secrets and git/mar internals.
const secretName = (n: string) => /^\.env/.test(n) || /\.pem$/i.test(n) || /^id_rsa/.test(n) || n === ".git" || n === ".mar";

/** Why `p` is not an acceptable `linkPaths` entry (repo-relative, single-segment `*` globs only), or null. */
export function linkPathProblem(p: string): string | null {
  if (p === "") return "is empty";
  if (p.includes("\\")) return "contains a backslash";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "is absolute";
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `has an invalid segment "${seg}"`;
    if (seg.includes("**")) return "uses **, only single-segment * globs are supported";
    if (secretName(seg)) return `names a protected path ("${seg}")`;
  }
  return null;
}

const globRe = (seg: string) => new RegExp("^" + seg.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");

/** Repo-relative paths (posix) under `root` matching `patterns`; only entries that exist. */
export async function expandLinkPaths(root: string, patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const pat of patterns) {
    let bases = [""];
    for (const seg of pat.split("/")) {
      const next: string[] = [];
      for (const b of bases) {
        if (!seg.includes("*")) { next.push(b ? `${b}/${seg}` : seg); continue; }
        const re = globRe(seg);
        const names = await readdir(join(root, b)).catch(() => [] as string[]);
        for (const n of names) if (re.test(n) && !secretName(n) && (seg.startsWith(".") || !n.startsWith("."))) next.push(b ? `${b}/${n}` : n);
      }
      bases = next;
    }
    for (const b of bases) if (await lstat(join(root, b)).then(() => true, () => false)) found.add(b);
  }
  return [...found].sort();
}

/** Symlinks (absolute target in `root`) each existing match into `dir`; skips destinations that already exist or whose parent is missing. */
export async function linkInto(root: string, dir: string, patterns: string[]): Promise<string[]> {
  const linked: string[] = [];
  for (const rel of await expandLinkPaths(root, patterns)) {
    const dest = join(dir, rel);
    if (!(await stat(dirname(dest)).then((s) => s.isDirectory(), () => false))) continue;
    if (await lstat(dest).then(() => true, () => false)) continue; // tracked (or otherwise present): never replace
    await symlink(join(root, rel), dest);
    linked.push(rel);
  }
  return linked;
}

// Pathspecs that keep our own symlinks out of `git add -A` (a trailing-slash ignore rule does not match a symlink).
async function linkExcludes(root: string, dir: string, patterns: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const rel of await expandLinkPaths(root, patterns))
    if (await lstat(join(dir, rel)).then((s) => s.isSymbolicLink(), () => false)) out.push(`:(exclude,literal)${rel}`);
  return out;
}

/** Removes a worktree directory (forced), prunes stale registrations. Never throws for a missing dir. */
export async function discardWorktree(root: string, dir: string): Promise<void> {
  await ok(["worktree", "remove", "--force", "--", dir], root);
  await rm(dir, { recursive: true, force: true });
  await ok(["worktree", "prune"], root);
}

const BASE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
/** Whether `ref` is acceptable as a worktree base (branch name or sha): no leading dash, no `..`, no odd characters. */
export const validBaseRef = (ref: string) => BASE_REF.test(ref) && !ref.includes("..") && !ref.endsWith("/") && !ref.endsWith(".lock");

export interface WorktreeOpts {
  /** Commit-ish every NEW worktree (task and shared) is cut from; default `HEAD`. Phase N >= 2 passes the integration branch. */
  baseRef?: string;
  /** Repo-relative paths (single-segment `*` globs allowed) symlinked from the main repo into writer worktrees by `link`. */
  linkPaths?: string[];
  /**
   * Workspace mode: the PARENT folder that holds the run state. Worktrees then live under `<stateRoot>/.mar/worktrees/<runId>`
   * (outside every child repo, so `.git/info/exclude` is never edited) instead of `<repo>/.mar/worktrees/<runId>`.
   */
  stateRoot?: string;
  /** Workspace mode: a task's worktree is `<run dir>/<taskId>/<taskSubdir>` (the task dir also holds sibling symlinks). */
  taskSubdir?: string;
  /**
   * On a dependency merge conflict, leave the merge in progress in the task's worktree (instead of failing) so the task
   * resolves it first; see `Worktrees.pendingMerges`. `commit` then refuses unresolved conflicts or unmerged dependencies.
   */
  resolveConflicts?: boolean;
  /** Workspace mode: the detached shared worktree is `<run dir>/.shared/<sharedSubdir>`. */
  sharedSubdir?: string;
}

/** Per-task context of `Worktrees.create` (workspace mode only). */
export interface CreateCtx {
  /** Workspace repo (folder name) the task's branch lives in. */
  repo?: string;
  /** Also expose the other repos as read-only symlinks next to the task's repo worktree. */
  siblings?: boolean;
  /**
   * Workspace mode, with `siblings`: per OTHER repo, the finished tasks (of that repo) the new task depends on, directly or
   * transitively. That repo's sibling view is then a per-task detached checkout with their branches merged in,
   * instead of the shared checkout.
   */
  siblingDeps?: Record<string, string[]>;
}

/** A dependency merge left in progress for the task to resolve: the conflicted dependency branch, its files, and the dependency branches still to merge. */
export interface PendingMerge { branch: string; files: string[]; remaining: string[] }

export interface Worktrees {
  /** Present with `resolveConflicts`: the merge the task must resolve before its own work (cleared when the task is created again). */
  pendingMerges?(taskId: string): PendingMerge | undefined;
  create(taskId: string, dependsOn?: string[], ctx?: CreateCtx): Promise<string>;
  commit(taskId: string, message: string): Promise<void>;
  remove(taskId: string): Promise<void>;
  branchFor(taskId: string): string;
  /** HEAD sha of the task's worktree. */
  head(taskId: string): Promise<string>;
  /** Files changed on the task's branch since `sinceSha` (renames reported as delete + add). */
  changedFiles(taskId: string, sinceSha: string): Promise<string[]>;
  /** Symlinks the configured `linkPaths` into the task's worktree; returns the linked repo-relative paths. */
  link(taskId: string): Promise<string[]>;
  // One detached (branchless) worktree at the base ref (HEAD by default) shared by all read-only tasks of the run.
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
export function createWorktrees(repoPath: string, runId: string, opts: WorktreeOpts = {}): Worktrees {
  if (!SAFE.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const links = opts.linkPaths ?? [];
  const baseRef = opts.baseRef ?? "HEAD";
  if (baseRef !== "HEAD" && !validBaseRef(baseRef)) throw new Error(`invalid baseRef: ${JSON.stringify(baseRef)}`);
  for (const p of links) { const why = linkPathProblem(p); if (why) throw new Error(`invalid link path ${JSON.stringify(p)}: ${why}`); }
  const root = resolve(repoPath); // absolute once: git runs with cwd=root, so relative paths must never reach it
  const runDir = join(resolve(opts.stateRoot ?? repoPath), ".mar", "worktrees", runId);
  const dirFor = (t: string) => (opts.taskSubdir ? join(runDir, t, opts.taskSubdir) : join(runDir, t));
  const branchFor = (t: string) => `mar/${runId}/${t}`;
  const pending = new Map<string, PendingMerge>();
  const check = (t: string, what = "task") => { if (!SAFE.test(t)) throw new Error(`invalid ${what} id: ${t}`); };

  const ensureExcluded = () => (opts.stateRoot ? Promise.resolve() : ensureMarExcluded(root));

  const discard = (dir: string) => discardWorktree(root, dir);

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
    pending.delete(taskId);
    try {
      if (existed) await git(["worktree", "add", "--", dir, branch], root);
      else { await git(["worktree", "add", "-b", branch, "--", dir, baseRef], root); createdBranch = true; }
      if (existed) preMerge = (await git(["rev-parse", "HEAD"], dir)).trim();
      for (const dep of dependsOn) {
        const depBranch = branchFor(dep);
        if (!(await branchExists(depBranch, root))) throw new Error(`dependency ${dep}: branch ${depBranch} not found`);
        try {
          await git([...IDENT, "merge", "--no-edit", depBranch], dir);
        } catch (e) {
          const files = await conflictedFiles(dir); // before any abort: it clears the index
          if (files.length > 0 && opts.resolveConflicts) { // keep the conflicted merge in the worktree for the task to resolve
            pending.set(taskId, { branch: depBranch, files, remaining: dependsOn.slice(dependsOn.indexOf(dep) + 1).map(branchFor) });
            break;
          }
          await ok(["merge", "--abort"], dir);
          if (files.length > 0) throw new DependencyMergeConflict(taskId, dep, files);
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

  const requireMerged = async (pm: PendingMerge, cwd: string) => {
    for (const b of [pm.branch, ...pm.remaining])
      if (!(await ok(["merge-base", "--is-ancestor", b, "HEAD"], cwd))) throw new Error(`dependency branch ${b} was not merged into the task`);
  };

  // Dot-prefixed: can never match a task id (SAFE has no "."), so it cannot collide with a task worktree.
  const sharedDir = opts.sharedSubdir ? join(runDir, ".shared", opts.sharedSubdir) : join(runDir, ".shared");
  // rmdir only succeeds on an empty directory, so this tidies the run folder once its last worktree is gone and is a
  // harmless no-op (ENOTEMPTY/ENOENT) while others are still in use.
  const pruneRunDir = () => rmdir(runDir).catch(() => {});
  async function createShared(): Promise<string> {
    await ensureExcluded();
    await ok(["worktree", "prune"], root);
    await discard(sharedDir); // stale leftover from a crashed run
    try { await git(["worktree", "add", "--detach", "--", sharedDir, baseRef], root); }
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
    async head(taskId: string) { check(taskId); return (await git(["rev-parse", "HEAD"], dirFor(taskId))).trim(); },
    async changedFiles(taskId: string, sinceSha: string) {
      check(taskId);
      if (!/^[0-9a-f]{7,64}$/.test(sinceSha)) throw new Error(`invalid sha: ${sinceSha}`);
      const out = await git(["diff", "--name-only", "--no-renames", "-z", `${sinceSha}..HEAD`, "--"], dirFor(taskId));
      return out.split("\0").filter(Boolean);
    },
    async link(taskId: string) {
      check(taskId);
      return links.length ? linkInto(root, dirFor(taskId), links) : [];
    },
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
        await pruneRunDir();
      },
    },
    ...(opts.resolveConflicts ? { pendingMerges: (taskId: string) => pending.get(taskId) } : {}),
    create(taskId: string, dependsOn: string[] = [], _ctx?: CreateCtx) {
      const p = queue.then(() => createOne(taskId, dependsOn));
      queue = p.catch(() => {});
      return p;
    },
    async commit(taskId: string, message: string) {
      check(taskId);
      const cwd = dirFor(taskId);
      const pm = pending.get(taskId);
      if (pm) { // the task was handed a conflicted merge: it must have resolved it and merged every dependency
        const unmerged = await conflictedFiles(cwd);
        const markers = (await git(["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) ", "--", ...pm.files], cwd).catch(() => "")).split("\n").filter(Boolean);
        if (unmerged.length || markers.length) throw new Error(`unresolved merge conflict in ${[...new Set([...unmerged, ...markers])].join(", ")}`);
      }
      // Never stage env files a worker created (secrets); they are discarded with the worktree.
      await git(["add", "-A", "--", ".", ":(exclude,glob)**/.env*", ...(links.length ? await linkExcludes(root, cwd, links) : [])], cwd);
      const merging = await ok(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd); // a resolved merge is committed even when it stages nothing
      if ((await gitExit(["diff", "--cached", "--quiet"], cwd)) === 0 && !merging) { if (pm) await requireMerged(pm, cwd); return; } // nothing staged
      await git([...IDENT, "commit", "-m", message], cwd);
      if (pm) await requireMerged(pm, cwd);
    },
    async remove(taskId: string) {
      check(taskId);
      await ok(["worktree", "remove", "--force", "--", dirFor(taskId)], root);
      await rm(dirFor(taskId), { recursive: true, force: true });
      await pruneRunDir();
    },
  };
}
