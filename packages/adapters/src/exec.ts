import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AdapterError } from "./types.js";

const DEFAULT_KILL_GRACE_MS = 2000;

export interface SpawnLinesOpts {
  cwd: string;
  signal: AbortSignal;
  stdin?: string;
  /** Time between SIGTERM and SIGKILL when stopping the child. */
  killGraceMs?: number;
}

/** Spawns without a shell and yields stdout lines. SIGTERM on abort/early exit, SIGKILL after a grace period. */
export async function* spawnLines(cmd: string, args: string[], opts: SpawnLinesOpts): AsyncIterable<string> {
  if (opts.signal.aborted) return;
  const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stderr = "";
  let spawnError: Error | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  child.stderr.on("data", (b) => { stderr = (stderr + b.toString()).slice(-2000); });
  child.on("error", (e) => { spawnError = e; });
  child.stdin.on("error", () => {}); // EPIPE if the child exits before reading stdin; exit status is reported below
  const exit = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, grace);
  };
  opts.signal.addEventListener("abort", stop, { once: true });
  child.stdin.end(opts.stdin);
  let code: number | null = null;
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) yield line;
  } finally {
    opts.signal.removeEventListener("abort", stop);
    stop();
    // Always reap the child (also on early consumer exit) so no zombie/orphan outlives the iterator.
    try { code = await exit; } finally { clearTimeout(killTimer); }
  }
  if (spawnError) throw new AdapterError(`failed to spawn ${cmd}: ${(spawnError as Error).message}`);
  if (code !== 0 && !opts.signal.aborted) throw new AdapterError(`${cmd} exited ${code}: ${stderr.slice(-300)}`);
}
