/**
 * src/utils/integrationTokenTarget.ts — business rule 111(c): moving the
 * address of a device a FortiManager or FortiGate integration manages needs
 * the right to manage that integration.
 *
 * Polaris authenticates to a FortiGate with the integration's fleet-wide API
 * token, at the ADDRESS the asset record holds. Giving such a device a new
 * address would send that token to whatever answers there, so the change needs
 * Integrations Read-Write. Clearing the address, reverting to the discovered
 * one or re-sending the current one sends nothing anywhere new.
 *
 * Keyed on the managing integration, NOT on assetType: the collectors pick the
 * token by discoveredByIntegration and the polling method, so a firewall
 * retyped to "server" still receives it. A Fortinet integration stamps itself
 * only on the gates, switches and APs it manages — never on DHCP clients — so
 * endpoints stay an ordinary Assets edit.
 *
 * One function for every path that writes an asset's address (the asset form,
 * forward lookup, PDF import, the primary-address pin, duplicate-IP reassign
 * and asset merge): it lived in assets.ts until the 2026-10-13 re-scan found
 * reassign and merge without it. Pure — the caller passes whether it holds
 * integrations:write.
 */

import { AppError } from "./errors.js";

type ManagedSide = { ipAddress: string | null; discoveredByIntegration?: { type: string } | null };

const MESSAGE =
  "Changing the address of a device that a FortiManager or FortiGate integration manages needs Integrations Read-Write: Polaris signs in to that address with the integration's API token.";

/** True when an integration's API token follows this asset's address. Pure. */
export function isFortinetTokenTarget(asset: { discoveredByIntegration?: { type: string } | null }): boolean {
  const t = asset.discoveredByIntegration?.type;
  return t === "fortimanager" || t === "fortigate";
}

/**
 * Throw 403 unless `canManageIntegrations`, when `nextIp` would give a
 * Fortinet-managed asset a new, non-empty address. Undefined / null / blank /
 * unchanged addresses pass. Pure.
 */
export function assertIpChangeMayRetargetIntegrationToken(
  canManageIntegrations: boolean,
  existing: ManagedSide,
  nextIp: string | null | undefined,
): void {
  if (!isFortinetTokenTarget(existing)) return;
  if (nextIp === undefined || nextIp === null) return;
  const next = nextIp.trim();
  if (!next || next === (existing.ipAddress ?? "").trim()) return;
  if (canManageIntegrations) return;
  throw new AppError(403, MESSAGE);
}

/**
 * Asset merge, either side (rule 111(c), decided 2026-10-13). The survivor
 * keeps its own discoveredByIntegration; what matters is whether the merged
 * record ends up at an address other than a managed member's:
 *  - the survivor is managed and the merge gives it the absorbed asset's
 *    address, or
 *  - the ABSORBED asset is managed and the survivor sits at a different
 *    address — the next discovery re-matches the survivor by serial and would
 *    stamp it managed while a pinned, typed address keeps pointing elsewhere.
 * The merged address is fine when it IS a managed member's own address: an
 * RMA chassis swap merges two managed records at two discovered addresses and
 * keeps the new gate's, which no operator typed. Pure.
 */
export function assertMergeMayRetargetIntegrationToken(
  canManageIntegrations: boolean,
  survivor: ManagedSide,
  absorbed: ManagedSide,
  resultingIp: string | null,
): void {
  if (canManageIntegrations) return;
  const result = (resultingIp ?? "").trim();
  if (!result) return;
  const managed = [survivor, absorbed].filter(isFortinetTokenTarget);
  if (!managed.length) return;
  if (managed.some((side) => (side.ipAddress ?? "").trim() === result)) return;
  throw new AppError(403, MESSAGE);
}
