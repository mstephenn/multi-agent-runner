#!/usr/bin/env node
// Runs the TypeScript sources directly (no build step): re-execs node with type transformation enabled
// and a resolve hook for `.js` -> `.ts` specifiers.
import { spawn } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.MAR_BIN_CHILD !== "1") {
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, MAR_BIN_CHILD: "1" } },
  );
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("error", (e) => { console.error(`mar: cannot start: ${e.message}`); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  register(pathToFileURL(fileURLToPath(new URL("./ts-resolve.mjs", import.meta.url))).href);
  const { main } = await import(new URL("../src/main.ts", import.meta.url).href);
  process.exit(await main(process.argv.slice(2)));
}
