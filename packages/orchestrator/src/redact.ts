const TOKEN_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  // Scheme length and user/password lengths are capped (no quadratic backtracking on long inputs). The password
  // may contain `/` or `@`: it runs greedily to the LAST `@` of the whitespace-delimited token.
  [/\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@:]{1,256}:[^\s]{1,256}@/gi, "$1[REDACTED]@"],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bgh[pos]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[REDACTED]"],
  [/\b(Authorization\s*[:=]\s*)Basic\s+[A-Za-z0-9+/=._~-]+/gi, "$1Basic [REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
];

// name (optionally quoted, JSON-style) followed by [=:]; the value is parsed separately (VALUE, sticky) and only
// consumed for secret names, so `Note: DB_PASSWORD=x` still redacts the inner assignment (re-scan after the separator).
const NAME_SEP = /(["']?)([A-Za-z][A-Za-z0-9_-]{0,63})\1(\s*[=:]\s*)/g;
const VALUE = /"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&}"']+/y;

const SECRET_SUFFIX = /(secret|token|password|passwd|apikey|privatekey|credentials?)$/;
// `KEY` alone is secret only for env-style names (STRIPE_KEY, stripeKey): bare `key` and hyphenated names
// like `my-key` stay benign, as do well-known non-secret keys (primary_key, sort_key, ...).
const BENIGN_KEY_PREFIX = new Set(["primary", "foreign", "sort", "cache", "partition"]);
function isSecretName(name: string): boolean {
  const seg = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]/);
  const bareKey = !name.includes("-") && seg.length >= 2 && seg[seg.length - 1] === "key" && !BENIGN_KEY_PREFIX.has(seg[seg.length - 2]);
  return bareKey || seg.some((w, i) => SECRET_SUFFIX.test(w) || w === "pwd" || w === "pass" || (w === "api" && seg[i + 1] === "key") || (w === "private" && seg[i + 1] === "key"));
}

function redactAssignments(s: string): string {
  let out = "", last = 0;
  NAME_SEP.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = NAME_SEP.exec(s)); ) {
    const end = m.index + m[0].length;
    if (!isSecretName(m[2])) continue; // keep scanning right after the separator: the value is not consumed
    VALUE.lastIndex = end;
    const v = VALUE.exec(s);
    if (!v) continue;
    const jsonString = m[1] === '"' && v[0].startsWith('"');
    out += s.slice(last, end) + (jsonString ? '"[REDACTED]"' : "[REDACTED]");
    last = NAME_SEP.lastIndex = end + v[0].length;
  }
  return out + s.slice(last);
}

export const redact = (s: string): string => redactAssignments(TOKEN_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), s));
