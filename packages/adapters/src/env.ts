/**
 * Environment for worker child processes: an allowlist copy of `base`, so unrelated secrets
 * (AWS_*, GITHUB_TOKEN, NPM_TOKEN, DATABASE_URL, ...) never reach a worker's shell.
 * HOME stays: Claude/Codex logins live under it. CLAUDE_*, ANTHROPIC_*, CODEX_*, OPENAI_* stay so
 * API-key and custom-config-dir setups keep working; proxy/CA vars stay so the CLIs can reach their API.
 *
 * RESIDUAL RISK: this only limits what is inherited. A worker with Bash can still read any file its OS user
 * can read (e.g. the real repo's `.env` via `../../..` from `.mar/worktrees/...`, or ~/.ssh). Real isolation
 * requires OS-level sandboxing (container / sandbox-exec / bubblewrap), which is out of scope for the adapter.
 */
const EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "TMPDIR", "SHELL", "TZ", "NO_COLOR", "COLORTERM",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
const PREFIXES = ["LC_", "XDG_", "CLAUDE_", "ANTHROPIC_", "CODEX_", "OPENAI_"];

export function workerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (EXACT.has(k) || PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
