/**
 * tests/unit/mobileTelemetryCharts.test.ts
 *
 * The phone's split CPU + Memory charts (public/js/mobile/telemetry-charts.js)
 * and the stacked-area renderer they draw memory with
 * (PolarisCharts.stackChart in public/js/mobile/charts.js): which sources get
 * them, per-core lines and their legend (tap toggles, double tap isolates),
 * the memory stack with Cache off by default and remembered, and the notes
 * that say why a series is missing.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSharedModules } from "./_sharedModules.js";

// assets.js / the mobile files read PolarisChartShared + PolarisAssetShared,
// which their pages load first (public/js/chart-shared.js, asset-shared.js).
loadSharedModules();

const read = (f: string) => readFileSync(join(process.cwd(), "public", "js", "mobile", f), "utf-8");
const CHARTS_SRC = read("charts.js");
const TELEMETRY_SRC = read("telemetry-charts.js");
const g = globalThis as any;

const GB = 1024 ** 3;

function load() {
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  loadSharedModules();
  new Function(CHARTS_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  loadSharedModules();
  new Function(TELEMETRY_SRC)();
  return g.PolarisTelemetryCharts;
}

// Four cores, an hour of agent samples a minute apart.
function agentSamples(count = 6, opts: { cores?: boolean } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 10, 2, 11, i)).toISOString(),
    cpuPct: 20 + i,
    cpuCorePcts: opts.cores === false ? null : [10 + i, 20 + i, 30 + i, 40 + i],
    memPct: 50,
    memTotalBytes: 16 * GB,
    memUsedBytes: 6 * GB,
    memBuffersBytes: 0.5 * GB,
    memCachedBytes: 4 * GB,
    swapUsedBytes: 0.25 * GB,
    swapTotalBytes: 2 * GB,
  }));
}

function render(tc: any, samples: any[], extra: any = {}) {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host")!;
  const ctx = {
    resp: { samples, stats: { avgCpuPct: 22, maxCpuPct: 25 }, tier: "detail", outages: [] },
    maint: [], asset: { id: "a1" }, range: "1h", bounds: null, hidden: {}, ...extra,
  };
  tc.render(host, ctx);
  return { host, ctx };
}

const chipLabels = (group: string) =>
  Array.from(document.querySelectorAll(`.series-chip[data-group="${group}"]`)).map((c) => (c as HTMLElement).textContent!.trim());
const chipOn = (group: string, key: string) =>
  document.querySelector(`.series-chip[data-group="${group}"][data-series="${key}"]`)!.getAttribute("aria-pressed") === "true";
const cpuLines = () => document.querySelectorAll("#asset-cpu-chart polyline").length;
const bandsDrawn = () => Array.from(new Set(Array.from(document.querySelectorAll("#asset-mem-chart .stack-band")).map((p) => (p as HTMLElement).dataset.band)));
const tap = (group: string, key: string) =>
  (document.querySelector(`.series-chip[data-group="${group}"][data-series="${key}"]`) as HTMLElement).click();

beforeEach(() => {
  try { localStorage.clear(); } catch { /* happy-dom always has it */ }
});

describe("which sources get the split charts", () => {
  it("the agent and vCenter always; Unraid, TrueNAS and Proxmox only on a host", () => {
    const tc = load();
    expect(tc.splits("agent", {})).toBe(true);
    expect(tc.splits("vcenter", {})).toBe(true);
    for (const m of ["unraid", "truenas", "proxmox"]) {
      expect(tc.splits(m, { virtualization: { role: "host" } })).toBe(true);
      expect(tc.splits(m, { virtualization: { role: "vm" } })).toBe(false);
      expect(tc.splits(m, {})).toBe(false);
    }
    for (const m of ["rest_api", "snmp", "winrm", "ssh", "icmp", null]) expect(tc.splits(m, {})).toBe(false);
  });
});

describe("per-core series", () => {
  it("transposes core vectors, leaving no point (not a zero) for a core a sample lacks", () => {
    const tc = load();
    const out = tc._coreSeries([
      { timestamp: "t1", cpuCorePcts: [1, 2, 3] },
      { timestamp: "t2", cpuCorePcts: [4, 5] },
      { timestamp: "t3", cpuCorePcts: [7, NaN, 9] },
    ]);
    expect(out.map((s: any[]) => s.map((p) => p.v))).toEqual([[1, 4, 7], [2, 5], [3, 9]]);
    expect(tc._coreSeries([{ timestamp: "t", cpuPct: 5 }])).toBeNull();
  });

  it("colours every core from the arc that excludes red, alternating lightness", () => {
    const tc = load();
    for (const n of [2, 8, 64]) {
      for (let i = 0; i < n; i++) {
        const m = /hsl\((\d+),68%,(\d+)%\)/.exec(tc._coreColor(i, n))!;
        expect(+m[1]).toBeGreaterThanOrEqual(35);
        expect(+m[1]).toBeLessThan(320);
        expect(+m[2]).toBe(i % 2 === 0 ? 46 : 63);
      }
    }
  });
});

describe("CPU chart", () => {
  it("draws the average on top of one line per core, with a chip for each", () => {
    const tc = load();
    render(tc, agentSamples());
    expect(chipLabels("cpu")).toEqual(["Avg", "Core 0", "Core 1", "Core 2", "Core 3"]);
    expect(cpuLines()).toBe(5);
    const lines = Array.from(document.querySelectorAll("#asset-cpu-chart polyline"));
    expect(lines.at(-1)!.getAttribute("stroke")).toBe("var(--md-primary)");
    expect(document.body.textContent).toContain("4 cores");
    expect(document.body.textContent).toContain("busiest Core 3 at 45%");
  });

  const chipEl = (group: string, key: string) =>
    document.querySelector(`.series-chip[data-group="${group}"][data-series="${key}"]`) as HTMLElement;
  const pointer = (el: Element, type: string, x = 0, y = 0) => {
    const ev = new Event(type, { bubbles: true }) as any;
    ev.clientX = x; ev.clientY = y;
    el.dispatchEvent(ev);
  };

  it("a tap switches a core off at once; Show all, beside the row, brings it back", () => {
    const tc = load();
    render(tc, agentSamples());
    tap("cpu", "2");
    expect(chipOn("cpu", "2")).toBe(false);
    expect(cpuLines()).toBe(4);
    const all = document.querySelector("[data-series-all]") as HTMLElement;
    // Outside the scrolling row, so a long row never pushes it out of reach.
    expect(all.closest(".series-legend")).toBeNull();
    expect(all.closest(".series-legend-bar")).not.toBeNull();
    all.click();
    expect(chipOn("cpu", "2")).toBe(true);
    expect(document.querySelector("[data-series-all]")).toBeNull();
  });

  it("a long-press shows only that core, keeps the average, and swallows the tap that ends it", () => {
    vi.useFakeTimers();
    try {
      const tc = load();
      const { ctx } = render(tc, agentSamples());
      pointer(chipEl("cpu", "1"), "pointerdown");
      vi.advanceTimersByTime(550);
      pointer(chipEl("cpu", "1"), "pointerup");
      chipEl("cpu", "1").click(); // the click a released press delivers
      expect(["0", "1", "2", "3"].filter((k) => chipOn("cpu", k))).toEqual(["1"]);
      expect(chipOn("cpu", "avg")).toBe(true);
      expect(cpuLines()).toBe(2);
      // The picks live on the caller's state object, so a re-render keeps them.
      expect(ctx.hidden).toEqual({ "0": true, "2": true, "3": true });
      // The next tap is a tap again.
      tap("cpu", "0");
      expect(chipOn("cpu", "0")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("a finger that drifts (scrolling the row) or lifts early is not a long-press", () => {
    vi.useFakeTimers();
    try {
      const tc = load();
      render(tc, agentSamples());
      pointer(chipEl("cpu", "2"), "pointerdown", 100, 10);
      pointer(chipEl("cpu", "2"), "pointermove", 130, 10);
      vi.advanceTimersByTime(600);
      expect(["0", "1", "2", "3"].every((k) => chipOn("cpu", k))).toBe(true);
      pointer(chipEl("cpu", "3"), "pointerdown");
      vi.advanceTimersByTime(200);
      pointer(chipEl("cpu", "3"), "pointerup");
      vi.advanceTimersByTime(600);
      expect(["0", "1", "2", "3"].every((k) => chipOn("cpu", k))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("Avg has no isolate — a long-press on it does nothing", () => {
    vi.useFakeTimers();
    try {
      const tc = load();
      render(tc, agentSamples());
      pointer(chipEl("cpu", "avg"), "pointerdown");
      vi.advanceTimersByTime(600);
      expect(["0", "1", "2", "3"].every((k) => chipOn("cpu", k))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("each legend is one scrolling row, fading only at an end with more past it", () => {
    const tc = load();
    render(tc, agentSamples());
    const rows = Array.from(document.querySelectorAll(".series-legend")) as HTMLElement[];
    expect(rows.map((r) => r.dataset.legend)).toEqual(["cpu", "mem"]);
    // happy-dom lays nothing out, so nothing overflows: no fade at either end.
    rows.forEach((r) => {
      expect(r.style.getPropertyValue("--fade-l")).toBe("0px");
      expect(r.style.getPropertyValue("--fade-r")).toBe("0px");
    });
    const css = readFileSync(join(process.cwd(), "public", "css", "mobile.css"), "utf-8");
    const rule = /\.series-legend \{[^}]*\}/.exec(css)![0];
    expect(rule).toContain("overflow-x: auto");
    expect(rule).toContain("scrollbar-width: none");
    expect(rule).toMatch(/mask-image: linear-gradient\(to right, transparent 0, #000 var\(--fade-l/);
    expect(css).toContain(".series-legend::-webkit-scrollbar { display: none; }");
  });

  it("says per-core detail is not kept on a rollup tier", () => {
    const tc = load();
    render(tc, agentSamples(6, { cores: false }), {
      resp: { samples: agentSamples(6, { cores: false }), stats: {}, tier: "hourly", outages: [] },
    });
    expect(chipLabels("cpu")).toEqual(["Avg"]);
    expect(document.body.textContent).toContain("Per-core detail is not kept in hourly buckets");
  });
});

describe("Memory chart", () => {
  it("stacks processes and buffers, keeps Cache off by default, and says where it went", () => {
    const tc = load();
    render(tc, agentSamples());
    expect(chipLabels("mem")).toEqual(["Processes", "Buffers", "Cache", "Swap"]);
    expect(chipOn("mem", "cache")).toBe(false);
    expect(bandsDrawn()).toEqual(["processes", "buffers"]);
    expect(document.querySelectorAll("#asset-mem-chart .stack-swap").length).toBe(1);
    expect(document.body.textContent).toContain("Cache hidden: counted in the gap, not in the stack.");
    expect(document.body.textContent).toContain("16 GB installed");
    // "In use" is every reported band, cache included — the desktop's inUse,
    // which a hidden chip does not change (the arithmetic never moves).
    expect(document.body.textContent).toContain("in use 10.5 GB of 16 GB (66%)");
  });

  it("a tap on Cache draws it and remembers the choice", () => {
    const tc = load();
    render(tc, agentSamples());
    tap("mem", "cache");
    expect(bandsDrawn()).toEqual(["processes", "buffers", "cache"]);
    expect(JSON.parse(localStorage.getItem(tc.PREFS_KEY)!)).toEqual({ cache: true });
    render(tc, agentSamples());
    expect(chipOn("mem", "cache")).toBe(true);
  });

  it("collapses a total-only source to one band and says so", () => {
    const tc = load();
    const samples = agentSamples().map((s) => ({ ...s, memBuffersBytes: null, memCachedBytes: null, swapUsedBytes: null }));
    render(tc, samples);
    expect(chipLabels("mem")).toEqual(["Processes"]);
    expect(document.body.textContent).toContain("This source reports a total only, with no cache or buffer breakdown.");
  });

  it("uses the hypervisor's vocabulary for a vSphere row", () => {
    const tc = load();
    const samples = agentSamples().map((s) => ({
      ...s, memUsedBytes: null, memBuffersBytes: null, memCachedBytes: null,
      memConsumedBytes: 8 * GB, memBalloonedBytes: 0,
    }));
    render(tc, samples);
    expect(chipLabels("mem")).toEqual(["Consumed", "Ballooned", "Swap"]);
    expect(document.body.textContent).toContain("As the hypervisor accounts for it");
  });

  it("names a TrueNAS host's bands in TrueNAS's words", () => {
    const tc = load();
    render(tc, agentSamples(), { asset: { virtualization: { platform: "truenas", role: "host" } } });
    expect(chipLabels("mem").slice(0, 3)).toEqual(["Services", "Buffers", "ZFS Cache"]);
  });

  it("falls back to a percentage line when no sample carries bytes", () => {
    const tc = load();
    render(tc, [{ timestamp: "2026-11-02T11:00:00Z", cpuPct: 5, memPct: 40 }, { timestamp: "2026-11-02T11:01:00Z", cpuPct: 6, memPct: 41 }]);
    expect(document.querySelector("#asset-mem-chart .stack-band")).toBeNull();
    expect(document.body.textContent).toContain("This source reports a percentage only");
  });
});

describe("stackChart", () => {
  afterEach(() => { vi.useRealTimers(); });
  const row = (min: number, total = 16 * GB) => ({
    ts: new Date(Date.UTC(2026, 10, 2, 11, min)).toISOString(), total, values: { a: 4 * GB, b: 2 * GB },
  });

  it("splits a band at an outage and drops a one-sample run", () => {
    load();
    const html = g.PolarisCharts.stackChart({
      samples: [row(0), row(1), row(2), row(10)],
      bands: [{ key: "a", color: "#f4a261" }],
      outages: [{ from: new Date(Date.UTC(2026, 10, 2, 11, 4)).toISOString(), to: new Date(Date.UTC(2026, 10, 2, 11, 6)).toISOString() }],
    });
    document.body.innerHTML = html;
    // [0,1,2] is one run; [10] alone is dropped.
    expect(document.querySelectorAll(".stack-band").length).toBe(1);
  });

  it("puts the axis ceiling at the whole and labels it in bytes", () => {
    load();
    document.body.innerHTML = g.PolarisCharts.stackChart({ samples: [row(0), row(1)], bands: [{ key: "a", color: "#f4a261" }] });
    const ticks = Array.from(document.querySelectorAll(".chart-y-tick")).map((t) => t.textContent);
    expect(ticks).toEqual(["16 GB", "8 GB", "0"]);
    expect(document.querySelectorAll(".stack-total").length).toBe(1);
  });

  it("formats bytes the way the OS reports memory", () => {
    load();
    expect(g.PolarisCharts.formatBytesAxis(16 * GB)).toBe("16 GB");
    expect(g.PolarisCharts.formatBytesAxis(6.5 * GB)).toBe("6.5 GB");
    expect(g.PolarisCharts.formatBytesAxis(512 * 1024 ** 2)).toBe("512 MB");
    expect(g.PolarisCharts.formatBytesAxis(0)).toBe("0");
  });

  // CQ-F018: the axis form is NOT api.js formatBytes ("16.0 GB", "" for
  // nothing) and must not borrow its name — mobile.html loads both.
  it("keeps the name formatBytes for api.js alone", () => {
    load();
    expect(g.PolarisCharts.formatBytes).toBeUndefined();
    const root = join(process.cwd(), "public", "js");
    const decl = /function\s+formatBytes\s*\(|\bformatBytes\s*:\s*[A-Za-z_]/;
    const files = ["api.js", "mobile/charts.js", "mobile/telemetry-charts.js", "mobile/asset-detail.js", "chart-shared.js"];
    const declaring = files.filter((f) => decl.test(readFileSync(join(root, f), "utf-8")));
    expect(declaring).toEqual(["api.js"]);
  });
});
