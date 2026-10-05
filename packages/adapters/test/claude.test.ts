import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeClaudeLine, buildClaudeArgs, claudeAdapter, claudeFailure } from "../src/claude.js";
import { fakeBin, waitFor } from "./helpers.js";
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
      "--tools", "Read,Edit", "--allowedTools", "Read,Edit",
      "--strict-mcp-config", "--setting-sources", "",
      "--permission-mode", "acceptEdits",
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
  it("empty tool list becomes --tools \"\" (all tools disabled), never omitted; no --allowedTools", () => {
    const a = buildClaudeArgs({ ...base, allowedTools: [] });
    expect(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(a).not.toContain("--allowedTools");
  });
  it("restricts the available tool set per role (read-only roles cannot Edit/Write)", () => {
    const tools = (t: string[]) => { const a = buildClaudeArgs({ ...base, allowedTools: t }); return a[a.indexOf("--tools") + 1]; };
    expect(tools(["Read", "Grep", "Glob"])).toBe("Read,Grep,Glob");
    expect(tools(["Read", "Grep", "Glob"])).not.toMatch(/Edit|Write/);
    expect(tools(["Read", "Edit", "Write", "Bash"])).toBe("Read,Edit,Write,Bash");
  });
  it("reduces permission patterns to tool names for --tools but keeps them for --allowedTools", () => {
    const a = buildClaudeArgs({ ...base, allowedTools: ["Bash(git *)", "Bash(npm test)", "Read"] });
    expect(a[a.indexOf("--tools") + 1]).toBe("Bash,Read");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("Bash(git *),Bash(npm test),Read");
  });
  it("isolates the worker from user MCP servers and user/project settings", () => {
    const a = buildClaudeArgs(base);
    expect(a).toContain("--strict-mcp-config");
    expect(a).not.toContain("--mcp-config");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
  });
  it("applies a budget of 0/negative/NaN as an error instead of unlimited", () => {
    for (const b of [0, -1, NaN, Infinity]) expect(() => buildClaudeArgs({ ...base, maxBudgetUsd: b })).toThrow(AdapterError);
    expect(buildClaudeArgs({ ...base, maxBudgetUsd: 0.5 })).toContain("0.5");
    expect(buildClaudeArgs({ ...base, maxBudgetUsd: undefined })).not.toContain("--max-budget-usd");
  });
});

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
    expect(evs).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
  it("kills the child and ends silently when aborted mid-run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mar-marker-"));
    const marker = join(dir, "started");
    const bin = fakeBin(`require("fs").writeFileSync(${JSON.stringify(marker)},"x");setInterval(()=>{},1000)`);
    const ac = new AbortController();
    const p = collect(claudeAdapter(bin).run({ ...base, signal: ac.signal }));
    await waitFor(() => existsSync(marker));
    ac.abort();
    expect(await p).toEqual([]);
  });
  it("throws AdapterError on an is_error result (subtype and message surfaced) and still yields usage", async () => {
    const bin = fakeBin(`console.log(JSON.stringify({type:"result",subtype:"error_max_turns",is_error:true,result:"",errors:["hit max turns"],total_cost_usd:0.5,usage:{input_tokens:1,output_tokens:2}}))`);
    const seen: AgentEvent[] = [];
    const run = async () => { for await (const e of claudeAdapter(bin).run(base)) seen.push(e); };
    const err = await run().catch((e: Error) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as Error).message).toMatch(/error_max_turns/);
    expect((err as Error).message).toMatch(/hit max turns/);
    expect(seen.some((e) => e.type === "result")).toBe(false);
    expect(seen.find((e) => e.type === "usage")).toMatchObject({ costUsd: 0.5 });
  });
  it("throws on non-zero exit after partial output, keeping the earlier events", async () => {
    const bin = fakeBin(`console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"partial"}]}}));console.error("crashed API_KEY=sekret");process.exit(2)`);
    const seen: AgentEvent[] = [];
    const run = async () => { for await (const e of claudeAdapter(bin).run(base)) seen.push(e); };
    const err = await run().catch((e: Error) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as Error).message).toMatch(/exited 2.*crashed/);
    expect((err as Error).message).not.toContain("sekret");
    expect(seen).toEqual([{ type: "assistant_text", text: "partial" }]);
  });
  it("throws when the run ends cleanly without any result line", async () => {
    const bin = fakeBin(`console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"hi"}]}}))`);
    await expect(collect(claudeAdapter(bin).run(base))).rejects.toThrow(/no result/);
  });
});

describe("claudeFailure", () => {
  it("detects is_error and error_* subtypes, ignores success and other lines", () => {
    expect(claudeFailure('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')).toBeNull();
    expect(claudeFailure('{"type":"assistant"}')).toBeNull();
    expect(claudeFailure("garbage")).toBeNull();
    expect(claudeFailure('{"type":"result","subtype":"error_max_budget_usd"}')).toMatchObject({ subtype: "error_max_budget_usd" });
    expect(claudeFailure('{"type":"result","subtype":"success","is_error":true,"result":"API Error: 500"}')).toEqual({ subtype: "success", message: "API Error: 500" });
    expect(claudeFailure('{"type":"result","subtype":"error_during_execution","errors":["a","b"]}')).toEqual({ subtype: "error_during_execution", message: "a; b" });
  });
  it("caps and redacts the message", () => {
    const f = claudeFailure(JSON.stringify({ type: "result", is_error: true, result: "TOKEN=abc " + "x".repeat(1000) }));
    expect(Array.from(f!.message).length).toBeLessThanOrEqual(300);
  });
});
