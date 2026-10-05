import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeClaudeLine, buildClaudeArgs, claudeAdapter } from "../src/claude.js";
import { AdapterError, type AdapterInput, type AgentEvent } from "../src/types.js";

const lines = readFileSync(new URL("./fixtures/claude-basic.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);

describe("normalizeClaudeLine", () => {
  it("emits exactly one result event with the final text", () => {
    const evs = lines.flatMap(normalizeClaudeLine);
    const results = evs.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    expect((results[0] as any).text).toContain("summary");
  });
  it("emits a usage event with numeric tokens", () => {
    const u = lines.flatMap(normalizeClaudeLine).find((e) => e.type === "usage") as any;
    expect(typeof u.input === "number" || u.input === null).toBe(true);
    expect("cached" in u && "costUsd" in u).toBe(true);
    expect(u.input).toBe(9);
    expect(u.output).toBe(50);
    expect(u.cached).toBe(14160);
    expect(u.costUsd).toBeGreaterThan(0);
  });
  it("maps tool_use and tool_result blocks", () => {
    const use = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } });
    const res = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body", is_error: false }] } });
    expect(normalizeClaudeLine(use)).toEqual([{ type: "tool_call", name: "Read", input: { file_path: "a.ts" } }]);
    expect(normalizeClaudeLine(res)).toMatchObject([{ type: "tool_result", output: "file body", isError: false }]);
  });
  it("ignores blank, non-JSON and unknown lines without throwing", () => {
    expect(normalizeClaudeLine("")).toEqual([]);
    expect(normalizeClaudeLine("garbage")).toEqual([]);
    expect(normalizeClaudeLine('{"type":"system","subtype":"init"}')).toEqual([]);
    expect(normalizeClaudeLine("null")).toEqual([]);
    expect(normalizeClaudeLine("42")).toEqual([]);
    expect(normalizeClaudeLine('{"type":"assistant","message":null}')).toEqual([]);
    expect(normalizeClaudeLine('{"type":"assistant","message":{"content":"str"}}')).toEqual([]);
  });
  it("maps missing or non-numeric usage fields to null, never NaN/undefined", () => {
    const evs = normalizeClaudeLine(JSON.stringify({ type: "result", result: "x" }));
    expect(evs[0]).toEqual({ type: "usage", input: null, output: null, cached: null, costUsd: null });
    const bad = normalizeClaudeLine(JSON.stringify({ type: "result", result: "x", total_cost_usd: "1", usage: { input_tokens: "3", output_tokens: null } }));
    expect(bad[0]).toEqual({ type: "usage", input: null, output: null, cached: null, costUsd: null });
  });
  it("gives an empty result text when result is not a string", () => {
    const evs = normalizeClaudeLine(JSON.stringify({ type: "result", result: null }));
    expect(evs[1]).toEqual({ type: "result", text: "" });
  });
  it("stringifies non-string tool_result content", () => {
    const res = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "hi" }], is_error: true }] } });
    expect(normalizeClaudeLine(res)).toMatchObject([{ type: "tool_result", output: '[{"type":"text","text":"hi"}]', isError: true }]);
  });
});

const base: AdapterInput = { taskId: "t", prompt: "-p do it", cwd: ".", model: null, allowedTools: ["Read", "Edit"], signal: new AbortController().signal };

describe("buildClaudeArgs", () => {
  it("omits the prompt (delivered on stdin) and builds the default args", () => {
    expect(buildClaudeArgs(base)).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      "--allowedTools", "Read,Edit", "--permission-mode", "acceptEdits",
    ]);
  });
  it("adds --model only when set", () => {
    expect(buildClaudeArgs(base)).not.toContain("--model");
    const a = buildClaudeArgs({ ...base, model: "m1" });
    expect(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2)).toEqual(["--model", "m1"]);
  });
  it("adds --max-budget-usd when set", () => {
    const a = buildClaudeArgs({ ...base, maxBudgetUsd: 1.5 });
    expect(a.slice(a.indexOf("--max-budget-usd"), a.indexOf("--max-budget-usd") + 2)).toEqual(["--max-budget-usd", "1.5"]);
  });
  it("adds --dangerously-skip-permissions only when unsafe === true", () => {
    const safe = buildClaudeArgs({ ...base, unsafe: false });
    expect(safe).not.toContain("--dangerously-skip-permissions");
    expect(safe).toContain("acceptEdits");
    expect(buildClaudeArgs({ ...base, unsafe: undefined })).not.toContain("--dangerously-skip-permissions");
    expect(buildClaudeArgs({ ...base, unsafe: "yes" as any })).not.toContain("--dangerously-skip-permissions");
    const unsafe = buildClaudeArgs({ ...base, unsafe: true });
    expect(unsafe).toContain("--dangerously-skip-permissions");
    expect(unsafe).not.toContain("--permission-mode");
  });
  it("omits --allowedTools when the list is empty", () => {
    expect(buildClaudeArgs({ ...base, allowedTools: [] })).not.toContain("--allowedTools");
  });
});

function fakeBin(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "mar-fake-")), "fake");
  writeFileSync(p, `#!${process.execPath}\n${body}`);
  chmodSync(p, 0o755);
  return p;
}
async function collect(it: AsyncIterable<AgentEvent>) { const o: AgentEvent[] = []; for await (const e of it) o.push(e); return o; }

describe("claudeAdapter", () => {
  it("sends the prompt on stdin and normalizes stdout", async () => {
    const bin = fakeBin(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log("noise");console.log(JSON.stringify({type:"result",result:s+"|"+process.argv.slice(2).join(" ")}))})`);
    const evs = await collect(claudeAdapter(bin).run({ ...base, prompt: "-hello" }));
    const r = evs.find((e) => e.type === "result") as any;
    expect(r.text.startsWith("-hello|-p --output-format")).toBe(true);
    expect(r.text).not.toContain("hello|-p -hello");
  });
  it("surfaces a missing binary as AdapterError with the spawn message", async () => {
    await expect(collect(claudeAdapter("/nonexistent/claude-bin").run(base))).rejects.toThrow(AdapterError);
    await expect(collect(claudeAdapter("/nonexistent/claude-bin").run(base))).rejects.toThrow(/ENOENT/);
  });
  it("does not start the process when already aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mar-marker-"));
    const marker = join(dir, "ran");
    const bin = fakeBin(`require("fs").writeFileSync(${JSON.stringify(marker)},"x")`);
    const ac = new AbortController(); ac.abort();
    const evs = await collect(claudeAdapter(bin).run({ ...base, signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 300));
    expect(evs).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});
