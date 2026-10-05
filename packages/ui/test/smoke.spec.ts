import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "../../server/src/server.js";
import { Store } from "../../server/src/store.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/run.json", import.meta.url)), "utf8"));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Wait until the clock has moved on, instead of a fixed sleep.
const nextMs = async () => { const t = Date.now(); while (Date.now() === t) await sleep(1); };

let srv: Awaited<ReturnType<typeof startServer>>;
let base = "";

test.beforeAll(async () => {
  const store = new Store(":memory:");
  const id: string = fixture.run.id;
  store.createRun(id, fixture.run.goal, fixture.run.repo);
  store.savePlan(id, fixture.plan);
  for (const t of fixture.tasks) store.setTaskStatus(id, t.task_id, t.status, t.detail ?? undefined);
  for (const e of fixture.events) {
    await nextMs(); // the store stamps ts itself; keep them strictly ordered for the replay test
    if (e.type === "blackboard_write") for (const b of fixture.blackboard) store.writeBb({ ...b, run_id: id });
    store.appendEvent({ run_id: id, task_id: e.task_id, agent_id: e.task_id, type: e.type, payload: e.payload });
  }
  for (const r of fixture.reports) store.saveReport(id, r.task_id, r.body);
  srv = await startServer(store, { port: 0, staticDir: dist });
  base = `http://127.0.0.1:${srv.port}`;
});
test.afterAll(async () => { await srv.close(); });

const flowEdge = (page: import("@playwright/test").Page) => page.locator(".react-flow__edge.animated");

test.beforeEach(async ({ page }) => { await page.goto(`${base}/?run=r1`); });

test("graph shows both agents with runtime badges and a labelled animated flow edge", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.run.goal);
  await expect(page.getByTestId("node-impl").locator(".rt-codex")).toHaveText("codex");
  await expect(page.getByTestId("node-rev").locator(".rt-claude")).toHaveText("claude");
  await expect(flowEdge(page)).toHaveCount(1);
  await expect(page.locator(".react-flow__edge-text", { hasText: "impl/summary" })).toBeVisible();
});

test("a task without usage shows n/a, never NaN", async ({ page }) => {
  const rev = page.getByTestId("node-rev");
  await expect(rev).toContainText("n/a tok");
  await expect(page.getByTestId("node-impl")).toContainText("1,200 tok");
  await expect(page.locator("body")).not.toContainText(/NaN|undefined/);
  await expect(page.getByTestId("total-tokens")).toHaveText("1,200");
});

test("selecting rev shows the injected key with its token count", async ({ page }) => {
  await page.getByTestId("node-rev").click();
  await expect(page.getByRole("tab", { name: "Context" })).toHaveAttribute("aria-selected", "true");
  const row = page.getByRole("row", { name: /impl\/summary/ });
  await expect(row).toContainText("v1");
  await expect(row).toContainText("42");
  await expect(page.locator("pre.prompt")).toContainText("Review the change.");
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("n/a");
});

test("keyboard: arrow keys switch inspector tabs", async ({ page }) => {
  await page.getByTestId("node-rev").getByRole("button").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "Context" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
});

test("untrusted event text renders as literal text and never executes", async ({ page }) => {
  await page.getByTestId("node-rev").click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.locator(".act-text")).toHaveText('<img src=x onerror="window.__pwned=1">');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test("replay scrubber hides later events in every view; Live restores them", async ({ page }) => {
  const snap = await (await page.request.get(`${base}/api/runs/r1`)).json();
  const read = snap.events.find((e: { type: string }) => e.type === "blackboard_read");
  await expect(flowEdge(page)).toHaveCount(1);
  await page.getByLabel("Replay").fill(String(read.ts - 1));
  await expect(flowEdge(page)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Replaying" })).toBeVisible();
  await page.getByRole("button", { name: "Live" }).click();
  await expect(flowEdge(page)).toHaveCount(1);
});

test("blackboard panel lists entries with their readers", async ({ page }) => {
  await page.getByRole("button", { name: /Blackboard/ }).click();
  const row = page.getByRole("region", { name: "Blackboard" }).getByRole("row", { name: /impl\/summary/ });
  await expect(row).toContainText("rev");
  await expect(row).toContainText("Added GET /health returning ok.");
});

test("stop needs a confirm click and sends x-mar", async ({ page }) => {
  const reqs: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/stop")) reqs.push(`${r.method()} ${r.headers()["x-mar"]}`); });
  await page.getByRole("button", { name: "Stop run" }).click();
  expect(reqs).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm stop" }).click();
  await expect(page.getByRole("button", { name: "Stop requested" })).toBeDisabled();
  expect(reqs).toEqual(["POST 1"]);
});

test("layout: at 1280x800 the graph fills most of the viewport and the timeline stays small", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const graph = await page.locator(".graph").boundingBox();
  const timeline = await page.locator(".timeline").boundingBox();
  expect(graph!.height).toBeGreaterThanOrEqual(800 * 0.4);
  expect(timeline!.height).toBeLessThanOrEqual(800 * 0.3);
  expect(graph!.height).toBeGreaterThan(timeline!.height);
  await page.screenshot({ path: "test-results/layout-1280.png" });
});

test("narrow width (800px): the inspector opens and the page does not scroll horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.getByTestId("node-impl").click();
  await expect(page.getByRole("tablist")).toBeVisible();
  // checked immediately (while the drawer is still sliding in) and again once it has settled
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.waitForTimeout(500);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/narrow-800.png" });
});

test("dark mode changes the page colours", async ({ browser }) => {
  const colours = async (scheme: "light" | "dark") => {
    const ctx = await browser.newContext({ colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(`${base}/?run=r1`);
    await expect(page.locator(".app")).toBeVisible();
    const c = await page.evaluate(() => { const s = getComputedStyle(document.body); return { bg: s.backgroundColor, fg: s.color }; });
    await ctx.close();
    return c;
  };
  const light = await colours("light"), dark = await colours("dark");
  expect(dark.bg).not.toBe(light.bg);
  expect(dark.bg).not.toBe(dark.fg);
});

test("an unknown run shows a terminal 'not found' state, not an endless reconnect", async ({ page }) => {
  await page.goto(`${base}/?run=does-not-exist`);
  await expect(page.getByRole("alert")).toContainText("not found");
  await expect(page.getByRole("button", { name: /stop/i })).toHaveCount(0);
});

test("a restrictive CSP is in place and the app still works under it", async ({ page }) => {
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("default-src 'self'");
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await page.reload();
  await expect(page.getByTestId("node-impl")).toBeVisible();
  expect(violations).toEqual([]);
});

test("a truncated snapshot shows the banner and marks header totals as partial", async ({ page }) => {
  const real = await (await page.request.get(`${base}/api/runs/r1`)).json();
  await page.route("**/api/runs/r1?*", (r) => r.fulfill({ json: { ...real, truncated: true } }));
  await page.route("**/api/runs/r1", (r) => r.fulfill({ json: { ...real, truncated: true } }));
  await page.goto(`${base}/?run=r1`);
  const banner = page.getByTestId("truncated-banner");
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toContainText(`Showing the latest ${real.events.length} events of a longer run`);
  await expect(page.getByTestId("total-tokens")).toHaveText("≥ 1,200");
  await expect(page.getByText("Tokens (partial)")).toBeVisible();
});

test("the page sends no referrer", async ({ page }) => {
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
});

test("the inspector drawer is wide enough to read activity (>= 520px at 1280 wide)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("node-impl").click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect.poll(async () => (await page.locator(".inspector").boundingBox())!.width).toBeGreaterThanOrEqual(520);
  // opening the drawer shrinks the graph pane; every node must still end up inside it
  await expect.poll(async () => {
    const pane = (await page.locator(".graph").boundingBox())!;
    const boxes = await Promise.all(["impl", "rev"].map((id) => page.getByTestId(`node-${id}`).boundingBox()));
    return boxes.every((b) => b !== null && b.x >= pane.x - 1 && b.x + b.width <= pane.x + pane.width + 1);
  }, { timeout: 5000 }).toBe(true);
  await page.screenshot({ path: "test-results/drawer-1280.png" });
});

test("animations run with motion enabled and leave no inline styles behind", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __motion: boolean }).__motion = false;
    new MutationObserver((muts) => {
      for (const m of muts) if (m.target instanceof HTMLElement && m.target.classList.contains("inspector") && /translate/.test(m.target.getAttribute("style") ?? "")) (window as unknown as { __motion: boolean }).__motion = true;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
  });
  await page.getByTestId("node-impl").click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __motion: boolean }).__motion)).toBe(true);
  // once finished, anime's inline transform/opacity are cleared and the drawer is fully opaque
  await expect.poll(() => page.locator(".inspector").evaluate((el) => (el as HTMLElement).style.transform + (el as HTMLElement).style.opacity)).toBe("");
  await expect(page.getByTestId("node-impl")).toBeVisible();
  await expect(page.getByTestId("total-tokens")).toHaveText("1,200"); // the count-up ends on the exact total
});

test("reduced motion: no animation styles are ever applied", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${base}/?run=r1`);
  await expect(page.getByTestId("node-impl")).toBeVisible();
  await page.getByTestId("node-impl").click();
  await expect(page.locator(".inspector")).toBeVisible();
  expect(await page.locator(".inspector").evaluate((el) => (el as HTMLElement).getAttribute("style") ?? "")).not.toMatch(/translate|opacity/);
  expect(await page.getByTestId("node-impl").evaluate((el) => (el as HTMLElement).getAttribute("style") ?? "")).not.toMatch(/scale|translate|opacity/);
  await expect(page.getByTestId("total-tokens")).toHaveText("1,200");
  await ctx.close();
});

test("Output tab shows the full report un-truncated, above the blackboard entries", async ({ page }) => {
  await page.getByTestId("node-impl").click();
  await page.getByRole("tab", { name: "Output" }).click();
  const report = page.getByTestId("report");
  const text = (await report.textContent()) ?? "";
  expect(text.length).toBeGreaterThan(1200);
  expect(text).toBe(fixture.reports[0].body);
  expect(text).toContain("END-OF-REPORT-MARKER");
  await expect(page.getByRole("heading", { name: "Report" })).toBeVisible();
  await expect(page.locator(".panel .entry").first()).toContainText("Report"); // report comes first
  await expect(page.locator(".panel")).toContainText("impl/summary");
});

test("an HTML-looking report renders as literal text", async ({ page }) => {
  await page.getByTestId("node-rev").click();
  await page.getByRole("tab", { name: "Output" }).click();
  const report = page.getByTestId("report");
  await expect(report).toHaveText(fixture.reports[1].body);
  await expect(page.locator(".panel img")).toHaveCount(0);
  await expect(page.locator(".panel b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
