import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRaw } from "../../server/test/rawDb.js";
import { startServer } from "@mar/server";
import { parseCli, runMain, UsageError } from "../src/main.js";
import { seedRepo } from "./historySeed.js";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });
const repo = seedRepo(); tmps.push(repo);
const db = join(repo, ".mar", "mar.db");
const sha = () => createHash("sha256").update(readFileSync(db)).digest("hex");
const files = () => readdirSync(join(repo, ".mar")).sort();

async function mar(args: string[], r = repo) {
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  const before = r === repo ? { sha: sha(), files: files(), mtime: statSync(db).mtimeMs } : undefined;
  const code = await runMain(["history", ...args, "--repo", r], { history: { columns: 140 } });
  if (before) expect({ sha: sha(), files: files(), mtime: statSync(db).mtimeMs }).toEqual(before); // read-only, no -wal/-shm
  vi.restoreAllMocks();
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("parseCli history", () => {
  it("defaults", () => { expect(parseCli(["history"])).toEqual({ cmd: "history", repo: ".", limit: 20, json: false, ui: false, port: 4317 }); });
  it("all options", () => {
    expect(parseCli(["history", "r1abc", "--repo", "/x", "--limit", "5", "--json"])).toMatchObject({ runId: "r1abc", repo: "/x", limit: 5, json: true });
    expect(parseCli(["history", "r1abc", "--task", "impl"])).toMatchObject({ runId: "r1abc", task: "impl" });
    expect(parseCli(["history", "--ui", "--port", "5000"])).toMatchObject({ ui: true, port: 5000 });
  });
  it.each([
    [["history", "--limit", "0"]], [["history", "--limit", "201"]], [["history", "--limit", "x"]], [["history", "--limit", "1.5"]],
    [["history", "--task", "impl"]], [["history", "r1", "--ui", "--json"]], [["history", "r1", "--ui", "--task", "a"]], [["history", "r1", "--json", "--task", "a"]],
    [["history", "--bogus"]], [["history", "a", "b"]], [["history", "--unsafe"]], [["history", "--port", "5000"]],
    [["run", "g", "--json"]], [["run", "g", "--limit", "5"]], [["resume", "r1", "--ui"]],
  ])("rejects %j", (argv) => { expect(() => parseCli(argv as string[])).toThrow(UsageError); });
  it("accepts the limit bounds", () => {
    expect(parseCli(["history", "--limit", "1"])).toMatchObject({ limit: 1 });
    expect(parseCli(["history", "--limit", "200"])).toMatchObject({ limit: 200 });
  });
  it("usage errors exit 2 and print usage", async () => {
    const err: string[] = []; vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
    expect(await runMain(["history", "--task", "x"])).toBe(2);
    expect(err.join("\n")).toContain("mar history");
  });
});

describe("mar history (list)", () => {
  it("lists runs newest first with the footer", async () => {
    const r = await mar([]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(/^ID\s+DATE\s+STATUS\s+PHASES\s+TASKS\s+TOKENS\s+GOAL$/);
    expect(lines.slice(1, 8).map((l) => l.split(/\s+/)[0])).toEqual(["rsingle1", "rthree3x", "rfailed4", "rabort55", "rold00001", "rcorrupt1", "rplanfail"]);
    expect(r.out).toContain("7 runs shown (7 total). Details: mar history <id>");
    expect(lines[1]).toMatch(/\(2h ago\)\s+done\s+1\s+2\/2\s+2,468\s+Add a health endpoint and cover it with tests$/);
    expect(lines[2]).toMatch(/\(5h ago\)\s+done\s+3\s+3\/3\s+3,000/);
    expect(r.out).toMatch(/rfailed4.*\sfailed\s+1\s+0\/2\s+n\/a/);
    expect(r.out).toMatch(/rabort55.*\sfailed\s+1\s+1\/3/);
    expect(r.out).toMatch(/rold00001.*\sdone\s+1\s+1\/1/);
    expect(r.out).toMatch(/rplanfail.*\splanning-failed\s+0\s+0\/0\s+n\/a/);
    expect(r.out).toMatch(/rcorrupt1.*\sstopped/);
  });
  it("honours --limit", async () => {
    const r = await mar(["--limit", "2"]);
    expect(r.out).toContain("2 runs shown (7 total).");
    expect(r.out).not.toContain("rfailed4");
  });
  it("--json is a plain array without table or footer", async () => {
    const r = await mar(["--json", "--limit", "3"]);
    const j = JSON.parse(r.out) as Record<string, unknown>[];
    expect(j.map((x) => x.id)).toEqual(["rsingle1", "rthree3x", "rfailed4"]);
    expect(j[0]).toMatchObject({ goal: "Add a health endpoint\nand cover it with tests", status: "done", phases: 1, tasksDone: 2, tasksTotal: 2, tokens: 2468, remaining: "" });
    expect(typeof j[0]!.created).toBe("string");
    expect(r.out).not.toContain("runs shown");
    expect(JSON.parse((await mar(["--json"])).out).find((x: { id: string }) => x.id === "rfailed4").tokens).toBeNull();
  });
  it("a repo without .mar/mar.db: friendly message, exit 0, nothing created", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mar-empty-")); tmps.push(empty);
    const r = await mar([], empty);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`No mar runs found in ${empty} (no .mar/mar.db).`);
    expect(existsSync(join(empty, ".mar"))).toBe(false);
    expect((await mar(["--json"], empty)).out).toBe("[]");
    expect((await mar(["r1abc"], empty)).code).toBe(1);
  });
  it("an empty DB gives the same message", async () => {
    const d = mkdtempSync(join(tmpdir(), "mar-emptydb-")); tmps.push(d); mkdirSync(join(d, ".mar"));
    const { Store } = await import("@mar/server"); new Store(join(d, ".mar", "mar.db")).close();
    const r = await mar([], d);
    expect(r.out).toContain("No mar runs found");
    expect(r.code).toBe(0);
  });
  it("a file that is not a database is a clear error, exit 1", async () => {
    const d = mkdtempSync(join(tmpdir(), "mar-baddb-")); tmps.push(d); mkdirSync(join(d, ".mar"));
    writeFileSync(join(d, ".mar", "mar.db"), "this is not sqlite at all".repeat(50));
    const r = await mar([], d);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read");
  });
});

describe("mar history <runId>", () => {
  it("single phase: header, plan, task lines, answer, saved reports", async () => {
    const r = await mar(["rsingle1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Run rsingle1");
    expect(r.out).toContain("Goal:      Add a health endpoint\nand cover it with tests");
    expect(r.out).toContain(`Repo:      ${repo}`);
    expect(r.out).toMatch(/Started:   \d{4}-\d\d-\d\d \d\d:\d\d \(2h ago\)/);
    expect(r.out).toContain("Status:    done");
    expect(r.out).toContain("Phases:    1 (limit 5)");
    expect(r.out).toContain("Tokens:    2,468");
    expect(r.out).toContain("== Phase 1 ==");
    expect(r.out).toMatch(/id\s+role\s+runtime\/tier\s+depends\s+paths\s+worktree\s+goal/);
    expect(r.out).toMatch(/research\s+researcher\s+claude\/mid\s+-\s+-\s+shared/);
    expect(r.out).toContain("  impl  done");
    expect(r.out).toContain("== Answer: impl ==\nAdded `GET /health`.\n\n- returns 200\n- 日本語 ✓ 🚀\n");
    expect(r.out).toContain("Saved reports:\n  " + join(repo, ".mar", "reports", "rsingle1", "impl.md"));
    expect(r.out).not.toContain("-- Phase 1 --");
  });
  it("accepts a unique prefix; ambiguous prefix exits 2 listing matches; unknown exits 1", async () => {
    expect((await mar(["rsin"])).out).toContain("Run rsingle1");
    expect((await mar(["r"])).code).toBe(2); // too short
    const amb2: string[] = [];
    const added = openRaw(db); added.prepare("INSERT INTO runs VALUES ('rsingle2','twin',?,?)").run(repo, Date.now()); added.close();
    try {
      const r = await runMain(["history", "rsing", "--repo", repo], { history: { out: () => {}, err: (l) => { amb2.push(l); } } });
      expect(r).toBe(2);
      expect(amb2.join("\n")).toContain("rsingle1");
      expect(amb2.join("\n")).toContain("rsingle2");
    } finally { const c = openRaw(db); c.prepare("DELETE FROM runs WHERE id='rsingle2'").run(); c.close(); }
    const unk = await mar(["zzzzz"]);
    expect(unk.code).toBe(1);
    expect(unk.err).toContain('no run "zzzzz"');
  });
  it("three phases: per-phase tables, integration results with a bounded, sanitized tail, remaining text", async () => {
    const r = await mar(["rthree3x"]);
    expect(r.out).toContain("== Phase 1 ==");
    expect(r.out).toContain("== Phase 2 ==");
    expect(r.out).toContain("== Phase 3 ==");
    expect(r.out).toContain("Remaining after this phase: wire the UI");
    expect(r.out).toContain("Integration: mar/integrate/rthree3x (merged api; verify passed)");
    expect(r.out).toContain("verify failed (pnpm test)");
    expect(r.out).toContain("| FAIL billing.test.ts");
    expect(r.out).not.toMatch(/\x1b|\x07|\u009b/);
    const tail = r.out.split("\n").filter((l) => l.startsWith("    | "));
    expect(tail.join("").length).toBeLessThanOrEqual(500 + tail.length * 6);
    expect(r.out).toContain("-- Phase 3 --");
    expect(r.out).toContain("== Answer: docs ==\n# Findings\n\nAll good. end");
    expect(r.out).toContain("Phases:    3 (limit 5)");
  });
  it("failed / aborted runs show reasons and status", async () => {
    const f = await mar(["rfailed4"]);
    expect(f.out).toContain("Status:    failed");
    expect(f.out).toContain("  migrate  failed (boom: exit 1)");
    expect(f.out).toContain("  verify  blocked");
    expect(f.out).toContain("== verify: blocked ==");
    expect((await mar(["rcorrupt1"])).out).toContain("No reports or summaries were stored");
    const a = await mar(["rabort55"]);
    expect(a.out).toContain("Status:    failed (aborted)");
    expect(a.out).toContain("  edit  failed (aborted)");
  });
  it("planning failure and the old single-plan run", async () => {
    const p = await mar(["rplanfail"]);
    expect(p.out).toContain("Status:    planning-failed (planning failed: Claude: timeout; Codex: no auth)");
    const o = await mar(["rold00001"]);
    expect(o.out).toContain("== Phase 1 ==");
    expect(o.out).not.toContain("== Phase 2 ==");
    expect(o.out).toContain("== Answer: only == (summary only)\nold summary");
  });
  it("corrupt rows degrade with a note and never crash", async () => {
    const c = await mar(["rcorrupt1"]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("Note:");
    expect(c.out).toMatch(/unreadable/);
  });
  it("shows a task branch only when it exists", async () => {
    const out: string[] = [];
    await runMain(["history", "rsingle1", "--repo", repo], { history: { out: (l) => out.push(l), branchExists: async (_r, b) => b === "mar/rsingle1/impl" } });
    expect(out.join("\n")).toContain("  impl  done  mar/rsingle1/impl");
    expect(out.join("\n")).not.toContain("research  done  mar/");
    // real git on a directory that is no repo: silently skipped
    expect((await mar(["rsingle1"])).out).not.toContain("mar/rsingle1/impl");
  });
});

describe("mar history <runId> --task", () => {
  it("prints only the report, ready to pipe", async () => {
    const r = await mar(["rsingle1", "--task", "impl"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Added `GET /health`.\n\n- returns 200\n- 日本語 ✓ 🚀\n");
  });
  it("sanitizes escapes in the report", async () => {
    expect((await mar(["rthree3x", "--task", "docs"])).out).toBe("# Findings\n\nAll good. end");
  });
  it("falls back to the blackboard summary, and says so when nothing is stored", async () => {
    expect((await mar(["rold00001", "--task", "only"])).out).toBe("old summary");
    const none = await mar(["rsingle1", "--task", "research"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain('no report or summary for task "research"');
    expect(none.out).toBe("");
  });
});

describe("mar history --ui", () => {
  type Handler = () => void;
  const fakeProc = () => {
    const h = new Map<string, Handler>();
    const proc = { on: (e: string, f: Handler) => { h.set(e, f); return proc; }, off: (e: string) => { h.delete(e); return proc; } };
    return { h, proc: proc as unknown as Pick<NodeJS.Process, "on" | "off"> };
  };
  const until = async (c: () => boolean) => { for (let i = 0; i < 400 && !c(); i++) await new Promise((r) => setTimeout(r, 10)); if (!c()) throw new Error("timeout"); };

  it("serves the newest run read-only, stays up, and closes cleanly on SIGINT (a second one within 1s is ignored)", async () => {
    const before = { sha: sha(), files: files(), mtime: statSync(db).mtimeMs };
    const { h, proc } = fakeProc();
    const out: string[] = [];
    let exited = false;
    const p = runMain(["history", "--ui", "--repo", repo], {
      proc, exit: () => { exited = true; }, startServer: (st, o) => startServer(st, { ...o, port: 0 }), history: { out: (l) => out.push(l) },
    });
    await until(() => out.some((l) => l.startsWith("Read-only history view")));
    const m = out[0]!.match(/^UI: http:\/\/127\.0\.0\.1:(\d+)\/\?run=rsingle1$/);
    expect(m).not.toBeNull();
    expect(out.at(-1)).toBe("Read-only history view. Press Ctrl-C to stop.");
    const base = `http://127.0.0.1:${m![1]}`;
    expect(await (await fetch(`${base}/api/meta`)).json()).toEqual({ readOnly: true });
    expect((await fetch(`${base}/api/runs/rsingle1/stop`, { method: "POST", headers: { "x-mar": "1" } })).status).toBe(405);
    expect(((await (await fetch(`${base}/api/runs/rsingle1`)).json()) as { reports: unknown[] }).reports).toHaveLength(1);
    h.get("SIGINT")!(); h.get("SIGINT")?.();
    expect(await p).toBe(0);
    expect(exited).toBe(false);
    expect(h.size).toBe(0);
    await expect(fetch(`${base}/api/meta`)).rejects.toThrow();
    expect({ sha: sha(), files: files(), mtime: statSync(db).mtimeMs }).toEqual(before);
  });
  it("uses the given run id (prefix) and reports a missing DB without serving", async () => {
    const { h, proc } = fakeProc();
    const out: string[] = [];
    const p = runMain(["history", "--ui", "rthree", "--repo", repo], { proc, startServer: (st, o) => startServer(st, { ...o, port: 0 }), history: { out: (l) => out.push(l) } });
    await until(() => out.length >= 2);
    expect(out[0]).toMatch(/\?run=rthree3x$/);
    h.get("SIGTERM")!();
    expect(await p).toBe(0);
    const empty = mkdtempSync(join(tmpdir(), "mar-emptyui-")); tmps.push(empty);
    const o2: string[] = [];
    expect(await runMain(["history", "--ui", "--repo", empty], { history: { out: (l) => o2.push(l) } })).toBe(0);
    expect(o2.join("")).toContain("No mar runs found");
  });
});
