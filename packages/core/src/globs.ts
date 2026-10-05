// Repo-relative path globs: `*` (any run of characters within a segment), `?` (one character), `**` (a whole
// segment matching any number of segments). Pure and conservative: when unsure, patterns are reported as overlapping.
// A pattern may also name a directory, so `src/a` covers `src/a/b.ts` (an implicit trailing `/**`), unless its last
// segment looks like a file name (an extension dot after the first character: `*.md`, `foo.ts`).

const segments = (p: string): string[] => {
  const s = p.split("/").filter((x) => x !== "");
  const last = s[s.length - 1];
  if (last === undefined || (last !== "**" && last.indexOf(".", 1) < 0)) s.push("**");
  return s;
};

// Could any single string match both segment patterns? (exact for `*` / `?` / literals)
function segmentsOverlap(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const f = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === a.length && j === b.length) r = true;
    else if (a[i] === "*") r = f(i + 1, j) || (j < b.length && f(i, j + 1));
    else if (b[j] === "*") r = f(i, j + 1) || (i < a.length && f(i + 1, j));
    else if (i === a.length || j === b.length) r = false;
    else r = (a[i] === b[j] || a[i] === "?" || b[j] === "?") && f(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return f(0, 0);
}

export function globsOverlap(a: string, b: string): boolean {
  const x = segments(a), y = segments(b);
  const memo = new Map<number, boolean>();
  const f = (i: number, j: number): boolean => {
    const key = i * (y.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === x.length && j === y.length) r = true;
    else if (x[i] === "**") r = f(i + 1, j) || (j < y.length && f(i, j + 1));
    else if (y[j] === "**") r = f(i, j + 1) || (i < x.length && f(i + 1, j));
    else if (i === x.length || j === y.length) r = false;
    else r = segmentsOverlap(x[i], y[j]) && f(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return f(0, 0);
}

/** True when the repo-relative `file` is covered by at least one glob (same semantics as `globsOverlap`). */
export const matchesAnyGlob = (file: string, globs: readonly string[]): boolean => globs.some((g) => globsOverlap(file, g));
