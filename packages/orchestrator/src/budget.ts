const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class BudgetTracker {
  private total = 0;
  constructor(private cap: number | undefined) {}
  add(u: { input: number | null; output: number | null }) { this.total += n(u.input) + n(u.output); }
  get used() { return this.total; }
  get exceeded() { return this.cap !== undefined && this.total > this.cap; }
}
