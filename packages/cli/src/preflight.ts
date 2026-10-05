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

// Auth is not checked here; it is verified lazily by the first real adapter call.
export async function preflight(repo: string, run: Runner): Promise<string[]> {
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
  for (const bin of ["claude", "codex"]) {
    const r = await run(bin, ["--version"]);
    if (r.code !== 0) problems.push(`${bin} CLI not found or not runnable`);
  }
  return problems;
}
