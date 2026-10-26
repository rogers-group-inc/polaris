/**
 * tests/integration/reservationPushQueue.test.ts
 *
 * Covers the read-side API surface for the queued push state — list + count
 * routes, plus the "queued row is invisible to the retry route until its
 * pushStatus is right." Lifecycle tests that exercise the FMG / FortiGate
 * transport (transient-vs-permanent classification on real create flows,
 * the retry tick promoting pending → synced) are covered in the unit suite
 * for classifyPushError; full end-to-end with a mocked transport is left
 * for a follow-up so the integration scope here stays focused on the API
 * + DB shapes.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

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
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
});

async function scaffold(agent: any, csrf: string) {
  const block = await agent
    .post("/api/v1/blocks")
    .set("X-CSRF-Token", csrf)
    .send({ name: "B-queue", cidr: "10.70.0.0/16" });
  const subnet = await agent
    .post("/api/v1/subnets")
    .set("X-CSRF-Token", csrf)
    .send({ blockId: block.body.id, cidr: "10.70.1.0/24", name: "S-queue" });
  return { block: block.body, subnet: subnet.body };
}

d("GET /reservations/push-queue + /push-queue/count", () => {
  it("returns an empty list and count=0 when nothing is queued", async () => {
    const { agent } = await authedAgent(app);
    const list = await agent.get("/api/v1/reservations/push-queue");
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(0);
    expect(list.body.reservations).toEqual([]);
    const count = await agent.get("/api/v1/reservations/push-queue/count");
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ count: 0, failed: 0 });
  });

  it("surfaces pending and failed_permanent rows; ignores synced + released", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf);

    // Seed four reservations directly in the DB so we can pin pushStatus
    // independently of the (FortiGate-dependent) push code path.
    const now = new Date();
    await prisma.reservation.createMany({
      data: [
        {
          subnetId: subnet.id,
          ipAddress: "10.70.1.10",
          hostname: "queued-a",
          status: "active",
          sourceType: "manual",
          macAddress: "aa:bb:cc:00:00:01",
          pushStatus: "pending",
          pushQueuedAt: now,
          pushAttempts: 1,
          pushError: "FMG unreachable",
        },
        {
          subnetId: subnet.id,
          ipAddress: "10.70.1.11",
          hostname: "queued-b",
          status: "active",
          sourceType: "manual",
          macAddress: "aa:bb:cc:00:00:02",
          pushStatus: "failed_permanent",
          pushQueuedAt: new Date(now.getTime() - 1000),
          pushAttempts: 3,
          pushError: "IP collided during queue — discovered dhcp_lease by aa:bb:cc:00:00:99",
        },
        {
          subnetId: subnet.id,
          ipAddress: "10.70.1.12",
          hostname: "synced",
          status: "active",
          sourceType: "dhcp_reservation",
          macAddress: "aa:bb:cc:00:00:03",
          pushStatus: "synced",
          pushedAt: now,
        },
        {
          subnetId: subnet.id,
          ipAddress: "10.70.1.13",
          hostname: "released",
          status: "released",
          sourceType: "manual",
          pushStatus: "pending", // shouldn't matter — status filter wins
        },
      ],
    });

    const list = await agent.get("/api/v1/reservations/push-queue");
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(2);
    const hostnames = list.body.reservations.map((r: any) => r.hostname).sort();
    expect(hostnames).toEqual(["queued-a", "queued-b"]);
    // Oldest first ordering — pushQueuedAt ascending.
    expect(list.body.reservations[0].hostname).toBe("queued-b");
    expect(list.body.reservations[1].hostname).toBe("queued-a");
    // Subnet relation hydrated for the UI without an N+1 fetch.
    expect(list.body.reservations[0].subnet).toMatchObject({ cidr: "10.70.1.0/24", name: "S-queue" });

    const count = await agent.get("/api/v1/reservations/push-queue/count");
    expect(count.body.count).toBe(2);
    // Only the failed_permanent row needs an operator — the Events dot and the
    // Alerts badge turn red on this figure, not on the total.
    expect(count.body.failed).toBe(1);
  });
});

d("POST /reservations/:id/retry-push", () => {
  it("returns 409 when the reservation is not queued", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf);
    const r = await agent
      .post("/api/v1/reservations")
      .set("X-CSRF-Token", csrf)
      .send({ subnetId: subnet.id, ipAddress: "10.70.1.20", hostname: "not-queued" });
    expect(r.status).toBe(201);
    expect(r.body.pushStatus).toBeNull();
    const retry = await agent
      .post(`/api/v1/reservations/${r.body.id}/retry-push`)
      .set("X-CSRF-Token", csrf);
    expect(retry.status).toBe(409);
    expect(String(retry.body?.error || "")).toMatch(/not queued/i);
  });

  it("returns 404 for a missing reservation id", async () => {
    const { agent, csrf } = await authedAgent(app);
    const retry = await agent
      .post(`/api/v1/reservations/00000000-0000-4000-8000-000000000000/retry-push`)
      .set("X-CSRF-Token", csrf);
    expect(retry.status).toBe(404);
  });
});

d("DELETE /reservations/:id for a queued row", () => {
  it("releases a pending row without contacting the FortiGate", async () => {
    const { agent, csrf } = await authedAgent(app);
    const { subnet } = await scaffold(agent, csrf);
    // Seed a pending row directly so we don't depend on the FG transport.
    const queued = await prisma.reservation.create({
      data: {
        subnetId: subnet.id,
        ipAddress: "10.70.1.30",
        hostname: "queued-for-release",
        status: "active",
        sourceType: "manual",
        macAddress: "aa:bb:cc:00:00:30",
        pushStatus: "pending",
        pushQueuedAt: new Date(),
        pushAttempts: 1,
      },
    });
    const del = await agent
      .delete(`/api/v1/reservations/${queued.id}`)
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204); // release returns 204 No Content
    const after = await prisma.reservation.findUnique({ where: { id: queued.id } });
    expect(after?.status).toBe("released");
    expect(after?.pushStatus).toBeNull();
    expect(after?.pushQueuedAt).toBeNull();
    expect(after?.pushAttempts).toBe(0);
  });
});
