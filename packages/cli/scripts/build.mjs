// Builds the publishable bundle: dist/mar.mjs (all workspace code + zod inlined; better-sqlite3 and ws stay
// external runtime dependencies) plus dist/ui (the built web UI) a README copy for the npm page, and the LICENSE.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(cliDir, "../..");
const uiDir = join(root, "packages/ui");
const { version } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));

const newest = (p) => {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(st.mtimeMs, ...readdirSync(p).map((f) => newest(join(p, f))));
};

// 1. UI: rebuild when dist is missing or older than its sources.
const uiIndex = join(uiDir, "dist/index.html");
const uiSources = ["src", "index.html", "vite.config.ts", "package.json"].map((f) => join(uiDir, f));
if (!existsSync(uiIndex) || newest(uiIndex) < Math.max(...uiSources.map(newest))) {
  console.log("building UI...");
  const r = spawnSync("pnpm", ["--filter", "@mar/ui", "build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) { console.error("UI build failed"); process.exit(r.status ?? 1); }
}

// 2. Bundle.
rmSync(join(cliDir, "dist"), { recursive: true, force: true });
const out = join(cliDir, "dist/mar.mjs");
await build({
  entryPoints: [join(cliDir, "src/bin.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  external: ["better-sqlite3", "ws", "bufferutil", "utf-8-validate"],
  define: { __MAR_VERSION__: JSON.stringify(version) },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __marCreateRequire } from "node:module";\nconst require = __marCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});
chmodSync(out, 0o755);

// 3. UI assets and README.
cpSync(join(uiDir, "dist"), join(cliDir, "dist/ui"), { recursive: true });
mkdirSync(cliDir, { recursive: true });
copyFileSync(join(root, "README.md"), join(cliDir, "README.md"));
copyFileSync(join(root, "LICENSE"), join(cliDir, "LICENSE"));
console.log(`built ${out} (v${version})`);
