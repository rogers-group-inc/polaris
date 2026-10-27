/**
 * tests/unit/mobileTopologyViews.test.ts — the phone topology's location views.
 *
 * The desktop's drill-down (Base → area → building → floor chips) on the
 * phone. Pinned here:
 *
 *   • THE ROWS are the desktop's viewSwitcherRows with Base folded into the
 *     head of the first row (a phone has no height for a row of one chip).
 *   • A ROW TOO LONG for the screen scrolls sideways with no scrollbar, and a
 *     chip its edge cuts fades AS A WHOLE — its opacity the share of it still
 *     showing — as the desktop's tab strips do; whole chips and chips wholly
 *     outside carry no opacity of their own.
 *   • THE VIEW drives the render the way it does on the desktop: the graph is
 *     partitioned to it, its saved layout is read under its key, the hull
 *     tiers it already is are suppressed, and a portal tap jumps views.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8");
const RENDER = read("public", "js", "topology-render.js");
const TAB = read("public", "js", "mobile", "topology-tab.js");
const CSS = read("public", "css", "mobile.css");
const g = globalThis as any;

type El = { data: Record<string, unknown> };
const node = (id: string, role: string, loc?: { b?: string; f?: string }): El => ({
  data: {
    id, role, label: id.toUpperCase(),
    ...(loc?.b ? { locB: loc.b.toLowerCase(), locBName: loc.b } : {}),
    ...(loc?.f ? { locF: loc.f.toLowerCase(), locFName: loc.f } : {}),
  },
});
const site = (): El[] => [
  node("fg", "fortigate"),
  node("s1", "fortiswitch", { b: "Shop", f: "1" }),
  node("s2", "fortiswitch", { b: "Shop", f: "2" }),
  node("o1", "fortiswitch", { b: "Office", f: "1" }),
];

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(RENDER)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(TAB)();
});

describe("viewChipRows", () => {
  it("folds Base into the head of the first row", () => {
    const views = g.PolarisTopologyRender.computeFloorViews(site());
    const rows = g.PolarisTopologyTab.viewChipRows(views, "flat");
    expect(rows.map((r: any[]) => r.map((c) => c.label))).toEqual([["Base", "Office", "Shop"]]);
    expect(rows[0][0].active).toBe(true);
  });

  it("adds the selected building's floors as a row of their own, the path lit", () => {
    const views = g.PolarisTopologyRender.computeFloorViews(site());
    const rows = g.PolarisTopologyTab.viewChipRows(views, "f||shop|2");
    expect(rows.map((r: any[]) => r.map((c) => c.label))).toEqual([["Base", "Office", "Shop"], ["1", "2"]]);
    expect(rows.map((r: any[]) => r.filter((c) => c.active).map((c) => c.label))).toEqual([["Shop"], ["2"]]);
  });

  it("is a single Base-only row when the site has one view level and nothing selected", () => {
    const views = g.PolarisTopologyRender.computeFloorViews([node("fg", "fortigate"), node("s1", "fortiswitch", { b: "Shop" })]);
    const rows = g.PolarisTopologyTab.viewChipRows(views, "flat");
    expect(rows.map((r: any[]) => r.map((c) => c.label))).toEqual([["Base", "Shop"]]);
  });
});

describe("fadeViewRow", () => {
  // A 200px window at x 0–200 holding chips at 0–80, 90–170, 180–260, 270–350.
  function row(): HTMLElement {
    const r = document.createElement("div");
    const rect = (left: number, width: number) => () => ({ left, right: left + width, width, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON() {} }) as DOMRect;
    r.getBoundingClientRect = rect(0, 200);
    [0, 90, 180, 270].forEach((left) => {
      const c = document.createElement("button");
      c.getBoundingClientRect = rect(left, 80);
      r.appendChild(c);
    });
    return r;
  }

  it("fades the chip the edge cuts by the share still showing; whole and hidden chips carry none", () => {
    const r = row();
    g.PolarisTopologyTab.fadeViewRow(r);
    const op = Array.from(r.children).map((c) => (c as HTMLElement).style.opacity);
    expect(op).toEqual(["", "", "0.250", ""]);
  });

  it("clears a fade once the chip is whole again", () => {
    const r = row();
    const third = r.children[2] as HTMLElement;
    third.style.opacity = "0.25";
    third.getBoundingClientRect = () => ({ left: 100, right: 180, width: 80, top: 0, bottom: 32, height: 32, x: 100, y: 0, toJSON() {} }) as DOMRect;
    g.PolarisTopologyTab.fadeViewRow(r);
    expect(third.style.opacity).toBe("");
  });
});

describe("the view drives the render", () => {
  it("partitions the graph, reads the view's saved layout and suppresses the tiers the view already is", () => {
    expect(TAB).toMatch(/partitionElementsForFloor\(elements, _activeView\)/);
    expect(TAB).toMatch(/layouts\[_activeView\]/);
    expect(TAB).toMatch(/renderLocationGroups\(_cy, suppress \? \{ suppressKinds: suppress \} : undefined\)/);
  });

  it("jumps views on a portal tap", () => {
    expect(TAB).toMatch(/node\.data\("isPortal"\)[\s\S]{0,200}setView\(target\)/);
  });

  it("scrolls a long row sideways with no scrollbar", () => {
    const rule = CSS.slice(CSS.indexOf(".topo-view-row {"));
    expect(rule).toMatch(/overflow-x: auto;/);
    expect(rule).toMatch(/scrollbar-width: none;/);
    expect(CSS).toContain(".topo-view-row::-webkit-scrollbar { display: none; }");
  });
});
