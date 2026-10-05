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
  // A separate run with a long feed (60 finished Reads) for the follow-latest test.
  store.createRun("r2", "Long feed", "/tmp/repo");
  store.savePlan("r2", { tasks: [{ id: "big", role: "implementer", runtime: "codex", tier: "mid", goal: "Read a lot", dependsOn: [], needs: [] }] });
  store.setTaskStatus("r2", "big", "running");
  store.appendEvent({ run_id: "r2", task_id: "big", agent_id: "big", type: "task_started", payload: { role: "implementer", runtime: "codex", tier: "mid" } });
  for (let i = 0; i < 60; i++) {
    store.appendEvent({ run_id: "r2", task_id: "big", agent_id: "big", type: "tool_call", payload: { name: "Read", input: { file_path: `src/f${i}.ts` } } });
    store.appendEvent({ run_id: "r2", task_id: "big", agent_id: "big", type: "tool_result", payload: { name: "Read", output: `content ${i}\nline2`, isError: false } });
  }
  srv = await startServer(store, { port: 0, staticDir: dist });
  base = `http://127.0.0.1:${srv.port}`;
});
test.afterAll(async () => { await srv.close(); });

const flowEdge = (page: import("@playwright/test").Page) => page.locator(".react-flow__edge.animated");

test.beforeEach(async ({ page }) => { await page.goto(`${base}/?run=r1`); });

const openActivity = async (page: import("@playwright/test").Page, node = "impl") => {
  await page.getByTestId(`node-${node}`).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.locator(".feed-list")).toBeVisible();
};
const stepRow = (page: import("@playwright/test").Page, text: string | RegExp) => page.locator("li.step.tool").filter({ hasText: text });

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
  await expect(page.locator(".say-text")).toHaveText('<img src=x onerror="window.__pwned=1">');
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

test("activity: a collapsed Read row shows the repo-relative path and line range, not raw JSON or the worktree prefix", async ({ page }) => {
  await openActivity(page);
  const row = stepRow(page, "src/a.py (lines 20–109)");
  await expect(row).toHaveCount(1);
  const summary = row.locator("summary");
  await expect(summary).not.toContainText(".mar/worktrees");
  await expect(summary).not.toContainText("file_path");
  await expect(summary).toContainText("Read");
  await expect(summary).toContainText("24 lines");
  await expect(row.locator("details")).not.toHaveAttribute("open", "");
});

test("activity: expanding a row reveals the full output and the input JSON", async ({ page }) => {
  await openActivity(page);
  const row = stepRow(page, "src/a.py (lines 20–109)");
  await row.locator("summary").click();
  const out = (await row.locator("pre.out").textContent()) ?? "";
  expect(out.length).toBeGreaterThan(1700);
  expect(out).toContain("field_23");
  await expect(row.locator("pre.io").first()).toContainText('"offset": 20');
  await expect(row.locator("pre.io").first()).toContainText('"file_path"');
  await page.getByRole("button", { name: "Copy" }).first().click();
  await expect(row.locator(".copied")).toHaveText(/Copied|Copy unavailable/);
});

test("activity: Errors chip shows only the failing step; counts are right; errors start expanded", async ({ page }) => {
  await openActivity(page);
  const chip = (n: string) => page.getByRole("button", { name: new RegExp(`^${n}`) });
  await expect(chip("All")).toContainText("7");
  await expect(chip("Messages")).toContainText("1");
  await expect(chip("Tools")).toContainText("6");
  await expect(chip("Errors")).toContainText("1");
  await expect(stepRow(page, "tests/test_a.py").locator("details")).toHaveAttribute("open", "");
  await chip("Errors").click();
  await expect(chip("Errors")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".feed-list > li")).toHaveCount(1);
  await expect(page.locator(".feed-list > li")).toContainText("pytest -q tests/test_a.py");
  await expect(page.locator(".feed-list > li")).toContainText("FAILED tests/test_a.py::test_x");
});

test("activity: Messages chip shows only the say row", async ({ page }) => {
  await openActivity(page);
  await page.getByRole("button", { name: /^Messages/ }).click();
  await expect(page.locator(".feed-list > li")).toHaveCount(1);
  await expect(page.locator("li.step.say")).toContainText("Reading the schema before editing.");
  await page.getByRole("button", { name: /^Tools/ }).click();
  await expect(page.locator("li.step.say")).toHaveCount(0);
  await expect(page.locator("li.step.tool")).toHaveCount(6);
});

test("activity: HTML-looking tool output renders as literal text and never executes", async ({ page }) => {
  await openActivity(page);
  const row = stepRow(page, "src/c.py");
  await row.locator("summary").click();
  await expect(row.locator("pre.out")).toHaveText('<img src=x onerror="window.__pwned=1">');
  await expect(page.locator('.feed img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("activity: parallel Reads pair in order and a call with no result shows the running indicator", async ({ page }) => {
  await openActivity(page);
  const b = stepRow(page, "src/b.py"), c = stepRow(page, "src/c.py");
  await b.locator("summary").click(); await c.locator("summary").click();
  await expect(b.locator("pre.out")).toHaveText("b-content");
  await expect(c.locator("pre.out")).toContainText("<img");
  const pending = stepRow(page, "sleep 600");
  await expect(pending).toHaveAttribute("data-state", "running");
  await expect(pending.getByRole("img", { name: "running" })).toBeVisible();
  await expect(stepRow(page, "missing_symbol")).toContainText("no matches");
});

test("activity: reduced motion applies no animation inline styles to rows", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${base}/?run=r1`);
  await openActivity(page);
  const styles = await page.locator(".feed-list > li").evaluateAll((els) => els.map((e) => e.getAttribute("style") ?? ""));
  expect(styles.length).toBeGreaterThan(0);
  for (const st of styles) expect(st).not.toMatch(/translate|opacity/);
  expect(await page.locator(".dot-run").first().evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  await ctx.close();
});

test("activity: scrolling up stops following and shows a jump button that returns to the bottom", async ({ page }) => {
  await page.goto(`${base}/?run=r2`);
  await openActivity(page, "big");
  const list = page.locator(".feed-list");
  const gap = () => list.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight);
  await expect.poll(gap).toBeLessThanOrEqual(24);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await list.evaluate((e) => { e.scrollTop = 0; });
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();
  expect(await gap()).toBeGreaterThan(200);
  await jump.click();
  await expect.poll(gap).toBeLessThanOrEqual(24);
  await expect(jump).toHaveCount(0);
});

test("activity: screenshot of the expanded feed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openActivity(page);
  await stepRow(page, "src/a.py (lines 20–109)").locator("summary").click();
  await page.locator("li.step.say").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/activity-1280.png" });
});
