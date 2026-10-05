#!/usr/bin/env node
// Runs the TypeScript sources directly (no build step): re-execs node with type transformation enabled
// and a resolve hook for `.js` -> `.ts` specifiers.
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { nodeVersionAtLeast, supervise } from "./supervise.mjs";

if (!nodeVersionAtLeast(process.versions.node, 22, 7)) {
  console.error(`mar: Node.js >= 22.7 is required (found ${process.versions.node}); --experimental-transform-types is unavailable.`);
  process.exit(1);
}

if (process.env.MAR_BIN_CHILD !== "1") {
  supervise(
    process.execPath,
    ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env: { ...process.env, MAR_BIN_CHILD: "1" } },
  );
} else {
  register(pathToFileURL(fileURLToPath(new URL("./ts-resolve.mjs", import.meta.url))).href);
  const { main } = await import(new URL("../src/main.ts", import.meta.url).href);
  process.exit(await main(process.argv.slice(2)));
}
