import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { workerEnv } from "@mar/adapters";
import { redact } from "./redact.js";

const TAIL_CHARS = 1500;
const RAW_WINDOW = 8000; // kept before redaction so a secret straddling the 1500-char cut is still recognised
const KILL_GRACE_MS = 2000;

/**
 * Splits one configured command line into argv WITHOUT a shell: whitespace separates words, '...' and "..."
 * group, a backslash escapes the next character (inside "..." only before `"` or `\`). Nothing is expanded
 * (no $VAR, ~, globs). An UNQUOTED shell operator (| & ; < > $( `) is rejected: the line comes from user config
 * and must never reach a shell.
 */
export function parseCommand(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const fail = (what: string): never => { throw new Error(`verify command "${line}": ${what}`); };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\") { if (i + 1 >= line.length) fail("trailing backslash"); cur += line[++i]; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) { words.push(cur); cur = ""; inWord = false; } continue; }
    if ("|&;<>`".includes(c) || (c === "$" && line[i + 1] === "(")) fail(`shell operator "${c === "$" ? "$(" : c}" is not supported (commands run without a shell; quote it if it is literal)`);
    cur += c; inWord = true;
  }
  if (quote) fail("unterminated quote");
  if (inWord) words.push(cur);
  if (words.length === 0) fail("empty command");
  return words;
}

export interface VerifyOpts { signal?: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv }
export interface VerifyResult {
  ok: boolean;
  failed?: { command: string; code: number | null; timedOut: boolean };
  tail: string;
  ms: number;
}

// Toolchain locations the worker allowlist drops but the repo's own checks may need (pnpm/corepack/node managers).
const TOOLCHAIN_VARS = ["PNPM_HOME", "COREPACK_HOME", "NVM_DIR", "VOLTA_HOME"];
const verifyEnv = (): NodeJS.ProcessEnv => {
  const env = workerEnv();
  for (const k of TOOLCHAIN_VARS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
};

// Drops a leading lone low surrogate left by cutting through a surrogate pair.
const cut = (s: string, n: number): string => {
  let t = s.length > n ? s.slice(-n) : s;
  const f = t.charCodeAt(0);
  if (f >= 0xdc00 && f <= 0xdfff) t = t.slice(1);
  return t;
};

/**
 * Runs `commands` one after another in `cwd` (no shell, own process group), stopping at the first failure.
 * On timeout or abort the whole process group gets SIGTERM, then SIGKILL after 2 s. Never throws for a missing
 * binary or a rejected command line: those are reported as `ok: false`.
 */
export async function runVerify(cwd: string, commands: string[], opts: VerifyOpts): Promise<VerifyResult> {
  const start = Date.now();
  let raw = "";
  const append = (s: string) => { raw = cut(raw + s, RAW_WINDOW); };
  const done = (failed?: VerifyResult["failed"]): VerifyResult => ({
    ok: failed === undefined, ...(failed ? { failed } : {}), tail: cut(redact(raw), TAIL_CHARS), ms: Date.now() - start,
  });
  const env = opts.env ?? verifyEnv();

  for (const command of commands) {
    if (opts.signal?.aborted) { append("\nverification aborted\n"); return done({ command, code: null, timedOut: false }); }
    let argv: string[];
    try { argv = parseCommand(command); }
    catch (e) { append(`${(e as Error).message}\n`); return done({ command, code: null, timedOut: false }); }
    const r = await runOne(argv, cwd, env, opts, append);
    if (r.kind === "ok") continue;
    if (r.kind === "spawn-error") append(`\ncommand failed to start: ${argv[0]}: ${r.message}\n`);
    else if (r.kind === "timeout") append(`\nverification timed out after ${Math.round(opts.timeoutMs / 1000)}s: ${command}\n`);
    else if (r.kind === "abort") append(`\nverification aborted: ${command}\n`);
    return done({ command, code: r.kind === "exit" ? r.code : null, timedOut: r.kind === "timeout" });
  }
  return done();
}

type One = { kind: "ok" } | { kind: "exit"; code: number | null } | { kind: "spawn-error"; message: string } | { kind: "timeout" } | { kind: "abort" };

function runOne(argv: string[], cwd: string, env: NodeJS.ProcessEnv, opts: VerifyOpts, append: (s: string) => void): Promise<One> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let spawnError: Error | undefined;
    let why: "timeout" | "abort" | undefined;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const group = (sig: NodeJS.Signals) => {
      try { if (child.pid !== undefined) process.kill(-child.pid, sig); else child.kill(sig); }
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const stop = (reason: "timeout" | "abort") => {
      if (closed || why) return;
      why = reason;
      group("SIGTERM");
      killTimer = setTimeout(() => group("SIGKILL"), KILL_GRACE_MS);
    };
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    child.stdout.on("data", (b: Buffer) => append(decoders[0].write(b)));
    child.stderr.on("data", (b: Buffer) => append(decoders[1].write(b)));
    child.on("error", (e) => { spawnError = e; });
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    const onAbort = () => stop("abort");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer); clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      for (const d of decoders) append(d.end());
      // Stray grandchildren must not outlive a timeout/abort.
      if (why) group("SIGKILL");
      if (spawnError) return resolve({ kind: "spawn-error", message: (spawnError as NodeJS.ErrnoException).code === "ENOENT" ? "command not found (ENOENT)" : spawnError.message });
      if (why) return resolve({ kind: why });
      resolve(code === 0 ? { kind: "ok" } : { kind: "exit", code });
    });
  });
}
