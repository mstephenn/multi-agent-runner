import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AdapterError } from "./types.js";
import { sanitizeDiagnostic } from "./sanitize.js";

const DEFAULT_KILL_GRACE_MS = 2000;
/** One stdout line may not exceed this many characters (8M); guards against unbounded memory growth. */
const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 4000;

export interface SpawnLinesOpts {
  cwd: string;
  signal: AbortSignal;
  stdin?: string;
  /** Time between SIGTERM and SIGKILL when stopping the child. */
  killGraceMs?: number;
  /** Child environment (default: inherit). */
  env?: NodeJS.ProcessEnv;
  /** Max characters in a single stdout line before failing with AdapterError. */
  maxLineChars?: number;
}

/**
 * Spawns without a shell (in its own process group) and yields stdout lines.
 * On abort or early consumer exit the whole group gets SIGTERM, then SIGKILL after a grace period.
 * A child that ends on its own is never signalled; we just await its exit.
 */
export async function* spawnLines(cmd: string, args: string[], opts: SpawnLinesOpts): AsyncIterable<string> {
  if (opts.signal.aborted) return;
  const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxLine = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true, env: opts.env });
  let stderr = "";
  let spawnError: Error | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let stoppedByUs = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (s: string) => { stderr = (stderr + s).slice(-STDERR_TAIL_CHARS); });
  child.on("error", (e) => { spawnError = e; });
  child.stdin.on("error", () => {}); // EPIPE if the child exits before reading stdin; exit status is reported below
  const exit = new Promise<number | null>((res) => child.on("close", (code) => { closed = true; res(code); }));
  const signalGroup = (sig: NodeJS.Signals) => {
    if (closed) return;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig); else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  const stop = () => {
    if (closed) return;
    // A leader that already exited by itself is not "stopped by us" (its exit status stays authoritative);
    // still signal the group so stray grandchildren do not outlive an abort.
    if (child.exitCode === null && child.signalCode === null) stoppedByUs = true;
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), grace);
  };
  opts.signal.addEventListener("abort", stop, { once: true });
  child.stdin.end(opts.stdin);
  let code: number | null = null;
  let finished = false; // read loop ended naturally (stdout closed)
  try {
    const dec = new StringDecoder("utf8");
    let buf = "";
    const tooLong = () => new AdapterError(`${cmd} output line exceeds ${maxLine} characters`);
    for await (const chunk of child.stdout) {
      buf += dec.write(chunk as Buffer);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.length > maxLine) throw tooLong();
        yield line;
      }
      if (buf.length > maxLine) throw tooLong();
    }
    buf += dec.end();
    if (buf) yield buf.replace(/\r$/, "");
    finished = true;
  } finally {
    opts.signal.removeEventListener("abort", stop);
    if (!finished) stop(); // early consumer exit or read error; a naturally finished child is just awaited
    // Always reap the child so no zombie/orphan outlives the iterator.
    try { code = await exit; } finally { clearTimeout(killTimer); }
    // Leftover group members (grandchildren that outlived the leader) must not linger after an abort/early exit.
    if (stoppedByUs) { closed = false; signalGroup("SIGKILL"); closed = true; }
  }
  if (spawnError) throw new AdapterError(`failed to spawn ${cmd}: ${(spawnError as Error).message}`);
  // Only a failure caused by our own kill is expected; a genuine non-zero exit is reported even if abort fired later.
  if (code !== 0 && !stoppedByUs) throw new AdapterError(`${cmd} exited ${code}: ${sanitizeDiagnostic(stderr)}`);
}
