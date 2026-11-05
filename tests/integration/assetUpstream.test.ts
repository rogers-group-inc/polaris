/**
 * tests/integration/assetUpstream.test.ts
 *
 * GET /assets/:id/upstream — the three General-tab upstream rows (Last Seen
 * Switch / AP / Firewall) resolved from display strings to the Asset rows the
 * row menus act on.
 *
 * What's worth a real database here is the RESOLUTION: the switch name is
 * stored as a serial, the AP name as a hostname, and the firewall name as
 * FortiManager's DEVICE NAME — which is under no obligation to match the
 * gate's own hostname, and matching hostnames alone is the bug
 * utils/fortinetParentKey.ts exists to document. A name that resolves to
 * nothing has to come back as the name with no asset rather than as an error.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { resolveAssetUpstream } from "../../src/services/assetUpstreamService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const SWITCH_SERIAL = "S248EPTF10000001";
const FMG_DEVICE_NAME = "SITE-A-FGT-PRIMARY";

let integrationId = "";
let gate = "";
let sw = "";
let ap = "";
let endpoint = "";
let orphan = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.assetFortigateSighting.deleteMany();
  await prisma.assetSource.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.integration.deleteMany();

  integrationId = (
    await prisma.integration.create({
      data: { name: "FMG-Test", type: "fortimanager", config: {} as any, enabled: true },
    })
  ).id;

  // The gate's hostname deliberately DIFFERS from its FMG device name — the
  // sighting carries the latter, so hostname-only matching would find nothing.
  gate = (
    await prisma.asset.create({
      data: {
        hostname: "fgt-a.example.internal",
        assetType: "firewall",
        status: "active",
        ipAddress: "10.0.0.1",
        fortinetTopology: { deviceName: FMG_DEVICE_NAME } as any,
        managementAccess: {
          source: "firewall-interface", interfaceName: "mgmt", profileName: null,
          mgmtIp: "10.0.0.1", protocols: ["https", "ping", "ssh"], https: true, ssh: true, snmp: false,
          checkedAt: new Date().toISOString(),
        } as any,
      },
    })
  ).id;

  // Switch: management access read from the controller's local-access policy —
  // https permitted, ssh NOT. The row menu must offer exactly one verb.
  sw = (
    await prisma.asset.create({
      data: {
        hostname: "FS-248E-01",
        serialNumber: SWITCH_SERIAL,
        assetType: "switch",
        status: "active",
        ipAddress: "10.0.1.20",
        managementAccess: {
          source: "fortiswitch", interfaceName: "internal", profileName: "default",
          mgmtIp: "10.0.1.20", protocols: ["https", "ping", "snmp"], https: true, ssh: false, snmp: true,
          checkedAt: new Date().toISOString(),
        } as any,
      },
    })
  ).id;

  ap = (
    await prisma.asset.create({
      data: { hostname: "AP-LOBBY-1", assetType: "access_point", status: "active", ipAddress: "10.0.1.30" },
    })
  ).id;

  endpoint = (
    await prisma.asset.create({
      data: {
        hostname: "PRINTER-4",
        assetType: "printer",
        status: "active",
        // Stored as the SERIAL, which is what the FortiSwitch discovery path
        // stamps — resolution step 4 (name-as-serial).
        lastSeenSwitch: `${SWITCH_SERIAL}/port15`,
        lastSeenAp: "AP-LOBBY-1",
      },
    })
  ).id;

  orphan = (
    await prisma.asset.create({
      data: {
        hostname: "LAPTOP-9",
        assetType: "workstation",
        status: "active",
        lastSeenSwitch: "SW-NOT-IN-INVENTORY/port2",
      },
    })
  ).id;

  await prisma.assetFortigateSighting.create({
    data: {
      assetId: endpoint,
      integrationId,
      fortigateDevice: FMG_DEVICE_NAME,
      source: "dhcp_lease",
      lastSeen: new Date("2026-09-01T12:00:00Z"),
    },
  });
  // An older sighting on a gate that isn't in inventory: the row must keep
  // naming the FRESHEST gate, not the first one that happens to resolve.
  await prisma.assetFortigateSighting.create({
    data: {
      assetId: endpoint,
      integrationId,
      fortigateDevice: "DECOMMISSIONED-FGT",
      source: "dhcp_lease",
      lastSeen: new Date("2026-08-01T12:00:00Z"),
    },
  });
});

d("GET /assets/:id/upstream", () => {
  it("resolves switch (by serial), AP (by hostname) and firewall (by FMG device name)", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${endpoint}/upstream`);
    expect(res.status).toBe(200);

    expect(res.body.switch.name).toBe(SWITCH_SERIAL);
    expect(res.body.switch.port).toBe("port15");
    expect(res.body.switch.asset.id).toBe(sw);
    // Shaped for the client's remote-access gating: https yes, ssh no.
    expect(res.body.switch.asset.managementAccess).toEqual({
      mgmtIp: "10.0.1.20", protocols: ["https", "ping", "snmp"], https: true, ssh: false,
    });

    expect(res.body.ap.name).toBe("AP-LOBBY-1");
    expect(res.body.ap.asset.id).toBe(ap);
    // Nothing ever read this AP's profile — unknown, not denied.
    expect(res.body.ap.asset.managementAccess).toBeNull();

    // The whole point: the sighting carries FMG's device name, and the gate's
    // hostname is something else entirely.
    expect(res.body.firewall.name).toBe(FMG_DEVICE_NAME);
    expect(res.body.firewall.asset.id).toBe(gate);
    expect(res.body.firewall.asset.managementAccess.ssh).toBe(true);
    expect(res.body.visibility.firewall).toBe(true);
  });

  it("reports an unresolvable name as the name with no asset, not an error", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${orphan}/upstream`);
    expect(res.status).toBe(200);
    expect(res.body.switch).toEqual({ name: "SW-NOT-IN-INVENTORY", port: "port2", asset: null });
    expect(res.body.ap).toBeNull();
    expect(res.body.firewall).toBeNull();
  });

  it("resolves nothing for a firewall — it is the thing doing the sighting", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${gate}/upstream`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ switch: null, ap: null, firewall: null });
  });

  it("404s for an asset that doesn't exist", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/assets/00000000-0000-0000-0000-000000000000/upstream");
    expect(res.status).toBe(404);
  });

  it("never resolves a name to the asset being viewed", async () => {
    // A switch whose own lastSeenSwitch names itself (seen when a trunk
    // reflects back) must not link to its own page.
    await prisma.asset.update({ where: { id: sw }, data: { lastSeenSwitch: `${SWITCH_SERIAL}/port1` } });
    const out = await resolveAssetUpstream(sw);
    expect(out!.switch!.asset).toBeNull();
  });

  it("answers a managed AP with its controller gate, not a sighting its deleted gate left", async () => {
    // The reported bug: an AP's old gate was replaced and deleted. Discovery
    // rewrote the AP's controller stamp to the new gate (its Location showed
    // it), but the AP is statically addressed, so only the old gate's DHCP
    // sighting existed — and the row named the deleted gate forever.
    await prisma.asset.update({
      where: { id: ap },
      data: { fortinetTopology: { controllerFortigate: FMG_DEVICE_NAME } as any },
    });
    await prisma.assetFortigateSighting.create({
      data: { assetId: ap, integrationId, fortigateDevice: "REPLACED-FGT", source: "dhcp_lease", lastSeen: new Date() },
    });
    const out = await resolveAssetUpstream(ap);
    expect(out!.firewall).toMatchObject({ name: FMG_DEVICE_NAME, source: "controller" });
    expect(out!.firewall!.asset!.id).toBe(gate);
    // Read off the asset, not the sighting table — no quarantine grant needed.
    const noGrant = await resolveAssetUpstream(ap, { includeFirewall: false });
    expect(noGrant!.firewall!.name).toBe(FMG_DEVICE_NAME);
  });

  it("resolves the controller by serial when the stamp carries one", async () => {
    await prisma.asset.update({ where: { id: gate }, data: { serialNumber: "FGT60F0000000001" } });
    await prisma.asset.update({
      where: { id: sw },
      data: { fortinetTopology: { controllerSerial: "FGT60F0000000001", controllerFortigate: "RENAMED-IN-FMG" } as any },
    });
    const out = await resolveAssetUpstream(sw);
    expect(out!.firewall).toMatchObject({ name: "RENAMED-IN-FMG", source: "controller" });
    expect(out!.firewall!.asset!.id).toBe(gate);
  });

  it("passes over the newest sighting when its gate no longer exists", async () => {
    // A newer sighting on a gate Polaris no longer holds: the endpoint must
    // name the live gate rather than the deleted one.
    await prisma.assetFortigateSighting.create({
      data: { assetId: endpoint, integrationId, fortigateDevice: "DELETED-FGT", source: "dhcp_reservation", lastSeen: new Date("2026-10-01T12:00:00Z") },
    });
    const out = await resolveAssetUpstream(endpoint);
    expect(out!.firewall).toMatchObject({ name: FMG_DEVICE_NAME, source: "sighting" });
    expect(out!.firewall!.asset!.id).toBe(gate);
  });

  it("withholds the firewall half when the caller can't read sightings", async () => {
    // The route passes this from hasPermission(assetsQuarantine, read) — the
    // same gate GET /:id/sightings carries. "not shown" must be
    // distinguishable from "no gate has ever seen this device".
    const out = await resolveAssetUpstream(endpoint, { includeFirewall: false });
    expect(out!.firewall).toBeNull();
    expect(out!.visibility.firewall).toBe(false);
    expect(out!.switch!.asset!.id).toBe(sw);
  });
});

d("GET /assets/:id/sightings — FortiGate and VLAN cells resolve to what they name", () => {
  it("decorates each sighting with its gate's asset and its network's id", async () => {
    const block = await prisma.ipBlock.create({ data: { name: "sightings-test-block", cidr: "10.77.0.0/16", ipVersion: "v4" } });
    try {
      const subnet = await prisma.subnet.create({
        data: { blockId: block.id, cidr: "10.77.5.0/24", name: "Staff", vlan: 50, fortigateDevice: FMG_DEVICE_NAME },
      });
      await prisma.assetFortigateSighting.updateMany({
        where: { assetId: endpoint, fortigateDevice: FMG_DEVICE_NAME },
        data: { ipAddress: "10.77.5.44" },
      });
      const { agent } = await authedAgent(app);
      const res = await agent.get(`/api/v1/assets/${endpoint}/sightings`);
      expect(res.status).toBe(200);
      const live = res.body.find((s: any) => s.fortigateDevice === FMG_DEVICE_NAME);
      // Resolved by FMG device name, not hostname — the gate's hostname differs.
      expect(live.fortigateAsset).toMatchObject({ id: gate, assetType: "firewall" });
      expect(live.fortigateAsset.managementAccess).toMatchObject({ https: true, ssh: true });
      expect(live).toMatchObject({ subnetId: subnet.id, subnetName: "Staff", vlan: 50 });
      // A gate not in inventory stays a name with no asset; no address, no network.
      const gone = res.body.find((s: any) => s.fortigateDevice === "DECOMMISSIONED-FGT");
      expect(gone).toMatchObject({ fortigateAsset: null, subnetId: null, vlan: null });
    } finally {
      await prisma.ipBlock.delete({ where: { id: block.id } });
    }
  });
});
