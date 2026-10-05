import { describe, it, expect } from "vitest";
import { Store } from "../../server/src/store.js";
import { publishResult, injectSlices } from "../src/index.js";

const setup = () => { const s = new Store(":memory:"); s.createRun("r", "g", "/x"); return s; };
const task = (needs: string[]) => ({ id: "b", role: "reviewer", runtime: "claude", tier: "mid", goal: "g", dependsOn: ["a"], needs }) as any;

describe("blackboard", () => {
  it("publishes summary and skips empty lists", () => {
    const s = setup();
    const e = publishResult(s, "r", "a", { summary: "did it", filesChanged: ["x.ts"], decisions: [], openQuestions: [] });
    expect(e.map((x) => x.key).sort()).toEqual(["a/files", "a/summary"]);
    expect(s.listEvents("r").filter((x) => x.type === "blackboard_write")).toHaveLength(2);
  });
  it("truncates over-long summaries to the cap", () => {
    const s = setup();
    const [sum] = publishResult(s, "r", "a", { summary: "x".repeat(5000), filesChanged: [], decisions: [], openQuestions: [] });
    expect(sum.body.length).toBeLessThanOrEqual(1200);
    expect(sum.body.endsWith("…")).toBe(true);
  });
  it("turns huge file lists into an artifact_ref", () => {
    const s = setup();
    const files = Array.from({ length: 400 }, (_, i) => `src/file-${i}.ts`);
    const e = publishResult(s, "r", "a", { summary: "s", filesChanged: files, decisions: [], openQuestions: [] });
    const f = e.find((x) => x.key === "a/files")!;
    expect(f.kind).toBe("artifact_ref");
    expect(f.refs).toHaveLength(20);
  });
  it("injects only needed keys, latest version, and logs reads", () => {
    const s = setup();
    publishResult(s, "r", "a", { summary: "v1", filesChanged: [], decisions: ["d"], openQuestions: [] });
    publishResult(s, "r", "a", { summary: "v2", filesChanged: [], decisions: ["d"], openQuestions: [] });
    const { slices, missing } = injectSlices(s, "r", task(["a/summary", "a/nope"]));
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ key: "a/summary", version: 2, body: "v2" });
    expect(missing).toEqual(["a/nope"]);
    const reads = s.listEvents("r").filter((x) => x.type === "blackboard_read");
    expect(reads).toHaveLength(1);
    expect(reads[0].payload).toMatchObject({ key: "a/summary", version: 2 });
  });
});

import { clip, fitList } from "../src/blackboard.js";
describe("hardening", () => {
  it("redacts secrets in stored bodies", () => {
    const s = setup();
    const [sum] = publishResult(s, "r", "a", { summary: "k sk-abc1234567890abcdef DB_PASSWORD=hunter2", filesChanged: [], decisions: ["use sk-abc1234567890abcdef"], openQuestions: [] });
    expect(sum.body).not.toMatch(/sk-abc|hunter2/);
    expect(s.latestBb("r", "a/decisions")!.body).not.toMatch(/sk-abc/);
  });
  it("clip boundary", () => {
    expect(clip("x".repeat(1200))).toHaveLength(1200);
    const c = clip("x".repeat(1201));
    expect(c).toHaveLength(1199 + 1);
    expect(c.endsWith("…")).toBe(true);
  });
  it("lists drop whole items with explicit marker", () => {
    const s = setup();
    const decisions = Array.from({ length: 200 }, (_, i) => `decision number ${i} ${"y".repeat(60)}`);
    const e = publishResult(s, "r", "a", { summary: "s", filesChanged: [], decisions, openQuestions: [] });
    const body = e.find((x) => x.key === "a/decisions")!.body;
    expect(body.length).toBeLessThanOrEqual(1200);
    const m = body.match(/…\(\+(\d+) more\)$/)!;
    expect(m).toBeTruthy();
    const kept = body.split("\n").length - 1;
    expect(kept + Number(m[1])).toBe(200);
  });
  it("exactly-fitting list is unchanged", () => {
    const items = ["a".repeat(598), "b".repeat(598)]; // 600+1+600 = 1201? "- " added below
    const fits = [items[0].slice(0, 597), items[1].slice(0, 598)]; // 597+1+598 = 1196
    expect(fitList(fits)).toBe(fits.join("\n"));
    const exact = ["a".repeat(600), "b".repeat(599)]; // 600+1+599 = 1200
    expect(fitList(exact)).toBe(exact.join("\n"));
  });
});
