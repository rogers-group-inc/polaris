/**
 * tests/unit/outageMarkersEdgeGuard.test.ts — pins when a probe outage window
 * is drawn on a stream with no per-sample success flag (CPU / memory,
 * storage, interfaces), on both the desktop (`_outageMarkers` in
 * public/js/assets.js) and the mobile port (`outageMarkers` in
 * public/js/mobile/charts.js).
 *
 * The previous guard padded each window by half the series' median cadence
 * and discarded it when ANY sample fell in the padding. The last good
 * telemetry poll before a device drops and the first after it recovers sit
 * right against the outage edges nearly every time (telemetry every 5-10 min,
 * probe every minute), so most real outages were thrown away and the line
 * bridged them. On the hourly / daily tiers the padding was 30 min / 12 h and
 * swallowed almost every window — the "12h / 7d / 30d show no misses" report.
 *
 * mobileChartsFailureFade.test.ts keeps the original 1-minute-cadence cases;
 * this file covers the realistic cadences that hid the bug.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type Outage = { from: string; to: string; kind?: string };
type Marker = { t: number; dep: boolean };
type MarkersFn = (outages: Outage[] | undefined, sampleTimesMs: number[]) => Marker[];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;

/** Slice one top-level `function name(...) { ... }` out of a source file. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf("\nfunction " + name + "(");
  if (start < 0) throw new Error("function not found: " + name);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start + 1, end + 2);
}

const impls: Record<string, MarkersFn> = {};

beforeAll(() => {
  const desktopSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
  const body = ["_medianCadenceMs", "_seriesReportedThrough", "_outageMarkers"]
    .map((n) => extractFunction(desktopSrc, n))
    .join("\n");
  impls.desktop = new Function(body + "\nreturn _outageMarkers;")() as MarkersFn;

  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/mobile/charts.js"), "utf8"));
  impls.mobile = (win as unknown as { PolarisCharts: { _outageMarkers: MarkersFn } }).PolarisCharts._outageMarkers;
});

function outage(fromMs: number, toMs: number, kind?: string): Outage {
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), kind };
}

/** Timestamps every `stepMs` from `startMs` up to (excluding) `endMs`. */
function every(stepMs: number, startMs: number, endMs: number): number[] {
  const out: number[] = [];
  for (let t = startMs; t < endMs; t += stepMs) out.push(t);
  return out;
}

describe.each(["desktop", "mobile"])("%s outage markers", (which) => {
  const markers = (o: Outage[], ts: number[]) => impls[which](o, ts);

  it("draws an outage whose edges sit right against the last and first good poll", () => {
    // 5-minute telemetry. Last good poll 9:15, device drops and the probe
    // fails from 9:16; it comes back, the last failed probe is 11:49 and
    // telemetry resumes at 11:50. The old guard (2.5 min each side) caught
    // both neighbours and dropped this 2.5-hour outage entirely.
    const nine15 = T0 + 9 * HOUR + 15 * MIN;
    const eleven50 = T0 + 11 * HOUR + 50 * MIN;
    const ts = [...every(5 * MIN, T0, nine15 + 1), ...every(5 * MIN, eleven50, eleven50 + 2 * HOUR)];
    const from = nine15 + MIN, to = eleven50 - MIN;
    expect(markers([outage(from, to)], ts).map((m) => m.t)).toEqual([from, to]);
  });

  it("draws a short outage that swallowed exactly one telemetry poll", () => {
    // Telemetry at :00 :05 :10; the probe fails :04..:07, so the :05 poll has
    // no row. The neighbours are 10 min apart against a 5-minute cadence.
    const ts = every(5 * MIN, T0, T0 + HOUR).filter((t) => t !== T0 + 5 * MIN);
    const from = T0 + 4 * MIN, to = T0 + 7 * MIN;
    expect(markers([outage(from, to)], ts).map((m) => m.t)).toEqual([from, to]);
  });

  it("skips a blip the series polled straight through — no hole, nothing missing", () => {
    // A single failed probe at :07 between two telemetry polls that both
    // succeeded: the CPU reading is continuous and must not dive.
    const ts = every(5 * MIN, T0, T0 + HOUR);
    expect(markers([outage(T0 + 7 * MIN, T0 + 7 * MIN)], ts)).toEqual([]);
  });

  it("skips an outage an agent kept reporting through", () => {
    const ts = every(MIN, T0, T0 + HOUR);
    expect(markers([outage(T0 + 10 * MIN + 30_000, T0 + 25 * MIN + 30_000)], ts)).toEqual([]);
  });

  it("draws a fully failed hourly probe bucket on the hourly telemetry tier", () => {
    // Hourly rollups: telemetry buckets at every hour except 05:00. The probe
    // bucket for 05:00 failed entirely; its window runs to the bucket's end,
    // which is the 06:00 telemetry bucket's start. The old 30-minute guard
    // caught 06:00 and dropped it.
    const ts = every(HOUR, T0, T0 + 12 * HOUR).filter((t) => t !== T0 + 5 * HOUR);
    const from = T0 + 5 * HOUR, to = T0 + 6 * HOUR;
    expect(markers([outage(from, to)], ts).map((m) => m.t)).toEqual([from, to]);
  });

  it("draws a fully failed day on the daily tier", () => {
    const ts = every(DAY, T0, T0 + 30 * DAY).filter((t) => t !== T0 + 10 * DAY);
    const from = T0 + 10 * DAY, to = T0 + 11 * DAY;
    expect(markers([outage(from, to)], ts).map((m) => m.t)).toEqual([from, to]);
  });

  it("draws an outage still open at the right edge", () => {
    const ts = every(5 * MIN, T0, T0 + HOUR);
    const from = T0 + HOUR - 2 * MIN, to = T0 + HOUR + 10 * MIN;
    expect(markers([outage(from, to)], ts).map((m) => m.t)).toEqual([from, to]);
  });

  it("keeps the dependency grey flag", () => {
    const ts = every(5 * MIN, T0, T0 + HOUR).filter((t) => t !== T0 + 5 * MIN);
    const out = markers([outage(T0 + 4 * MIN, T0 + 7 * MIN, "dependency")], ts);
    expect(out.map((m) => m.dep)).toEqual([true, true]);
  });
});
