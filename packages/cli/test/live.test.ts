// Opt-in: spends real tokens on real, logged-in `claude` and `codex` CLIs. Skipped unless MAR_LIVE=1.
// Everything happens in a throwaway temp git repo; `unsafe` is never enabled.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/src/store.js";
import { claudeAdapter, codexAdapter } from "../../adapters/src/index.js";
import { loadConfig } from "../src/config.js";
import { executeRun } from "../src/main.js";

const hostStatus = () => {
  try { return execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" }); } catch { return ""; }
};
const available = (bin: string) => {
  try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
};

let repo: string | undefined;
afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe.skipIf(!process.env.MAR_LIVE)("live smoke", () => {
  it("runs a tiny two-task goal on real Claude and Codex within a low budget", async () => {
    const missing = ["claude", "codex"].filter((b) => !available(b));
    if (missing.length) throw new Error(`live test needs these CLIs installed and logged in: ${missing.join(", ")} (not found on PATH)`);

    const hostBefore = hostStatus();
    repo = mkdtempSync(join(tmpdir(), "mar-live-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
    g("init", "-q", "-b", "feat/live"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "# demo\n"); writeFileSync(join(repo, ".gitignore"), ".mar/\n");
    g("add", "."); g("commit", "-qm", "init");
    const headBefore = g("rev-parse", "HEAD").trim();

    const config = { ...loadConfig(repo), defaultBudgetTokens: 30000, concurrency: 2, maxAttempts: 1 };
    const { runId, results } = await executeRun({
      goal: "Add a one-line greeting function in hello.js, then review it.", repo, store: new Store(":memory:"),
      adapters: { claude: claudeAdapter(), codex: codexAdapter() }, config, unsafe: false,
    });

    expect(Object.keys(results).length).toBeGreaterThan(0);
    expect(Object.values(results).every((r) => r === "done"), `task results: ${JSON.stringify(results)}`).toBe(true);
    // Nothing merged or moved on the working branch; work lives on mar/<runId>/<taskId> branches.
    expect(g("rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(g("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/live");
    expect(g("branch", "--list", `mar/${runId}/*`).trim()).not.toBe("");
    // Nothing outside the temp dir was touched.
    expect(hostStatus()).toBe(hostBefore);
  }, 600_000);
});
