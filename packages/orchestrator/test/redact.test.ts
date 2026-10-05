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
    // updated: expectation used to be invalid JSON; a quoted JSON value now stays a valid JSON string.
    expect(r('{"apiKey":"abc def"}')).toBe('{"apiKey":"[REDACTED]"}');
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
  it("does not let a non-secret key swallow an inner secret assignment", () => {
    expect(r("Note: DB_PASSWORD=hunter2")).toBe("Note: DB_PASSWORD=[REDACTED]");
    expect(r("Run with env: API_KEY=abc")).toBe("Run with env: API_KEY=[REDACTED]");
    expect(r("config: password=abc")).toBe("config: password=[REDACTED]");
    expect(r('{"note":"DB_PASSWORD=x y"}')).not.toContain("x y");
    expect(r('{"note":"DB_PASSWORD=x"}')).not.toMatch(/=x/);
  });
  it("matches private_key, AUTHTOKEN, pwd, privateKey", () => {
    for (const n of ["private_key", "PRIVATE-KEY", "privateKey", "AUTHTOKEN", "pwd", "ACCESSTOKEN"]) expect(r(`${n}=zzz`)).toBe(`${n}=[REDACTED]`);
  });
  it("redacts URL passwords containing / or @", () => {
    expect(r("postgres://user:p/ss@host/db")).toBe("postgres://[REDACTED]@host/db");
    expect(r("postgres://user:p@ss@host/db")).toBe("postgres://[REDACTED]@host/db");
    expect(r("ssh://u:pw@h")).toBe("ssh://[REDACTED]@h");
  });
  it("is linear on long adversarial inputs (<200ms)", () => {
    for (const unit of ["a.", "a-", "a://a:", "a=", "A_"]) {
      const big = unit.repeat(50_000);
      const t = performance.now();
      redact(big);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
  it("leaves more benign near-misses unchanged", () => {
    for (const x of ["tokenizer: bpe", "secretary=bob", "a.b.c://x", "key=value", "private=1", "my-key: 5"]) expect(r(x)).toBe(x);
  });
});

describe("redact gaps (M1)", () => {
  const r = redact;
  it("redacts *_PASS names", () => {
    expect(r("DB_PASS=hunter2")).toBe("DB_PASS=[REDACTED]");
    expect(r("pass: hunter2")).toBe("pass: [REDACTED]");
  });
  it("redacts bare KEY-suffix names but keeps benign ones", () => {
    expect(r("STRIPE_KEY=abc123")).toBe("STRIPE_KEY=[REDACTED]");
    expect(r("stripeKey=abc123")).toBe("stripeKey=[REDACTED]");
    for (const x of ["max_tokens=100", "tokenizer=bpe", "name=bob", "key=value", "my-key: 5", "primary_key=id", "sort_key=a", "bypass=1"]) expect(r(x)).toBe(x);
  });
  it("redacts credentials=", () => {
    expect(r("credentials=abc:def")).toBe("credentials=[REDACTED]");
    expect(r("AWS_CREDENTIALS=zzz")).toBe("AWS_CREDENTIALS=[REDACTED]");
  });
  it("redacts sk_live_ / sk_test_ keys", () => {
    expect(r("k sk_live_abcdefghijkl1234 z")).toBe("k [REDACTED] z");
    expect(r("k sk_test_abcdefghijkl1234 z")).toBe("k [REDACTED] z");
  });
  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(r(`t ${jwt} z`)).toBe("t [REDACTED] z");
  });
  it("redacts Authorization: Basic", () => {
    const out = r("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("dXNlcjpw");
    expect(out).toContain("Authorization");
  });
  it("stays linear on adversarial input for the new patterns (<200ms)", () => {
    for (const unit of ["eyJabcde.", "sk_live_", "Basic ", "A_KEY", "pass="]) {
      const big = unit.repeat(20_000);
      const t = performance.now();
      redact(big);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
});
