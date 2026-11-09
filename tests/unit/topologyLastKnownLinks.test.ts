/**
 * tests/unit/topologyLastKnownLinks.test.ts — the Device Map keeps a
 * switch-to-switch link as LAST KNOWN while an end of it is dark.
 *
 * Operator report (2026-11-09): when a switch went dependency-down, its
 * switch-to-switch links vanished from the map about an hour later (the switch
 * to AP links stayed) and the site redrew as a star off the FortiGate. Those
 * links rest on interface and LLDP rows only a full scrape refreshes, and
 * `runsHeavyCadences` stops the full scrape for a suppressed / down device, so
 * the rows aged past the one-hour cutoff. A dark end now keeps them for up to
 * seven days, marked `lastKnownAt`. Pins business rule 144.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { findInterfaces, findAssets } = vi.hoisted(() => ({
  findInterfaces: vi.fn(),
  findAssets: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetInterface: { findMany: findInterfaces },
    asset: { findMany: findAssets },
  },
}));

import { inferInterfaceTopology, INTERFACE_LAST_KNOWN_MS } from "../../src/services/interfaceTopologyService.js";
import { lldpOnlySwitchLinks } from "../../src/services/topologyGraphService.js";
import { keepsLastKnownLinks } from "../../src/utils/monitorStatus.js";

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

// Two FortiSwitches joined by FortiOS's auto-named peer aggregate: each names
// the other's serial (the last 14 characters).
const sw = (id: string, serial: string, over: Record<string, unknown> = {}) => ({
  id, hostname: id.toUpperCase(), serialNumber: serial, ipAddress: null,
  assetType: "switch", manufacturer: "Fortinet", model: null,
  monitored: true, monitorStatus: "up", consecutiveFailures: 0, dependencySuppressed: false,
  ...over,
});
const SW1 = "S148FFTF21000001";
const SW2 = "S148FFTF21000002";
const trunk = (assetId: string, peerSerial: string, lastSeen: Date) => ({
  assetId, ifName: peerSerial.slice(-14), ifType: "aggregate", ifParent: null, lastSeen,
});

beforeEach(() => {
  findInterfaces.mockReset();
  findAssets.mockReset();
});

describe("keepsLastKnownLinks", () => {
  const a = (over: Record<string, unknown>) => ({ monitored: true, monitorStatus: "up", consecutiveFailures: 0, dependencySuppressed: false, ...over });
  it("is true for a monitored device Polaris stopped fully polling", () => {
    expect(keepsLastKnownLinks(a({ dependencySuppressed: true }))).toBe(true);
    expect(keepsLastKnownLinks(a({ monitorStatus: "down", consecutiveFailures: 5 }))).toBe(true);
    expect(keepsLastKnownLinks(a({ monitorStatus: "recovering", consecutiveFailures: 2 }))).toBe(true);
  });
  it("is false for a device still fully polled, and for an unmonitored one", () => {
    expect(keepsLastKnownLinks(a({}))).toBe(false);
    expect(keepsLastKnownLinks(a({ monitored: false, monitorStatus: "down" }))).toBe(false);
  });
});

describe("inferInterfaceTopology — last-known links", () => {
  it("reads up to seven days of rows (the hour is applied per link, after matching)", async () => {
    findInterfaces.mockResolvedValue([]);
    findAssets.mockResolvedValue([]);
    const before = Date.now();
    await inferInterfaceTopology(["sw1"]);
    const gt: Date = findInterfaces.mock.calls[0][0].where.lastSeen.gt;
    expect(Math.abs(before - INTERFACE_LAST_KNOWN_MS - gt.getTime())).toBeLessThan(5000);
  });

  it("keeps a link whose rows are hours old when an end is dependency-down, and marks it", async () => {
    const seen = ago(3 * HOUR);
    findInterfaces.mockResolvedValue([trunk("sw1", SW2, seen), trunk("sw2", SW1, seen)]);
    findAssets.mockResolvedValue([sw("sw1", SW1), sw("sw2", SW2, { dependencySuppressed: true })]);
    const { edges, darkAssetIds } = await inferInterfaceTopology(["sw1", "sw2"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ sourceAssetId: "sw1", targetAssetId: "sw2" });
    expect(edges[0].lastKnownAt).toEqual(seen);
    expect([...darkAssetIds]).toEqual(["sw2"]);
  });

  it("keeps it from the healthy end's row alone (its trunk to the dark switch is not refreshed either)", async () => {
    findInterfaces.mockResolvedValue([trunk("sw1", SW2, ago(2 * HOUR))]);
    findAssets.mockResolvedValue([sw("sw1", SW1), sw("sw2", SW2, { monitorStatus: "down", consecutiveFailures: 9 })]);
    const { edges } = await inferInterfaceTopology(["sw1", "sw2"]);
    expect(edges).toHaveLength(1);
  });

  it("still drops an hour-old link between two devices Polaris polls", async () => {
    findInterfaces.mockResolvedValue([trunk("sw1", SW2, ago(2 * HOUR)), trunk("sw2", SW1, ago(2 * HOUR))]);
    findAssets.mockResolvedValue([sw("sw1", SW1), sw("sw2", SW2)]);
    const { edges } = await inferInterfaceTopology(["sw1", "sw2"]);
    expect(edges).toEqual([]);
  });

  it("a fresh link carries no last-known mark, even with a dark end", async () => {
    findInterfaces.mockResolvedValue([trunk("sw1", SW2, ago(60 * 1000)), trunk("sw2", SW1, ago(3 * HOUR))]);
    findAssets.mockResolvedValue([sw("sw1", SW1), sw("sw2", SW2, { dependencySuppressed: true })]);
    const { edges } = await inferInterfaceTopology(["sw1", "sw2"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].lastKnownAt).toBeUndefined();
  });
});

describe("lldpOnlySwitchLinks — last-known links", () => {
  const SWITCHES = new Set(["sw1", "sw2"]);
  const CUTOFF = ago(HOUR);
  const row = (assetId: string, peer: string, lastSeen: Date) => ({
    assetId, matchedAssetId: peer, localIfName: "port49", portId: "port50", portIdSubtype: "interfaceName", lastSeen,
  });

  it("keeps an hour-old LLDP link when an end is dark, with the newest sighting", () => {
    const seen = ago(4 * HOUR);
    const links = lldpOnlySwitchLinks([row("sw1", "sw2", seen)], SWITCHES, new Set(), CUTOFF,
      { darkIds: new Set(["sw2"]), cutoff: ago(INTERFACE_LAST_KNOWN_MS) });
    expect(links).toHaveLength(1);
    expect(links[0].lastKnownAt).toEqual(seen);
  });

  it("drops it when neither end is dark, or past the seven days", () => {
    expect(lldpOnlySwitchLinks([row("sw1", "sw2", ago(4 * HOUR))], SWITCHES, new Set(), CUTOFF,
      { darkIds: new Set(), cutoff: ago(INTERFACE_LAST_KNOWN_MS) })).toEqual([]);
    expect(lldpOnlySwitchLinks([row("sw1", "sw2", ago(8 * 24 * HOUR))], SWITCHES, new Set(), CUTOFF,
      { darkIds: new Set(["sw2"]), cutoff: ago(INTERFACE_LAST_KNOWN_MS) })).toEqual([]);
  });
});
