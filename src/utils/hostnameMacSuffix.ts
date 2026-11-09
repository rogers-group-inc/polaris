/**
 * src/utils/hostnameMacSuffix.ts
 *
 * Business rule 91(i): devices that share a discovered hostname are told apart
 * by the last three octets of their MAC — "iPhone" + 44:61:32:F2:BC:27 becomes
 * "iPhone-F2BC27". Pure name math; the decision of WHICH assets are renamed
 * lives in services/hostnameMacSuffixService.ts.
 */

import { macHexKeyOrNull } from "./mac.js";

/** "F2BC27" for 44:61:32:F2:BC:27; the whole 12 hex digits when `full`. Null for no MAC. */
export function macNameSuffix(mac: string | null | undefined, full = false): string | null {
  const hex = macHexKeyOrNull(mac);
  if (!hex) return null;
  return full ? hex : hex.slice(-6);
}

/** "iPhone-F2BC27". Null when the MAC is unusable. */
export function suffixedHostname(base: string, mac: string | null | undefined, full = false): string | null {
  const suffix = macNameSuffix(mac, full);
  return suffix ? `${base}-${suffix}` : null;
}

/**
 * True when `name` is `base` itself or `base` carrying a MAC suffix (6 or 12
 * hex digits), compared case-insensitively — the members of one hostname
 * family. "iPhone-Pro" is not a member of "iPhone".
 */
export function isHostnameFamilyMember(name: string | null | undefined, base: string): boolean {
  if (!name || !base) return false;
  const n = name.toLowerCase();
  const b = base.toLowerCase();
  if (n === b) return true;
  if (!n.startsWith(b + "-")) return false;
  return /^(?:[0-9a-f]{6}|[0-9a-f]{12})$/.test(n.slice(b.length + 1));
}
