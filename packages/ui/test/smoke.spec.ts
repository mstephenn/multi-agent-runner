import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "../../server/src/server.js";
import { Store } from "../../server/src/store.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/run.json", import.meta.url)), "utf8"));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let srv: Awaited<ReturnType<typeof startServer>>;
let base = "";

test.beforeAll(async () => {
  const store = new Store(":memory:");
  const id: string = fixture.run.id;
  store.createRun(id, fixture.run.goal, fixture.run.repo);
  store.savePlan(id, fixture.plan);
  for (const t of fixture.tasks) store.setTaskStatus(id, t.task_id, t.status, t.detail ?? undefined);
  for (const e of fixture.events) {
    await sleep(5); // the store stamps ts itself; keep them strictly ordered for the replay test
    if (e.type === "blackboard_write") for (const b of fixture.blackboard) store.writeBb({ ...b, run_id: id });
    store.appendEvent({ run_id: id, task_id: e.task_id, agent_id: e.task_id, type: e.type, payload: e.payload });
  }
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
