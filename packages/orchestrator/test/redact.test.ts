import { describe, it, expect } from "vitest";
import { redact } from "../src/index.js";
describe("redact", () => {
  it("masks common secret shapes", () => {
    const out = redact("key sk-abc1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAABCDEFGHIJKLMNOP Bearer abc.def.ghi DB_PASSWORD=hunter2 name=bob");
    expect(out).not.toMatch(/sk-abc|ghp_abc|AKIAABC|abc\.def|hunter2/);
    expect(out).toContain("name=bob");
  });
});
