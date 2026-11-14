/**
 * tests/unit/alertInterfaceRateChart.test.ts — the alert email's port chart
 * and FC login block (business rule 159a).
 *
 * Pinned:
 *  - an interface error-rate or FC counter alert leads with `{chart.interface}`
 *    through `{chart.trigger}`, follows it with the port's traffic in and out,
 *    and draws none of the device charts; the three tokens render away on
 *    every other alert, and an alert with no port keeps the device charts;
 *  - the traffic series is bits per second, a cleared or wrapped counter
 *    skipped, each direction paired on its own readings;
 *  - the series is the rate the engine compared: per second for the error
 *    rates, per minute for FC, a cleared counter skipped, FC rows without a
 *    reading skipped rather than paired;
 *  - the automation's own threshold reaches the chart;
 *  - an FC alert names what is logged into the port.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  chartTokenForMetric,
  chartTokensForAlert,
  bitsDisplayScale,
  interfaceRatePoints,
  interfaceTrafficPoints,
  isInterfaceRateAlert,
  storageThresholdFromTrigger,
  type ChartToken,
} from "../../src/services/alertChartService.js";
import { renderInterfaceFcLogins } from "../../src/services/alertInterfaceService.js";

const DEFAULT: ChartToken[] = [
  "chart.trigger", "chart.sensor", "chart.probeLoss", "chart.storage",
  "chart.interface", "chart.interfaceIn", "chart.interfaceOut",
  "chart.cpu", "chart.memory", "chart.responseTime",
];
const has = (ratePort: boolean) => ({ port: false, sensor: false, mount: false, ratePort });
const at = (m: number) => new Date(Date.UTC(2026, 10, 12, 14, m));

describe("which charts an interface rate alert draws", () => {
  it("leads with the port chart, adds its traffic, and drops the device charts", () => {
    for (const m of ["ifInErrorRate", "ifOutErrorRate", "fcCrcErrorRate", "fcLinkFailureRate", "fcSyncLossRate", "fcSignalLossRate", "fcInvalidTxWordRate"]) {
      expect(chartTokenForMetric(m)).toBe("chart.interface");
      expect(isInterfaceRateAlert(m)).toBe(true);
      const w = chartTokensForAlert(DEFAULT, m, has(true));
      expect([...w].sort()).toEqual(["chart.interface", "chart.interfaceIn", "chart.interfaceOut"]);
    }
  });

  it("keeps the device charts on a rate alert with no port, and on a throughput alert", () => {
    const noPort = chartTokensForAlert(DEFAULT, "ifInErrorRate", has(false));
    expect(noPort.has("chart.cpu")).toBe(true);
    expect(noPort.has("chart.interfaceIn")).toBe(false);
    const bps = chartTokensForAlert(DEFAULT, "ifInBps", has(true));
    expect(bps.has("chart.cpu")).toBe(true);
    expect(bps.has("chart.interfaceIn")).toBe(false);
    expect(bps.has("chart.interfaceOut")).toBe(false);
  });

  it("draws no port chart without a port, and none on any other alert", () => {
    expect(chartTokensForAlert(DEFAULT, "fcCrcErrorRate", has(false)).has("chart.interface")).toBe(false);
    expect(chartTokensForAlert([...DEFAULT, "chart.interface"], "cpuPct", has(true)).has("chart.interface")).toBe(false);
    expect(chartTokenForMetric("ifInBps")).toBeNull();
  });

  it("passes the automation's threshold to the chart", () => {
    expect(storageThresholdFromTrigger({ type: "asset_metric", metric: "fcCrcErrorRate", threshold: 5 })).toBe(5);
    expect(storageThresholdFromTrigger({ type: "asset_metric", metric: "ifInErrorRate", threshold: 0.5 })).toBe(0.5);
    expect(storageThresholdFromTrigger({ type: "asset_metric", metric: "cpuPct", threshold: 90 })).toBeNull();
  });
});

describe("interfaceTrafficPoints", () => {
  it("is bits per second each way, a cleared counter skipped, each direction on its own readings", () => {
    const t = interfaceTrafficPoints([
      { timestamp: at(0), inOctets: 0n, outOctets: 1000n },
      { timestamp: at(1), inOctets: 7_500_000n, outOctets: null },
      { timestamp: at(2), inOctets: 100n, outOctets: 1000n + 15_000n },  // in cleared
      { timestamp: at(3), inOctets: 750_100n, outOctets: 1000n + 22_500n },
    ]);
    expect(t.in.map((p) => p.v)).toEqual([1_000_000, 100_000]);
    // out pairs minute 0 with minute 2 (the null is skipped, not a zero).
    expect(t.out.map((p) => p.v)).toEqual([1000, 1000]);
  });

  it("scales a reading to the unit that fits", () => {
    expect(bitsDisplayScale(950)).toEqual({ divisor: 1, unit: " bps" });
    expect(bitsDisplayScale(2_400_000_000)).toEqual({ divisor: 1e9, unit: " Gbps" });
    expect(bitsDisplayScale(0)).toEqual({ divisor: 1, unit: " bps" });
  });
});

describe("interfaceRatePoints", () => {
  it("is errors per second between consecutive samples, a cleared counter skipped", () => {
    const pts = interfaceRatePoints([
      { timestamp: at(0), inErrors: 100n },
      { timestamp: at(1), inErrors: 160n },
      { timestamp: at(2), inErrors: 10n },  // cleared
      { timestamp: at(3), inErrors: 70n },
    ], "ifInErrorRate");
    expect(pts.map((p) => p.v)).toEqual([1, 1]);
  });

  it("is an FC counter per minute, rows without an FC reading skipped, not paired", () => {
    const fc = (invalidCrcs: number) => ({ invalidCrcs, linkFailures: 0, syncLosses: 0, sigLosses: 0, invalidTxWords: 0, linkResetIns: 0, linkResetOuts: 0 });
    const pts = interfaceRatePoints([
      { timestamp: at(0), fcErrors: fc(4) },
      { timestamp: at(1), fcErrors: null },
      { timestamp: at(2), fcErrors: fc(14) },
    ], "fcCrcErrorRate");
    expect(pts).toEqual([{ t: at(2).getTime(), v: 5 }]);
  });
});

describe("renderInterfaceFcLogins", () => {
  const login = { name: "esx01", matchedType: "server", matchMethod: "wwn", portWwn: "10:00:00:90:fa:00:00:01", vsan: 101, hba: "Emulex SN1610E", lastSeen: at(5) };

  it("names the logged-in device, its WWN, VSAN, HBA and how it was matched", () => {
    const html = renderInterfaceFcLogins("fc1/5", [login], { html: true });
    expect(html).toContain("Logged in to fc1/5");
    expect(html).toContain("esx01 (server)");
    expect(html).toContain("10:00:00:90:fa:00:00:01");
    expect(html).toContain("the WWN the host reports");
    const text = renderInterfaceFcLogins("fc1/5", [login], { html: false });
    expect(text.split("\n")[0]).toBe("Logged in to fc1/5"); // no colon: pruneEmptyTextLines keeps it
    expect(text).toContain("VSAN");
  });

  it("is empty for a port with nothing logged in", () => {
    expect(renderInterfaceFcLogins("fc1/7", [], { html: true })).toBe("");
  });
});
