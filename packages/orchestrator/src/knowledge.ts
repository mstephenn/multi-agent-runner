import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KbIndex, type KbEntry, type KbSection } from "@mar/core";
import { redact } from "./redact.js";
import { repoMap } from "./repomap.js";

export const KB_DIR = ".mar/knowledge";
const MAP_CHARS = 6000;

export interface KnowledgeBase { root: string; dir: string; index: KbIndex }
export interface KbDraft { id: string; section: KbSection; title: string; body: string }
export interface KbRefreshResult { kb: KnowledgeBase; added: string[]; updated: string[]; unchanged: string[]; preserved: string[] }
export interface KbOptions { now?: () => number }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readText = (p: string): string | undefined => { try { return readFileSync(p, "utf8"); } catch { return undefined; } };
const readJson = (p: string): unknown => { const t = readText(p); if (t === undefined) return undefined; try { return JSON.parse(t); } catch { return undefined; } };
const render = (d: KbDraft): string => redact(`# ${d.title}\n\n${d.body.trim()}\n`);

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function saveIndex(kb: KnowledgeBase): void {
  writeAtomic(join(kb.dir, "index.json"), JSON.stringify(kb.index, null, 2) + "\n");
}

/** Loads the KB under `root`, creating an empty one (dir + index.json) if absent. A corrupt index is rebuilt from the .md files on disk. */
export function loadKnowledge(root: string, opts: KbOptions = {}): KnowledgeBase {
  const now = (opts.now ?? Date.now)();
  const dir = join(root, KB_DIR);
  mkdirSync(dir, { recursive: true });
  const parsed = KbIndex.safeParse(readJson(join(dir, "index.json")));
  if (parsed.success) return { root, dir, index: parsed.data };
  const kb: KnowledgeBase = { root, dir, index: { version: 1, createdAt: now, updatedAt: now, entries: [] } };
  // Recover hand-written markdown as manual entries so a damaged index never loses knowledge.
  for (const f of readdirSync(dir).filter((n) => /^[a-z0-9_-]+\.md$/.test(n)).sort()) {
    const id = f.slice(0, -3), text = readText(join(dir, f)) ?? "";
    kb.index.entries.push({ id, section: "conventions", title: /^#\s+(.+)$/m.exec(text)?.[1]?.slice(0, 120) ?? id, file: f, hash: sha(text), source: "manual", createdAt: now, updatedAt: now });
  }
  saveIndex(kb);
  return kb;
}

export const getEntry = (kb: KnowledgeBase, id: string): KbEntry | undefined => kb.index.entries.find((e) => e.id === id);
export const readEntry = (kb: KnowledgeBase, id: string): string | undefined => { const e = getEntry(kb, id); return e && readText(join(kb.dir, e.file)); };

function parseJson(path: string): Record<string, any> | undefined {
  const v = readJson(path);
  return v && typeof v === "object" ? (v as Record<string, any>) : undefined;
}

/** Builds the scan-derived entries (structure, stack, conventions, commands) for `root`. Deterministic apart from the repo contents. */
export function scanRepo(root: string): KbDraft[] {
  const drafts: KbDraft[] = [];
  let map = "";
  try { map = repoMap(root, MAP_CHARS); } catch { /* not a git repo: skip the structure entry */ }
  if (map) drafts.push({ id: "structure", section: "structure", title: "Repository structure", body: "```\n" + map + "\n```" });

  const pkg = parseJson(join(root, "package.json"));
  const has = (f: string) => existsSync(join(root, f));
  const stack: string[] = [];
  const langs: [string, string][] = [["package.json", "Node.js"], ["tsconfig.json", "TypeScript"], ["pyproject.toml", "Python"], ["requirements.txt", "Python"], ["Cargo.toml", "Rust"], ["go.mod", "Go"], ["pom.xml", "Java (Maven)"], ["Dockerfile", "Docker"]];
  for (const [f, name] of langs) if (has(f) && !stack.some((l) => l.startsWith(`- ${name} `))) stack.push(`- ${name} (\`${f}\`)`);
  const pm = has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : has("package-lock.json") ? "npm" : undefined;
  if (pm) stack.push(`- Package manager: ${pm}`);
  if (pkg) {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
    if (deps.length) stack.push(`- Dependencies: ${deps.slice(0, 40).join(", ")}${deps.length > 40 ? `, … (+${deps.length - 40})` : ""}`);
  }
  if (stack.length) drafts.push({ id: "stack", section: "stack", title: "Tech stack", body: stack.join("\n") });

  const conv: string[] = [];
  const confs: [RegExp, string][] = [[/^(\.?eslint(rc|\.config)|eslint\.config)/, "ESLint"], [/^(\.prettierrc|prettier\.config)/, "Prettier"], [/^\.editorconfig$/, "EditorConfig"], [/^(vitest|jest)\.config/, "Test runner config"], [/^tsconfig.*\.json$/, "TypeScript config"], [/^(ruff|\.flake8|\.golangci)/, "Linter config"]];
  let names: string[] = [];
  try { names = readdirSync(root).sort(); } catch { /* unreadable root */ }
  for (const n of names) for (const [re, label] of confs) if (re.test(n)) conv.push(`- ${label}: \`${n}\``);
  if (pkg?.type === "module") conv.push("- ES modules (`\"type\": \"module\"`)");
  for (const f of ["CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md"]) if (has(f)) conv.push(`- See \`${f}\` for contributor/agent guidelines`);
  if (conv.length) drafts.push({ id: "conventions", section: "conventions", title: "Conventions", body: conv.join("\n") });

  const cmds: string[] = [];
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
  for (const k of Object.keys(scripts).sort()) cmds.push(`- \`${pm ?? "npm"} run ${k}\` — \`${String(scripts[k])}\``);
  const mk = readText(join(root, "Makefile")) ?? "";
  for (const m of mk.matchAll(/^([A-Za-z][\w-]*):(?!=)/gm)) cmds.push(`- \`make ${m[1]}\``);
  if (has("Cargo.toml")) cmds.push("- `cargo build`, `cargo test`");
  if (has("go.mod")) cmds.push("- `go build ./...`, `go test ./...`");
  if (cmds.length) drafts.push({ id: "commands", section: "commands", title: "Commands", body: cmds.join("\n") });
  return drafts;
}

/**
 * Merges `drafts` into the KB. New ids are added; scan entries whose content changed are rewritten (createdAt kept);
 * entries not in `drafts` are never removed; entries marked manual, or whose file was edited on disk since the last
 * write, are left untouched and promoted to source "manual". All bodies pass through redact() before hashing/writing.
 */
export function mergeKnowledge(kb: KnowledgeBase, drafts: KbDraft[], opts: KbOptions = {}): KbRefreshResult {
  const now = (opts.now ?? Date.now)();
  const res: KbRefreshResult = { kb, added: [], updated: [], unchanged: [], preserved: [] };
  const seen = new Set<string>();
  for (const d of drafts) {
    seen.add(d.id);
    const text = render(d), hash = sha(text), file = `${d.id}.md`, path = join(kb.dir, file);
    const prior = getEntry(kb, d.id);
    if (!prior) {
      writeAtomic(path, text);
      kb.index.entries.push({ id: d.id, section: d.section, title: d.title, file, hash, source: "scan", createdAt: now, updatedAt: now, scannedAt: now });
      res.added.push(d.id);
      continue;
    }
    const onDisk = readText(join(kb.dir, prior.file));
    if (prior.source === "manual" || (onDisk !== undefined && sha(onDisk) !== prior.hash)) {
      prior.source = "manual";
      if (onDisk !== undefined) prior.hash = sha(onDisk);
      res.preserved.push(d.id);
    } else if (onDisk !== undefined && prior.hash === hash) {
      prior.scannedAt = now;
      res.unchanged.push(d.id);
    } else {
      writeAtomic(join(kb.dir, prior.file), text);
      Object.assign(prior, { section: d.section, title: d.title, hash, updatedAt: now, scannedAt: now });
      res.updated.push(d.id);
    }
  }
  for (const e of kb.index.entries) if (!seen.has(e.id)) res.preserved.push(e.id);
  kb.index.updatedAt = now;
  saveIndex(kb);
  return res;
}

/** Loads (or creates) the KB at `root`, scans the repo and merges the result. */
export function refreshKnowledge(root: string, opts: KbOptions = {}): KbRefreshResult {
  return mergeKnowledge(loadKnowledge(root, opts), scanRepo(root), opts);
}
