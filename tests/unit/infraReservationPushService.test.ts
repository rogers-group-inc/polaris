/**
 * tests/unit/infraReservationPushService.test.ts — the scheduled DHCP write
 * (src/services/infraReservationPushService.ts → runInfraReservationPush).
 *
 * The pure eligibility predicate is pinned clause by clause in
 * tests/unit/infraReservationPush.test.ts; this suite drives the pass itself
 * against a stubbed Prisma client and a stubbed pushReservation: both opt-in
 * gates, the asset/row scoping, the per-cycle ceiling, the success stamp, the
 * permanent-vs-transient failure split (classifyPushError is the real one) and
 * the summary Event.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";

const m = vi.hoisted(() => ({
  pushReservation: vi.fn(),
  integrationPushEnabled: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/reservationPushService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pushReservation: m.pushReservation,
  integrationPushEnabled: m.integrationPushEnabled,
}));

const { runInfraReservationPush } = await import("../../src/services/infraReservationPushService.js");

const db = {
  integrationFindUnique: stubbed(prisma.integration.findUnique),
  assetFindMany: stubbed(prisma.asset.findMany),
  reservationFindMany: stubbed(prisma.reservation.findMany),
  reservationUpdate: stubbed(prisma.reservation.update),
};

const INTEGRATION = { id: "int1", type: "fortigate", config: { pushReservations: true, autoReserveFortinetInfra: true } };

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: `r${n}`,
  ipAddress: `10.0.0.${n}`,
  hostname: `sw-${n}`,
  notes: null,
  macAddress: `AA:BB:CC:00:00:${String(n).padStart(2, "0")}`,
  sourceType: "fortiswitch",
  dhcpBinding: "lease",
  pushedToId: null,
  pushStatus: null,
  subnet: { cidr: "10.0.0.0/24", discoveredBy: "int1", fortigateDevice: "FGT-A" },
  ...over,
});

const params = { integrationId: "int1", integrationName: "Branch FGT", actor: "system" };
const lastEvent = () => eventLog.logEvent.mock.calls.at(-1)![0] as unknown as Record<string, any>;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.pushReservation.mockReset();
  m.integrationPushEnabled.mockReset();
  m.integrationPushEnabled.mockReturnValue(true);
  m.pushReservation.mockResolvedValue({ scopeId: 7, entryId: 42 });
  db.integrationFindUnique.mockResolvedValue(INTEGRATION);
  db.assetFindMany.mockResolvedValue([{ id: "a1", hostname: "sw-1", ipAddress: "10.0.0.1" }]);
  db.reservationFindMany.mockResolvedValue([row(1)]);
  db.reservationUpdate.mockResolvedValue({});
});

const ZERO = { attempted: 0, pushed: 0, failed: 0, deferred: 0 };

describe("runInfraReservationPush — gates", () => {
  it("does nothing for an unknown integration", async () => {
    db.integrationFindUnique.mockResolvedValue(null);
    await expect(runInfraReservationPush(params)).resolves.toEqual(ZERO);
    expect(db.assetFindMany).not.toHaveBeenCalled();
  });

  it("does nothing when the transport gate (pushReservations) is off, even with the feature flag on", async () => {
    m.integrationPushEnabled.mockReturnValue(false);
    await expect(runInfraReservationPush(params)).resolves.toEqual(ZERO);
    expect(m.integrationPushEnabled).toHaveBeenCalledWith(INTEGRATION);
    expect(db.assetFindMany).not.toHaveBeenCalled();
    expect(m.pushReservation).not.toHaveBeenCalled();
  });

  it("does nothing unless autoReserveFortinetInfra is exactly true", async () => {
    for (const config of [{ pushReservations: true }, { pushReservations: true, autoReserveFortinetInfra: "true" }, null]) {
      db.integrationFindUnique.mockResolvedValue({ ...INTEGRATION, config });
      await expect(runInfraReservationPush(params)).resolves.toEqual(ZERO);
    }
    expect(m.pushReservation).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("runInfraReservationPush — scoping", () => {
  it("reads only this integration's active switches/APs with an address, then their active reservations", async () => {
    db.assetFindMany.mockResolvedValue([
      { id: "a1", ipAddress: "10.0.0.1" },
      { id: "a2", ipAddress: "10.0.0.1" }, // duplicate address: one IN entry
      { id: "a3", ipAddress: "10.0.0.3" },
    ]);
    await runInfraReservationPush(params);
    expect(db.assetFindMany.mock.calls[0][0].where).toEqual({
      discoveredByIntegrationId: "int1",
      assetType: { in: ["switch", "access_point"] },
      status: "active",
      ipAddress: { not: null },
    });
    expect(db.reservationFindMany.mock.calls[0][0].where).toEqual({
      ipAddress: { in: ["10.0.0.1", "10.0.0.3"] },
      status: "active",
    });
  });

  it("stops before the reservation read when the integration owns no such asset", async () => {
    db.assetFindMany.mockResolvedValue([]);
    await expect(runInfraReservationPush(params)).resolves.toEqual(ZERO);
    expect(db.reservationFindMany).not.toHaveBeenCalled();
  });

  it("pushes only eligible rows and writes no Event when none are", async () => {
    db.reservationFindMany.mockResolvedValue([
      row(1, { dhcpBinding: "reservation" }),
      row(2, { macAddress: null }),
      row(3, { pushStatus: "failed_permanent" }),
      row(4, { pushedToId: "int1" }),
      row(5, { sourceType: "dhcp_lease" }),
      row(6, { subnet: { cidr: "10.0.0.0/24", discoveredBy: "other", fortigateDevice: "FGT-A" } }),
      row(7, { subnet: { cidr: "10.0.0.0/24", discoveredBy: "int1", fortigateDevice: null } }),
    ]);
    await expect(runInfraReservationPush(params)).resolves.toEqual(ZERO);
    expect(m.pushReservation).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("runInfraReservationPush — pushing", () => {
  it("pushes the lease-table MAC to the row's own gate and stamps the push pointers", async () => {
    db.reservationFindMany.mockResolvedValue([row(1, { sourceType: "fortinap", hostname: "ap-1" })]);
    const out = await runInfraReservationPush(params);
    expect(out).toEqual({ attempted: 1, pushed: 1, failed: 0, deferred: 0 });
    expect(m.pushReservation).toHaveBeenCalledWith({
      reservationId: "r1",
      subnetCidr: "10.0.0.0/24",
      ip: "10.0.0.1",
      mac: "AA:BB:CC:00:00:01",
      hostname: "ap-1",
      notes: null,
      createdBy: "system:auto-reserve",
      integration: INTEGRATION,
      deviceName: "FGT-A",
    });
    const upd = db.reservationUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "r1" });
    expect(upd.data).toMatchObject({
      pushedToId: "int1",
      pushedScopeId: 7,
      pushedEntryId: 42,
      pushStatus: "synced",
      pushError: null,
      dhcpBinding: "reservation",
    });
    expect(upd.data.pushedAt).toBeInstanceOf(Date);
    expect(lastEvent()).toMatchObject({
      action: "reservation.infra.auto_pushed",
      resourceType: "integration",
      resourceId: "int1",
      resourceName: "Branch FGT",
      actor: "system",
      level: "info",
      message: "Auto-reserved 1 managed device address(es) on their FortiGate",
      details: { integrationId: "int1", attempted: 1, pushed: 1, failed: 0, deferred: 0, ips: ["10.0.0.1"] },
    });
  });

  it("caps a cycle at 25 writes and defers the rest", async () => {
    db.reservationFindMany.mockResolvedValue(Array.from({ length: 30 }, (_, i) => row(i + 1)));
    const out = await runInfraReservationPush(params);
    expect(out).toEqual({ attempted: 25, pushed: 25, failed: 0, deferred: 5 });
    expect(m.pushReservation).toHaveBeenCalledTimes(25);
    expect(lastEvent().message).toBe("Auto-reserved 25 managed device address(es) on their FortiGate; 5 deferred to the next cycle");
    expect(lastEvent().details).toMatchObject({ deferred: 5 });
    expect((lastEvent().details.ips as string[])).toHaveLength(25);
  });

  it("never runs more than two pushes at once", async () => {
    db.reservationFindMany.mockResolvedValue(Array.from({ length: 6 }, (_, i) => row(i + 1)));
    let inFlight = 0;
    let peak = 0;
    m.pushReservation.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { scopeId: 1, entryId: 1 };
    });
    await runInfraReservationPush(params);
    expect(peak).toBeLessThanOrEqual(2);
    expect(m.pushReservation).toHaveBeenCalledTimes(6);
  });

  it("records a PERMANENT refusal on the row so it leaves the candidate set", async () => {
    db.reservationFindMany.mockResolvedValue([row(1), row(2)]);
    m.pushReservation.mockImplementation(async ({ reservationId }: { reservationId: string }) => {
      if (reservationId === "r2") throw new AppError(400, "entry rejected by device: " + "x".repeat(600));
      return { scopeId: 1, entryId: 2 };
    });
    const out = await runInfraReservationPush(params);
    expect(out).toEqual({ attempted: 2, pushed: 1, failed: 1, deferred: 0 });
    const failedWrite = db.reservationUpdate.mock.calls.find((c) => c[0].where.id === "r2")![0];
    expect(failedWrite.data.pushStatus).toBe("failed_permanent");
    expect(failedWrite.data.pushError).toHaveLength(500);
    expect(failedWrite.data.pushError.startsWith("entry rejected by device")).toBe(true);
    expect(failedWrite.data.pushLastAttemptAt).toBeInstanceOf(Date);
    expect(lastEvent()).toMatchObject({
      level: "warning",
      message: "Auto-reserved 1 managed device address(es) on their FortiGate; 1 failed",
    });
  });

  it("leaves a TRANSIENT failure untouched for the next cycle", async () => {
    m.pushReservation.mockRejectedValue(new Error("ETIMEDOUT"));
    const out = await runInfraReservationPush(params);
    expect(out).toEqual({ attempted: 1, pushed: 0, failed: 1, deferred: 0 });
    expect(db.reservationUpdate).not.toHaveBeenCalled();
    expect(lastEvent()).toMatchObject({ level: "warning" });
  });

  it("still finishes the pass when recording a permanent failure itself fails", async () => {
    m.pushReservation.mockRejectedValue(new AppError(409, "duplicate"));
    db.reservationUpdate.mockRejectedValue(new Error("db down"));
    await expect(runInfraReservationPush(params)).resolves.toEqual({ attempted: 1, pushed: 0, failed: 1, deferred: 0 });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });

  it("counts every row as failed (transient, no device call) once the signal is aborted", async () => {
    db.reservationFindMany.mockResolvedValue([row(1), row(2)]);
    const ac = new AbortController();
    ac.abort();
    const out = await runInfraReservationPush({ ...params, signal: ac.signal });
    expect(out).toEqual({ attempted: 2, pushed: 0, failed: 2, deferred: 0 });
    expect(m.pushReservation).not.toHaveBeenCalled();
    expect(db.reservationUpdate).not.toHaveBeenCalled();
  });
});
