/**
 * src/services/monitoring/lldpMatchIndex.ts — the LLDP match-index cache (CQ-B061, moved verbatim from monitoringService.ts):
 * the fleet-wide index that resolves an LLDP neighbour (system name, chassis id, mgmt
 * address) to a Polaris asset, built once and refreshed on a TTL.
 */

import { normalizeMacOrNull } from "../../utils/mac.js";
import { prisma } from "../../db.js";
import { bareInterfaceIp, interfaceIpIsUnaddressed } from "../../utils/cidr.js";
import { splitInterfaceAddresses } from "../../utils/interfaceAddress.js";
import { ipv6Enabled } from "../ipv6GateService.js";
import { createTtlCache } from "../../utils/ttlCache.js";
import { expandMacRange } from "../../utils/macAddresses.js";
import { logger } from "../../utils/logger.js";
import { buildInfraParentIndex, controllerGateIdOf, type InfraParentCandidate } from "../../utils/fortinetParentKey.js";
import { indexLldpHostname, type LldpHostnameMatchIndex } from "../../utils/lldpHostnameMatch.js";
import { InterfaceSample } from "./types.js";

/**
 * Who read an interface table's addresses. `agent-interface` is the asset's
 * own Polaris Agent: its bearer is bound to this asset, so the report cannot
 * have come from another device answering at the address (business rule
 * 103(e)); an SNMP / REST / WinRM scrape proves only that something answered.
 */
export type InterfaceAddressSource = "monitor-system-info" | "agent-interface";

/**
 * Build a lookup table for asset-matching neighbors. One pass over the asset
 * table at persist time is cheaper than per-neighbor queries; the table is
 * kept in scope only for the duration of a single recordSystemInfoResult call.
 *
 * - byIp: ipAddress + every row in asset_associated_ips (manual + monitor-discovered)
 * - byMac: macAddress (uppercased) + every entry in macAddresses
 * - byHostnameAll: hostname (lowercased) → EVERY asset carrying it (rule 91);
 *   `gateIdByAssetId` is what picks between them
 */
// ─── LLDP match-index cache ───────────────────────────────────────────────
//
// `persistLldpNeighbors` used to call `buildLldpAssetMatchIndex` on every
// system-info pass — for each monitored asset that returned an LLDP scrape
// we'd findMany over EVERY asset row (plus its associated IP and MAC side
// tables) just to build the IP/MAC/hostname lookup maps. At 1700 monitored
// assets that's the heaviest single read in the monitor hot loop.
//
// Cache the index for 60 s. Asset hostnames / IPs / MACs change slowly
// enough that the worst-case stale-cache effect is one cycle of "LLDP
// neighbor resolved to the wrong asset" which corrects itself on the next
// scrape. Single-process module-level cache; no inter-process invalidation
// needed because the workers are all in one node process.
//
// Discovery code that materially changes the lookup keys (asset rename,
// IP change, MAC add/remove) can call `invalidateLldpMatchCache()` to drop
// the cache before its next read — but the TTL is short enough that
// explicit invalidation is optional, and most discovery writes don't need
// it. Currently nobody calls it; the TTL is the source of truth.
const LLDP_MATCH_CACHE_TTL_MS = 60_000;

interface LldpMatchIndex extends LldpHostnameMatchIndex {
  byIp: Map<string, string>;
  byMac: Map<string, string>;
}

// createTtlCache (2026-08 audit) — the hand-rolled cache+inflight trio it
// replaces re-implemented exactly the promise-coalescing the shared util
// provides (many parallel systemInfo workers hitting the same TTL-miss
// window share ONE findMany).
const lldpMatchCache = createTtlCache<LldpMatchIndex>({ ttlMs: LLDP_MATCH_CACHE_TTL_MS, maxEntries: 1 });

export function getLldpAssetMatchIndex(): Promise<LldpMatchIndex> {
  return lldpMatchCache.getOrCompute("", buildLldpAssetMatchIndex);
}

/** Drop the cached LLDP match index so the next `persistLldpNeighbors`
 *  call rebuilds from a fresh findMany. Currently unused — discovery code
 *  relies on the 60 s TTL for refresh. Exported for tests and for future
 *  callers that want explicit control after a bulk asset write. */
export function invalidateLldpMatchCache(): void {
  lldpMatchCache.invalidate();
}

async function buildLldpAssetMatchIndex(): Promise<LldpMatchIndex> {
  // Always-on logging around the full-fleet findMany: the rebuild fires at
  // most every 60 s on TTL miss, so log volume is bounded, and "the rebuild
  // wedged" is one of the leading hypotheses for systemInfo handler stalls
  // (every concurrent handler awaits the same inflight Promise — if it
  // never settles, every awaiter times out together). Pair of start +
  // complete lines gives the operator wall-clock for the rebuild itself.
  const startedAt = Date.now();
  logger.info({ phase: "lldp_match_index.rebuild_start" }, "LLDP match index rebuild started");
  // Two reads: the identity columns for every asset, and — for the Fortinet
  // infra rows only — the three `fortinetTopology` keys that say which gate
  // each sits under (rule 91's tie-break for a shared hostname). A JSON-path
  // projection rather than selecting the whole blob: a gate's topology stamp
  // carries its managed-member serial lists, far more than this index needs
  // every 60 s.
  type InfraKeyRow = {
    id: string; hostname: string | null; serialNumber: string | null; assetType: string;
    controllerSerial: string | null; controllerFortigate: string | null; deviceName: string | null;
  };
  const [rows, infraRows] = await Promise.all([
    prisma.asset.findMany({
      select: {
        id: true, ipAddress: true, macAddress: true, hostname: true, dnsName: true,
        associatedIpRows: { select: { ip: true } },
        macAddressRows:   { select: { mac: true, macEnd: true } },
      },
    }),
    prisma.$queryRaw<InfraKeyRow[]>`
      SELECT id, hostname, "serialNumber", "assetType"::text AS "assetType",
             "fortinetTopology"->>'controllerSerial'    AS "controllerSerial",
             "fortinetTopology"->>'controllerFortigate' AS "controllerFortigate",
             "fortinetTopology"->>'deviceName'          AS "deviceName"
      FROM assets
      WHERE "assetType"::text IN ('firewall', 'switch', 'access_point')
    `,
  ]);
  logger.info(
    { phase: "lldp_match_index.rebuild_complete", elapsedMs: Date.now() - startedAt, assets: rows.length },
    "LLDP match index rebuild complete",
  );
  const byIp = new Map<string, string>();
  const byMac = new Map<string, string>();
  const byHostnameAll = new Map<string, string[]>();
  // Index a hostname-shaped string under the asset id, including the leftmost
  // label when it's an FQDN. Symmetric coverage matters for LLDP matching: a
  // FortiGate's `Asset.hostname` is "HARBOR-61F-1" (short form, set by the
  // fortigate-firewall source) but the device advertises itself via LLDP as
  // "HARBOR-61F-1.example.com" (FQDN). The lookup side already lowercases; we
  // just need both forms in the index.
  const idxHostname = (raw: string | null, assetId: string) => indexLldpHostname(byHostnameAll, raw, assetId);
  // Which gate each infra asset sits under, through the shared resolver (a
  // controller stamp is serial-first, FMG device name second, hostname last).
  const gateIdByAssetId = new Map<string, string>();
  const infraCandidates: InfraParentCandidate[] = infraRows.map(r => ({
    id: r.id, hostname: r.hostname, serialNumber: r.serialNumber, assetType: r.assetType,
    fortinetTopology: {
      controllerSerial: r.controllerSerial, controllerFortigate: r.controllerFortigate, deviceName: r.deviceName,
    },
  }));
  const infraIndex = buildInfraParentIndex(infraCandidates);
  for (const c of infraCandidates) {
    const gate = c.assetType === "firewall" ? c.id : controllerGateIdOf(infraIndex, c);
    if (gate) gateIdByAssetId.set(c.id, gate);
  }
  for (const a of rows) {
    if (a.ipAddress && !byIp.has(a.ipAddress)) byIp.set(a.ipAddress, a.id);
    for (const row of a.associatedIpRows) {
      if (row.ip && !byIp.has(row.ip)) byIp.set(row.ip, a.id);
    }
    if (a.macAddress) {
      const mac = a.macAddress.toUpperCase();
      if (!byMac.has(mac)) byMac.set(mac, a.id);
    }
    for (const row of a.macAddressRows) {
      if (!row.mac) continue;
      // Range rows (interface-fold, macEnd set) expand so an LLDP neighbor
      // advertising ANY port MAC in the range still resolves to the asset.
      // Cap guards the index against a malformed row; real interface ranges
      // are bounded by physical port counts.
      for (const mac of expandMacRange(row.mac, row.macEnd, 512)) {
        if (!byMac.has(mac)) byMac.set(mac, a.id);
      }
    }
    idxHostname(a.hostname, a.id);
    // Also index dnsName when set — covers AD-discovered hosts where the
    // FQDN lives on dnsName separately, and LLDP advertises the hostname
    // form which might differ.
    idxHostname(a.dnsName, a.id);
  }
  return { byIp, byMac, byHostnameAll, gateIdByAssetId };
}

/**
 * Build the per-interface monitor-source rows for the asset_associated_ips
 * table from a fresh interface scrape. Pure: takes the interface samples,
 * returns rows ready for createMany. Caller (recordSystemInfoResult) does
 * the delete-and-replace transaction; manual entries are preserved by
 * filtering on source there.
 *
 * Empty result is meaningful — it tells the caller to skip the persist
 * entirely so a transient "scrape returned no interface IPs" doesn't wipe
 * an existing monitor-source set.
 */
export function buildMonitorAssocIpEntries(
  interfaces: InterfaceSample[],
  now: Date,
  source: InterfaceAddressSource = "monitor-system-info",
): Array<{
  ip: string;
  source: string;
  interfaceName: string | null;
  mac: string | null;
  interfaceRole: string | null;
  lastSeen: Date;
  firstSeen: Date;
}> {
  const out: Array<{
    ip: string; source: string; interfaceName: string | null;
    mac: string | null; interfaceRole: string | null; lastSeen: Date; firstSeen: Date;
  }> = [];
  const seenIps = new Set<string>();
  for (const i of interfaces) {
    // Business rule 126: one row per reportable address, both families, under
    // the same interface and MAC. Loopback and link-local never land — the
    // agent used to report `lo` as 127.0.0.1 and an IPv6-only NIC as fe80::,
    // and this list feeds IP history, path-check hop resolution and search.
    const addr = splitInterfaceAddresses(i.ipAddress, i.ipv6Address, ipv6Enabled());
    // A collector that names the interface's secondary addresses (FortiOS)
    // also tells us the IPv4 above is the primary; one that doesn't leaves
    // the role unknown. Secondaries are informational — they ride the
    // interface's MAC and nothing else (no network, DHCP or binding).
    const rolesKnown = Array.isArray(i.secondaryIps);
    const secondaries = rolesKnown
      ? (i.secondaryIps as string[]).filter((s) => !interfaceIpIsUnaddressed(s))
      : [];
    const candidates: Array<{ ip: string | null; role: string | null }> = [
      { ip: addr.ipAddress, role: rolesKnown ? "primary" : null },
      ...secondaries.map((s) => ({ ip: bareInterfaceIp(s), role: "secondary" })),
      { ip: addr.ipv6Address, role: null },
    ];
    for (const { ip, role } of candidates) {
      if (!ip || seenIps.has(ip)) continue; // dedupe within a single scrape
      seenIps.add(ip);
      out.push({
        ip,
        source,
        interfaceName: i.ifName,
        // Colon-uppercase like every other address/MAC row: the asset panel
        // groups addresses under the MAC list by exact string, and REST / agent
        // / WinRM collectors report lowercase or dashed MACs.
        mac:           normalizeMacOrNull(i.macAddress),
        interfaceRole: role,
        lastSeen:      now,
        firstSeen:     now,
      });
    }
  }
  return out;
}
