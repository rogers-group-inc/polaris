/**
 * src/services/userBookingService.ts — the work an account has booked that has
 * not happened yet: pending reboots, firmware upgrades and group firmware
 * upgrades stamped with its username (business rule 140(b)).
 *
 * A booking is approved when it is made and judged, at fire time, against the
 * device — never against the person (rule 93). So a booking outlives the
 * account that made it: it fires on schedule after its creator is disabled or
 * deleted. That is deliberate (a planned change window must not vanish because
 * someone left), but it must not be INVISIBLE. This read is what the Disable
 * and Delete dialogs show, so the administrator decides, booking by booking,
 * whether the departing person's planned work still stands.
 *
 * It only reads. Cancelling goes through each booking's own cancel route, with
 * that route's own gate (`assets:write` + the write scope), so this surface can
 * never cancel something its caller could not cancel from the device's card.
 */

import { prisma } from "../db.js";

type PendingBookingKind = "reboot" | "firmware" | "firmwareGroup";

export interface PendingBooking {
  kind: PendingBookingKind;
  id: string;
  /** The device — for a group, its controlling FortiGate. */
  assetId: string;
  assetName: string;
  scheduledFor: Date;
  /** "to 7.6.8", "12 devices", or a reboot's reason. Empty when there is none. */
  detail: string;
  /** What the write scope judges: the DEVICE for a reboot / firmware booking,
   *  the booking itself for a group (rule 141(e) — a group has no tags). */
  scope: { createdBy: string | null; tags: string[] };
}

/** Enough to tell the administrator the list is not the whole of it. */
export const PENDING_BOOKING_LIMIT = 200;

const ASSET_SELECT = { id: true, hostname: true, ipAddress: true, createdBy: true, tags: true } as const;

function nameOf(a: { id: string; hostname: string | null; ipAddress: string | null }): string {
  return a.hostname || a.ipAddress || a.id;
}

/**
 * Every pending booking stamped with `username`, soonest first, capped at
 * `PENDING_BOOKING_LIMIT` per kind. A group that is already `running` is not
 * listed: stopping a live group is the nav bar's verb (rule 138), not a
 * checkbox in an account dialog. Bookings an automation made
 * (`createdBy = "automation:…"`) are nobody's and never match.
 */
export async function listPendingBookingsBy(username: string): Promise<PendingBooking[]> {
  const where = { createdBy: username, status: "pending" } as const;
  const order = { scheduledFor: "asc" } as const;
  const [reboots, firmware, groups] = await Promise.all([
    prisma.rebootSchedule.findMany({
      where, orderBy: order, take: PENDING_BOOKING_LIMIT,
      select: { id: true, scheduledFor: true, note: true, asset: { select: ASSET_SELECT } },
    }),
    prisma.firmwareUpgradeSchedule.findMany({
      where, orderBy: order, take: PENDING_BOOKING_LIMIT,
      select: { id: true, scheduledFor: true, toVersion: true, asset: { select: ASSET_SELECT } },
    }),
    prisma.firmwareGroupSchedule.findMany({
      where, orderBy: order, take: PENDING_BOOKING_LIMIT,
      select: { id: true, scheduledFor: true, createdBy: true, gate: { select: ASSET_SELECT }, _count: { select: { members: true } } },
    }),
  ]);

  const out: PendingBooking[] = [
    ...reboots.map((r): PendingBooking => ({
      kind: "reboot", id: r.id, assetId: r.asset.id, assetName: nameOf(r.asset), scheduledFor: r.scheduledFor,
      detail: (r.note ?? "").trim().slice(0, 120),
      scope: { createdBy: r.asset.createdBy, tags: r.asset.tags },
    })),
    ...firmware.map((f): PendingBooking => ({
      kind: "firmware", id: f.id, assetId: f.asset.id, assetName: nameOf(f.asset), scheduledFor: f.scheduledFor,
      detail: `to ${f.toVersion}`,
      scope: { createdBy: f.asset.createdBy, tags: f.asset.tags },
    })),
    ...groups.map((g): PendingBooking => ({
      kind: "firmwareGroup", id: g.id, assetId: g.gate.id, assetName: nameOf(g.gate), scheduledFor: g.scheduledFor,
      detail: `${g._count.members} device${g._count.members === 1 ? "" : "s"}`,
      scope: { createdBy: g.createdBy, tags: [] },
    })),
  ];
  out.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  return out;
}
