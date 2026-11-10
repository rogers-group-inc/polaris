/**
 * tests/unit/chartTimeTicks.test.ts — the X axis every asset-details chart
 * draws (_chartTimeTicks / _chartXTicksSVG in public/js/assets.js).
 *
 * Until 2026-09-23 each renderer ticked the window at equal fifths. On a
 * 7-day window that is every 1.4 days (9/17 18:36, 9/19 04:12 …), so the
 * date-only labels skipped 9/18 and 9/22 outright, sat between the dashed
 * midnight lines instead of on them, and the last one, centred on the right
 * edge with 10px of padding, was cut in half. Pinned here:
 *  - a multi-day window ticks at LOCAL MIDNIGHT, every day, when there is room;
 *  - a sub-day window ticks on clock boundaries of a nice step;
 *  - HH:MM labels are never used past 4 days (the midnight lines stop naming
 *    their date there), and a midnight on a multi-day window reads M/D;
 *  - every tick lies inside the window, and the count respects the width;
 *  - a label at either end of the plot is anchored to that end, not centred.
 *
 * Every window is built from local Date parts, so the assertions hold in any
 * timezone the suite runs in.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assetsSource } from "./_assetsSource.js";

const lines = assetsSource().split(/\r?\n/);
function slice(startsWith: string, endsWith: string): string {
  const start = lines.findIndex((l) => l.startsWith(startsWith));
  const end = lines.findIndex((l, i) => i > start && l.startsWith(endsWith));
  if (start < 0 || end < 0) throw new Error(`assets.js: ${startsWith} … ${endsWith} not found`);
  return lines.slice(start, end).join("\n");
}
const pad2 = lines.find((l) => l.startsWith("function _chartPad2("));
const chartShared = readFileSync(resolve(__dirname, "../../public/js/chart-shared.js"), "utf8");
// The axis reads the operator's display timezone through chart-shared.js's
// zone helpers, which ask api.js timeZoneOpts(). `zone.tz` switches it: ""
// is "auto" (the browser's own zone — every case above the display-zone
// block), anything else an IANA zone.
const zone = { tz: "" };
const api = new Function(
  "zone",
  "var window = {};\n" +
  "function timeZoneOpts() { return zone.tz ? { timeZone: zone.tz } : {}; }\n" +
  `${chartShared}\nvar PolarisChartShared = window.PolarisChartShared;\n` +
  `${pad2}\n${slice("var _CHART_TICK_STEPS_MS", "function _chartXScale(")}\n` +
  `${slice("function _dateChangeMarkers(", "// ─── Maintenance-window chart bands")}\n` +
  "return { ticks: _chartTimeTicks, svg: _chartXTicksSVG, markers: _dateChangeMarkers, Z: PolarisChartShared };",
)(zone) as {
  ticks: (t0: number, t1: number, innerW: number) => { ts: number; label: string }[];
  svg: (t0: number, t1: number, padL: number, padT: number, innerW: number, innerH: number, opts?: { dateLine?: boolean }) => string;
  markers: (t0: number, t1: number, padL: number, padT: number, innerW: number, innerH: number) => string;
  Z: { zoneMidnight: (ts: number) => number; addZoneDays: (ts: number, n: number) => number; zoneParts: (ts: number) => { hour: number; day: number; month: number } };
};

const at = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).getTime();

describe("_chartTimeTicks", () => {
  it("ticks a 7-day window at every local midnight — 9/18 and 9/22 included", () => {
    const t = api.ticks(at(9, 16, 9, 12), at(9, 23, 9, 12), 1000);
    expect(t.map((x) => x.label)).toEqual(["9/17", "9/18", "9/19", "9/20", "9/21", "9/22", "9/23"]);
    for (const x of t) {
      const d = new Date(x.ts);
      expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
    }
  });

  it("widens the day step instead of crowding a narrow plot", () => {
    const t = api.ticks(at(9, 1), at(9, 30), 300); // room for 3 labels
    expect(t.length).toBeLessThanOrEqual(3);
    expect(t.length).toBeGreaterThanOrEqual(2);
    for (const x of t) expect(new Date(x.ts).getHours()).toBe(0);
  });

  it("ticks a 24-hour window on clock-hour multiples of its step", () => {
    const t0 = at(9, 22, 8, 37);
    const t1 = at(9, 23, 8, 37);
    // 12 labels fit; 2h could need 13 on a boundary-aligned day, so 3h.
    const t = api.ticks(t0, t1, 1000);
    expect(t.map((x) => x.label)).toEqual(["09:00", "12:00", "15:00", "18:00", "21:00", "00:00", "03:00", "06:00"]);
  });

  it("names a multi-day window's midnights by date, and never uses HH:MM past 4 days", () => {
    const three = api.ticks(at(9, 20, 9), at(9, 23, 9), 1000);
    expect(three.some((x) => x.label === "9/21")).toBe(true);
    expect(three.some((x) => x.label === "00:00")).toBe(false);
    const five = api.ticks(at(9, 18, 9), at(9, 23, 9), 2000);
    expect(five.every((x) => /^\d+\/\d+$/.test(x.label))).toBe(true);
  });

  it("keeps every tick inside the window and within the width budget", () => {
    const spans: [number, number][] = [
      [at(9, 23, 8, 0), at(9, 23, 9, 0)],
      [at(9, 23, 0, 3), at(9, 23, 11, 59)],
      [at(9, 16, 5), at(9, 23, 5)],
      [at(8, 24, 13), at(9, 23, 13)],
    ];
    for (const [t0, t1] of spans) {
      for (const w of [300, 600, 1000]) {
        const t = api.ticks(t0, t1, w);
        expect(t.length).toBeGreaterThan(0);
        expect(t.length).toBeLessThanOrEqual(Math.max(2, Math.floor(w / 80)));
        for (const x of t) {
          expect(x.ts).toBeGreaterThanOrEqual(t0);
          expect(x.ts).toBeLessThanOrEqual(t1);
        }
      }
    }
  });
});

describe("_chartXTicksSVG", () => {
  const anchors = (svg: string) =>
    [...svg.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)</g)].map((m) => ({
      x: Number(m[1]),
      anchor: m[2],
      label: m[3],
    }));

  it("anchors a tick label on the right edge to the end so it is not clipped", () => {
    // A window that ends exactly at midnight puts the 9/23 tick on the edge.
    const svg = api.svg(at(9, 16), at(9, 23), 56, 10, 1000, 134);
    const labels = anchors(svg);
    const last = labels[labels.length - 1];
    expect(last.label).toBe("9/23");
    expect(last.x).toBeCloseTo(1056, 5);
    expect(last.anchor).toBe("end");
    expect(labels.filter((l) => l.anchor === "middle").length).toBeGreaterThan(0);
  });

  it("with dateLine, writes the date under the first tick and at each day change", () => {
    const svg = api.svg(at(9, 22, 18), at(9, 23, 6), 56, 10, 1000, 134, { dateLine: true });
    const dates = anchors(svg).filter((l) => /^\d+\/\d+$/.test(l.label)).map((l) => l.label);
    expect(dates).toEqual(["9/22", "9/23"]);
  });
});

// ─── On the operator's display timezone (CQ-F017) ─────────────────────────────
// The axis used to be laid out on the BROWSER's zone while every other
// timestamp moved to the display zone. These windows are built from UTC
// instants in zones the suite does not run in (UTC in CI), so a browser-zone
// axis fails them.
describe("the axis on a display timezone", () => {
  const H = 3600000;
  const D = 86400000;
  afterEach(() => { zone.tz = ""; });

  it("ticks a 7-day window at the display zone's midnights (Asia/Kolkata, +05:30)", () => {
    zone.tz = "Asia/Kolkata";
    const t0 = Date.UTC(2026, 8, 15, 18, 30); // 9/16 00:00 IST
    const ticks = api.ticks(t0, t0 + 7 * D, 1000);
    expect(ticks.map((t) => t.label)).toEqual(["9/16", "9/17", "9/18", "9/19", "9/20", "9/21", "9/22", "9/23"]);
    for (const t of ticks) expect((t.ts + 5.5 * H) % D).toBe(0);
  });

  it("ticks a day on the display zone's whole hours, which are UTC half-hours there", () => {
    zone.tz = "Asia/Kolkata";
    const t0 = Date.UTC(2026, 8, 20, 0, 0);
    const ticks = api.ticks(t0, t0 + D, 1000);
    expect(ticks.length).toBeGreaterThan(3);
    for (const t of ticks) {
      expect(t.label).toMatch(/^\d\d:00$/);
      expect(t.ts % H).toBe(30 * 60 * 1000);
    }
  });

  it("draws the midnight lines and their dates in the display zone", () => {
    zone.tz = "Asia/Kolkata";
    const t0 = Date.UTC(2026, 8, 20, 12, 0); // 9/20 17:30 IST
    const svg = api.markers(t0, t0 + D, 56, 10, 1000, 134);
    const labels = [...svg.matchAll(/>(\d+\/\d+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["9/21"]);
    const x = Number(svg.match(/<line x1="([\d.]+)"/)![1]);
    // 9/21 00:00 IST is 6.5 h into the window.
    expect(x).toBeCloseTo(56 + (6.5 / 24) * 1000, 5);
  });

  it("steps whole calendar days across a DST change, never 24 h (America/New_York, 2026-11-01)", () => {
    zone.tz = "America/New_York";
    const oct31 = api.Z.zoneMidnight(Date.UTC(2026, 9, 31, 12));
    expect(oct31).toBe(Date.UTC(2026, 9, 31, 4)); // 00:00 EDT
    const nov1 = api.Z.addZoneDays(oct31, 1);
    const nov2 = api.Z.addZoneDays(oct31, 2);
    expect(nov1).toBe(Date.UTC(2026, 10, 1, 4)); // 00:00 EDT
    expect(nov2).toBe(Date.UTC(2026, 10, 2, 5)); // 00:00 EST — a 25 h day
    // A week across the change ticks at every local midnight, before and after.
    const t0 = api.Z.zoneMidnight(Date.UTC(2026, 9, 29, 12));
    const ticks = api.ticks(t0, api.Z.addZoneDays(t0, 7), 1000);
    expect(ticks.map((t) => t.label)).toEqual(["10/29", "10/30", "10/31", "11/1", "11/2", "11/3", "11/4", "11/5"]);
    for (const t of ticks) expect(api.Z.zoneParts(t.ts).hour).toBe(0);
  });

  it("on auto the helpers are the browser's own Date calls", () => {
    const t = new Date(2026, 8, 20, 15, 45, 12).getTime();
    expect(api.Z.zoneParts(t)).toMatchObject({ month: 9, day: 20, hour: 15 });
    expect(api.Z.zoneMidnight(t)).toBe(new Date(2026, 8, 20).getTime());
  });
});
