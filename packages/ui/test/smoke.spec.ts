import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "../../server/src/server.js";
import { Store } from "../../server/src/store.js";
import { failedRun, workspaceRun } from "./fixtures/board.js";
import { serveFixture } from "./fixtures/serve.js";

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

// The Board is the default tab now; most of the older tests below exercise the graph, so they start on it (a saved choice wins).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { if (!localStorage.getItem("mar.main.tab")) localStorage.setItem("mar.main.tab", "graph"); } catch { /* storage blocked */ } });
  await page.goto(`${base}/?run=r1`);
});
type Pg = import("@playwright/test").Page;
// Start from the default tab (no saved choice) on the first load only, so a reload can still prove persistence.
const freshTabs = (page: Pg) => page.addInitScript(() => { try { if (!sessionStorage.getItem("fresh")) { sessionStorage.setItem("fresh", "1"); localStorage.removeItem("mar.main.tab"); } } catch { /* storage blocked */ } });
const openTab = (page: Pg, name: string | RegExp) => page.getByRole("tab", typeof name === "string" ? { name, exact: true } : { name }).click();

const openActivity = async (page: import("@playwright/test").Page, node = "impl") => {
  await openTab(page, "Board");
  await page.getByTestId(`row-${node}`).getByRole("button").click();
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
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true"); // a running task opens on Activity
  await page.getByRole("tab", { name: "Context" }).click();
  const row = page.getByRole("row", { name: /impl\/summary/ });
  await expect(row).toContainText("v1");
  await expect(row).toContainText("42");
  await expect(page.locator("pre.prompt")).toContainText("Review the change.");
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page.locator(".inspector").getByRole("tabpanel")).toContainText("Usage is reported when the task finishes.");
  await expect(page.locator(".inspector").getByRole("tabpanel")).not.toContainText("n/a");
});

test("keyboard: arrow keys switch inspector tabs", async ({ page }) => {
  await page.getByTestId("node-rev").getByRole("button").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("tab", { name: "Context" }).click();
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
  await openTab(page, "Timeline");
  await page.getByLabel("Replay").fill(String(read.ts - 1));
  await expect(page.getByRole("status").filter({ hasText: "Replaying" })).toBeVisible();
  await openTab(page, "Graph"); // the replay position is shared by every tab
  await expect(flowEdge(page)).toHaveCount(0);
  await openTab(page, "Timeline");
  await page.getByRole("button", { name: "Live" }).click();
  await openTab(page, "Graph");
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

test("layout: at 1280x800 the active tab fills the space under the header and the page does not scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const name of ["Board", "Graph", "Timeline"]) {
    await openTab(page, name);
    const body = await page.locator(".tab-body").boundingBox();
    expect(body!.height).toBeGreaterThanOrEqual(800 * 0.6);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
  }
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
  await expect(page.getByRole("group", { name: "Run status" })).toHaveAttribute("title", /partial/);
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
  await openTab(page, "Graph");
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
  const chip = (n: string) => page.locator(".inspector").getByRole("button", { name: new RegExp(`^${n}`) }); // the board has its own All chip
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

// ---- timeline tab: time axis, playhead, lanes, replay ----
type Ev = { id: number; run_id: string; task_id: string; agent_id: string; ts: number; type: string; payload: Record<string, unknown> };

// Serve r1 with its timestamps stretched over `spanMs` (ending a few seconds ago, so rev is still running up to "now"),
// optionally with extra lanes: a long-named done task, a retried task and a failed one (or `many` generated lanes).
async function mockRun(page: import("@playwright/test").Page, opts: { spanMs?: number; extra?: "rich" | number; tab?: string } = {}) {
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
  await openTab(page, opts.tab ?? "Timeline");
  const read = events.find((e) => e.type === "blackboard_read" && e.task_id === "rev")!;
  return { t0: Math.min(...events.filter((e) => /^task_started$/.test(e.type)).map((e) => e.ts)), readTs: read.ts, spanMs };
}
const label = (page: import("@playwright/test").Page) => page.getByTestId("playhead-label");

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
  await openTab(page, "Graph");
  await expect(flowEdge(page)).toHaveCount(0);
  await openTab(page, "Timeline");
  await page.getByRole("button", { name: "Live" }).click();
  await openTab(page, "Graph");
  await expect(flowEdge(page)).toHaveCount(1);
  await openTab(page, "Timeline");
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
  await openTab(page, "Timeline");
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
  // The start offset depends on how far apart the store stamped the first fixture events (machine timing), so only the duration is exact.
  await expect(tip).toHaveText(/^investigate_sow_sprint_plan · done · started \+\d+s · ended \+1m \d+s · took 1m 12s · 1 write · 1 read$/);
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
  await rp.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(rp.getByRole("button", { name: /^rev, running/ })).toBeVisible();
  await rp.waitForTimeout(400);
  for (const st of await rp.locator(".shimmer").evaluateAll((els) => els.map((e) => e.getAttribute("style") ?? ""))) expect(st).toBe("");
  // replay still works under reduced motion
  await rp.getByRole("button", { name: "Play" }).click();
  await expect(rp.getByRole("status").filter({ hasText: "Replaying" })).toBeVisible();
  await ctx.close();
});

test("800px wide: the timeline is usable and the page does not scroll horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await mockRun(page, { extra: "rich" });
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  expect((await page.getByLabel("Replay").boundingBox())!.width).toBeGreaterThan(200);
  expect(await page.getByTestId("tick").count()).toBeGreaterThanOrEqual(2);
  await page.getByLabel("Replay").fill(String(Date.now() - 100_000));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/timeline-800.png" });
});

test("timeline with many lanes scrolls inside its tab and keeps the axis visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockRun(page, { extra: 14 });
  const body = (await page.locator(".tab-body").boundingBox())!;
  const tl = page.locator(".timeline");
  expect(await tl.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await tl.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const ax = (await page.locator(".tl-axis").boundingBox())!;
  expect(ax.y).toBeGreaterThanOrEqual(body.y);
  expect(ax.y + ax.height).toBeLessThanOrEqual(body.y + body.height + 1);
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

test("graph options menu filters tasks, recovers from empty results, and toggles the minimap (off by default)", async ({ page }) => {
  const controls = page.getByLabel("Graph controls");
  await expect(controls).toHaveCount(0);
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.getByRole("button", { name: "Graph options" }).click();
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
  await page.getByRole("button", { name: "Graph options" }).click();
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
});

test("goal expands and phase remaining work opens dismissible history", async ({ page }) => {
  await page.goto(`${base}/?run=r3`);
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
});

// ---- task board, problems strip, tabs, answer, details (fixtures replicating real runs; served through page.route) ----
const gotoWorkspace = async (page: Pg) => { await serveFixture(page, base, workspaceRun(Date.now())); await openTab(page, "Board"); await expect(page.getByTestId("row-p2-ws-fix")).toBeVisible(); };
const gotoFailed = async (page: Pg) => { await serveFixture(page, base, failedRun(Date.now())); await openTab(page, "Board"); await expect(page.getByTestId("row-p1-ui")).toBeVisible(); };
const rowIds = (page: Pg) => page.locator(".board-item").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid!.replace("row-", "")));
const overflowX = (page: Pg) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("board: the default tab has one row per task with what each is doing now", async ({ page }) => {
  await freshTabs(page);
  await serveFixture(page, base, workspaceRun(Date.now()));
  await expect(page.getByRole("tab", { name: "Board", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".board-item")).toHaveCount(6);
  const now = (id: string) => page.getByTestId(`row-${id}`).locator(".c-now");
  await expect(now("p2-ws-fix")).toHaveText("Read src/app.js (lines 1–80)");
  await expect(now("p2-ws-docs")).toHaveText("Bash: node --test");
  await expect(now("p1-route53")).toHaveText("Added GET /v2/routes backed by a Route53 client wrapper.");
  await expect(page.getByTestId("row-p2-ws-fix").locator(".c-tok")).toHaveText("reported when done");
  await expect(page.getByTestId("row-p1-route53").locator(".c-tok")).toHaveText("21,500");
  await expect(page.getByTestId("row-p1-validate").locator(".repo-badge")).toHaveText("All repos");
  await expect(page.getByTestId("row-p1-fe").locator(".repo-badge")).toHaveText("r101-frontend");
  await expect(page.getByTestId("row-p1-review").locator(".rt-claude")).toHaveText("claude");
  await expect(page.locator("body")).not.toContainText(/NaN|undefined/);
  // long text is clipped with the full text in the title
  await expect(now("p1-review")).toHaveAttribute("title", /^Two findings: the handler swallows Route53 errors/);
});

test("board: failed and blocked rows say why; phases are grouped with a summary and collapse", async ({ page }) => {
  await gotoFailed(page);
  await expect(page.getByTestId("row-p1-queue").locator(".c-now")).toHaveText("Timed out");
  await expect(page.getByTestId("row-p1-ui").locator(".c-now")).toContainText("Dependency merge conflict");
  await expect(page.getByTestId("row-p2-docs").locator(".c-now")).toHaveText("waiting on p1-queue, p1-ui");
  const phase1 = page.getByRole("button", { name: /^Phase 1/ });
  await expect(phase1).toContainText("· 2 failed · 2 done");
  await expect(phase1).toHaveAttribute("aria-expanded", "true");
  await phase1.click();
  await expect(page.getByTestId("row-p1-queue")).toHaveCount(0);
  await expect(page.getByTestId("row-p2-docs")).toBeVisible();
  await expect(phase1).toHaveAttribute("aria-expanded", "false");
});

test("board: rows sort running, failed, blocked, pending, done within a phase", async ({ page }) => {
  await gotoWorkspace(page);
  expect(await rowIds(page)).toEqual(["p1-route53", "p1-fe", "p1-validate", "p1-review", "p2-ws-fix", "p2-ws-docs"]);
  await gotoFailed(page);
  expect(await rowIds(page)).toEqual(["p1-queue", "p1-ui", "p1-schema", "p1-api", "p2-docs"]); // failed first, then done by start time
});

test("board: status chips with counts and the search box filter the rows", async ({ page }) => {
  await gotoWorkspace(page);
  const chip = (n: string) => page.getByRole("button", { name: new RegExp(`^${n}\\b`) });
  await expect(chip("All")).toContainText("6");
  await expect(chip("Running")).toContainText("2");
  await expect(chip("Failed")).toContainText("0");
  await expect(chip("Done")).toContainText("4");
  await chip("Running").click();
  await expect(chip("Running")).toHaveAttribute("aria-pressed", "true");
  expect(await rowIds(page)).toEqual(["p2-ws-fix", "p2-ws-docs"]);
  await chip("All").click();
  await page.getByPlaceholder("filter tasks…").fill("frontend");
  expect(await rowIds(page)).toEqual(["p1-fe"]);
  await page.getByPlaceholder("filter tasks…").fill("nothing-matches");
  await expect(page.getByText("No tasks match.")).toBeVisible();
  await page.getByPlaceholder("filter tasks…").fill("");
  await chip("Done").click();
  await expect(page.locator(".board-item")).toHaveCount(4);
});

test("board: rows are keyboard-focusable buttons; Enter selects and the row is highlighted", async ({ page }) => {
  await gotoWorkspace(page);
  const row = page.getByTestId("row-p1-fe").getByRole("button");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector for p1-fe" })).toBeVisible();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("row-p1-route53").getByRole("button")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("j"); // J/K follow the board order
  await expect(page.getByRole("complementary", { name: "Inspector for p1-validate" })).toBeVisible();
});

test("board: the elapsed time of a running task ticks and a done task stays fixed", async ({ page }) => {
  await gotoWorkspace(page);
  const running = page.getByTestId("row-p2-ws-fix").locator(".c-time");
  const done = page.getByTestId("row-p1-fe").locator(".c-time");
  const before = await running.textContent(), fixed = await done.textContent();
  await expect.poll(() => running.textContent(), { timeout: 4000 }).not.toBe(before);
  await expect(done).toHaveText(fixed!);
});

test("header: one-line status summary, repo badges collapse into a popover, goal clamps with the full text in the title", async ({ page }) => {
  await gotoWorkspace(page);
  const status = page.getByRole("group", { name: "Run status" });
  await expect(status).toContainText("Phase 2/5");
  await expect(status).toContainText("4 of 6 done");
  await expect(status).toContainText("2 running");
  await expect(status).toContainText("$0.14");
  await expect(status).toContainText(/~\d+ min left|finishing up/);
  await expect(page.getByTestId("phase-remaining")).toHaveText("Update r101-scheduler to call the new endpoint and add release notes");
  const goal = page.getByRole("heading", { level: 1 }).getByRole("button");
  await expect(goal).toHaveAttribute("title", /^Add a \/v2\/routes endpoint/);
  await expect(page.getByLabel("Workspace repositories").locator(".repo-badge")).toHaveCount(0); // five repos: one button
  await page.getByRole("button", { name: "5 repos" }).click();
  await expect(page.getByRole("region", { name: "Workspace repositories list" })).toContainText("r101-ws-bc");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Workspace repositories list" })).toHaveCount(0);
  await expect(page.getByTestId("history-badge")).toHaveCount(0);
});

test("header: a finished failed run says Failed instead of an ETA; budget shows as a thin bar only with a known limit", async ({ page }) => {
  await gotoFailed(page);
  await expect(page.getByRole("group", { name: "Run status" })).toContainText("2 failed 1 blocked");
  await expect(page.getByRole("group", { name: "Run status" })).toContainText("Failed");
  await expect(page.getByRole("group", { name: "Run status" })).not.toContainText("left");
  await expect(page.locator("progress.budget-bar")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/NaN|undefined/);
});

test("problems strip: lists failed and blocked tasks with reasons and conflicting files; Open selects the task", async ({ page }) => {
  await gotoFailed(page);
  const strip = page.getByRole("region", { name: "Problems" });
  await expect(strip).toContainText("3 errors");
  await expect(strip.getByTestId("problem-task:p1-queue")).toContainText("Timed out");
  const conflict = strip.getByTestId("problem-task:p1-ui");
  await expect(conflict).toContainText("Merge conflict merging dependency p1-schema");
  await expect(conflict.locator("code").first()).toHaveText("packages/ui/test/smoke.spec.ts");
  await expect(strip.getByTestId("problem-task:p2-docs")).toContainText("Dependency failed");
  expect((await strip.boundingBox())!.height).toBeLessThanOrEqual(800 * 0.25 + 1);
  await conflict.getByRole("button", { name: "Open p1-ui" }).click();
  await expect(page.getByRole("complementary", { name: "Inspector for p1-ui" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Problems" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: /Problems/ }).click();
  await expect(strip.getByTestId("problem-task:p1-queue")).toHaveCount(0);
});

test("problems strip is absent for a healthy run", async ({ page }) => {
  await gotoWorkspace(page);
  await expect(page.getByRole("region", { name: "Problems" })).toHaveCount(0);
});

test("details: the default tab follows the task status and the failure reason is shown first; the chosen tab is remembered per task", async ({ page }) => {
  await gotoWorkspace(page);
  const tab = (n: string) => page.getByRole("tab", { name: n });
  await page.getByTestId("row-p2-ws-fix").getByRole("button").click();
  await expect(tab("Activity")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("row-p1-fe").getByRole("button").click();
  await expect(tab("Output")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".inspector").getByRole("tabpanel")).toContainText("p1-fe/summary");
  await tab("Usage").click();
  await page.getByTestId("row-p2-ws-fix").getByRole("button").click();
  await page.getByTestId("row-p1-fe").getByRole("button").click();
  await expect(tab("Usage")).toHaveAttribute("aria-selected", "true"); // remembered for this task
  await gotoFailed(page);
  await page.getByTestId("row-p1-queue").getByRole("button").click();
  await expect(tab("Context")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("failure-reason")).toContainText("Timed out");
  await page.getByTestId("row-p1-ui").getByRole("button").click();
  await expect(page.getByTestId("failure-reason")).toContainText("smoke.spec.ts");
});

test("main tabs: ARIA roles, arrow keys, Home/End and a saved choice that survives a reload", async ({ page }) => {
  await freshTabs(page);
  await page.goto(`${base}/?run=r1`);
  const list = page.getByRole("tablist", { name: "Run views" });
  await expect(list.getByRole("tab")).toHaveText(["Board", "Answer", "Graph", "Timeline", "Blackboard (1)"]);
  const board = list.getByRole("tab", { name: "Board", exact: true });
  await expect(board).toHaveAttribute("aria-selected", "true");
  await expect(board).toHaveAttribute("tabindex", "0");
  await expect(list.getByRole("tab", { name: "Graph" })).toHaveAttribute("tabindex", "-1");
  await expect(page.locator("#main-panel-board")).toHaveAttribute("role", "tabpanel");
  await expect(page.locator("#main-panel-board")).toHaveAttribute("aria-labelledby", "main-tab-board");
  await board.focus();
  await page.keyboard.press("ArrowRight");
  await expect(list.getByRole("tab", { name: "Answer" })).toBeFocused();
  await expect(list.getByRole("tab", { name: "Answer" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); // wraps to the last tab
  await expect(list.getByRole("tab", { name: /^Blackboard/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(board).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("#main-panel-blackboard")).toBeVisible();
  await page.reload();
  await expect(list.getByRole("tab", { name: /^Blackboard/ })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => localStorage.getItem("mar.main.tab"))).toBe("blackboard");
});

test("main tabs work when localStorage is unavailable", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  await page.goto(`${base}/?run=r1`);
  await expect(page.getByRole("tab", { name: "Board", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /^Blackboard/ }).click();
  await expect(page.getByRole("region", { name: "Blackboard" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/NaN|undefined/);
  await ctx.close();
});

test("answer tab: only when reports exist; the final task's report is shown as literal text with a copy button", async ({ page }) => {
  await freshTabs(page);
  await page.goto(`${base}/?run=r3`); // no reports
  await expect(page.getByRole("tab", { name: "Answer" })).toHaveCount(0);
  await page.goto(`${base}/?run=r1`);
  await openTab(page, "Answer");
  await expect(page.getByRole("heading", { name: "rev", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "impl", exact: true })).toHaveCount(0); // impl is not a final task
  await expect(page.getByTestId("answer-rev")).toHaveText(fixture.reports[1].body); // an HTML-looking report renders literally
  await expect(page.locator(".answer img")).toHaveCount(0);
  await expect(page.locator(".answer b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.locator(".copied")).toHaveText(/Copied|Copy unavailable/);
});

test("answer tab: a finished run with an answer shows a dismissible 'Answer ready' notice that opens the tab", async ({ page }) => {
  await freshTabs(page);
  const fx = failedRun(Date.now());
  fx.snap.tasks = fx.snap.tasks.map((t) => ({ ...t, status: "done", detail: null }));
  fx.snap.events = fx.snap.events.filter((e) => e.type !== "dependency_merge_conflict").map((e) => (e.type === "phase_started" ? { ...e, payload: { ...e.payload, remaining: "" } } : e));
  await serveFixture(page, base, fx);
  const notice = page.getByTestId("answer-ready");
  await expect(notice).toContainText("Answer ready");
  await expect(page.getByRole("region", { name: "Problems" })).toHaveCount(0);
  await notice.getByRole("button", { name: "Open answer" }).click();
  await expect(page.getByRole("tab", { name: "Answer" })).toHaveAttribute("aria-selected", "true");
  await expect(notice).toHaveCount(0);
  await openTab(page, "Board");
  await expect(notice).toHaveCount(0); // opening it counts as seen
  await page.evaluate(() => localStorage.setItem("mar.main.tab", "board"));
  await page.reload();
  await expect(page.getByTestId("answer-ready")).toBeVisible();
  await page.getByTestId("answer-ready").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("answer-ready")).toHaveCount(0);
});

test("graph tab: 6 tasks across a 5-repo workspace stay readable at 1280x800 and no swimlane is empty", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoWorkspace(page);
  await openTab(page, "Graph");
  const ids = ["p1-route53", "p1-validate", "p1-fe", "p1-review", "p2-ws-fix", "p2-ws-docs"];
  await expect(page.getByTestId("node-p2-ws-docs")).toBeVisible();
  await page.waitForTimeout(500); // the fit settles
  const boxes = await Promise.all(ids.map((id) => page.getByTestId(`node-${id}`).boundingBox()));
  for (const b of boxes) expect(b!.width).toBeGreaterThanOrEqual(120);
  const lanes = page.locator('[data-testid^="band-repo-"]');
  const laneBoxes = await lanes.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  expect(laneBoxes).toHaveLength(3); // webservices, frontend and the cross-repo lane: never one per workspace repo
  for (const lane of laneBoxes) {
    expect(boxes.some((b) => b!.x >= lane.x - 1 && b!.y >= lane.y - 1 && b!.x + b!.width <= lane.x + lane.w + 1 && b!.y + b!.height <= lane.y + lane.h + 1)).toBe(true);
  }
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.screenshot({ path: "test-results/graph-workspace-1280.png" });
});

test("800px wide: the board has no horizontal overflow, with and without the details panel", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await gotoWorkspace(page);
  expect(await overflowX(page)).toBeLessThanOrEqual(1);
  expect(await page.locator(".board").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByTestId("row-p2-ws-fix").getByRole("button").click();
  await expect(page.getByRole("complementary", { name: "Inspector for p2-ws-fix" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await overflowX(page)).toBeLessThanOrEqual(1);
  await gotoFailed(page);
  expect(await overflowX(page)).toBeLessThanOrEqual(1);
  expect(await page.locator(".problems").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("board in dark mode uses the dark palette and keeps text readable", async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await gotoWorkspace(page);
  const colours = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor, row = getComputedStyle(document.querySelector(".board-item")!).backgroundColor, ink = getComputedStyle(document.querySelector(".c-id")!).color;
    return { bg, row, ink };
  });
  expect(colours.bg).not.toBe("rgb(246, 245, 241)");
  expect(colours.row).not.toBe("rgb(255, 255, 255)");
  expect(colours.ink).not.toBe(colours.row);
  await ctx.close();
});

test("reduced motion: board rows and the details panel get no animation inline styles", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await gotoWorkspace(page);
  await page.getByTestId("row-p2-ws-fix").getByRole("button").click();
  await expect(page.locator(".inspector")).toBeVisible();
  const styles = await page.locator(".board-item").evaluateAll((els) => els.map((e) => e.getAttribute("style") ?? ""));
  expect(styles).toHaveLength(6);
  for (const st of styles) expect(st).toBe("");
  expect(await page.locator(".inspector").evaluate((el) => el.getAttribute("style") ?? "")).not.toMatch(/translate|opacity/);
  expect(await page.locator(".dot-run").first().evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  await ctx.close();
});

test("untrusted event text on the board is rendered as text only", async ({ page }) => {
  const fx = workspaceRun(Date.now());
  fx.snap.events.push({ id: 9999, run_id: "ws1", task_id: "p2-ws-fix", agent_id: "p2-ws-fix", ts: Date.now() - 1000, type: "assistant_text", payload: { text: '<img src=x onerror="window.__pwned=1">' } });
  await serveFixture(page, base, fx);
  await openTab(page, "Board");
  await expect(page.getByTestId("row-p2-ws-fix").locator(".c-now")).toHaveText('<img src=x onerror="window.__pwned=1">');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
