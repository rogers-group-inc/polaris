/**
 * tests/unit/recurrenceRulesEditor.test.ts — the RULES editor in
 * `window.PolarisRecurrence` (public/js/recurrence-editor.js): "which days,
 * and either all day or these hours", one rule per sentence, replacing the
 * seven day rows on every schedule surface (quiet time and Maintenance).
 *
 * What is pinned: a stored shape renders as the fewest rules that say it and
 * collects back to the SAME shape (an untouched schedule must re-save
 * byte-identical — the overnight 22:00–06:00 range stays one range on its
 * start day, never rebuilt from minutes); the collapse contract is
 * collectDayEditor's; two rules overlapping on one day are refused by day;
 * the invert derives "everything else" with midnight stitched; presets apply
 * through the delegated handlers; and the week strip is seven rows of 48.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type AnyFn = (...a: any[]) => any;
interface Rec { rulesEditorHtml: AnyFn; wireRulesEditor: AnyFn; collectRulesEditor: AnyFn; fillRulesEditor: AnyFn; rulesFromShape: AnyFn }

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let rec: Rec;
let win: Window;

beforeAll(() => {
  win = new Window();
  g.window = win;
  g.document = win.document;
  doc = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  rec = (win as unknown as { PolarisRecurrence: Rec }).PolarisRecurrence;
});

const NIGHT = [{ startTime: "22:00", endTime: "06:00" }];
const PRESETS = [
  { key: "nights", label: "Nights and weekends", rules: [{ days: [1, 2, 3, 4, 5], ranges: NIGHT }, { days: [0, 6], ranges: [] }] },
  { key: "business", label: "Outside business hours", invert: true, rules: [{ days: [1, 2, 3, 4, 5], ranges: [{ startTime: "08:00", endTime: "18:00" }] }] },
];

function mount(shape?: unknown, opts: Record<string, unknown> = {}): Element {
  const host = doc.createElement("div");
  host.innerHTML = rec.rulesEditorHtml("t", { shape, presets: PRESETS, invertLabel: "Quiet outside these hours", ...opts });
  doc.body.appendChild(host);
  const root = host.querySelector(".rc-rules")!;
  rec.wireRulesEditor(root, null, PRESETS);
  return root;
}
const click = (el: Element) => (el as unknown as { click: () => void }).click();
const ruleCount = (root: Element) => root.querySelectorAll(".rc-rule").length;

describe("rules from a stored shape", () => {
  it("renders the default as ONE rule over all seven days", () => {
    const root = mount(null, { defaultStart: "20:00", defaultEnd: "02:00" });
    expect(ruleCount(root)).toBe(1);
    expect(rec.collectRulesEditor(root)).toEqual({ freq: "daily", hours: [{ startTime: "20:00", endTime: "02:00" }] });
  });

  it("groups days that keep the same hours into one rule, calendar order", () => {
    const shape = { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hoursByDay: [
      { dow: 0, hours: [] }, { dow: 1, hours: NIGHT }, { dow: 2, hours: NIGHT }, { dow: 3, hours: NIGHT }, { dow: 4, hours: NIGHT }, { dow: 5, hours: NIGHT }, { dow: 6, hours: [] },
    ] };
    const rules = rec.rulesFromShape(shape, { start: "22:00", end: "06:00" });
    expect(rules).toEqual([{ days: [0, 6], ranges: [] }, { days: [1, 2, 3, 4, 5], ranges: NIGHT }]);
    expect(ruleCount(mount(shape))).toBe(2);
  });
});

describe("round trip — an untouched schedule re-saves byte-identical", () => {
  const cases = [
    { name: "daily one range", shape: { version: 1, kind: "recurring", freq: "daily", hours: NIGHT }, out: { freq: "daily", hours: NIGHT } },
    { name: "weekly subset", shape: { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [1, 3, 5], hours: [{ startTime: "20:00", endTime: "02:00" }] }, out: { freq: "weekly", daysOfWeek: [1, 3, 5], hours: [{ startTime: "20:00", endTime: "02:00" }] } },
    { name: "daily all day", shape: { version: 1, kind: "recurring", freq: "daily" }, out: { freq: "daily" } },
    { name: "two ranges a day", shape: { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "12:00", endTime: "13:00" }, { startTime: "22:00", endTime: "06:00" }] }, out: { freq: "daily", hours: [{ startTime: "12:00", endTime: "13:00" }, { startTime: "22:00", endTime: "06:00" }] } },
    { name: "nights + weekend (per-day)", shape: { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hoursByDay: [{ dow: 0, hours: [] }, { dow: 1, hours: NIGHT }, { dow: 2, hours: NIGHT }, { dow: 3, hours: NIGHT }, { dow: 4, hours: NIGHT }, { dow: 5, hours: NIGHT }, { dow: 6, hours: [] }] },
      out: { freq: "weekly", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hoursByDay: [{ dow: 0, hours: [] }, { dow: 1, hours: NIGHT }, { dow: 2, hours: NIGHT }, { dow: 3, hours: NIGHT }, { dow: 4, hours: NIGHT }, { dow: 5, hours: NIGHT }, { dow: 6, hours: [] }] } },
    { name: "legacy startTime/endTime pair", shape: { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [2], startTime: "01:00", endTime: "03:00" }, out: { freq: "weekly", daysOfWeek: [2], hours: [{ startTime: "01:00", endTime: "03:00" }] } },
  ];
  for (const c of cases) {
    it(`re-collects ${c.name}`, () => {
      expect(rec.collectRulesEditor(mount(c.shape))).toEqual(c.out);
    });
  }
});

describe("what it refuses", () => {
  it("a rule with no day ticked", () => {
    const root = mount(null);
    click(root.querySelector(".rc-rule-add")!);
    expect(rec.collectRulesEditor(root).error).toMatch(/Period 2: pick at least one day/);
  });

  it("two rules that overlap on one day, by day", () => {
    const root = mount({ version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [1], hours: NIGHT });
    click(root.querySelector(".rc-rule-add")!); // a second rule, no days, default 22:00–06:00
    const second = root.querySelectorAll(".rc-rule")[1]!;
    click(second.querySelector('.rc-chip[data-dow="1"]')!);
    (second.querySelector(".rc-start") as HTMLInputElement).value = "23:00";
    (second.querySelector(".rc-end") as HTMLInputElement).value = "01:00";
    expect(rec.collectRulesEditor(root).error).toMatch(/^Mon: 22:00–06:00 overlaps 23:00–01:00/);
  });

  it("an all-day period sharing a day with an hours period, by day — the union would hide the double listing", () => {
    const root = mount(null);
    click(root.querySelector('.rc-preset[data-preset="nights"]')!);
    // Tick Sunday on the weeknight rule too — the mis-click behind the first bug report.
    click(root.querySelectorAll(".rc-rule")[0]!.querySelector('.rc-chip[data-dow="0"]')!);
    expect(rec.collectRulesEditor(root).error).toMatch(/^Sun: all day overlaps 22:00–06:00/);
  });

  it("a preset's overnight range running into the next all-day day is NOT a conflict", () => {
    const root = mount(null);
    click(root.querySelector('.rc-preset[data-preset="nights"]')!);
    // Friday 22:00–06:00 spills into Saturday, which is all day: the normal
    // shape, so the strip paints Saturday in the plain colour, not the warning one.
    const satCells = Array.from(root.querySelectorAll(".rc-strip > div")[6]!.querySelectorAll("i")) as HTMLElement[];
    expect(satCells.some((c) => c.getAttribute("style")!.includes("--color-warning"))).toBe(false);
    expect(satCells.every((c) => c.getAttribute("style")!.includes("--color-accent"))).toBe(true);
    // And the preset leaves Sunday OFF the weeknight rule.
    expect(root.querySelectorAll(".rc-rule")[0]!.querySelector('.rc-chip[data-dow="0"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(rec.collectRulesEditor(root).error).toBeUndefined();
  });

  it("reports nothing picked as empty, not an error", () => {
    const root = mount(null);
    click(root.querySelector(".rc-rule-remove")!);
    expect(rec.collectRulesEditor(root)).toEqual({ empty: true });
  });
});

describe("presets and invert", () => {
  it("a preset replaces the rules and marks itself; any edit unmarks it", () => {
    const root = mount(null);
    click(root.querySelector('.rc-preset[data-preset="nights"]')!);
    expect(ruleCount(root)).toBe(2);
    expect(root.querySelector('.rc-preset[data-preset="nights"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(rec.collectRulesEditor(root)).toEqual({ freq: "weekly", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hoursByDay: [
      { dow: 0, hours: [] }, { dow: 1, hours: NIGHT }, { dow: 2, hours: NIGHT }, { dow: 3, hours: NIGHT }, { dow: 4, hours: NIGHT }, { dow: 5, hours: NIGHT }, { dow: 6, hours: [] },
    ] });
    click(root.querySelectorAll(".rc-rule")[1]!.querySelector('.rc-chip[data-dow="6"]')!);
    expect(root.querySelector('.rc-preset[data-preset="nights"]')!.getAttribute("aria-pressed")).toBe("false");
  });

  it("the invert turns working hours into everything else, stitching midnight", () => {
    const root = mount(null);
    click(root.querySelector('.rc-preset[data-preset="business"]')!);
    expect((root.querySelector(".rc-invert") as HTMLInputElement).checked).toBe(true);
    const got = rec.collectRulesEditor(root);
    expect(got.freq).toBe("weekly");
    expect(got.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const byDow = Object.fromEntries(got.hoursByDay.map((d: { dow: number; hours: unknown }) => [d.dow, d.hours]));
    // Monday: 00:00–08:00 came from Sunday's run (all day, no stitch); 18:00 runs into Tuesday 08:00.
    expect(byDow[1]).toEqual([{ startTime: "00:00", endTime: "08:00" }, { startTime: "18:00", endTime: "08:00" }]);
    expect(byDow[2]).toEqual([{ startTime: "18:00", endTime: "08:00" }]);
    // Friday evening runs into the all-day weekend, which is "all day" on its own.
    expect(byDow[5]).toEqual([{ startTime: "18:00", endTime: "00:00" }]);
    expect(byDow[6]).toEqual([]);
    expect(byDow[0]).toEqual([]);
  });
});

describe("the week strip and the per-day breakdown", () => {
  it("paints seven rows of 48 half-hour cells and lists each day", () => {
    const root = mount({ version: 1, kind: "recurring", freq: "daily", hours: NIGHT });
    expect(root.querySelectorAll(".rc-strip > div").length).toBe(7);
    expect(root.querySelectorAll(".rc-strip > div")[0]!.querySelectorAll("i").length).toBe(48);
    const rows = root.querySelectorAll(".rc-perday-table tbody tr");
    expect(rows.length).toBe(7);
    expect(rows[1]!.textContent).toContain("22:00–06:00");
    expect(root.querySelector(".rc-summary")!.textContent).toBe("Daily 22:00–06:00");
  });

  it("fillRulesEditor re-seeds the list and keeps the handlers", () => {
    const root = mount(null);
    rec.fillRulesEditor(root, { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 6] });
    expect(ruleCount(root)).toBe(1);
    expect(rec.collectRulesEditor(root)).toEqual({ freq: "weekly", daysOfWeek: [0, 6] });
    click(root.querySelector(".rc-rule-add")!);
    expect(ruleCount(root)).toBe(2);
  });
});
