import { describe, it, expect } from "vitest";
import { spawnLines } from "../src/exec.js";
import { AdapterError } from "../src/types.js";

import { alive, waitFor } from "./helpers.js";
import { sanitizeDiagnostic } from "../src/sanitize.js";

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
  it("kills grandchildren too (process group) on abort", async () => {
    const ac = new AbortController();
    const script = "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(process.pid+' '+g.pid);setInterval(()=>{},1000)";
    let pids: number[] = [];
    for await (const l of spawnLines("node", ["-e", script], { cwd: process.cwd(), signal: ac.signal, killGraceMs: 300 })) { pids = l.split(" ").map(Number); ac.abort(); }
    expect(pids).toHaveLength(2);
    await waitFor(() => !alive(pids[1]!));
    expect(alive(pids[0]!)).toBe(false);
  });
  it("kills grandchildren on early consumer exit", async () => {
    const script = "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(process.pid+' '+g.pid);setInterval(()=>{},1000)";
    let pids: number[] = [];
    for await (const l of spawnLines("node", ["-e", script], { cwd: process.cwd(), signal: new AbortController().signal, killGraceMs: 300 })) { pids = l.split(" ").map(Number); break; }
    await waitFor(() => !alive(pids[1]!));
  });
  it("does not signal a child that is still flushing a normal exit", async () => {
    // child keeps working after closing stdout early; the old unconditional stop() would SIGTERM it -> `exited null`
    const script = "console.log('a');require('fs').closeSync(1);setTimeout(()=>{process.exit(0)},300)"; // exit delay is the behaviour under test
    const out: string[] = [];
    for await (const l of spawnLines("node", ["-e", script], { cwd: process.cwd(), signal: new AbortController().signal })) out.push(l);
    expect(out).toEqual(["a"]);
  });
  it("reports a genuine non-zero exit even if abort fires afterwards", async () => {
    const ac = new AbortController();
    const run = async () => {
      for await (const _ of spawnLines("node", ["-e", "console.log(process.pid);setTimeout(()=>process.exit(4),50)"], { cwd: process.cwd(), signal: ac.signal })) {
        await waitFor(() => !alive(Number(_))); // child has exited on its own by now
        ac.abort();
      }
    };
    await expect(run()).rejects.toThrow(/exited 4/);
  });
  it("caps and redacts stderr in the error and never splits a multibyte char", async () => {
    const script = "console.error('API_KEY=supersecret123 '+'😀'.repeat(1000));process.exit(1)";
    const run = async () => { for await (const _ of spawnLines("node", ["-e", script], { cwd: process.cwd(), signal: new AbortController().signal })); };
    const err = await run().catch((e: Error) => e);
    expect(err).toBeInstanceOf(AdapterError);
    const m = (err as Error).message;
    expect(Array.from(m).length).toBeLessThanOrEqual(400);
    expect(m).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    const run2 = async () => { for await (const _ of spawnLines("node", ["-e", "console.error('API_KEY=supersecret123 boom');process.exit(1)"], { cwd: process.cwd(), signal: new AbortController().signal })); };
    const e2 = await run2().catch((e: Error) => e);
    expect((e2 as Error).message).toContain("boom");
    expect((e2 as Error).message).not.toContain("supersecret123");
  });
  it("rejects a line over the length cap with AdapterError and stops the child", async () => {
    const script = "process.stdout.write('x'.repeat(5000));setInterval(()=>{},1000)";
    const run = async () => { for await (const _ of spawnLines("node", ["-e", script], { cwd: process.cwd(), signal: new AbortController().signal, maxLineChars: 1000, killGraceMs: 300 })); };
    await expect(run()).rejects.toThrow(/line exceeds/);
  });
  it("passes env to the child", async () => {
    const out: string[] = [];
    for await (const l of spawnLines("node", ["-e", "console.log(process.env.MAR_T)"], { cwd: process.cwd(), signal: new AbortController().signal, env: { ...process.env, MAR_T: "v1" } })) out.push(l);
    expect(out).toEqual(["v1"]);
  });
});

describe("sanitizeDiagnostic", () => {
  it("redacts KEY=value pairs, bearer tokens and sk- keys", () => {
    const s = sanitizeDiagnostic('OPENAI_API_KEY=abc123 token: "xyz" Authorization: Bearer abc.def sk-abcdefgh12345 ok');
    expect(s).not.toMatch(/abc123|xyz|abc\.def|sk-abcdefgh/);
    expect(s).toContain("ok");
  });
});
