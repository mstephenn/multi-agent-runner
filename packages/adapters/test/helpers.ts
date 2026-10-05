import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fakeBin(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "mar-fake-")), "fake");
  writeFileSync(p, `#!${process.execPath}\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

/** Polls `cond` until true (or throws after `timeoutMs`); replaces fixed sleeps. */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
