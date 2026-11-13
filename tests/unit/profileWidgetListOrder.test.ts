/**
 * tests/unit/profileWidgetListOrder.test.ts — on a manufacturer profile, a new
 * widget lands at the TOP of the Custom widgets list (2026-11-13): the New
 * widget form opens above the existing widgets, and the list sorts by Order,
 * then newest first (`_mfgWidgetListOrder`, `renderWidgetSection` in
 * public/js/server-settings-profiles.js). It used to be alphabetical with the
 * form at the bottom, so on a 28-widget APC profile both were out of sight.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/server-settings-profiles.js"), "utf8").split(/\r?\n/);
const fn = (name: string) => {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
};

beforeAll(() => {
  new Function("g", [fn("_mfgWidgetListOrder"), fn("renderWidgetSection")].join("\n") +
    "\ng._mfgWidgetListOrder = _mfgWidgetListOrder; g.renderWidgetSection = renderWidgetSection;")(g);
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g._mfgAddingWidget = {};
  g.renderWidgetCard = (_p: string, w: { id: string }) => `<div class="card" data-id="${w.id}"></div>`;
  g.renderAddWidgetCard = () => '<div class="mfg-widget-add-card"></div>';
});

const W = (id: string, name: string, createdAt?: string, order = 0) => ({ id, name, order, ...(createdAt ? { createdAt } : {}) });

describe("_mfgWidgetListOrder", () => {
  it("puts the newest widget first among equal Order values", () => {
    const out = g._mfgWidgetListOrder([
      W("a", "Alpha", "2026-11-11T10:00:00.000Z"),
      W("z", "Zulu (new)", "2026-11-13T09:00:00.000Z"),
      W("m", "Mike", "2026-11-12T10:00:00.000Z"),
    ]);
    expect(out.map((w: { id: string }) => w.id)).toEqual(["z", "m", "a"]);
  });

  it("still honours an explicit Order first", () => {
    const out = g._mfgWidgetListOrder([W("new", "New", "2026-11-13T00:00:00.000Z", 5), W("old", "Old", "2026-01-01T00:00:00.000Z", 0)]);
    expect(out.map((w: { id: string }) => w.id)).toEqual(["old", "new"]);
  });

  it("falls back to the name when no creation time is known", () => {
    const out = g._mfgWidgetListOrder([W("b", "Bravo"), W("a", "Alpha")]);
    expect(out.map((w: { id: string }) => w.id)).toEqual(["a", "b"]);
  });
});

describe("renderWidgetSection", () => {
  it("opens the New widget form above the existing widgets", () => {
    g._mfgAddingWidget = { p1: true };
    document.body.innerHTML = g.renderWidgetSection({ id: "p1", manufacturer: "APC", widgets: [W("a", "Alpha", "2026-11-11T00:00:00.000Z")] });
    const order = Array.from(document.querySelectorAll(".mfg-widget-add-card, .card")).map((e) => e.className);
    expect(order).toEqual(["mfg-widget-add-card", "card"]);
  });
});
