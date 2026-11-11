/**
 * tests/unit/mobileAssetChartsPollingPoe.test.ts — four things on the mobile
 * asset sheet:
 *
 *   • CPU + Memory carries its own 1h / 24h / 7d range, independent of the
 *     Response Time chart's (which used to drag telemetry along with it);
 *   • the chart sections name their polling method beside the title, read from
 *     /effective-monitor-settings (the resolved method, source default
 *     included); a stream nothing collects says "Not collected";
 *   • a switch's PoE state: a summary over every port with the faulted ones
 *     named, a label on each port row, and a PoE row in the slide-up;
 *   • a MONITORED interface's slide-up draws throughput + error charts from
 *     interface-history, counters differenced into per-interval rates.
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

const DETAIL_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");
const g = globalThis as any;

describe("mobile asset sheet: chart ranges, polling chips, PoE, interface charts", () => {
  let asset: any;
  let sysInfo: any;
  let eff: any;
  let charts: any[];
  let calls: Record<string, any[][]>;
  const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
  const seg = (id: string, r: string) =>
    document.querySelector(`#${id} .seg-item[data-range="${r}"]`) as HTMLButtonElement;
  const chip = (stream: string) =>
    document.querySelector(`.sect-poll[data-poll-stream="${stream}"]`) as HTMLElement;

  function boot() {
    document.body.innerHTML = '<div id="app"></div>';
    g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
    charts = [];
    g.PolarisCharts = {
      lineChart: (o: any) => { charts.push(o); return '<div class="chart-stub"></div>'; },
      // Rule 159a: the error charts are stacked bars.
      barChart: (o: any) => { charts.push(o); return '<div class="chart-stub"></div>'; },
      formatRate: (v: number) => String(Math.round(v * 100) / 100),
    };
    g.PolarisMonitorStates = {
      fromPayload: () => ({ known: false, threshold: 1, recoveryPolls: 1, severity: null }),
      replay: (s: any[]) => s.map(() => ({ status: "up" })),
    };
    g.PolarisMobile = { user: () => ({ permissions: {} }) };
    g.mobileFormatDate = (s: any) => String(s ?? "");
    g.timeAgo = () => "1m ago";
    calls = {};
    const rec = (name: string, fn: (...a: any[]) => any) => (...a: any[]) => { (calls[name] ||= []).push(a); return fn(...a); };
    const known: Record<string, any> = {
      get: rec("get", async () => asset),
      monitorHistory: rec("monitorHistory", async () => ({ samples: [] })),
      telemetryHistory: rec("telemetryHistory", async () => ({
        samples: [{ timestamp: "2026-10-07T11:00:00Z", cpuPct: 10, memPct: 20 }], stats: {},
      })),
      systemInfo: rec("systemInfo", async () => sysInfo),
      effectiveMonitorSettings: rec("effectiveMonitorSettings", async () => eff),
      interfaceHistory: rec("interfaceHistory", async () => ({
        samples: [
          { timestamp: "2026-10-07T11:00:00Z", inOctets: 0,      outOctets: 0,     inErrors: 0, outErrors: 0 },
          { timestamp: "2026-10-07T11:01:00Z", inOctets: 750000, outOctets: 75000, inErrors: 3, outErrors: 2 },
        ],
      })),
    };
    g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
    loadSharedModules();
    new Function(DETAIL_SRC)();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 12, 0));
    asset = {
      id: "a1", hostname: "SW-1", assetType: "switch", monitored: true, status: "active",
      monitorStatus: "up", macAddresses: [], monitoredInterfaces: ["port1"],
    };
    sysInfo = {
      interfaces: [
        { ifName: "port1", operStatus: "up", speedBps: 1e9, poeStatus: "delivering", poeClass: "class3" },
        { ifName: "port2", operStatus: "up", poeStatus: "searching" },
        { ifName: "port3", alias: "Lobby AP", operStatus: "down", poeStatus: "fault" },
        { ifName: "port4", operStatus: "up" },
      ],
      lldpNeighbors: [],
    };
    eff = { resolved: { responseTimePolling: "icmp", cpuMemoryPolling: "rest_api", temperaturePolling: null, interfacesPolling: "snmp" } };
    boot();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function openSheet() {
    g.PolarisAssetDetail.open("a1");
    await flush();
  }

  it("opens with every section collapsed, Hardware Sensors included, and a tap expands one", async () => {
    await openSheet();
    const bodies = Array.from(document.querySelectorAll(".sect-body[data-sect]")) as HTMLElement[];
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((b) => !b.hasAttribute("hidden")).map((b) => b.dataset.sect)).toEqual([]);
    expect(bodies.map((b) => b.dataset.sect)).toContain("temperatures");
    (document.querySelector('.asset-sect-header[data-key="temperatures"]') as HTMLElement).click();
    expect(document.querySelector('.sect-body[data-sect="temperatures"]')!.hasAttribute("hidden")).toBe(false);
  });

  it("an agent asset gets the split CPU + Memory charts; a REST-polled one keeps the combined chart", async () => {
    const render = vi.fn();
    g.PolarisTelemetryCharts = { splits: (m: string) => m === "agent", render };
    try {
      // rest_api (the harness default) keeps the combined chart.
      await openSheet();
      expect(render).not.toHaveBeenCalled();
      expect(charts.some((c) => /CPU and memory/.test(c.ariaLabel))).toBe(true);

      eff = { resolved: { ...eff.resolved, cpuMemoryPolling: "agent" } };
      boot();
      g.PolarisTelemetryCharts = { splits: (m: string) => m === "agent", render };
      await openSheet();
      expect(render).toHaveBeenCalledTimes(1);
      const [host, ctx] = render.mock.calls[0];
      expect(host.id).toBe("asset-telemetry-chart");
      expect(ctx.range).toBe("24h");
      expect(ctx.asset.id).toBe("a1");
      expect(charts.some((c) => /CPU and memory/.test(c.ariaLabel))).toBe(false);
      // A range change re-renders through the same path with the same core picks.
      seg("asset-telemetry-range-seg", "7d").click();
      await flush();
      expect(render.mock.calls.at(-1)![1].range).toBe("7d");
      expect(render.mock.calls.at(-1)![1].hidden).toBe(ctx.hidden);
    } finally {
      delete g.PolarisTelemetryCharts;
    }
  });

  it("CPU + Memory has its own range control — Response Time's five presets — moving independently", async () => {
    await openSheet();
    const ranges = (id: string) => Array.from(document.querySelectorAll("#" + id + " .seg-item")).map((b) => (b as HTMLElement).dataset.range);
    expect(ranges("asset-telemetry-range-seg")).toEqual(["1h", "12h", "24h", "7d", "30d"]);
    expect(ranges("asset-telemetry-range-seg")).toEqual(ranges("asset-range-seg"));
    expect(calls.telemetryHistory.at(-1)![1]).toBe("24h");

    const monitorBefore = calls.monitorHistory.length;
    seg("asset-telemetry-range-seg", "1h").click();
    await flush();
    expect(calls.telemetryHistory.at(-1)![1]).toBe("1h");
    expect(seg("asset-telemetry-range-seg", "1h").classList.contains("on")).toBe(true);
    expect(calls.monitorHistory.length).toBe(monitorBefore);

    // ...and the Response Time control no longer drags telemetry along.
    const telBefore = calls.telemetryHistory.length;
    seg("asset-range-seg", "7d").click();
    await flush();
    expect(calls.monitorHistory.at(-1)![1]).toBe("7d");
    expect(calls.telemetryHistory.length).toBe(telBefore);
  });

  it("names each chart section's resolved polling method beside its title", async () => {
    await openSheet();
    expect(chip("responseTime").textContent).toBe("ICMP");
    expect(chip("cpuMemory").textContent).toBe("REST API");
    expect(chip("interfaces").textContent).toBe("SNMP");
    expect(chip("temperature").textContent).toBe("Not collected");
    expect(chip("temperature").classList.contains("off")).toBe(true);
    expect(chip("responseTime").hidden).toBe(false);
    // The chip sits inside the title line.
    expect(chip("cpuMemory").closest(".sect-title")!.textContent).toContain("CPU + Memory");
  });

  it("keeps the chips hidden when the settings read fails", async () => {
    g.api.assets.effectiveMonitorSettings = async () => { throw new Error("nope"); };
    await openSheet();
    expect(chip("responseTime").hidden).toBe(true);
  });

  it("summarizes PoE over every port and names the faulted ones", async () => {
    await openSheet();
    const summary = document.querySelector(".poe-summary")!;
    expect(summary.textContent).toContain("1 delivering");
    expect(summary.textContent).toContain("1 searching");
    expect(summary.textContent).toContain("1 fault");
    // port3 is DOWN, so not in the list — but its fault is still reported.
    expect(summary.querySelector(".poe-summary-faults")!.textContent).toContain("Lobby AP");
  });

  it("labels each port's PoE state on its row", async () => {
    await openSheet();
    (document.getElementById("iface-show-all-btn") as HTMLElement).click();
    const label = (name: string) => {
      const row = Array.from(document.querySelectorAll(".iface-row")).find((r) => r.textContent!.includes(name))!;
      return row.querySelector(".poe-label");
    };
    expect(label("port1")!.textContent).toBe("PoE Delivering");
    expect(label("port1")!.classList.contains("poe-ok")).toBe(true);
    expect(label("port2")!.textContent).toBe("PoE Searching");
    expect(label("port4")).toBeNull();
  });

  it("renders no PoE summary on a device with no PoE ports", async () => {
    sysInfo.interfaces = sysInfo.interfaces.map((i: any) => ({ ...i, poeStatus: undefined }));
    await openSheet();
    expect(document.querySelector(".poe-summary")).toBeNull();
  });

  it("a monitored interface's slide-up draws throughput and error charts", async () => {
    await openSheet();
    charts = [];
    (document.querySelector(".iface-row") as HTMLElement).click();
    await flush();
    // The interface is a page of the asset sheet now, not a sheet of its own.
    const sheet = document.querySelector('#asset-host .asset-page[data-page="iface"]')!;
    expect(sheet.textContent).toContain("Delivering");
    expect(sheet.textContent).toContain("class3");
    expect(calls.interfaceHistory.at(-1)!.slice(1)).toEqual(["port1", { range: "1h" }]);

    // 750 000 octets in 60 s = 100 kbps in; 75 000 = 10 kbps out.
    const tput = charts.find((c) => /throughput/.test(c.ariaLabel));
    expect(tput.yUnit).toBe("Kbps");
    expect(tput.series[0].values[0].v).toBeCloseTo(100);
    expect(tput.series[1].values[0].v).toBeCloseTo(10);
    // Errors are stacked bars in errors PER SECOND (rule 159a): 3 in and 2
    // out over 60 s.
    const errs = charts.find((c) => /errors per second/.test(c.ariaLabel));
    expect(errs.points[0].values[0]).toBeCloseTo(3 / 60);
    expect(errs.points[0].values[1]).toBeCloseTo(2 / 60);
    expect(errs.series.map((s: any) => s.color)).toEqual(["var(--md-primary)", "var(--md-tertiary)"]);
    expect(document.getElementById("iface-err-sub")!.textContent).toContain("in peak 0.05/s");

    seg("iface-range-seg", "7d").click();
    await flush();
    expect(calls.interfaceHistory.at(-1)!.slice(1)).toEqual(["port1", { range: "7d" }]);
    // The same five presets as Response Time.
    seg("iface-range-seg", "12h").click();
    await flush();
    expect(calls.interfaceHistory.at(-1)!.slice(1)).toEqual(["port1", { range: "12h" }]);
    seg("iface-range-seg", "30d").click();
    await flush();
    expect(calls.interfaceHistory.at(-1)!.slice(1)).toEqual(["port1", { range: "30d" }]);
  });

  // Rule 159a: a fibre-channel port's page — WWN and FC errors rows, the FC
  // errors per minute chart with the port's bands, and Logged in cards.
  it("a fibre-channel port shows its WWN, FC counters, FC chart with bands, and what is logged in", async () => {
    const fc = (invalidCrcs: number, linkFailures: number) => ({ invalidCrcs, linkFailures, syncLosses: 0, sigLosses: 0, invalidTxWords: 10, linkResetIns: 0, linkResetOuts: 0 });
    Object.assign(sysInfo.interfaces[0], {
      wwn: "20:05:00:3a:9c:12:34:56",
      fc: {
        errorCounters: fc(54, 1),
        logins: [{ vsan: 101, portWwn: "10:00:00:90:fa:00:00:01", hostName: "esx01", matchMethod: "wwn", matchedAsset: { id: "h1", hostname: "esx01.example.test" } }],
      },
    });
    const prev = g.api.assets;
    const thresholdCalls: any[] = [];
    g.api = { assets: new Proxy({}, { get: (_t, k: string) => {
      if (k === "interfaceHistory") return async () => ({ samples: [
        { timestamp: "2026-10-07T11:00:00Z", inErrors: 0, outErrors: 0, fcErrors: fc(10, 0) },
        { timestamp: "2026-10-07T11:01:00Z", inErrors: 0, outErrors: 0, fcErrors: fc(22, 1) },
      ] });
      if (k === "metricThresholds") return async (_id: string, o: any) => {
        thresholdCalls.push(o);
        return { tiers: o.metric === "fcCrcErrorRate" ? [{ severity: "warning", operator: ">", threshold: 5, ruleName: "FC CRC" }] : [] };
      };
      return prev[k];
    } }) };
    await openSheet();
    charts = [];
    (document.querySelector(".iface-row") as HTMLElement).click();
    await flush();
    const page = document.querySelector('#asset-host .asset-page[data-page="iface"]')!;
    expect(page.textContent).toContain("20:05:00:3a:9c:12:34:56");
    expect(page.textContent).toContain("CRC 54 · words 10 · link 1");
    expect(page.textContent).toContain("Logged in");
    expect(page.textContent).toContain("esx01.example.test");
    expect(page.textContent).toContain("matched by WWN");

    const fcChart = charts.find((c) => /fibre-channel/.test(c.ariaLabel));
    expect(fcChart.points[0].values[0]).toBeCloseTo(12);              // 12 CRC in one minute
    expect(fcChart.points[0].event).toEqual({ count: 1, severity: null });
    expect(fcChart.series[0].tiers).toEqual([{ severity: "warning", operator: ">", threshold: 5, ruleName: "FC CRC" }]);
    expect(document.getElementById("iface-fc-sub")!.textContent).toContain("bands: FC CRC");
    // The bands are asked for THIS port, for the two error rates and the five FC metrics.
    expect(thresholdCalls.every((o) => o.ifName === "port1")).toBe(true);
    expect(thresholdCalls.map((o) => o.metric).sort()).toEqual([
      "fcCrcErrorRate", "fcInvalidTxWordRate", "fcLinkFailureRate", "fcSignalLossRate", "fcSyncLossRate", "ifInErrorRate", "ifOutErrorRate",
    ]);
  });

  it("an unmonitored interface's slide-up has no charts", async () => {
    await openSheet();
    (document.getElementById("iface-show-all-btn") as HTMLElement).click();
    const row = Array.from(document.querySelectorAll(".iface-row")).find((r) => r.textContent!.includes("port2")) as HTMLElement;
    row.click();
    await flush();
    expect(document.getElementById("iface-tput-chart")).toBeNull();
    expect(calls.interfaceHistory).toBeUndefined();
  });
});
