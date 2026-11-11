/**
 * src/api/routes/assets/shared.ts — Helpers more than one assets sub-router needs: the associated-IP shape, the monitored-state
 * clamp, the write-time quarantine / integration-token guards. The credential-assignment
 * guard moved to credentialService and the current-state interval to monitoring/monitorSettings
 * (CQ-B062 slice 2). Split out of routes/assets.ts (CQ-B062).
 */

import { type Request } from "express";
import { AppError } from "../../../utils/errors.js";
import { hasPermission } from "../../middleware/permissions.js";
import { assertIpChangeMayRetargetIntegrationToken as assertIpChangeMayRetargetIntegrationTokenUtil } from "../../../utils/integrationTokenTarget.js";

// ─── associatedIps shape helper ──────────────────────────────────────────────
//
// `Asset.associatedIps` was a JSONB column until the side-table migration; the
// frontend (`public/js/assets.js`) and any external API consumer still expect
// the response to carry an `associatedIps: [...]` JSON array on the asset
// object. Rather than change the wire format, every place that reads asset
// rows + their `associatedIpRows` relation runs the rows through this helper
// to project them back into the original JSON shape.

interface AssociatedIpJson {
  ip: string;
  source: string;
  interfaceName?: string;
  mac?: string;
  /** Interface-scrape rows where the device says: "primary" | "secondary". */
  interfaceRole?: string;
  /** Discovered rows: the gate that reported the binding, and its medium (rule 102). */
  device?: string;
  medium?: string;
  ptrName?: string;
  ptrTtl?: number;
  ptrFetchedAt?: string;
  lastSeen?: string;
  firstSeen?: string;
}

interface AssociatedIpRow {
  ip: string;
  source: string;
  interfaceName: string | null;
  mac: string | null;
  interfaceRole: string | null;
  device: string | null;
  medium: string | null;
  ptrName: string | null;
  ptrTtl: number | null;
  ptrFetchedAt: Date | null;
  lastSeen: Date;
  firstSeen: Date;
}

export function shapeAssociatedIps(rows: AssociatedIpRow[] | null | undefined): AssociatedIpJson[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const out: AssociatedIpJson = { ip: r.ip, source: r.source };
    if (r.interfaceName) out.interfaceName = r.interfaceName;
    if (r.mac)           out.mac           = r.mac;
    if (r.interfaceRole) out.interfaceRole = r.interfaceRole;
    if (r.device)       out.device        = r.device;
    if (r.medium)        out.medium        = r.medium;
    if (r.ptrName)       out.ptrName       = r.ptrName;
    if (r.ptrTtl != null) out.ptrTtl       = r.ptrTtl;
    if (r.ptrFetchedAt)   out.ptrFetchedAt = r.ptrFetchedAt.toISOString();
    out.lastSeen  = r.lastSeen.toISOString();
    out.firstSeen = r.firstSeen.toISOString();
    return out;
  });
}

export const ASSOCIATED_IP_SELECT = {
  ip: true, source: true, interfaceName: true, mac: true, interfaceRole: true, device: true, medium: true,
  ptrName: true, ptrTtl: true, ptrFetchedAt: true,
  lastSeen: true, firstSeen: true,
} as const;

/**
 * Apply Asset.monitored side-effects on save. The polling-method resolver is
 * the source of truth for HOW the asset gets probed — we don't re-validate
 * polling/credential consistency at write-time; the dispatcher reports
 * errors clearly when a missing credential surfaces during a probe.
 */
export function clampMonitoredState(data: Record<string, unknown>): void {
  const monitored = data.monitored === undefined ? undefined : Boolean(data.monitored);
  if (monitored === false) {
    data.consecutiveFailures = 0;
  } else if (monitored === true) {
    // Reset probe state so the pill always starts at Recovering on re-enable
    // rather than carrying over stale Down/Missed from the previous session.
    data.monitorStatus = "recovering";
    data.consecutiveFailures = 0;
    data.consecutiveSuccesses = 0;
  }
}

/**
 * Quarantine status is owned by the quarantine endpoints (assetsQuarantine):
 * setting it anywhere else skips the FortiGate push, and discovery's
 * auto-quarantine pass then pushes a REAL quarantine for any sighted asset
 * whose status says "quarantined". `PUT /assets/:id` has always refused it;
 * create and the PDF import did not (re-scan F61). `current` is null for a
 * create. Throws 400.
 */
export function assertQuarantineStatusUntouched(next: unknown, current: string | null): void {
  if (next === undefined || next === null || next === "") return;
  if (next === "quarantined" && current !== "quarantined") {
    throw new AppError(400, "Quarantine an asset with POST /assets/:id/quarantine (Quarantine permission), not by setting its status");
  }
  if (next !== "quarantined" && current === "quarantined") {
    throw new AppError(400, "Release the quarantine with DELETE /assets/:id/quarantine before changing this asset's status");
  }
}

/** Rule 111(c) — see utils/integrationTokenTarget.ts. */
export function assertIpChangeMayRetargetIntegrationToken(
  req: Request,
  existing: { ipAddress: string | null; discoveredByIntegration?: { type: string } | null },
  nextIp: string | null | undefined,
): void {
  assertIpChangeMayRetargetIntegrationTokenUtil(hasPermission(req, "integrations", "write"), existing, nextIp);
}
