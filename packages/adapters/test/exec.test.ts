import { describe, it, expect } from "vitest";
import { spawnLines } from "../src/exec.js";
import { AdapterError } from "../src/types.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("spawnLines", () => {
  it("passes args verbatim without a shell (spaces, quotes, unicode)", async () => {
    const arg = `it's "tricky" ñ $HOME; echo pwned`;
    const out: string[] = [];
    for await (const l of spawnLines("node", ["-e", "console.log(process.argv[1])", arg], { cwd: process.cwd(), signal: new AbortController().signal })) out.push(l);
    expect(out).toEqual([arg]);
  });
  it("throws AdapterError with stderr on non-zero exit", async () => {
    const run = async () => { for await (const _ of spawnLines("node", ["-e", "console.error('bad'); process.exit(3)"], { cwd: process.cwd(), signal: new AbortController().signal })); };
    await expect(run()).rejects.toThrow(/bad/);
    await expect(run()).rejects.toBeInstanceOf(AdapterError);
  });
  it("kills the child on abort", async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 50);
    const start = Date.now();
    for await (const _ of spawnLines("node", ["-e", "setTimeout(()=>{},10000)"], { cwd: process.cwd(), signal: ac.signal }));
    clearTimeout(t);
    expect(Date.now() - start).toBeLessThan(3000);
  });
  it("SIGKILLs a child that ignores SIGTERM after the grace period", async () => {
    const ac = new AbortController();
    let pid = 0;
    const start = Date.now();
    for await (const l of spawnLines("node", ["-e", "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"], { cwd: process.cwd(), signal: ac.signal, killGraceMs: 300 })) {
      pid = Number(l); ac.abort();
    }
    expect(pid).toBeGreaterThan(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(alive(pid)).toBe(false);
  });
  it("kills the child when the consumer stops iterating early", async () => {
    let pid = 0;
    for await (const l of spawnLines("node", ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], { cwd: process.cwd(), signal: new AbortController().signal, killGraceMs: 300 })) { pid = Number(l); break; }
    expect(alive(pid)).toBe(false);
  });
  it("does not truncate very long lines and reassembles lines split across chunks", async () => {
    const script = "const big='x'.repeat(300000);process.stdout.write(big.slice(0,100000));setTimeout(()=>{process.stdout.write(big.slice(100000)+'\\nsecond\\n'+'thi');setTimeout(()=>process.stdout.write('rd\\n'),50)},50)";
    const out: string[] = [];
    for await (const l of spawnLines("node", ["-e", script], { cwd: process.cwd(), signal: new AbortController().signal })) out.push(l);
    expect(out.map((l) => l.length)).toEqual([300000, 6, 5]);
    expect(out.slice(1)).toEqual(["second", "third"]);
  });
  it("writes stdin to the child", async () => {
    const out: string[] = [];
    for await (const l of spawnLines("node", ["-e", "process.stdin.pipe(process.stdout)"], { cwd: process.cwd(), signal: new AbortController().signal, stdin: "-a\nb" })) out.push(l);
    expect(out).toEqual(["-a", "b"]);
  });
  it("surfaces a spawn failure as AdapterError", async () => {
    const run = async () => { for await (const _ of spawnLines("/nonexistent/bin-xyz", [], { cwd: process.cwd(), signal: new AbortController().signal })); };
    await expect(run()).rejects.toBeInstanceOf(AdapterError);
    await expect(run()).rejects.toThrow(/ENOENT/);
  });
  it("does not spawn when already aborted", async () => {
    const ac = new AbortController(); ac.abort();
    const out: string[] = [];
    for await (const l of spawnLines("/nonexistent/bin-xyz", [], { cwd: process.cwd(), signal: ac.signal })) out.push(l);
    expect(out).toEqual([]);
  });
});
