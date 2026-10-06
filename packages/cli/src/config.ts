import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { linkPathProblem, parseCommand, REPO_NAME, type WorkspaceRepo } from "@mar/orchestrator";

const tierKeys = z.object({ low: z.string().nullable(), mid: z.string().nullable(), high: z.string().nullable() });
type Tiers = z.infer<typeof tierKeys>;
const DEFAULT_TIERS: { claude: Tiers; codex: Tiers } = {
  claude: { low: "claude-haiku-4-5-20251001", mid: "claude-sonnet-5-5", high: "claude-sonnet-5-5" },
  codex: { low: null, mid: null, high: null },
};
const isOpus = (m: string | null | undefined) => !!m && /opus/i.test(m);

const shape = {
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
  // Phased runs: tasks per phase, phases per run, and a cap on all tokens of the run (default: 5 x defaultBudgetTokens, see effectiveMaxTotalTokens).
  maxTasks: z.number().int().min(1).max(16).default(8),
  maxPhases: z.number().int().min(1).max(10).default(5),
  maxTotalTokens: z.number().int().positive().optional(),
  // Size of the repo map handed to the planner (flat file list when it fits, a structured map otherwise).
  repoMapChars: z.number().int().min(2000).max(100000).default(20000),
  // Partial overrides are allowed and merged with the defaults below.
  tiers: z.object({ claude: tierKeys.partial().strict().optional(), codex: tierKeys.partial().strict().optional() }).strict().optional(),
  // Workspace runs (parent folder of several git repos): restrict the run to these repo folders (`--repos` wins). Ignored in a single repo.
  repos: z.array(z.string().regex(REPO_NAME, "repo names may only contain letters, digits, '.', '_' and '-'")).optional(),
};
const Schema = z.object(shape).strict().transform((c) => ({
  ...c,
  tiers: {
    claude: { ...DEFAULT_TIERS.claude, ...c.tiers?.claude },
    codex: { ...DEFAULT_TIERS.codex, ...c.tiers?.codex },
  },
}));
export type MarConfig = z.output<typeof Schema>;

/** Token cap for a whole run: `maxTotalTokens`, else 5 x the (possibly `--budget`-overridden) per-task budget. */
export const effectiveMaxTotalTokens = (c: Pick<MarConfig, "maxTotalTokens" | "defaultBudgetTokens">): number => c.maxTotalTokens ?? 5 * c.defaultBudgetTokens;

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

// --- multi-repo workspaces ----------------------------------------------------------------------------------------------

/** Keys a child repo's own `.mar.json` may set; everything else is run-level and only read from the workspace root. */
export const REPO_SCOPED_KEYS = ["verify", "verifyTimeoutMinutes", "linkPaths", "ownership", "integrate"] as const;
export type RepoConfig = Pick<MarConfig, (typeof REPO_SCOPED_KEYS)[number]>;
const RepoSchema = z.object({
  verify: shape.verify, verifyTimeoutMinutes: shape.verifyTimeoutMinutes, linkPaths: shape.linkPaths, ownership: shape.ownership, integrate: shape.integrate,
}).partial().strict();
const RUN_LEVEL_KEYS: ReadonlySet<string> = new Set(Object.keys(shape).filter((k) => !(REPO_SCOPED_KEYS as readonly string[]).includes(k)));

export interface WorkspaceConfig {
  /** Run-level config: the workspace root's `.mar.json`. */
  config: MarConfig;
  /** Per repo name: repo-scoped keys, built-in defaults < root file < the repo's own file. */
  repoConfigs: Record<string, RepoConfig>;
  /** One note per child file that sets run-level keys (they are ignored). */
  notes: string[];
}

export function loadWorkspaceConfig(root: string, repos: readonly WorkspaceRepo[]): WorkspaceConfig {
  const config = loadConfig(root);
  const base: RepoConfig = { verify: config.verify, verifyTimeoutMinutes: config.verifyTimeoutMinutes, linkPaths: config.linkPaths, ownership: config.ownership, integrate: config.integrate };
  const notes: string[] = [];
  const repoConfigs: Record<string, RepoConfig> = {};
  for (const r of repos) {
    const label = `${r.name}/${FILE}`;
    const p = join(r.path, FILE);
    let child: Partial<RepoConfig> = {};
    if (existsSync(p)) {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new Error(`${label}: invalid JSON or unreadable file (${(e as Error).message})`); }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label}: must be a JSON object`);
      const own: Record<string, unknown> = {}; const ignored: string[] = [];
      for (const [k, v] of Object.entries(raw)) { if (RUN_LEVEL_KEYS.has(k)) ignored.push(k); else own[k] = v; }
      if (ignored.length) notes.push(`ignored run-level keys in ${label}: ${ignored.join(", ")}`);
      const res = RepoSchema.safeParse(own);
      if (!res.success) throw new Error(`${label}: ${res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      child = res.data;
    }
    repoConfigs[r.name] = { ...base, ...child };
  }
  return { config, repoConfigs, notes };
}
