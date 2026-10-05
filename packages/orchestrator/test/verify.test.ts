import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand, runVerify } from "../src/verify.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "mar-verify-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const node = (code: string) => `node -e "${code.replace(/"/g, '\\"')}"`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

describe("parseCommand", () => {
  it("splits on whitespace", () => expect(parseCommand("  pnpm   test  --run ")).toEqual(["pnpm", "test", "--run"]));
  it("handles single and double quotes", () => {
    expect(parseCommand(`node -e "console.log('a b')"`)).toEqual(["node", "-e", "console.log('a b')"]);
    expect(parseCommand(`echo 'x  y' ""`)).toEqual(["echo", "x  y", ""]);
    expect(parseCommand(`a"b c"d`)).toEqual(["ab cd"]);
  });
  it("handles backslash escapes", () => {
    expect(parseCommand("a\\ b c")).toEqual(["a b", "c"]);
    expect(parseCommand(`"a\\"b"`)).toEqual(['a"b']);
  });
  it("does no expansion", () => expect(parseCommand("echo $HOME ~ *")).toEqual(["echo", "$HOME", "~", "*"]));
  it("allows operators inside quotes", () => expect(parseCommand(`node -e "a | b; c > d && $(x) \`y\`"`)).toEqual(["node", "-e", "a | b; c > d && $(x) `y`"]));
  it.each(["a | b", "a && b", "a; b", "a > f", "a < f", "echo $(whoami)", "echo `id`", "a & b"])("rejects unquoted operator in %s", (c) => {
    expect(() => parseCommand(c)).toThrow(new RegExp(`shell|operator`, "i"));
    expect(() => parseCommand(c)).toThrow(c.slice(0, 4));
  });
  it("rejects empty commands and unterminated quotes", () => {
    expect(() => parseCommand("   ")).toThrow(/empty/i);
    expect(() => parseCommand(`echo "x`)).toThrow(/unterminated/i);
  });
});

describe("runVerify", () => {
  const base = { timeoutMs: 10_000 };
  it("passes and merges stdout and stderr", async () => {
    const r = await runVerify(tmp(), [node("console.log('out'); console.error('err')")], base);
    expect(r.ok).toBe(true);
    expect(r.failed).toBeUndefined();
    expect(r.tail).toContain("out");
    expect(r.tail).toContain("err");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
  it("reports the failing command and exit code, and stops there", async () => {
    const d = tmp();
    const r = await runVerify(d, [node("process.exit(0)"), node("console.log('boom'); process.exit(3)"), node("require('fs').writeFileSync('later','x')")], base);
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({ code: 3, timedOut: false });
    expect(r.failed!.command).toContain("process.exit(3)");
    expect(r.tail).toContain("boom");
    expect(existsSync(join(d, "later"))).toBe(false);
  });
  it("runs commands in cwd", async () => {
    const d = tmp();
    const r = await runVerify(d, [node("console.log(process.cwd())")], base);
    expect(r.tail.trim().endsWith(d.split("/").pop()!)).toBe(true);
  });
  it("keeps only the last 1500 chars (multibyte-safe)", async () => {
    const r = await runVerify(tmp(), [node("process.stdout.write('A'.repeat(5000) + 'é'.repeat(100) + 'END')")], base);
    expect(r.tail.length).toBeLessThanOrEqual(1500);
    expect(r.tail.endsWith("END")).toBe(true);
    expect(r.tail).not.toContain("�");
    expect(r.tail).toContain("é");
  });
  it("redacts secrets in the tail", async () => {
    const r = await runVerify(tmp(), [node("console.log('API_KEY=supersecretvalue1 and sk-abcdefghijklmnop')"), node("process.exit(1)")], base);
    expect(r.tail).not.toContain("supersecretvalue1");
    expect(r.tail).not.toContain("sk-abcdefghijklmnop");
    expect(r.tail).toContain("[REDACTED]");
  });
  it("redacts a secret that straddles the truncation boundary", async () => {
    const r = await runVerify(tmp(), [node("process.stdout.write('x'.repeat(1485) + ' sk-abcdefghijklmnopqrstuvwxyz0123')")], base);
    expect(r.tail).not.toMatch(/sk-abcdef|ghijklmnop|wxyz0123/);
  });
  it("passes the worker env (PATH/HOME) and not unrelated secrets by default", async () => {
    process.env.MAR_TEST_NPM_TOKEN_X = "leak";
    try {
      const r = await runVerify(tmp(), [node("console.log(!!process.env.PATH, !!process.env.HOME, process.env.MAR_TEST_NPM_TOKEN_X ?? 'unset')")], base);
      expect(r.tail.trim()).toBe("true true unset");
    } finally { delete process.env.MAR_TEST_NPM_TOKEN_X; }
  });
  it("honours an explicit env", async () => {
    const r = await runVerify(tmp(), [node("console.log(process.env.FOO)")], { ...base, env: { ...process.env, FOO: "bar" } });
    expect(r.tail.trim()).toBe("bar");
  });
  it("times out, killing the child AND its grandchild", async () => {
    const d = tmp();
    const pidFile = join(d, "gc.pid");
    const code = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const r = await runVerify(d, [node(code)], { timeoutMs: 1200 });
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({ timedOut: true });
    const gc = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(gc));
    expect(alive(gc)).toBe(false);
  }, 20_000);
  it("aborts a running command", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t = Date.now();
    const r = await runVerify(tmp(), [node("setInterval(()=>{},1000)")], { timeoutMs: 60_000, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.failed?.timedOut).toBe(false);
    expect(r.tail).toMatch(/abort/i);
    expect(Date.now() - t).toBeLessThan(8000);
  }, 20_000);
  it("an already-aborted signal runs nothing", async () => {
    const ac = new AbortController(); ac.abort();
    const d = tmp();
    const r = await runVerify(d, [node("require('fs').writeFileSync('ran','x')")], { ...base, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(existsSync(join(d, "ran"))).toBe(false);
  });
  it("an unknown binary is ok:false with a clear message, never a throw", async () => {
    const r = await runVerify(tmp(), ["definitely-not-a-binary-xyz --flag"], base);
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({ code: null, timedOut: false });
    expect(r.tail).toMatch(/definitely-not-a-binary-xyz/);
    expect(r.tail).toMatch(/not found|ENOENT/i);
  });
  it("a command with a shell operator fails the gate instead of running a shell", async () => {
    const r = await runVerify(tmp(), ["echo a | cat"], base);
    expect(r.ok).toBe(false);
    expect(r.tail).toMatch(/shell|operator/i);
  });
  it("ok with no commands", async () => {
    expect(await runVerify(tmp(), [], base)).toMatchObject({ ok: true, tail: "" });
  });
});
