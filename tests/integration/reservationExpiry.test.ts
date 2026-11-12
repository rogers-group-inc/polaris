/**
 * tests/integration/reservationExpiry.test.ts
 *
 * Business rule 175: a reservation that EXPIRES ends the way a released one
 * does. A network reserved as a whole goes back to "available", and the
 * reserved-address Polaris pushed to the FortiGate is removed — retried while
 * the gate cannot be reached, then reported once.
 *
 * The device call is stubbed: what is under test is which rows Polaris tries,
 * what it records, and when it stops.
 */

import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  unpush: vi.fn(async (_p: unknown) => ({ alreadyAbsent: false })),
}));
vi.mock("../../src/services/reservationPushService.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  unpushReservation: h.unpush,
}));

import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  expireStaleReservations,
  unpushExpiredReservations,
  EXPIRED_UNPUSH_MAX_ATTEMPTS,
} from "../../src/services/reservationService.js";

const d = dbDescribe;
const PFX = "expiry-test";
const BLOCK = "10.91.0.0/16";
const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 3_600_000);

async function cleanup() {
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.event.deleteMany({ where: { action: { startsWith: "reservation.unpush" }, message: { contains: PFX } } });
}

async function network(cidr: string, status: "available" | "reserved" = "available", fortigateDevice: string | null = null) {
  const block = await prisma.ipBlock.upsert({ where: { cidr: BLOCK }, update: {}, create: { name: `${PFX} block`, cidr: BLOCK, ipVersion: "v4" } as never });
  return prisma.subnet.create({ data: { blockId: block.id, cidr, name: `${PFX} ${cidr}`, status, fortigateDevice } as never });
}

const reservation = (subnetId: string, data: Record<string, unknown>) =>
  prisma.reservation.create({ data: { subnetId, status: "active", ...data } as never });

async function unpushEvents(resourceId: string, action: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await prisma.event.findMany({ where: { action, resourceId } });
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});
beforeEach(async () => {
  h.unpush.mockReset();
  h.unpush.mockImplementation(async () => ({ alreadyAbsent: false }));
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("an expired whole-network reservation frees the network (rule 175)", () => {
  it("returns the network to available, and leaves one another reservation still holds", async () => {
    const lapsed = await network("10.91.1.0/24", "reserved");
    const held = await network("10.91.2.0/24", "reserved");
    const untouched = await network("10.91.3.0/24", "reserved");
    await reservation(lapsed.id, { expiresAt: past() });
    await reservation(held.id, { expiresAt: past(), hostname: "first" });
    await reservation(held.id, { expiresAt: future(), hostname: "second" });
    // A single-address reservation lapsing says nothing about the network's status.
    await reservation(untouched.id, { ipAddress: "10.91.3.10", expiresAt: past() });

    expect(await expireStaleReservations()).toBe(3);

    const status = async (id: string) => (await prisma.subnet.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(lapsed.id)).toBe("available");
    expect(await status(held.id)).toBe("reserved");
    expect(await status(untouched.id)).toBe("reserved");
  });
});

d("an expired reservation's device entry is removed (rule 175)", () => {
  async function pushed(ip: string, extra: Record<string, unknown> = {}) {
    const integration = await prisma.integration.create({ data: { type: "fortigate", name: `${PFX} gate ${ip}`, config: {} } as never });
    const subnet = await network("10.91.9.0/24", "available", "gate-a").catch(async () =>
      prisma.subnet.findFirstOrThrow({ where: { cidr: "10.91.9.0/24" } }));
    const row = await reservation(subnet.id, {
      ipAddress: ip, hostname: `${PFX}-${ip}`, macAddress: "AA:BB:CC:00:00:01", expiresAt: past(),
      pushedToId: integration.id, pushedScopeId: 3, pushedEntryId: 7, pushStatus: "pushed", pushAttempts: 4, pushError: "from the push", ...extra,
    });
    return { row, integration };
  }

  it("asks the gate to delete the entry Polaris pushed, then clears the pointers", async () => {
    const { row, integration } = await pushed("10.91.9.10");
    await expireStaleReservations();
    // The push's own attempt history does not count against the un-push.
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } })).pushAttempts).toBe(0);

    expect(await unpushExpiredReservations()).toEqual({ removed: 1, failed: 0 });
    expect(h.unpush).toHaveBeenCalledTimes(1);
    expect(h.unpush.mock.calls[0]![0]).toMatchObject({
      reservationId: row.id, scopeId: 3, entryId: 7, ip: "10.91.9.10", deviceName: "gate-a", integration: { id: integration.id },
    });
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "expired", pushedToId: null, pushedScopeId: null, pushedEntryId: null, pushStatus: null, pushError: null });
    expect((await unpushEvents(row.id, "reservation.unpush.succeeded")).length).toBe(1);

    // Nothing left to do on the next tick.
    expect(await unpushExpiredReservations()).toEqual({ removed: 0, failed: 0 });
    expect(h.unpush).toHaveBeenCalledTimes(1);
  });

  it("retries an unreachable gate on later ticks, then reports once and stops", async () => {
    const { row } = await pushed("10.91.9.11");
    await expireStaleReservations();
    h.unpush.mockRejectedValue(new Error(`${PFX} gate unreachable`));

    for (let i = 1; i <= EXPIRED_UNPUSH_MAX_ATTEMPTS; i++) {
      expect(await unpushExpiredReservations()).toEqual({ removed: 0, failed: 1 });
      const r = await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } });
      expect(r.pushAttempts).toBe(i);
      expect(r.pushedEntryId).toBe(7); // the pointers stay: they are the record of what is on the gate
    }
    expect(await unpushExpiredReservations()).toEqual({ removed: 0, failed: 0 });
    expect(h.unpush).toHaveBeenCalledTimes(EXPIRED_UNPUSH_MAX_ATTEMPTS);
    const events = await unpushEvents(row.id, "reservation.unpush.failed");
    expect(events.length).toBe(1);
    expect(events[0]!.message).toContain("still on FortiGate");
  });

  it("a gate that comes back is un-pushed on the next tick", async () => {
    const { row } = await pushed("10.91.9.12");
    await expireStaleReservations();
    h.unpush.mockRejectedValueOnce(new Error("down"));
    expect(await unpushExpiredReservations()).toEqual({ removed: 0, failed: 1 });
    expect(await unpushExpiredReservations()).toEqual({ removed: 1, failed: 0 });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } })).pushedEntryId).toBeNull();
  });

  it("leaves alone a row that pushed nothing, a queued row, and an active row", async () => {
    const subnet = await network("10.91.8.0/24");
    const integration = await prisma.integration.create({ data: { type: "fortigate", name: `${PFX} gate idle`, config: {} } as never });
    await reservation(subnet.id, { ipAddress: "10.91.8.10", expiresAt: past() });
    await reservation(subnet.id, { ipAddress: "10.91.8.11", expiresAt: past(), pushedToId: integration.id, pushStatus: "pending" });
    await reservation(subnet.id, { ipAddress: "10.91.8.12", expiresAt: future(), pushedToId: integration.id, pushedScopeId: 1, pushedEntryId: 2, pushStatus: "pushed" });
    await expireStaleReservations();
    expect(await unpushExpiredReservations()).toEqual({ removed: 0, failed: 0 });
    expect(h.unpush).not.toHaveBeenCalled();
  });
});
