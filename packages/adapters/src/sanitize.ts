/** Max length of diagnostic text (stderr, error messages) embedded into AdapterError. */
export const DIAGNOSTIC_MAX = 300;

// Local, minimal redaction (adapters cannot import the orchestrator's redactor): KEY=value / KEY: value pairs for
// secret-looking names, bearer tokens and common API key shapes.
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*`;
const PAIR = new RegExp(String.raw`\b(${SECRET_NAME})(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`, "gi");

/** Strips obvious secrets, collapses to the last `max` code points (never splits a surrogate pair). */
export function sanitizeDiagnostic(text: string, max = DIAGNOSTIC_MAX): string {
  let s = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(PAIR, "$1$2[redacted]")
    .trim();
  const cps = Array.from(s);
  if (cps.length > max) s = "…" + cps.slice(-(max - 1)).join("");
  return s;
}
