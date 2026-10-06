import { execFile } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const REPO_NAME = /^[A-Za-z0-9._-]+$/;

export interface WorkspaceRepo { name: string; path: string }
export type Workspace =
  | { kind: "repo"; root: string }
  | { kind: "workspace"; root: string; repos: WorkspaceRepo[]; warnings?: string[] };

const insideWorkTree = (cwd: string): Promise<boolean> => new Promise((res) => {
  execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd }, (err, out) => res(!err && String(out).trim() === "true"));
});
const exists = (p: string) => lstat(p).then(() => true, () => false);

/**
 * Single-repo mode when `path` is inside a git work tree; otherwise its IMMEDIATE child git repositories form a workspace
 * (directories, not symlinks, not dot-dirs / node_modules, with a `.git` dir or file, names `[A-Za-z0-9._-]+`), sorted by name.
 * `opts.repos` (from `--repos` / `.mar.json`) restricts the workspace to the named repos.
 */
export async function resolveWorkspace(path: string, opts: { repos?: readonly string[] } = {}): Promise<Workspace> {
  const root = resolve(path);
  if (!(await stat(root).then((s) => s.isDirectory(), () => false))) throw new Error(`${root} does not exist or is not a directory`);
  if (await insideWorkTree(root)) {
    if (opts.repos !== undefined && opts.repos.length > 0) throw new Error(`--repos only applies when ${root} is a parent folder of git repositories, not a repository itself`);
    return { kind: "repo", root };
  }
  const warnings: string[] = [];
  const found: WorkspaceRepo[] = [];
  for (const e of (await readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    if (!(await exists(join(root, e.name, ".git")))) continue;
    if (!REPO_NAME.test(e.name)) { warnings.push(`skipping "${e.name}": repository folder names may only contain letters, digits, ".", "_" and "-"`); continue; }
    found.push({ name: e.name, path: join(root, e.name) });
  }
  if (found.length === 0) throw new Error(`${root} is not a git repository and has no git repositories in its immediate subfolders`);
  let repos = found;
  if (opts.repos !== undefined && opts.repos.length > 0) {
    const want = new Set(opts.repos);
    for (const n of want) if (!found.some((r) => r.name === n)) throw new Error(`unknown repo "${n}" in ${root} (found: ${found.map((r) => r.name).join(", ")})`);
    repos = found.filter((r) => want.has(r.name));
  }
  return { kind: "workspace", root, repos, ...(warnings.length ? { warnings } : {}) };
}
