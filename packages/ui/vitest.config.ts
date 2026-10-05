import { defineConfig } from "vitest/config";

// Playwright specs (*.spec.ts) run via `pnpm test:e2e`, never under Vitest.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["**/node_modules/**", "dist/**", "**/*.spec.ts"] } });
