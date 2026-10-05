import { describe, it, expect } from "vitest";
import type { StoredEvent } from "@mar/core";
import { deriveSteps, summarizeTool, resultMeta, relTime, taskStart, type ToolStep, type SayStep } from "../src/activity.js";

let n = 0;
const ev = (task: string | null, type: string, payload: unknown, ts = 1000 + n * 10): StoredEvent =>
  ({ id: ++n, run_id: "r", task_id: task, agent_id: task, ts, type, payload }) as unknown as StoredEvent;
const call = (name: string, input: unknown, ts?: number, task = "t") => ev(task, "tool_call", { name, input }, ts);
const result = (name: string, output: unknown, isError = false, ts?: number, task = "t") => ev(task, "tool_result", { name, output, isError }, ts);

const WT = "/Users/stephenm/workspace/ibeam/squad-lead-agent/.mar/worktrees/rmuuw5f9x/.shared/src/schema/conversion_signal.py";

describe("deriveSteps pairing", () => {
  it("pairs a result with its call and computes ms", () => {
    const s = deriveSteps([call("Read", { file_path: "a.py" }, 1000), result("Read", "x\ny", false, 1450)], "t");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "tool", name: "Read", done: true, isError: false, output: "x\ny", resultMeta: "2 lines", ms: 450 });
  });
  it("pairs parallel same-name calls FIFO", () => {
    const s = deriveSteps([call("Read", { file_path: "a" }, 1000), call("Read", { file_path: "b" }, 1010), result("Read", "A", false, 1100), result("Read", "B", false, 1200)], "t") as ToolStep[];
    expect(s.map((x) => [x.summary, x.output, x.ms])).toEqual([["a", "A", 100], ["b", "B", 190]]);
  });
  it("leaves an unmatched call pending", () => {
    const [s] = deriveSteps([call("Bash", { command: "sleep 9" })], "t") as ToolStep[];
    expect(s).toMatchObject({ done: false, isError: false });
    expect(s.output).toBeUndefined(); expect(s.ms).toBeUndefined();
  });
  it("turns an orphan result into its own done step", () => {
    const [s] = deriveSteps([result("Grep", "No matches found")], "t") as ToolStep[];
    expect(s).toMatchObject({ kind: "tool", name: "Grep", done: true, resultMeta: "no matches" });
    expect(s.ms).toBeUndefined();
  });
  it("marks error results", () => {
    const [s] = deriveSteps([call("Bash", { command: "false" }), result("Bash", "boom\nstack", true)], "t") as ToolStep[];
    expect(s).toMatchObject({ isError: true, done: true, resultMeta: "boom" });
  });
  it("does not pair across different names or tasks", () => {
    const s = deriveSteps([call("Read", {}), result("Grep", "x"), call("Read", {}, 1, "other"), result("Read", "y", false, 2, "other")], "t") as ToolStep[];
    expect(s.map((x) => [x.name, x.done])).toEqual([["Read", false], ["Grep", true]]);
  });
  it("emits say steps and keeps event order", () => {
    const s = deriveSteps([ev("t", "assistant_text", { text: "hi" }), call("Read", {}), ev("t", "usage", {}), result("Read", "")], "t");
    expect(s.map((x) => x.kind)).toEqual(["say", "tool"]);
    expect((s[0] as SayStep).text).toBe("hi");
    expect(s.map((x) => x.id)).toEqual([...s.map((x) => x.id)].sort((a, b) => a - b));
  });
  it("clips very long messages visibly", () => {
    const [s] = deriveSteps([ev("t", "assistant_text", { text: "x".repeat(9000) })], "t") as SayStep[];
    expect(s.text.length).toBeLessThan(8100);
    expect(s.text.endsWith(" …(clipped)")).toBe(true);
    const [u] = deriveSteps([ev("t", "assistant_text", { text: "y".repeat(8000) })], "t") as SayStep[];
    expect(u.text).toBe("y".repeat(8000));
  });
});

describe("deriveSteps robustness", () => {
  it("never throws on odd payloads", () => {
    const odd: StoredEvent[] = [
      ev("t", "tool_call", null), ev("t", "tool_call", []), ev("t", "tool_call", 5), ev("t", "tool_call", { name: 3, input: "s" }),
      ev("t", "tool_result", null), ev("t", "tool_result", { name: "Read" }), ev("t", "tool_result", { name: "Read", output: { a: 1 }, isError: "yes" }),
      ev("t", "assistant_text", { text: 42 }), ev("t", "assistant_text", undefined),
      ev("t", "tool_call", { name: "Read", input: null }), ev("t", "tool_call", { name: "Grep", input: [1] }), ev("t", "tool_call", { name: "Bash", input: 7 }),
    ];
    expect(() => deriveSteps(odd, "t")).not.toThrow();
    expect(deriveSteps(odd, "t").length).toBeGreaterThan(0);
  });
  it("summarizeTool / resultMeta are total", () => {
    for (const i of [null, undefined, 1, "s", [], [1], {}, { file_path: 3 }, { offset: "x" }]) {
      for (const name of ["Read", "Grep", "Glob", "Bash", "Edit", "Task", "zzz", ""]) expect(typeof summarizeTool(name, i)).toBe("string");
    }
    expect(typeof resultMeta("Grep", undefined, false)).toBe("string");
    expect(typeof resultMeta("Bash", 5, true)).toBe("string");
  });
  it("handles 5,000 events fast", () => {
    const evs: StoredEvent[] = [];
    for (let i = 0; i < 2500; i++) { evs.push(call("Read", { file_path: `f${i}` }, i)); evs.push(result("Read", "a\nb", false, i + 1)); }
    const t0 = performance.now();
    const s = deriveSteps(evs, "t");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(s).toHaveLength(2500);
  });
  it("does not mutate its input", () => {
    const evs = [call("Read", { file_path: WT }), result("Read", "x")];
    const snap = JSON.stringify(evs);
    Object.freeze(evs); evs.forEach((e) => Object.freeze(e));
    deriveSteps(evs, "t");
    expect(JSON.stringify(evs)).toBe(snap);
  });
});

describe("summarizeTool", () => {
  it("strips the worktree prefix from Read paths and shows line ranges", () => {
    expect(summarizeTool("Read", { file_path: WT, offset: 20, limit: 90 })).toBe("src/schema/conversion_signal.py (lines 20–109)");
    expect(summarizeTool("Read", { file_path: WT })).toBe("src/schema/conversion_signal.py");
    expect(summarizeTool("Read", { file_path: WT, limit: 50 })).toBe("src/schema/conversion_signal.py (lines 1–50)");
  });
  it("strips a repo-dir worktree prefix too", () => {
    expect(summarizeTool("Edit", { file_path: "/x/.mar/worktrees/abc/myrepo/src/b.ts" })).toBe("src/b.ts");
    expect(summarizeTool("Write", { file_path: "/tmp/other/c.ts" })).toBe("/tmp/other/c.ts");
  });
  it("summarizes Grep and Glob", () => {
    expect(summarizeTool("Grep", { pattern: "foo\\(", path: WT })).toBe("/foo\\(/ in src/schema/conversion_signal.py");
    expect(summarizeTool("Grep", { pattern: "x" })).toBe("/x/ in .");
    expect(summarizeTool("Grep", { pattern: "x", glob: "*.ts" })).toBe("/x/ in *.ts");
    expect(summarizeTool("Grep", { pattern: "x", path: "src", glob: "*.ts", output_mode: "count" })).toBe("/x/ in src [*.ts] [count]");
    expect(summarizeTool("Glob", { pattern: "**/*.py", path: "/a/.mar/worktrees/q/.shared/src" })).toBe("**/*.py in src");
  });
  it("uses the first line of a Bash command and strips paths inside it", () => {
    expect(summarizeTool("Bash", { command: `cat ${WT}\necho hi` })).toBe("cat src/schema/conversion_signal.py");
    expect(summarizeTool("shell", { command: "ls" })).toBe("ls");
    expect(summarizeTool("Bash", { command: "x".repeat(300) }).length).toBeLessThanOrEqual(141);
  });
  it("falls back to compact clipped JSON", () => {
    expect(summarizeTool("Task", { a: 1 })).toBe('{"a":1}');
    expect(summarizeTool("Weird", { big: "z".repeat(500) }).length).toBeLessThanOrEqual(121);
    expect(summarizeTool("Weird", null)).toBe("");
  });
});

describe("resultMeta", () => {
  it("describes search results", () => {
    expect(resultMeta("Grep", "No matches found", false)).toBe("no matches");
    expect(resultMeta("Glob", "", false)).toBe("no matches");
    expect(resultMeta("Grep", "a\n\nb\nc", false)).toBe("3 lines");
    expect(resultMeta("Read", "only", false)).toBe("1 line");
  });
  it("describes bash and errors", () => {
    expect(resultMeta("Bash", "lots\nof\noutput", false)).toBe("exit ok");
    expect(resultMeta("Bash", "\nnpm ERR! nope\nmore", true)).toBe("npm ERR! nope");
    expect(resultMeta("Read", "e".repeat(300), true).length).toBeLessThanOrEqual(101);
  });
});

describe("relTime / taskStart", () => {
  it("formats offsets", () => {
    expect(relTime(1000, 1000)).toBe("+0s");
    expect(relTime(13_000, 1000)).toBe("+12s");
    expect(relTime(1000 + 184_000, 1000)).toBe("+3m 04s");
    expect(relTime(500, 1000)).toBe("+0s");
  });
  it("finds the start of a task", () => {
    const evs = [ev("t", "prompt_sent", {}, 50), ev("t", "task_started", {}, 40), ev("u", "task_started", {}, 1)];
    expect(taskStart(evs, "t")).toBe(40);
    expect(taskStart([ev("t", "prompt_sent", {}, 50)], "t")).toBe(50);
    expect(taskStart([], "t")).toBe(0);
  });
});
