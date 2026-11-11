/**
 * tests/integration/integrationDetach.test.ts — business rule 160 against a
 * real database: deleting an integration keeps what it discovered but
 * detaches it, decommissions the assets nothing else reports only when asked,
 * and records the DHCP entries it leaves on the device.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";
import { previewIntegrationDetach, detachSummary } from "../../src/services/integrationDetachService.js";

const d = dbDescribe;
const PFX = "intg-detach-test";

async function cleanup() {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: PFX } }, select: { id: true } });
  if (assets.length) await prisma.asset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  await prisma.subnet.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.ipBlock.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.discoveryRun.deleteMany({ where: { integrationName: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.event.deleteMany({ where: { resourceName: { startsWith: PFX } } });
}

const mkIntegration = (suffix: string, type: string) =>
  prisma.integration.create({ data: { name: `${PFX} ${suffix}`, type, config: {} } as never });
const mkAsset = (suffix: string, over: Record<string, unknown> = {}) =>
  prisma.asset.create({ data: { hostname: `${PFX}-${suffix}`, assetType: "server", status: "active", ...over } as never });
const source = (assetId: string, integrationId: string | null, sourceKind: string, externalId: string) =>
  prisma.assetSource.create({ data: { assetId, integrationId, sourceKind, externalId: `${PFX}:${externalId}`, observed: { hostname: "from-source" } } });

/**
 * A vCenter that reports three VMs and a host:
 *   only   — nothing else reports it, owned by this vCenter   → decommission candidate
 *   shared — an AD integration also reports it                → kept active either way
 *   manual — an operator also made it by hand                 → kept active either way
 *
 * Discovered assets carry the `vcenter` tag, as syncVcenterDevices writes it:
 * that is what stops the db.ts shadow-write minting a `manual` source row for
 * them (assetSourceDerivation). The hand-made one has no such tag, so it gets
 * its `manual` row the way a real operator-created asset does.
 *   host   — the hypervisor the VMs sit on (placement edges)
 */
async function seedVcenter() {
  const vc = await mkIntegration("vcenter", "vcenter");
  const ad = await mkIntegration("ad", "activedirectory");
  const only = await mkAsset("only", { discoveredByIntegrationId: vc.id, monitored: true, tags: ["vcenter"] });
  const shared = await mkAsset("shared", { discoveredByIntegrationId: vc.id, tags: ["vcenter"] });
  const manual = await mkAsset("manual");
  const host = await mkAsset("host", { discoveredByIntegrationId: vc.id, tags: ["vcenter"] });
  await source(only.id, vc.id, "vcenter-vm", "vm-only");
  // An enrichment row is not a claim: SNMP answering does not make it "reported".
  await source(only.id, null, "snmp-sysdescr", "snmp-only");
  await source(shared.id, vc.id, "vcenter-vm", "vm-shared");
  await source(shared.id, ad.id, "ad", "ad-shared");
  await source(manual.id, vc.id, "vcenter-vm", "vm-manual");
  await source(host.id, vc.id, "vcenter-host", "host-1");
  await prisma.assetDependencyParent.createMany({ data: [
    { assetId: only.id, parentAssetId: host.id, source: "vcenter", detectedVia: "hypervisor" },
    { assetId: shared.id, parentAssetId: host.id, source: "vcenter", detectedVia: "hypervisor" },
    // An operator override must survive: it is not the integration's edge.
    { assetId: manual.id, parentAssetId: host.id, source: "override", detectedVia: "manual" },
  ] });
  await prisma.discoveryRun.create({ data: { integrationId: vc.id, integrationName: vc.name, type: "vcenter", actor: "t", status: "completed" } as never });
  return { vc, ad, only, shared, manual, host };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("deleting an integration (rule 160)", () => {
  it("previews what it discovered, and which of it nothing else reports", async () => {
    const s = await seedVcenter();
    const adm = await authedAgent(app);
    const res = await adm.agent.get(`/api/v1/integrations/${s.vc.id}/delete-preview`);
    expect(res.status).toBe(200);
    // `host` is also sole-sourced: 4 sourced, 2 sole (only + host), 1 monitored.
    expect(res.body).toMatchObject({ sourcedAssets: 4, soleSourceAssets: 2, soleSourceMonitored: 1, networks: 0, pushedReservations: 0, azureTaggedAssets: 0, canDecommission: true });
    expect((await adm.agent.get("/api/v1/integrations/00000000-0000-0000-0000-000000000000/delete-preview")).status).toBe(404);
  });

  it("without the tick-box: keeps every asset active, removes its source rows, placement edges and run record", async () => {
    const s = await seedVcenter();
    const adm = await authedAgent(app);
    const res = await adm.agent.delete(`/api/v1/integrations/${s.vc.id}`).set("X-CSRF-Token", adm.csrf);
    expect(res.status).toBe(204);
    expect(await prisma.integration.findUnique({ where: { id: s.vc.id } })).toBeNull();

    // Its source rows are gone — not left with a null integration id.
    expect(await prisma.assetSource.count({ where: { sourceKind: { in: ["vcenter-vm", "vcenter-host"] }, externalId: { startsWith: PFX } } })).toBe(0);
    // Other integrations' rows, manual rows and enrichment rows are untouched.
    const kinds = (await prisma.assetSource.findMany({ where: { assetId: { in: [s.only.id, s.shared.id, s.manual.id, s.host.id] } }, select: { sourceKind: true } })).map((r) => r.sourceKind).sort();
    expect(kinds).toEqual(["ad", "manual", "snmp-sysdescr"]);

    // Nothing was decommissioned.
    for (const a of [s.only, s.shared, s.manual, s.host]) {
      expect((await prisma.asset.findUnique({ where: { id: a.id } }))!.status, a.hostname!).toBe("active");
    }
    // The hypervisor's placement edges are gone; the operator's override is not.
    const edges = await prisma.assetDependencyParent.findMany({ where: { parentAssetId: s.host.id }, select: { source: true } });
    expect(edges.map((e) => e.source)).toEqual(["override"]);
    expect(await prisma.discoveryRun.count({ where: { integrationId: s.vc.id } })).toBe(0);

    await waitForEventCount("integration.deleted", 1, s.vc.id);
    const ev = await prisma.event.findFirst({ where: { action: "integration.deleted", resourceId: s.vc.id } });
    expect(ev!.message).toContain("4 assets detached");
    expect(ev!.message).toContain("2 placement links removed");
  });

  it("with the tick-box: decommissions only the assets nothing else reports", async () => {
    const s = await seedVcenter();
    const adm = await authedAgent(app);
    const res = await adm.agent.delete(`/api/v1/integrations/${s.vc.id}?decommission=true`).set("X-CSRF-Token", adm.csrf);
    expect(res.status).toBe(204);

    const status = async (id: string) => (await prisma.asset.findUnique({ where: { id } }))!.status;
    expect(await status(s.only.id)).toBe("decommissioned");
    expect(await status(s.host.id)).toBe("decommissioned");
    // Still reported by AD / made by an operator: not the integration's to retire.
    expect(await status(s.shared.id)).toBe("active");
    expect(await status(s.manual.id)).toBe("active");
    // Rule 10: a decommissioned asset is not monitored.
    expect((await prisma.asset.findUnique({ where: { id: s.only.id } }))!.monitored).toBe(false);

    await waitForEventCount("asset.integration_deleted.decommissioned", 1, s.only.id);
    const ev = await prisma.event.findFirst({ where: { action: "asset.integration_deleted.decommissioned", resourceId: s.only.id } });
    expect(ev!.message).toContain("no other discovery source reports it");
  });

  it("never decommissions an asset another integration owns", async () => {
    const vc = await mkIntegration("vcenter", "vcenter");
    const other = await mkIntegration("fmg", "fortimanager");
    const theirs = await mkAsset("owned-elsewhere", { discoveredByIntegrationId: other.id, tags: ["vcenter"] });
    await source(theirs.id, vc.id, "vcenter-vm", "vm-theirs");
    expect((await previewIntegrationDetach({ id: vc.id, name: vc.name, type: "vcenter" })).soleSourceAssets).toBe(0);

    const adm = await authedAgent(app);
    expect((await adm.agent.delete(`/api/v1/integrations/${vc.id}?decommission=true`).set("X-CSRF-Token", adm.csrf)).status).toBe(204);
    expect((await prisma.asset.findUnique({ where: { id: theirs.id } }))!.status).toBe("active");
  });

  it("strips azure: tags when an Azure Arc integration is deleted, and keeps every other tag", async () => {
    const arc = await mkIntegration("arc", "azurearc");
    const a = await mkAsset("arc-vm", { discoveredByIntegrationId: arc.id, tags: ["azurearc", "azure:env=prod", "region:East", "keep-me", "azure:owner=ops"] });
    await source(a.id, arc.id, "arc", "arc-1");
    expect((await previewIntegrationDetach({ id: arc.id, name: arc.name, type: "azurearc" })).azureTaggedAssets).toBe(1);

    const adm = await authedAgent(app);
    expect((await adm.agent.delete(`/api/v1/integrations/${arc.id}`).set("X-CSRF-Token", adm.csrf)).status).toBe(204);
    expect((await prisma.asset.findUnique({ where: { id: a.id } }))!.tags.sort()).toEqual(["azurearc", "keep-me", "region:East"]);
  });

  it("leaves pushed DHCP reservations in place and records each one in Events", async () => {
    const fg = await mkIntegration("fortigate", "fortigate");
    const block = await prisma.ipBlock.create({ data: { name: `${PFX} block`, cidr: "10.199.0.0/16", ipVersion: "v4" } as never });
    const net = await prisma.subnet.create({ data: { blockId: block.id, cidr: "10.199.1.0/24", name: `${PFX} net`, discoveredBy: fg.id, fortigateDevice: "FG-LAB" } as never });
    const r1 = await prisma.reservation.create({ data: { subnetId: net.id, ipAddress: "10.199.1.10", macAddress: "AA:BB:CC:00:00:01", hostname: "printer", sourceType: "dhcp_reservation", pushedToId: fg.id, pushStatus: "synced", pushedScopeId: 3, pushedEntryId: 7 } as never });
    await prisma.reservation.create({ data: { subnetId: net.id, ipAddress: "10.199.1.11", sourceType: "manual" } as never });

    const preview = await previewIntegrationDetach({ id: fg.id, name: fg.name, type: "fortigate" });
    expect(preview).toMatchObject({ pushedReservations: 1, networks: 1 });

    const adm = await authedAgent(app);
    expect((await adm.agent.delete(`/api/v1/integrations/${fg.id}`).set("X-CSRF-Token", adm.csrf)).status).toBe(204);

    // The network and its reservations stay.
    expect((await prisma.subnet.findUnique({ where: { id: net.id } }))!.discoveredBy).toBeNull();
    expect(await prisma.reservation.count({ where: { id: r1.id } })).toBe(1);

    await waitForEventCount("integration.dhcp_entries_left", 1, fg.id);
    const ev = await prisma.event.findFirst({ where: { action: "integration.dhcp_entries_left", resourceId: fg.id } });
    expect(ev!.level).toBe("warning");
    expect(ev!.message).toContain("1 DHCP reservation pushed through");
    const details = ev!.details as { count: number; entries: Array<Record<string, unknown>> };
    expect(details.count).toBe(1);
    expect(details.entries[0]).toMatchObject({ ip: "10.199.1.10", mac: "AA:BB:CC:00:00:01", hostname: "printer", network: "10.199.1.0/24", device: "FG-LAB", scopeId: 3, entryId: 7 });
  });
});

d("the clean-up migration (what integrations deleted before rule 160 left behind)", () => {
  it("removes dead source rows, frozen placement edges and stranded azure: tags, and nothing that is still live", async () => {
    const live = await mkIntegration("live-vc", "vcenter");
    const host = await mkAsset("mig-host", { tags: ["vcenter"] });
    const deadVm = await mkAsset("mig-dead-vm", { tags: ["vcenter"] });
    const liveVm = await mkAsset("mig-live-vm", { tags: ["vcenter"] });
    const exArc = await mkAsset("mig-ex-arc", { tags: ["azurearc", "azure:env=prod", "keep-me"] });
    const stillArc = await mkAsset("mig-still-arc", { tags: ["azurearc", "azure:env=dev"] });
    const arc = await mkIntegration("live-arc", "azurearc");
    // What a pre-160 delete left: rows whose integration id the FK nulled.
    await source(deadVm.id, null, "vcenter-vm", "mig-dead-vm");
    await source(exArc.id, null, "arc", "mig-ex-arc");
    // Live rows, and a kind that legitimately has no integration.
    await source(liveVm.id, live.id, "vcenter-vm", "mig-live-vm");
    await source(host.id, live.id, "vcenter-host", "mig-host");
    await source(stillArc.id, arc.id, "arc", "mig-still-arc");
    await source(deadVm.id, null, "polaris-agent", "mig-agent");
    await prisma.assetDependencyParent.createMany({ data: [
      { assetId: deadVm.id, parentAssetId: host.id, source: "vcenter", detectedVia: "hypervisor" },
      { assetId: liveVm.id, parentAssetId: host.id, source: "vcenter", detectedVia: "hypervisor" },
      { assetId: deadVm.id, parentAssetId: host.id, source: "override", detectedVia: "manual" },
    ] });

    const sql = readFileSync(resolve(__dirname, "../../prisma/migrations/20261111140000_orphan_integration_sources/migration.sql"), "utf8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(6);
    for (const s of statements) await prisma.$executeRawUnsafe(s);

    const kindsOf = async (id: string) => (await prisma.assetSource.findMany({ where: { assetId: id, externalId: { startsWith: PFX } }, select: { sourceKind: true } })).map((r) => r.sourceKind).sort();
    expect(await kindsOf(deadVm.id)).toEqual(["polaris-agent"]);
    expect(await kindsOf(exArc.id)).toEqual([]);
    expect(await kindsOf(liveVm.id)).toEqual(["vcenter-vm"]);
    expect(await kindsOf(stillArc.id)).toEqual(["arc"]);

    const edges = async (id: string) => (await prisma.assetDependencyParent.findMany({ where: { assetId: id }, select: { source: true } })).map((e) => e.source).sort();
    expect(await edges(deadVm.id)).toEqual(["override"]);
    expect(await edges(liveVm.id)).toEqual(["vcenter"]);

    expect((await prisma.asset.findUnique({ where: { id: exArc.id } }))!.tags.sort()).toEqual(["azurearc", "keep-me"]);
    expect((await prisma.asset.findUnique({ where: { id: stillArc.id } }))!.tags.sort()).toEqual(["azure:env=dev", "azurearc"]);
  });
});

d("detachSummary", () => {
  it("says only what happened", () => {
    const none = { sourceRows: 0, detachedAssets: 0, decommissioned: 0, azureTagsStripped: 0, sightings: 0, placementEdges: 0, networks: 0, dhcpEntriesLeft: 0 };
    expect(detachSummary(none)).toBe("");
    expect(detachSummary({ ...none, detachedAssets: 412, decommissioned: 38, networks: 1, dhcpEntriesLeft: 6 }))
      .toBe("412 assets detached (38 decommissioned); 1 network kept as manual; 6 DHCP entries left on the device");
  });
});
