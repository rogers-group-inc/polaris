/**
 * src/services/autoMonitorInterfacesService.ts
 *
 * "Auto-Monitor Interfaces" feature for the FMG/FortiGate integration. Lets an
 * operator pre-select which interfaces on every discovered FortiGate /
 * FortiSwitch / FortiAP get pinned for fast-cadence (~60s) polling — i.e.
 * added to Asset.monitoredInterfaces — instead of clicking "Poll 1m" by hand
 * on every asset's System tab.
 *
 * The selection is stored as JSON inside Integration.config under each
 * existing per-class block (fortigateMonitor / fortiswitchMonitor /
 * fortiapMonitor) as a multi-block union — each block is independent and
 * the resolved pin set is the UNION across whichever blocks are present.
 * Missing key = block off; `null` selection = whole feature off.
 *
 *   byNames    : explicit ifNames the operator picked from an aggregated list
 *   byPatterns : pattern strings; regex=false treats them as shell wildcards
 *                (* and ?), regex=true treats them as raw anchor-free regex
 *   byTypes    : ifType set (physical / aggregate / vlan / loopback / tunnel).
 *                `tunnel` also covers FortiOS IPsec phase1-interface tunnels
 *                (surfaced as synthetic rows — see below).
 *   byLldp     : neighbor-assetType set; pins any interface whose LLDP
 *                neighbor matched a monitored Polaris asset of one of the
 *                selected types
 *
 * Resolution always happens against each asset's latest AssetInterfaceSample
 * rows. For the fortigate class those rows are augmented with synthetic
 * `ifType:"tunnel"` entries built from the latest AssetIpsecTunnelSample per
 * tunnel (see mergeTunnelsIntoInterfaces) — FortiOS phase1-interface tunnels
 * are real `config system interface` entries but the REST monitor endpoint
 * omits them, so they'd otherwise never appear in the "By name" / "By type"
 * pickers. Those synthetic rows are tagged `isIpsecTunnel`, and the apply pass
 * routes their pins to `Asset.monitoredIpsecTunnels` (read by the IPsec
 * sampler) while real interface pins go to `Asset.monitoredInterfaces` (IF-MIB)
 * — `splitPinsByProvenance` does the partition. The apply pass is strictly
 * additive on BOTH fields: it never strips existing pins. This is deliberate;
 * both arrays are operator-owned and removing items on every discovery would
 * surprise anyone who pinned something by hand.
 *
 * Dead-parent exclusion: an IPsec tunnel whose phase-1 parent interface
 * (`AssetIpsecTunnelSample.parentInterface`, e.g. "wan2") is currently DOWN
 * and holds no usable IP address (null / "" / "0.0.0.0") can never establish —
 * the underlay link is unprovisioned or unplugged, not merely flapping. Such
 * tunnels are never auto-pinned, by ANY selection block (including byNames and
 * byTypes+includeDownTunnels). `mergeTunnelsIntoInterfaces` stamps
 * `parentDownNoIp` on the tunnel row and `resolvePinnedInterfaces` drops those
 * rows up front. A parent that is down but still holds an IP does NOT trigger
 * the exclusion — that's a real link that flapped, and `includeDownTunnels`
 * exists precisely to watch its tunnels. Operators can still pin a dead-parent
 * tunnel by hand on the asset (apply is additive and never strips).
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { normalizeFortiapInterfaceName } from "../utils/fortiapInterfaceAlias.js";
import { readFirewallDeviceName } from "../utils/fortinetParentKey.js";
import { compilePattern } from "../utils/wildcard.js";
import { interfaceIpIsUnaddressed } from "../utils/cidr.js";

// ─── Public types ───────────────────────────────────────────────────────────

/** Asset types that By LLDP can match against. Mirrors the AssetType enum. */
export const LLDP_NEIGHBOR_TYPES = [
  "firewall",
  "switch",
  "access_point",
  "server",
  "workstation",
  "router",
  "printer",
  "other",
] as const;
export type LldpNeighborType = (typeof LLDP_NEIGHBOR_TYPES)[number];

export const IF_TYPES = ["physical", "aggregate", "vlan", "loopback", "tunnel"] as const;
export type IfType = (typeof IF_TYPES)[number];

export interface ByNamesBlock    { names: string[] }
export interface ByPatternsBlock { patterns: string[]; regex: boolean; onlyUp: boolean }
/**
 * `includeDownTunnels` is a tunnel-only exception to `onlyUp`: when both are
 * set, fully-`down` IPsec tunnels still pin even though "only currently up" is
 * on. It has no effect on non-tunnel types and is moot when `onlyUp` is false
 * (down interfaces pin anyway). A down IPsec tunnel is often exactly what an
 * operator wants to watch, so the picker surfaces this next to the tunnel row.
 */
export interface ByTypesBlock    { types: IfType[]; onlyUp: boolean; includeDownTunnels?: boolean }
export interface ByLldpBlock     { neighborTypes: LldpNeighborType[] }

/**
 * Multi-block selection. Each key is optional; presence = block enabled. A
 * `null` selection (or an object with all keys missing) is equivalent to the
 * whole feature being off and produces zero pins.
 */
export type AutoMonitorSelection = {
  byNames?:    ByNamesBlock;
  byPatterns?: ByPatternsBlock;
  byTypes?:    ByTypesBlock;
  byLldp?:     ByLldpBlock;
} | null;

// Fortinet classes (FMG / FortiGate) plus the AD/Entra workstation+server
// classes. Interface auto-monitor is class-agnostic — it resolves a selection
// against each asset's latest AssetInterfaceSample rows regardless of source —
// so the only per-class knowledge is the Asset.assetType each maps to.
export type AutoMonitorClass = "fortigate" | "fortiswitch" | "fortiap" | "workstation" | "server" | "virtual_machine";

/** Minimal interface shape consumed by the resolver. */
export interface ResolverInterface {
  ifName: string;
  ifType: string | null;
  operStatus: string | null;
  /**
   * Interface IP as last sampled (FortiOS REST reports "0.0.0.0" for an
   * unaddressed port; SNMP/agent paths may leave it null). Only consulted by
   * `mergeTunnelsIntoInterfaces` to judge a tunnel's parent link — the
   * resolver blocks never filter on it directly.
   */
  ipAddress?: string | null;
  /**
   * True only for synthetic rows produced by `mergeTunnelsIntoInterfaces` —
   * i.e. FortiOS phase1-interface IPsec tunnels surfaced from
   * asset_ipsec_tunnel_samples. Drives write-time routing: a pinned name
   * whose row carries this flag is written to `Asset.monitoredIpsecTunnels`
   * (the field the IPsec sampler reads) instead of `Asset.monitoredInterfaces`
   * (IF-MIB). Absent/false on real AssetInterfaceSample rows. See
   * `splitPinsByProvenance` and the module header.
   */
  isIpsecTunnel?: boolean;
  /**
   * Set by `mergeTunnelsIntoInterfaces` on IPsec tunnel rows whose phase-1
   * parent interface is currently down AND has no usable IP (null / "" /
   * "0.0.0.0") — an underlay that can't carry the tunnel at all.
   * `resolvePinnedInterfaces` excludes such rows from every selection block;
   * see the module header ("Dead-parent exclusion").
   */
  parentDownNoIp?: boolean;
}

/**
 * Per-asset LLDP info passed alongside ResolverInterface[] when By LLDP is
 * in play. The resolver only needs the matched neighbor's assetType and
 * monitored flag — everything else (chassisId, system name, port id, ...)
 * lives in the AssetLldpNeighbor table but isn't consulted here.
 */
export interface LldpNeighborMatch {
  matchedAssetType: string | null;
  matchedAssetMonitored: boolean;
}

/** ifName → list of LLDP matches observed on that local port. */
export type LldpByIfName = Map<string, LldpNeighborMatch[]>;

const CLASS_TO_ASSET_TYPE: Record<AutoMonitorClass, string> = {
  fortigate: "firewall",
  fortiswitch: "switch",
  fortiap: "access_point",
  workstation: "workstation",
  server: "server",
  // vCenter VM class — the klass keeps its vm name, but the assets are plain
  // servers (the virtual_machine built-in type was retired 2026-07). Scope
  // stays exact because every query pairs this with discoveredByIntegrationId,
  // and only vCenter integrations use this klass.
  virtual_machine: "server",
};

// ─── Pattern compilation (wildcard vs regex) ────────────────────────────────
//
// Moved to src/utils/wildcard.ts when the contact device filter needed the same
// wildcard semantics — notificationTypes evaluates that tree and can't import a
// service. Re-exported here because this module has been the import site for
// every consumer (tag criteria, app-map discovery rules, storage auto-monitor,
// the integrations route) and for the existing unit suite.
export { MAX_PATTERN_LENGTH, compileWildcard, compilePattern } from "../utils/wildcard.js";

// ─── Pure resolver ──────────────────────────────────────────────────────────

/**
 * Returns the set of ifNames a multi-block selection would pin on one asset.
 * Pure: no DB, no I/O. The set is the UNION across whichever blocks are
 * present; an empty / null selection produces zero pins. Caller does the
 * union with the asset's existing Asset.monitoredInterfaces.
 *
 * `lldpByIfName` is only consulted when `selection.byLldp` is set. Callers
 * that don't intend to use By LLDP can skip it; if it's missing AND byLldp
 * is set, By LLDP contributes nothing (rather than throwing).
 */
export function resolvePinnedInterfaces(
  selection: AutoMonitorSelection,
  interfaces: ResolverInterface[],
  lldpByIfName?: LldpByIfName,
): string[] {
  if (!selection) return [];
  if (!interfaces || interfaces.length === 0) return [];

  // Dead-parent exclusion (module header): an IPsec tunnel riding a parent
  // interface that is down with no IP can never establish, so it is invisible
  // to EVERY block — byNames' "up/down ignored" and byTypes'
  // includeDownTunnels both apply only to the tunnel's own state, not to a
  // structurally dead underlay. Hand-pins on the asset are unaffected (the
  // apply pass is additive and never strips).
  interfaces = interfaces.filter((i) => i.parentDownNoIp !== true);
  if (interfaces.length === 0) return [];

  const picked = new Set<string>();

  // By name — explicit ifNames; up/down state ignored on purpose.
  if (selection.byNames && selection.byNames.names.length > 0) {
    const want = new Set(selection.byNames.names);
    for (const i of interfaces) if (want.has(i.ifName)) picked.add(i.ifName);
  }

  // By pattern — wildcards or regex per the block's `regex` flag.
  if (selection.byPatterns && selection.byPatterns.patterns.length > 0) {
    const regexes = selection.byPatterns.patterns.map((p) => compilePattern(p, selection.byPatterns!.regex));
    const pool = selection.byPatterns.onlyUp ? interfaces.filter((i) => i.operStatus === "up") : interfaces;
    for (const i of pool) if (regexes.some((r) => r.test(i.ifName))) picked.add(i.ifName);
  }

  // By type — ifType ∈ chosen set.
  if (selection.byTypes && selection.byTypes.types.length > 0) {
    const want = new Set(selection.byTypes.types);
    const includeDownTunnels = selection.byTypes.includeDownTunnels === true;
    for (const i of interfaces) {
      if (i.ifType === null) continue;
      if (!want.has(i.ifType as IfType)) continue;
      if (selection.byTypes.onlyUp && i.operStatus !== "up") {
        // onlyUp normally drops non-up interfaces. The one exception:
        // fully-down IPsec tunnels when the operator opted into them.
        if (!(includeDownTunnels && i.ifType === "tunnel")) continue;
      }
      picked.add(i.ifName);
    }
  }

  // By LLDP — an LLDP neighbor on this port matched a monitored Polaris asset
  // whose assetType is in the chosen set. Multiple neighbors on the same port
  // (shared media / aggregate) — any single match is enough to pin.
  if (selection.byLldp && selection.byLldp.neighborTypes.length > 0 && lldpByIfName && lldpByIfName.size > 0) {
    const want = new Set(selection.byLldp.neighborTypes);
    for (const i of interfaces) {
      const neighbors = lldpByIfName.get(i.ifName);
      if (!neighbors || neighbors.length === 0) continue;
      const hit = neighbors.some(
        (n) => n.matchedAssetMonitored && n.matchedAssetType !== null && want.has(n.matchedAssetType as LldpNeighborType),
      );
      if (hit) picked.add(i.ifName);
    }
  }

  return Array.from(picked);
}

/** Result of partitioning a pin set by interface provenance. */
export interface PinsByProvenance {
  /** Names that pin to `Asset.monitoredInterfaces` (real IF-MIB interfaces). */
  interfaces: string[];
  /** Names that pin to `Asset.monitoredIpsecTunnels` (synthetic IPsec rows). */
  ipsecTunnels: string[];
}

/**
 * Partition a resolved pin set into the two destination fields by looking up
 * each picked name's source row in `interfaces`. A name whose row carries
 * `isIpsecTunnel` goes to `ipsecTunnels` (→ Asset.monitoredIpsecTunnels);
 * everything else goes to `interfaces` (→ Asset.monitoredInterfaces). Per asset
 * a name is unambiguous: `mergeTunnelsIntoInterfaces` de-dupes against real rows
 * (real wins), so the same ifName is never both a real interface and a synthetic
 * tunnel on one device. A picked name with no matching row (shouldn't happen —
 * picks come from this same list) defaults to `interfaces`, preserving the
 * pre-routing behavior. Pure: no DB, no I/O.
 */
export function splitPinsByProvenance(
  picked: string[],
  interfaces: ResolverInterface[],
): PinsByProvenance {
  if (picked.length === 0) return { interfaces: [], ipsecTunnels: [] };
  const tunnelNames = new Set<string>();
  for (const i of interfaces) if (i.isIpsecTunnel) tunnelNames.add(i.ifName);
  const ifaces: string[] = [];
  const tunnels: string[] = [];
  for (const name of picked) {
    if (tunnelNames.has(name)) tunnels.push(name);
    else ifaces.push(name);
  }
  return { interfaces: ifaces, ipsecTunnels: tunnels };
}

// ─── IPsec tunnel → synthetic interface merge (pure) ─────────────────────────

/** Latest IPsec tunnel observation the merge helper consumes. */
export interface TunnelObservation {
  tunnelName: string;
  /** Phase-1 rollup status: "up" | "down" | "partial" | "dynamic". */
  status: string | null;
  /**
   * Phase-1 `interface` from the FortiOS CMDB — the underlay port the tunnel
   * rides (e.g. "wan1"). Null/absent when the CMDB endpoint was unreachable.
   * Used to evaluate the dead-parent exclusion against the real interface
   * rows already in the asset's list.
   */
  parentInterface?: string | null;
}

/**
 * True when a sampled interface IP gives no evidence of a usable address:
 * never sampled (null), empty, or the FortiOS "unaddressed" placeholder
 * 0.0.0.0 (with or without a trailing mask, e.g. "0.0.0.0 0.0.0.0").
 *
 * The address-shape parsing lives in `utils/cidr.ts` with the rest of the IP
 * math, shared with the `ifIpAddress` automation reading — an operator's
 * `!= 0.0.0.0` rule and this dead-parent check must agree on what counts as
 * unaddressed, or the same interface reads dead to one and alive to the other.
 */
const hasNoUsableIp = interfaceIpIsUnaddressed;

/**
 * Append IPsec tunnels to each asset's interface list as synthetic
 * `ifType: "tunnel"` rows so the auto-monitor "By name" / "By interface type"
 * pickers (and the preview/apply resolver) can see them. FortiOS phase1-
 * interface tunnels are real `config system interface` entries of type
 * `tunnel`, but the REST `/api/v2/monitor/system/interface` endpoint omits
 * them — so on REST-polled FortiGates they never reach asset_interface_samples
 * and would otherwise be invisible here. Each synthetic row carries
 * `isIpsecTunnel: true`; at apply time `splitPinsByProvenance` routes those
 * pins to `Asset.monitoredIpsecTunnels` (the field the dedicated IPsec sampler
 * in asset_ipsec_tunnel_samples reads for fast-cadence polling) rather than
 * `Asset.monitoredInterfaces` (IF-MIB). This is what makes a "By type: tunnel"
 * selection actually fast-poll IPsec tunnels on REST-polled gates, where an
 * IF-MIB pin would yield nothing. See the module header.
 *
 * Pure: mutates `interfacesByAsset` in place and returns it.
 *
 * Collision handling — the IPsec SA status is AUTHORITATIVE. A tunnel can also
 * appear as a real `asset_interface_samples` row (e.g. an SNMP-polled gate
 * whose IF-MIB enumerates the tunnel as ifType 131). SNMP `ifOperStatus`
 * reports an IPsec tunnel interface as **always "up"** regardless of the actual
 * phase-1 SA state, so trusting that row would make `onlyUp` pin a tunnel whose
 * SA is down. So instead of skipping on a name collision, we OVERRIDE the
 * existing row's `operStatus` with the SA-derived value and tag it
 * `isIpsecTunnel` (which also routes its pin to `Asset.monitoredIpsecTunnels`
 * via `splitPinsByProvenance`, the correct field for an IPsec tunnel). New
 * tunnels with no real row are appended as before.
 *
 * operStatus mapping: only a fully-`down` tunnel maps to "down"; up / partial
 * / dynamic all map to "up" so the "only currently-up" filter on By type /
 * By pattern keeps healthy-but-not-fully-up tunnels (dial-up server templates
 * report "dynamic" and are operational by design).
 *
 * Dead-parent stamping: when the tunnel's `parentInterface` resolves to a real
 * interface row on the same asset that is down with no usable IP, the tunnel
 * row (synthetic or collided-real) is stamped `parentDownNoIp: true` so the
 * resolver excludes it from every block. A parent that is missing from the
 * list, has unknown operStatus, or is down but still addressed does NOT
 * trigger the exclusion — only positive evidence of a dead underlay does.
 */
export function mergeTunnelsIntoInterfaces(
  interfacesByAsset: Map<string, ResolverInterface[]>,
  tunnelsByAsset: Map<string, TunnelObservation[]>,
): Map<string, ResolverInterface[]> {
  for (const [assetId, tunnels] of tunnelsByAsset) {
    if (tunnels.length === 0) continue;
    let list = interfacesByAsset.get(assetId);
    if (!list) { list = []; interfacesByAsset.set(assetId, list); }
    const byName = new Map(list.map((i) => [i.ifName, i]));
    for (const t of tunnels) {
      if (!t.tunnelName) continue;
      // SA status wins: fully-down SA → "down"; up/partial/dynamic/null → "up".
      const saOperStatus = t.status === "down" ? "down" : "up";
      // Dead-parent check: parent row present, oper-down, and no usable IP.
      const parent = t.parentInterface ? byName.get(t.parentInterface) : undefined;
      const parentDead =
        parent !== undefined &&
        !parent.isIpsecTunnel &&
        parent.operStatus === "down" &&
        hasNoUsableIp(parent.ipAddress);
      const existingRow = byName.get(t.tunnelName);
      if (existingRow) {
        // Real interface row for this tunnel (e.g. always-"up" SNMP IF-MIB):
        // override with the authoritative SA status and mark it as IPsec.
        existingRow.operStatus = saOperStatus;
        existingRow.isIpsecTunnel = true;
        if (existingRow.ifType == null) existingRow.ifType = "tunnel";
        if (parentDead) existingRow.parentDownNoIp = true;
        continue;
      }
      const row: ResolverInterface = {
        ifName:        t.tunnelName,
        ifType:        "tunnel",
        operStatus:    saOperStatus,
        isIpsecTunnel: true,
      };
      if (parentDead) row.parentDownNoIp = true;
      list.push(row);
      byName.set(t.tunnelName, row);
    }
  }
  return interfacesByAsset;
}

// ─── DB-bound functions ─────────────────────────────────────────────────────

/**
 * Every currently-reported interface per asset, from the CURRENT-STATE
 * `AssetInterface` table (one row per (assetId, ifName) by construction, so no
 * DISTINCT ON is needed). Returns a Map keyed by assetId.
 *
 * When `includeIpsecTunnels` is set (fortigate class only — switches/APs have
 * no IPsec), the latest IPsec tunnel per (assetId, tunnelName) is also pulled
 * from asset_ipsec_tunnel_samples and merged in as synthetic tunnel-type
 * interfaces via `mergeTunnelsIntoInterfaces`. The two reads run in parallel.
 * Tunnels still come from the sample table — they have no current-state
 * equivalent yet (see the storage/ipsec parity note in the plan).
 */
/**
 * Staleness bound for the pin candidate list. Preserves the previous 72h
 * behaviour verbatim: it tolerates the long end of the pollInterval-linked
 * systemInfo cadence (up to 24h) plus a couple of missed scrapes, so an AP
 * that hasn't reported in three days drops off the "By name" checklist —
 * which is the right behaviour, since you can't usefully pin a port on a
 * device that stopped answering.
 */
const INTERFACE_STALE_MS = 72 * 60 * 60 * 1000;

// Exported for massPinService (the Assets-page Mass Pinning section), which
// needs the same interface + IPsec-tunnel inventory for an arbitrary asset-id set.
export async function loadLatestInterfaces(
  assetIds: string[],
  includeIpsecTunnels = false,
): Promise<Map<string, ResolverInterface[]>> {
  const out = new Map<string, ResolverInterface[]>();
  if (assetIds.length === 0) return out;
  // Reads the CURRENT-STATE inventory (`asset_interfaces`) — one row per
  // (assetId, ifName) already, so no DISTINCT ON and no hypertable scan. The
  // former 72h timestamp window existed purely to keep that DISTINCT ON off
  // the bulk of asset_interface_samples (the disaster pattern
  // interfaceTopologyService.ts had to fix: 13.5 min / 90M rows / 9 GB I/O on
  // prod); the equivalent staleness filter is now a cheap `lastSeen` bound.
  //
  // THIS READ IS WHY THE CURRENT-STATE TABLE HAS TO EXIST. It builds the
  // candidate list an operator pins FROM, so it must see interfaces that are
  // not yet pinned. Pointing it at the sample table after that table goes
  // pinned-only would deadlock the feature: only already-pinned interfaces
  // would be visible, and nothing new could ever be pinned.
  const staleCutoff = new Date(Date.now() - INTERFACE_STALE_MS);
  const ifacesPromise = prisma.assetInterface.findMany({
    where: { assetId: { in: assetIds }, lastSeen: { gt: staleCutoff } },
    select: { assetId: true, ifName: true, ifType: true, operStatus: true, ipAddress: true },
  });
  // IPsec tunnels (fortigate only): same 72h-bounded DISTINCT ON shape so the
  // picker surfaces phase1-interface tunnels the REST monitor endpoint omits.
  // parentInterface feeds the dead-parent exclusion in the merge helper.
  const tunnelsPromise = includeIpsecTunnels
    ? prisma.$queryRaw<Array<{ assetId: string; tunnelName: string; status: string | null; parentInterface: string | null }>>`
        SELECT DISTINCT ON ("assetId", "tunnelName")
          "assetId", "tunnelName", "status", "parentInterface"
        FROM asset_ipsec_tunnel_samples
        WHERE "assetId" = ANY(${assetIds}::text[])
          AND "timestamp" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '72 hours'
        ORDER BY "assetId", "tunnelName", "timestamp" DESC
      `
    : Promise.resolve([] as Array<{ assetId: string; tunnelName: string; status: string | null; parentInterface: string | null }>);

  const [rows, tunnelRows] = await Promise.all([ifacesPromise, tunnelsPromise]);
  for (const r of rows) {
    if (!out.has(r.assetId)) out.set(r.assetId, []);
    out.get(r.assetId)!.push({ ifName: r.ifName, ifType: r.ifType, operStatus: r.operStatus, ipAddress: r.ipAddress });
  }
  if (tunnelRows.length > 0) {
    const tunnelsByAsset = new Map<string, TunnelObservation[]>();
    for (const t of tunnelRows) {
      if (!tunnelsByAsset.has(t.assetId)) tunnelsByAsset.set(t.assetId, []);
      tunnelsByAsset.get(t.assetId)!.push({ tunnelName: t.tunnelName, status: t.status, parentInterface: t.parentInterface });
    }
    mergeTunnelsIntoInterfaces(out, tunnelsByAsset);
  }
  return out;
}

/**
 * Per-asset LLDP neighbor info, grouped by (assetId, localIfName). Joined to
 * Asset so we know the matched neighbor's assetType + monitored flag. Only
 * rows with a non-null matchedAssetId are returned — unmatched neighbors
 * can't satisfy "is an asset of type X" anyway.
 */
async function loadLldpByAsset(
  assetIds: string[],
): Promise<Map<string, LldpByIfName>> {
  const out = new Map<string, LldpByIfName>();
  if (assetIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{
    assetId: string;
    localIfName: string;
    matchedAssetType: string | null;
    matchedAssetMonitored: boolean | null;
  }>>`
    SELECT
      n."assetId"                 AS "assetId",
      n."localIfName"             AS "localIfName",
      a."assetType"::text         AS "matchedAssetType",
      a."monitored"               AS "matchedAssetMonitored"
    FROM asset_lldp_neighbors n
    LEFT JOIN assets a ON a.id = n."matchedAssetId"
    WHERE n."assetId" = ANY(${assetIds}::text[])
      AND n."matchedAssetId" IS NOT NULL
  `;
  for (const r of rows) {
    let perAsset = out.get(r.assetId);
    if (!perAsset) { perAsset = new Map(); out.set(r.assetId, perAsset); }
    let list = perAsset.get(r.localIfName);
    if (!list) { list = []; perAsset.set(r.localIfName, list); }
    list.push({
      matchedAssetType: r.matchedAssetType,
      matchedAssetMonitored: r.matchedAssetMonitored === true,
    });
  }
  return out;
}

/** True iff the selection mentions byLldp (so the apply path knows to load LLDP). */
function selectionUsesLldp(sel: AutoMonitorSelection): boolean {
  return !!sel?.byLldp && sel.byLldp.neighborTypes.length > 0;
}

/**
 * Peer-inferred LLDP matches synthesized from `Asset.fortinetTopology` so
 * "By LLDP" covers managed FortiAPs whose FortiSwitch silently consumes
 * LLDP without re-publishing via SNMP LLDP-MIB. Same data source as the
 * inferred Neighbor column on the System tab (peerInferredLldpService).
 *
 * Three class-aware queries:
 *   - klass=fortigate     → child switches name this FG as controllerFortigate.
 *                           Emit on FG's id at localIfName = switch.uplinkInterface
 *                           (FortiGate-side FortiLink port name).
 *   - klass=fortiswitch   → child APs name this switch as parentSwitch. Emit
 *                           on switch's id at localIfName = ap.parentPort.
 *   - klass=fortiap       → self has parentSwitch + uplinkInterface (AP-local
 *                           port). Emit on AP's id at that localIfName, with
 *                           the matched switch's monitored flag.
 */
async function loadInferredLldpByAsset(
  assets: ReadonlyArray<{
    id: string;
    hostname: string | null;
    serialNumber?: string | null;
    fortinetTopology?: unknown;
  }>,
  klass: AutoMonitorClass,
): Promise<Map<string, LldpByIfName>> {
  const out = new Map<string, LldpByIfName>();
  // Match the child's stamp against BOTH identities of each in-scope asset.
  // `controllerFortigate` holds FMG's device NAME, not the gate's configured
  // hostname, so a hostname-only match found no child switches at all on
  // installs where the two differ (prod 2026-08-12) — the FortiGate class then
  // auto-monitored zero FortiLink ports. `parentSwitch` has the mirror problem:
  // it carries the switch-id (= serial) while the hostname may be a label.
  // See utils/fortinetParentKey.ts for the shared resolution order.
  const keys: string[] = [];
  const idByKey = new Map<string, string>();
  for (const a of assets) {
    // Hostname first so it wins a collision, preserving pre-fix resolution.
    // `deviceName` (the gate's own name in FMG) is what a child's
    // `controllerFortigate` actually holds, and is the key that resolves rows
    // stamped before `controllerSerial` existed.
    for (const k of [a.hostname, a.serialNumber, readFirewallDeviceName(a.fortinetTopology)]) {
      if (!k) continue;
      if (idByKey.has(k)) continue;
      idByKey.set(k, a.id);
      keys.push(k);
    }
  }
  if (keys.length === 0) return out;

  const add = (selfId: string, ifName: string, matchedAssetType: string, matchedMonitored: boolean) => {
    let perAsset = out.get(selfId);
    if (!perAsset) { perAsset = new Map(); out.set(selfId, perAsset); }
    let list = perAsset.get(ifName);
    if (!list) { list = []; perAsset.set(ifName, list); }
    list.push({ matchedAssetType, matchedAssetMonitored: matchedMonitored });
  };

  if (klass === "fortigate") {
    const rows = await prisma.$queryRaw<Array<{
      controllerFortigate: string;
      uplinkInterface: string;
      monitored: boolean;
      controllerSerial: string | null;
    }>>`
      SELECT
        "fortinetTopology"->>'controllerFortigate' AS "controllerFortigate",
        "fortinetTopology"->>'controllerSerial'    AS "controllerSerial",
        "fortinetTopology"->>'uplinkInterface'     AS "uplinkInterface",
        monitored                                  AS "monitored"
      FROM assets
      WHERE "assetType"::text = 'switch'
        AND (
          "fortinetTopology"->>'controllerSerial'    = ANY(${keys}::text[])
          OR "fortinetTopology"->>'controllerFortigate' = ANY(${keys}::text[])
        )
        AND "fortinetTopology"->>'uplinkInterface' IS NOT NULL
    `;
    for (const r of rows) {
      // Serial first — definitive. Falls back to the FMG device name.
      const fgId = (r.controllerSerial ? idByKey.get(r.controllerSerial) : undefined)
        ?? idByKey.get(r.controllerFortigate);
      if (!fgId) continue;
      add(fgId, r.uplinkInterface, "switch", r.monitored === true);
    }
  } else if (klass === "fortiswitch") {
    const rows = await prisma.$queryRaw<Array<{
      parentSwitch: string;
      parentPort: string;
      monitored: boolean;
    }>>`
      SELECT
        "fortinetTopology"->>'parentSwitch' AS "parentSwitch",
        "fortinetTopology"->>'parentPort'   AS "parentPort",
        monitored                           AS "monitored"
      FROM assets
      WHERE "assetType"::text = 'access_point'
        AND "fortinetTopology"->>'parentSwitch' = ANY(${keys}::text[])
        AND "fortinetTopology"->>'parentPort' IS NOT NULL
    `;
    for (const r of rows) {
      const swId = idByKey.get(r.parentSwitch);
      if (!swId) continue;
      add(swId, r.parentPort, "access_point", r.monitored === true);
    }
  } else if (klass === "fortiap") {
    // For each in-scope AP that has parentSwitch + uplinkInterface, resolve
    // the switch by hostname so we can carry its monitored flag.
    const apRows = await prisma.$queryRaw<Array<{
      id: string;
      parentSwitch: string;
      uplinkInterface: string;
    }>>`
      SELECT
        id,
        "fortinetTopology"->>'parentSwitch'     AS "parentSwitch",
        "fortinetTopology"->>'uplinkInterface'  AS "uplinkInterface"
      FROM assets
      WHERE id = ANY(${assets.map((a) => a.id)}::text[])
        AND "fortinetTopology"->>'parentSwitch' IS NOT NULL
        AND "fortinetTopology"->>'uplinkInterface' IS NOT NULL
    `;
    if (apRows.length > 0) {
      // The AP's parentSwitch stamp is an LLDP system name — usually the
      // switch-id (= serial), sometimes the hostname. Look the switch up by
      // either, or the AP contributes no inferred neighbor at all.
      const switchKeys = [...new Set(apRows.map((r) => r.parentSwitch))];
      const switches = await prisma.asset.findMany({
        where: {
          assetType: "switch" as any,
          OR: [{ hostname: { in: switchKeys } }, { serialNumber: { in: switchKeys } }],
        },
        select: { hostname: true, serialNumber: true, monitored: true },
      });
      const swMonitoredByKey = new Map<string, boolean>();
      for (const sw of switches) {
        const mon = sw.monitored === true;
        if (sw.hostname) swMonitoredByKey.set(sw.hostname, mon);
        if (sw.serialNumber && !swMonitoredByKey.has(sw.serialNumber)) swMonitoredByKey.set(sw.serialNumber, mon);
      }
      for (const r of apRows) {
        if (!swMonitoredByKey.has(r.parentSwitch)) continue;
        add(r.id, r.uplinkInterface, "switch", swMonitoredByKey.get(r.parentSwitch)!);
      }
    }
  }

  return out;
}

/**
 * Rewrite fortiap inferred-LLDP keys from the FortiAP CLI naming used by
 * discovery (`lan1`, `lan2`, ...) into the SNMP-canonical names the AP's
 * own IF-MIB exposes (`eth0`, `eth1`, ...) so the entries line up with the
 * interface table AND with what `Asset.monitoredInterfaces` would have to
 * contain for fast-cadence pinning to actually scrape a real ifIndex.
 * Mutates `inferred` in place — collisions on rewrite merge into the
 * existing key. See `src/utils/fortiapInterfaceAlias.ts`.
 */
function normalizeFortiapInferredLldp(
  inferred: Map<string, LldpByIfName>,
  interfacesByAsset: Map<string, ResolverInterface[]>,
): void {
  for (const [assetId, byIf] of inferred) {
    const known = interfacesByAsset.get(assetId);
    if (!known || known.length === 0) continue;
    const knownIfNames = new Set(known.map((i) => i.ifName));
    const renames: Array<{ from: string; to: string }> = [];
    for (const ifName of byIf.keys()) {
      const normalized = normalizeFortiapInterfaceName(ifName, knownIfNames);
      if (normalized !== ifName) renames.push({ from: ifName, to: normalized });
    }
    for (const { from, to } of renames) {
      const matches = byIf.get(from)!;
      byIf.delete(from);
      const existing = byIf.get(to);
      if (existing) existing.push(...matches);
      else byIf.set(to, matches);
    }
  }
}

/**
 * Merge inferred matches into the real-LLDP map per (assetId, ifName).
 * Real entries come first, inferred appended after. Duplicates within an
 * ifName are harmless — `resolvePinnedInterfaces` looks for ANY match
 * satisfying the byLldp filter — so no dedupe.
 */
function mergeLldpMaps(
  base: Map<string, LldpByIfName>,
  extra: Map<string, LldpByIfName>,
): Map<string, LldpByIfName> {
  if (extra.size === 0) return base;
  for (const [assetId, extraByIf] of extra) {
    let baseByIf = base.get(assetId);
    if (!baseByIf) { baseByIf = new Map(); base.set(assetId, baseByIf); }
    for (const [ifName, matches] of extraByIf) {
      const existing = baseByIf.get(ifName);
      if (!existing) baseByIf.set(ifName, matches.slice());
      else existing.push(...matches);
    }
  }
  return base;
}

export interface AggregateRow {
  ifName: string;
  ifType: string | null;
  deviceCount: number;
  devices: Array<{ assetId: string; hostname: string | null; ipAddress: string | null }>;
}

/**
 * Aggregate every interface seen across the integration's assets of one class,
 * grouped by ifName. Powers the "By name" checklist and the "By type" counts.
 */
export async function getInterfaceAggregate(
  integrationId: string,
  klass: AutoMonitorClass,
): Promise<AggregateRow[]> {
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true, ipAddress: true },
  });
  if (assets.length === 0) return [];
  const byAssetId = new Map(assets.map((a) => [a.id, a]));
  const interfacesByAsset = await loadLatestInterfaces(assets.map((a) => a.id), klass === "fortigate");

  // Group by ifName across all assets.
  const byIfName = new Map<string, AggregateRow>();
  for (const [assetId, ifaces] of interfacesByAsset) {
    const asset = byAssetId.get(assetId);
    if (!asset) continue;
    for (const i of ifaces) {
      let row = byIfName.get(i.ifName);
      if (!row) {
        row = { ifName: i.ifName, ifType: i.ifType, deviceCount: 0, devices: [] };
        byIfName.set(i.ifName, row);
      }
      // Prefer a non-null ifType when one shows up later.
      if (row.ifType === null && i.ifType !== null) row.ifType = i.ifType;
      row.deviceCount += 1;
      row.devices.push({ assetId, hostname: asset.hostname, ipAddress: asset.ipAddress });
    }
  }

  return Array.from(byIfName.values()).sort((a, b) => {
    if (b.deviceCount !== a.deviceCount) return b.deviceCount - a.deviceCount;
    return a.ifName.localeCompare(b.ifName);
  });
}

// ─── Precomputed aggregate cache ─────────────────────────────────────────────
// The "By name" checklist source is recomputed at the tail of every successful
// discovery run and stashed on Integration.interfaceAggregateCache, so the edit
// modal loads it instantly instead of running the fleet-wide DISTINCT ON in
// loadLatestInterfaces on every open. Only the three fields the UI renders
// (ifName / ifType / deviceCount) are cached — the heavy per-row devices[] list
// is dropped, keeping the payload a few KB even on a big FortiGate.

/** Which interface classes each integration type carries (drives the cache build). */
const INTERFACE_CLASSES_BY_TYPE: Record<string, AutoMonitorClass[]> = {
  fortimanager:    ["fortigate", "fortiswitch", "fortiap"],
  fortigate:       ["fortigate", "fortiswitch", "fortiap"],
  entraid:         ["workstation", "server"],
  activedirectory: ["workstation", "server"],
  windowsserver:   ["workstation", "server"],
  azurearc:        ["workstation", "server"],
  // VMs only — ESXi hosts have no agent-fed interface samples to pin.
  vcenter:         ["virtual_machine"],
};

export interface CachedAggregateRow {
  ifName: string;
  ifType: string | null;
  deviceCount: number;
}

export interface InterfaceAggregateCacheEntry {
  computedAt: string; // ISO8601
  rows: CachedAggregateRow[];
}

/** Map keyed by AutoMonitorClass; the persisted shape of Integration.interfaceAggregateCache. */
export type InterfaceAggregateCache = Record<string, InterfaceAggregateCacheEntry>;

/**
 * Recompute the "By name" aggregate for every interface class this integration
 * carries and persist it to Integration.interfaceAggregateCache. Best-effort:
 * callers (the discovery success path) must not let a failure here fail the run.
 */
export async function computeAndCacheInterfaceAggregate(
  integrationId: string,
  integrationType: string,
  computedAtIso?: string,
): Promise<void> {
  const classes = INTERFACE_CLASSES_BY_TYPE[integrationType];
  if (!classes) return;
  const computedAt = computedAtIso ?? new Date().toISOString();
  const cache: InterfaceAggregateCache = {};
  for (const klass of classes) {
    const rows = await getInterfaceAggregate(integrationId, klass);
    cache[klass] = {
      computedAt,
      rows: rows.map((r) => ({ ifName: r.ifName, ifType: r.ifType, deviceCount: r.deviceCount })),
    };
  }
  await prisma.integration.update({
    where: { id: integrationId },
    data: { interfaceAggregateCache: cache as any },
  });
}

/**
 * Read the precomputed aggregate for one class. Returns null when the cache is
 * absent or has no entry for this class (e.g. before the integration's first
 * post-feature discovery) so the route can fall back to a live compute.
 */
export async function getCachedInterfaceAggregate(
  integrationId: string,
  klass: AutoMonitorClass,
): Promise<InterfaceAggregateCacheEntry | null> {
  const integ = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { interfaceAggregateCache: true },
  });
  const cache = (integ?.interfaceAggregateCache ?? null) as InterfaceAggregateCache | null;
  return cache?.[klass] ?? null;
}

export interface PreviewResult {
  deviceCount: number;
  interfaceCount: number;
  perDeviceMax: number;
  sampleDevices: Array<{ hostname: string | null; pinNames: string[] }>;
  /**
   * Per-asset set difference between `selection` and the optional
   * `baselineSelection` (typically the previous in-flight selection or the
   * saved selection). Only present when `baselineSelection` is supplied to
   * `previewAutoMonitorForClass`. Drives the "+X / −Y" delta hint on the
   * auto-monitor card's live preview so operators see what each checkbox
   * toggle just changed without re-counting by hand.
   *
   * `addedCount` / `removedCount` count distinct (assetId, ifName) pairs,
   * not raw ifName strings — the same ifName on two devices is two pairs.
   * `addedSample` / `removedSample` carry up to 5 illustrative entries each
   * for the UI to surface.
   */
  diff?: {
    addedCount: number;
    removedCount: number;
    addedSample: Array<{ hostname: string | null; ifName: string }>;
    removedSample: Array<{ hostname: string | null; ifName: string }>;
  };
}

/**
 * Compute the per-asset pin set for `selection` against an already-loaded
 * (assets, interfacesByAsset, lldpByAsset) view. Pure — no DB I/O. Used by
 * the diff path so we can run two pin computations against one DB fetch.
 */
function computePinsByAsset(
  assets: ReadonlyArray<{ id: string; hostname: string | null }>,
  interfacesByAsset: Map<string, ResolverInterface[]>,
  lldpByAsset: Map<string, LldpByIfName>,
  selection: AutoMonitorSelection,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!selection) return out;
  for (const a of assets) {
    const pin = resolvePinnedInterfaces(
      selection,
      interfacesByAsset.get(a.id) ?? [],
      lldpByAsset.get(a.id),
    );
    if (pin.length === 0) continue;
    out.set(a.id, pin);
  }
  return out;
}

/**
 * Preview what `selection` would pin if applied right now. Does not write.
 * `interfaceCount` is the sum of pin lengths — i.e. what *this selection
 * alone* would produce, not unioned with whatever the operator pinned by
 * hand. That's intentional: the preview answers "what does my selection
 * cover", and existing manual pins are a separate concern.
 *
 * When `baselineSelection` is non-undefined the response carries a `diff`
 * block enumerating per-asset (assetId, ifName) pairs that the change in
 * selection just added or removed. `null` baselineSelection counts as "no
 * pins at all" so the diff shows the full current set as additions — that
 * matches the natural reading of "you just turned this block on for the
 * first time, here's what +X means."
 */
export async function previewAutoMonitorForClass(
  integrationId: string,
  klass: AutoMonitorClass,
  selection: AutoMonitorSelection,
  baselineSelection?: AutoMonitorSelection,
): Promise<PreviewResult> {
  const empty: PreviewResult = { deviceCount: 0, interfaceCount: 0, perDeviceMax: 0, sampleDevices: [] };
  const wantDiff = baselineSelection !== undefined;
  if (!selection && !wantDiff) return empty;

  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true, serialNumber: true, fortinetTopology: true },
  });
  if (assets.length === 0) {
    return wantDiff
      ? { ...empty, diff: { addedCount: 0, removedCount: 0, addedSample: [], removedSample: [] } }
      : empty;
  }
  const ids = assets.map((a) => a.id);
  // LLDP join is only needed if either selection uses byLldp; load once.
  const needLldp = selectionUsesLldp(selection) || (wantDiff && selectionUsesLldp(baselineSelection ?? null));
  const [interfacesByAsset, realLldp, inferredLldp] = await Promise.all([
    loadLatestInterfaces(ids, klass === "fortigate"),
    needLldp ? loadLldpByAsset(ids) : Promise.resolve(new Map<string, LldpByIfName>()),
    needLldp ? loadInferredLldpByAsset(assets, klass) : Promise.resolve(new Map<string, LldpByIfName>()),
  ]);
  if (needLldp && klass === "fortiap") normalizeFortiapInferredLldp(inferredLldp, interfacesByAsset);
  const lldpByAsset = mergeLldpMaps(realLldp, inferredLldp);

  const currentPins = computePinsByAsset(assets, interfacesByAsset, lldpByAsset, selection);

  // Build the preview shape from currentPins.
  let deviceCount = 0;
  let interfaceCount = 0;
  let perDeviceMax = 0;
  const matched: Array<{ hostname: string | null; pinNames: string[] }> = [];
  for (const a of assets) {
    const pin = currentPins.get(a.id);
    if (!pin || pin.length === 0) continue;
    deviceCount += 1;
    interfaceCount += pin.length;
    if (pin.length > perDeviceMax) perDeviceMax = pin.length;
    matched.push({ hostname: a.hostname, pinNames: pin });
  }
  matched.sort((x, y) => (x.hostname || "").localeCompare(y.hostname || ""));
  const result: PreviewResult = {
    deviceCount,
    interfaceCount,
    perDeviceMax,
    sampleDevices: matched.slice(0, 5),
  };

  if (!wantDiff) return result;

  // Diff currentPins against baselinePins, one (assetId, ifName) pair at a
  // time. Hostname is captured per-asset so the sample can render a useful
  // "hostname · ifName" pair without a second lookup.
  const baselinePins = computePinsByAsset(assets, interfacesByAsset, lldpByAsset, baselineSelection ?? null);
  const hostnameById = new Map(assets.map((a) => [a.id, a.hostname]));
  let addedCount = 0;
  let removedCount = 0;
  const addedSample: Array<{ hostname: string | null; ifName: string }> = [];
  const removedSample: Array<{ hostname: string | null; ifName: string }> = [];
  // Walk every asset that appears in either set so partial overlaps are
  // counted correctly. Per-asset comparison is cheap because pin lists are
  // small (rarely >50 interfaces).
  const allIds = new Set<string>([...currentPins.keys(), ...baselinePins.keys()]);
  for (const id of allIds) {
    const cur = currentPins.get(id) ?? [];
    const base = baselinePins.get(id) ?? [];
    if (cur.length === 0 && base.length === 0) continue;
    const baseSet = new Set(base);
    const curSet = new Set(cur);
    for (const n of cur) {
      if (!baseSet.has(n)) {
        addedCount += 1;
        if (addedSample.length < 5) addedSample.push({ hostname: hostnameById.get(id) ?? null, ifName: n });
      }
    }
    for (const n of base) {
      if (!curSet.has(n)) {
        removedCount += 1;
        if (removedSample.length < 5) removedSample.push({ hostname: hostnameById.get(id) ?? null, ifName: n });
      }
    }
  }
  result.diff = { addedCount, removedCount, addedSample, removedSample };
  return result;
}

export interface ApplyResult {
  devices: number;
  interfacesAdded: number;
  perDeviceMax: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; pinNames: string[] }>;
}

/**
 * Apply `selection` to every asset of `klass` discovered by `integrationId`.
 * Strictly additive: pin = union(existing, computed); we never strip. Skips
 * the write when nothing would change so back-to-back discoveries stay quiet.
 */
export async function applyAutoMonitorForClass(
  integrationId: string,
  klass: AutoMonitorClass,
  selection: AutoMonitorSelection,
  _actor?: string,
): Promise<ApplyResult> {
  const empty: ApplyResult = { devices: 0, interfacesAdded: 0, perDeviceMax: 0, sampleDevices: [] };
  if (!selection) return empty;
  const assetType = CLASS_TO_ASSET_TYPE[klass];
  const assets = await prisma.asset.findMany({
    where: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    select: { id: true, hostname: true, serialNumber: true, fortinetTopology: true, monitoredInterfaces: true, monitoredIpsecTunnels: true },
  });
  if (assets.length === 0) return empty;
  const ids = assets.map((a) => a.id);
  const needLldp = selectionUsesLldp(selection);
  const [interfacesByAsset, realLldp, inferredLldp] = await Promise.all([
    loadLatestInterfaces(ids, klass === "fortigate"),
    needLldp ? loadLldpByAsset(ids) : Promise.resolve(new Map<string, LldpByIfName>()),
    needLldp ? loadInferredLldpByAsset(assets, klass) : Promise.resolve(new Map<string, LldpByIfName>()),
  ]);
  if (needLldp && klass === "fortiap") normalizeFortiapInferredLldp(inferredLldp, interfacesByAsset);
  const lldpByAsset = mergeLldpMaps(realLldp, inferredLldp);

  // Two-phase apply: compute every pending update in memory FIRST, then
  // batch the prisma.asset.update calls in chunks so the network round-trips
  // don't serialize. The previous shape did `await prisma.asset.update` once
  // per asset inside the resolver loop, which on a fleet of a few hundred
  // switches stacked up enough round-trips to wedge the modal's "Applying..."
  // state for minutes (and exhaust the DB connection pool's headroom for the
  // rest of the app).
  //
  // Idempotency holds because the apply pass is strictly additive — a half-
  // landed batch produces the same final pin set as a fully-landed one
  // re-run (the next call recomputes `fresh` against the current
  // monitoredInterfaces and only fires for the rows that still need a
  // change). So we use Promise.allSettled rather than a $transaction; one
  // failed write doesn't block the other writes from landing, and the
  // operator just re-clicks Apply if they care to catch up.
  interface PendingUpdate {
    assetId:   string;
    hostname:  string | null;
    // Fresh names per destination field (computed pins not already pinned).
    freshIfaces:  string[];
    freshTunnels: string[];
    // Full arrays to write. Only the field with fresh additions is rebuilt;
    // the other is passed through unchanged (idempotent — same value re-set).
    unionedIfaces:  string[];
    unionedTunnels: string[];
  }
  const pending: PendingUpdate[] = [];
  let perDeviceMax = 0;
  for (const a of assets) {
    const ifaceList = interfacesByAsset.get(a.id) ?? [];
    const computed = resolvePinnedInterfaces(selection, ifaceList, lldpByAsset.get(a.id));
    if (computed.length === 0) continue;
    // Route each pin to its destination field by provenance: synthetic IPsec
    // tunnel rows → monitoredIpsecTunnels, real interfaces → monitoredInterfaces.
    const { interfaces: pickedIfaces, ipsecTunnels: pickedTunnels } = splitPinsByProvenance(computed, ifaceList);
    const existingIf  = new Set(a.monitoredInterfaces);
    const existingTun = new Set(a.monitoredIpsecTunnels);
    const freshIfaces  = pickedIfaces.filter((n) => !existingIf.has(n));
    const freshTunnels = pickedTunnels.filter((n) => !existingTun.has(n));
    if (freshIfaces.length === 0 && freshTunnels.length === 0) continue;
    const unionedIfaces  = freshIfaces.length  ? [...a.monitoredInterfaces, ...freshIfaces]    : a.monitoredInterfaces;
    const unionedTunnels = freshTunnels.length ? [...a.monitoredIpsecTunnels, ...freshTunnels] : a.monitoredIpsecTunnels;
    const totalPins = unionedIfaces.length + unionedTunnels.length;
    if (totalPins > perDeviceMax) perDeviceMax = totalPins;
    pending.push({
      assetId:        a.id,
      hostname:       a.hostname,
      freshIfaces,
      freshTunnels,
      unionedIfaces,
      unionedTunnels,
    });
  }
  if (pending.length === 0) return { devices: 0, interfacesAdded: 0, perDeviceMax: 0, sampleDevices: [] };

  // Chunked Promise.allSettled — mirrors `batchSettled` in
  // src/services/discovery/discoveryEngine.ts. 50 is the conventional batch size in
  // this codebase; small enough to keep pool headroom for the rest of the
  // app on big fleets but large enough to amortize the per-batch overhead.
  const BATCH_SIZE = 50;
  let devices = 0;
  let interfacesAdded = 0;
  for (const chunk of chunkArray(pending, BATCH_SIZE)) {
    const results = await Promise.allSettled(
      chunk.map((p) =>
        prisma.asset.update({
          where: { id: p.assetId },
          // Write both fields: interface pins to monitoredInterfaces, IPsec
          // tunnel pins to monitoredIpsecTunnels. The unchanged field is re-set
          // to its current value (harmless / idempotent).
          data:  { monitoredInterfaces: p.unionedIfaces, monitoredIpsecTunnels: p.unionedTunnels },
        }),
      ),
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const p = chunk[k];
      if (!r || !p) continue;
      if (r.status === "fulfilled") {
        devices += 1;
        // interfacesAdded reports total fresh fast-poll pins added across both
        // fields (real interfaces + IPsec tunnels) — a pin is a pin to the toast.
        interfacesAdded += p.freshIfaces.length + p.freshTunnels.length;
      }
    }
  }

  // Sample devices used to be filled inline as updates landed; rebuild them
  // from the first 5 successful entries in pending order. Order is stable
  // across re-applies which keeps the toast deterministic.
  const sampleDevices: ApplyResult["sampleDevices"] = pending.slice(0, 5).map((p) => ({
    assetId:  p.assetId,
    hostname: p.hostname,
    pinNames: [...p.freshIfaces, ...p.freshTunnels],
  }));

  return { devices, interfacesAdded, perDeviceMax, sampleDevices };
}

// ─── Legacy shape coercion ──────────────────────────────────────────────────

/**
 * Coerce the pre-multi-block discriminated-union shape into the new shape.
 * Used both by the Zod parser (incoming legacy bodies) and by the one-shot
 * migration job (existing stored configs).
 *
 *   { mode: "names",    names }                  → { byNames:    { names } }
 *   { mode: "wildcard", patterns, onlyUp }       → { byPatterns: { patterns, regex: false, onlyUp } }
 *   { mode: "type",     types, onlyUp }          → { byTypes:    { types, onlyUp } }
 *
 * Already-new-shape objects pass through. Returns null for null/empty input.
 */
export function coerceLegacySelection(input: any): AutoMonitorSelection {
  if (!input || typeof input !== "object") return null;

  // New-shape: any of the four blocks present.
  if ("byNames" in input || "byPatterns" in input || "byTypes" in input || "byLldp" in input) {
    return input as AutoMonitorSelection;
  }

  // Legacy: { mode, ... }
  if (input.mode === "names" && Array.isArray(input.names)) {
    return { byNames: { names: input.names.slice() } };
  }
  if (input.mode === "wildcard" && Array.isArray(input.patterns)) {
    return {
      byPatterns: {
        patterns: input.patterns.slice(),
        regex:    false,
        onlyUp:   input.onlyUp === true,
      },
    };
  }
  if (input.mode === "type" && Array.isArray(input.types)) {
    return {
      byTypes: {
        types:  input.types.slice(),
        onlyUp: input.onlyUp !== false,
      },
    };
  }

  return null;
}
