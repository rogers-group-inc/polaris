/**
 * src/api/routes/reservations.ts
 *
 * Authorization:
 *   - admin / networkadmin: full CRUD on all reservations
 *   - user / assetsadmin: can create reservations and edit/delete only their own (createdBy match)
 *   - readonly: read-only
 *
 * Note on the IP-panel "Reserve" take-over of a DHCP lease: a dhcp_lease is
 * observed device presence, not a user-owned reservation, so claiming the IP
 * is a plain create — `reservationService.createReservation` supersedes the
 * lease server-side (releaseSupersededDhcpLeaseAt). It does NOT route through
 * the ownership-gated release below, so a `write`-level user with no claim on
 * the lease can still reserve the IP.
 */

import { Router } from "express";
import { z } from "zod";
import * as reservationService from "../../services/reservationService.js";
import * as staleService from "../../services/reservationStaleService.js";
import { AppError } from "../../utils/errors.js";
import { requirePermission, requireOwnership, assertOwnership } from "../middleware/permissions.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

// Accepts the standard 48-bit MAC formats: bare hex, colon/dash pairs, or
// Cisco dotted quads. Shared by every MAC field in this file.
const MAC_FORMAT_RE = /^[0-9a-f]{12}$|^([0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$|^([0-9a-f]{4}\.){2}[0-9a-f]{4}$/i;
const MAC_FORMAT_MSG = "MAC address must be 12 hex chars (with optional :, -, or . separators)";

const MacAddressSchema = z
  .string()
  .min(1)
  .refine((s) => MAC_FORMAT_RE.test(s), MAC_FORMAT_MSG)
  .optional();

const CreateReservationSchema = z.object({
  subnetId: z.string().uuid(),
  ipAddress: z.string().optional(),
  hostname: z.string().min(1, "Hostname is required"),
  owner: z.string().optional(),
  projectRef: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  macAddress: MacAddressSchema,
});

// Preview-only: which addresses WOULD be allocated. Creates nothing, so it is
// gated at `reservations:read` (the IP panel already shows every free address
// to that level) rather than the ownership gate the create below carries.
const NextAvailablePreviewSchema = z.object({
  subnetId: z.string().uuid(),
  count: z.number().int().min(1).max(reservationService.MAX_BULK_ALLOCATE),
  contiguous: z.boolean().optional().default(false),
});

const NextAvailableSchema = z.object({
  subnetId: z.string().uuid(),
  hostname: z.string().min(1, "Hostname is required"),
  owner: z.string().optional(),
  projectRef: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  macAddress: MacAddressSchema,
});

const UpdateReservationSchema = z.object({
  hostname: z.string().optional(),
  owner: z.string().min(1, "Owner is required").optional(),
  projectRef: z.string().min(1, "Project reference is required").optional(),
  expiresAt: z.coerce.date().optional(),
  notes: z.string().optional(),
  // Empty string clears the MAC (only allowed when the subnet is not
  // push-eligible — service layer enforces). A non-empty value must match
  // the standard 48-bit MAC formats.
  macAddress: z
    .string()
    .refine((s) => s === "" || MAC_FORMAT_RE.test(s), MAC_FORMAT_MSG)
    .optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// ─── Stale-reservation alerts (must come before /:id) ──────────────────────
//
// Settings are admin-only writes; reads are open to any authenticated user
// so the Events page can render the badge count for everyone.

const StaleSettingsSchema = z.object({
  staleAfterDays: z.number().int().min(0).max(3650),
});

router.get("/stale-settings", requirePermission("staleReservations", "read"), async (_req, res, next) => {
  try {
    res.json(await staleService.getStaleSettings());
  } catch (err) { next(err); }
});

router.put("/stale-settings", requirePermission("staleReservations", "write"), async (req, res, next) => {
  try {
    const input = StaleSettingsSchema.parse(req.body);
    const updated = await staleService.updateStaleSettings(input, req.session?.username);
    res.json(updated);
  } catch (err) { next(err); }
});

router.get("/alerts", requirePermission("staleReservations", "read"), async (req, res, next) => {
  try {
    const show = req.query.show === "ignored" ? "ignored" : "active";
    const alerts = await staleService.listStaleReservations(show);
    res.json({ alerts, total: alerts.length, show });
  } catch (err) { next(err); }
});

// Badge count is always the active list — ignored rows are silenced by the
// operator and shouldn't drive a sidebar badge.
router.get("/alerts/count", requirePermission("staleReservations", "read"), async (_req, res, next) => {
  try {
    const alerts = await staleService.listStaleReservations("active");
    res.json({ count: alerts.length });
  } catch (err) { next(err); }
});

// Snooze a stale-reservation alert by `staleAfterDays` more days. Sets
// staleSnoozedUntil = now + staleAfterDays so the row is suppressed from the
// alert list and the job won't re-fire until the snooze expires (or until
// discovery sees the IP active again, which clears the snooze automatically).
// Open to any user-or-above so operators can quiet noise without admin escalation.
router.post("/:id/snooze", requirePermission("staleReservations", "write"), async (req, res, next) => {
  try {
    const result = await staleService.snoozeReservation(req.params.id as string, req.session?.username);
    res.json(result);
  } catch (err) { next(err); }
});

// Permanently ignore a stale-reservation alert (admin / network-admin). The
// row is suppressed from the active alert list and the job won't ever
// re-fire on it, even if it later goes online and offline again — operator's
// intent is durable. Reachable via the admin filter view in the Alerts panel.
router.post("/:id/stale-ignore", requirePermission("staleReservations", "write"), async (req, res, next) => {
  try {
    const result = await staleService.setStaleIgnored(req.params.id as string, true, req.session?.username);
    res.json(result);
  } catch (err) { next(err); }
});

router.delete("/:id/stale-ignore", requirePermission("staleReservations", "write"), async (req, res, next) => {
  try {
    const result = await staleService.setStaleIgnored(req.params.id as string, false, req.session?.username);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /reservations/push-queue  (must come before /:id)
// Lists every reservation in the queued-push state — either still waiting on
// a transient FortiGate / FMG recovery (pushStatus="pending") or permanently
// stuck after a 4xx / verify-mismatch / collision (pushStatus="failed_permanent").
// Drives the global queue view page under Reservations alerts. Open to any
// auth role with `reservations:read` so operators can see what Polaris owes
// the network even when they can't act on it themselves.
router.get("/push-queue", requirePermission("reservations", "read"), async (_req, res, next) => {
  try {
    const rows = await reservationService.listPushQueue();
    res.json({ reservations: rows, count: rows.length });
  } catch (err) { next(err); }
});

router.get("/push-queue/count", requirePermission("reservations", "read"), async (_req, res, next) => {
  try {
    const count = await reservationService.countPushQueue();
    res.json({ count });
  } catch (err) { next(err); }
});

// POST /reservations/:id/retry-push — operator-triggered single-row retry of
// a queued push. Bypasses the monitored-gate gate and the unmonitored backoff
// window. Allowed for `pushStatus IN ("pending", "failed_permanent")` so an
// operator can recover a permanently-failed row after fixing whatever the
// permanent error called out. Uses requireOwnership so a `user` role can
// retry their own queued rows and an admin (fullwrite) can retry anyone's.
router.post("/:id/retry-push", requireOwnership("reservations"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const before = await reservationService.getReservation(id);
    assertOwnership(req, before.createdBy, "retry reservations");
    const { outcome, reservation } = await reservationService.retryReservationNow(id, req.session?.username ?? null);
    res.json({ outcome, reservation });
  } catch (err) { next(err); }
});

// POST /reservations/next-available/preview  (must come before /:id)
// Backs the Auto-Allocate modal's multiple-IP mode: the operator picks a count
// and whether the run must be contiguous, and the table is filled from this
// before anything is written. Each row is then created through POST / below,
// one request per address, so a long allocation reports per-row progress and
// per-row failures instead of riding one request that can outlive the proxy's
// read timeout while it pushes to a FortiGate.
router.post("/next-available/preview", requirePermission("reservations", "read"), async (req, res, next) => {
  try {
    const { subnetId, count, contiguous } = NextAvailablePreviewSchema.parse(req.body);
    const ips = await reservationService.findNextAvailableIps(subnetId, count, contiguous);
    res.json({ ips, count: ips.length, contiguous });
  } catch (err) {
    next(err);
  }
});

// POST /reservations/next-available  (must come before /:id)
router.post("/next-available", requireOwnership("reservations"), async (req, res, next) => {
  try {
    const input = NextAvailableSchema.parse(req.body);
    const reservation = await reservationService.nextAvailableReservation({
      ...input,
      createdBy: req.session?.username,
    });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

router.get("/", requirePermission("reservations", "read"), async (req, res, next) => {
  try {
    const { subnetId, owner, projectRef, status } = req.query as Record<string, string>;
    const limit = parseInt(req.query.limit as string, 10) || undefined;
    const offset = parseInt(req.query.offset as string, 10) || undefined;
    res.json(await reservationService.listReservations({
      subnetId,
      owner,
      projectRef,
      status: status as any,
      limit,
      offset,
    }));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requirePermission("reservations", "read"), async (req, res, next) => {
  try {
    res.json(await reservationService.getReservation(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireOwnership("reservations"), async (req, res, next) => {
  try {
    const input = CreateReservationSchema.parse(req.body);
    const reservation = await reservationService.createReservation({
      ...input,
      createdBy: req.session?.username,
    });
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});

// Addresses owned by the DEVICE's own configuration rather than by anything
// Polaris granted: a FortiGate virtual IP, and a statically-configured router /
// firewall interface address. Polaris discovers and reports them; every way of
// changing one lives on the device. This closes the edit and release verbs.
// Enforced at the ROUTE layer rather than in the service, because discovery's
// own reconcile still has to be able to refresh and retire these rows.
// CREATE is deliberately not one of them: business rule 77 admitted `vip` into
// `isSupersedableByCreate`, so a create over a VIP succeeds and carries the VIP
// snapshot onto the operator's row. `interface_ip` is still absent from that
// set, so the collision check 409s a create over one.
// The set itself now lives in reservationService (a second consumer arrived
// with business rule 41's chassis-replacement diff, which must not offer to
// migrate a device-owned line onto the new gate). The route keeps the
// route-layer ENFORCEMENT for the reason above.
function assertNotDeviceOwned(
  reservation: { sourceType: string; ipAddress: string | null },
  verb: string,
): void {
  if (!reservationService.isDeviceOwnedRow(reservation)) return;
  const what = reservation.sourceType === "vip" ? "a FortiGate VIP" : "a device interface address";
  throw new AppError(
    409,
    `${reservation.ipAddress ?? "This address"} is ${what} — it is configured on the device, so it cannot be ${verb} from Polaris`,
  );
}

router.put("/:id", requireOwnership("reservations"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const before = await reservationService.getReservation(id);
    assertNotDeviceOwned(before, "edited");
    assertOwnership(req, before.createdBy, "edit reservations");
    const input = UpdateReservationSchema.parse(req.body);
    const reservation = await reservationService.updateReservation(id, input, {
      actor: req.session?.username ?? null,
    });
    res.json(reservation);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireOwnership("reservations"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await reservationService.getReservation(id);
    assertNotDeviceOwned(existing, "released");
    if (req.permissionLevel !== "fullwrite") {
      assertOwnership(req, existing.createdBy, "release reservations");
    }
    await reservationService.releaseReservation(id, req.session?.username);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
