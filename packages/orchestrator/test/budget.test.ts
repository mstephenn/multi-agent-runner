import { describe, it, expect } from "vitest";
import { BudgetTracker } from "../src/budget.js";
describe("BudgetTracker", () => {
  it("sums usage and flags exceed", () => {
    const b = new BudgetTracker(100);
    b.add({ input: 60, output: 30 }); expect(b.exceeded).toBe(false);
    b.add({ input: 5, output: 10 }); expect(b.exceeded).toBe(true);
  });
  it("treats nulls as zero and undefined cap as unlimited", () => {
    const b = new BudgetTracker(undefined);
    b.add({ input: null, output: null }); b.add({ input: 1e9, output: 1e9 });
    expect(b.exceeded).toBe(false);
    expect(new BudgetTracker(10).used).toBe(0);
  });
  it("never produces NaN from missing or non-finite fields", () => {
    const b = new BudgetTracker(10);
    b.add({ input: undefined, output: NaN } as any);
    b.add({ input: null, output: 3 });
    expect(b.used).toBe(3);
    expect(b.exceeded).toBe(false);
  });
});
