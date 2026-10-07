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
    g.PolarisCharts = { lineChart: (o: any) => { charts.push(o); return '<div class="chart-stub"></div>'; } };
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
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
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

  it("CPU + Memory has its own 1h / 24h / 7d range, independent of Response Time", async () => {
    await openSheet();
    const ranges = Array.from(document.querySelectorAll("#asset-telemetry-range-seg .seg-item")).map((b) => (b as HTMLElement).dataset.range);
    expect(ranges).toEqual(["1h", "24h", "7d"]);
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
    const sheet = document.getElementById("iface-sheet")!;
    expect(sheet.textContent).toContain("Delivering");
    expect(sheet.textContent).toContain("class3");
    expect(calls.interfaceHistory.at(-1)!.slice(1)).toEqual(["port1", { range: "1h" }]);

    // 750 000 octets in 60 s = 100 kbps in; 75 000 = 10 kbps out.
    const tput = charts.find((c) => /throughput/.test(c.ariaLabel));
    expect(tput.yUnit).toBe("Kbps");
    expect(tput.series[0].values[0].v).toBeCloseTo(100);
    expect(tput.series[1].values[0].v).toBeCloseTo(10);
    const errs = charts.find((c) => /errors/.test(c.ariaLabel));
    expect(errs.series[0].values[0].v).toBe(3);
    expect(document.getElementById("iface-err-sub")!.textContent).toContain("total 5");

    seg("iface-range-seg", "7d").click();
    await flush();
    expect(calls.interfaceHistory.at(-1)!.slice(1)).toEqual(["port1", { range: "7d" }]);
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
