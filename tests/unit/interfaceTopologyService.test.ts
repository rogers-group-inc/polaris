/**
 * tests/unit/interfaceTopologyService.test.ts — CQ-T010 own suite for
 * src/services/interfaceTopologyService.ts.
 *
 * tests/unit/interfaceTopologyMatching.test.ts pins the hostname-match tiers
 * and the live-only inventory. This suite covers the rest of
 * `inferInterfaceTopology`: the serial path, reciprocal folding, the
 * aggregate → physical-member label swap, ambiguity / self-loop refusals,
 * remote peers, and the last-known-link rule (business rule 144).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { inferInterfaceTopology, INTERFACE_LAST_KNOWN_MS } from "../../src/services/interfaceTopologyService.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

// Synthetic serials. FortiOS names the peer aggregate after the peer's serial,
// front-truncated to fit 15 chars (see utils/fortinetSerialPattern.ts).
const GATE_SERIAL = "FGT61FTK22000001"; // → "GT61FTK22000001"
const SW_SERIAL = "S108FFTV23000001"; //   → "8FFTV23000001-0"
const IF_TO_GATE = "GT61FTK22000001";
const IF_TO_SW = "8FFTV23000001-0";

type Inv = {
  id: string; hostname: string | null; serialNumber: string | null; ipAddress: string | null;
  assetType: string; manufacturer: string | null; model: string | null;
  monitored: boolean; monitorStatus: string | null; consecutiveFailures: number; dependencySuppressed: boolean;
};
const inv = (id: string, assetType: string, serialNumber: string | null, extra: Partial<Inv> = {}): Inv => ({
  id, hostname: id, serialNumber, ipAddress: `10.0.0.${id.length}`, assetType, manufacturer: "Fortinet", model: "FS-108F",
  monitored: true, monitorStatus: "up", consecutiveFailures: 0, dependencySuppressed: false, ...extra,
});
const iface = (assetId: string, ifName: string, lastSeen: Date = minsAgo(5), ifType: string | null = "aggregate", ifParent: string | null = null) =>
  ({ assetId, ifName, ifType, ifParent, lastSeen });

const assetFind = stubbed(prisma.asset.findMany);
const ifFind = stubbed(prisma.assetInterface.findMany);

let inventory: Inv[];
let interfaces: ReturnType<typeof iface>[];

beforeEach(() => {
  resetDbStub();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  inventory = [inv("gate", "firewall", GATE_SERIAL), inv("sw1", "switch", SW_SERIAL)];
  interfaces = [];
  assetFind.mockImplementation(async (args: { where: Record<string, any> }) => {
    // The seed monitor read is keyed by id; the inventory read by type + status.
    if (args.where.id) return inventory.filter((a) => args.where.id.in.includes(a.id));
    return inventory;
  });
  ifFind.mockImplementation(async () => interfaces);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("inferInterfaceTopology — reads", () => {
  it("returns an empty result without touching the database for no seeds", async () => {
    const out = await inferInterfaceTopology([]);
    expect(out.edges).toEqual([]);
    expect(out.remoteAssets.size).toBe(0);
    expect(out.darkAssetIds.size).toBe(0);
    expect(assetFind).not.toHaveBeenCalled();
  });

  it("reads the seeds' interfaces up to seven days old", async () => {
    await inferInterfaceTopology(["sw1"]);
    expect(ifFind.mock.calls[0][0].where).toEqual({
      assetId: { in: ["sw1"] },
      lastSeen: { gt: new Date(NOW.getTime() - INTERFACE_LAST_KNOWN_MS) },
    });
    expect(INTERFACE_LAST_KNOWN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("reports the dark seeds even when no interface is a peer aggregate (no inventory read)", async () => {
    inventory = [
      inv("sw1", "switch", SW_SERIAL, { dependencySuppressed: true }),
      inv("sw2", "switch", "S2", { monitored: false, monitorStatus: "down" }),
      inv("sw3", "switch", "S3", { monitorStatus: "down" }),
    ];
    interfaces = [iface("sw1", "port1", minsAgo(1), "physical")];
    const out = await inferInterfaceTopology(["sw1", "sw2", "sw3"]);
    expect([...out.darkAssetIds].sort()).toEqual(["sw1", "sw3"]); // an unmonitored device is never dark
    expect(out.edges).toEqual([]);
    expect(assetFind).toHaveBeenCalledTimes(1);
  });
});

describe("inferInterfaceTopology — matching", () => {
  it("draws a serial-matched edge and folds the reciprocal into one edge with both interface names", async () => {
    interfaces = [iface("sw1", IF_TO_GATE), iface("gate", IF_TO_SW)];
    const out = await inferInterfaceTopology(["sw1", "gate"]);
    expect(out.edges).toEqual([
      { sourceAssetId: "sw1", sourceIfName: IF_TO_GATE, targetAssetId: "gate", targetIfName: IF_TO_SW, matchVia: "serial", aggregateIndex: null },
    ]);
    // Both ends are seeds: nothing is remote.
    expect(out.remoteAssets.size).toBe(0);
  });

  it("returns a peer outside the seed set as a remote asset, with a null target interface", async () => {
    interfaces = [iface("gate", IF_TO_SW)];
    const out = await inferInterfaceTopology(["gate"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ sourceAssetId: "gate", targetAssetId: "sw1", targetIfName: null, aggregateIndex: 0 });
    expect(out.remoteAssets.get("sw1")).toEqual({
      id: "sw1", hostname: "sw1", serialNumber: SW_SERIAL, ipAddress: "10.0.0.3", assetType: "switch", manufacturer: "Fortinet", model: "FS-108F",
    });
  });

  it("labels the edge with the aggregate's single physical member, but keeps a multi-member aggregate's name", async () => {
    interfaces = [
      iface("gate", IF_TO_SW),
      iface("gate", "port7", minsAgo(5), "physical", IF_TO_SW),
      iface("sw1", IF_TO_GATE),
      iface("sw1", "port49", minsAgo(5), "physical", IF_TO_GATE),
      iface("sw1", "port50", minsAgo(5), "physical", IF_TO_GATE),
    ];
    const out = await inferInterfaceTopology(["gate", "sw1"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ sourceAssetId: "gate", sourceIfName: "port7", targetIfName: IF_TO_GATE });
  });

  it("refuses an ambiguous serial fragment", async () => {
    inventory.push(inv("twin", "switch", "X108FFTV23000001"));
    interfaces = [iface("gate", IF_TO_SW)];
    expect((await inferInterfaceTopology(["gate"])).edges).toEqual([]);
  });

  it("refuses a self-loop (a device's own truncated serial)", async () => {
    interfaces = [iface("sw1", IF_TO_SW)];
    expect((await inferInterfaceTopology(["sw1"])).edges).toEqual([]);
  });

  it("refuses an ambiguous hostname match", async () => {
    inventory.push(inv("a", "switch", "SA", { hostname: "HILLTOP2-T1024E" }), inv("b", "switch", "SB", { hostname: "HILLTOP2-T1024E.corp" }));
    interfaces = [iface("sw1", "HILLTOP2-T1024E")];
    expect((await inferInterfaceTopology(["sw1"])).edges).toEqual([]);
  });

  it("matches an operator-named aggregate by the peer's hostname", async () => {
    inventory.push(inv("peer", "switch", "SPEER", { hostname: "HILLTOP2-T1024E" }));
    interfaces = [iface("sw1", "HILLTOP2-T1024E")];
    const out = await inferInterfaceTopology(["sw1"]);
    expect(out.edges).toEqual([expect.objectContaining({ targetAssetId: "peer", matchVia: "hostname" })]);
  });

  it("ignores ordinary port names", async () => {
    interfaces = [iface("sw1", "port1", minsAgo(1), "physical"), iface("sw1", "fortilink"), iface("sw1", "_FlInK1_ICL0_")];
    expect((await inferInterfaceTopology(["sw1"])).edges).toEqual([]);
  });
});

describe("inferInterfaceTopology — last-known links (rule 144)", () => {
  it("drops a link proven only by an hour-old row when both ends are fully polled", async () => {
    interfaces = [iface("gate", IF_TO_SW, minsAgo(61))];
    expect((await inferInterfaceTopology(["gate"])).edges).toEqual([]);
  });

  it("treats a row exactly an hour old as stale", async () => {
    interfaces = [iface("gate", IF_TO_SW, minsAgo(60))];
    expect((await inferInterfaceTopology(["gate"])).edges).toEqual([]);
  });

  it("keeps an old link while the far end is dark, stamped lastKnownAt", async () => {
    inventory = [inv("gate", "firewall", GATE_SERIAL), inv("sw1", "switch", SW_SERIAL, { dependencySuppressed: true })];
    const seen = minsAgo(300);
    interfaces = [iface("gate", IF_TO_SW, seen)];
    const out = await inferInterfaceTopology(["gate"]);
    expect(out.edges).toEqual([expect.objectContaining({ targetAssetId: "sw1", lastKnownAt: seen })]);
    // The dark peer outside the site is reported too.
    expect(out.darkAssetIds.has("sw1")).toBe(true);
  });

  it("keeps an old link while the source end is dark", async () => {
    inventory = [inv("gate", "firewall", GATE_SERIAL, { monitorStatus: "down" }), inv("sw1", "switch", SW_SERIAL)];
    interfaces = [iface("gate", IF_TO_SW, minsAgo(120))];
    expect((await inferInterfaceTopology(["gate"])).edges).toHaveLength(1);
  });

  it("an edge with one fresh side carries no lastKnownAt", async () => {
    inventory = [inv("gate", "firewall", GATE_SERIAL), inv("sw1", "switch", SW_SERIAL, { monitorStatus: "down" })];
    interfaces = [iface("gate", IF_TO_SW, minsAgo(5)), iface("sw1", IF_TO_GATE, minsAgo(500))];
    const out = await inferInterfaceTopology(["gate", "sw1"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).not.toHaveProperty("lastKnownAt");
    expect(out.edges[0].targetIfName).toBe(IF_TO_GATE);
  });

  it("an old edge rests on the NEWER of its two rows", async () => {
    inventory = [inv("gate", "firewall", GATE_SERIAL), inv("sw1", "switch", SW_SERIAL, { monitorStatus: "down" })];
    interfaces = [iface("gate", IF_TO_SW, minsAgo(90)), iface("sw1", IF_TO_GATE, minsAgo(500))];
    const out = await inferInterfaceTopology(["gate", "sw1"]);
    expect(out.edges[0].lastKnownAt).toEqual(minsAgo(90));
  });
});
