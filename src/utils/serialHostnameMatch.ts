/**
 * src/utils/serialHostnameMatch.ts
 *
 * Business rule 91(c): a managed FortiSwitch / FortiAP pulls its management
 * address from its FortiGate by DHCP, and FortiOS reports that client — in the
 * lease table and the detected-device inventory — with the device SERIAL as its
 * hostname and the mgmt port's MAC. When the switch's own record carries no MAC
 * yet (baseMac not captured), neither the MAC rung nor the hostname rung of
 * `AssetIndex` finds it — the switch is hostnamed by its switch-id — and Phase 7
 * minted a second "fortigate-endpoint" asset for the same box (the ghost
 * `assetGhostMergeService` later absorbs).
 *
 * The hostname is still the client's own claim (rule 91(b)): any DHCP client
 * can send "S108FF…" as option 12. So a serial-shaped hostname resolves to the
 * managed device only when the row's address is the one Fortinet discovery
 * itself reported for that device — the claimant would have to be ON the
 * switch's management IP, at which point it is the duplicate-IP conflict
 * (rule 40), not an adoption.
 */

import { isUsableSerial } from "./serialNumber.js";

/** Asset types a gate hands a DHCP address to and reports by serial. */
const SERIAL_HOSTNAMED_TYPES: ReadonlySet<string> = new Set(["switch", "access_point"]);

export interface SerialHostnameCandidate {
  assetType?: string | null;
  ipAddress?: string | null;
  fortinetTopology?: unknown;
}

/**
 * True when `candidate` — the asset whose serial equals the row's hostname —
 * may be taken as the row's device: a Fortinet-discovered switch or AP whose
 * recorded management address is the row's address.
 */
export function serialHostnameCorroborated(
  candidate: SerialHostnameCandidate | null | undefined,
  hostname: string | null | undefined,
  ip: string | null | undefined,
): boolean {
  if (!candidate || !hostname || !ip) return false;
  if (!isUsableSerial(hostname)) return false;
  if (!candidate.assetType || !SERIAL_HOSTNAMED_TYPES.has(candidate.assetType)) return false;
  if (candidate.fortinetTopology == null) return false;
  return !!candidate.ipAddress && candidate.ipAddress === ip.trim();
}
