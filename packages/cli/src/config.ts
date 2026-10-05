import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const tiers = z.object({ low: z.string().nullable(), mid: z.string().nullable(), high: z.string().nullable() }).strict();
const Schema = z.object({
  concurrency: z.number().int().positive().default(3),
  maxAttempts: z.number().int().min(1).max(3).default(1),
  defaultBudgetTokens: z.number().int().positive().default(200000),
  plannerModel: z.string().default("claude-sonnet-5-5"),
  tiers: z.object({ claude: tiers, codex: tiers }).strict().default({
    claude: { low: "claude-haiku-4-5-20251001", mid: "claude-sonnet-5-5", high: "claude-sonnet-5-5" },
    codex: { low: null, mid: null, high: null },
  }),
}).strict();
export type MarConfig = z.infer<typeof Schema>;

export function loadConfig(repo: string): MarConfig {
  const p = join(repo, ".mar.json");
  return Schema.parse(existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
}
