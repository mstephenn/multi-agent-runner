const TOKEN_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bgh[pos]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
];

// name (optionally quoted, JSON-style) + [=:] + double-quoted | single-quoted | bare value
const KV = /(["']?)([A-Za-z][A-Za-z0-9_-]{0,63})\1(\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&}"']+)/g;

function isSecretName(name: string): boolean {
  const seg = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]/);
  return seg.some((w, i) => w === "secret" || w === "token" || w === "password" || w === "passwd" || w === "apikey" || (w === "api" && seg[i + 1] === "key"));
}

export const redact = (s: string): string => {
  const out = TOKEN_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), s);
  return out.replace(KV, (m, q: string, name: string, sep: string) => (isSecretName(name) ? `${q}${name}${q}${sep}[REDACTED]` : m));
};
