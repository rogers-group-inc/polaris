/**
 * tests/unit/mobileChartsFailureFade.test.ts — pins the missed-poll rendering
 * in the mobile SPA's chart helper (`public/js/mobile/charts.js`).
 *
 * The mobile charts used to filter valueless samples out and let the polyline
 * bridge straight over the hole, so an outage was invisible on a phone. Now a
 * failed poll sits at the baseline in red with a gradient transition segment,
 * matching the desktop response-time chart. Two feeds have to keep working:
 * explicit `ok:false` points (monitor stream) and, for the telemetry stream
 * which has no per-sample success flag, the `gapFade` series combined with the
 * chart's `outages` list — the response-time probe's own failure record, which
 * replaced an inferred 2.5x-median-cadence gap heuristic.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type Point = { ts: string | number; v: number | null; ok?: boolean; dep?: boolean; rec?: boolean; down?: boolean };
type Series = { values: Point[]; color?: string; fill?: boolean; gapFade?: boolean };
type Prepared = { s: Series; pts: { ts: number; v: number | null; ok: boolean }[] };
type Charts = {
  lineChart: (opts: Record<string, unknown>) => string;
  _outageMarkers: (outages: Outage[] | undefined, sampleTimesMs: number[]) => number[];
  _medianCadenceMs: (ts: number[]) => number;
  _seriesPoints: (s: Series) => { ts: number; v: number | null; ok: boolean }[];
  _applySharedOutageMarkers: (prepared: Prepared[], outages?: Outage[]) => number[];
};

type Outage = { from: string; to: string };

/** Build an outage window from two epoch-ms instants. */
function outage(fromMs: number, toMs: number): Outage {
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

const FAIL = "#d32f2f";
const MISS = "#ffc107";
const RECOVER = "#0288d1";
const DEP = "#9aa0a6";
let charts: Charts;

beforeAll(() => {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  const src = readFileSync(resolve(__dirname, "../../public/js/mobile/charts.js"), "utf8");
  (0, eval)(src);
  charts = (win as unknown as { PolarisCharts: Charts }).PolarisCharts;
});

/** Minute-cadence timestamps starting at a fixed epoch. */
function minutes(count: number, startMs = 1_800_000_000_000, stepMin = 1): number[] {
  return Array.from({ length: count }, (_, i) => startMs + i * stepMin * 60_000);
}

function okSeries(ts: number[], v = 10): Series {
  return { values: ts.map((t) => ({ ts: t, v })) };
}

describe("outageMarkers", () => {
  it("marks nothing when the probe reported no outage, however wide the hole", () => {
    const ts = minutes(3);
    const withGap = [ts[0], ts[1], ts[2], ts[2] + 30 * 60_000, ts[2] + 31 * 60_000];
    expect(charts._outageMarkers([], withGap)).toEqual([]);
    expect(charts._outageMarkers(undefined, withGap)).toEqual([]);
  });

  it("brackets an outage with one marker at each end", () => {
    const ts = minutes(40);
    // The probe fails BETWEEN telemetry polls, so the outage sits strictly
    // inside the sampling hole: last good sample ts[5], first good again ts[20].
    const start = ts[6], end = ts[19];
    const sampled = [...ts.slice(0, 6), ...ts.slice(20)];
    // Markers are { t, dep } objects — `dep` picks red vs the dependency grey.
    expect(charts._outageMarkers([outage(start, end)], sampled).map((m) => m.t)).toEqual([start, end]);
  });

  it("collapses a single-probe outage to one marker", () => {
    const ts = minutes(10);
    expect(charts._outageMarkers([outage(ts[4], ts[4])], [ts[0], ts[1], ts[8], ts[9]]).map((m) => m.t)).toEqual([ts[4]]);
  });

  it("drops a marker that lands on real data — an agent keeps pushing when the probe transport fails", () => {
    // The probe says the device was unreachable, but the host's agent pushed
    // telemetry straight through it. Diving a line that has data would
    // misreport what we are holding.
    const ts = minutes(20);
    expect(charts._outageMarkers([outage(ts[5], ts[9])], ts)).toEqual([]);
  });

  it("ignores an unparseable window rather than plotting NaN", () => {
    const ts = minutes(6);
    expect(charts._outageMarkers([{ from: "nope", to: "also-nope" }], ts)).toEqual([]);
  });

  it("returns markers in time order", () => {
    const ts = minutes(60);
    const sampled = [ts[0], ts[1], ts[50], ts[51]];
    const out = charts._outageMarkers([outage(ts[30], ts[40]), outage(ts[5], ts[10])], sampled);
    expect(out).toEqual([...out].sort((a, b) => a - b));
    expect(out).toHaveLength(4);
  });
});

describe("seriesPoints", () => {
  it("keeps explicit failures as valueless baseline points", () => {
    const ts = minutes(3);
    const pts = charts._seriesPoints({
      values: [{ ts: ts[0], v: 5 }, { ts: ts[1], v: null, ok: false }, { ts: ts[2], v: 7 }],
    });
    expect(pts.map((p) => p.ok)).toEqual([true, false, true]);
    expect(pts[1].v).toBeNull();
  });

  it("drops valueless points that are not flagged as failures", () => {
    const ts = minutes(2);
    const pts = charts._seriesPoints({ values: [{ ts: ts[0], v: null }, { ts: ts[1], v: 3 }] });
    expect(pts).toHaveLength(1);
    expect(pts[0].v).toBe(3);
  });

  it("sorts out-of-order input and rejects unparseable timestamps", () => {
    const ts = minutes(3);
    const pts = charts._seriesPoints({
      values: [{ ts: ts[2], v: 3 }, { ts: "not-a-date", v: 9 }, { ts: ts[0], v: 1 }],
    });
    expect(pts.map((p) => p.ts)).toEqual([ts[0], ts[2]]);
  });

  it("does not infer gaps on its own — that is the shared pass's job", () => {
    const ts = minutes(3);
    const withGap = [ts[0], ts[1], ts[2], ts[2] + 30 * 60_000, ts[2] + 31 * 60_000];
    expect(charts._seriesPoints({ ...okSeries(withGap), gapFade: true }).every((p) => p.ok)).toBe(true);
  });
});

describe("applySharedOutageMarkers", () => {
  const ts = minutes(40);
  // Telemetry stops for the duration of the outage, then resumes; the outage
  // itself sits strictly inside that hole (see outageMarkers above).
  const withGap = [...ts.slice(0, 6), ...ts.slice(20)];
  const outages = [outage(ts[6], ts[19])];

  function prep(list: Series[], o: Outage[] | undefined = outages) {
    const prepared = list.map((s) => ({ s, pts: charts._seriesPoints(s) }));
    const marks = charts._applySharedOutageMarkers(prepared, o);
    return { prepared, marks };
  }

  it("leaves unflagged series alone", () => {
    const { prepared, marks } = prep([okSeries(withGap)]);
    expect(marks).toEqual([]);
    expect(prepared[0].pts.every((p) => p.ok)).toBe(true);
  });

  it("injects the markers into a flagged series", () => {
    const { prepared, marks } = prep([{ ...okSeries(withGap), gapFade: true }]);
    expect(marks).toHaveLength(2);
    expect(prepared[0].pts.filter((p) => !p.ok)).toHaveLength(2);
    // still time-ordered after injection
    const order = prepared[0].pts.map((p) => p.ts);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("derives one marker set from the union, so both series dive at the same x", () => {
    // memory reports only the first three samples; CPU spans the gap
    const { prepared, marks } = prep([
      { ...okSeries(withGap), gapFade: true },
      { ...okSeries(withGap.slice(0, 3)), gapFade: true },
    ]);
    const cpuMarks = prepared[0].pts.filter((p) => !p.ok).map((p) => p.ts);
    const memMarks = prepared[1].pts.filter((p) => !p.ok).map((p) => p.ts);
    expect(cpuMarks).toEqual(marks.map((m) => m.t));
    expect(memMarks).toEqual(marks.map((m) => m.t));
  });

  it("a series that simply stops reporting is not an outage without a probe failure", () => {
    // Memory stops partway through and the probe never failed. Under the old
    // gap heuristic a wide enough hole was reason enough; now it takes evidence.
    const full = minutes(8);
    const { marks } = prep([
      { ...okSeries(full), gapFade: true },
      { ...okSeries(full.slice(0, 4)), gapFade: true },
    ], []);
    expect(marks).toEqual([]);
  });
});

describe("lineChart missed-poll rendering", () => {
  it("draws no red at all for a fully successful series", () => {
    const svg = charts.lineChart({ series: [okSeries(minutes(6))] });
    expect(svg).not.toContain(FAIL);
    expect(svg).not.toContain("linearGradient");
  });

  it("fades into and out of red across an explicit failure", () => {
    const ts = minutes(4);
    const svg = charts.lineChart({
      series: [{
        color: "var(--md-primary)",
        values: [
          { ts: ts[0], v: 10 }, { ts: ts[1], v: 12 },
          { ts: ts[2], v: null, ok: false },
          { ts: ts[3], v: 11 },
        ],
      }],
    });
    // one gradient per OK↔fail transition — in and back out
    expect(svg.match(/<linearGradient /g)).toHaveLength(2);
    // each gradient runs between the series color and the failure color
    expect(svg).toContain('stop-color="var(--md-primary)"');
    expect(svg).toContain('stop-color="' + FAIL + '"');
    // and the failure gets its own baseline dot
    expect(svg).toContain('stroke-width="4"');
  });

  it("collapses runs of same-state points instead of emitting per-sample lines", () => {
    const ts = minutes(12);
    const values: Point[] = ts.map((t, i) => (i >= 4 && i <= 6 ? { ts: t, v: null, ok: false } : { ts: t, v: 20 }));
    const svg = charts.lineChart({ series: [{ values }] });
    // two OK runs + one failure run = 3 polylines, 2 gradient transition lines
    expect(svg.match(/<polyline /g)).toHaveLength(3);
    expect(svg.match(/<linearGradient /g)).toHaveLength(2);
    expect(svg.match(/<line [^>]*stroke="url\(#/g)).toHaveLength(2);
  });

  it("puts failures on the plot baseline, below every real value", () => {
    const ts = minutes(3);
    const svg = charts.lineChart({
      series: [{ values: [{ ts: ts[0], v: 50 }, { ts: ts[1], v: null, ok: false }, { ts: ts[2], v: 50 }] }],
      yMin: 0, yMax: 100, height: 120,
    });
    // plot height = 120 - TOP_GUTTER(4) - BOTTOM_GUTTER(18) = 98; baseline = 98 - pad(2)
    expect(svg).toContain('stroke-width="4"');
    const dot = /<line x1="[\d.]+" y1="([\d.]+)"[^>]*stroke-width="4"/.exec(svg);
    expect(dot).not.toBeNull();
    expect(Number(dot![1])).toBeCloseTo(96, 1);
  });

  it("renders a red baseline instead of 'No data' when every poll failed", () => {
    const svg = charts.lineChart({
      series: [{ values: minutes(5).map((t) => ({ ts: t, v: null, ok: false })) }],
    });
    expect(svg).not.toContain("No data");
    expect(svg).toContain('stroke="' + FAIL + '"');
  });

  it("fades a gapFade series across a reported outage, and leaves a plain one bridging", () => {
    const ts = minutes(40);
    const withGap = [...ts.slice(0, 6), ...ts.slice(20)];
    const outages = [outage(ts[6], ts[19])];
    const faded = charts.lineChart({
      series: [{ ...okSeries(withGap, 30), gapFade: true }],
      outages, yMin: 0, yMax: 100,
    });
    expect(faded).toContain(FAIL);
    expect(faded.match(/<linearGradient /g)).toHaveLength(2);

    // Same hole, same outage list — but without gapFade the series opts out.
    const plain = charts.lineChart({ series: [okSeries(withGap, 30)], outages, yMin: 0, yMax: 100 });
    expect(plain).not.toContain(FAIL);
  });

  it("bridges the same hole when the probe reported no outage", () => {
    // The hole alone is no longer evidence: without a probe failure behind it,
    // the line bridges. This is the case the old 2.5x gap heuristic got wrong
    // for unmounted disks and maintenance windows.
    const ts = minutes(40);
    const withGap = [...ts.slice(0, 6), ...ts.slice(20)];
    const svg = charts.lineChart({
      series: [{ ...okSeries(withGap, 30), gapFade: true }],
      outages: [], yMin: 0, yMax: 100,
    });
    expect(svg).not.toContain(FAIL);
  });

  it("still shows the empty state when there are no points at all", () => {
    expect(charts.lineChart({ series: [{ values: [] }] })).toContain("No data");
  });

  it("gives each chart and series its own gradient ids", () => {
    const failing: Series = {
      values: [{ ts: minutes(3)[0], v: 5 }, { ts: minutes(3)[1], v: null, ok: false }, { ts: minutes(3)[2], v: 5 }],
    };
    const a = charts.lineChart({ series: [failing, { ...failing, color: "red" }] });
    const b = charts.lineChart({ series: [failing] });
    const ids = (s: string) => (s.match(/<linearGradient id="([^"]+)"/g) || []).map((m) => m);
    const all = [...ids(a), ...ids(b)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("dips the filled area to the baseline over an outage", () => {
    const ts = minutes(3);
    const svg = charts.lineChart({
      series: [{
        fill: true,
        values: [{ ts: ts[0], v: 40 }, { ts: ts[1], v: null, ok: false }, { ts: ts[2], v: 40 }],
      }],
      yMin: 0, yMax: 100, height: 120,
    });
    const poly = /<polygon points="([^"]+)"/.exec(svg);
    expect(poly).not.toBeNull();
    // the middle vertex sits on the baseline, not interpolated between the peaks
    expect(poly![1].split(" ")[1]).toMatch(/,96\.0$/);
  });
});

describe("the verdict palette — the response-time chart's five colours", () => {
  // The phone draws the same chart the device page draws, so it draws the same
  // colours: green up, amber for a miss that has not reached the covering
  // automation's count, red for the miss that IS the verdict, purple for a poll
  // answering while misses are still outstanding, grey when the upstream
  // explains it. The states themselves come from the shared replay in
  // public/js/monitor-states.js, which the caller runs; the chart's job is only
  // to paint what it was handed, and these pin that it paints all five.
  const ts = minutes(6);

  it("paints a miss below the threshold amber, not red", () => {
    const svg = charts.lineChart({
      series: [{ values: [
        { ts: ts[0], v: 10 },
        { ts: ts[1], v: null, ok: false, down: false },
        { ts: ts[2], v: 10 },
      ] as Point[], color: "green" }],
    });
    expect(svg).toContain(MISS);
    expect(svg).not.toContain(FAIL);
  });

  it("turns red at the miss that is the verdict, and fades between the two", () => {
    const svg = charts.lineChart({
      series: [{ values: [
        { ts: ts[0], v: 10 },
        { ts: ts[1], v: null, ok: false, down: false },
        { ts: ts[2], v: null, ok: false, down: false },
        { ts: ts[3], v: null, ok: false, down: true },
        { ts: ts[4], v: 10 },
      ] as Point[], color: "green" }],
    });
    expect(svg).toContain(MISS);
    expect(svg).toContain(FAIL);
    expect(svg).toContain('stop-color="' + MISS + '"');
  });

  it("paints an answered poll purple while misses are still outstanding", () => {
    const svg = charts.lineChart({
      series: [{ values: [
        { ts: ts[0], v: null, ok: false, down: true },
        { ts: ts[1], v: 10, rec: true },
        { ts: ts[2], v: 10, rec: true },
        { ts: ts[3], v: 10 },
      ] as Point[], color: "green" }],
    });
    expect(svg).toContain(RECOVER);
    expect(svg).toContain("green");
  });

  it("keeps grey ahead of the amber/red split", () => {
    // A miss the upstream explains is not being counted against this device at
    // all, so how close it sits to the threshold says nothing worth colouring.
    const svg = charts.lineChart({
      series: [{ values: [
        { ts: ts[0], v: 10 },
        { ts: ts[1], v: null, ok: false, dep: true, down: false },
        { ts: ts[2], v: 10 },
      ] as Point[], color: "green" }],
    });
    expect(svg).toContain(DEP);
    expect(svg).not.toContain(MISS);
  });

  it("leaves a chart that resolved no threshold exactly as it was", () => {
    // Every other stream — CPU, memory, interface counters — never asks for a
    // verdict, so its misses stay red and nothing goes amber or purple.
    const svg = charts.lineChart({
      series: [{ values: [
        { ts: ts[0], v: 10 },
        { ts: ts[1], v: null, ok: false },
        { ts: ts[2], v: 10 },
      ] as Point[], color: "green" }],
    });
    expect(svg).toContain(FAIL);
    expect(svg).not.toContain(MISS);
    expect(svg).not.toContain(RECOVER);
  });
});

describe("legend", () => {
  const keyOf = (html: string): string[] => {
    const host = (globalThis as unknown as { document: Document }).document.createElement("div");
    host.innerHTML = html;
    return Array.from(host.querySelectorAll(".chart-state-legend > span")).map((s) => s.textContent ?? "");
  };

  it("names only the states the line drew, in the Status pill's order", () => {
    const ts = minutes(6);
    const html = charts.lineChart({
      legend: { series: "Up" },
      series: [{ values: [
        { ts: ts[0]!, v: null, ok: false, dep: true },
        { ts: ts[1]!, v: null, ok: false, dep: true },
        { ts: ts[2]!, v: 10, rec: true },
        { ts: ts[3]!, v: 10 },
        { ts: ts[4]!, v: 10 },
      ], color: "var(--md-success)" }],
    });
    expect(keyOf(html)).toEqual(["Up", "Recovering", "Parent down"]);
  });

  it("draws no key when the chart drew only its series", () => {
    const html = charts.lineChart({ legend: { series: "Up" }, series: [okSeries(minutes(5))] });
    expect(keyOf(html)).toEqual([]);
  });

  it("draws no key on a chart that did not ask for one", () => {
    const html = charts.lineChart({ series: [{ values: [
      { ts: 1, v: 10 }, { ts: 2, v: null, ok: false },
    ] }] });
    expect(html).not.toContain("chart-state-legend");
  });
});
