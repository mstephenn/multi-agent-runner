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
  // detached: the child leads its own process group, so a terminal Ctrl-C (SIGINT to the foreground group)
  // reaches only this supervisor, which forwards it exactly once. Otherwise the child would see it twice
  // and its "second signal force-exits" path would skip the graceful abort.
  const child = spawn(cmd, args, { stdio: "inherit", env, detached: true });
  let timer;
  let exited = false;
  const killGroup = (sig) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
  };
  const forward = (sig) => {
    child.kill(sig);
    timer ??= setTimeout(() => { killGroup("SIGKILL"); }, graceMs);
  };
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => { const h = () => forward(sig); proc.on(sig, h); return [sig, h]; });
  // The child is outside our group, so make sure it (and its workers) cannot outlive the supervisor.
  const onParentExit = () => { if (!exited) killGroup("SIGKILL"); };
  proc.on("exit", onParentExit);
  child.on("error", (e) => { console.error(`mar: cannot start: ${e.message}`); proc.exit(1); });
  child.on("exit", (code, signal) => {
    exited = true;
    clearTimeout(timer);
    killGroup("SIGKILL"); // stragglers left in the child's group
    for (const [sig, h] of handlers) proc.off(sig, h);
    proc.off("exit", onParentExit);
    proc.exit(exitCodeFor(code, signal));
  });
  return child;
}
