import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KbIndex, type KbSection } from "@mar/core";
import { KB_DIR } from "./knowledge.js";
import { redact } from "./redact.js";

const SECTIONS: readonly KbSection[] = ["structure", "stack", "conventions", "commands"];
const TRUNCATED = "\n[Knowledge base truncated]";

/**
 * Read-only digest for planner and worker prompts. Missing/invalid indexes and
 * unreadable entries are omitted. Entries follow section order, then id order.
 * maxChars caps the entire result in UTF-16 code units (including the marker).
 * Non-finite limits are rejected; non-positive limits produce an empty digest.
 */
export function knowledgePrompt(root: string, maxChars = 8000): string {
  if (!Number.isFinite(maxChars)) throw new RangeError("maxChars must be finite");
  const limit = Math.max(0, Math.floor(maxChars));
  if (!limit) return "";
  const dir = join(root, KB_DIR);
  let index: KbIndex;
  try {
    index = KbIndex.parse(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
  } catch {
    return "";
  }
  const entries = [...index.entries].sort((a, b) =>
    SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parts: string[] = [];
  for (const entry of entries) {
    // Never follow an index filename outside the KB directory.
    if (!/^[a-z0-9_-]+\.md$/.test(entry.file)) continue;
    let body: string;
    try { body = readFileSync(join(dir, entry.file), "utf8").trim(); }
    catch { continue; }
    if (!body) continue;
    parts.push(`## ${entry.section}: ${entry.title}\n\n${body}`);
  }
  if (!parts.length) return "";
  const digest = redact("# Repository knowledge base\n\n" + parts.join("\n\n"));
  if (digest.length <= limit) return digest;
  if (limit <= TRUNCATED.length) return TRUNCATED.trimStart().slice(0, limit);
  let body = digest.slice(0, limit - TRUNCATED.length);
  // Avoid cutting a Unicode surrogate pair in half.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  return body + TRUNCATED;
}
