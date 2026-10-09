/**
 * src/utils/genericApiSource.ts — the Generic API integration's vocabulary.
 *
 * No imports, on purpose (the workloadSources.ts split): the service, the
 * sync, the conflict resolver and the projection all name these, and none of
 * them may import the sync, which pulls discoveryEngine.
 */

/** `Integration.type` — and the asset tag the sync owns. */
export const GENERIC_API_TYPE = "genericapi";

/** `AssetSource.sourceKind` for a record a Generic API integration read. */
export const GENERIC_API_SOURCE_KIND = "generic-api";

/** The operator-facing product name. */
export const GENERIC_API_LABEL = "Generic API";

/**
 * `AssetSource.externalId` for one record. Scoped to the integration: two
 * Generic API integrations reading two systems that both number their devices
 * from 1 must never claim each other's rows.
 */
export function genericApiExternalId(integrationId: string, identity: string): string {
  return `${integrationId}:${identity}`;
}

/** The identity part of an externalId this integration wrote, or null for another integration's. */
export function genericApiIdentityFromExternalId(integrationId: string, externalId: string): string | null {
  const prefix = `${integrationId}:`;
  return externalId.startsWith(prefix) ? externalId.slice(prefix.length) : null;
}
