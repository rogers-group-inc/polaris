/**
 * tests/integration/recordSystemInfoContract.test.ts
 *
 * Coverage for recordSystemInfoResult — the persistence half of the
 * system-info heavy pass (interfaces / storage / IPsec / SD-WAN / LLDP /
 * wireless / MCLAG / detected-model / assoc-IP mirror). Written as the
 * PREREQUISITE for splitting the ~240-line function (2026-08 audit): every
 * stream's persistence contract is pinned here first, so the later re-homing
 * has a net.
 *
 * Assertion strategy: buffered streams (interface / storage / ipsec-tunnel
 * samples) are flushed explicitly via flushAllSampleBuffers() and asserted
 * against their hypertables; the synchronous side effects (MAC range-fold,
 * assoc-IP full-replace, LLDP delete-replace, detected-model adoption, the
 * lastSystemInfoAt empty-interfaces guard) are asserted directly.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  recordSystemInfoResult,
  type SystemInfoSample,
  type CollectionResult,
} from "../../src/services/monitoringService.js";
import { flushAllSampleBuffers } from "../../src/services/sampleWriteBuffer.js";

const d = dbDescribe;
const HOSTNAME = "sysinfo-contract-test";

let assetId = "";

async function wipe(): Promise<void> {
  const old = await prisma.asset.findMany({ where: { hostname: HOSTNAME }, select: { id: true } });
  const ids = old.map((a) => a.id);
  if (ids.length > 0) {
    // Sample hypertables carry no FK to Asset — clear them explicitly so a
    // re-run never sees a previous run's rows.
    await prisma.assetInterfaceSample.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.assetStorageSample.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.assetIpsecTunnelSample.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  }
}

async function seedAsset(extra: Record<string, unknown> = {}): Promise<void> {
  await wipe();
  const asset = await prisma.asset.create({
    data: {
      hostname: HOSTNAME,
      assetType: "switch",
      status: "active",
      ipAddress: "10.97.0.2",
      monitored: true,
      ...extra,
    } as never,
  });
  assetId = asset.id;
}

function ok(data: Partial<SystemInfoSample>): CollectionResult<SystemInfoSample> {
  return { supported: true, data: { interfaces: [], storage: [], ...data } };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await wipe();
    await prisma.$disconnect();
  } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await seedAsset();
});

d("recordSystemInfoResult", () => {
  it("supported=false is a complete no-op", async () => {
    await recordSystemInfoResult(assetId, { supported: false });
    await flushAllSampleBuffers();
    const fresh = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(fresh!.lastSystemInfoAt).toBeNull();
    expect(await prisma.assetInterfaceSample.count({ where: { assetId } })).toBe(0);
  });

  // The pinned-only cutover: time-series rows are written for PINNED
  // interfaces only, while current state is recorded for EVERY interface in
  // asset_interfaces. Before this, every interface got a sample row (pinned
  // ones stamped "fast", the rest "slow" and deleted 24h later) — which was the
  // bulk of the largest table in the database, for rows nothing read as history.
  it("time-series rows land for PINNED interfaces only, and bump lastSystemInfoAt", async () => {
    await seedAsset({ monitoredInterfaces: ["port1"] });
    await recordSystemInfoResult(assetId, ok({
      interfaces: [
        { ifName: "port1", operStatus: "up", speedBps: 1e9, inOctets: 1234 },
        { ifName: "port2", operStatus: "down" },
      ],
    }));
    await flushAllSampleBuffers();

    const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId }, orderBy: { ifName: "asc" } });
    expect(rows.map((r) => [r.ifName, r.cadence])).toEqual([["port1", "fast"]]);
    expect(rows[0]!.speedBps).toBe(BigInt(1e9));
    expect(rows[0]!.inOctets).toBe(BigInt(1234));

    const fresh = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(fresh!.lastSystemInfoAt).not.toBeNull();
  });

  it("current state is recorded for EVERY interface, pinned or not", async () => {
    await seedAsset({ monitoredInterfaces: ["port1"] });
    await recordSystemInfoResult(assetId, ok({
      interfaces: [
        { ifName: "port1", operStatus: "up", speedBps: 1e9 },
        { ifName: "port2", operStatus: "down", ifType: "physical" },
      ],
    }));

    const inv = await prisma.assetInterface.findMany({ where: { assetId }, orderBy: { ifName: "asc" } });
    expect(inv.map((r) => r.ifName)).toEqual(["port1", "port2"]);
    expect(inv[1]!.operStatus).toBe("down");
    // Topology columns must survive here — the fast re-walk nulls them, which
    // is why only the full pass writes this table.
    expect(inv[1]!.ifType).toBe("physical");
  });

  // Same guard as lastSystemInfoAt: an empty interface list means "this pull
  // returned nothing useful" at least as often as "this device has no
  // interfaces", so it must not blank the System tab.
  it("an empty interfaces[] preserves the stored current-state inventory", async () => {
    await seedAsset({ monitoredInterfaces: [] });
    await recordSystemInfoResult(assetId, ok({ interfaces: [{ ifName: "port1" }] }));
    expect(await prisma.assetInterface.count({ where: { assetId } })).toBe(1);

    await recordSystemInfoResult(assetId, ok({ interfaces: [] }));
    expect(await prisma.assetInterface.count({ where: { assetId } })).toBe(1);
  });

  it("an empty interfaces[] never bumps lastSystemInfoAt, but other streams still persist", async () => {
    await recordSystemInfoResult(assetId, ok({
      storage: [{ mountPath: "/", totalBytes: 1000, usedBytes: 400 }],
    }));
    await flushAllSampleBuffers();

    const storage = await prisma.assetStorageSample.findMany({ where: { assetId } });
    expect(storage).toHaveLength(1);
    expect(storage[0]!.cadence).toBe("slow"); // not pinned
    expect(storage[0]!.totalBytes).toBe(BigInt(1000));

    const fresh = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(fresh!.lastSystemInfoAt).toBeNull();
  });

  it("folds scraped interface MACs into range rows without touching other sources' rows", async () => {
    await prisma.assetMacAddress.create({
      data: { assetId, mac: "11:22:33:44:55:66", source: "manual" },
    });
    await recordSystemInfoResult(assetId, ok({
      interfaces: [
        { ifName: "port1", macAddress: "AA:BB:CC:00:00:01" },
        { ifName: "port2", macAddress: "AA:BB:CC:00:00:02" },
        { ifName: "port3", macAddress: "AA:BB:CC:00:00:03" },
      ],
    }));

    const macRows = await prisma.assetMacAddress.findMany({ where: { assetId }, orderBy: { mac: "asc" } });
    const monitorRows = macRows.filter((r) => r.source === "monitor-interface");
    expect(monitorRows).toHaveLength(1); // 3 contiguous MACs → one range row
    expect(monitorRows[0]!.mac.toLowerCase()).toBe("aa:bb:cc:00:00:01");
    expect((monitorRows[0]!.macEnd ?? "").toLowerCase()).toBe("aa:bb:cc:00:00:03");
    expect(macRows.some((r) => r.source === "manual" && r.mac === "11:22:33:44:55:66")).toBe(true);
  });

  it("assoc-IP mirror full-replaces non-manual rows, preserves manual ones, and keeps prior rows on an IP-less scrape", async () => {
    await prisma.assetAssociatedIp.createMany({
      data: [
        { assetId, ip: "10.97.0.9", source: "manual" },
        { assetId, ip: "10.97.0.8", source: "monitor-system-info", interfaceName: "old0" },
      ],
    });
    await recordSystemInfoResult(assetId, ok({
      interfaces: [{ ifName: "vlan10", ipAddress: "10.97.10.1", macAddress: "AA:BB:CC:00:00:10" }],
    }));

    let rows = await prisma.assetAssociatedIp.findMany({ where: { assetId }, orderBy: { ip: "asc" } });
    expect(rows.map((r) => [r.ip, r.source])).toEqual([
      ["10.97.0.9", "manual"],
      ["10.97.10.1", "monitor-system-info"],
    ]);

    // A scrape whose interfaces carry no IPs must keep the previous list.
    await recordSystemInfoResult(assetId, ok({
      interfaces: [{ ifName: "port1" }],
    }));
    rows = await prisma.assetAssociatedIp.findMany({ where: { assetId } });
    expect(rows.map((r) => r.ip).sort()).toEqual(["10.97.0.9", "10.97.10.1"]);
  });

  it("assoc-IP mirror writes an interface's secondary IPs beside its primary, each with its role", async () => {
    await recordSystemInfoResult(assetId, ok({
      interfaces: [
        { ifName: "port2", ipAddress: "10.97.20.1", macAddress: "AA:BB:CC:00:00:20", secondaryIps: ["10.97.21.1", "10.97.22.1"] },
        { ifName: "eth0", ipAddress: "10.97.30.1", macAddress: "AA:BB:CC:00:00:30" },
      ],
    }));
    const rows = await prisma.assetAssociatedIp.findMany({ where: { assetId }, orderBy: { ip: "asc" } });
    expect(rows.map((r) => [r.ip, r.interfaceName, r.mac, r.interfaceRole])).toEqual([
      ["10.97.20.1", "port2", "AA:BB:CC:00:00:20", "primary"],
      ["10.97.21.1", "port2", "AA:BB:CC:00:00:20", "secondary"],
      ["10.97.22.1", "port2", "AA:BB:CC:00:00:20", "secondary"],
      ["10.97.30.1", "eth0", "AA:BB:CC:00:00:30", null],
    ]);
  });

  it("LLDP: undefined leaves stored neighbors alone; [] keeps recently-seen rows (48h stickiness)", async () => {
    await recordSystemInfoResult(assetId, ok({
      lldpNeighbors: [{ localIfName: "port1", systemName: "peer-sw" }],
      lldpSource: "snmp",
    }));
    let rows = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.systemName).toBe("peer-sw");

    // undefined → not collected this pass → rows survive.
    await recordSystemInfoResult(assetId, ok({ interfaces: [{ ifName: "port1" }] }));
    rows = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
    expect(rows).toHaveLength(1);

    // [] → queried, zero neighbors — but persistLldpNeighbors applies the
    // 48h LLDP_STICKY_WINDOW_MS, so a freshly-seen neighbor survives one
    // empty scrape rather than flapping off a transient miss.
    await recordSystemInfoResult(assetId, ok({ lldpNeighbors: [] }));
    rows = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
    expect(rows).toHaveLength(1);

    // A neighbor last seen OUTSIDE the sticky window ages out on the next
    // queried-but-absent pass.
    await prisma.assetLldpNeighbor.updateMany({
      where: { assetId },
      data: { lastSeen: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });
    await recordSystemInfoResult(assetId, ok({ lldpNeighbors: [] }));
    rows = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
    expect(rows).toHaveLength(0);
  });

  it("LLDP: a local port label that is really a port DESCRIPTION is keyed to the port", async () => {
    // The prod shape (MORGAN-148E-1, 2026-08-25): LLDP-MIB's local port label
    // on a FortiSwitch is the operator's port description, so neighbour rows
    // arrived keyed by the attached AP's own name — the join key every
    // interface lookup uses (Neighbor column, alert LLDP block, By-LLDP
    // auto-monitor).
    await recordSystemInfoResult(assetId, ok({
      interfaces: [{ ifName: "port9", alias: "port9", description: "MORGAN-221E-1" }],
    }));
    await recordSystemInfoResult(assetId, ok({
      lldpNeighbors: [{ localIfName: "MORGAN-221E-1", systemName: "MORGAN-221E-1" }],
      lldpSource: "snmp",
    }));

    let rows = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.localIfName).toBe("port9");

    // The same neighbour reported under both names collapses to one row
    // rather than two INSERTs against one business key.
    await recordSystemInfoResult(assetId, ok({
      lldpNeighbors: [
        { localIfName: "port9", systemName: "MORGAN-221E-1" },
        { localIfName: "MORGAN-221E-1", systemName: "MORGAN-221E-1" },
      ],
      lldpSource: "snmp",
    }));
    rows = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
    expect(rows.map((r) => r.localIfName)).toEqual(["port9"]);
  });

  it("LLDP: a mislabeled stored row is dropped now, not after the 48h grace", async () => {
    await recordSystemInfoResult(assetId, ok({
      interfaces: [{ ifName: "port9", alias: "port9", description: "MORGAN-221E-1" }],
    }));
    // A row left behind by the pre-fix collector, seen minutes ago — the
    // stickiness window would otherwise keep it answering lookups for two
    // days under a name that is not a port.
    await prisma.assetLldpNeighbor.create({
      data: { assetId, localIfName: "MORGAN-221E-1", systemName: "MORGAN-221E-1", source: "snmp", lastSeen: new Date() },
    });
    await recordSystemInfoResult(assetId, ok({
      lldpNeighbors: [{ localIfName: "port12", systemName: "some-phone" }],
      lldpSource: "snmp",
    }));
    const rows = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
    expect(rows.map((r) => r.localIfName)).toEqual(["port12"]);
  });

  it("interfaces: a scrape that named ports by description is mapped back before anything keys on it", async () => {
    await recordSystemInfoResult(assetId, ok({
      interfaces: [
        { ifName: "port9",  alias: "port9",  description: "MORGAN-221E-1", poeStatus: "fault" },
        { ifName: "port12", alias: "port12", description: "Tim Smith" },
      ],
    }));
    // The degraded tick: ifName walk failed, so every name is an ifDescr.
    await recordSystemInfoResult(assetId, ok({
      interfaces: [
        { ifName: "MORGAN-221E-1", poeStatus: "fault" },
        { ifName: "Tim Smith" },
      ],
    }));
    const rows = await prisma.assetInterface.findMany({ where: { assetId }, orderBy: { ifName: "asc" } });
    expect(rows.map((r) => r.ifName)).toEqual(["port12", "port9"]);
    // firstSeen survives, which is the proof the rename landed on the SAME
    // row rather than replacing the port with a differently-named twin.
    expect(rows.every((r) => r.firstSeen <= r.lastSeen)).toBe(true);
  });

  it("interface pins naming a description are rewritten onto the port they describe", async () => {
    await prisma.asset.update({
      where: { id: assetId },
      data: { monitoredInterfaces: ["port33", "MORGAN-221E-1"] },
    });
    await recordSystemInfoResult(assetId, ok({
      interfaces: [
        { ifName: "port9",  alias: "port9",  description: "MORGAN-221E-1" },
        { ifName: "port33", alias: "port33" },
      ],
    }));
    const fresh = await prisma.asset.findUnique({ where: { id: assetId }, select: { monitoredInterfaces: true } });
    expect(fresh?.monitoredInterfaces).toEqual(["port33", "port9"]);
  });

  it("detected model adopts over empty/generic values only, never over an operator-typed model", async () => {
    // Generic discovery literal → overwritable.
    await prisma.asset.update({ where: { id: assetId }, data: { model: "FortiSwitch" } });
    await recordSystemInfoResult(assetId, ok({ detectedModel: "FortiSwitch 448E-FPOE" }));
    let fresh = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(fresh!.model).toBe("FortiSwitch 448E-FPOE");

    // A previously-detected "FortiSwitch <token>" stays overwritable (hardware swap).
    await recordSystemInfoResult(assetId, ok({ detectedModel: "FortiSwitch 424E" }));
    fresh = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(fresh!.model).toBe("FortiSwitch 424E");

    // Operator-typed model → never touched.
    await prisma.asset.update({ where: { id: assetId }, data: { model: "Catalyst 9300" } });
    await recordSystemInfoResult(assetId, ok({ detectedModel: "FortiSwitch 448E-FPOE" }));
    fresh = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(fresh!.model).toBe("Catalyst 9300");
  });

  it("IPsec tunnel samples land with pin-aware cadence", async () => {
    await seedAsset({ assetType: "firewall", monitoredIpsecTunnels: ["to-hq"] });
    await recordSystemInfoResult(assetId, ok({
      ipsecTunnels: [
        { tunnelName: "to-hq",  parentInterface: "wan1", remoteGateway: "203.0.113.1", status: "up",   incomingBytes: 10, outgoingBytes: 20, proxyIdCount: 1 },
        { tunnelName: "to-dr",  parentInterface: "wan2", remoteGateway: "203.0.113.2", status: "down", incomingBytes: null, outgoingBytes: null, proxyIdCount: 0 },
      ],
    }));
    await flushAllSampleBuffers();
    const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId }, orderBy: { tunnelName: "desc" } });
    expect(rows.map((r) => [r.tunnelName, r.cadence])).toEqual([["to-hq", "fast"], ["to-dr", "slow"]]);
  });
});
