import { defineConfig, devices } from "@playwright/test";

// The spec starts its own server (startServer + built dist), so no webServer here.
export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  outputDir: "./node_modules/.pw-results",
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
});
