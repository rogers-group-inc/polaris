/**
 * src/utils/lldpHostnameMatch.ts
 *
 * The hostname arm of LLDP neighbour matching, made ambiguity-aware (business
 * rule 91). `persistLldpNeighbors` resolves a neighbour's `systemName` (or a
 * hostname-shaped `chassisId`) against the asset inventory; the index it reads
 * used to be first-writer-wins per hostname, so on a FortiLink fleet whose
 * switch-ids repeat per site ("IDF-1" behind every gate) a switch's LLDP
 * neighbour row resolved to whichever same-named switch sorted first — and
 * froze there as `matchedAssetId`, which the dependency recompute then read as
 * a cross-site adjacency. Dependency membership rejects such an edge only when
 * both gates' rosters are known; the Device Map drew it regardless.
 *
 * Resolution: a unique name matches outright. A shared name matches only the
 * candidate under the SAME controller FortiGate as the asset doing the scrape
 * (a firewall counts as its own gate) — LLDP is a one-hop protocol, so a
 * neighbour at another site is impossible. Still ambiguous ⇒ no match, which
 * leaves the row displayable (the neighbour's name is still shown) but draws
 * no edge from it. Pure — the index is built by the caller.
 */

export interface LldpHostnameMatchIndex {
  /** Every asset id carrying each (lower-cased) hostname or short form. */
  byHostnameAll: Map<string, string[]>;
  /**
   * The FortiGate each Fortinet infra asset sits under, as an asset id: a
   * switch's / AP's resolved controller, a firewall's own id. Absent for an
   * asset with no resolvable controller and for every non-infra asset.
   */
  gateIdByAssetId: Map<string, string>;
}

/**
 * The one asset a (lower-cased) hostname names from `scrapingAssetId`'s point
 * of view, or null. Never the scraping asset itself.
 */
export function pickLldpHostnameMatch(
  index: LldpHostnameMatchIndex,
  scrapingAssetId: string,
  nameKey: string,
): string | null {
  const all = index.byHostnameAll.get(nameKey) ?? [];
  const ids = all.filter(id => id !== scrapingAssetId);
  if (ids.length === 0) return null;
  // Unique means unique in the INVENTORY, not merely once the scraper is set
  // aside: a switch that sees its own name has a same-named twin somewhere,
  // and the twin is at another site or it would not share the switch-id.
  if (all.length === 1) return ids[0];
  const myGate = index.gateIdByAssetId.get(scrapingAssetId);
  if (!myGate) return null;
  const sameSite = ids.filter(id => index.gateIdByAssetId.get(id) === myGate);
  return sameSite.length === 1 ? sameSite[0] : null;
}

/**
 * Add a hostname-shaped value to `byHostnameAll` under its lower-cased form
 * and, for an FQDN, its leftmost label — a FortiGate's `Asset.hostname` is the
 * short form while the device advertises its FQDN over LLDP, and the reverse
 * happens too. Idempotent per (name, id).
 */
export function indexLldpHostname(
  byHostnameAll: Map<string, string[]>,
  raw: string | null | undefined,
  assetId: string,
): void {
  if (!raw) return;
  const lower = raw.toLowerCase().trim();
  if (!lower) return;
  const add = (key: string) => {
    const list = byHostnameAll.get(key);
    if (!list) byHostnameAll.set(key, [assetId]);
    else if (!list.includes(assetId)) list.push(assetId);
  };
  add(lower);
  const dotIdx = lower.indexOf(".");
  if (dotIdx > 0) add(lower.slice(0, dotIdx));
}
