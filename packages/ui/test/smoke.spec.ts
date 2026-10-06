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
  store.savePlan("r2", { tasks: [{ id: "big", role: "implementer", runtime: "codex", tier: "mid", goal: "Read a lot", dependsOn: [], needs: [], paths: [] }] });
  store.setTaskStatus("r2", "big", "running");
  store.appendEvent({ run_id: "r2", task_id: "big", agent_id: "big", type: "task_started", payload: { role: "implementer", runtime: "codex", tier: "mid" } });
  for (let i = 0; i < 60; i++) {
    store.appendEvent({ run_id: "r2", task_id: "big", agent_id: "big", type: "tool_call", payload: { name: "Read", input: { file_path: `src/f${i}.ts` } } });
    store.appendEvent({ run_id: "r2", task_id: "big", agent_id: "big", type: "tool_result", payload: { name: "Read", output: `content ${i}\nline2`, isError: false } });
  }
  // A two-phase run: the second phase builds on the first.
  store.createRun("r3", "Two phase goal", "/tmp/repo");
  const tk = (id: string, phase: number) => ({ id, role: "implementer" as const, runtime: "codex" as const, tier: "mid" as const, goal: id, dependsOn: [], needs: phase > 1 ? ["p1-api/summary"] : [], paths: [], phase });
  store.savePlan("r3", { tasks: [tk("p1-api", 1), tk("p2-ui", 2)] });
  store.setTaskStatus("r3", "p1-api", "done"); store.setTaskStatus("r3", "p2-ui", "running");
  store.appendEvent({ run_id: "r3", task_id: null, agent_id: null, type: "phase_started", payload: { phase: 1, maxPhases: 5, tasks: ["p1-api"], remaining: "wire the UI" } });
  store.appendEvent({ run_id: "r3", task_id: "p1-api", agent_id: "p1-api", type: "task_started", payload: { role: "implementer", runtime: "codex", tier: "mid" } });
  store.appendEvent({ run_id: "r3", task_id: "p1-api", agent_id: "p1-api", type: "task_finished", payload: { tokens: 10 } });
  store.appendEvent({ run_id: "r3", task_id: null, agent_id: null, type: "phase_finished", payload: { phase: 1, done: 1, failed: 0, blocked: 0, tokens: 10 } });
  store.appendEvent({ run_id: "r3", task_id: null, agent_id: null, type: "phase_started", payload: { phase: 2, maxPhases: 5, tasks: ["p2-ui"], remaining: "docs and release notes" } });
  store.appendEvent({ run_id: "r3", task_id: "p2-ui", agent_id: "p2-ui", type: "task_started", payload: { role: "implementer", runtime: "codex", tier: "mid" } });
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

test("graph shows runtime badges and reveals flow labels on hover and selection", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.run.goal);
  await expect(page.getByTestId("node-impl").locator(".rt-codex")).toHaveText("codex");
  await expect(page.getByTestId("node-rev").locator(".rt-claude")).toHaveText("claude");
  await expect(flowEdge(page)).toHaveCount(1);
  const edge = flowEdge(page);
  const label = edge.locator(".graph-edge-label");
  await page.mouse.move(1, 1);
  await expect(label).toHaveCSS("opacity", "0");
  await expect(edge.locator(".graph-edge-marker")).toHaveCSS("opacity", "1");
  await edge.locator(".graph-edge-marker").hover();
  await expect(label).toHaveCSS("opacity", "1");
  await expect(label).toContainText("impl/summary");
  await label.click();
  await page.mouse.move(1, 1);
  await expect(label).toHaveCSS("opacity", "1");
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
  await expect(page.locator(".inspector").getByRole("tabpanel")).toContainText("n/a");
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
  await page.getByRole("tab", { name: /Blackboard/ }).click();
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
  await expect(page.getByRole("tablist", { name: "Inspector sections" })).toBeVisible();
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

test("live mode: Stop is available and there is no history badge", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();
  await expect(page.getByTestId("history-badge")).toHaveCount(0);
});

test("read-only history mode: badge shown, Stop absent, no websocket", async ({ page }) => {
  await page.goto("about:blank"); // drop the live page that beforeEach opened, so only this page's sockets are counted
  await page.route("**/api/meta", (route) => route.fulfill({ json: { readOnly: true } }));
  const sockets: string[] = [];
  page.on("websocket", (w) => sockets.push(w.url()));
  await page.goto(`${base}/?run=r1`);
  await expect(page.getByTestId("history-badge")).toHaveText("History (read-only)");
  await expect(page.getByRole("button", { name: /stop/i })).toHaveCount(0);
  await expect(page.getByTestId("node-impl")).toBeVisible();
  await expect(page.getByTestId("total-tokens")).toHaveText("1,200");
  await page.waitForTimeout(500);
  expect(sockets).toEqual([]);
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

// ---- bottom dock: tabs, time axis, playhead, lanes, replay ----
type Ev = { id: number; run_id: string; task_id: string; agent_id: string; ts: number; type: string; payload: Record<string, unknown> };

// Serve r1 with its timestamps stretched over `spanMs` (ending a few seconds ago, so rev is still running up to "now"),
// optionally with extra lanes: a long-named done task, a retried task and a failed one (or `many` generated lanes).
async function mockRun(page: import("@playwright/test").Page, opts: { spanMs?: number; extra?: "rich" | number } = {}) {
  const spanMs = opts.spanMs ?? 180_000;
  const real = await (await page.request.get(`${base}/api/runs/r1`)).json();
  const a: number = real.events[0].ts, b: number = real.events.at(-1).ts;
  const t0 = Date.now() - spanMs - 3000;
  const k = (spanMs - 8000) / Math.max(1, b - a);
  const at = (ts: number) => Math.round(t0 + (ts - a) * k);
  let nid = Math.max(...real.events.map((e: Ev) => e.id)) + 1;
  const ev = (task: string, type: string, ts: number, payload: Record<string, unknown> = {}): Ev => ({ id: nid++, run_id: "r1", task_id: task, agent_id: task, ts: t0 + ts, type, payload });
  const events: Ev[] = real.events.map((e: Ev) => ({ ...e, ts: at(e.ts) }));
  const long = "investigate_sow_sprint_plan";
  if (opts.extra === "rich") {
    events.push(
      ev(long, "task_started", 10_000, { runtime: "claude", role: "researcher", tier: "high" }),
      ev(long, "blackboard_read", 14_000, { author: "impl", key: "impl/summary", version: 1, tokens: 5 }),
      ev(long, "blackboard_write", 50_000, { key: `${long}/notes` }),
      ev(long, "task_finished", 82_000),
      ev("flaky_build", "task_started", 20_000, { runtime: "codex", role: "implementer", tier: "mid" }),
      ev("flaky_build", "task_failed", 45_000),
      ev("flaky_build", "task_started", 60_000, { runtime: "codex" }),
      ev("flaky_build", "blackboard_write", 100_000, { key: "flaky_build/summary" }),
      ev("flaky_build", "task_finished", 120_000),
      ev("blocked_one", "task_started", 90_000, { runtime: "claude" }),
      ev("blocked_one", "task_failed", 95_000),
    );
  } else if (typeof opts.extra === "number") {
    for (let i = 0; i < opts.extra; i++) events.push(ev(`generated_agent_${i}`, "task_started", 5_000 + i * 3000, { runtime: i % 2 ? "codex" : "claude" }), ev(`generated_agent_${i}`, "task_finished", 40_000 + i * 3000));
  }
  const snap = { ...real, events, blackboard: real.blackboard.map((x: { ts: number }) => ({ ...x, ts: at(x.ts) })) };
  await page.route("**/api/runs/r1?*", (r) => r.fulfill({ json: snap }));
  await page.route("**/api/runs/r1", (r) => r.fulfill({ json: snap }));
  await page.goto(`${base}/?run=r1`);
  const read = events.find((e) => e.type === "blackboard_read" && e.task_id === "rev")!;
  return { t0: Math.min(...events.filter((e) => /^task_started$/.test(e.type)).map((e) => e.ts)), readTs: read.ts, spanMs };
}
const tabs = (page: import("@playwright/test").Page) => page.getByRole("tablist", { name: "Bottom panel" });
const label = (page: import("@playwright/test").Page) => page.getByTestId("playhead-label");

test("dock tabs: Timeline is the default; Blackboard (N) shows entries and readers; arrow keys, Home and End switch; the choice survives a reload", async ({ page }) => {
  const timeline = tabs(page).getByRole("tab", { name: "Timeline" }), bb = tabs(page).getByRole("tab", { name: /^Blackboard \(1\)$/ });
  await expect(timeline).toHaveAttribute("aria-selected", "true");
  await expect(timeline).toHaveAttribute("tabindex", "0");
  await expect(bb).toHaveAttribute("tabindex", "-1");
  await expect(page.locator("#dock-panel-timeline")).toHaveAttribute("role", "tabpanel");
  await bb.click();
  await expect(bb).toHaveAttribute("aria-selected", "true");
  const row = page.getByRole("region", { name: "Blackboard" }).getByRole("row", { name: /impl\/summary/ });
  await expect(row).toContainText("rev");
  await expect(row).toContainText("Added GET /health returning ok.");
  await page.reload();
  await expect(tabs(page).getByRole("tab", { name: /^Blackboard/ })).toHaveAttribute("aria-selected", "true");
  await tabs(page).getByRole("tab", { name: /^Blackboard/ }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs(page).getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).getByRole("tab", { name: "Timeline" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(tabs(page).getByRole("tab", { name: /^Blackboard/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tabs(page).getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#dock-panel-blackboard")).toBeVisible();
  await expect(page.locator(".bb-toggle")).toHaveCount(0);
});

test("dock tabs work when localStorage is unavailable", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  await page.reload();
  await tabs(page).getByRole("tab", { name: /^Blackboard/ }).click();
  await expect(page.getByRole("region", { name: "Blackboard" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/NaN|undefined/);
});

test("axis: labelled human ticks; lane labels show the FULL agent id, never an ellipsis", async ({ page }) => {
  await mockRun(page, { extra: "rich" });
  const ticks = page.getByTestId("tick");
  await expect.poll(() => ticks.count()).toBeGreaterThanOrEqual(3);
  expect(await ticks.count()).toBeLessThanOrEqual(9);
  const texts = await ticks.allTextContents();
  expect(texts[0]).toBe("0s");
  for (const t of texts) expect(t).toMatch(/^\d+(s|m( \d\ds)?|h( \d\dm)?)$/);
  const id = page.locator(".lane-id", { hasText: "investigate_sow_sprint_plan" });
  await expect(id).toHaveText("investigate_sow_sprint_plan");
  const btn = id.locator("xpath=..");
  expect(await btn.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await id.evaluate((el) => getComputedStyle(el.parentElement!).textOverflow)).not.toBe("ellipsis");
  const lane = page.locator("li.lane").filter({ has: id });
  await expect(lane.locator(".badge.rt-claude")).toHaveText("claude");
  await expect(lane.locator(".lane-status")).toContainText("done");
  // each retry is its own bar
  await expect(page.locator("li.lane").filter({ hasText: "flaky_build" }).locator(".seg")).toHaveCount(2);
  await expect(page.locator("li.lane").filter({ hasText: "flaky_build" }).locator(".mk-write")).toHaveCount(1);
});

test("scrubber, axis and lanes share one x-scale; the scrubber moves the playhead and hides later events", async ({ page }) => {
  const { t0, readTs } = await mockRun(page);
  const track = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const axis = await track(".tl-axis"), scrub = await track(".tl-scrub"), lane = await track(".lane-track");
  expect(Math.abs(axis.x - scrub.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(axis.width - scrub.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(axis.x - lane.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(axis.width - lane.width)).toBeLessThanOrEqual(1);
  await expect(flowEdge(page)).toHaveCount(1);
  await expect(page.locator(".live-pill")).toBeVisible();
  const liveX = (await page.getByTestId("playhead").boundingBox())!.x;
  await page.getByLabel("Replay").fill(String(t0 + 90_000));
  await expect(label(page)).toHaveText("+1m 30s");
  const midX = (await page.getByTestId("playhead").boundingBox())!.x;
  expect(midX).toBeLessThan(liveX - 20);
  expect(midX).toBeGreaterThan(axis.x);
  await expect(page.getByRole("status").filter({ hasText: "Replaying" })).toBeVisible();
  await expect(page.locator(".live-pill")).toHaveCount(0);
  // a later event disappears from other views, then returns on Live
  await page.getByLabel("Replay").fill(String(readTs - 1));
  await expect(flowEdge(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Live" }).click();
  await expect(flowEdge(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Live" })).toBeDisabled();
  await expect(page.locator(".live-pill")).toBeVisible();
  // keyboard: the slider steps with the arrow keys
  await page.getByLabel("Replay").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("status").filter({ hasText: "Replaying" })).toBeVisible();
  // clicking the axis sets the cutoff too
  const ax = (await page.locator(".tl-axis").boundingBox())!;
  await page.mouse.click(ax.x + ax.width * 0.25, ax.y + ax.height / 2);
  const m = /^\+(\d+)s$|^\+(\d+)m/.exec((await label(page).textContent()) ?? "");
  expect(m).not.toBeNull();
  await page.mouse.click(ax.x + ax.width * 0.5, ax.y + ax.height / 2);
  await expect(label(page)).toHaveText(/^\+1m/);
});

test("clicking a lane label opens the Inspector for that agent; Enter on a bar does too", async ({ page }) => {
  await page.locator(".lane-label").filter({ has: page.locator(".lane-id", { hasText: /^rev$/ }) }).click();
  await expect(page.getByRole("complementary", { name: "Inspector for rev" })).toBeVisible();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: /^impl, done/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector for impl" })).toBeVisible();
});

test("bar tooltip shows status and duration on focus and on hover", async ({ page }) => {
  await mockRun(page, { extra: "rich" });
  const bar = page.getByRole("button", { name: /^investigate_sow_sprint_plan, done/ });
  await bar.focus();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText("investigate_sow_sprint_plan · done · started +3s · ended +1m 15s · took 1m 12s · 1 write · 1 read");
  await expect(bar).toHaveAttribute("aria-describedby", "tl-tip");
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await page.getByRole("button", { name: /^rev, running/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("running for");
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("replay: Play advances the cutoff, Pause holds it, Live restores; playback returns to live at the end", async ({ page }) => {
  await mockRun(page);
  await page.getByLabel("Speed").selectOption("8");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Replaying" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect.poll(async () => (await label(page).textContent()) ?? "", { timeout: 4000 }).not.toBe("+0s");
  await page.getByRole("button", { name: "Pause" }).click();
  const held = await label(page).textContent();
  await page.waitForTimeout(450);
  expect(await label(page).textContent()).toBe(held);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Replaying" })).toHaveCount(0, { timeout: 8000 }); // ran to the end: back to live
  await expect(page.locator(".live-pill")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await page.getByRole("button", { name: "Play" }).click();
  await page.getByRole("button", { name: "Live" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Replaying" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});

test("shimmer animates running bars with motion enabled and leaves no inline styles under reduced motion", async ({ page, browser }) => {
  await mockRun(page);
  await expect.poll(() => page.locator(".shimmer").first().evaluate((el) => (el as HTMLElement).style.transform)).toMatch(/translate/);
  await expect(page.locator(".seg-done .shimmer")).toHaveCount(0);
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const rp = await ctx.newPage();
  const real = await (await rp.request.get(`${base}/api/runs/r1`)).json();
  await rp.route("**/api/runs/r1?*", (r) => r.fulfill({ json: real }));
  await rp.route("**/api/runs/r1", (r) => r.fulfill({ json: real }));
  await rp.goto(`${base}/?run=r1`);
  await expect(rp.getByRole("button", { name: /^rev, running/ })).toBeVisible();
  await rp.waitForTimeout(400);
  for (const st of await rp.locator(".shimmer").evaluateAll((els) => els.map((e) => e.getAttribute("style") ?? ""))) expect(st).toBe("");
  // replay still works under reduced motion
  await rp.getByRole("button", { name: "Play" }).click();
  await expect(rp.getByRole("status").filter({ hasText: "Replaying" })).toBeVisible();
  await ctx.close();
});

test("800px wide: the dock is usable and the page does not scroll horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await mockRun(page, { extra: "rich" });
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  expect((await page.getByLabel("Replay").boundingBox())!.width).toBeGreaterThan(200);
  expect(await page.getByTestId("tick").count()).toBeGreaterThanOrEqual(2);
  await page.getByLabel("Replay").fill(String(Date.now() - 100_000));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect((await page.locator(".dock").boundingBox())!.height).toBeLessThanOrEqual(700 * 0.3 + 1);
  await page.screenshot({ path: "test-results/timeline-800.png" });
});

test("dock stays within 30% of the viewport with many lanes, scrolls inside, and keeps the axis visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockRun(page, { extra: 14 });
  const dock = (await page.locator(".dock").boundingBox())!;
  expect(dock.height).toBeLessThanOrEqual(800 * 0.3 + 1);
  expect((await page.locator(".graph").boundingBox())!.height).toBeGreaterThanOrEqual(800 * 0.4);
  const tl = page.locator(".timeline");
  expect(await tl.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await tl.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const ax = (await page.locator(".tl-axis").boundingBox())!;
  expect(ax.y).toBeGreaterThanOrEqual(dock.y);
  expect(ax.y + ax.height).toBeLessThanOrEqual(dock.y + dock.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`screenshot: timeline with a mid-run playhead (${scheme})`, async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const { t0 } = await mockRun(page, { extra: "rich" });
    await page.getByLabel("Replay").fill(String(t0 + 75_000));
    await expect(label(page)).toHaveText("+1m 15s");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(2, 2);
    await page.screenshot({ path: scheme === "light" ? "test-results/timeline-1280.png" : "test-results/timeline-dark.png" });
    await ctx.close();
  });
}

test("two-phase run: P<n> badges on nodes and Phase 2/5 with the remaining text in the header", async ({ page }) => {
  await page.goto(`${base}/?run=r3`);
  await expect(page.getByTestId("phase-indicator")).toContainText("Phase 2/5");
  await expect(page.getByTestId("phase-remaining")).toHaveText("docs and release notes");
  await expect(page.getByTestId("node-p1-api").getByTestId("phase-p1-api")).toHaveText("P1");
  await expect(page.getByTestId("node-p2-ui").getByTestId("phase-p2-ui")).toHaveText("P2");
  // single-phase runs show neither badge nor indicator
  await page.goto(`${base}/?run=r1`);
  await expect(page.getByTestId("node-impl")).toBeVisible();
  await expect(page.getByTestId("phase-indicator")).toHaveCount(0);
  await expect(page.locator(".phase-tag")).toHaveCount(0);
});


test("workspace repos and sibling warnings appear in task views", async ({ page }) => {
  await page.goto(`${base}/?run=r1`);
  const repos = page.getByLabel("Workspace repositories");
  await expect(repos).toContainText("api");
  await expect(repos).toContainText("web");
  await expect(page.getByTestId("node-impl").locator(".repo-badge")).toHaveText("api");
  await expect(page.getByTestId("node-rev").locator(".repo-badge")).toHaveText("All repos");
  await page.getByTestId("node-impl").click();
  const inspector = page.getByLabel("Inspector for impl", { exact: true });
  await expect(inspector.locator(".repo-badge")).toHaveText("api");
  const warnings = inspector.getByLabel("Sibling repository warnings");
  await expect(warnings).toContainText("Sibling modified: web (2 files)");
  await warnings.locator("summary").click();
  await expect(warnings).toContainText("src/client.ts");
  await expect(warnings).toContainText("1 more file not listed.");
});


<<<<<<< HEAD
test("graph controls filter tasks, recover from empty results, and toggle the minimap", async ({ page }) => {
  const controls = page.getByLabel("Graph controls");
  await controls.getByLabel("Running / failed").check();
  await expect(page.getByTestId("node-impl")).toHaveCount(0);
  await expect(page.getByTestId("node-rev")).toBeVisible();
  await controls.getByLabel("Repo", { exact: true }).selectOption({ label: "api" });
  await expect(page.getByText("No tasks match these filters.")).toBeVisible();
  await controls.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.getByTestId("node-impl")).toBeVisible();
  await controls.getByRole("button", { name: "Minimap" }).click();
  await expect(page.locator(".react-flow__minimap")).toBeVisible();
  await controls.getByRole("button", { name: "Minimap" }).click();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.goto(`${base}/?run=r3`);
  await controls.getByLabel("Phase", { exact: true }).selectOption("2");
  await expect(page.getByTestId("node-p1-api")).toHaveCount(0);
  await expect(page.getByTestId("node-p2-ui")).toBeVisible();
});

test("graph cards keep completed durations fixed while running elapsed time advances", async ({ page }) => {
  const completed = page.getByTestId("node-impl").locator(".agent-duration");
  const running = page.getByTestId("node-rev").locator(".agent-duration");
  await expect(completed).toContainText("Duration:");
  await expect(running).toContainText("Elapsed:");
  const fixed = await completed.textContent();
  const initial = await running.textContent();
  await expect.poll(() => running.textContent(), { timeout: 3000 }).not.toBe(initial);
  await expect(completed).toHaveText(fixed!);
=======
test("goal expands and phase remaining work opens dismissible history", async ({ page }) => {
  await page.goto("/?run=r3");
  const goal = page.getByRole("heading", { level: 1 }).getByRole("button");
  await expect(goal).toHaveAttribute("aria-expanded", "false");
  await goal.click();
  await expect(goal).toHaveAttribute("aria-expanded", "true");
  const remaining = page.getByTestId("phase-remaining");
  await remaining.click();
  const popover = page.getByRole("region", { name: "Remaining work and phase history" });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("wire the UI");
  await expect(popover).toContainText("docs and release notes");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(remaining).toBeFocused();
  await remaining.click();
  await goal.click();
  await expect(popover).toHaveCount(0);
>>>>>>> local/mar/rmuwcqki6/p1-header
});
