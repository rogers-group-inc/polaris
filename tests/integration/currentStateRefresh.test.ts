/**
 * tests/integration/currentStateRefresh.test.ts
 *
 * The freshness contract behind the three snapshot tabs — Wireless, MAC Table
 * and ARP Table. Each states how often its data is re-read and how old the
 * reading is, and each offers a Refresh that re-asks the device. What is
 * pinned here is the half the browser cannot compute for itself:
 *
 *  - GET /assets/:id/mac-table hands back the same freshness pair the ARP tab
 *    already had (`collectedAt` + `pollIntervalSec`) plus the pass stamp that
 *    separates "scraped and genuinely empty" from "never scraped" — an empty
 *    forwarding database means both, and the tab has to say which;
 *  - the MAC cadence has NO discovery fallback, unlike ARP's: only the
 *    system-info pass writes the forwarding database, so an unmonitored switch
 *    must report null rather than borrowing its integration's 12-hour sweep;
 *  - POST /assets/:id/refresh-system-info runs the system-info collector ALONE
 *    and leaves monitor state untouched. That is the whole reason it exists
 *    instead of the tabs calling probe-now: a manual refresh must not be able
 *    to mark an asset down, clear a missed poll, or move lastSeen.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;

let switchId = "";
let unmonitoredSwitchId = "";
let integrationId = "";

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
  await prisma.assetMacTableEntry.deleteMany();
  await prisma.event.deleteMany({ where: { action: "asset.refresh" } });
  await prisma.assetSource.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.integration.deleteMany();

  const integration = await prisma.integration.create({
    // pollInterval is in HOURS — the figure the ARP tab falls back to and the
    // MAC tab must NOT.
    data: { name: "FMG-Test", type: "fortimanager", config: {} as any, enabled: true, pollInterval: 12 },
  });
  integrationId = integration.id;

  switchId = (await prisma.asset.create({
    data: {
      hostname: "SW-1", assetType: "switch", status: "active",
      ipAddress: "10.0.0.11", monitored: true,
      discoveredByIntegrationId: integrationId,
    },
  })).id;

  unmonitoredSwitchId = (await prisma.asset.create({
    data: {
      hostname: "SW-2", assetType: "switch", status: "active",
      ipAddress: "10.0.0.12", monitored: false,
      discoveredByIntegrationId: integrationId,
    },
  })).id;
});

async function seedFdb(assetId: string, lastSeen: Date) {
  await prisma.assetMacTableEntry.create({
    data: {
      assetId,
      macAddress: "aa:bb:cc:dd:ee:01",
      vlanId: 10,
      basePort: 7,
      ifName: "port7",
      status: "learned",
      firstSeen: lastSeen,
      lastSeen,
    },
  });
}

d("GET /assets/:id/mac-table — freshness facts", () => {
  it("reports when the forwarding database was collected and how often it is re-read", async () => {
    const collected = new Date(Date.now() - 5 * 60 * 1000);
    await seedFdb(switchId, collected);

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${switchId}/mac-table`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(new Date(res.body.collectedAt).getTime()).toBe(collected.getTime());
    // Resolved from the monitor settings walk, so it is a positive number of
    // seconds rather than the integration's hours.
    expect(typeof res.body.pollIntervalSec).toBe("number");
    expect(res.body.pollIntervalSec).toBeGreaterThan(0);
  });

  // The whole table is delete-replaced under one timestamp, so the newest
  // lastSeen IS the scrape stamp — not a per-row "when did we last see this
  // MAC", which would make a quiet port look stale on its own.
  it("takes the collection stamp from the newest row across the whole table", async () => {
    const older = new Date(Date.now() - 60 * 60 * 1000);
    const newer = new Date(Date.now() - 60 * 1000);
    await seedFdb(switchId, older);
    await prisma.assetMacTableEntry.create({
      data: {
        assetId: switchId, macAddress: "aa:bb:cc:dd:ee:02", vlanId: 10,
        basePort: 8, ifName: "port8", status: "learned", firstSeen: newer, lastSeen: newer,
      },
    });
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${switchId}/mac-table`);
    expect(new Date(res.body.collectedAt).getTime()).toBe(newer.getTime());
  });

  // An empty forwarding database is ambiguous from the rows alone. The pass
  // stamp is what separates a switch polled over REST (recent pass, no FDB
  // ever) from one that has never been reached at all.
  it("separates 'scraped and empty' from 'never scraped' with the pass stamp", async () => {
    const { agent } = await authedAgent(app);

    const never = await agent.get(`/api/v1/assets/${switchId}/mac-table`);
    expect(never.body).toMatchObject({ total: 0, collectedAt: null, lastSystemInfoAt: null });

    const passAt = new Date(Date.now() - 2 * 60 * 1000);
    await prisma.asset.update({ where: { id: switchId }, data: { lastSystemInfoAt: passAt } });
    const scraped = await agent.get(`/api/v1/assets/${switchId}/mac-table`);
    expect(scraped.body.collectedAt).toBeNull();
    expect(new Date(scraped.body.lastSystemInfoAt).getTime()).toBe(passAt.getTime());
  });

  // ARP has a second writer (discovery) and falls back to its cadence; the
  // forwarding database does not, and inventing one would tell the operator a
  // refresh is coming that never is.
  it("reports no cadence for an unmonitored switch instead of borrowing the discovery sweep", async () => {
    await seedFdb(unmonitoredSwitchId, new Date());
    const { agent } = await authedAgent(app);

    const mac = await agent.get(`/api/v1/assets/${unmonitoredSwitchId}/mac-table`);
    expect(mac.body.pollIntervalSec).toBeNull();

    // Same asset, same integration: the ARP tab DOES fall back, to 12 h.
    const arp = await agent.get(`/api/v1/assets/${unmonitoredSwitchId}/arp-table`);
    expect(arp.body.pollIntervalSec).toBe(12 * 3600);
  });

  it("requires authentication", async () => {
    const res = await request(app).get(`/api/v1/assets/${switchId}/mac-table`);
    expect(res.status).toBe(401);
  });
});

d("POST /assets/:id/refresh-system-info", () => {
  it("404s on an asset that does not exist", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/assets/00000000-0000-0000-0000-000000000000/refresh-system-info")
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(404);
  });

  // Monitoring off is a legitimate answer, not a failure: the collector
  // declines before any traffic, and the tab says "nothing to refresh".
  it("answers supported:false for an asset the system-info pass does not cover", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post(`/api/v1/assets/${unmonitoredSwitchId}/refresh-system-info`)
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(false);
    expect(res.body.collected).toBe(false);
  });

  // The reason this is not probe-now. recordSystemInfoResult writes no probe
  // result, so an operator hitting Refresh on a tab can neither flip the
  // monitor pill nor disturb the down-detection counters.
  it("leaves monitor state alone", async () => {
    await prisma.asset.update({
      where: { id: unmonitoredSwitchId },
      data: { monitorStatus: "down", consecutiveFailures: 3, lastResponseTimeMs: 42 },
    });
    const SELECT = {
      monitorStatus: true, monitorStatusChangedAt: true, consecutiveFailures: true,
      lastSeen: true, lastResponseTimeMs: true,
    } as const;
    const before = await prisma.asset.findUnique({ where: { id: unmonitoredSwitchId }, select: SELECT });

    const { agent, csrf } = await authedAgent(app);
    await agent.post(`/api/v1/assets/${unmonitoredSwitchId}/refresh-system-info`).set("X-CSRF-Token", csrf);

    const after = await prisma.asset.findUnique({ where: { id: unmonitoredSwitchId }, select: SELECT });
    expect(after).toEqual(before);
  });

  it("audits the refresh, since it is operator-initiated", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post(`/api/v1/assets/${unmonitoredSwitchId}/refresh-system-info`).set("X-CSRF-Token", csrf);
    expect(await waitForEventCount("asset.refresh", 1, unmonitoredSwitchId)).toBeGreaterThanOrEqual(1);
  });

  // The same short-circuit probe-now has: an operator who narrowed the
  // integration to keep Polaris off a host must not be able to reach it from
  // a tab's Refresh button either.
  it("refuses a device the originating integration's filter excludes", async () => {
    await prisma.integration.update({
      where: { id: integrationId },
      data: { config: { deviceExclude: ["SW-2"] } as any },
    });
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post(`/api/v1/assets/${unmonitoredSwitchId}/refresh-system-info`)
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(409);
    expect(res.body.collected).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  // CSRF runs ahead of the session check on a mutating route, so an anonymous
  // POST is rejected as 403 rather than 401 — either way it never reaches the
  // collector, which is what this pins.
  it("rejects an unauthenticated caller", async () => {
    const res = await request(app).post(`/api/v1/assets/${switchId}/refresh-system-info`);
    expect([401, 403]).toContain(res.status);
  });
});
