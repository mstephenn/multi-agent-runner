import { describe, it, expect } from "vitest";
import { redact } from "../src/index.js";
describe("redact", () => {
  it("masks common secret shapes", () => {
    const out = redact("key sk-abc1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAABCDEFGHIJKLMNOP Bearer abc.def.ghi DB_PASSWORD=hunter2 name=bob");
    expect(out).not.toMatch(/sk-abc|ghp_abc|AKIAABC|abc\.def|hunter2/);
    expect(out).toContain("name=bob");
  });
});

describe("redact hardening", () => {
  const r = redact;
  it("redacts quoted and spaced values fully", () => {
    expect(r('PASSWORD="a b" x')).toBe("PASSWORD=[REDACTED] x");
    expect(r("TOKEN='x y z' x")).toBe("TOKEN=[REDACTED] x");
  });
  it("handles colon and JSON forms", () => {
    expect(r("password: hunter2")).toBe("password: [REDACTED]");
    expect(r('{"apiKey":"abc def"}')).toBe('{"apiKey":"[REDACTED]"}'.replace('"[REDACTED]"', "[REDACTED]"));
  });
  it("handles hyphenated, camelCase and segment names", () => {
    for (const n of ["API-KEY", "apiKey", "client_secret", "GITHUB_TOKEN", "DB_PASSWORD"]) expect(r(`${n}=zzz`)).toBe(`${n}=[REDACTED]`);
  });
  it("is case-insensitive for bearer", () => {
    expect(r("authorization: bearer abc.def")).not.toContain("abc.def");
  });
  it("masks other token prefixes", () => {
    const t = ["gho_" + "a".repeat(25), "ghs_" + "a".repeat(25), "github_pat_" + "a".repeat(30), "xoxb-1234567890-abc", "AIza" + "a".repeat(30)];
    for (const x of t) expect(r(`v ${x} w`)).toBe("v [REDACTED] w");
  });
  it("masks PEM blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----";
    expect(r(`k ${pem} z`)).toBe("k [REDACTED] z");
  });
  it("masks URL credentials", () => {
    expect(r("https://user:pass@host/x")).toBe("https://[REDACTED]@host/x");
  });
  it("leaves benign text unchanged", () => {
    for (const x of ["name=bob", "max_tokens=100", "tokenizer=bpe", "https://example.com/a:b"]) expect(r(x)).toBe(x);
  });
});
