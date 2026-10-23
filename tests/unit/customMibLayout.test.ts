/**
 * tests/unit/customMibLayout.test.ts — the Custom MIB tab's per-profile widget
 * layout (the dashboard's column model, edited with the tab's pencil).
 *
 * Server half: `sanitizeWidgetLayout` is what makes a stored layout safe to
 * render for THIS profile — a stale editor must not keep a deleted widget or
 * carry in another profile's, and an off-grid width or height must fall back
 * rather than break the grid. Client half: the tab must still show a widget
 * created after the layout was saved (`_cmibCompleteLayout`), and a drag must
 * land a card exactly where the marker said (`_cmibMoveWidget`), dropping the
 * column it emptied.
 *
 * assets.js is a browser script with no module boundary, so the client
 * functions are sliced out by name and eval'd, as in assetAlertsTabDom.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeWidgetLayout } from "../../src/services/manufacturerProfileService.js";

const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found in assets.js`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const g = globalThis as Record<string, any>;
// eslint-disable-next-line no-new-func
new Function(
  "g",
  "var CMIB_WIDTHS = [3, 4, 6, 12];\n" +
  [fnSrc("_cmibIsMfr"), fnSrc("_cmibCompleteLayout")].join("\n") +
  "\ng._cmibCompleteLayout = _cmibCompleteLayout;",
)(g);
// _cmibMoveWidget / _cmibFindCol read the module-level `_cmib`; bind a fresh
// one per test.
// eslint-disable-next-line no-new-func
const bound = new Function("state", `var _cmib = state;\n${fnSrc("_cmibFindCol")}\n${fnSrc("_cmibMoveWidget")}\nreturn _cmibMoveWidget;`);

const W = (id: string, enabled: boolean | null = false) => ({ id, enabled });

describe("sanitizeWidgetLayout (server)", () => {
  const ids = new Set(["a", "b", "c"]);

  it("keeps a valid layout as is", () => {
    const layout = { version: 1, columns: [{ id: "c1", width: 6, widgets: [{ id: "a", height: 2 }, { id: "b", height: 1 }] }] };
    expect(sanitizeWidgetLayout(layout, ids)).toEqual(layout);
  });

  it("drops unknown and repeated widgets, then the columns they emptied", () => {
    const out = sanitizeWidgetLayout({ version: 1, columns: [
      { id: "c1", width: 3, widgets: [{ id: "gone", height: 1 }] },
      { id: "c2", width: 4, widgets: [{ id: "a", height: 1 }, { id: "a", height: 3 }, { id: "other-profile", height: 1 }] },
    ] }, ids);
    expect(out).toEqual({ version: 1, columns: [{ id: "c2", width: 4, widgets: [{ id: "a", height: 1 }] }] });
  });

  it("falls back on an off-grid width or height instead of failing", () => {
    const out = sanitizeWidgetLayout({ columns: [{ id: "c1", width: 7, widgets: [{ id: "a", height: 9 }] }] }, ids);
    expect(out).toEqual({ version: 1, columns: [{ id: "c1", width: 3, widgets: [{ id: "a", height: 1 }] }] });
  });

  it("is null for nothing usable, so the tab shows its default grid", () => {
    expect(sanitizeWidgetLayout(null, ids)).toBeNull();
    expect(sanitizeWidgetLayout({ columns: "x" }, ids)).toBeNull();
    expect(sanitizeWidgetLayout({ columns: [{ id: "c", width: 3, widgets: [{ id: "zzz", height: 1 }] }] }, ids)).toBeNull();
  });
});

describe("_cmibCompleteLayout (client)", () => {
  it("appends a widget the saved layout does not mention, and ignores Generic API widgets", () => {
    const saved = { version: 1, columns: [{ id: "c1", width: 6, widgets: [{ id: "a", height: 2 }, { id: "deleted", height: 1 }] }] };
    const out = g._cmibCompleteLayout(saved, [W("a"), W("new"), W("feed", null)]);
    expect(out.columns).toEqual([
      { id: "c1", width: 6, widgets: [{ id: "a", height: 2 }] },
      { id: "col-new", width: 3, widgets: [{ id: "new", height: 1 }] },
    ]);
  });

  it("with nothing saved gives every widget its own 3-wide column", () => {
    const out = g._cmibCompleteLayout(null, [W("a"), W("b")]);
    expect(out.columns.map((c: { width: number; widgets: unknown[] }) => [c.width, c.widgets.length])).toEqual([[3, 1], [3, 1]]);
  });
});

describe("_cmibMoveWidget (client)", () => {
  let state: { working: { version: 1; columns: Array<{ id: string; width: number; widgets: Array<{ id: string; height: number }> }> } };
  let move: (id: string, col: string | null, index: number) => void;

  beforeEach(() => {
    state = { working: { version: 1, columns: [
      { id: "c1", width: 6, widgets: [{ id: "a", height: 1 }, { id: "b", height: 2 }, { id: "c", height: 1 }] },
      { id: "c2", width: 3, widgets: [{ id: "d", height: 1 }] },
    ] } };
    move = bound(state);
  });

  const order = () => state.working.columns.map((c) => [c.id, c.widgets.map((w) => w.id).join("")]);

  it("reorders within a column, landing where the marker was", () => {
    move("a", "c1", 2); // dropped between b and c
    expect(order()).toEqual([["c1", "bac"], ["c2", "d"]]);
  });

  it("moves to another column and keeps the card's height", () => {
    move("b", "c2", 0);
    expect(order()).toEqual([["c1", "ac"], ["c2", "bd"]]);
    expect(state.working.columns[1].widgets[0]).toEqual({ id: "b", height: 2 });
  });

  it("starts a new column, and drops the column it emptied", () => {
    move("d", null, 0);
    expect(order().map((x) => x[1])).toEqual(["abc", "d"]);
    expect(state.working.columns).toHaveLength(2);
    expect(state.working.columns[1].id).not.toBe("c2");
  });
});
