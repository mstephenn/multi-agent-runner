import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, normalize } from "node:path";

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** Windows env keys are case-insensitive but keep their original casing ("Path"); read one regardless of case. */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
  return k === undefined ? undefined : env[k];
}

/** Windows only: resolves a bare command through PATH + PATHEXT (like cmd.exe), so `claude` finds claude.exe / codex.cmd. */
export function resolveWindowsCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  const exts = (envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasPath = /[\\/]/.test(cmd);
  const dirs = hasPath || isAbsolute(cmd) ? [""] : (envGet(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  const names = extname(cmd) && exts.includes(extname(cmd).toUpperCase()) ? [cmd, ...exts.map((e) => cmd + e)] : exts.map((e) => cmd + e);
  for (const d of dirs) for (const n of names) {
    const p = d ? join(d, n) : n;
    if (isFile(p)) return p;
  }
  return cmd;
}

const META = /([()\][%!^"`<>&|;, *?])/g;
/** Escapes one argument for cmd.exe (same algorithm as cross-spawn); `twice` for shims that re-invoke cmd. */
function escapeArg(arg: string, twice: boolean): string {
  let a = `${arg}`.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(META, "^$1");
  return twice ? a.replace(META, "^$1") : a;
}

/** The `cmd.exe /d /s /c "<line>"` argv that runs a .cmd/.bat shim with `args` verbatim. */
export function cmdShimArgv(file: string, args: string[]): string[] {
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.(cmd|bat)$/i.test(file);
  const cmd = normalize(file).replace(META, "^$1");
  return ["/d", "/s", "/c", `"${[cmd, ...args.map((a) => escapeArg(a, twice))].join(" ")}"`];
}

/**
 * spawn() that also works on Windows: no process group (POSIX only), resolves PATHEXT and runs .cmd/.bat shims
 * (npm/pnpm installs of claude, codex, pnpm) through cmd.exe with safe quoting. Never uses `shell: true`.
 */
export function spawnPortable(cmd: string, args: string[], opts: SpawnOptions = {}, platform: NodeJS.Platform = process.platform): ChildProcess {
  if (platform !== "win32") return spawn(cmd, args, { ...opts, shell: false, detached: true });
  const file = resolveWindowsCommand(cmd, opts.env ?? process.env);
  const base: SpawnOptions = { ...opts, shell: false, detached: false, windowsHide: true };
  if (/\.(cmd|bat)$/i.test(file)) {
    return spawn(envGet(process.env, "ComSpec") ?? "cmd.exe", cmdShimArgv(file, args), { ...base, windowsVerbatimArguments: true });
  }
  return spawn(file, args, base);
}

/** Signals the child's whole process tree: the POSIX process group, or `taskkill /T` on Windows. */
export function killTree(child: ChildProcess, sig: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (pid === undefined) { child.kill(sig); return; }
  if (platform === "win32") {
    const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (r.status !== 0) child.kill(sig);
    return;
  }
  try { process.kill(-pid, sig); } catch { child.kill(sig); }
}

/** fs.symlink type for a directory target: junctions need no elevated privilege on Windows. */
export const dirLinkType = (platform: NodeJS.Platform = process.platform): "junction" | "dir" => (platform === "win32" ? "junction" : "dir");
