/**
 * tests/unit/fcPortCounters.test.ts
 *
 * Business rule 159(a) — a fibre-channel port's counters as a sampled,
 * alertable series, and its WWN on the Interfaces table.
 *
 * Pinned:
 *  - stored counters read back only as finite non-negative numbers, and a row
 *    with none reads as NO reading, never as zeros;
 *  - every FC rate metric is a real automation metric with a label, a unit, a
 *    cadence, the interface-name dimension and the pinned-interface gate;
 *  - an FC port's WWN comes from an 8-byte ifPhysAddress on ifType 56 only;
 *  - the full scrape copies each FC port's counters onto its interface row;
 *  - the Interfaces table's three FC cells.
 */

import { describe, it, expect, vi } from "vitest";
import vm from "node:vm";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  FC_RATE_METRICS,
  FC_ERROR_COLUMNS,
  fcErrorsFrom,
  isFcRateMetric,
  type FcErrorCounters,
} from "../../src/utils/fibreChannel.js";
import { ASSET_METRICS } from "../../src/services/notificationTypes/triggers.js";
import { METRIC_META } from "../../src/services/notificationTypes/metricMeta.js";
import { METRIC_DIMENSIONS, triggerIsPerDimension } from "../../src/services/notificationTypes/dimensions.js";
import { METRIC_STREAM } from "../../src/services/notificationCadenceService.js";
import { pinTestForTrigger, interfaceIsPinned } from "../../src/services/notifications/scope.js";
import { isInterfaceDimensionMetric } from "../../src/services/alertInterfaceService.js";
import { snmpWwnFromPhysAddress, attachFcErrors } from "../../src/services/monitoring/snmpCollectors.js";
import { assetsFileSource } from "./_assetsSource.js";

const counters = (over: Partial<FcErrorCounters> = {}): FcErrorCounters => ({
  linkFailures: 0, syncLosses: 0, sigLosses: 0, invalidTxWords: 0, invalidCrcs: 0,
  linkResetIns: 0, linkResetOuts: 0, ...over,
});

describe("fcErrorsFrom", () => {
  it("keeps finite non-negative numbers, nulls the rest", () => {
    expect(fcErrorsFrom({ invalidCrcs: 7, linkFailures: -1, syncLosses: "3", sigLosses: NaN })).toEqual({
      linkFailures: null, syncLosses: 3, sigLosses: null, invalidTxWords: null, invalidCrcs: 7,
      linkResetIns: null, linkResetOuts: null,
    });
  });

  it("is null for a row that carries no FC reading", () => {
    expect(fcErrorsFrom(null)).toBeNull();
    expect(fcErrorsFrom(undefined)).toBeNull();
    expect(fcErrorsFrom([])).toBeNull();
    expect(fcErrorsFrom({})).toBeNull();
    expect(fcErrorsFrom({ linkFailures: null })).toBeNull();
  });
});

describe("the FC rate metrics", () => {
  const metrics = Object.keys(FC_RATE_METRICS);

  it("each reads a real fcIfErrorTable counter", () => {
    const fields = new Set(FC_ERROR_COLUMNS.map(([f]) => f));
    for (const m of metrics) expect(fields.has(FC_RATE_METRICS[m as keyof typeof FC_RATE_METRICS])).toBe(true);
    expect(isFcRateMetric("fcCrcErrorRate")).toBe(true);
    expect(isFcRateMetric("ifInErrorRate")).toBe(false);
    expect(isFcRateMetric("toString")).toBe(false);
  });

  it("are automation metrics with a per-minute unit, a cadence and the interface dimension", () => {
    for (const m of metrics) {
      expect((ASSET_METRICS as readonly string[]).includes(m)).toBe(true);
      expect(METRIC_META[m]?.unit).toMatch(/\/min$/);
      expect(METRIC_STREAM[m]).toBe("systemInfo");
      expect(METRIC_DIMENSIONS[m]).toEqual(["ifNamePattern"]);
      expect(triggerIsPerDimension({ type: "asset_metric", metric: m } as never)).toBe(true);
      expect(isInterfaceDimensionMetric(m)).toBe(true);
    }
  });

  it("read pinned ports only", () => {
    for (const m of metrics) {
      expect(pinTestForTrigger({ type: "asset_metric", metric: m, operator: ">", value: 0 } as never)).toBe(interfaceIsPinned);
    }
  });
});

describe("snmpWwnFromPhysAddress", () => {
  const wwn = Buffer.from([0x20, 0x01, 0x00, 0x3a, 0x9c, 0x12, 0x34, 0x56]);

  it("reads an FC port's 8-byte ifPhysAddress as its WWN", () => {
    expect(snmpWwnFromPhysAddress(56, wwn)).toBe("20:01:00:3a:9c:12:34:56");
  });

  it("never on another ifType, a 6-byte MAC, or nothing", () => {
    expect(snmpWwnFromPhysAddress(6, wwn)).toBeNull();
    expect(snmpWwnFromPhysAddress(56, Buffer.from([0, 1, 2, 3, 4, 5]))).toBeNull();
    expect(snmpWwnFromPhysAddress(56, null)).toBeNull();
    expect(snmpWwnFromPhysAddress(null, wwn)).toBeNull();
  });
});

describe("attachFcErrors", () => {
  it("copies each FC port's counters onto the interface of the same name", () => {
    const ifaces = [{ ifName: "fc1/1" }, { ifName: "fc1/2" }, { ifName: "mgmt0" }] as Array<{ ifName: string; fcErrors?: FcErrorCounters | null }>;
    attachFcErrors(ifaces as never, [
      { ifIndex: 1, ifName: "fc1/1", errorCounters: counters({ invalidCrcs: 4 }) },
      { ifIndex: 2, ifName: null, errorCounters: counters({ invalidCrcs: 9 }) },
    ]);
    expect(ifaces[0]!.fcErrors?.invalidCrcs).toBe(4);
    expect(ifaces[1]!.fcErrors).toBeUndefined();
    expect(ifaces[2]!.fcErrors).toBeUndefined();
  });
});

describe("the Interfaces table's FC cells", () => {
  const src = assetsFileSource("assets-system.js");
  const start = src.indexOf("var _FC_ERROR_COLS = [");
  const end = src.indexOf("function _lldpNeighborInlineCell(");
  const ctx: Record<string, any> = {
    escapeHtml: (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + "\nthis._fcIfaceCellsHTML = _fcIfaceCellsHTML; this._fcErrorTotal = _fcErrorTotal; this._fcLoginText = _fcLoginText;", ctx);

  const fc = {
    errorCounters: counters({ invalidCrcs: 3, linkFailures: 1 }),
    logins: [
      { vsan: 101, portWwn: "10:00:00:00:c9:00:00:01", hostName: "esx01", matchMethod: "wwn", matchedAsset: { id: "a1", hostname: "esx01.example.test" } },
      { vsan: 101, portWwn: "10:00:00:00:c9:00:00:02", hostName: null, matchMethod: null, matchedAsset: null },
    ],
  };

  it("sums the five counters an operator acts on, null when there are none", () => {
    expect(ctx._fcErrorTotal(fc)).toBe(4);
    expect(ctx._fcErrorTotal(null)).toBeNull();
    expect(ctx._fcErrorTotal({ errorCounters: null, logins: [] })).toBeNull();
  });

  it("names what is logged in by its matched asset, then its WWN", () => {
    expect(ctx._fcLoginText(fc)).toBe("esx01.example.test 10:00:00:00:c9:00:00:01, 10:00:00:00:c9:00:00:02");
  });

  it("draws the WWN, a link to the matched host with a +N, and an amber total with each counter in the tooltip", () => {
    const html: string = ctx._fcIfaceCellsHTML({ wwn: "20:01:00:3a:9c:12:34:56", fc });
    expect(html).toContain(">20:01:00:3a:9c:12:34:56<");
    expect(html).toContain('class="asset-lldp-link" data-asset-id="a1"');
    expect(html).toContain("the WWN the host reports");
    expect(html).toContain(">+1<");
    expect(html).toContain("color:var(--color-warning)");
    expect(html).toContain("CRC errors: 3");
    expect(html).toContain(">4<");
  });

  it("is three dashes on a port with nothing FC about it", () => {
    const html: string = ctx._fcIfaceCellsHTML({ wwn: null, fc: null });
    expect(html.match(/<td/g)).toHaveLength(3);
    expect(html.match(/—/g)).toHaveLength(3);
  });
});
