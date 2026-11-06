/**
 * src/services/hostnameMacSuffixService.ts
 *
 * Business rule 91(i): when discovery creates an asset whose hostname another
 * live asset already carries (or carries with a MAC suffix), every member of
 * that hostname family whose name discovery gave it is renamed
 * `<hostname>-<last 3 MAC octets>` — the new asset and the existing one alike —
 * so devices that share a DHCP / detected-device name (every "iPhone") can be
 * told apart.
 *
 * Who may be renamed: an asset whose name came from a DHCP lease or a gate's
 * detected-device table and nothing better — no `hostnameOverride` (an operator
 * rename is never touched) and no AssetSource but `fortigate-endpoint` (a name
 * from Entra / AD / vCenter / the agent / a Generic API feed is that source's,
 * and stays). It also needs a primary MAC to take the suffix from.
 *
 * The name sticks: the fortigate-endpoint source echoes `Asset.hostname` into
 * its observed blob, so later projections keep the suffixed name. A better
 * source attaching later replaces it with its own name, as it would have
 * replaced the bare one.
 */

import { prisma } from "../db.js";
import { isHostnameFamilyMember, suffixedHostname } from "../utils/hostnameMacSuffix.js";

/** The source kinds whose name a suffix may replace. */
const SUFFIXABLE_SOURCE_KINDS = new Set(["fortigate-endpoint"]);

export interface FamilyMember {
  id: string;
  hostname: string | null;
  macAddress: string | null;
  hostnameOverride: string | null;
  sourceKinds: string[];
}

export interface PlannedRename {
  id: string;
  from: string;
  to: string;
}

/** True when rule 91(i) may rename this asset. */
export function isSuffixEligible(m: FamilyMember): boolean {
  if (!m.hostname || !m.macAddress) return false;
  if (m.hostnameOverride) return false;
  return m.sourceKinds.every((k) => SUFFIXABLE_SOURCE_KINDS.has(k));
}

/**
 * Pure: given every live member of one hostname family (`base` and its
 * suffixed forms), the renames rule 91(i) makes. A family of one is left
 * alone. Only members still carrying the bare name are renamed; a suffix that
 * another member already holds falls back to the full MAC.
 */
export function planFamilyRenames(base: string, members: FamilyMember[]): PlannedRename[] {
  const live = members.filter((m) => isHostnameFamilyMember(m.hostname, base));
  if (live.length < 2) return [];
  const taken = new Set(live.map((m) => (m.hostname || "").toLowerCase()));
  const out: PlannedRename[] = [];
  for (const m of live) {
    if ((m.hostname || "").toLowerCase() !== base.toLowerCase()) continue;
    if (!isSuffixEligible(m)) continue;
    // Keep the member's own casing of the base ("IPHONE" stays "IPHONE-…").
    const ownBase = m.hostname!;
    let to = suffixedHostname(ownBase, m.macAddress);
    if (to && taken.has(to.toLowerCase())) to = suffixedHostname(ownBase, m.macAddress, true);
    if (!to || taken.has(to.toLowerCase())) continue;
    taken.add(to.toLowerCase());
    out.push({ id: m.id, from: m.hostname!, to });
  }
  return out;
}

/**
 * Load each family the given hostnames name (live assets only: a
 * decommissioned one holds no name a device is told apart from) and return
 * the renames rule 91(i) makes. One query per 100 bases.
 */
export async function planHostnameMacSuffixes(hostnames: Array<string | null | undefined>): Promise<PlannedRename[]> {
  const bases = new Map<string, string>(); // lowercase → as given
  for (const h of hostnames) {
    const t = (h || "").trim();
    if (t) bases.set(t.toLowerCase(), t);
  }
  if (bases.size === 0) return [];
  const all = [...bases.values()];
  const renames: PlannedRename[] = [];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const rows = await prisma.asset.findMany({
      where: {
        status: { not: "decommissioned" },
        OR: chunk.flatMap((b) => [
          { hostname: { equals: b, mode: "insensitive" as const } },
          { hostname: { startsWith: `${b}-`, mode: "insensitive" as const } },
        ]),
      },
      select: {
        id: true, hostname: true, macAddress: true, hostnameOverride: true,
        sources: { select: { sourceKind: true } },
      },
    });
    const members: FamilyMember[] = rows.map((r) => ({
      id: r.id,
      hostname: r.hostname,
      macAddress: r.macAddress,
      hostnameOverride: r.hostnameOverride,
      sourceKinds: r.sources.map((s) => s.sourceKind),
    }));
    for (const b of chunk) renames.push(...planFamilyRenames(b, members));
  }
  return renames;
}
