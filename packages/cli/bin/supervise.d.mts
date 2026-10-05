export function nodeVersionAtLeast(version: string, major: number, minor: number): boolean;
export function exitCodeFor(code: number | null, signal: string | null): number;
export function supervise(
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; graceMs?: number; proc?: NodeJS.Process },
): unknown;
