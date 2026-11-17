/**
 * tests/integration/nonFortinetInfraPlacement.test.ts
 *
 * Business rule 192: a switch Fortinet does not manage (a Cisco Fibre Channel
 * switch — `assetType: "switch"`, no `fortinetTopology.role`) is placed like
 * an endpoint when the infra graph gives it no parent, so its last-seen
 * FortiSwitch becomes its dependency parent. It stays infrastructure for what
 * hangs off it: a server whose last-seen switch is the Cisco switch keeps the
 * Cisco switch as ITS parent.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { recomputeDependencyTree } from "../../src/services/dependencyTreeService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;
const HOST = "dep-nonforti-test";
const GATE_SERIAL = "FGNONFORTI01";

const ids = { gate: "", fsw: "", cisco: "", server: "" };

async function wipe(): Promise<void> {
  await prisma.assetDependencyParent.deleteMany({ where: { asset: { hostname: { startsWith: HOST } } } });
  await prisma.assetDependencyParent.deleteMany({ where: { parent: { hostname: { startsWith: HOST } } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

async function seed(): Promise<void> {
  await wipe();
  const gate = await prisma.asset.create({
    data: {
      hostname: `${HOST}-gate`, assetType: "firewall", serialNumber: GATE_SERIAL, status: "active", monitored: true,
      fortinetTopology: { role: "fortigate" },
    } as never,
  });
  const fsw = await prisma.asset.create({
    data: {
      hostname: `${HOST}-fsw`, assetType: "switch", serialNumber: "S248NONFORTI1", status: "active", monitored: true,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: `${HOST}-gate`, controllerSerial: GATE_SERIAL },
    } as never,
  });
  const cisco = await prisma.asset.create({
    data: {
      hostname: `${HOST}-mds`, assetType: "switch", serialNumber: "JAFNONFORTI1", status: "active", monitored: true,
      lastSeenSwitch: `${HOST}-fsw/port12`,
    } as never,
  });
  const server = await prisma.asset.create({
    data: {
      hostname: `${HOST}-srv`, assetType: "server", status: "active", monitored: true,
      lastSeenSwitch: `${HOST}-mds/fc1/3`,
    } as never,
  });
  Object.assign(ids, { gate: gate.id, fsw: fsw.id, cisco: cisco.id, server: server.id });
}

const parentsOf = (assetId: string) =>
  prisma.assetDependencyParent.findMany({ where: { assetId }, select: { parentAssetId: true, source: true, detectedVia: true } });

beforeAll(async () => { if (dbReachable) await prisma.$connect(); });
beforeEach(async () => { if (dbReachable) await seed(); });
afterAll(async () => { if (dbReachable) { await wipe(); await prisma.$disconnect(); } });

d("non-Fortinet switches placed like endpoints (rule 192)", () => {
  it("a Cisco switch with no infra parent takes its last-seen FortiSwitch as its parent", async () => {
    await recomputeDependencyTree();
    expect(await parentsOf(ids.cisco)).toEqual([{ parentAssetId: ids.fsw, source: "endpoint", detectedVia: "switch-port" }]);
    const cisco = await prisma.asset.findUnique({ where: { id: ids.cisco }, select: { dependencyLayer: true } });
    const fsw = await prisma.asset.findUnique({ where: { id: ids.fsw }, select: { dependencyLayer: true } });
    expect(cisco!.dependencyLayer).toBe((fsw!.dependencyLayer ?? 0) + 1);
  });

  it("stays a parent for what hangs off it", async () => {
    await recomputeDependencyTree();
    expect(await parentsOf(ids.server)).toEqual([{ parentAssetId: ids.cisco, source: "endpoint", detectedVia: "switch-port" }]);
  });

  it("the site's topology lists it under its FortiSwitch, so the Device List shows it", async () => {
    await recomputeDependencyTree();
    const { buildSiteTopology } = await import("../../src/services/topologyGraphService.js");
    const t = await buildSiteTopology(ids.gate) as { endpoints?: Array<{ id: string; assetType: string; switchId: string; port: string }> };
    const mds = (t.endpoints ?? []).find((e) => e.id === ids.cisco);
    expect(mds).toMatchObject({ assetType: "switch", switchId: ids.fsw, port: "port12" });
  });

  it("the FortiSwitch itself is never placed this way", async () => {
    await recomputeDependencyTree();
    const rows = await parentsOf(ids.fsw);
    expect(rows.every((r) => r.source !== "endpoint")).toBe(true);
  });

  it("drops the endpoint edge once the infra graph gives it a parent of its own", async () => {
    await recomputeDependencyTree();
    // An LLDP adjacency to the FortiSwitch, as an SNMP scrape of the Cisco switch would record.
    await prisma.assetLldpNeighbor.create({
      data: {
        assetId: ids.cisco, localIfName: "mgmt0", source: "snmp", systemName: `${HOST}-fsw`,
        matchedAssetId: ids.fsw, lastSeen: new Date(),
      } as never,
    });
    await recomputeDependencyTree();
    const rows = await parentsOf(ids.cisco);
    expect(rows.some((r) => r.source === "endpoint")).toBe(false);
    expect(rows.some((r) => r.parentAssetId === ids.fsw)).toBe(true);
    await prisma.assetLldpNeighbor.deleteMany({ where: { assetId: ids.cisco } });
  });
});
