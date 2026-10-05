const PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY)[A-Z0-9_]*)=\S+/gi, "$1=[REDACTED]"],
];
export const redact = (s: string): string => PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), s);
