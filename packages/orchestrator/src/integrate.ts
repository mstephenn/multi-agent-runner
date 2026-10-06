import { rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IDENT, SAFE, branchExists, discardWorktree, ensureMarExcluded, git, linkInto, ok, validBaseRef } from "./worktree.js";
import { runVerify as realRunVerify, type VerifyResult } from "./verify.js";

export interface IntegrateOpts {
  repo: string;
  runId: string;
  /** Done WRITER branches in topological order. */
  branches: string[];
  verify?: { commands: string[]; timeoutMs: number };
  /** Same single-segment-glob paths as `createWorktrees({ linkPaths })`; linked only when verify commands exist. */
  linkPaths?: string[];
  /** Commit-ish a NEW integration branch is cut from (default: the repo's current HEAD). */
  baseRef?: string;
  /**
   * Default true: (re)create the integration branch from `baseRef`/HEAD. `false` continues from the existing integration
   * tip (phase N >= 2 accumulates); if the branch does not exist yet it is created from `baseRef`/HEAD.
   */
  reset?: boolean;
  signal?: AbortSignal;
  runVerify?: typeof realRunVerify;
}
export interface IntegrateResult {
  branch: string;
  merged: string[];
  conflict?: { branch: string; files: string[] };
  verify?: Pick<VerifyResult, "ok" | "failed" | "tail">;
}

const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const validBranch = (b: string) => BRANCH.test(b) && !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock");

/**
 * Merges `branches` (in order) into `mar/<runId>/integration` (by default a fresh branch cut from the repo's CURRENT HEAD; with `reset: false` the
 * existing branch is continued, so later phases accumulate on top of earlier ones), in a
 * temporary worktree. The repo's own branch, HEAD and working tree are never touched. Stops at the first conflict
 * (that merge is aborted; earlier merges stay), then verifies the result when no conflict occurred. The temporary
 * worktree is always removed; the branch is kept. By default re-running recreates the branch (`-B`).
 */
export async function integrate(o: IntegrateOpts): Promise<IntegrateResult> {
  if (!SAFE.test(o.runId)) throw new Error(`invalid run id: ${o.runId}`);
  for (const b of o.branches) if (!validBranch(b)) throw new Error(`invalid branch name: ${b}`);
  const root = resolve(o.repo);
  const branch = `mar/${o.runId}/integration`;
  const runDir = join(root, ".mar", "worktrees", o.runId);
  const dir = join(runDir, ".integration");
  const verifyFn = o.runVerify ?? realRunVerify;

  const current = (await git(["symbolic-ref", "--short", "-q", "HEAD"], root).catch(() => "")).trim();
  if (current === branch) throw new Error(`refusing to integrate: ${branch} is the current branch`);
  for (const b of o.branches) if (!(await branchExists(b, root))) throw new Error(`branch ${b} not found`);
  if (o.baseRef !== undefined && o.baseRef !== "HEAD" && !validBaseRef(o.baseRef)) throw new Error(`invalid baseRef: ${JSON.stringify(o.baseRef)}`);
  const base = (await git(["rev-parse", "--verify", `${o.baseRef ?? "HEAD"}^{commit}`], root)).trim();
  const continueTip = o.reset === false && (await branchExists(branch, root));

  await ensureMarExcluded(root);
  await ok(["worktree", "prune"], root);
  await discardWorktree(root, dir); // stale leftover from a crashed run
  try {
    if (continueTip) await git(["worktree", "add", "--", dir, branch], root);
    else await git(["worktree", "add", "-B", branch, "--", dir, base], root);
    const merged: string[] = [];
    for (const b of o.branches) {
      if (o.signal?.aborted) throw new Error("integration aborted");
      try {
        await git([...IDENT, "merge", "--no-ff", "--no-edit", b], dir);
      } catch (e) {
        // Collect the conflicted files BEFORE aborting: abort clears the index.
        const files = (await git(["diff", "--name-only", "--diff-filter=U"], dir).catch(() => "")).split("\n").filter(Boolean);
        await ok(["merge", "--abort"], dir);
        if (files.length === 0) throw new Error(`merging ${b} into ${branch} failed: ${(e as Error).message}`);
        return { branch, merged, conflict: { branch: b, files } };
      }
      merged.push(b);
    }
    if (o.signal?.aborted) throw new Error("integration aborted");
    const commands = o.verify?.commands ?? [];
    if (commands.length === 0) return { branch, merged };
    if (o.linkPaths?.length) await linkInto(root, dir, o.linkPaths);
    const v = await verifyFn(dir, commands, { signal: o.signal, timeoutMs: o.verify!.timeoutMs });
    return { branch, merged, verify: { ok: v.ok, failed: v.failed, tail: v.tail } };
  } finally {
    await discardWorktree(root, dir).catch(() => {});
    await rmdir(runDir).catch(() => {}); // only succeeds when empty
  }
}
