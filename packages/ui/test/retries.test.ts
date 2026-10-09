import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StoredEvent } from "@mar/core";
import { deriveAgents, retryCount } from "../src/derive.js";
import { Board } from "../src/Board.js";
import { Inspector } from "../src/Inspector.js";

const start = (id: number, attempt?: unknown): StoredEvent => ({ id, run_id: "r", task_id: "a", agent_id: "a", ts: id, type: "task_started", payload: { attempt } });
const row = { task_id: "a", status: "done", detail: null, attempt: 4 };

it("combines persisted attempts with live events without double counting or regressing", () => {
  expect(retryCount(deriveAgents([start(1)], [row])[0]!)).toBe(3);
  expect(retryCount(deriveAgents([start(1), start(2)], [])[0]!)).toBe(1);
  expect(retryCount(deriveAgents([start(1, 4), start(2, 2)], [])[0]!)).toBe(3);
  expect(retryCount(deriveAgents([start(1), start(1)], [])[0]!)).toBe(0);
  for (const attempt of [0, -2, 1.5, NaN, Infinity, "3", null]) expect(retryCount(deriveAgents([start(1, attempt)], [])[0]!)).toBe(0);
});

it("shows plural retry badges on board and inspector, hiding them on first attempts", () => {
  for (const attempt of [1, 2, 4]) {
    const agent = deriveAgents([], [{ ...row, attempt }])[0]!;
    const board = renderToStaticMarkup(createElement(Board, { groups: [{ key: "all", phase: null, title: "", summary: "", rows: [agent] }], total: 1, counts: { all: 1, running: 0, done: 1, failed: 0 }, chip: "all", onChip() {}, query: "", onQuery() {}, selected: null, onSelect() {}, now: 0, nowTexts: new Map() }));
    const inspector = renderToStaticMarkup(createElement(Inspector, { agent, events: [], blackboard: [], plan: null, width: null, onWidthChange() {}, onClose() {}, onTab() {} }));
    for (const html of [board, inspector]) {
      if (attempt === 1) expect(html).not.toContain("retry-badge");
      else expect(html).toContain(attempt === 2 ? "1 retry" : "3 retries");
    }
  }
});
