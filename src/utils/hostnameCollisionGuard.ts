/**
 * src/utils/hostnameCollisionGuard.ts
 *
 * Business rule 91(a): a shared hostname — exact, or equal only after the
 * 15-char NetBIOS truncation — is not evidence that two records are one
 * device. Discovery may raise a hostname-collision Conflict (and the Conflicts
 * card may call the pair "duplicate assets") only when nothing the two records
 * already say contradicts it:
 *
 *   - **serial** — both carry a usable serial (`isUsableSerial`) and they
 *     differ. Two serials are two pieces of hardware, whatever the names say.
 *   - **class** — one side is network infrastructure (switch, router,
 *     firewall, access point) and the other is a specific non-infrastructure
 *     type (workstation, server, printer, VM host, container, …). A FortiSwitch
 *     named `CROSSPLAINS-CSR-DESK` and an Entra laptop whose NetBIOS name is
 *     `CROSSPLAINS-CSR` are a site naming scheme, not a duplicate.
 *
 * Absent or generic data (`other`, a blank type, no serial, a custom type this
 * file does not classify) never refuses: the pair is still offered for review,
 * as it was before this guard.
 */

import { isGenericAssetType } from "./assetTypes.js";
import { isUsableSerial, squashSerial } from "./serialNumber.js";

/** Types that name a piece of network infrastructure, never an endpoint. */
const NETWORK_INFRA_TYPES = new Set(["switch", "router", "firewall", "access_point"]);

/** Built-in types that name something that is definitely NOT network infrastructure. */
const NON_INFRA_TYPES = new Set([
  "server", "workstation", "printer", "hypervisor", "kubernetes_cluster", "container",
]);

export interface HostnameCollisionSide {
  assetType?: string | null;
  serialNumber?: string | null;
}

export type HostnameCollisionRefusal = "serial" | "class";

function classOf(assetType: string | null | undefined): "infra" | "endpoint" | null {
  if (isGenericAssetType(assetType)) return null;
  const t = (assetType as string).trim().toLowerCase();
  if (NETWORK_INFRA_TYPES.has(t)) return "infra";
  if (NON_INFRA_TYPES.has(t)) return "endpoint";
  return null;
}

/**
 * Why a hostname match between `incoming` and `candidate` must NOT be offered
 * as one device, or null when it may be.
 */
export function hostnameCollisionRefusal(
  incoming: HostnameCollisionSide,
  candidate: HostnameCollisionSide,
): HostnameCollisionRefusal | null {
  if (isUsableSerial(incoming.serialNumber) && isUsableSerial(candidate.serialNumber)) {
    if (squashSerial((incoming.serialNumber as string).trim()) !== squashSerial((candidate.serialNumber as string).trim())) {
      return "serial";
    }
  }
  const a = classOf(incoming.assetType);
  const b = classOf(candidate.assetType);
  if (a && b && a !== b) return "class";
  return null;
}
