/**
 * tests/unit/ipUpstreamChain.test.ts
 *
 * The pure decisions behind the IP-keyed upstream sweep
 * (services/ipUpstreamChainService.ts): which ARP rows may name the MAC at an
 * address, which of several learning ports is the attachment point, and when a
 * stored stamp counts as moved. The DB-bound sweep is covered by
 * tests/integration/ipUpstreamChain.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  claimIsFresh,
  pickArpMac,
  pickBestSwitchPort,
  portKey,
  stampChanged,
  switchPortLabel,
  type ArpRowLite,
  type FdbRowLite,
  type MaclessClaimRow,
} from "../../src/services/ipUpstreamChainService.js";

const T0 = new Date("2026-09-08T12:00:00Z");
const CUTOFF = new Date("2026-09-01T12:00:00Z");

function claim(over: Partial<MaclessClaimRow> = {}): MaclessClaimRow {
  return {
    id: "a1", hostname: "host", ip: "10.1.1.50", ipSource: "fortigate", ipOverride: null,
    lastSeen: null, ipLastSeen: null, lastSeenSwitch: null, lastSeenAp: null,
    ...over,
  };
}

function arp(assetId: string, mac: string, over: Partial<ArpRowLite> = {}): ArpRowLite {
  return { assetId, ipAddress: "10.1.1.50", macAddress: mac, lastSeen: T0, ...over };
}

function fdb(assetId: string, ifName: string, over: Partial<FdbRowLite> = {}): FdbRowLite {
  return { assetId, macAddress: "AA:BB:CC:DD:EE:01", ifName, lastSeen: T0, ...over };
}

describe("claimIsFresh", () => {
  it("never expires an operator-owned claim", () => {
    expect(claimIsFresh(claim({ ipSource: "manual" }), CUTOFF)).toBe(true);
    expect(claimIsFresh(claim({ ipOverride: "10.1.1.50" }), CUTOFF)).toBe(true);
  });

  it("reads the per-address history timestamp before the asset's own presence", () => {
    // Device is demonstrably up but the ADDRESS was last asserted months ago:
    // a stale record, not a current claim (rule 40).
    expect(claimIsFresh(claim({ lastSeen: T0, ipLastSeen: new Date("2026-05-01T00:00:00Z") }), CUTOFF)).toBe(false);
    expect(claimIsFresh(claim({ lastSeen: null, ipLastSeen: T0 }), CUTOFF)).toBe(true);
  });

  it("falls back to lastSeen only when there is no history row at all", () => {
    expect(claimIsFresh(claim({ lastSeen: T0 }), CUTOFF)).toBe(true);
    expect(claimIsFresh(claim({ lastSeen: new Date("2026-01-01T00:00:00Z") }), CUTOFF)).toBe(false);
    expect(claimIsFresh(claim(), CUTOFF)).toBe(false);
  });
});

describe("pickArpMac", () => {
  it("takes the owning gate's row and ignores every other gate", () => {
    // Overlapping RFC1918: another site's gate has a different device at the
    // same address. Only the owning gate may answer.
    const rows = [arp("gate-A", "AA:AA:AA:AA:AA:01"), arp("gate-B", "BB:BB:BB:BB:BB:02")];
    expect(pickArpMac(rows, "gate-A")).toEqual({ mac: "AA:AA:AA:AA:AA:01", gateAssetId: "gate-A" });
  });

  it("returns null when the owning gate has no row, even if another gate does", () => {
    expect(pickArpMac([arp("gate-B", "BB:BB:BB:BB:BB:02")], "gate-A")).toBeNull();
  });

  it("with no owning gate, accepts rows only when a single gate reports the address", () => {
    expect(pickArpMac([arp("gate-B", "BB:BB:BB:BB:BB:02")], null))
      .toEqual({ mac: "BB:BB:BB:BB:BB:02", gateAssetId: "gate-B" });
    expect(pickArpMac([arp("gate-A", "AA:AA:AA:AA:AA:01"), arp("gate-B", "AA:AA:AA:AA:AA:01")], null))
      .toBe("ambiguous");
  });

  it("refuses two MACs at one address on the same gate (rule 26's duplicate rule)", () => {
    const rows = [
      arp("gate-A", "AA:AA:AA:AA:AA:01", { lastSeen: T0 }),
      arp("gate-A", "CC:CC:CC:CC:CC:03", { lastSeen: new Date(T0.getTime() - 60_000) }),
    ];
    expect(pickArpMac(rows, "gate-A")).toBe("ambiguous");
  });

  it("collapses the same MAC seen on several interfaces of one gate", () => {
    const rows = [arp("gate-A", "AA:AA:AA:AA:AA:01"), arp("gate-A", "AA:AA:AA:AA:AA:01")];
    expect(pickArpMac(rows, "gate-A")).toEqual({ mac: "AA:AA:AA:AA:AA:01", gateAssetId: "gate-A" });
  });

  it("returns null for no rows", () => {
    expect(pickArpMac([], "gate-A")).toBeNull();
    expect(pickArpMac([], null)).toBeNull();
  });
});

describe("pickBestSwitchPort", () => {
  it("prefers the port that learned the fewest MACs (access over uplink)", () => {
    const rows = [fdb("core", "port48"), fdb("edge", "port7")];
    const card = new Map([[portKey("core", "port48"), 120], [portKey("edge", "port7"), 1]]);
    expect(pickBestSwitchPort(rows, card)?.assetId).toBe("edge");
  });

  it("breaks a cardinality tie on the freshest sighting", () => {
    const older = fdb("sw1", "port1", { lastSeen: new Date(T0.getTime() - 3_600_000) });
    const newer = fdb("sw2", "port2", { lastSeen: T0 });
    const card = new Map([[portKey("sw1", "port1"), 1], [portKey("sw2", "port2"), 1]]);
    expect(pickBestSwitchPort([older, newer], card)?.assetId).toBe("sw2");
  });

  it("breaks a full tie on a stable name order, whichever way the rows arrive", () => {
    const a = fdb("sw1", "port1");
    const b = fdb("sw1", "port2");
    const card = new Map([[portKey("sw1", "port1"), 1], [portKey("sw1", "port2"), 1]]);
    expect(pickBestSwitchPort([a, b], card)?.ifName).toBe("port1");
    expect(pickBestSwitchPort([b, a], card)?.ifName).toBe("port1");
  });

  it("treats a port with no cardinality row as a single-MAC port", () => {
    const rows = [fdb("core", "port48"), fdb("edge", "port7")];
    const card = new Map([[portKey("core", "port48"), 40]]);
    expect(pickBestSwitchPort(rows, card)?.assetId).toBe("edge");
  });

  it("returns null for no rows", () => {
    expect(pickBestSwitchPort([], new Map())).toBeNull();
  });
});

describe("labels and change detection", () => {
  it("writes the <switch>/<port> shape the three parsers of lastSeenSwitch read", () => {
    expect(switchPortLabel("plv-sw-01", "port12")).toBe("plv-sw-01/port12");
  });

  it("compares stamps case-insensitively and ignores padding", () => {
    expect(stampChanged("PLV-SW-01/port12", "plv-sw-01/port12")).toBe(false);
    expect(stampChanged("  plv-sw-01/port12 ", "plv-sw-01/port12")).toBe(false);
    expect(stampChanged(null, "plv-sw-01/port12")).toBe(true);
    expect(stampChanged("plv-sw-01/port12", "plv-sw-01/port13")).toBe(true);
  });
});
