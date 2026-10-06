import { execFileSync } from "node:child_process";

const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|bun\.lockb)$/;
const SMALL_DIR_FILES = 12;
const TREE_DEPTH = 3;
const moreLine = (n: number, dirs: number) => `… (+${n} more files in ${dirs} dirs)`;
const MORE_LINE_MAX = moreLine(99_999_999, 99_999).length;

function listFiles(repo: string, ref: string | undefined): string[] {
  let raw: string;
  try {
    // -z: NUL-separated so names with spaces, newlines or non-ASCII bytes survive unquoted.
    const args = ref === undefined ? ["ls-files", "-z"] : ["ls-tree", "-r", "-z", "--name-only", ref, "--"];
    raw = execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = String(err.stderr ?? "").split("\n")[0]!.trim();
    const why = err.code === "ENOENT" ? "git is not installed or not on PATH"
      : err.code === "ENOBUFS" ? "the file list exceeds the 64 MB buffer"
      : stderr || (e instanceof Error ? e.message.split("\n")[0] : String(e));
    throw new Error(`repoMap: cannot list files in ${repo}: ${why}`);
  }
  return raw.split("\0")
    .filter((f) => f && !LOCKFILE.test(f) && !/\.min\./.test(f))
    .map((f) => f.replace(/\n/g, "\\n").replace(/\r/g, "\\r"));
}

const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
const depthOf = (f: string) => f.split("/").length - 1;
const ext = (f: string) => { const b = base(f); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : "(none)"; };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const ROOT_KEY = /^(README.*|readme.*|package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements.*\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle.*|tsconfig.*\.json|Makefile|makefile|justfile|Dockerfile.*|docker-compose.*\.ya?ml|\.mar\.json)$/;
const ROOT_CONFIG = /^(\.?[\w-]+\.(config|rc)\.[a-z]+|\.[\w.-]*rc(\.[a-z]+)?|[\w.-]+\.(toml|ya?ml|json|ini|cfg))$/;
const NESTED_KEY = /^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/;
const DOCS_KEY = /^(README.*|readme.*|index\.\w+)$/;

// Files that explain the repo, most general first: root key files, root config, docs index, nested manifests.
function keyFiles(files: string[]): string[] {
  const rank = (f: string): number => {
    const d = depthOf(f), b = base(f);
    if (d === 0) return ROOT_KEY.test(b) ? 0 : ROOT_CONFIG.test(b) ? 1 : -1;
    if (d === 1 && /^docs$/i.test(f.split("/")[0]!) && DOCS_KEY.test(b)) return 2;
    if (d <= 3 && NESTED_KEY.test(b)) return 3;
    if (d <= 2 && /^README/i.test(b)) return 4;
    return -1;
  };
  return files.map((f) => [f, rank(f)] as const).filter(([, r]) => r >= 0).sort((a, b) => a[1] - b[1] || cmp(a[0], b[0])).map(([f]) => f);
}

interface Dir { files: number; exts: Map<string, number>; direct: string[] }

/**
 * Compact repository map for the planner. When the flat file list fits in `maxChars` it is returned as is (one path
 * per line). Otherwise a structured map within `maxChars`: key files, a directory tree (depth <= 3) with file counts
 * and top extensions, the file names of small directories (<= 12 direct files, shallow first) until the cap, and a
 * closing `… (+N more files in M dirs)` line. Deterministic; lockfiles and minified files are skipped. `ref` lists
 * that commit-ish (e.g. the integration branch) instead of the working checkout.
 */
export function repoMap(repo: string, maxChars = 20000, ref?: string): string {
  const files = listFiles(repo, ref).sort(cmp);
  const flatLen = files.reduce((n, f) => n + f.length + 1, 0);
  if (flatLen <= maxChars) return files.join("\n");

  const lines: string[] = [];
  let len = 0;
  const listed = new Set<string>();
  const tryAdd = (line: string, limit: number): boolean => {
    if (len + line.length + 1 > limit) return false;
    lines.push(line); len += line.length + 1; return true;
  };
  const limit = Math.max(0, maxChars - MORE_LINE_MAX - 1);

  // 1. key files (up to ~20% of the cap)
  const keyLimit = Math.floor(maxChars * 0.2);
  const keys = keyFiles(files);
  if (keys.length && tryAdd("Key files:", keyLimit)) for (const f of keys) if (tryAdd(f, keyLimit)) listed.add(f); else break;

  // 2. directory tree, depth reduced until it fits ~40% of the cap
  const dirs = new Map<string, Dir>();
  const dirAt = (d: string) => { let x = dirs.get(d); if (!x) { x = { files: 0, exts: new Map(), direct: [] }; dirs.set(d, x); } return x; };
  for (const f of files) {
    const segs = f.split("/"); segs.pop();
    dirAt(segs.join("/")).direct.push(base(f));
    for (let i = 0; i <= segs.length; i++) {
      const x = dirAt(segs.slice(0, i).join("/"));
      x.files++; x.exts.set(ext(f), (x.exts.get(ext(f)) ?? 0) + 1);
    }
  }
  const treeLine = (d: string, x: Dir) => {
    const top = [...x.exts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 3).map(([e, n]) => `${e}×${n}`).join(" ");
    const depth = d === "" ? 0 : d.split("/").length;
    return `${"  ".repeat(depth)}${d === "" ? "./" : d.slice(d.lastIndexOf("/") + 1) + "/"} (${x.files} file${x.files === 1 ? "" : "s"}; ${top})`;
  };
  const treeLimit = len + Math.floor(maxChars * 0.4);
  const names = [...dirs.keys()].sort(cmp);
  // Indented lines show only the last segment: print parents before children (sorted order guarantees it).
  for (let depth = TREE_DEPTH; depth >= 1; depth--) {
    const sel = names.filter((d) => d === "" || d.split("/").length <= depth);
    const block = ["Directory tree (files; top extensions):", ...sel.map((d) => treeLine(d, dirs.get(d)!))];
    const size = block.reduce((n, l) => n + l.length + 1, 0);
    if (len + size <= treeLimit || depth === 1) {
      for (const l of block) if (!tryAdd(l, Math.min(limit, treeLimit))) break;
      break;
    }
  }

  // 3. names of small directories, shallow first, until the cap
  const small = names.filter((d) => d !== "" && dirs.get(d)!.direct.length > 0 && dirs.get(d)!.direct.length <= SMALL_DIR_FILES)
    .sort((a, b) => a.split("/").length - b.split("/").length || cmp(a, b));
  let header = false;
  for (const d of small) {
    const x = dirs.get(d)!;
    const fresh = x.direct.filter((n) => !listed.has(`${d}/${n}`));
    if (fresh.length === 0) continue;
    if (!header) { if (!tryAdd("Files in small directories:", limit)) break; header = true; }
    if (!tryAdd(`${d}/: ${fresh.join(", ")}`, limit)) break;
    for (const n of fresh) listed.add(`${d}/${n}`);
  }
  // root-level files that are not key files fit the same rule (root counts as a small directory)
  const rootDirect = dirs.get("")!.direct.filter((n) => !listed.has(n));
  if (rootDirect.length && rootDirect.length <= SMALL_DIR_FILES && tryAdd(`./: ${rootDirect.join(", ")}`, limit)) for (const n of rootDirect) listed.add(n);

  // 4. closing line
  const unlisted = files.filter((f) => !listed.has(f));
  if (unlisted.length) {
    const rest = new Set(unlisted.map(dirOf));
    lines.push(moreLine(unlisted.length, rest.size));
  }
  let out = lines.join("\n");
  if (out.length > maxChars) {
    // Last resort for tiny caps: keep the closing line, drop lines before it.
    const tail = lines.at(-1)!;
    const body = lines.slice(0, -1);
    while (body.length && body.join("\n").length + 1 + tail.length > maxChars) body.pop();
    out = (body.length ? body.join("\n") + "\n" : "") + tail;
    if (out.length > maxChars) out = out.slice(0, maxChars);
  }
  return out;
}
