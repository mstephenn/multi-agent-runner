import { describe, it, expect } from "vitest";
import { waitFor } from "./helpers.js";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCodexLine, codexFailure, buildCodexArgs, codexAdapter } from "../src/codex.js";
import { AdapterError, type AdapterInput, type AgentEvent } from "../src/types.js";

const lines = readFileSync(new URL("./fixtures/codex-basic.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);

describe("normalizeCodexLine", () => {
  it("emits a result from the last agent message", () => {
    const evs = lines.flatMap(normalizeCodexLine);
    const r = evs.filter((e) => e.type === "result");
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect((r.at(-1) as any).text).toContain("summary");
  });
  it("emits usage with cached tokens when reported", () => {
    const u = lines.flatMap(normalizeCodexLine).find((e) => e.type === "usage") as any;
    expect(u).toEqual({ type: "usage", input: 16536, output: 9, cached: 11136, costUsd: null });
  });
  it("does not treat the fixture's non-fatal config-warning error items as failures", () => {
    expect(lines.map(codexFailure).filter(Boolean)).toEqual([]);
    expect(lines.flatMap(normalizeCodexLine).some((e) => e.type === "tool_call")).toBe(false);
  });
  it("maps command_execution items to tool_call/tool_result", () => {
    // unit-test line (hand-built, not captured)
    const l = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "a\nb", exit_code: 0 } });
    expect(normalizeCodexLine(l)).toMatchObject([{ type: "tool_call", name: "shell" }, { type: "tool_result", output: "a\nb", isError: false }]);
    const bad = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "false", exit_code: 1 } });
    expect(normalizeCodexLine(bad)[1]).toMatchObject({ output: "", isError: true });
  });
  it("ignores garbage and unknown events", () => {
    expect(normalizeCodexLine("")).toEqual([]);
    expect(normalizeCodexLine("{")).toEqual([]);
    expect(normalizeCodexLine("null")).toEqual([]);
    expect(normalizeCodexLine("42")).toEqual([]);
    expect(normalizeCodexLine('{"type":"thread.started"}')).toEqual([]);
    expect(normalizeCodexLine('{"type":"item.completed","item":null}')).toEqual([]);
    expect(normalizeCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"x"}}')).toEqual([]);
    expect(normalizeCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":""}}')).toEqual([]);
    expect(normalizeCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":5}}')).toEqual([]);
  });
  it("maps missing or non-numeric usage fields to null, never NaN/undefined", () => {
    expect(normalizeCodexLine('{"type":"turn.completed"}')).toEqual([{ type: "usage", input: null, output: null, cached: null, costUsd: null }]);
    const bad = normalizeCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: "3", output_tokens: null } }));
    expect(bad).toEqual([{ type: "usage", input: null, output: null, cached: null, costUsd: null }]);
  });
});

describe("codexFailure", () => {
  it("detects turn.failed and top-level error events (unit-test lines)", () => {
    expect(codexFailure('{"type":"turn.failed","error":{"message":"boom"}}')).toBe("boom");
    expect(codexFailure('{"type":"turn.failed"}')).toMatch(/turn failed/i);
    expect(codexFailure('{"type":"error","message":"bad"}')).toBe("bad");
  });
  it("ignores everything else", () => {
    expect(codexFailure("")).toBeNull();
    expect(codexFailure("{")).toBeNull();
    expect(codexFailure("null")).toBeNull();
    expect(codexFailure('{"type":"turn.completed"}')).toBeNull();
    expect(codexFailure('{"type":"item.completed","item":{"type":"error","message":"warn"}}')).toBeNull();
  });
});

const base: AdapterInput = { taskId: "t", prompt: "-p do it", cwd: "/work/dir", model: null, allowedTools: ["Read"], signal: new AbortController().signal };

describe("buildCodexArgs", () => {
  it("builds read-only args, with the prompt read from stdin (`-`)", () => {
    expect(buildCodexArgs(base)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"', "--sandbox", "read-only", "-C", "/work/dir", "-"]);
  });
  it("passes --ignore-rules (verified in `codex exec --help`)", () => {
    expect(buildCodexArgs(base)).toContain("--ignore-rules");
  });
  it("isolates workers from the user's Codex config (MCP servers) and never blocks on approvals", () => {
    // Verified against codex-cli 0.156.1: `-c mcp_servers={}` does NOT clear user MCP servers, `--ignore-user-config` does (auth still works).
    for (const unsafe of [false, true]) {
      const a = buildCodexArgs({ ...base, unsafe });
      expect(a).toContain("--ignore-user-config");
      expect(a[a.indexOf("-c") + 1]).toBe('approval_policy="never"');
      expect(a.join(" ")).not.toMatch(/dangerously|bypass/i);
    }
  });
  it("uses workspace-write only when an Edit/Write tool is allowed", () => {
    const sb = (t: string[]) => { const a = buildCodexArgs({ ...base, allowedTools: t }); return a[a.indexOf("--sandbox") + 1]; };
    expect(sb([])).toBe("read-only");
    expect(sb(["Read", "Bash"])).toBe("read-only");
    expect(sb(["Read", "Edit"])).toBe("workspace-write");
    expect(sb(["Write"])).toBe("workspace-write");
    expect(sb(["Edit(src/**)"])).toBe("workspace-write");
    expect(sb(["NotWrite"])).toBe("read-only");
  });
  it("adds -m only when set", () => {
    expect(buildCodexArgs(base)).not.toContain("-m");
    const a = buildCodexArgs({ ...base, model: "m1" });
    expect(a.slice(a.indexOf("-m"), a.indexOf("-m") + 2)).toEqual(["-m", "m1"]);
    expect(a.at(-1)).toBe("-");
  });
  it("never maps unsafe: args are identical and carry no bypass flag", () => {
    const safe = buildCodexArgs(base);
    expect(buildCodexArgs({ ...base, unsafe: true })).toEqual(safe);
    expect(buildCodexArgs({ ...base, unsafe: true, allowedTools: ["Edit"] })).toEqual(buildCodexArgs({ ...base, allowedTools: ["Edit"] }));
    expect(safe.join(" ")).not.toMatch(/dangerously|danger-full-access|bypass/);
  });
});

function fakeBin(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "mar-fake-")), "fake");
  writeFileSync(p, `#!${process.execPath}\n${body}`);
  chmodSync(p, 0o755);
  return p;
}
const emit = (...ls: object[]) => ls.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join("");
async function collect(it: AsyncIterable<AgentEvent>) { const o: AgentEvent[] = []; for await (const e of it) o.push(e); return o; }
const msg = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });

describe("codexAdapter", () => {
  it("sends the prompt on stdin and normalizes stdout; last result wins", async () => {
    const bin = fakeBin(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log("noise");console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:s+"|"+process.argv.slice(2).join(" ")}}));${emit({ type: "turn.completed", usage: {} })}})`);
    const evs = await collect(codexAdapter(bin).run({ ...base, cwd: ".", prompt: "-hello" }));
    const r = evs.filter((e) => e.type === "result") as any[];
    expect(r.at(-1).text.startsWith("-hello|exec --json")).toBe(true);
    expect(r.at(-1).text.endsWith(" -")).toBe(true);
    expect(evs.some((e) => e.type === "usage")).toBe(true);
  });
  it("passes a clean run through (fixture replay)", async () => {
    const bin = fakeBin(`process.stdin.resume();${lines.map((l) => `console.log(${JSON.stringify(l)});`).join("")}`);
    const evs = await collect(codexAdapter(bin).run({ ...base, cwd: "." }));
    expect(evs.filter((e) => e.type === "result")).toHaveLength(1);
  });
  it("throws AdapterError on turn.failed even if exit code is 0", async () => {
    const bin = fakeBin(`${emit({ type: "turn.started" }, { type: "turn.failed", error: { message: "quota exceeded" } })}`);
    const p = collect(codexAdapter(bin).run({ ...base, cwd: "." }));
    await expect(p).rejects.toThrow(AdapterError);
    await expect(collect(codexAdapter(bin).run({ ...base, cwd: "." }))).rejects.toThrow(/quota exceeded/);
  });
  it("throws AdapterError on turn.failed even after an agent message", async () => {
    const bin = fakeBin(emit(msg("partial"), { type: "turn.failed", error: { message: "late" } }));
    await expect(collect(codexAdapter(bin).run({ ...base, cwd: "." }))).rejects.toThrow(/late/);
  });
  it("throws AdapterError when the run ends with no agent message (includes last error)", async () => {
    const bin = fakeBin(emit({ type: "turn.started" }, { type: "error", message: "stream died" }, { type: "turn.completed", usage: {} }));
    await expect(collect(codexAdapter(bin).run({ ...base, cwd: "." }))).rejects.toThrow(/stream died/);
    const empty = fakeBin(emit({ type: "thread.started" }));
    await expect(collect(codexAdapter(empty).run({ ...base, cwd: "." }))).rejects.toThrow(/no agent message/);
  });
  it("tolerates a transient top-level error (e.g. reconnect) when a result follows", async () => {
    const bin = fakeBin(emit({ type: "error", message: "Reconnecting... 1/5" }, msg("{\"summary\":\"ok\"}"), { type: "turn.completed", usage: {} }));
    const evs = await collect(codexAdapter(bin).run({ ...base, cwd: "." }));
    expect(evs.filter((e) => e.type === "result")).toHaveLength(1);
  });
  it("does not pass secrets from the parent env to the child", async () => {
    process.env.MAR_TEST_SECRET_TOKEN = "leak";
    try {
      const bin = fakeBin(`console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:String(process.env.MAR_TEST_SECRET_TOKEN)}}))`);
      const evs = await collect(codexAdapter(bin).run({ ...base, cwd: "." }));
      expect(evs.find((e) => e.type === "result")).toMatchObject({ text: "undefined" });
    } finally { delete process.env.MAR_TEST_SECRET_TOKEN; }
  });
  it("surfaces a missing binary as AdapterError with the spawn message", async () => {
    await expect(collect(codexAdapter("/nonexistent/codex-bin").run(base))).rejects.toThrow(/ENOENT/);
  });
  it("does not start the process when already aborted, and does not raise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mar-marker-"));
    const marker = join(dir, "ran");
    const bin = fakeBin(`require("fs").writeFileSync(${JSON.stringify(marker)},"x")`);
    const ac = new AbortController(); ac.abort();
    const evs = await collect(codexAdapter(bin).run({ ...base, cwd: ".", signal: ac.signal }));
    // sentinel: a second, un-aborted run of a different fake must finish AFTER the aborted one; if the aborted run had
    // spawned, its marker would exist by the time the sentinel's marker is observed.
    const sentinel = join(dir, "sentinel");
    await collect(codexAdapter(fakeBin(`require("fs").writeFileSync(${JSON.stringify(sentinel)},"x")`)).run({ ...base, cwd: "." })).catch(() => {});
    await waitFor(() => existsSync(sentinel));
    expect(evs).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
  it("kills the child and ends without error when aborted mid-run", async () => {
    const started = join(mkdtempSync(join(tmpdir(), "mar-marker-")), "started");
    const bin = fakeBin(`${emit({ type: "turn.started" })}require("fs").writeFileSync(${JSON.stringify(started)},"x");setInterval(()=>{},1000);`);
    const ac = new AbortController();
    const it = codexAdapter(bin).run({ ...base, cwd: ".", signal: ac.signal });
    void waitFor(() => existsSync(started)).then(() => ac.abort());
    const evs = await collect(it);
    expect(evs).toEqual([]);
  });
});
