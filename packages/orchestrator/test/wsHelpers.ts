import { afterAll, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Registers hooks: git ignores global/system config, temp dirs made with `tmp()` are removed after each test. */
export function useGitEnv() {
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
  afterAll(() => {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  afterEach(cleanup);
}

const roots: string[] = [];
export const tmp = (prefix = "mar-ws-"): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };
export const cleanup = () => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); };

export const g = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8" });

/** A git repo (branch `main`) with one commit containing `files` (default: README.md). */
export function initRepo(dir: string, files: Record<string, string> = { "README.md": "hi\n" }) {
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main"); g(dir, "config", "user.email", "t@t"); g(dir, "config", "user.name", "t");
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "init");
}

/** A parent folder (not a git repo) with one git repo per name. */
export function tmpWorkspace(names: string[], files: (name: string) => Record<string, string> = (n) => ({ "README.md": `${n}\n`, "src/index.ts": `export const ${n.replace(/\W/g, "_")} = 1;\n` })): string {
  const root = tmp();
  for (const n of names) initRepo(join(root, n), files(n));
  return root;
}
