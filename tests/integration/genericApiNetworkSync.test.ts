/**
 * tests/integration/genericApiNetworkSync.test.ts — a Generic API integration
 * as a NETWORK source (business rule 100(j)) against a real database.
 *
 * Pinned:
 *   - subnets are created only inside a block, never over an overlapping,
 *     excluded or retired network; an unowned subnet is claimed with its name
 *     and purpose kept; one another integration owns is never re-pointed;
 *   - addresses land only in subnets the feed owns, as dhcp_reservation /
 *     dhcp_lease / external; a manual row is never overwritten (a Conflict
 *     proposing only what the feed says); a VIP is left alone; a dns_resolved
 *     fallback gives way; an expired lease is not written;
 *   - a feed with no subnet query claims the unowned subnet its addresses fall
 *     in; one that lists subnets writes nothing into a subnet it does not list;
 *   - reservations / assignments that leave a complete read are released,
 *     leases never are, an incomplete read releases nothing; subnet
 *     deprecation is opt-in;
 *   - the route refuses a network query that would read wrong, and a
 *     network-only feed with nothing to read.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { syncGenericApiNetwork } from "../../src/services/discovery/genericApiNetworkSync.js";
import type { GenericApiNetworkQuery, GenericApiNetworkQueryResult } from "../../src/services/genericApiService.js";

const d = dbDescribe;
const PREFIX = "IT gan";
const BLOCK = "10.250.0.0/16";
const EXCL = "10.250.9.0/24";

let feedId = "";
let otherId = "";
let blockId = "";

async function cleanup(): Promise<void> {
  const block = await prisma.ipBlock.findUnique({ where: { cidr: BLOCK }, select: { id: true } });
  if (block) {
    const subnets = await prisma.subnet.findMany({ where: { blockId: block.id }, select: { id: true } });
    const ids = subnets.map((s) => s.id);
    if (ids.length) {
      const res = await prisma.reservation.findMany({ where: { subnetId: { in: ids } }, select: { id: true } });
      await prisma.conflict.deleteMany({ where: { reservationId: { in: res.map((r) => r.id) } } });
      await prisma.reservation.deleteMany({ where: { subnetId: { in: ids } } });
      await prisma.subnet.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.ipBlock.delete({ where: { id: block.id } });
  }
  await prisma.subnetExclusion.deleteMany({ where: { cidr: EXCL } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
});
afterAll(async () => { if (dbReachable) await cleanup(); });

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  feedId = (await prisma.integration.create({ data: { type: "genericapi", name: `${PREFIX} feed`, config: {}, enabled: true } })).id;
  otherId = (await prisma.integration.create({ data: { type: "fortigate", name: `${PREFIX} gate`, config: {}, enabled: true } })).id;
  blockId = (await prisma.ipBlock.create({ data: { name: `${PREFIX} block`, cidr: BLOCK, ipVersion: "v4" } })).id;
  await prisma.subnet.createMany({ data: [
    { blockId, cidr: "10.250.1.0/24", name: "Gate LAN", status: "available", discoveredBy: otherId, fortigateDevice: "FGT-1", tags: ["dhcp-discovered", "fortigate"] },
    { blockId, cidr: "10.250.2.0/24", name: "Ops LAN", purpose: "operator wrote this", status: "available" },
    { blockId, cidr: "10.250.3.0/24", name: "Retired", status: "deprecated" },
  ] });
  await prisma.subnetExclusion.create({ data: { cidr: EXCL, name: "transit" } });
});

const subnetId = async (cidr: string) => (await prisma.subnet.findFirst({ where: { cidr, blockId }, select: { id: true } }))!.id;
const activeAt = async (ip: string) => prisma.reservation.findFirst({ where: { ipAddress: ip, status: "active", subnet: { blockId } } });

const query = (kind: GenericApiNetworkQuery["kind"]): GenericApiNetworkQuery => ({ kind, path: "/x", map: {} });
function result(kind: GenericApiNetworkQuery["kind"], items: unknown[], over: Partial<GenericApiNetworkQueryResult> = {}): GenericApiNetworkQueryResult {
  return {
    index: 0, query: query(kind),
    subnets: kind === "subnets" ? (items as any) : [],
    addresses: kind === "subnets" ? [] : (items as any),
    complete: true, rawCount: items.length, unmapped: 0, unmappedReasons: [], warnings: [], error: null,
    ...over,
  };
}
const sub = (cidr: string, over: Record<string, unknown> = {}) => ({ cidr, name: null, vlan: null, purpose: null, ...over });
const ad = (ip: string, over: Record<string, unknown> = {}) => ({ ipAddress: ip, macAddress: null, hostname: null, expiresAt: null, owner: null, notes: null, ...over });

const SUBNETS = result("subnets", [
  sub("10.250.1.0/24", { name: "steal me" }),   // another integration's
  sub("10.250.2.0/24", { name: "Feed name", purpose: "feed purpose", vlan: 22 }), // unowned → claim
  sub("10.250.3.0/24"),                          // retired
  sub("10.250.4.0/24", { name: "Feed LAN", vlan: 40 }), // new
  sub("10.250.4.128/25"),                        // overlaps the new one
  sub(EXCL),                                     // excluded
  sub("10.99.0.0/24"),                           // no block
]);

d("Generic API network sync — subnets", () => {
  it("creates inside a block, claims the unowned, never re-points another integration's, skips overlap / exclusion / retired / block-less", async () => {
    const s = await syncGenericApiNetwork(feedId, `${PREFIX} feed`, {}, [SUBNETS]);
    expect(s.subnetsCreated).toEqual(["10.250.4.0/24"]);
    expect(s.subnetsClaimed).toEqual(["10.250.2.0/24"]);
    expect(s.skipped.join(" | ")).toMatch(/10\.250\.1\.0\/24 — owned by another integration/);
    expect(s.skipped.join(" | ")).toMatch(/10\.250\.3\.0\/24 — retired/);
    expect(s.skipped.join(" | ")).toMatch(/10\.250\.4\.128\/25 — overlaps 10\.250\.4\.0\/24/);
    expect(s.skipped.join(" | ")).toMatch(/10\.250\.9\.0\/24 — excluded/);
    expect(s.skipped.join(" | ")).toMatch(/10\.99\.0\.0\/24 — no block/);

    const foreign = await prisma.subnet.findFirst({ where: { cidr: "10.250.1.0/24" } });
    expect([foreign?.discoveredBy, foreign?.name, foreign?.fortigateDevice]).toEqual([otherId, "Gate LAN", "FGT-1"]);
    const claimed = await prisma.subnet.findFirst({ where: { cidr: "10.250.2.0/24" } });
    expect(claimed).toMatchObject({ discoveredBy: feedId, name: "Ops LAN", purpose: "operator wrote this", vlan: 22, fortigateDevice: null });
    expect(claimed?.tags).toContain("genericapi");
    const created = await prisma.subnet.findFirst({ where: { cidr: "10.250.4.0/24" } });
    expect(created).toMatchObject({ blockId, discoveredBy: feedId, name: "Feed LAN", vlan: 40, fortigateDevice: null, fortigateSerial: null });
    expect(await prisma.subnet.count({ where: { cidr: "10.250.4.128/25" } })).toBe(0);
    expect(await prisma.subnet.count({ where: { cidr: EXCL } })).toBe(0);
  });

  it("deprecates a subnet that leaves a complete read only when asked, and never on an incomplete one", async () => {
    await syncGenericApiNetwork(feedId, `${PREFIX} feed`, {}, [SUBNETS]);
    const without = result("subnets", [sub("10.250.2.0/24")]);
    await syncGenericApiNetwork(feedId, `${PREFIX} feed`, {}, [without]);
    expect((await prisma.subnet.findFirst({ where: { cidr: "10.250.4.0/24" } }))?.status).toBe("available");
    await syncGenericApiNetwork(feedId, `${PREFIX} feed`, { deprecateMissingSubnets: true }, [{ ...without, complete: false }]);
    expect((await prisma.subnet.findFirst({ where: { cidr: "10.250.4.0/24" } }))?.status).toBe("available");
    const s = await syncGenericApiNetwork(feedId, `${PREFIX} feed`, { deprecateMissingSubnets: true }, [without]);
    expect(s.subnetsDeprecated).toEqual(["10.250.4.0/24"]);
    expect((await prisma.subnet.findFirst({ where: { cidr: "10.250.4.0/24" } }))?.status).toBe("deprecated");
  });
});

d("Generic API network sync — addresses", () => {
  it("writes each kind, never over a manual row or a VIP, replaces a dns_resolved fallback, and skips a foreign subnet", async () => {
    await syncGenericApiNetwork(feedId, `${PREFIX} feed`, {}, [SUBNETS]);
    const ops = await subnetId("10.250.2.0/24");
    await prisma.reservation.createMany({ data: [
      { subnetId: ops, ipAddress: "10.250.2.20", hostname: "op-host", owner: "alice", sourceType: "manual", status: "active" },
      { subnetId: ops, ipAddress: "10.250.2.21", hostname: "web-vip", sourceType: "vip", status: "active" },
      { subnetId: ops, ipAddress: "10.250.2.22", hostname: "from-dns", sourceType: "dns_resolved", status: "active", createdBy: "system:dns-resolved" },
    ] });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const s = await syncGenericApiNetwork(feedId, `${PREFIX} feed`, {}, [
      SUBNETS,
      result("reservations", [ad("10.250.4.10", { macAddress: "AA:BB:CC:00:00:10", hostname: "res" }), ad("10.250.2.20", { hostname: "feed-host" }), ad("10.250.1.30")]),
      result("leases", [ad("10.250.4.10", { hostname: "loses" }), ad("10.250.4.11", { expiresAt: future }), ad("10.250.4.12", { expiresAt: past })]),
      result("assignments", [ad("10.250.4.13", { owner: "Ops", notes: "printer" }), ad("10.250.2.21", { owner: "x" }), ad("10.250.2.22", { hostname: "assigned" })]),
    ], { pollIntervalHours: 12 });

    expect(await activeAt("10.250.4.10")).toMatchObject({ sourceType: "dhcp_reservation", hostname: "res", macAddress: "AA:BB:CC:00:00:10", expiresAt: null, lastSeenLeased: null });
    expect((await activeAt("10.250.4.11"))?.sourceType).toBe("dhcp_lease");
    expect((await activeAt("10.250.4.11"))?.expiresAt?.toISOString()).toBe(future);
    expect(await activeAt("10.250.4.12")).toBeNull();
    expect(await activeAt("10.250.4.13")).toMatchObject({ sourceType: "external", owner: "Ops", notes: "printer" });
    // The manual row: untouched, with one conflict proposing only the hostname.
    expect(await activeAt("10.250.2.20")).toMatchObject({ sourceType: "manual", hostname: "op-host", owner: "alice" });
    const conflicts = await prisma.conflict.findMany({ where: { reservation: { ipAddress: "10.250.2.20" }, status: "pending" } });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ integrationId: feedId, conflictFields: ["hostname"], proposedHostname: "feed-host", proposedOwner: "alice", proposedSourceType: "dhcp_reservation" });
    // The VIP stays a VIP; the dns_resolved fallback gave way.
    expect(await activeAt("10.250.2.21")).toMatchObject({ sourceType: "vip", hostname: "web-vip" });
    expect(await activeAt("10.250.2.22")).toMatchObject({ sourceType: "external", hostname: "assigned" });
    // Nothing written into the other integration's subnet.
    expect(await activeAt("10.250.1.30")).toBeNull();
    expect(s.skipped.join(" | ")).toMatch(/1 address\(es\) in subnets another integration owns/);
    expect(s.conflicts).toBe(1);
  });

  it("releases reservations / assignments that leave a complete read, never leases, nothing on an incomplete read", async () => {
    const run = (res: unknown[], leases: unknown[], assign: unknown[], over: Partial<GenericApiNetworkQueryResult> = {}, cfg = {}) =>
      syncGenericApiNetwork(feedId, `${PREFIX} feed`, cfg, [
        SUBNETS, result("reservations", res, over), result("leases", leases), result("assignments", assign),
      ]);
    await run([ad("10.250.4.10"), ad("10.250.4.20")], [ad("10.250.4.11", { hostname: "old" })], [ad("10.250.4.13")]);

    // Incomplete reservations read: nothing released.
    await run([ad("10.250.4.20")], [], [ad("10.250.4.13")], { complete: false });
    expect((await activeAt("10.250.4.10"))?.sourceType).toBe("dhcp_reservation");

    const s = await run([ad("10.250.4.20")], [ad("10.250.4.11", { hostname: "new" })], []);
    expect(s.addressesReleased).toBe(2);
    expect(await activeAt("10.250.4.10")).toBeNull();
    expect(await activeAt("10.250.4.13")).toBeNull();
    expect(await prisma.reservation.count({ where: { ipAddress: "10.250.4.10", status: "released" } })).toBe(1);
    // The lease is updated, never swept.
    expect((await activeAt("10.250.4.11"))?.hostname).toBe("new");
    const dropped = await run([ad("10.250.4.20")], [], []);
    expect(dropped.addressesReleased).toBe(0);
    expect((await activeAt("10.250.4.11"))?.sourceType).toBe("dhcp_lease");

    // Releasing again over an older released row at the same address works (the unique key).
    await run([ad("10.250.4.10"), ad("10.250.4.20")], [], []);
    await run([ad("10.250.4.20")], [], []);
    expect(await prisma.reservation.count({ where: { ipAddress: "10.250.4.10", status: "released" } })).toBe(1);

    // Switched off: nothing is released.
    await run([ad("10.250.4.10"), ad("10.250.4.20")], [], []);
    await run([ad("10.250.4.20")], [], [], {}, { releaseMissingAddresses: false });
    expect((await activeAt("10.250.4.10"))?.sourceType).toBe("dhcp_reservation");
  });

  it("a feed with no subnet query claims the unowned subnet its addresses fall in; one that lists subnets does not", async () => {
    const leaseOnly = await syncGenericApiNetwork(feedId, `${PREFIX} feed`, {}, [result("leases", [ad("10.250.2.50")])]);
    expect(leaseOnly.subnetsClaimed).toEqual(["10.250.2.0/24"]);
    expect((await prisma.subnet.findFirst({ where: { cidr: "10.250.2.0/24" } }))).toMatchObject({ discoveredBy: feedId, name: "Ops LAN" });
    expect((await activeAt("10.250.2.50"))?.sourceType).toBe("dhcp_lease");

    await prisma.subnet.update({ where: { id: await subnetId("10.250.2.0/24") }, data: { discoveredBy: null } });
    await prisma.reservation.deleteMany({ where: { ipAddress: "10.250.2.50" } });
    const listing = await syncGenericApiNetwork(feedId, `${PREFIX} feed`, {}, [
      result("subnets", [sub("10.250.4.0/24")]), result("leases", [ad("10.250.2.50")]),
    ]);
    expect(listing.subnetsClaimed).toEqual([]);
    expect(await activeAt("10.250.2.50")).toBeNull();
    expect(listing.skipped.join(" | ")).toMatch(/1 address\(es\) in subnets this feed does not list/);
  });
});

d("Generic API network sync — the route contract", () => {
  it("refuses a network query that would read wrong, and a network-only feed with nothing to read", async () => {
    const { agent, csrf } = await authedAgent(app);
    const base = { host: "inventory.example.com", path: "/api/devices", recordsPath: "data", fieldMap: { id: "id" } };
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["placeholder in a network path", { networkQueries: [{ kind: "subnets", path: "/p/{{id}}", map: { cidr: "c" } }] }, /cannot hold/],
      ["unknown field for the kind", { networkQueries: [{ kind: "leases", path: "/l", map: { ipAddress: "ip", cidr: "c" } }] }, /not a leases field/],
      ["network without a prefix", { networkQueries: [{ kind: "subnets", path: "/p", map: { network: "n" } }] }, /prefixLength/],
      ["network-only feed with no queries", { readDevices: false, fieldMap: {} }, /needs at least one network query/],
    ];
    for (const [label, over, msg] of cases) {
      const r = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf)
        .send({ type: "genericapi", name: `${PREFIX} bad`, config: { ...base, ...over } });
      expect(r.status, label).toBe(400);
      expect(JSON.stringify(r.body), label).toMatch(msg);
    }
    // A network-only feed needs no identity mapping, and never stores a push switch.
    const ok = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({
      type: "genericapi", name: `${PREFIX} ipam`,
      config: { host: "ipam.example.com", fieldMap: {}, readDevices: false, pushReservations: true,
        networkQueries: [{ name: "Prefixes", kind: "subnets", path: "/api/ipam/prefixes", recordsPath: "results", paginate: true, map: { cidr: "prefix" } }] },
    });
    expect(ok.status).toBe(201);
    const stored = (await prisma.integration.findUnique({ where: { id: ok.body.id } }))!.config as Record<string, unknown>;
    expect(stored.readDevices).toBe(false);
    expect(stored.releaseMissingAddresses).toBe(true);
    expect(stored.deprecateMissingSubnets).toBe(false);
    expect(stored).not.toHaveProperty("pushReservations");
    expect((stored.networkQueries as any[])[0]).toMatchObject({ kind: "subnets", paginate: true, map: { cidr: "prefix" } });
  });
});
