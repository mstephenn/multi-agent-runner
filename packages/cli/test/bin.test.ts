import { describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 30000 });
const bin = fileURLToPath(new URL("../bin/mar.mjs", import.meta.url));
const run = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((res) =>
  execFile(process.execPath, [bin, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }, (e, out, err) =>
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
});
