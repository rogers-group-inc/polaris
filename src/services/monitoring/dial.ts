/**
 * src/services/monitoring/dial.ts — the address every monitoring stream dials for an asset (business rule 128),
 * shared by the settings resolver and the collectors (CQ-B061).
 */

import { assetDialAddress } from "../../utils/assetDialAddress.js";
import { ipv6Dialable } from "../ipv6GateService.js";

/**
 * The address every stream dials for an asset (business rule 128): its IPv4,
 * else — only with IPv6 on for the install — its primary IPv6. Each caller's
 * asset read must select `ipv6Address` beside `ipAddress`.
 */
export function dial(asset: { ipAddress?: string | null; ipv6Address?: string | null }): string | null {
  return assetDialAddress(asset, ipv6Dialable());
}
