/**
 * tests/unit/assetCpuMemoryChartsDom.test.ts — the asset-details System tab's
 * CPU and Memory charts (public/js/assets.js).
 *
 * These were ONE chart until 2026-09: a CPU line and a memory line sharing a
 * 0–100% axis. Per-core CPU from the Polaris Agent turns the first into up to
 * 512 lines, and the memory half became a byte-scaled stack, so they split.
 * What this file pins is the handful of decisions that are only observable in
 * a browser and would otherwise rot silently:
 *
 *  - **No core line may be red or grey.** Red is the missed-poll colour on
 *    every chart in this app and grey is dependency-down (business rule 38).
 *    A core drawn in either reads as an outage marker, which is the one
 *    reading an operator must never get wrong. The palette therefore spans a
 *    hue arc that excludes red, and this test asserts the arc — not the
 *    individual colours, which are free to be retuned.
 *  - **A core missing from a sample gets no point, not a zero.** A zero draws
 *    an idle core; the truth is that the core was not reported (a resized VM,
 *    or a vector truncated at the agent's report cap).
 *  - **Isolation survives a re-render.** The focused core lives on the
 *    container's dataset, because the resize observer and the 60-second
 *    silent refresh both re-render — losing the isolation on every tick would
 *    make it useless for watching one hot core.
 *  - **The memory stack closes on the installed total**, and `free` is
 *    DERIVED rather than trusted, so the tooltip cannot contradict the
 *    picture beside it.
 *  - **Three source shapes degrade, none of them to an empty panel**: the
 *    agent's full breakdown, a bytes-only source (SNMP/WinRM/vCenter), and a
 *    percentage-only source (FortiOS) which falls back to the single line the
 *    chart drew before the split.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * region under test is sliced out by its section banner and eval'd with the
 * app-shell globals stubbed — the approach of assetStorageSectionDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const assetsLines = assetsSrc.split(/\r?\n/);

/**
 * Slice the whole CPU/Memory chart region rather than picking functions out
 * of it one by one: they call each other freely, and a name-by-name list
 * would need editing every time a private helper is added.
 */
function regionSrc(startsWith: string, endsWith: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(startsWith));
  if (start < 0) throw new Error(`assets.js: region start ${startsWith} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l.startsWith(endsWith));
  if (end < 0) throw new Error(`assets.js: region end ${endsWith} not found`);
  return assetsLines.slice(start, end).join("\n");
}

const REGION = regionSrc("// ─── CPU & Memory: one chart, or two", "// FortiGate active-session count chart");

// The legend-visibility helpers live up with the other per-user chart prefs
// rather than in the chart region, so they are sliced in alongside it —
// eval'd for real rather than stubbed, because "Cache is hidden unless you
// said otherwise" is a behaviour of theirs and stubbing it would test
// nothing. They touch localStorage, which happy-dom provides.
const VIS_REGION = regionSrc(
  "// ─── Telemetry chart series visibility (legend toggles) ───",
  "// Per-(asset, mount) forecast-overlay visibility.",
);

const EXPORTS = [
  "_renderSystemChart",
  "_cpuCoreColor", "_cpuCoreSeries", "_cpuHiddenCores", "_setCpuHiddenCores", "_renderCpuChart",
  "_cpuLegendHTML", "_memBandsFor", "_memRuns", "_renderMemoryChart", "_seriesChipHTML",
  "_renderMemoryPctChart", "_MEM_BANDS_AGENT", "_MEM_BANDS_VSPHERE", "_CPU_AVG_COLOR",
  "_CPU_CORE_HUE_START", "_CPU_CORE_HUE_END",
  "_memBandVisible", "_setMemBandVisible", "_MEM_BANDS_OFF_BY_DEFAULT",
];
const SRC = VIS_REGION + "\n" + REGION + "\n" + EXPORTS.map((n) => `globalThis.${n} = ${n};`).join("\n");

/** Turn every band on, for the tests that are about the stack rather than the chips. */
function showAllBands() {
  for (const b of [...g._MEM_BANDS_AGENT, ...g._MEM_BANDS_VSPHERE]) g._setMemBandVisible(b.key, true);
  g._setMemBandVisible("swap", true);
}

/** The app-shell + chart-kit globals the region calls into. */
function installStubs() {
  // The prefs helpers key on the signed-in user and no-op without one.
  g.currentUsername = "tester";
  try { localStorage.clear(); } catch { /* private mode */ }
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c: string) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  g.formatBytes = (n: number) => `${n}B`;
  g._fmtBytes = (n: number) => (n == null || isNaN(n) ? "—" : `${n}B`);
  g._fmtTooltipTs = (ts: string) => String(ts);
  g.CHART_TOOLTIP_HTML = '<div class="chart-tooltip"></div>';

  g._isRestApiManagedNetworkDevice = () => false;
  g._assetMonitorStreamSource = () => ({ polling: "agent", source: "Agent" });
  g._notAvailableViaPollingHTML = (what: string, how: string) => `<div>NA:${what}:${how}</div>`;
  g._staleBannerHTML = () => "";
  g._resolvedStreamPolling = () => "agent";
  // Lives next to assetSystemViewHTML, outside this region — the gate
  // deciding whether the section splits at all, which the CPU legend
  // consults to word its "no cores in this tier" note.
  g._telemetrySplitsCpuMemory = () => true;

  g._chartTimeBounds = (samples: any[], since?: string, until?: string) => ({
    t0: since ? +new Date(since) : +new Date(samples[0].timestamp),
    t1: until ? +new Date(until) : +new Date(samples[samples.length - 1].timestamp),
  });
  g._chartPad2 = (n: number) => String(n).padStart(2, "0");
  g._chartXScale = (padL: number, innerW: number, t0: number, t1: number) =>
    (ts: string | number) => padL + ((+new Date(ts) - t0) / Math.max(1, t1 - t0)) * innerW;
  g._chartYScale = (padT: number, innerH: number, yMin: number, yMax: number) =>
    (v: number) => padT + innerH - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * innerH;
  g._chartClipId = (p: string) => `clip-${p}`;
  g._chartClipDefs = () => "";
  g._chartClipAttr = (id: string) => `clip-path="url(#${id})"`;

  g._outageMarkers = () => [];
  g._outagePts = () => [];
  g._outageDotsSVG = () => "";
  g._outageHitsSVG = () => "";
  g._missTooltipHTML = () => "<div>miss</div>";
  g._failureAwareSeriesSVG = (pts: any[], color: string) => ({
    defs: "",
    segments: `<polyline class="agg-line" data-n="${pts.length}" stroke="${color}"/>`,
  });
  g._dateChangeMarkers = () => "";
  g._maintenanceBandLayer = () => "";
  g._stashChartGeometry = () => {};
  g._addChartScreenshotButton = () => {};
  g._observeChartResize = () => {};
  g._statsSummaryFrom = () => () => "";

  // Captured so a test can assert what the tooltip would render.
  g.__tooltipFns = [] as Array<(t: Element) => string>;
  g._wireChartTooltip = (_c: Element, fn: (t: Element) => string) => { g.__tooltipFns.push(fn); };
}

function ts(minute: number): string {
  return new Date(Date.UTC(2026, 8, 18, 12, minute, 0)).toISOString();
}

/** A window of agent samples: full breakdown + per-core vectors. */
function agentSamples(cores: number[][]): any[] {
  const GB = 1024 ** 3;
  return cores.map((vec, i) => ({
    timestamp: ts(i),
    cpuPct: vec.reduce((a, b) => a + b, 0) / vec.length,
    cpuCorePcts: vec,
    memPct: 50,
    memUsedBytes: 8 * GB,
    memTotalBytes: 32 * GB,
    memBuffersBytes: 1 * GB,
    memCachedBytes: 5 * GB,
    memFreeBytes: 18 * GB,
    swapUsedBytes: 1 * GB,
    swapTotalBytes: 4 * GB,
  }));
}

function payload(samples: any[], extra: Record<string, unknown> = {}) {
  return {
    since: samples[0].timestamp,
    until: samples[samples.length - 1].timestamp,
    tier: "detail",
    samples,
    outages: [],
    stats: { total: samples.length, avgCpuPct: 10, maxCpuPct: 20, avgMemPct: 50, maxMemPct: 60 },
    ...extra,
  };
}

/**
 * Click a legend chip and let the deferred single-click handler run.
 *
 * The CPU legend waits out the double-click window before acting, so an
 * isolate does not first toggle the very chip it was aimed at. Tests have to
 * wait the same 220 ms — with fake timers, so the suite does not.
 */
function clickChip(el: HTMLElement, series: string): void {
  const chip = el.querySelector(`.cpu-legend-chip[data-series="${series}"]`) as HTMLElement;
  if (!chip) throw new Error(`no cpu legend chip for ${series}`);
  chip.click();
  vi.advanceTimersByTime(300);
}

function dblClickChip(el: HTMLElement, series: string): void {
  const chip = el.querySelector(`.cpu-legend-chip[data-series="${series}"]`) as HTMLElement;
  if (!chip) throw new Error(`no cpu legend chip for ${series}`);
  // A real double-click fires click, click, dblclick — and the pending
  // single-click timer must be cancelled by the dblclick rather than fire
  // after it, which is the bug this ordering reproduces.
  chip.click();
  chip.click();
  chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  vi.advanceTimersByTime(300);
}

function container(): HTMLElement {
  const el = document.createElement("div");
  // clientWidth is 0 in happy-dom; the renderers fall back to 600.
  document.body.appendChild(el);
  return el;
}

describe("CPU chart — per-core rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    installStubs();
    // eslint-disable-next-line no-eval
    (0, eval)(SRC);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("draws one line per logical core plus the aggregate", () => {
    const el = container();
    g._renderCpuChart(el, payload(agentSamples([[10, 20, 30, 40], [12, 22, 32, 42]])), {}, {});
    const coreLines = el.querySelectorAll("polyline.cpu-core-line");
    expect(coreLines.length).toBe(4);
    expect(el.querySelectorAll("polyline.agg-line").length).toBe(1);
  });

  it("gives every core a distinct colour", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) seen.add(g._cpuCoreColor(i, 16));
    expect(seen.size).toBe(16);
  });

  it("keeps the core palette out of the reserved red and grey", () => {
    // Red = missed poll, grey = dependency down. The palette is an HSL arc,
    // so the guarantee is the arc's bounds, not a list of hexes.
    expect(g._CPU_CORE_HUE_START).toBeGreaterThan(20);
    expect(g._CPU_CORE_HUE_END).toBeLessThan(340);
    for (let n of [1, 2, 8, 64, 512]) {
      for (let i = 0; i < n; i++) {
        const m = /^hsl\((\d+),(\d+)%,(\d+)%\)$/.exec(g._cpuCoreColor(i, n));
        expect(m, `core ${i}/${n} is not an hsl() colour`).toBeTruthy();
        const [h, sat] = [Number(m![1]), Number(m![2])];
        expect(h, `core ${i}/${n} hue ${h} is in the red band`).toBeGreaterThan(20);
        expect(h, `core ${i}/${n} hue ${h} is in the red band`).toBeLessThan(340);
        // Saturated enough never to read as the dependency grey.
        expect(sat).toBeGreaterThan(30);
      }
    }
  });

  it("renders a legend chip for every core plus Average", () => {
    const el = container();
    g._renderCpuChart(el, payload(agentSamples([[1, 2, 3], [4, 5, 6]])), {}, {});
    const chips = el.querySelectorAll(".cpu-legend-chip");
    expect(chips.length).toBe(4); // Average + 3 cores
    expect(chips[0].getAttribute("data-series")).toBe("avg");
    expect(chips[1].textContent).toContain("0");
  });

  it("hides a core on legend click and brings it back on a second click", () => {
    const el = container();
    const data = payload(agentSamples([[1, 2, 3], [4, 5, 6]]));
    g._renderCpuChart(el, data, {}, {});
    expect(el.querySelectorAll("polyline.cpu-core-line").length).toBe(3);

    clickChip(el, "1");
    expect(el.querySelectorAll("polyline.cpu-core-line").length).toBe(2);
    expect(el.querySelector('polyline.cpu-core-line[data-core="1"]')).toBeNull();

    clickChip(el, "1");
    expect(el.querySelectorAll("polyline.cpu-core-line").length).toBe(3);
  });

  it("marks a switched-off chip without taking it away or hiding it", () => {
    // A chip that vanished when clicked would be a one-way door, and one
    // dimmed past reading is the same door with the handle painted out.
    // Measured in Chrome at opacity 0.4: 1.84:1 on morning, 2.01 noon, 2.17
    // nightfall — under the floor for non-text UI, on a click target. The
    // strikethrough carries the state instead; 0.8 measures 3.93-4.99:1.
    const el = container();
    g._renderCpuChart(el, payload(agentSamples([[1, 2], [3, 4]])), {}, {});
    clickChip(el, "0");
    const chip = el.querySelector('.cpu-legend-chip[data-series="0"]') as HTMLElement;
    expect(chip).not.toBeNull();
    const style = chip.getAttribute("style")!;
    expect(style).toContain("line-through");
    const opacity = Number(/opacity:([\d.]+)/.exec(style)?.[1] ?? "1");
    expect(opacity).toBeGreaterThanOrEqual(0.7);
  });

  it("keeps hidden cores across a re-render", () => {
    const el = container();
    const data = payload(agentSamples([[1, 2, 3], [4, 5, 6]]));
    g._renderCpuChart(el, data, {}, {});
    clickChip(el, "2");
    // What the resize observer and the silent refresh tick both do.
    g._renderCpuChart(el, data, {}, {});
    expect(g._cpuHiddenCores(el)["2"]).toBe(true);
    expect(el.querySelector('polyline.cpu-core-line[data-core="2"]')).toBeNull();
  });

  it("switches the aggregate off from its own chip", () => {
    const el = container();
    g._renderCpuChart(el, payload(agentSamples([[1, 2], [3, 4]])), {}, {});
    expect(el.querySelectorAll("polyline.agg-line").length).toBe(1);
    clickChip(el, "avg");
    expect(el.querySelectorAll("polyline.agg-line").length).toBe(0);
    // The cores are untouched by it.
    expect(el.querySelectorAll("polyline.cpu-core-line").length).toBe(2);
  });

  it("isolates one core on double-click, and offers one click back", () => {
    const el = container();
    const data = payload(agentSamples([[1, 2, 3, 4], [5, 6, 7, 8]]));
    g._renderCpuChart(el, data, {}, {});
    dblClickChip(el, "2");
    expect(el.querySelectorAll("polyline.cpu-core-line").length).toBe(1);
    expect(el.querySelector('polyline.cpu-core-line[data-core="2"]')).not.toBeNull();
    // 63 chips of undoing is not a way back, so there is a Show all.
    const all = el.querySelector(".cpu-legend-all") as HTMLElement;
    expect(all).not.toBeNull();
    all.click();
    expect(el.querySelectorAll("polyline.cpu-core-line").length).toBe(4);
  });

  it("gives the last core standing a heavier stroke", () => {
    // Opacity and weight key off how many cores are DRAWN, not how many the
    // host has — hiding the rest is pointless if the survivor stays faint.
    const el = container();
    g._renderCpuChart(el, payload(agentSamples([[1, 2, 3, 4], [5, 6, 7, 8]])), {}, {});
    dblClickChip(el, "0");
    const line = el.querySelector('polyline.cpu-core-line[data-core="0"]')!;
    expect(line.getAttribute("stroke-width")).toBe("2");
    expect(Number(line.getAttribute("opacity"))).toBeGreaterThan(0.8);
  });

  it("does not offer Show all when nothing is hidden", () => {
    const el = container();
    g._renderCpuChart(el, payload(agentSamples([[1, 2], [3, 4]])), {}, {});
    expect(el.querySelector(".cpu-legend-all")).toBeNull();
  });

  it("does not carry hidden cores from one asset's chart to another's", () => {
    // Core 5 of one host has nothing to do with core 5 of another, so this
    // state lives on the container and is deliberately NOT persisted.
    const a = container();
    g._renderCpuChart(a, payload(agentSamples([[1, 2], [3, 4]])), {}, {});
    clickChip(a, "0");
    const b = container();
    g._renderCpuChart(b, payload(agentSamples([[1, 2], [3, 4]])), {}, {});
    expect(b.querySelectorAll("polyline.cpu-core-line").length).toBe(2);
  });

  it("falls back to the aggregate alone when no sample carries cores", () => {
    const el = container();
    const samples = agentSamples([[1, 2], [3, 4]]).map((s) => { delete s.cpuCorePcts; return s; });
    g._renderCpuChart(el, payload(samples), {}, {});
    expect(el.querySelectorAll("polyline.cpu-core-line").length).toBe(0);
    expect(el.querySelectorAll("polyline.agg-line").length).toBe(1);
  });

  it("says WHY a rollup range shows no cores, on an agent asset", () => {
    const el = container();
    const samples = agentSamples([[1, 2], [3, 4]]).map((s) => { delete s.cpuCorePcts; return s; });
    g._renderCpuChart(el, payload(samples, { tier: "hourly" }), {}, {});
    expect(el.textContent).toContain("Per-core detail is not kept in hourly buckets");
  });

  it("does not blame the tier when the source simply has no cores", () => {
    // A FortiGate on a rollup tier never had per-core data to lose; telling
    // the operator to pick a shorter range would send them nowhere.
    g._resolvedStreamPolling = () => "rest_api";
    g._telemetrySplitsCpuMemory = () => false;
    const el = container();
    const samples = agentSamples([[1, 2], [3, 4]]).map((s) => { delete s.cpuCorePcts; return s; });
    g._renderCpuChart(el, payload(samples, { tier: "hourly" }), {}, {});
    expect(el.textContent).not.toContain("Per-core detail");
  });
});

describe("the chart region is self-contained", () => {
  // _CPU_AVG_COLOR was USED in three places and DECLARED nowhere; the first
  // version of this file stubbed it as a global, so every test passed while
  // the real page threw a ReferenceError on the first CPU chart render.
  // assets.js is one script scope with no module boundary, so nothing else
  // would have caught it — stub only what lives OUTSIDE the region.
  it("declares every global it uses, without help from the stubs", () => {
    installStubs();
    for (const name of EXPORTS) delete (globalThis as any)[name];
    (0, eval)(SRC);
    expect(typeof g._CPU_AVG_COLOR).toBe("string");
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(() => g._renderCpuChart(el, payload(agentSamples([[1, 2], [3, 4]])), {}, {})).not.toThrow();
    // The combined chart shares the region, so it is covered by the same
    // guarantee: it is the ONLY chart a non-agent asset renders, and a
    // ReferenceError in it would take the whole section down.
    const el2 = document.createElement("div");
    document.body.appendChild(el2);
    const pct = [0, 1].map((i) => ({ timestamp: ts(i), cpuPct: 10 + i, memPct: 40 + i }));
    expect(() => g._renderSystemChart(el2, payload(pct), {}, {})).not.toThrow();
  });
});

describe("_cpuCoreSeries", () => {
  beforeEach(() => { installStubs(); (0, eval)(SRC); });

  it("returns null when nothing in the window is per-core", () => {
    expect(g._cpuCoreSeries([{ timestamp: ts(0), cpuPct: 5 }])).toBeNull();
    expect(g._cpuCoreSeries([{ timestamp: ts(0), cpuCorePcts: [] }])).toBeNull();
  });

  it("widens to the widest vector and leaves a missing core UNPLOTTED", () => {
    // Not zero — a zero draws an idle core that was never reported.
    const series = g._cpuCoreSeries([
      { timestamp: ts(0), cpuCorePcts: [10, 20] },
      { timestamp: ts(1), cpuCorePcts: [30, 40, 50] },
    ]);
    expect(series.length).toBe(3);
    expect(series[0].length).toBe(2);
    expect(series[2].length).toBe(1);
    expect(series[2][0].v).toBe(50);
  });

  it("drops a non-finite reading rather than plotting NaN coordinates", () => {
    const series = g._cpuCoreSeries([{ timestamp: ts(0), cpuCorePcts: [10, NaN, Infinity, 40] }]);
    expect(series[1].length).toBe(0);
    expect(series[2].length).toBe(0);
    expect(series[3][0].v).toBe(40);
  });
});

describe("Memory chart — the stack", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installStubs();
    (0, eval)(SRC);
  });

  it("derives free so the bands close exactly on the installed total", () => {
    const GB = 1024 ** 3;
    const b = g._memBandsFor({
      memTotalBytes: 32 * GB, memUsedBytes: 8 * GB,
      memBuffersBytes: 1 * GB, memCachedBytes: 5 * GB,
      // A free figure that disagrees with the rest: the chart must not trust
      // it, or the tooltip would contradict the picture beside it.
      memFreeBytes: 999 * GB,
    });
    expect(b.values.processes + b.values.buffers + b.values.cache + b.free).toBe(b.total);
    expect(b.free).toBe(18 * GB);
    expect(b.kind).toBe("agent");
  });

  it("never returns a negative band when the readings overshoot the total", () => {
    const b = g._memBandsFor({ memTotalBytes: 100, memUsedBytes: 90, memCachedBytes: 40 });
    expect(b.free).toBe(0);
  });

  it("returns null when there is no byte reading to stack", () => {
    expect(g._memBandsFor({ memPct: 50 })).toBeNull();
    expect(g._memBandsFor({ memUsedBytes: 5 })).toBeNull();
  });

  it("distinguishes a band reported as zero from one never reported", () => {
    // The renderer drops a band no row reported and KEEPS one every row
    // reported as 0 — a host genuinely using no swap is a reading, and
    // collapsing it would be the same mistake as charting an unreported
    // cache as an empty one.
    const b = g._memBandsFor({ memTotalBytes: 100, memUsedBytes: 40, memCachedBytes: 0 });
    expect(b.values.cache).toBe(0);
    expect(b.values.buffers).toBeNull();
  });

  it("draws one filled band per component, plus the total and swap lines", () => {
    const el = container();
    showAllBands();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2], [3]])), {}, {});
    // Processes / Buffers / Cache.
    expect(el.querySelectorAll("polygon").length).toBe(3);
    // Total and swap are lines, not bands: swap is a different device and
    // stacks with nothing, and the total is the ceiling the stack is read
    // against rather than a quantity of its own.
    const dashed = Array.from(el.querySelectorAll("polyline"))
      .filter((p) => p.getAttribute("stroke-dasharray"));
    expect(dashed.length).toBe(2);
    expect(el.textContent).toContain("Installed total");
    expect(el.textContent).toContain("Swap / page file");
  });

  it("names every band in the legend", () => {
    const el = container();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2]])), {}, {});
    for (const band of g._MEM_BANDS_AGENT) expect(el.textContent).toContain(band.label);
  });

  it("collapses to one band, and says so, for a source with no breakdown", () => {
    const el = container();
    const GB = 1024 ** 3;
    const samples = [0, 1, 2].map((i) => ({
      timestamp: ts(i), cpuPct: 5, memPct: 25,
      memUsedBytes: 8 * GB, memTotalBytes: 32 * GB,
    }));
    g._renderMemoryChart(el, payload(samples), {}, {});
    expect(el.querySelectorAll("polygon").length).toBe(1);
    expect(el.textContent).toContain("no cache/buffer breakdown");
    expect(el.textContent).not.toContain("Swap / page file");
  });

  it("falls back to the percentage line for a source with no bytes at all", () => {
    const el = container();
    const samples = [0, 1, 2].map((i) => ({ timestamp: ts(i), cpuPct: 5, memPct: 40 + i }));
    g._renderMemoryChart(el, payload(samples), {}, {});
    expect(el.querySelectorAll("polygon").length).toBe(0);
    expect(el.querySelectorAll("polyline.agg-line").length).toBe(1);
    expect(el.textContent).toContain("percentage only");
  });

  it("tooltips every band and the in-use total", () => {
    const el = container();
    g.__tooltipFns = [];
    g._renderMemoryChart(el, payload(agentSamples([[1], [2]])), {}, {});
    const hit = el.querySelector("rect.chart-hit")!;
    const html = g.__tooltipFns[g.__tooltipFns.length - 1](hit);
    expect(html).toContain("Processes");
    expect(html).toContain("Buffers");
    expect(html).toContain("Cache");
    expect(html).toContain("Free");
    expect(html).toContain("In use");
    expect(html).toContain("Swap");
  });
});

describe("_memRuns", () => {
  beforeEach(() => { installStubs(); (0, eval)(SRC); });

  const pts = [{ t: 100 }, { t: 200 }, { t: 300 }, { t: 400 }];

  it("keeps one run when nothing interrupted collection", () => {
    expect(g._memRuns(pts, []).length).toBe(1);
  });

  it("splits the stack at an outage so a band never paints across a gap", () => {
    const runs = g._memRuns(pts, [{ t: 250 }]);
    expect(runs.length).toBe(2);
    expect(runs[0].map((p: any) => p.t)).toEqual([100, 200]);
    expect(runs[1].map((p: any) => p.t)).toEqual([300, 400]);
  });

  it("ignores an outage that lands outside the sampled span", () => {
    expect(g._memRuns(pts, [{ t: 50 }, { t: 500 }]).length).toBe(1);
  });
});

describe("Combined chart - the non-agent shape", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installStubs();
    (0, eval)(SRC);
  });

  // A FortiGate, an SNMP switch or a vCenter VM reports one CPU percentage
  // and one memory figure per sample. The split section would give it two
  // single-line charts where one had been, so it keeps the combined chart --
  // and that chart has to stay working, which is what this block pins.
  const pctSamples = [0, 1, 2].map((i) => ({ timestamp: ts(i), cpuPct: 10 + i, memPct: 40 + i }));

  it("draws both series on one 0-100% axis", () => {
    const el = container();
    g._renderSystemChart(el, payload(pctSamples), {}, {});
    expect(el.querySelectorAll("polyline.agg-line").length).toBe(2);
    // No stack: the byte bands are the agent shape's, not this one's.
    expect(el.querySelectorAll("polygon").length).toBe(0);
    expect(el.textContent).toContain("CPU");
    expect(el.textContent).toContain("Memory");
    // The axis is a percentage, not the memory chart's byte scale.
    expect(el.textContent).toContain("100%");
  });

  it("converts a bytes-only source to a percentage rather than dropping it", () => {
    const el = container();
    const GB = 1024 ** 3;
    const samples = [0, 1].map((i) => ({
      timestamp: ts(i), cpuPct: 5, memUsedBytes: 8 * GB, memTotalBytes: 32 * GB,
    }));
    g.__tooltipFns = [];
    g._renderSystemChart(el, payload(samples), {}, {});
    expect(el.querySelectorAll("polyline.agg-line").length).toBe(2);
    const hit = el.querySelector("rect.chart-hit")!;
    const html = g.__tooltipFns[g.__tooltipFns.length - 1](hit);
    expect(html).toContain("25.0%");
  });

  it("renders the stale banner on its empty path, like every other section", () => {
    const el = container();
    g._staleBannerHTML = () => '<div class="asset-stale-banner-slot">stale</div>';
    g._renderSystemChart(el, { samples: [], outages: [], stats: { total: 0 } }, {}, {});
    expect(el.textContent).toContain("stale");
    expect(el.textContent).toContain("No telemetry samples");
  });
});

describe("Memory chart - the vSphere vocabulary", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installStubs();
    (0, eval)(SRC);
  });

  const GB = 1024 ** 3;

  /** A vCenter VM: the hypervisor's view of how it is backing 32 GB of guest RAM. */
  function vmSamples(n: number): any[] {
    return Array.from({ length: n }, (_, i) => ({
      timestamp: ts(i),
      cpuPct: 20,
      cpuCorePcts: [18, 22, 19, 21],
      memUsedBytes: 12 * GB,
      memTotalBytes: 32 * GB,
      memPrivateBytes: 8 * GB,
      memSharedBytes: 3 * GB,
      memBalloonedBytes: 1 * GB,
      memSwappedBytes: 0.5 * GB,
      memCompressedBytes: 0.25 * GB,
    }));
  }

  /** An ESXi host: consumed / ballooned / swapped against installed RAM. */
  function hostSamples(n: number): any[] {
    return Array.from({ length: n }, (_, i) => ({
      timestamp: ts(i),
      cpuPct: 44,
      memUsedBytes: 300 * GB,
      memTotalBytes: 512 * GB,
      memConsumedBytes: 300 * GB,
      memBalloonedBytes: 4 * GB,
      memSwappedBytes: 2 * GB,
    }));
  }

  it("picks the vSphere table off the hypervisor columns, not the asset", () => {
    const b = g._memBandsFor(vmSamples(1)[0]);
    expect(b.kind).toBe("vsphere");
    expect(b.table).toBe(g._MEM_BANDS_VSPHERE);
    // Untouched guest RAM is derived, exactly as free is on the agent stack.
    expect(b.free).toBe(32 * GB - (8 + 3 + 1 + 0.5 + 0.25) * GB);
  });

  it("never mixes the two vocabularies in one row", () => {
    // A VM publishes no `consumed` and a host no `private` — that disjointness
    // is what stops either stack counting the same memory twice.
    expect(g._memBandsFor(vmSamples(1)[0]).values.consumed).toBeNull();
    expect(g._memBandsFor(hostSamples(1)[0]).values.private).toBeNull();
    // And an agent row reaches the agent table even though both carry bytes.
    expect(g._memBandsFor(agentSamples([[1]])[0]).kind).toBe("agent");
  });

  it("draws a band per reported hypervisor component and names it", () => {
    const el = container();
    g._renderMemoryChart(el, payload(vmSamples(3)), {}, {});
    expect(el.querySelectorAll("polygon").length).toBe(5);
    for (const label of ["Private", "Shared", "Ballooned", "Host-swapped", "Compressed"]) {
      expect(el.textContent).toContain(label);
    }
    // "Consumed" is the host's band and must not appear on a VM.
    expect(el.textContent).not.toContain("Consumed");
    // The bands are measured outside the guest; the legend has to say so.
    expect(el.textContent).toContain("not the guest");
  });

  it("drops the bands an ESXi host does not publish", () => {
    const el = container();
    g._renderMemoryChart(el, payload(hostSamples(3)), {}, {});
    expect(el.querySelectorAll("polygon").length).toBe(3);
    expect(el.textContent).toContain("Consumed");
    expect(el.textContent).not.toContain("Private");
    expect(el.textContent).not.toContain("Compressed");
  });

  it("tooltips the bands it actually drew, in stack order", () => {
    const el = container();
    g.__tooltipFns = [];
    g._renderMemoryChart(el, payload(vmSamples(3)), {}, {});
    const hit = el.querySelector("rect.chart-hit")!;
    const html = g.__tooltipFns[g.__tooltipFns.length - 1](hit);
    expect(html).toContain("Ballooned");
    expect(html).toContain("Host-swapped");
    // The remainder is guest RAM the host never had to touch, which is not
    // the same claim as the OS-level "Free" on the agent stack.
    expect(html).toContain("Untouched");
    expect(html).not.toContain("Free");
  });

  it("charts a vCenter VM's vCPUs on the CPU chart", () => {
    const el = container();
    g._renderCpuChart(el, payload(vmSamples(2)), {}, {});
    // Four vCPUs plus the aggregate, which carries a chip of its own.
    expect(el.querySelectorAll("polyline").length).toBeGreaterThanOrEqual(4);
    expect(el.querySelectorAll(".cpu-legend-chip").length).toBe(5);
  });
});

describe("Memory chart - the axis is the installed total", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installStubs();
    (0, eval)(SRC);
  });

  const GB = 1024 ** 3;

  /** 32 GB installed, 8 GB in use, and a page file bigger than RAM. */
  function bigSwapSamples(swapUsedGb: number): any[] {
    return [0, 1, 2].map((i) => ({
      timestamp: ts(i),
      cpuPct: 5,
      memUsedBytes: 8 * GB,
      memTotalBytes: 32 * GB,
      memBuffersBytes: 1 * GB,
      memCachedBytes: 4 * GB,
      memFreeBytes: 19 * GB,
      swapUsedBytes: swapUsedGb * GB,
      swapTotalBytes: 64 * GB,
    }));
  }

  /** Top y-axis tick, which is the ceiling the stack is drawn against. */
  function topTick(el: HTMLElement): string {
    const texts = Array.from(el.querySelectorAll("text"))
      .filter((t) => t.getAttribute("text-anchor") === "end");
    return texts[texts.length - 1]?.textContent ?? "";
  }

  it("tops at installed RAM, not at the largest value in the window", () => {
    const el = container();
    // 48 GB of page file in use on a 32 GB box. The old axis grew to fit it,
    // which squashed the whole physical stack into the bottom of the chart
    // and left the Installed total line floating in the middle.
    g._renderMemoryChart(el, payload(bigSwapSamples(48)), {}, {});
    expect(topTick(el)).toBe(_fmt(32 * GB));
  });

  it("is the same ceiling whether swap is large or absent", () => {
    const withSwap = container();
    g._renderMemoryChart(withSwap, payload(bigSwapSamples(48)), {}, {});
    const noSwap = container();
    const samples = bigSwapSamples(48).map((s) => {
      const c = { ...s };
      delete c.swapUsedBytes;
      delete c.swapTotalBytes;
      return c;
    });
    g._renderMemoryChart(noSwap, payload(samples), {}, {});
    expect(topTick(withSwap)).toBe(topTick(noSwap));
  });

  it("says so when the swap line is running above the ceiling", () => {
    // A flat line pinned to the top of the chart is a reading, not a stuck
    // series — the legend has to distinguish them.
    const over = container();
    g._renderMemoryChart(over, payload(bigSwapSamples(48)), {}, {});
    expect(over.textContent).toContain("above installed RAM, clipped");

    const under = container();
    g._renderMemoryChart(under, payload(bigSwapSamples(2)), {}, {});
    expect(under.textContent).toContain("Swap / page file");
    expect(under.textContent).not.toContain("clipped");
  });

  it("takes the largest total when the machine was resized mid-window", () => {
    const el = container();
    const samples = bigSwapSamples(2);
    samples[2].memTotalBytes = 64 * GB;
    g._renderMemoryChart(el, payload(samples), {}, {});
    expect(topTick(el)).toBe(_fmt(64 * GB));
  });
});

/** Mirrors the _fmtBytes stub the harness installs. */
function _fmt(n: number): string {
  return `${n}B`;
}

describe("Memory chart - switching bands off", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installStubs();
    (0, eval)(SRC);
  });

  function memChip(el: HTMLElement, key: string): HTMLElement {
    const chip = el.querySelector(`.mem-legend-chip[data-series="${key}"]`) as HTMLElement;
    if (!chip) throw new Error(`no mem legend chip for ${key}`);
    return chip;
  }

  it("ships with Cache switched off", () => {
    // Page cache is reclaimable: drawn in the stack it makes a healthy host
    // look nearly full, which is the most common misreading of this chart.
    expect(g._MEM_BANDS_OFF_BY_DEFAULT).toEqual(["cache"]);
    expect(g._memBandVisible("cache")).toBe(false);
    expect(g._memBandVisible("processes")).toBe(true);
    expect(g._memBandVisible("buffers")).toBe(true);

    const el = container();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2], [3]])), {}, {});
    expect(el.querySelectorAll("polygon").length).toBe(2); // processes + buffers
  });

  it("still offers the chip for a band it is not drawing", () => {
    const el = container();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2], [3]])), {}, {});
    const chip = memChip(el, "cache");
    expect(chip.getAttribute("style")).toContain("line-through");
    chip.click();
    expect(el.querySelectorAll("polygon").length).toBe(3);
  });

  it("says where the hidden memory went", () => {
    // The gap above the stack stops meaning "free" the moment a band is
    // switched off, and an operator reading headroom has to be told.
    const el = container();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2], [3]])), {}, {});
    expect(el.textContent).toContain("cache hidden");
    expect(el.textContent).toContain("counted in the gap");
    memChip(el, "cache").click();
    expect(el.textContent).not.toContain("counted in the gap");
  });

  it("keeps the axis and the derived free figure honest when a band is off", () => {
    // Hiding a band changes the PICTURE, never the arithmetic: the ceiling
    // is still installed RAM and Free is still total minus everything
    // measured, cache included.
    const GB = 1024 ** 3;
    const el = container();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2]])), {}, {});
    const ticks = Array.from(el.querySelectorAll("text"))
      .filter((t) => t.getAttribute("text-anchor") === "end");
    expect(ticks[ticks.length - 1]?.textContent).toBe(`${32 * GB}B`);

    g.__tooltipFns = [];
    g._renderMemoryChart(el, payload(agentSamples([[1], [2]])), {}, {});
    const hit = el.querySelector("rect.chart-hit")!;
    const html = g.__tooltipFns[g.__tooltipFns.length - 1](hit);
    // Free is 32 - (8 processes + 1 buffers + 5 cache) = 18 GB, unchanged by
    // cache being switched off.
    expect(html).toContain(`${18 * GB}B`);
  });

  it("names a hidden band in the tooltip rather than dropping its reading", () => {
    // The chart answers "what shape is this host's memory"; the tooltip
    // answers "what exactly was measured", and that second answer must not
    // depend on which chips are lit.
    const el = container();
    g.__tooltipFns = [];
    g._renderMemoryChart(el, payload(agentSamples([[1], [2]])), {}, {});
    const hit = el.querySelector("rect.chart-hit")!;
    const html = g.__tooltipFns[g.__tooltipFns.length - 1](hit);
    expect(html).toContain("Cache (hidden)");
    expect(html).toContain("Processes");
    expect(html).not.toContain("Processes (hidden)");
  });

  it("switches the swap line off from its own chip", () => {
    const el = container();
    showAllBands();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2]])), {}, {});
    const dashedBefore = Array.from(el.querySelectorAll("polyline"))
      .filter((l) => l.getAttribute("stroke-dasharray")).length;
    memChip(el, "swap").click();
    const dashedAfter = Array.from(el.querySelectorAll("polyline"))
      .filter((l) => l.getAttribute("stroke-dasharray")).length;
    // The Installed total line stays; only swap goes.
    expect(dashedAfter).toBe(dashedBefore - 1);
    expect(el.textContent).toContain("Installed total");
  });

  it("persists the choice, unlike the CPU cores", () => {
    // Band names mean the same thing on every host, so which of them an
    // operator wants is a standing preference — that is also what makes a
    // default expressible at all.
    const el = container();
    g._renderMemoryChart(el, payload(agentSamples([[1], [2]])), {}, {});
    memChip(el, "cache").click();
    expect(g._memBandVisible("cache")).toBe(true);

    const fresh = container();
    g._renderMemoryChart(fresh, payload(agentSamples([[1], [2]])), {}, {});
    expect(fresh.querySelectorAll("polygon").length).toBe(3);
  });

  it("applies the same default to a vSphere stack, which has no cache band", () => {
    const GB = 1024 ** 3;
    const el = container();
    const vm = [0, 1, 2].map((i) => ({
      timestamp: ts(i), cpuPct: 10,
      memUsedBytes: 12 * GB, memTotalBytes: 32 * GB,
      memPrivateBytes: 8 * GB, memSharedBytes: 3 * GB, memBalloonedBytes: 1 * GB,
      memSwappedBytes: 0.5 * GB, memCompressedBytes: 0.25 * GB,
    }));
    g._renderMemoryChart(el, payload(vm), {}, {});
    // Nothing in the vSphere table is off by default, so all five draw.
    expect(el.querySelectorAll("polygon").length).toBe(5);
    expect(el.textContent).not.toContain("counted in the gap");
  });
});
