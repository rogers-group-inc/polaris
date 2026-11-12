/**
 * tests/unit/reservationService.test.ts — own suite for reservationService
 * (CQ-T010).
 *
 * Complements, does not repeat:
 *   - reservationCreateCollision / infraReservationRelease /
 *     reservationExpiryCollision / expiredReservationUnpush /
 *     reservationPushQueue unit suites and tests/integration/reservations*.ts —
 *     createReservation, releaseReservation, releaseInfraReservationsForAssets,
 *     findNextAvailableIps, expireStaleReservations, unpushExpiredReservations,
 *     listPushQueue
 *
 * Unreached until now: listReservations (limit clamp, the pushEligible flag
 * and the stripped integration blob), getReservation, isDeviceOwnedRow,
 * updateReservation (owner auto-stamp, MAC normalisation, the zero-MAC and
 * clear-MAC refusals, push-before-write on an eligible subnet, the rule 74
 * description budget, queued rows that need no device), countPushQueueByState,
 * the queued-push retry engine behind retryPendingReservations /
 * retryReservationNow (eligibility drift cancels, a discovery collider
 * supersedes, the monitored-down and backoff gates — "passive" exempt —,
 * transient vs permanent errors), triggerRetryAfterStatusChange, and
 * reconcileOrphanedInfraReservations' selection and per-pass cap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const push = vi.hoisted(() => ({
  pushReservation: vi.fn(),
  updatePushedReservation: vi.fn(),
  unpushReservation: vi.fn(),
  releaseDhcpLease: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/reservationPushService.js", async (orig) => ({
  ...(await orig<object>()),
  ...push,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  listReservations,
  getReservation,
  isDeviceOwnedRow,
  DEVICE_OWNED_SOURCE_TYPES,
  updateReservation,
  countPushQueueByState,
  retryPendingReservations,
  retryReservationNow,
  triggerRetryAfterStatusChange,
  reconcileOrphanedInfraReservations,
  nextAvailableReservation,
} from "../../src/services/reservationService.js";

const NOW = new Date("2026-05-10T12:00:00Z");
const actions = () => eventLog.logEvent.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(push)) f.mockReset();
  stubbed(prisma.reservation.update).mockImplementation(async ({ data }: { data: object }) => ({ id: "r1", ...data }));
});

afterEach(() => vi.useRealTimers());

// ─── list / get ─────────────────────────────────────────────────────────────

describe("listReservations", () => {
  it("defaults to 50, caps at 200, and passes only the filters given", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([]);
    stubbed(prisma.reservation.count).mockResolvedValue(0);
    let r = await listReservations();
    expect(r).toMatchObject({ limit: 50, offset: 0, total: 0 });
    expect(stubbed(prisma.reservation.findMany).mock.calls[0][0]).toMatchObject({ where: {}, skip: 0, take: 50 });

    r = await listReservations({ limit: 5000, offset: 20, owner: "dave", status: "active" });
    expect(r.limit).toBe(200);
    expect(stubbed(prisma.reservation.findMany).mock.calls[1][0]).toMatchObject({
      where: { owner: "dave", status: "active" }, skip: 20, take: 200,
    });
  });

  it("flags push eligibility and never returns the integration's config", async () => {
    const pushing = { type: "fortigate", config: { pushReservations: true, apiToken: "secret" } };
    stubbed(prisma.reservation.findMany).mockResolvedValue([
      { id: "a", ipAddress: "10.0.0.5", subnet: { cidr: "10.0.0.0/24", integration: pushing } },
      { id: "b", ipAddress: "2001:db8::5", subnet: { cidr: "2001:db8::/64", integration: pushing } },
      { id: "c", ipAddress: null, subnet: { cidr: "10.0.0.0/24", integration: pushing } },
      { id: "d", ipAddress: "10.0.0.6", subnet: { cidr: "10.0.0.0/24", integration: { type: "fortigate", config: {} } } },
      { id: "e", ipAddress: "10.0.0.7", subnet: null },
    ]);
    stubbed(prisma.reservation.count).mockResolvedValue(5);
    const { reservations } = await listReservations();
    expect(reservations.map((r) => [r.id, r.pushEligible])).toEqual([
      ["a", true], ["b", false], ["c", false], ["d", false], ["e", false],
    ]);
    expect(JSON.stringify(reservations)).not.toContain("secret");
    expect(reservations[0].subnet).toEqual({ cidr: "10.0.0.0/24" });
    expect(reservations[4].subnet).toBeNull();
  });
});

describe("getReservation", () => {
  it("returns the row with its subnet and block", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue({ id: "r1" });
    expect(await getReservation("r1")).toEqual({ id: "r1" });
    expect(stubbed(prisma.reservation.findUnique).mock.calls[0][0].include.subnet.include.block).toBeTruthy();
  });

  it("404s a missing id", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(null);
    await expect(getReservation("nope")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("isDeviceOwnedRow", () => {
  it("is true only for a VIP or an interface address — config the device owns", () => {
    expect([...DEVICE_OWNED_SOURCE_TYPES].sort()).toEqual(["interface_ip", "vip"]);
    expect(isDeviceOwnedRow({ sourceType: "vip" })).toBe(true);
    expect(isDeviceOwnedRow({ sourceType: "interface_ip" })).toBe(true);
    for (const t of ["manual", "dhcp_reservation", "dhcp_lease", "fortiswitch", "observed"]) {
      expect(isDeviceOwnedRow({ sourceType: t })).toBe(false);
    }
  });
});

// ─── update ─────────────────────────────────────────────────────────────────

function row(over: Record<string, unknown> = {}, subnetOver: Record<string, unknown> = {}) {
  return {
    id: "r1",
    status: "active",
    ipAddress: "10.0.0.5",
    hostname: "printer",
    owner: "alice",
    projectRef: null,
    expiresAt: null,
    notes: null,
    createdBy: "alice",
    macAddress: "aa:bb:cc:dd:ee:01",
    pushStatus: "synced",
    pushedScopeId: 3,
    pushedEntryId: 7,
    subnet: {
      cidr: "10.0.0.0/24",
      fortigateDevice: "FGT-HQ",
      integration: { id: "int1", type: "fortigate", config: { pushReservations: true } },
      ...subnetOver,
    },
    ...over,
  };
}

describe("updateReservation", () => {
  it("404s a missing row and 409s one that is not active", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(null);
    await expect(updateReservation("x", {})).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({ status: "released" }));
    await expect(updateReservation("r1", {})).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("stamps the caller as owner unless an owner was typed", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({}, { integration: null }));
    await updateReservation("r1", { notes: "n" }, { actor: "  bob " });
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data.owner).toBe("bob");
    await updateReservation("r1", { owner: "" }, { actor: "bob" });
    expect(stubbed(prisma.reservation.update).mock.calls[1][0].data.owner).toBe("");
    await updateReservation("r1", { notes: "n" });
    expect(stubbed(prisma.reservation.update).mock.calls[2][0].data.owner).toBeUndefined();
  });

  it("rejects a malformed MAC, and the zero MAC only as a change", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({}, { integration: null }));
    await expect(updateReservation("r1", { macAddress: "nonsense" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(updateReservation("r1", { macAddress: "00:00:00:00:00:00" })).rejects.toThrow(/not a device's MAC/);
    // A row already holding the zero MAC stays editable when the MAC comes back untouched.
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({ macAddress: "00:00:00:00:00:00" }, { integration: null }));
    await expect(updateReservation("r1", { macAddress: "00-00-00-00-00-00", notes: "x" })).resolves.toBeTruthy();
  });

  it("an unchanged MAC in another spelling is not a change and contacts no device", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row());
    await updateReservation("r1", { macAddress: "AA-BB-CC-DD-EE-01" });
    expect(push.updatePushedReservation).not.toHaveBeenCalled();
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data).not.toHaveProperty("macAddress");
  });

  it("on a non-push subnet a MAC may be cleared and is written without device contact", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({}, { integration: { id: "i", type: "fortigate", config: {} } }));
    await updateReservation("r1", { macAddress: "  " });
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data.macAddress).toBeNull();
    expect(push.updatePushedReservation).not.toHaveBeenCalled();
  });

  it("on a pushing subnet a MAC change is written to the FortiGate first, then stored synced", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row());
    push.updatePushedReservation.mockResolvedValue({ scopeId: 4, entryId: 9 });
    await updateReservation("r1", { macAddress: "AA:BB:CC:DD:EE:02" }, { actor: "bob" });
    expect(push.updatePushedReservation).toHaveBeenCalledWith(expect.objectContaining({
      reservationId: "r1", ip: "10.0.0.5", newMac: "aa:bb:cc:dd:ee:02", scopeId: 3, entryId: 7, deviceName: "FGT-HQ",
    }));
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data).toMatchObject({
      macAddress: "aa:bb:cc:dd:ee:02", pushedToId: "int1", pushedScopeId: 4, pushedEntryId: 9, pushStatus: "synced", pushError: null,
    });
    expect(actions()).toEqual(["reservation.push.updated", "reservation.updated"]);
  });

  it("a device failure aborts the whole update — Polaris never drifts from the gate", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row());
    push.updatePushedReservation.mockRejectedValue(new AppError(502, "gate unreachable"));
    await expect(updateReservation("r1", { macAddress: "aa:bb:cc:dd:ee:02" })).rejects.toThrow("gate unreachable");
    expect(prisma.reservation.update).not.toHaveBeenCalled();
    expect(actions()).toEqual(["reservation.push.update_failed"]);
  });

  it("refuses to clear the MAC on a pushing subnet, synced or queued", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row());
    await expect(updateReservation("r1", { macAddress: "" })).rejects.toThrow(/require a MAC/);
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({ pushStatus: "pending" }));
    await expect(updateReservation("r1", { macAddress: "" })).rejects.toThrow(/queued push-eligible/);
  });

  it("a queued row's MAC change is just stashed for the retry tick", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({ pushStatus: "pending" }));
    await updateReservation("r1", { macAddress: "aa:bb:cc:dd:ee:03" });
    expect(push.updatePushedReservation).not.toHaveBeenCalled();
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data.macAddress).toBe("aa:bb:cc:dd:ee:03");
  });

  it("an IPv6 row is never pushed (rule 125)", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({ ipAddress: "2001:db8::5" }));
    await updateReservation("r1", { macAddress: "aa:bb:cc:dd:ee:04" });
    expect(push.updatePushedReservation).not.toHaveBeenCalled();
  });

  it("holds notes to the FortiGate's description budget when the edit touches them (rule 74)", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row());
    await expect(updateReservation("r1", { notes: "x".repeat(300) })).rejects.toMatchObject({ httpStatus: 400 });
    // An over-long note written before the rule must not strand the row: an
    // edit that does not touch notes or hostname is not judged.
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({ notes: "y".repeat(300) }));
    await expect(updateReservation("r1", { projectRef: "P-1" })).resolves.toBeTruthy();
  });

  it("audits the change set", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(row({}, { integration: null }));
    stubbed(prisma.reservation.update).mockResolvedValue({ ...row(), hostname: "printer-2" });
    await updateReservation("r1", { hostname: "printer-2" }, { actor: "bob" });
    const ev = eventLog.logEvent.mock.calls.at(-1)![0];
    expect(ev).toMatchObject({ action: "reservation.updated", actor: "bob", resourceName: "printer-2" });
    expect(JSON.stringify(ev.details)).toContain("printer-2");
  });
});

// ─── push queue counts ──────────────────────────────────────────────────────

describe("countPushQueueByState", () => {
  it("totals both states and counts only failed_permanent as failed", async () => {
    stubbed(prisma.reservation.groupBy).mockResolvedValue([
      { pushStatus: "pending", _count: { _all: 4 } },
      { pushStatus: "failed_permanent", _count: { _all: 2 } },
    ]);
    expect(await countPushQueueByState()).toEqual({ count: 6, failed: 2 });
  });

  it("is zero on an empty queue", async () => {
    stubbed(prisma.reservation.groupBy).mockResolvedValue([]);
    expect(await countPushQueueByState()).toEqual({ count: 0, failed: 0 });
  });
});

// ─── queued push retry ──────────────────────────────────────────────────────

function queued(over: Record<string, unknown> = {}, subnetOver: Record<string, unknown> = {}, integOver: Record<string, unknown> | null = {}) {
  return {
    id: "q1",
    subnetId: "s1",
    status: "active",
    ipAddress: "10.0.0.9",
    hostname: "cam",
    notes: null,
    createdBy: "alice",
    macAddress: "aa:bb:cc:00:00:09",
    pushStatus: "pending",
    pushQueuedAt: new Date(NOW.getTime() - 3_600_000),
    pushAttempts: 0,
    pushLastAttemptAt: null,
    pushError: null,
    subnet: {
      cidr: "10.0.0.0/24",
      status: "available",
      fortigateDevice: "FGT-HQ",
      discoveredBy: "int1",
      integration: integOver === null ? null : { id: "int1", type: "fortigate", enabled: true, config: { pushReservations: true }, ...integOver },
      ...subnetOver,
    },
    ...over,
  };
}

describe("retryPendingReservations", () => {
  beforeEach(() => {
    stubbed(prisma.reservation.findFirst).mockResolvedValue(null);
    stubbed(prisma.asset.findFirst).mockResolvedValue({ monitored: true, monitorStatus: "up" });
  });

  it("pushes a ready row and promotes it to a synced dhcp_reservation", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([queued()]);
    push.pushReservation.mockResolvedValue({ scopeId: 2, entryId: 11 });
    const r = await retryPendingReservations();
    expect(r).toMatchObject({ attempted: 1, succeeded: 1 });
    const updates = stubbed(prisma.reservation.update).mock.calls.map((c) => c[0].data);
    expect(updates[0]).toMatchObject({ pushAttempts: { increment: 1 } });
    expect(updates[1]).toMatchObject({
      sourceType: "dhcp_reservation", pushStatus: "synced", pushedToId: "int1", pushedScopeId: 2, pushedEntryId: 11,
      pushQueuedAt: null, pushAttempts: 0,
    });
    expect(actions()).toEqual(["reservation.push.queued.succeeded"]);
  });

  it.each([
    ["subnet_deprecated", queued({}, { status: "deprecated" })],
    ["subnet_no_fortigateDevice", queued({}, { fortigateDevice: null })],
    ["reservation_no_mac", queued({ macAddress: null })],
    ["integration_deleted", queued({}, {}, null)],
    ["integration_disabled", queued({}, {}, { enabled: false })],
    ["integration_type_vcenter_not_pushable", queued({}, {}, { type: "vcenter" })],
    ["pushReservations_disabled", queued({}, {}, { config: {} })],
  ])("cancels the queued push when %s, keeping the row as manual", async (reason, r) => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([r]);
    const out = await retryPendingReservations();
    expect(out).toMatchObject({ attempted: 1, cancelled: 1 });
    expect(push.pushReservation).not.toHaveBeenCalled();
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data).toMatchObject({ pushStatus: null, pushedToId: null });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "reservation.push.queued.cancelled", details: { reason } });
  });

  it("a row discovery landed at the same IP supersedes the queue — failed_permanent, never pushed", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([queued()]);
    stubbed(prisma.reservation.findFirst).mockResolvedValue({ id: "d1", sourceType: "dhcp_reservation", macAddress: "11:22:33:44:55:66" });
    const r = await retryPendingReservations();
    expect(r.superseded).toBe(1);
    expect(push.pushReservation).not.toHaveBeenCalled();
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data).toMatchObject({
      pushStatus: "failed_permanent", pushError: "IP collided during queue — discovered dhcp_reservation by 11:22:33:44:55:66",
    });
  });

  it("waits while the monitored gate is not up — but a passive gate is no evidence and is pushed", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([queued()]);
    stubbed(prisma.asset.findFirst).mockResolvedValue({ monitored: true, monitorStatus: "down" });
    expect((await retryPendingReservations()).skippedMonitoredDown).toBe(1);
    expect(push.pushReservation).not.toHaveBeenCalled();

    stubbed(prisma.asset.findFirst).mockResolvedValue({ monitored: true, monitorStatus: "passive" });
    push.pushReservation.mockResolvedValue({ scopeId: 1, entryId: 1 });
    expect((await retryPendingReservations()).succeeded).toBe(1);
  });

  it("an unmonitored gate backs off exponentially on the attempt count", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue(null);
    // 2 attempts → 120 s window; last try 100 s ago → skip.
    stubbed(prisma.reservation.findMany).mockResolvedValue([queued({ pushAttempts: 2, pushLastAttemptAt: new Date(NOW.getTime() - 100_000) })]);
    expect((await retryPendingReservations()).skippedBackoff).toBe(1);
    // 130 s ago → outside the window → attempt.
    stubbed(prisma.reservation.findMany).mockResolvedValue([queued({ pushAttempts: 2, pushLastAttemptAt: new Date(NOW.getTime() - 130_000) })]);
    push.pushReservation.mockResolvedValue({ scopeId: 1, entryId: 1 });
    expect((await retryPendingReservations()).succeeded).toBe(1);
  });

  it("the backoff is capped at 30 minutes however many attempts", async () => {
    stubbed(prisma.asset.findFirst).mockResolvedValue({ monitored: false, monitorStatus: null });
    stubbed(prisma.reservation.findMany).mockResolvedValue([queued({ pushAttempts: 40, pushLastAttemptAt: new Date(NOW.getTime() - 1_801_000) })]);
    push.pushReservation.mockResolvedValue({ scopeId: 1, entryId: 1 });
    expect((await retryPendingReservations()).succeeded).toBe(1);
  });

  it("a transient error keeps the row queued; a permanent one parks it for the operator", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([queued(), queued({ id: "q2" })]);
    push.pushReservation
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockRejectedValueOnce(new AppError(409, "entry exists"));
    const r = await retryPendingReservations();
    expect(r).toMatchObject({ attempted: 2, transient: 1, permanent: 1 });
    const datas = stubbed(prisma.reservation.update).mock.calls.map((c) => c[0].data);
    expect(datas).toContainEqual({ pushError: "ETIMEDOUT" });
    expect(datas).toContainEqual({ pushStatus: "failed_permanent", pushError: "entry exists" });
    expect(actions()).toEqual(["reservation.push.queued.retry_failed", "reservation.push.queued.failed_permanent"]);
  });

  it("only scans active pending rows, oldest first", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([]);
    expect(await retryPendingReservations()).toMatchObject({ attempted: 0 });
    expect(stubbed(prisma.reservation.findMany).mock.calls[0][0]).toMatchObject({
      where: { pushStatus: "pending", status: "active" }, orderBy: { pushQueuedAt: "asc" },
    });
  });
});

describe("retryReservationNow", () => {
  beforeEach(() => {
    stubbed(prisma.reservation.findFirst).mockResolvedValue(null);
  });

  it("refuses a missing, inactive or unqueued row", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(null);
    await expect(retryReservationNow("x", "bob")).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.reservation.findUnique).mockResolvedValue(queued({ status: "released" }));
    await expect(retryReservationNow("q1", "bob")).rejects.toMatchObject({ httpStatus: 409 });
    stubbed(prisma.reservation.findUnique).mockResolvedValue(queued({ pushStatus: "synced" }));
    await expect(retryReservationNow("q1", "bob")).rejects.toThrow(/not queued \(pushStatus=synced\)/);
  });

  it("bypasses the down and backoff gates — the operator asked", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(queued({ pushAttempts: 5, pushLastAttemptAt: new Date(NOW) }));
    stubbed(prisma.asset.findFirst).mockResolvedValue({ monitored: true, monitorStatus: "down" });
    push.pushReservation.mockResolvedValue({ scopeId: 1, entryId: 2 });
    const r = await retryReservationNow("q1", "bob");
    expect(r.outcome).toBe("synced");
    expect(prisma.asset.findFirst).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls.map((c) => [c[0].action, c[0].actor])).toEqual([
      ["reservation.push.queued.retry_manual", "bob"],
      ["reservation.push.queued.succeeded", "bob"],
    ]);
  });

  it("re-queues a failed_permanent row before retrying it", async () => {
    stubbed(prisma.reservation.findUnique).mockResolvedValue(queued({ pushStatus: "failed_permanent", pushQueuedAt: null, pushError: "old" }));
    push.pushReservation.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await retryReservationNow("q1", null);
    expect(r.outcome).toBe("transient");
    expect(stubbed(prisma.reservation.update).mock.calls[0][0].data).toEqual({ pushStatus: "pending", pushQueuedAt: NOW, pushError: "old" });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("permanently-failed");
  });
});

describe("triggerRetryAfterStatusChange", () => {
  it("does nothing for anything that is not a discovered, named firewall", async () => {
    for (const a of [null, { assetType: "switch", hostname: "s", discoveredByIntegrationId: "i" }, { assetType: "firewall", hostname: null, discoveredByIntegrationId: "i" }, { assetType: "firewall", hostname: "f", discoveredByIntegrationId: null }]) {
      stubbed(prisma.asset.findUnique).mockResolvedValue(a);
      await triggerRetryAfterStatusChange("a1");
    }
    expect(prisma.reservation.count).not.toHaveBeenCalled();
  });

  it("counts the gate's pending rows and runs a retry tick only when there are some", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ assetType: "firewall", hostname: "FGT-HQ", discoveredByIntegrationId: "int1" });
    stubbed(prisma.reservation.count).mockResolvedValue(0);
    stubbed(prisma.reservation.findMany).mockResolvedValue([]);
    await triggerRetryAfterStatusChange("a1");
    expect(stubbed(prisma.reservation.count).mock.calls[0][0].where).toEqual({
      pushStatus: "pending", status: "active", subnet: { fortigateDevice: "FGT-HQ", discoveredBy: "int1" },
    });
    expect(prisma.reservation.findMany).not.toHaveBeenCalled();

    stubbed(prisma.reservation.count).mockResolvedValue(2);
    await triggerRetryAfterStatusChange("a1");
    await vi.waitFor(() => expect(prisma.reservation.findMany).toHaveBeenCalled());
  });
});

// ─── orphan reconcile ───────────────────────────────────────────────────────

describe("reconcileOrphanedInfraReservations", () => {
  const infra = (id: string, ip: string, pushedToId: string | null = null, discoveredBy = "int1") =>
    ({ id, ipAddress: ip, hostname: id, pushedToId, subnet: { discoveredBy } });

  it("is a no-op with no managed-device rows", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([]);
    expect(await reconcileOrphanedInfraReservations()).toEqual({ released: 0, deferred: 0, skipped: 0, failed: 0 });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("keeps rows a live device holds, skips pushed orphans, and releases the rest (same-integration matches only)", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([
      infra("live", "10.0.0.1"),
      infra("gone", "10.0.0.2"),
      infra("pushed", "10.0.0.3", "int1"),
      infra("decom", "10.0.0.4"),
      infra("otherGate", "10.0.0.5"),
    ]);
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "a1", ipAddress: "10.0.0.1", status: "active", discoveredByIntegrationId: "int1" },
      { id: "a4", ipAddress: "10.0.0.4", status: "decommissioned", discoveredByIntegrationId: "int1" },
      // Same RFC1918 address behind a different integration: not a match.
      { id: "a5", ipAddress: "10.0.0.5", status: "active", discoveredByIntegrationId: "int2" },
    ]);
    // releaseReservation is this module's own: let it fail at its lookup so
    // the test sees exactly which rows were sent to it.
    stubbed(prisma.reservation.findUnique).mockResolvedValue(null);
    const r = await reconcileOrphanedInfraReservations();
    expect(r).toEqual({ released: 0, deferred: 0, skipped: 1, failed: 3 });
    const sent = stubbed(prisma.reservation.findUnique).mock.calls.map((c) => c[0].where.id).sort();
    expect(sent).toEqual(["decom", "gone", "otherGate"]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "reservation.infra.released", level: "warning" });
  });

  it("releases at most `limit` per pass and defers the rest", async () => {
    stubbed(prisma.reservation.findMany).mockResolvedValue([infra("a", "10.0.0.1"), infra("b", "10.0.0.2"), infra("c", "10.0.0.3")]);
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    stubbed(prisma.reservation.findUnique).mockResolvedValue(null);
    const r = await reconcileOrphanedInfraReservations({ limit: 2 });
    expect(r).toMatchObject({ deferred: 1, failed: 2 });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("1 deferred to the next pass");
  });
});

// ─── next available ─────────────────────────────────────────────────────────

describe("nextAvailableReservation", () => {
  it("404s a missing subnet before creating anything", async () => {
    stubbed(prisma.subnet.findUnique).mockResolvedValue(null);
    await expect(nextAvailableReservation({ subnetId: "s" })).rejects.toMatchObject({ httpStatus: 404 });
    expect(prisma.reservation.create).not.toHaveBeenCalled();
  });

  it("409s a full subnet with the single-address wording", async () => {
    stubbed(prisma.subnet.findUnique).mockResolvedValue({ id: "s", cidr: "10.9.9.0/30", status: "available" });
    stubbed(prisma.reservation.findMany).mockResolvedValue([{ ipAddress: "10.9.9.1" }, { ipAddress: "10.9.9.2" }]);
    await expect(nextAvailableReservation({ subnetId: "s" })).rejects.toThrow("No available IP addresses in subnet 10.9.9.0/30");
  });
});
