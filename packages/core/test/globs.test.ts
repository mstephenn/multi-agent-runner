import { describe, it, expect } from "vitest";
import { globsOverlap, matchesAnyGlob } from "../src/index.js";

describe("globsOverlap", () => {
  it.each([
    ["src/a/**", "src/b/**", false],
    ["src/a", "src/b", false],
    ["src/a/*", "src/b/*", false],
    ["src/**", "src/a/b.ts", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/*.tsx", false],
    ["**", "anything/at/all.ts", true],
    ["**", "**", true],
    ["src/a*", "src/ab/x", true],
    ["src/a*", "src/b*", false],
    ["*.md", "docs/*.md", false],
    ["*.md", "README.md", true],
    ["docs/**/*.md", "docs/a/b/c.md", true],
    ["docs/**/*.md", "src/**", false],
    ["src/a", "src/a/b.ts", true], // a bare name may be a directory
    ["a?c", "abc", true],
    ["a?c", "abbc", false],
    ["**/foo.ts", "src/deep/foo.ts", true],
    ["**/foo.ts", "src/deep/bar.ts", false],
  ])("%s vs %s -> %s (both orders)", (a, b, want) => {
    expect(globsOverlap(a, b)).toBe(want);
    expect(globsOverlap(b, a)).toBe(want);
  });
});

describe("matchesAnyGlob", () => {
  it("matches files against declared globs", () => {
    expect(matchesAnyGlob("src/a/x.ts", ["src/a/**"])).toBe(true);
    expect(matchesAnyGlob("src/b/x.ts", ["src/a/**"])).toBe(false);
    expect(matchesAnyGlob("src/b/x.ts", ["src/a/**", "src/b/*.ts"])).toBe(true);
    expect(matchesAnyGlob("README.md", ["*.md"])).toBe(true);
    expect(matchesAnyGlob("docs/x.md", ["*.md"])).toBe(false);
    expect(matchesAnyGlob("anything", [])).toBe(false);
  });
});
