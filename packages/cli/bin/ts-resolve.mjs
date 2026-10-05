// Resolve hook: maps relative `.js` specifiers to an existing `.ts` file (workspace sources are TypeScript).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const ts = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}
