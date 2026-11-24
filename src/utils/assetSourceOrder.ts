/**
 * src/utils/assetSourceOrder.ts — the order an asset's discovery sources are
 * presented in, and the collapse to one entry per (sourceKind, integration).
 * Pure — no DB.
 *
 * Shared by the two surfaces that list an asset's sources, so they always name
 * the same set: the asset details Sources tab (listAssetSourcesForDisplay) and
 * the Assets table's Sources column (assetListService → enrichAssetList).
 */

/** Identity-first, enrichment under the owners, manual last; unlisted kinds sit at 50. */
const SOURCE_DISPLAY_RANK: Record<string, number> = {
  "entra": 1,
  "intune": 2,
  "ad": 3,
  "fortigate-firewall": 4,
  "fortiswitch": 5,
  "fortiap": 6,
  "fortigate-endpoint": 7,
  // Enrichment, so it sorts under the sources that own the device — but
  // above "manual", since it is a real reading rather than a fallback.
  "snmp-sysdescr": 8,
  "snmp-identity": 8,
  "snmp-profile": 8,
  "fortinet-live": 9,
  "manual": 99,
};

interface OrderableSource {
  sourceKind: string;
  integrationId: string | null;
  lastSeen: Date | null;
}

/**
 * Sort by display rank, newest first within a rank, then keep only the newest
 * row per (sourceKind, integrationId).
 *
 * The collapse exists because a source's identity key can churn: the worst
 * offender is `fortigate-endpoint`, whose externalId is the endpoint MAC — a
 * MAC change spawns a fresh source row and leaves the old one behind, so one
 * integration would otherwise be listed several times. The serial/GUID-keyed
 * kinds (fortigate-firewall/switch/ap, ad, entra, intune) have stable
 * externalIds and never collapse. Returns a new array; the input is untouched.
 */
export function orderAndCollapseSources<T extends OrderableSource>(rows: readonly T[]): T[] {
  const sorted = rows.slice().sort((a, b) => {
    const ai = SOURCE_DISPLAY_RANK[a.sourceKind] ?? 50;
    const bi = SOURCE_DISPLAY_RANK[b.sourceKind] ?? 50;
    if (ai !== bi) return ai - bi;
    return (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0);
  });
  const seen = new Set<string>();
  return sorted.filter((r) => {
    const key = `${r.sourceKind}\u0000${r.integrationId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
