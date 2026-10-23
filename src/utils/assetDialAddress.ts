/**
 * src/utils/assetDialAddress.ts — the address a probe or collector dials for
 * an asset (business rule 128).
 *
 * IPv4 first, always: `Asset.ipAddress` when it is set. Only an asset with NO
 * IPv4 falls back to its primary IPv6 (`Asset.ipv6Address`), and only while
 * IPv6 is on for the install — the caller passes that switch
 * (services/ipv6GateService.ts → ipv6Enabled), so this stays pure.
 *
 * Every stream that used to read `asset.ipAddress` to decide where to send a
 * probe reads this instead. Name fallbacks (dnsName / hostname for WinRM, SSH,
 * the event log) stay at the call site, AFTER this: an address beats a name.
 */

export interface DialableAsset {
  ipAddress?: string | null;
  ipv6Address?: string | null;
}

export function assetDialAddress(asset: DialableAsset | null | undefined, allowIpv6: boolean): string | null {
  if (!asset) return null;
  const v4 = typeof asset.ipAddress === "string" ? asset.ipAddress.trim() : "";
  if (v4) return v4;
  if (!allowIpv6) return null;
  const v6 = typeof asset.ipv6Address === "string" ? asset.ipv6Address.trim() : "";
  return v6 || null;
}
