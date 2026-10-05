import { describe, it, expect, vi, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { exitCodeFor, nodeVersionAtLeast } from "../bin/supervise.mjs";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 30000 });
const bin = fileURLToPath(new URL("../bin/mar.mjs", import.meta.url));
const run = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((res) =>
  execFile(process.execPath, [bin, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }, (e, out, err) =>
    res({ code: e ? (typeof (e as any).code === "number" ? (e as any).code : 1) : 0, out: String(out), err: String(err) })));

describe("mar binary", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("mar run");
  });
  it("run without a goal exits 2", async () => {
    const r = await run(["run"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage");
  });
  it("invalid --port exits 2 (usage error)", async () => {
    const r = await run(["run", "g", "--port", "70000"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--port");
  });
});

describe("supervise", () => {
  const sup = fileURLToPath(new URL("../bin/supervise.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "mar-sup-"));
  const wrapper = join(dir, "wrap.mjs");
  writeFileSync(wrapper, `import { supervise } from ${JSON.stringify(sup)};
supervise(process.execPath, [process.argv[2]], { graceMs: Number(process.argv[3]) });`);
  const fake = (name: string, src: string) => { const f = join(dir, name); writeFileSync(f, src); return f; };
  const exec = (entry: string, grace = 5000) => spawn(process.execPath, [wrapper, entry, String(grace)], { stdio: ["ignore", "pipe", "inherit"] });
  const done = (p: ReturnType<typeof exec>) => new Promise<number | null>((res) => p.on("exit", (c) => res(c)));
  const ready = (p: ReturnType<typeof exec>) => new Promise<void>((res) => p.stdout!.once("data", () => res()));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("pure helpers", () => {
    expect(nodeVersionAtLeast("22.7.0", 22, 7)).toBe(true);
    expect(nodeVersionAtLeast("22.6.9", 22, 7)).toBe(false);
    expect(nodeVersionAtLeast("24.1.0", 22, 7)).toBe(true);
    expect(nodeVersionAtLeast("20.19.0", 22, 7)).toBe(false);
    expect(exitCodeFor(3, null)).toBe(3);
    expect(exitCodeFor(null, "SIGTERM")).toBe(143);
    expect(exitCodeFor(null, null)).toBe(1);
  });
  it("propagates the child's exit code", async () => {
    expect(await done(exec(fake("c3.mjs", "process.exit(3)")))).toBe(3);
  });
  it("child killed by a signal -> exit 128+signo", async () => {
    expect(await done(exec(fake("k.mjs", "process.kill(process.pid, 'SIGTERM'); setInterval(()=>{},1000)")))).toBe(143);
  });
  it("forwards SIGTERM to the child", async () => {
    const p = exec(fake("fw.mjs", "process.on('SIGTERM',()=>process.exit(7)); console.log('up'); setInterval(()=>{},1000)"));
    await ready(p); p.kill("SIGTERM");
    expect(await done(p)).toBe(7);
  });
  it("a process-group SIGINT (terminal Ctrl-C) reaches the child exactly once", async () => {
    const child = fake("grp.mjs", `process.on('SIGINT',()=>{console.log('sigint'); setTimeout(()=>process.exit(0),700)}); console.log('up'); setInterval(()=>{},1000)`);
    // detached: the wrapper leads its own process group, like a foreground job; the group gets the SIGINT.
    const p = spawn(process.execPath, [wrapper, child, "5000"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
    let out = ""; p.stdout!.on("data", (d) => { out += d; });
    await vi.waitFor(() => expect(out).toContain("up"));
    process.kill(-p.pid!, "SIGINT");
    expect(await done(p)).toBe(0);
    expect(out.match(/sigint/g)).toHaveLength(1);
  });
  it("kills the child's process group when the supervisor itself exits", async () => {
    const pidFile = join(dir, "pid");
    const child = fake("orph.mjs", `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`);
    const quitter = join(dir, "quit.mjs");
    writeFileSync(quitter, `import { supervise } from ${JSON.stringify(sup)};
supervise(process.execPath, [process.argv[2]]);
setTimeout(() => process.exit(0), 800);`);
    const p = spawn(process.execPath, [quitter, child], { stdio: "ignore" });
    await new Promise((res) => p.on("exit", res));
    const cpid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => { try { process.kill(cpid, 0); return true; } catch { return false; } };
    try { await vi.waitFor(() => expect(alive()).toBe(false)); }
    finally { try { process.kill(cpid, "SIGKILL"); } catch { /* gone */ } }
  });
  it("escalates to SIGKILL when the child ignores the forwarded signal", async () => {
    const p = exec(fake("ig.mjs", "process.on('SIGTERM',()=>{}); console.log('up'); setInterval(()=>{},1000)"), 300);
    await ready(p); p.kill("SIGTERM");
    expect(await done(p)).toBe(137);
  });
});
