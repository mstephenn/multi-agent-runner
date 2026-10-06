import { describe, expect, it } from "vitest";
import { shortcutAction, stepSelection, SHORTCUTS } from "../src/shortcuts.js";

describe("shortcutAction", () => {
  it("maps plain keys and ignores modifiers", () => {
    expect(shortcutAction({ key: "?" })).toBe("help");
    expect(shortcutAction({ key: "j" })).toBe("next");
    expect(shortcutAction({ key: "K" })).toBe("prev");
    expect(shortcutAction({ key: "f" })).toBe("fit");
    expect(shortcutAction({ key: "m" })).toBe("minimap");
    expect(shortcutAction({ key: "f", metaKey: true })).toBeNull();
    expect(shortcutAction({ key: "j", ctrlKey: true })).toBeNull();
    expect(shortcutAction({ key: "x" })).toBeNull();
  });
  it("ignores plain keys while typing but not Escape", () => {
    expect(shortcutAction({ key: "j", target: { tagName: "INPUT" } })).toBeNull();
    expect(shortcutAction({ key: "?", target: { tagName: "SELECT" } })).toBeNull();
    expect(shortcutAction({ key: "m", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
    expect(shortcutAction({ key: "Escape", target: { tagName: "INPUT" } })).toBe("close");
    expect(shortcutAction({ key: "j", target: { tagName: "BUTTON" } })).toBe("next");
  });
  it("documents every action once", () => {
    expect(new Set(SHORTCUTS.map((s) => s.action)).size).toBe(SHORTCUTS.length);
  });
});

describe("stepSelection", () => {
  const ids = ["a", "b", "c"];
  it("wraps in both directions", () => {
    expect(stepSelection(ids, "a", 1)).toBe("b");
    expect(stepSelection(ids, "c", 1)).toBe("a");
    expect(stepSelection(ids, "a", -1)).toBe("c");
  });
  it("starts at the ends with nothing selected and handles empty/unknown", () => {
    expect(stepSelection(ids, null, 1)).toBe("a");
    expect(stepSelection(ids, null, -1)).toBe("c");
    expect(stepSelection(ids, "zzz", 1)).toBe("a");
    expect(stepSelection([], "a", 1)).toBeNull();
  });
});
