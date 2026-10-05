import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { linkPathProblem, parseCommand } from "@mar/orchestrator";

const tierKeys = z.object({ low: z.string().nullable(), mid: z.string().nullable(), high: z.string().nullable() });
type Tiers = z.infer<typeof tierKeys>;
const DEFAULT_TIERS: { claude: Tiers; codex: Tiers } = {
  claude: { low: "claude-haiku-4-5-20251001", mid: "claude-sonnet-5-5", high: "claude-sonnet-5-5" },
  codex: { low: null, mid: null, high: null },
};
const isOpus = (m: string | null | undefined) => !!m && /opus/i.test(m);

const Schema = z.object({
  concurrency: z.number().int().min(1).max(16).default(3),
  maxAttempts: z.number().int().min(1).max(3).default(1),
  defaultBudgetTokens: z.number().int().positive().default(200000),
  plannerModel: z.string().min(1).default("claude-sonnet-5-5"),
  taskTimeoutMinutes: z.number().int().min(1).max(240).default(20),
  maxBudgetUsdPerTask: z.number().positive().optional(),
  allowOpus: z.boolean().default(false),
  // Verify gate: commands (argv-split, no shell) every implementer/tester must pass in its worktree. [] = gate off.
  verify: z.array(z.string().superRefine((c, ctx) => { try { parseCommand(c); } catch (e) { ctx.addIssue({ code: "custom", message: (e as Error).message }); } })).default([]),
  verifyTimeoutMinutes: z.number().int().min(1).max(60).default(10),
  // Repo-relative paths (single-segment * globs) symlinked from the main repo into writer worktrees, e.g. node_modules.
  linkPaths: z.array(z.string().superRefine((p, ctx) => { const why = linkPathProblem(p); if (why) ctx.addIssue({ code: "custom", message: why }); })).default([]),
  // What to do when a writer touches files outside its declared task paths.
  ownership: z.enum(["warn", "enforce"]).default("warn"),
  // Merge all done writer branches into mar/<run>/integration (never your branch) and re-verify the result.
  integrate: z.boolean().default(true),
  // Partial overrides are allowed and merged with the defaults below.
  tiers: z.object({ claude: tierKeys.partial().strict().optional(), codex: tierKeys.partial().strict().optional() }).strict().optional(),
}).strict().transform((c) => ({
  ...c,
  tiers: {
    claude: { ...DEFAULT_TIERS.claude, ...c.tiers?.claude },
    codex: { ...DEFAULT_TIERS.codex, ...c.tiers?.codex },
  },
}));
export type MarConfig = z.output<typeof Schema>;

const FILE = ".mar.json";

export function loadConfig(repo: string): MarConfig {
  const p = join(repo, FILE);
  let raw: unknown = {};
  if (existsSync(p)) {
    try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(`${FILE}: invalid JSON or unreadable file (${(e as Error).message})`); }
  }
  const r = Schema.safeParse(raw);
  if (!r.success) throw new Error(`${FILE}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  const c = r.data;
  if (!c.allowOpus) {
    const offenders = [c.plannerModel, ...Object.values(c.tiers.claude), ...Object.values(c.tiers.codex)].filter(isOpus);
    if (offenders.length) throw new Error(`${FILE}: opus models are disabled by default (${offenders.join(", ")}); set "allowOpus": true to use them`);
  }
  return c;
}
