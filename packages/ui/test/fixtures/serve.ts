import type { Page } from "@playwright/test";
import type { FixtureRun } from "./board.js";

/** Serves a fixture run to the page: stubs the run list, the snapshot and a silent websocket, so only the built UI (`base`) is needed. */
export async function serveFixture(page: Page, base: string, fx: FixtureRun, opts: { readOnly?: boolean; open?: boolean } = {}): Promise<void> {
  const { id } = fx.info;
  await page.route("**/api/meta", (r) => r.fulfill({ json: { readOnly: opts.readOnly === true } }));
  await page.route("**/api/runs", (r) => r.fulfill({ json: [fx.info] }));
  const snap = { ...fx.snap, truncated: false };
  await page.route(`**/api/runs/${id}?*`, (r) => r.fulfill({ json: snap }));
  await page.route(`**/api/runs/${id}`, (r) => r.fulfill({ json: snap }));
  await page.routeWebSocket(/\/ws/, () => { /* connected, never sends: the run looks live */ });
  if (opts.open !== false) await page.goto(`${base}/?run=${id}`);
}
