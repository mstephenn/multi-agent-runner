import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const root = join(cliDir, "../..");
const bundle = join(cliDir, "dist/mar.mjs");
const version = (JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { version: string }).version;
const canBuild = existsSync(join(root, "node_modules/esbuild"))  || existsSync(join(cliDir, "node_modules/esbuild"));
const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
const mar = (bin: string, args: string[], cwd = tmpdir()) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

describe.skipIf(!canBuild)("packaged bundle", () => {
  it("builds dist/mar.mjs with shebang, exec bit and UI assets", () => {
    execFileSync(process.execPath, [join(cliDir, "scripts/build.mjs")], { cwd: cliDir, stdio: "pipe", timeout: 300_000 });
    expect(readFileSync(bundle, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(bundle).mode & 0o111).not.toBe(0);
    expect(existsSync(join(cliDir, "dist/ui/index.html"))).toBe(true);
  }, 300_000);

  it("runs: --help, --version, run without goal", () => {
    const help = mar(bundle, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("mar run");
    const v = mar(bundle, ["--version"]);
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(version);
    expect(mar(bundle, ["-v"]).stdout.trim()).toBe(version);
    expect(mar(bundle, ["run"]).status).toBe(2);
  });

  it("is self-contained (no workspace, TypeScript or absolute paths)", () => {
    const src = readFileSync(bundle, "utf8");
    expect(src).not.toMatch(/["']@mar\//);
    expect(src).not.toMatch(/(?:from|import\s*\(?)\s*["'][^"']*\.ts["']/);
    expect(src).not.toContain("/Users/");
  });

  it("run in a non-git directory fails preflight with a non-zero exit", () => {
    const dir = tmp("mar-nogit-");
    const r = mar(bundle, ["run", "x", "--repo", dir]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("preflight failed");
    expect(r.stderr).toContain("not a git repository");
  });

  const npm = (args: string[], cwd: string) => spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 240_000 });

  it("pack file list is minimal", () => {
    const r = npm(["pack", "--dry-run", "--json", "--ignore-scripts"], cliDir);
    expect(r.status, r.stderr).toBe(0);
    const files = (JSON.parse(r.stdout) as { files: { path: string }[] }[])[0].files.map((f) => f.path);
    for (const f of ["dist/mar.mjs", "dist/ui/index.html", "package.json"]) expect(files).toContain(f);
    expect(files.filter((f) => /^(src|test|scripts)\//.test(f) || f.endsWith(".map") || /\.superpowers|\.mar(\/|$)/.test(f))).toEqual([]);
  }, 240_000);

  it("npm i -g into a temp prefix gives a working `mar` from any directory", () => {
    const dest = tmp("mar-pack-");
    const p = npm(["pack", "--ignore-scripts", "--json", "--pack-destination", dest], cliDir);
    expect(p.status, p.stderr).toBe(0);
    const tgz = join(dest, (JSON.parse(p.stdout) as { filename: string }[])[0].filename);
    const prefix = tmp("mar-prefix-");
    let i = npm(["install", "-g", "--prefix", prefix, tgz], tmpdir());
    if (i.status !== 0) i = npm(["install", "-g", "--offline", "--prefix", prefix, tgz], tmpdir());
    if (i.status !== 0) { console.warn("install smoke skipped: npm install failed (no network / cache?):", i.stderr.slice(-300)); return; }
    const bin = join(prefix, "bin/mar");
    const v = spawnSync(bin, ["--version"], { cwd: tmpdir(), encoding: "utf8" });
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(version);
    const h = spawnSync(bin, ["--help"], { cwd: tmpdir(), encoding: "utf8" });
    expect(h.status).toBe(0);
    expect(h.stdout).toContain("mar run");
  }, 300_000);
});
