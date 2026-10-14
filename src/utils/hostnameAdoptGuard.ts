/**
 * src/utils/hostnameAdoptGuard.ts
 *
 * Business rule 91(b) (re-scan F2): which assets a DHCP lease or a FortiGate
 * detected-device row may NOT re-address when it matched them by hostname
 * alone. A DHCP client chooses its own hostname (option 12), so anyone holding
 * a lease on a discovered gate can claim a monitored server's name — and if
 * that moved the asset's ipAddress, the monitor would then probe the
 * claimant's address with the asset's stored credentials.
 *
 * "Protected" = monitored, or any per-stream credential attached. Unprotected
 * assets keep the historical hostname-adoption behaviour.
 */

/** Every credential reference column on Asset (prisma/schema.prisma). */
export const ASSET_CREDENTIAL_COLUMNS = [
  "monitorCredentialId",
  "responseTimeCredentialId",
  "cpuMemoryCredentialId",
  "temperatureCredentialId",
  "interfacesCredentialId",
  "lldpCredentialId",
  "customWidgetCredentialId",
  "processesCredentialId",
  "eventLogCredentialId",
] as const;

export type HostnameAdoptGuardFields =
  & { monitored?: boolean | null }
  & { [K in (typeof ASSET_CREDENTIAL_COLUMNS)[number]]?: string | null };

/** True when a hostname-only match must not move this asset's address. */
export function isHostnameAdoptProtected(asset: HostnameAdoptGuardFields | null | undefined): boolean {
  if (!asset) return false;
  if (asset.monitored === true) return true;
  return ASSET_CREDENTIAL_COLUMNS.some((c) => !!asset[c]);
}
