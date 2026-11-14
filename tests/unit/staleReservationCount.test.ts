/**
 * tests/unit/staleReservationCount.test.ts — the badge count behind
 * GET /reservations/alerts/count is evaluated once per 30 s for every caller
 * (efficiency audit group 2), and the operator's own changes drop the memo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => undefined) }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";

type Svc = typeof import("../../src/services/reservationStaleService.js");
let svc: Svc;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
  resetDbStub();
  vi.mocked(prisma.setting.findUnique).mockImplementation((async (args: { where: { key: string } }) =>
    args.where.key.includes("Started")
      ? { value: { startedAt: "2026-01-01T00:00:00Z" } }
      : { value: { staleAfterDays: 30 } }) as never);
  vi.mocked(prisma.reservation.findMany).mockResolvedValue([] as never);
  vi.resetModules();
  svc = await import("../../src/services/reservationStaleService.js");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("countStaleReservations", () => {
  it("serves every caller inside 30 s from one evaluation, concurrent ones included", async () => {
    const [a, b] = await Promise.all([svc.countStaleReservations(), svc.countStaleReservations()]);
    expect(a).toBe(0);
    expect(b).toBe(0);
    await svc.countStaleReservations();
    expect(prisma.reservation.findMany).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await svc.countStaleReservations();
    expect(prisma.reservation.findMany).toHaveBeenCalledTimes(2);
  });

  it("an operator change drops the memo; a failed evaluation is not remembered", async () => {
    await svc.countStaleReservations();
    svc.invalidateStaleReservationCount();
    await svc.countStaleReservations();
    expect(prisma.reservation.findMany).toHaveBeenCalledTimes(2);

    svc.invalidateStaleReservationCount();
    vi.mocked(prisma.reservation.findMany).mockRejectedValueOnce(new Error("db down"));
    await expect(svc.countStaleReservations()).rejects.toThrow("db down");
    await expect(svc.countStaleReservations()).resolves.toBe(0);
    expect(prisma.reservation.findMany).toHaveBeenCalledTimes(4);
  });

  it("changing the threshold drops the memo", async () => {
    await svc.countStaleReservations();
    await svc.updateStaleSettings({ staleAfterDays: 14 }, "alice");
    await svc.countStaleReservations();
    expect(prisma.reservation.findMany).toHaveBeenCalledTimes(2);
  });
});
