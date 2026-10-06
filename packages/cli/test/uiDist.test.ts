import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { marVersion, parseCli, resolveUiDist } from "../src/main.js";

describe("resolveUiDist", () => {
  const here = "/pkg/dist";
  const bundled = join(resolve(here, "ui"), "index.html");
  const dev = join(resolve(here, "../../ui/dist"), "index.html");
  it("prefers dist/ui next to the bundle", () => {
    expect(resolveUiDist(here, () => true)).toBe(resolve(here, "ui"));
  });
  it("falls back to the monorepo ui build", () => {
    expect(resolveUiDist(here, (p) => p === dev)).toBe(resolve(here, "../../ui/dist"));
    expect(resolveUiDist(here, (p) => p === bundled || p === dev)).toBe(resolve(here, "ui"));
  });
  it("returns undefined when neither exists", () => {
    expect(resolveUiDist(here, () => false)).toBeUndefined();
  });
});

describe("--version", () => {
  it("parses --version and -v", () => {
    expect(parseCli(["--version"])).toEqual({ cmd: "version" });
    expect(parseCli(["-v"])).toEqual({ cmd: "version" });
  });
  it("marVersion is semver", () => { expect(marVersion()).toMatch(/^\d+\.\d+\.\d+/); });
});
