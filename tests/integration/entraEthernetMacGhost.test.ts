/**
 * tests/integration/entraEthernetMacGhost.test.ts
 *
 * One computer, two assets: the Intune asset (Wi-Fi MAC only — Graph's list
 * call never returns ethernetMacAddress) and a FortiGate endpoint asset that
 * the gate created for the wired NIC it could not match. Once the per-device
 * read supplies the Ethernet MAC, the Entra sync must absorb that endpoint
 * duplicate into the Intune asset — even though the Intune asset matched by
 * deviceId, so the tertiary MAC cross-link (which runs only on a MISS) never
 * looks at it.
 *
 * And it must absorb nothing else: an asset holding the MAC that carries an
 * authoritative source of its own is a real record, not a ghost.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncEntraDevices, knownEthernetMacsFromIntuneRows } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const HOST = "ETH-GHOST-PC1";
const DEVICE_ID = "eth-ghost-device-0001";
const WIFI = "A0:B1:C2:D3:E4:F5";
const ETH = "00:11:22:33:44:55";
const SYNC = "2026-10-01T08:00:00Z";
let integrationId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { contains: "eth-ghost", mode: "insensitive" } } });
  const intgs = await prisma.integration.findMany({ where: { name: "eth-ghost-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "entraid", name: "eth-ghost-test", config: { enableIntune: true }, enabled: true },
  });
  integrationId = intg.id;
});

async function seedIntuneAsset() {
  return prisma.asset.create({
    data: {
      hostname: HOST,
      assetType: "workstation",
      status: "active",
      macAddress: WIFI,
      tags: ["entraid"],
      macAddressRows: { create: [{ mac: WIFI, source: "intune-wifi", lastSeen: new Date("2026-09-01T00:00:00Z") }] },
      sources: {
        create: [
          { sourceKind: "entra", externalId: DEVICE_ID, integrationId, observed: { kind: "entra" }, inferred: false },
          { sourceKind: "intune", externalId: DEVICE_ID, integrationId, observed: { kind: "intune", wiFiMacAddress: WIFI, ethernetMacAddress: null }, inferred: false },
        ],
      },
    },
  });
}

/** The asset FortiGate discovery creates for an unmatched MAC sighting. */
async function seedEndpointAsset(hostname: string, extraSourceKind?: string) {
  return prisma.asset.create({
    data: {
      hostname,
      assetType: "workstation",
      status: "active",
      macAddress: ETH,
      tags: ["device-inventory"],
      macAddressRows: { create: [{ mac: ETH, source: "device-inventory", lastSeen: new Date() }] },
      sources: {
        create: [
          { sourceKind: "fortigate-endpoint", externalId: ETH, observed: {}, inferred: false },
          ...(extraSourceKind ? [{ sourceKind: extraSourceKind, externalId: `${extraSourceKind}-${hostname}`, observed: {}, inferred: false }] : []),
        ],
      },
    },
  });
}

function device(over: Record<string, unknown> = {}) {
  return {
    sources: ["entra", "intune"] as ("entra" | "intune")[],
    deviceId: DEVICE_ID,
    displayName: HOST,
    operatingSystem: "Windows",
    operatingSystemVersion: "10.0.26100.1000",
    trustType: "AzureAd",
    accountEnabled: true,
    wifiMacAddress: WIFI,
    ethernetMacAddress: ETH,
    ethernetMacSyncedAt: SYNC,
    macAddress: ETH,
    lastSyncDateTime: SYNC,
    ...over,
  } as any;
}

function discovery(devices: any[]) {
  return {
    devices,
    presentDeviceIds: devices.map((x) => String(x.deviceId).toLowerCase()),
    disabledDeviceIds: [],
    presentIntuneDeviceIds: devices.map((x) => String(x.deviceId).toLowerCase()),
    intuneRead: "ok" as const,
    inventoryComplete: true,
    scoped: false,
  };
}

d("Entra sync — Intune Ethernet MAC absorbs the endpoint duplicate", () => {
  it("merges the FortiGate endpoint asset into the Intune asset and keeps both MACs", async () => {
    const intune = await seedIntuneAsset();
    // A different hostname on purpose: the duplicate-hostname job can't pair these.
    const ghost = await seedEndpointAsset("eth-ghost-dhcp-name");

    await syncEntraDevices(integrationId, "eth-ghost-test", { enableIntune: true }, discovery([device()]));

    expect(await prisma.asset.findUnique({ where: { id: ghost.id } })).toBeNull();
    const rows = await prisma.assetMacAddress.findMany({ where: { assetId: intune.id }, select: { mac: true } });
    expect(rows.map((r) => r.mac).sort()).toEqual([ETH, WIFI].sort());
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: intune.id }, select: { macAddress: true } });
    expect(after.macAddress).toBe(ETH);
    const ev = await prisma.event.findFirst({ where: { action: "asset.duplicate_merged", resourceId: intune.id } });
    expect(ev?.message).toContain(ETH);
  });

  it("stores the read stamp on the intune source row, so the next run can skip the read", async () => {
    await seedIntuneAsset();
    await syncEntraDevices(integrationId, "eth-ghost-test", { enableIntune: true }, discovery([device()]));
    const rows = await prisma.assetSource.findMany({
      where: { sourceKind: "intune", integrationId },
      select: { externalId: true, observed: true },
    });
    expect(knownEthernetMacsFromIntuneRows(rows).get(DEVICE_ID)).toEqual({ ethernetMacAddress: ETH, ethernetMacSyncedAt: SYNC });
  });

  it("never absorbs an asset with an authoritative source of its own", async () => {
    const intune = await seedIntuneAsset();
    const real = await seedEndpointAsset("eth-ghost-agent-host", "polaris-agent");

    await syncEntraDevices(integrationId, "eth-ghost-test", { enableIntune: true }, discovery([device()]));

    expect(await prisma.asset.findUnique({ where: { id: real.id } })).not.toBeNull();
    expect(await prisma.asset.findUnique({ where: { id: intune.id } })).not.toBeNull();
  });

  it("leaves the endpoint asset alone when the device reports no Ethernet MAC", async () => {
    await seedIntuneAsset();
    const ghost = await seedEndpointAsset("eth-ghost-dhcp-name");

    await syncEntraDevices(integrationId, "eth-ghost-test", { enableIntune: true },
      discovery([device({ ethernetMacAddress: undefined, macAddress: WIFI })]));

    expect(await prisma.asset.findUnique({ where: { id: ghost.id } })).not.toBeNull();
  });
});
