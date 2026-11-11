/**
 * tests/unit/userBookingService.test.ts — business rule 140(b): the pending
 * reboots and firmware upgrades an account has booked, as the Disable / Delete
 * dialogs list them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const seen: Record<string, any> = {};
const rows: Record<string, any[]> = { reboot: [], firmware: [], group: [] };

function table(key: string) {
  return { findMany: vi.fn(async (args: any) => { seen[key] = args; return rows[key]; }) };
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    rebootSchedule: table("reboot"),
    firmwareUpgradeSchedule: table("firmware"),
    firmwareGroupSchedule: table("group"),
  },
}));

import { listPendingBookingsBy, PENDING_BOOKING_LIMIT } from "../../src/services/userBookingService.js";

const asset = (id: string, over: Record<string, unknown> = {}) => ({ id, hostname: `host-${id}`, ipAddress: "10.0.0.1", createdBy: "someone", tags: ["region:East"], ...over });

beforeEach(() => {
  rows.reboot = [];
  rows.firmware = [];
  rows.group = [];
});

describe("listPendingBookingsBy", () => {
  it("asks only for PENDING bookings stamped with that username, bounded", async () => {
    await listPendingBookingsBy("bob");
    for (const key of ["reboot", "firmware", "group"]) {
      expect(seen[key].where).toEqual({ createdBy: "bob", status: "pending" });
      expect(seen[key].take).toBe(PENDING_BOOKING_LIMIT);
    }
  });

  it("merges the three kinds soonest first, with what each is about", async () => {
    rows.reboot = [{ id: "rb", scheduledFor: new Date("2026-11-16T00:00:00Z"), note: "  kernel patch  ", asset: asset("a1") }];
    rows.firmware = [{ id: "fw", scheduledFor: new Date("2026-11-14T00:00:00Z"), toVersion: "7.6.8", asset: asset("a2") }];
    rows.group = [{ id: "gr", scheduledFor: new Date("2026-11-15T00:00:00Z"), createdBy: "bob", gate: asset("a3"), _count: { members: 12 } }];

    const out = await listPendingBookingsBy("bob");

    expect(out.map((b) => [b.kind, b.id, b.assetName, b.detail])).toEqual([
      ["firmware", "fw", "host-a2", "to 7.6.8"],
      ["firmwareGroup", "gr", "host-a3", "12 devices"],
      ["reboot", "rb", "host-a1", "kernel patch"],
    ]);
  });

  it("judges a reboot or firmware booking on its DEVICE and a group on the booking itself", async () => {
    rows.reboot = [{ id: "rb", scheduledFor: new Date(), note: null, asset: asset("a1", { createdBy: "carol", tags: ["region:West"] }) }];
    rows.group = [{ id: "gr", scheduledFor: new Date(), createdBy: "bob", gate: asset("a3"), _count: { members: 1 } }];

    const out = await listPendingBookingsBy("bob");
    const by = Object.fromEntries(out.map((b) => [b.kind, b]));

    expect(by.reboot.scope).toEqual({ createdBy: "carol", tags: ["region:West"] });
    // A group has no tags of its own (rule 141(e)): its creator, or Full Read-Write.
    expect(by.firmwareGroup.scope).toEqual({ createdBy: "bob", tags: [] });
    expect(by.firmwareGroup.detail).toBe("1 device");
    expect(by.reboot.detail).toBe("");
  });

  it("names a device with no hostname by its address, then its id", async () => {
    rows.reboot = [
      { id: "r1", scheduledFor: new Date(1), note: null, asset: asset("a1", { hostname: null }) },
      { id: "r2", scheduledFor: new Date(2), note: null, asset: asset("a2", { hostname: null, ipAddress: null }) },
    ];
    expect((await listPendingBookingsBy("bob")).map((b) => b.assetName)).toEqual(["10.0.0.1", "a2"]);
  });
});
