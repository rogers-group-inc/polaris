/**
 * tests/unit/hwSensorTableScroll.test.ts — the asset-details System tab's
 * Hardware Sensors table height cap (public/js/assets.js).
 *
 * The table renders the device's WHOLE sensor table, and a chassis publishes
 * dozens of rows (a FortiGate-201G walk is 30+ TMP/VOL/FAN/PSU entries), so
 * unbounded it pushed Storage, LLDP and every section below it off the panel.
 * Past HW_SENSOR_SCROLL_ROWS rows the wrapper is capped and scrolls under a
 * sticky header instead.
 *
 * What's pinned here is what would rot silently: the threshold is an INCLUSIVE
 * ceiling (a table of exactly 10 must not grow a scrollbar), the sticky class
 * has to reach the rendered DOM (the header scrolling away with the table is
 * the whole reason the cap needs `.table-wrapper-modal-sticky` and not bare
 * overflow), and the no-reading table behind the "Show N sensors" toggle is
 * capped by its OWN row count rather than inheriting the visible table's.
 *
 * assets.js is a ~18k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetAlertsTabDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { assetsSource } from "./_assetsSource.js";

const g = globalThis as Record<string, any>;

const assetsSrc = assetsSource();
const assetsLines = assetsSrc.split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

/** The threshold comes from the file so the test can't drift from the source. */
function thresholdSrc(): string {
  const line = assetsLines.find((l) => l.startsWith("var HW_SENSOR_SCROLL_ROWS ="));
  if (!line) throw new Error("assets.js: HW_SENSOR_SCROLL_ROWS not found");
  return line;
}

const FN_NAMES = ["_hwTableWrapper", "_hwClassLabel", "_hwReadingText", "_hwStatusCell", "_renderTemperatures"];
const SRC = thresholdSrc() + "\n" + FN_NAMES.map(fnSrc).join("\n") + "\n" +
  "globalThis.HW_SENSOR_SCROLL_ROWS = HW_SENSOR_SCROLL_ROWS;\n" +
  FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

function sensors(n: number, opts?: { unreadable?: boolean }) {
  return Array.from({ length: n }, (_, i) => ({
    sensorName: "TMP" + (i + 1),
    sensorClass: "temperature",
    value: opts?.unreadable ? null : 40 + i,
    unit: "°C",
    alarmStatus: "ok",
  }));
}

/** Render the section into a fresh container and hand back its wrappers. */
function render(hardwareSensors: any[]) {
  document.body.innerHTML = '<div id="hw"></div>';
  const el = document.getElementById("hw")!;
  g._renderTemperatures(el, { hardwareSensors, lastTelemetryAt: "2026-08-23T12:00:00Z" }, { id: "A1", assetType: "firewall" });
  return el;
}

beforeEach(() => {
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g._updateTemperatureUpdatedStamp = () => {};
  g._staleBannerHTML = () => "";
  g._isRestApiManagedNetworkDevice = () => false;
  g._resolvedStreamPolling = () => "snmp";
  g._assetMonitorStreamSource = () => ({ polling: "SNMP" });
  g._notAvailableViaPollingHTML = () => "<p>n/a</p>";
  g._assetTableTypeKey = (k: string) => k;
  g.openSensorDetailPanel = () => {};
  // applyTableLayout / PolarisTempUnit are both optional at the call sites.
  delete g.applyTableLayout;
  (globalThis as any).window.PolarisTempUnit = undefined;
  new Function(SRC)();
});

describe("_hwTableWrapper", () => {
  it("leaves a table at or under the threshold unbounded", () => {
    for (const n of [0, 1, g.HW_SENSOR_SCROLL_ROWS - 1, g.HW_SENSOR_SCROLL_ROWS]) {
      expect(g._hwTableWrapper(n)).toEqual({ cls: "table-wrapper", style: "" });
    }
  });

  it("caps and sticks the header one row past the threshold", () => {
    const w = g._hwTableWrapper(g.HW_SENSOR_SCROLL_ROWS + 1);
    expect(w.cls).toContain("table-wrapper-modal-sticky");
    expect(w.style).toMatch(/^max-height:\d+px$/);
  });

  it("caps to a fixed height, not a share of the viewport", () => {
    // A vh fraction shows a different number of rows per panel height, which
    // is what the row-derived cap exists to avoid — so the cap must not grow
    // with the row count either.
    const small = g._hwTableWrapper(g.HW_SENSOR_SCROLL_ROWS + 1).style;
    expect(g._hwTableWrapper(200).style).toBe(small);
  });
});

describe("Hardware Sensors table rendering", () => {
  it("renders a short table with no scroll wrapper", () => {
    const el = render(sensors(g.HW_SENSOR_SCROLL_ROWS));
    const wrap = el.querySelector("div.table-wrapper")!;
    expect(wrap.className).not.toContain("table-wrapper-modal-sticky");
    expect(wrap.getAttribute("style")).toBeNull();
    expect(el.querySelectorAll("tbody tr").length).toBe(g.HW_SENSOR_SCROLL_ROWS);
  });

  it("scrolls a long table under a sticky header", () => {
    const el = render(sensors(g.HW_SENSOR_SCROLL_ROWS + 1));
    const wrap = el.querySelector("div.table-wrapper")!;
    expect(wrap.className).toContain("table-wrapper-modal-sticky");
    expect(wrap.getAttribute("style")).toMatch(/max-height:\d+px/);
    // Every sensor is still in the DOM — the cap scrolls, it never truncates.
    expect(el.querySelectorAll("tbody tr").length).toBe(g.HW_SENSOR_SCROLL_ROWS + 1);
  });

  it("caps the no-reading table by its own row count", () => {
    // Two readable sensors (so the section renders) plus a long unreadable
    // tail: the visible table stays unbounded while the hidden one scrolls.
    const el = render([...sensors(2), ...sensors(g.HW_SENSOR_SCROLL_ROWS + 1, { unreadable: true })]);
    const wraps = el.querySelectorAll("div.table-wrapper");
    expect(wraps.length).toBe(2);
    expect(wraps[0].className).not.toContain("table-wrapper-modal-sticky");
    const hidden = wraps[1] as HTMLElement;
    expect(hidden.className).toContain("table-wrapper-modal-sticky");
    // The toggle's own margin survives alongside the cap.
    expect(hidden.getAttribute("style")).toMatch(/margin-top:0\.4rem;max-height:\d+px/);
  });
});
