import { describe, it, expect } from "vitest";
import { sanitizeForTerminal as s } from "../src/sanitize.js";

describe("sanitizeForTerminal", () => {
  it("strips CSI sequences (clear screen, colours, cursor moves)", () => {
    expect(s("a\x1b[2Jb")).toBe("ab");
    expect(s("\x1b[31;1mred\x1b[0m")).toBe("red");
    expect(s("x\x1b[?25ly\x1b[10;20Hz")).toBe("xyz");
  });
  it("strips OSC sequences terminated by BEL or ST, and unterminated ones", () => {
    expect(s("a\x1b]0;pwned title\x07b")).toBe("ab");
    expect(s("a\x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
    expect(s("keep\x1b]52;c;SGVsbG8=")).toBe("keep");
  });
  it("strips 8-bit C1 introducers and DCS/APC strings", () => {
    expect(s("a\u009b2Jb")).toBe("ab");
    expect(s("a\u009d0;title\u009cb")).toBe("ab");
    expect(s("a\x1bPq#0;2;0;0;0\x1b\\b")).toBe("ab");
    expect(s("a\x1b_Gf=24;AAAA\x1b\\b")).toBe("ab");
  });
  it("drops other control characters, DEL and CR but keeps newline and tab", () => {
    expect(s("a\x00b\x07c\x08d\x7fe\rf\x0bg\x0ch\u0085i")).toBe("abcdefghi");
    expect(s("l1\nl2\tcol\r\nl3")).toBe("l1\nl2\tcol\nl3");
    expect(s("a\x1bcb")).toBe("ab"); // ESC c (terminal reset)
  });
  it("leaves markdown, unicode and emoji unchanged", () => {
    const text = "# Title\n\n- **bold** `code` [l](http://x)\n\n```ts\nconst a = 1;\n```\n| a | b |\n日本語 café ñ — “quotes” ✓ 🚀 👨‍👩‍👧 \u00a0 \u200b end\n";
    expect(s(text)).toBe(text);
    expect(s("")).toBe("");
  });
});
