/**
 * tests/integration/interfaceIdentityReconcile.test.ts
 *
 * The prod incident this locks down (MORGAN-148E-1, 2026-08-25): a FortiSwitch
 * scrape whose `ifName` walk failed named every port by its `ifDescr` — the
 * operator's port DESCRIPTION — so `port9` was collected as `MORGAN-221E-1`,
 * the access point plugged into it. That name became an identity: it went into
 * the inventory, auto-monitor pinned it, and later degraded ticks fed samples
 * under it. The alert an operator finally received read "Interface PoE status
 * on MORGAN-221E-1 is fault" — a real fault on a real port, reported under the
 * name of the neighbour.
 *
 * These tests exercise the write paths (not the pure mapping, which is covered
 * in tests/unit/interfaceIdentity.test.ts) because the reconciliation is only
 * worth anything if the SAMPLE that alerts and the PIN that selects it both
 * land on the port.
 */

import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import {
  persistInterfaces,
  repairInterfacePins,
  loadInterfaceIdentity,
  clearInterfaceIdentityCache,
} from "../../src/services/interfaceInventoryService.js";
import { buildInterfaceIdentity } from "../../src/utils/interfaceIdentity.js";
import { type InterfaceSample } from "../../src/services/monitoringService.js";
import { recordFastFilteredResult } from "../../src/services/monitoring/streamCollection.js";
import { flushAllSampleBuffers } from "../../src/services/sampleWriteBuffer.js";

const d = dbDescribe;
const HOSTNAME = "iface-identity-test";

let assetId = "";

async function wipe(): Promise<void> {
  const rows = await prisma.asset.findMany({ where: { hostname: HOSTNAME }, select: { id: true } });
  for (const r of rows) {
    // The sample tables carry assetId with no FK (hypertables), so they need
    // their own cleanup — the inventory cascades with the asset.
    await prisma.assetInterfaceSample.deleteMany({ where: { assetId: r.id } });
  }
  await prisma.asset.deleteMany({ where: { hostname: HOSTNAME } });
}

function iface(ifName: string, over: Partial<InterfaceSample> = {}): InterfaceSample {
  return { ifName, adminStatus: "up", operStatus: "up", ...over };
}

/** The switch as a healthy full pass sees it: port names, descriptions beside them. */
const HEALTHY_SCRAPE: InterfaceSample[] = [
  iface("port8",  { alias: "port8",  description: "Erin Bachich" }),
  iface("port9",  { alias: "port9",  description: "MORGAN-221E-1", poeStatus: "fault" }),
  iface("port33", { alias: "port33", poeStatus: "disabled" }),
];

d("interface identity reconciliation", () => {
  beforeAll(async () => {
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    clearInterfaceIdentityCache();
    const asset = await prisma.asset.create({
      data: {
        hostname: HOSTNAME,
        assetType: "switch",
        status: "active",
        monitored: true,
        monitoredInterfaces: ["port9", "port33", "MORGAN-221E-1"],
      },
    });
    assetId = asset.id;
    await persistInterfaces(assetId, HEALTHY_SCRAPE, new Date());
  });

  afterAll(async () => {
    await wipe();
  });

  it("lands a fast-pass sample named by its description on the real port", async () => {
    // Exactly what the fast cadence produced in prod: the pin resolved through
    // ifDescr, so the sample arrived keyed by the AP's name.
    await recordFastFilteredResult(assetId, {
      supported: true,
      data: {
        interfaces: [iface("MORGAN-221E-1", { poeStatus: "fault" })],
        storage: [],
      },
    } as never);
    await flushAllSampleBuffers();

    const samples = await prisma.assetInterfaceSample.findMany({
      where: { assetId },
      select: { ifName: true, poeStatus: true },
    });
    expect(samples).toHaveLength(1);
    // The alert's dimension is this ifName — this is the assertion that makes
    // the email say "port9".
    expect(samples[0]!.ifName).toBe("port9");
    expect(samples[0]!.poeStatus).toBe("fault");
  });

  it("keeps only the real port when a scrape reports both names at once", async () => {
    await recordFastFilteredResult(assetId, {
      supported: true,
      data: {
        interfaces: [
          iface("port9", { poeStatus: "fault" }),
          iface("MORGAN-221E-1", { poeStatus: "fault" }),
        ],
        storage: [],
      },
    } as never);
    await flushAllSampleBuffers();

    const samples = await prisma.assetInterfaceSample.findMany({
      where: { assetId },
      select: { ifName: true },
    });
    expect(samples.map((s) => s.ifName)).toEqual(["port9"]);
  });

  it("still samples a port that is new since the last full scrape", async () => {
    await recordFastFilteredResult(assetId, {
      supported: true,
      data: { interfaces: [iface("port50", { poeStatus: "searching" })], storage: [] },
    } as never);
    await flushAllSampleBuffers();

    const samples = await prisma.assetInterfaceSample.findMany({
      where: { assetId },
      select: { ifName: true },
    });
    expect(samples.map((s) => s.ifName)).toEqual(["port50"]);
  });

  it("rewrites a description pin onto its port and collapses the duplicate", async () => {
    const identity = buildInterfaceIdentity(HEALTHY_SCRAPE);
    await repairInterfacePins(assetId, identity, ["port9", "port33", "MORGAN-221E-1"], HOSTNAME);

    const after = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { monitoredInterfaces: true },
    });
    expect(after?.monitoredInterfaces).toEqual(["port9", "port33"]);

    const event = await prisma.event.findFirst({
      where: { action: "asset.interface_pin.canonicalized", resourceId: assetId },
    });
    expect(event).not.toBeNull();
  });

  it("writes nothing when every pin already names a port", async () => {
    const identity = buildInterfaceIdentity(HEALTHY_SCRAPE);
    await repairInterfacePins(assetId, identity, ["port9", "port33"], HOSTNAME);

    const event = await prisma.event.findFirst({
      where: { action: "asset.interface_pin.canonicalized", resourceId: assetId },
    });
    expect(event).toBeNull();
  });

  it("reads the identity from the stored inventory, labels and all", async () => {
    const identity = await loadInterfaceIdentity(assetId);
    expect(identity.names.has("port9")).toBe(true);
    expect(identity.labelToName.get("MORGAN-221E-1")).toBe("port9");
    // alias === ifName on a FortiSwitch: never a label.
    expect(identity.labelToName.has("port9")).toBe(false);
  });

  it("invalidates the cached identity when the inventory is rewritten", async () => {
    await loadInterfaceIdentity(assetId); // prime
    // The AP moved to port10 — the old label must stop resolving to port9.
    await persistInterfaces(
      assetId,
      [iface("port9", { alias: "port9" }), iface("port10", { alias: "port10", description: "MORGAN-221E-1" })],
      new Date(),
    );
    const identity = await loadInterfaceIdentity(assetId);
    expect(identity.labelToName.get("MORGAN-221E-1")).toBe("port10");
  });
});
