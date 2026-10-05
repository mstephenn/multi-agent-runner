// Parent-side supervision for bin/mar.mjs: forwards termination signals to the child, escalates to SIGKILL
// after a grace period, and maps a signal-killed child to exit code 128+signo.
import { spawn } from "node:child_process";
import { constants } from "node:os";

/** True when `version` (e.g. "22.7.0") is >= major.minor. */
export function nodeVersionAtLeast(version, major, minor) {
  const [a, b] = String(version).split(".").map((n) => Number.parseInt(n, 10) || 0);
  return a > major || (a === major && b >= minor);
}

/** Exit code for a finished child: its own code, else 128+signo when killed by a signal, else 1. */
export function exitCodeFor(code, signal) {
  if (typeof code === "number") return code;
  if (signal && constants.signals[signal]) return 128 + constants.signals[signal];
  return 1;
}

export function supervise(cmd, args, { env, graceMs = 5000, proc = process } = {}) {
  const child = spawn(cmd, args, { stdio: "inherit", env });
  let timer;
  const forward = (sig) => {
    child.kill(sig);
    timer ??= setTimeout(() => { child.kill("SIGKILL"); }, graceMs);
  };
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => { const h = () => forward(sig); proc.on(sig, h); return [sig, h]; });
  child.on("error", (e) => { console.error(`mar: cannot start: ${e.message}`); proc.exit(1); });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    for (const [sig, h] of handlers) proc.off(sig, h);
    proc.exit(exitCodeFor(code, signal));
  });
  return child;
}
