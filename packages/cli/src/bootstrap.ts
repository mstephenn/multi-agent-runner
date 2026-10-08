import { readdir, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Runner } from "./preflight.js";

const IDENT = ["-c", "user.name=mar", "-c", "user.email=mar@localhost"];

/** A folder that is not in a git work tree and has no immediate child git repos becomes a repo (`git init -b main`). Returns true if it did. */
export async function initIfNoRepo(path: string, run: Runner): Promise<boolean> {
  if (!(await stat(path).then((s) => s.isDirectory(), () => false))) return false;
  if ((await run("git", ["rev-parse", "--is-inside-work-tree"])).out.trim() === "true") return false;
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && await lstat(join(path, e.name, ".git")).then(() => true, () => false)) return false;
  }
  const r = await run("git", ["init", "-b", "main"]);
  if (r.code !== 0) throw new Error(`git init failed in ${path}`);
  return true;
}

/** A repo with no commits gets an initial commit of its existing (non-ignored) files, so worktrees have a base and the tree is clean. Returns true if it committed. */
export async function ensureInitialCommit(run: Runner): Promise<boolean> {
  if ((await run("git", ["rev-parse", "--is-inside-work-tree"])).out.trim() !== "true") return false;
  if ((await run("git", ["rev-parse", "--verify", "HEAD"])).code === 0) return false;
  if ((await run("git", ["add", "-A"])).code !== 0) throw new Error("could not stage files for the initial commit");
  const r = await run("git", [...IDENT, "commit", "--allow-empty", "-m", "chore: initial commit (mar)"]);
  if (r.code !== 0) throw new Error("could not create an initial commit");
  return true;
}
