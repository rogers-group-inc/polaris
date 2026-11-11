/**
 * src/api/routes/assets/shared.ts — The one write-time guard more than one
 * assets sub-router needs that reads the request: the integration-token
 * retarget (rule 111(c)), which asks the caller's integrations permission.
 * Split out of routes/assets.ts (CQ-B062). Slice 2 moved everything else out
 * of the route layer: the credential-assignment guard to credentialService,
 * the current-state interval to monitoring/monitorSettings, the associated-IP
 * shape to assetAddressService, clampMonitoredState to utils/assetInvariants,
 * and assertQuarantineStatusUntouched to assetQuarantineService.
 */

import { type Request } from "express";
import { hasPermission } from "../../middleware/permissions.js";
import { assertIpChangeMayRetargetIntegrationToken as assertIpChangeMayRetargetIntegrationTokenUtil } from "../../../utils/integrationTokenTarget.js";

/** Rule 111(c) — see utils/integrationTokenTarget.ts. */
export function assertIpChangeMayRetargetIntegrationToken(
  req: Request,
  existing: { ipAddress: string | null; discoveredByIntegration?: { type: string } | null },
  nextIp: string | null | undefined,
): void {
  assertIpChangeMayRetargetIntegrationTokenUtil(hasPermission(req, "integrations", "write"), existing, nextIp);
}
