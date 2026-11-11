/**
 * src/api/routes/assets/shared.ts — The write-time guards more than one assets
 * sub-router needs: quarantine status and the integration-token retarget.
 * Split out of routes/assets.ts (CQ-B062). Slice 2 moved the rest out of the
 * route layer: the credential-assignment guard to credentialService, the
 * current-state interval to monitoring/monitorSettings, the associated-IP
 * shape to assetAddressService, and clampMonitoredState to utils/assetInvariants.
 */

import { type Request } from "express";
import { AppError } from "../../../utils/errors.js";
import { hasPermission } from "../../middleware/permissions.js";
import { assertIpChangeMayRetargetIntegrationToken as assertIpChangeMayRetargetIntegrationTokenUtil } from "../../../utils/integrationTokenTarget.js";

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
