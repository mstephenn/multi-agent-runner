import { execFile } from "node:child_process";

export type Runner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

/** Real runner: execFile (no shell), bound to `cwd`. Never throws; 127 = binary not found, 124 = timed out (child killed). */
export function nodeRunner(cwd: string, timeoutMs = 15_000): Runner {
  return (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
      if (!err) return resolve({ code: 0, out: String(stdout) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.killed) return resolve({ code: 124, out: String(stdout ?? "") });
      resolve({ code: e.code === "ENOENT" ? 127 : typeof e.code === "number" ? e.code : 1, out: String(stdout ?? "") });
    });
  });
}

// mar's own untracked state (.mar/, .mar.json) must not make the tree look dirty.
const isDirtyLine = (l: string) => l.trim() !== "" && !/^\?\? \.mar(\.json|\/.*)?$/.test(l);

/** Git checks of one repo (a work tree with at least one commit and a clean tree). */
export async function preflightRepo(repo: string, run: Runner): Promise<string[]> {
  const problems: string[] = [];
  const inRepo = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.code !== 0) problems.push(`${repo} is not a git repository`);
  else if (inRepo.out.trim() !== "true") problems.push(`${repo} is not inside a git work tree (bare repository?)`);
  else if ((await run("git", ["rev-parse", "--verify", "HEAD"])).code !== 0) problems.push(`${repo} has no commits yet; make an initial commit first`);
  else {
    const st = await run("git", ["status", "--porcelain"]);
    if (st.code !== 0) problems.push("could not determine working tree state (git status failed)");
    else if (st.out.split("\n").some(isDirtyLine)) problems.push("working tree has uncommitted changes; commit or stash first");
  }
  return problems;
}

/** The agent CLIs must be runnable. */
export async function preflightTools(run: Runner): Promise<string[]> {
  const problems: string[] = [];
  for (const bin of ["claude", "codex"]) {
    const r = await run(bin, ["--version"]);
    if (r.code !== 0) problems.push(`${bin} CLI not found or not runnable`);
  }
  return problems;
}

// Auth is not checked here; it is verified lazily by the first real adapter call.
export async function preflight(repo: string, run: Runner): Promise<string[]> {
  return [...(await preflightRepo(repo, run)), ...(await preflightTools(run))];
}

/** Workspace: every IN-SCOPE repo must pass the git checks (messages prefixed `<repo>: `); the CLIs are checked once. */
export async function preflightWorkspace(repos: readonly { name: string; path: string }[], runnerFor: (cwd: string) => Runner): Promise<string[]> {
  const problems: string[] = [];
  for (const r of repos) for (const p of await preflightRepo(r.path, runnerFor(r.path))) problems.push(`${r.name}: ${p}`);
  problems.push(...(await preflightTools(runnerFor(repos[0]?.path ?? "."))));
  return problems;
}
