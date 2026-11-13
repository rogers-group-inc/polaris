/**
 * tests/unit/alertChartService.test.ts — the alert-chart scope rules and the
 * token plumbing, as one suite (CQ-T010).
 *
 * Complements, does not repeat:
 *   - alertSdwanChart.test.ts — parseSdwanDimension / resolveSdwanTarget /
 *     chartKeysForChangeEvent / sdwanSeriesFrom / wanMemberTarget
 *   - alertSensorChart.test.ts — failSpansFrom and the sensor chart render
 *   - alertStorageChart.test.ts — storage specs + bytesDisplayScale examples
 *   - alertCpuCoreChart.test.ts / cpuCores.test.ts — per-core series + colour
 *   - alertInterfaceRateChart.test.ts — rule 159a's happy paths
 *   - alertInterfaceLldp.test.ts / pathCheckAutomation.test.ts — the port and
 *     path-check carve-outs, each on its own
 *   - alertChartRenderMemo.test.ts / alertEmailTemplate.test.ts — buildAlertCharts
 *     memo + the email template substitution in context
 *   - memoryForecastCountdown.test.ts — the memory forecast chart
 *
 * What was unreached: sensorReadingDisplay (no test at all — the °C/°F
 * agreement between an alert sentence and its chart, and the never-block
 * fallback); the full metric → chart table; the chartTokensForAlert scope
 * matrix as a whole (each swap was tested in its own feature file, never the
 * precedence between them); interfaceRatePoints' counter-reset / equal-instant
 * / FC-gap edges; and substituteChartTokens' text mode, escaping and the
 * no-data / alias-dedupe paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const h = vi.hoisted(() => ({ getBranding: vi.fn() }));
vi.mock("../../src/services/brandingService.js", () => ({ getBranding: h.getBranding }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  CHART_TOKENS,
  attachmentsFor,
  bytesDisplayScale,
  chartTokenForMetric,
  chartTokensForAlert,
  chartTokensIn,
  interfaceRatePoints,
  isInterfaceRateAlert,
  isMemoryForecastAlert,
  isPathCheckScopedAlert,
  isPortScopedAlert,
  isResourceScopedAlert,
  isSdwanScopedAlert,
  isStorageScopedAlert,
  memorySeriesFrom,
  sensorReadingDisplay,
  substituteChartTokens,
  type ChartToken,
  type RenderedChart,
} from "../../src/services/alertChartService.js";

beforeEach(() => {
  resetDbStub();
  h.getBranding.mockReset();
});

const ALL: ChartToken[] = [...CHART_TOKENS];
const none = { port: false, sensor: false, mount: false };

describe("chartTokenForMetric — the full metric → chart table", () => {
  it.each([
    ["hwSensorValue", "chart.sensor"], ["hwSensorAlarm", "chart.sensor"],
    ["cpuPct", "chart.cpu"], ["cpuCorePct", "chart.cpu"], ["telemetryFailingMinutes", "chart.cpu"],
    ["memPct", "chart.memory"], ["memUsedBytes", "chart.memory"], ["memDaysUntilFull", "chart.memory"], ["memForecastPct", "chart.memory"],
    ["responseTimeMs", "chart.responseTime"], ["monitorStatus", "chart.responseTime"], ["consecutiveFailures", "chart.responseTime"],
    ["probeLossPct", "chart.probeLoss"],
    ["sdwanLatencyMs", "chart.sdwanLatency"], ["sdwanJitterMs", "chart.sdwanJitter"], ["sdwanPacketLoss", "chart.sdwanLoss"],
    ["sdwanRuleStatus", "chart.sdwanLatency"], ["sdwanSelectedMember", "chart.sdwanLatency"], ["sdwanMemberState", "chart.sdwanLatency"],
    ["storageUsedPct", "chart.storage"], ["storageUsedBytes", "chart.storage"], ["storageDaysUntilFull", "chart.storage"],
    ["ifInErrorRate", "chart.interface"], ["fcInvalidTxWordRate", "chart.interface"],
  ])("%s → %s", (metric, token) => {
    expect(chartTokenForMetric(metric)).toBe(token);
  });

  it("throughput, unknown metrics, null and undefined have no chart", () => {
    for (const m of ["ifInBps", "ifOperStatus", "pathLatencyMs", "nope", null, undefined, ""]) {
      expect(chartTokenForMetric(m)).toBeNull();
    }
  });
});

describe("the scope predicates", () => {
  it("are false for null / undefined / empty", () => {
    for (const fn of [isPortScopedAlert, isSdwanScopedAlert, isPathCheckScopedAlert, isStorageScopedAlert, isResourceScopedAlert, isMemoryForecastAlert, isInterfaceRateAlert]) {
      expect(fn(null)).toBe(false);
      expect(fn(undefined)).toBe(false);
      expect(fn("")).toBe(false);
    }
  });

  it("isInterfaceRateAlert reads own keys only — an Object.prototype name is not a metric", () => {
    expect(isInterfaceRateAlert("toString")).toBe(false);
    expect(isInterfaceRateAlert("constructor")).toBe(false);
    expect(isInterfaceRateAlert("ifOutErrorRate")).toBe(true);
  });

  it("port scope is the STATE fields only, never the rate quartet", () => {
    for (const m of ["ifOperStatus", "ifAdminStatus", "ifIpAddress", "poeStatus"]) expect(isPortScopedAlert(m)).toBe(true);
    for (const m of ["ifInErrorRate", "ifInBps", "ifOutBps"]) expect(isPortScopedAlert(m)).toBe(false);
  });

  it("the memory forecasts are resource alerts too", () => {
    expect(isResourceScopedAlert("memForecastPct")).toBe(true);
    expect(isMemoryForecastAlert("memForecastPct")).toBe(true);
    expect(isMemoryForecastAlert("memPct")).toBe(false);
  });
});

describe("chartTokensForAlert — the scope matrix", () => {
  const sorted = (s: Set<ChartToken>) => [...s].sort();

  it("a generic alert keeps the device charts and loses every scoped token", () => {
    const got = chartTokensForAlert(ALL, "ifInBps", { port: true, sensor: false, mount: true, ratePort: true });
    expect(sorted(got)).toEqual(["chart.cpu", "chart.memory", "chart.probeLoss", "chart.responseTime"]);
  });

  it("chart.trigger with no primary chart is simply dropped", () => {
    const got = chartTokensForAlert(["chart.trigger", "chart.cpu"], "ifInBps", none);
    expect(sorted(got)).toEqual(["chart.cpu"]);
  });

  it("chart.trigger resolves to the primary, so a body asking only for the alias still draws it", () => {
    expect(sorted(chartTokensForAlert(["chart.trigger"], "responseTimeMs", none))).toEqual(["chart.responseTime"]);
  });

  it("a port-state alert with no port draws nothing at all", () => {
    expect(chartTokensForAlert(ALL, "ifOperStatus", none).size).toBe(0);
  });

  it("a port-state alert WITH a port keeps only the SD-WAN trio (the WAN-member case)", () => {
    const got = chartTokensForAlert(ALL, "ifOperStatus", { port: true, sensor: true, mount: true, ratePort: true });
    expect(sorted(got)).toEqual(["chart.sdwanJitter", "chart.sdwanLatency", "chart.sdwanLoss"]);
  });

  it("a path-check alert draws nothing, whatever it carries", () => {
    expect(chartTokensForAlert(ALL, "pathOk", { port: true, sensor: true, mount: true, ratePort: true }).size).toBe(0);
  });

  it("a sensor alert keeps chart.sensor only when it names a sensor", () => {
    expect(chartTokensForAlert(ALL, "hwSensorValue", { ...none, sensor: true }).has("chart.sensor")).toBe(true);
    expect(chartTokensForAlert(ALL, "hwSensorValue", none).has("chart.sensor")).toBe(false);
  });

  it("a storage alert swaps the device + sensor charts for chart.storage, and needs a mount", () => {
    const got = chartTokensForAlert(ALL, "storageUsedPct", { port: false, sensor: true, mount: true });
    expect(sorted(got)).toEqual(["chart.storage"]);
    expect(chartTokensForAlert(ALL, "storageUsedPct", { ...none, sensor: true }).size).toBe(0);
  });

  it("an SD-WAN alert swaps the device charts for the trio", () => {
    const got = chartTokensForAlert(ALL, "sdwanPacketLoss", none);
    expect(sorted(got)).toEqual(["chart.sdwanJitter", "chart.sdwanLatency", "chart.sdwanLoss"]);
  });

  it("a CPU alert keeps CPU + memory and nothing else, even with a sensor present", () => {
    expect(sorted(chartTokensForAlert(ALL, "cpuPct", { port: true, sensor: true, mount: true }))).toEqual(["chart.cpu", "chart.memory"]);
  });

  it("a resource alert never ADDS a chart the body did not ask for", () => {
    expect(sorted(chartTokensForAlert(["chart.cpu", "chart.responseTime"], "memPct", none))).toEqual(["chart.cpu"]);
  });

  it("the interface rate chart rides only on a rate alert that names its port", () => {
    const got = chartTokensForAlert(ALL, "fcLinkFailureRate", { ...none, ratePort: true });
    expect(sorted(got)).toEqual(["chart.cpu", "chart.interface", "chart.memory", "chart.probeLoss", "chart.responseTime"]);
    expect(chartTokensForAlert(ALL, "fcLinkFailureRate", none).has("chart.interface")).toBe(false);
  });

  it("does not mutate the token list it was given", () => {
    const input: ChartToken[] = ["chart.trigger", "chart.cpu"];
    chartTokensForAlert(input, "ifOperStatus", none);
    expect(input).toEqual(["chart.trigger", "chart.cpu"]);
  });
});

describe("interfaceRatePoints — the edges", () => {
  const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);
  const at = (s: number) => new Date(t0 + s * 1000);

  it("unknown metric → no points", () => {
    expect(interfaceRatePoints([{ timestamp: at(0), inErrors: 1n }], "ifInBps")).toEqual([]);
  });

  it("a counter that went backwards (cleared) is skipped and becomes the new base", () => {
    const pts = interfaceRatePoints([
      { timestamp: at(0), inErrors: 100n },
      { timestamp: at(10), inErrors: 150n },
      { timestamp: at(20), inErrors: 5n },
      { timestamp: at(30), inErrors: 25n },
    ], "ifInErrorRate");
    expect(pts).toEqual([{ t: at(10).getTime(), v: 5 }, { t: at(30).getTime(), v: 2 }]);
  });

  it("two rows at the same instant never divide by zero", () => {
    const pts = interfaceRatePoints([
      { timestamp: at(0), outErrors: 1n },
      { timestamp: at(0), outErrors: 9n },
      { timestamp: at(4), outErrors: 13n },
    ], "ifOutErrorRate");
    expect(pts).toEqual([{ t: at(4).getTime(), v: 1 }]);
  });

  it("null counters are skipped, never paired across", () => {
    const pts = interfaceRatePoints([
      { timestamp: at(0), inErrors: 0n },
      { timestamp: at(10), inErrors: null },
      { timestamp: at(20), inErrors: 20n },
    ], "ifInErrorRate");
    expect(pts).toEqual([{ t: at(20).getTime(), v: 1 }]);
  });

  it("an FC counter is per MINUTE and rows without fcErrors are skipped", () => {
    const pts = interfaceRatePoints([
      { timestamp: at(0), fcErrors: { invalidCrcs: 10 } },
      { timestamp: at(30), fcErrors: null },
      { timestamp: at(60), fcErrors: { invalidCrcs: 16 } },
    ], "fcCrcErrorRate");
    expect(pts).toEqual([{ t: at(60).getTime(), v: 6 }]);
  });

  it("thins a long window to at most 240 points and keeps the newest", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ timestamp: at(i), inErrors: BigInt(i) }));
    const pts = interfaceRatePoints(rows, "ifInErrorRate");
    expect(pts.length).toBeLessThanOrEqual(241);
    expect(pts[pts.length - 1]!.t).toBe(at(999).getTime());
  });
});

describe("sensorReadingDisplay — the sentence agrees with the chart", () => {
  it("converts a Celsius reading to °F when the install displays °F", async () => {
    stubbed(prisma.assetHardwareSensorSample.findFirst).mockResolvedValue({ unit: "°C" });
    h.getBranding.mockResolvedValue({ temperatureUnit: "f" });
    await expect(sensorReadingDisplay("a1", "CPU Temp", 100)).resolves.toEqual({ value: 212, unit: "°F" });
    expect(prisma.assetHardwareSensorSample.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { assetId: "a1", sensorName: "CPU Temp" },
      orderBy: { timestamp: "desc" },
    }));
  });

  it("leaves a non-temperature unit and a °C install alone", async () => {
    stubbed(prisma.assetHardwareSensorSample.findFirst).mockResolvedValue({ unit: "RPM" });
    h.getBranding.mockResolvedValue({ temperatureUnit: "f" });
    await expect(sensorReadingDisplay("a1", "Fan1", 4200)).resolves.toEqual({ value: 4200, unit: "RPM" });
    stubbed(prisma.assetHardwareSensorSample.findFirst).mockResolvedValue({ unit: "C" });
    h.getBranding.mockResolvedValue({ temperatureUnit: "c" });
    await expect(sensorReadingDisplay("a1", "Inlet", 31.5)).resolves.toEqual({ value: 31.5, unit: "°C" });
  });

  it("passes a non-numeric reading through untouched", async () => {
    stubbed(prisma.assetHardwareSensorSample.findFirst).mockResolvedValue({ unit: "°C" });
    h.getBranding.mockResolvedValue({ temperatureUnit: "f" });
    await expect(sensorReadingDisplay("a1", "PSU", "alarm")).resolves.toEqual({ value: "alarm", unit: "°F" });
    await expect(sensorReadingDisplay("a1", "PSU", null)).resolves.toEqual({ value: null, unit: "°F" });
  });

  it("no sample row → no unit, the value unchanged", async () => {
    stubbed(prisma.assetHardwareSensorSample.findFirst).mockResolvedValue(null);
    h.getBranding.mockResolvedValue({ temperatureUnit: "f" });
    await expect(sensorReadingDisplay("a1", "x", 7)).resolves.toEqual({ value: 7, unit: "" });
  });

  it("never blocks an alert: a failed lookup returns the raw value with no unit", async () => {
    stubbed(prisma.assetHardwareSensorSample.findFirst).mockRejectedValue(new Error("db down"));
    h.getBranding.mockResolvedValue({ temperatureUnit: "f" });
    await expect(sensorReadingDisplay("a1", "x", 90.4)).resolves.toEqual({ value: 90.4, unit: "" });
    stubbed(prisma.assetHardwareSensorSample.findFirst).mockResolvedValue({ unit: "°C" });
    h.getBranding.mockRejectedValue(new Error("settings gone"));
    await expect(sensorReadingDisplay("a1", "x", 90.4)).resolves.toEqual({ value: 90.4, unit: "" });
  });
});

describe("bytesDisplayScale / memorySeriesFrom", () => {
  it("picks the largest unit keeping the number ≥ 1, capped at PB", () => {
    expect(bytesDisplayScale(0)).toEqual({ divisor: 1, unit: " B" });
    expect(bytesDisplayScale(1023)).toEqual({ divisor: 1, unit: " B" });
    expect(bytesDisplayScale(1024)).toEqual({ divisor: 1024, unit: " KB" });
    expect(bytesDisplayScale(1024 ** 3 * 16).unit).toBe(" GB");
    expect(bytesDisplayScale(1024 ** 7).unit).toBe(" PB");
  });

  it("bytes win whenever the window has them; percent-only rows are dropped from a bytes series", () => {
    const gb = 1024 ** 3;
    const s = memorySeriesFrom([
      { t: 1, memPct: 50, memUsedBytes: null, memTotalBytes: null },
      { t: 2, memPct: 60, memUsedBytes: BigInt(2 * gb), memTotalBytes: BigInt(4 * gb) },
      { t: 3, memPct: 70, memUsedBytes: 3 * gb, memTotalBytes: 8 * gb },
    ]);
    expect(s).toEqual({ points: [{ t: 2, v: 2 }, { t: 3, v: 3 }], unit: " GB", percent: false, total: 8 });
  });

  it("a zero total is not a bytes row; percent-only devices keep the 0–100 chart", () => {
    const s = memorySeriesFrom([
      { t: 1, memPct: 40, memUsedBytes: 5, memTotalBytes: 0 },
      { t: 2, memPct: null, memUsedBytes: null, memTotalBytes: null },
    ]);
    expect(s).toEqual({ points: [{ t: 1, v: 40 }], unit: "%", percent: true, total: null });
  });
});

describe("chart tokens in a body", () => {
  const chart = (token: ChartToken, over: Partial<RenderedChart> = {}): RenderedChart => ({
    token,
    cid: `${token}@polaris`,
    attachment: { filename: `${token}.png`, content: Buffer.from("png"), cid: `${token}@polaris`, contentType: "image/png" } as never,
    summary: `${token} summary`,
    hasData: true,
    ...over,
  });

  it("chartTokensIn finds only braced tokens across several templates, skipping null", () => {
    const got = chartTokensIn("x {chart.cpu} chart.memory", null, undefined, "{chart.trigger}{chart.cpu}");
    expect([...got].sort()).toEqual(["chart.cpu", "chart.trigger"]);
  });

  it("text mode substitutes the summary; a chart with no data or none built renders away", () => {
    const charts = new Map<ChartToken, RenderedChart>([
      ["chart.cpu", chart("chart.cpu")],
      ["chart.memory", chart("chart.memory", { hasData: false })],
    ]);
    const out = substituteChartTokens("A{chart.cpu}B{chart.memory}C{chart.probeLoss}D", charts, { html: false });
    expect(out).toBe("Achart.cpu summaryBCD");
  });

  it("the alias draws the primary once; the primary's own token later renders away", () => {
    const cpu = chart("chart.cpu");
    const charts = new Map<ChartToken, RenderedChart>([["chart.cpu", cpu], ["chart.trigger", { ...cpu, token: "chart.trigger" }]]);
    const out = substituteChartTokens("{chart.trigger}|{chart.cpu}|{chart.cpu}", charts, { html: false });
    expect(out).toBe("chart.cpu summary||");
  });

  it("every occurrence of a token is replaced when it is the first emission", () => {
    const charts = new Map<ChartToken, RenderedChart>([["chart.cpu", chart("chart.cpu")]]);
    expect(substituteChartTokens("{chart.cpu}{chart.cpu}", charts, { html: false })).toBe("chart.cpu summarychart.cpu summary");
  });

  it("html: an <img> by cid with an escaped alt; a failed PNG falls back to an escaped paragraph", () => {
    const charts = new Map<ChartToken, RenderedChart>([
      ["chart.cpu", chart("chart.cpu", { summary: 'CPU <"now"> & 9%' })],
      ["chart.memory", chart("chart.memory", { attachment: null, summary: "Mem <b>" })],
    ]);
    const out = substituteChartTokens("{chart.cpu}{chart.memory}", charts, { html: true });
    expect(out).toContain('src="cid:chart.cpu@polaris"');
    expect(out).toContain('alt="CPU &lt;&quot;now&quot;&gt; &amp; 9%"');
    expect(out).toContain(">Mem &lt;b&gt;</p>");
  });

  it("attachmentsFor returns only the attachments the body references", () => {
    const charts = new Map<ChartToken, RenderedChart>([
      ["chart.cpu", chart("chart.cpu")],
      ["chart.memory", chart("chart.memory")],
      ["chart.responseTime", chart("chart.responseTime", { attachment: null })],
    ]);
    const got = attachmentsFor(charts, '<img src="cid:chart.cpu@polaris"> cid:chart.responseTime@polaris');
    expect(got).toHaveLength(1);
    expect((got[0] as unknown as { cid: string }).cid).toBe("chart.cpu@polaris");
  });
});
