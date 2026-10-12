/**
 * src/utils/adBindFallback.ts — when the Active Directory bind account may be
 * used to probe an asset.
 *
 * An AD-discovered Windows host that has no credential of its own is polled
 * over WinRM / SSH with the AD integration's bind account, so the account an
 * operator already trusts to read the directory also covers the servers it
 * discovered. That is a convenience with one precondition: the bind account
 * must only ever be offered to a destination DISCOVERY chose.
 *
 * `assets:write` can pin an asset's address (`ipOverride`) or its name
 * (`hostnameOverride`), and the WinRM / SSH target is `ipAddress ||
 * dnsName || hostname`. Without this check, anyone able to edit an asset could
 * point an AD-sourced row at a host they run, set its polling method to
 * WinRM / SSH, and receive the bind password in the handshake — a secret that
 * is encrypted at rest and masked from everyone without `integrations`.
 *
 * A pinned asset loses the fallback and needs a credential selected on it.
 * That is the intended outcome, not a regression: choosing a credential is
 * the explicit act that says "send THIS secret to THIS address".
 */

export interface AdBindFallbackAsset {
  ipOverride?: string | null;
  hostnameOverride?: string | null;
}

/** True when no operator has named the probe destination for this asset. */
export function adBindFallbackAllowed(asset: AdBindFallbackAsset): boolean {
  return !asset.ipOverride && !asset.hostnameOverride;
}

/**
 * The integration whose bind account may back the probe, or null. Shaped to
 * drop into the resolver parameter that already means "the integration this
 * asset was discovered by".
 */
export function adBindFallbackIntegration<T>(asset: AdBindFallbackAsset, integration: T | null): T | null {
  return adBindFallbackAllowed(asset) ? integration : null;
}
