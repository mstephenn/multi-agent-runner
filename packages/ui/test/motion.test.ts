import { describe, it, expect } from "vitest";
import { countTo, drawerIn, nodeIn, pulseRing, reducedMotion, rowsIn, statusFlash } from "../src/motion.js";

// Vitest runs in Node (no window): every helper must degrade to a harmless no-op.
describe("motion helpers without a browser", () => {
  it("treats a missing window as reduced motion", () => {
    expect(reducedMotion()).toBe(true);
  });
  it("countTo snaps straight to the target value and returns a callable stop", () => {
    const seen: number[] = [];
    const stop = countTo(0, 1200, (n) => seen.push(n));
    expect(seen).toEqual([1200]);
    expect(() => stop()).not.toThrow();
  });
  it("countTo with equal values just reports it", () => {
    const seen: number[] = [];
    countTo(5, 5, (n) => seen.push(n));
    expect(seen).toEqual([5]);
  });
  it("element helpers accept null/empty input and return stop functions", () => {
    for (const stop of [drawerIn(null), nodeIn(null), statusFlash(null), pulseRing(null), rowsIn([])]) {
      expect(typeof stop).toBe("function");
      expect(() => stop()).not.toThrow();
    }
  });
});
