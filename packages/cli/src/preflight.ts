import { execFile } from "node:child_process";

export type Runner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

/** Real runner: execFile (no shell), bound to `cwd`. Never throws; 127 = binary not found. */
export function nodeRunner(cwd: string): Runner {
  return (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, out: String(stdout) });
      const e = err as NodeJS.ErrnoException;
      resolve({ code: e.code === "ENOENT" ? 127 : typeof e.code === "number" ? e.code : 1, out: String(stdout ?? "") });
    });
  });
}

// Auth is not checked here; it is verified lazily by the first real adapter call.
export async function preflight(repo: string, run: Runner): Promise<string[]> {
  const problems: string[] = [];
  const inRepo = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.code !== 0) problems.push(`${repo} is not a git repository`);
  else if ((await run("git", ["rev-parse", "--verify", "HEAD"])).code !== 0) problems.push(`${repo} has no commits yet; make an initial commit first`);
  else {
    const st = await run("git", ["status", "--porcelain"]);
    if (st.out.trim()) problems.push("working tree has uncommitted changes; commit or stash first");
  }
  for (const bin of ["claude", "codex"]) {
    const r = await run(bin, ["--version"]);
    if (r.code !== 0) problems.push(`${bin} CLI not found or not runnable`);
  }
  return problems;
}
