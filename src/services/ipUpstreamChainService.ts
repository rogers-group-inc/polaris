/**
 * src/services/ipUpstreamChainService.ts
 *
 * The IP-keyed upstream chain: for an asset that has an address but NO MAC,
 * walk IP → owning FortiGate → that gate's ARP cache → MAC → switch forwarding
 * table / AP station table, and stamp `lastSeenSwitch` / `lastSeenAp`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every other writer of those two columns is keyed by MAC: discovery Phase 7.5
 * matches the FortiSwitch MAC map through `assetIdx.findByMac`, the FortiAP
 * station scrape matches `staMacAddr` through the LLDP match index, and the
 * SNMP forwarding-database persist resolves `matchedAssetId` by MAC. An asset
 * that arrived from Active Directory, Azure Arc, a vCenter cluster, an active
 * scan or the operator form carries an IP and nothing else, so none of those
 * writers can ever reach it — even though the gate's neighbour cache and the
 * switches' tables already hold every fact needed. This service reads those
 * tables (`AssetArpEntry`, `AssetMacTableEntry`, `AssetWirelessStation` — all
 * current-state, all written by something else) and derives what the MAC-keyed
 * writers would have derived had the MAC been known. No device I/O.
 *
 * ── Scope: MAC-less assets ONLY ─────────────────────────────────────────────
 * The sweep deliberately never touches an asset that has a MAC. Those are
 * already served by Phase 7.5 / the station scrape, and a second writer with a
 * different label format (`<hostname>/<ifName>` here vs `<switchId>/<portName>`
 * there) would ping-pong the column every tick and audit both halves as
 * "changes" forever. This job only writes what no other writer can.
 *
 * ── The three rules it has to respect ───────────────────────────────────────
 *  1. **The ARP lookup is scoped to the owning gate** (business rule 41: the
 *     containing subnet's chassis serial first, FortiManager device name
 *     second, resolved through utils/fortinetParentKey.ts — never a hostname
 *     match). Overlapping RFC1918 ranges behind different gates on one FMG
 *     would otherwise cross-match, the same reason Phase 7.6 keys ARP evidence
 *     by (gate, ip). When no gate can be named for the address, the rows are
 *     accepted only if exactly ONE gate reports the address at all — two gates
 *     answering is the overlap case and is skipped.
 *  2. **Freshness on both ends** (business rule 40's claim model). The asset's
 *     own claim on the address must be current — operator-owned claims never
 *     expire, a discovered one must have been re-asserted within
 *     `CLAIM_FRESH_DAYS` — and the ARP / FDB / station rows must have been seen
 *     within `EVIDENCE_FRESH_MS`. A recycled DHCP address would otherwise hand a
 *     departed laptop the printer's switch port.
 *  3. **Two MACs at one address is no answer** (business rule 26's ARP rule): a
 *     duplicate on the wire is not evidence to act on, so the address is
 *     skipped rather than guessed at.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 * `lastSeenSwitch` = `<switch hostname>/<ifName>` on the LOWEST-cardinality
 * port that learned the MAC (Phase 7.5's rank rule: an access port sees one
 * MAC, the uplink trunk above it sees fifty), `lastSeenAp` = the AP's hostname.
 * Only on change, never cleared (absence of evidence is not a move), sorted by
 * asset id inside one `$transaction` (the documented lastSeenAp deadlock fix),
 * with one `asset.switch_port.changed` / `asset.wireless_ap.changed` Event per
 * moved value written AFTER the commit through `buildConnectionChangedEvent`.
 * The MAC itself is NOT adopted onto the asset: adopting it would make the row
 * eligible for MAC-keyed dedupe and merge, and a wrong adoption merges two
 * devices — that step stays a deliberate follow-up behind an opt-in.
 *
 * ── Scale ───────────────────────────────────────────────────────────────────
 * Set-based end to end: one claim query, one containment query, one firewall
 * load, one ARP query per 500 addresses, one FDB query + one grouped
 * cardinality query per 500 MACs, one station query, one batched update. No
 * per-asset awaits. At 2000 assets the MAC-less subset is a few hundred rows.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { chunkArray } from "../utils/chunk.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { UNMONITORABLE_STATUSES } from "../utils/assetInvariants.js";
import { buildIpContexts } from "./subnetService.js";
import { claimIsOperatorOwned, CLAIM_FRESH_DAYS } from "./duplicateIpConflictService.js";
import { buildConnectionChangedEvent, logEventsBatch } from "./eventLogService.js";
import {
  buildInfraParentIndex,
  resolveInfraParentAsset,
  type InfraParentCandidate,
} from "../utils/fortinetParentKey.js";

/** ARP / FDB / station rows older than this are not evidence. The tables are
 *  delete-replaced per scrape, so a row this old means its writer stopped
 *  answering (offline gate, switch dropped from monitoring) — not that the
 *  device is still there. Generous because discovery cadence is the
 *  integration's pollInterval, which operators set to hours. */
export const EVIDENCE_FRESH_MS = 24 * 60 * 60 * 1000;

/** Rows per IN clause. */
const IN_CHUNK = 500;
/** Asset updates per transaction. */
const UPDATE_CHUNK = 200;
/** Ceiling on candidates per pass — a fleet past this is paged across ticks. */
const CANDIDATE_CAP = 5000;

/** Fortinet infrastructure carries its topology on `fortinetTopology`, never
 *  on these two columns (Phase 7.5 makes the same exclusion). */
const INFRA_TYPES = ["firewall", "switch", "access_point"];

const ACTOR = "system:upstream-chain";
const SOURCE = "ip-upstream-chain";

// ─── Row shapes (kept minimal — these are the only fields the decisions read) ─

export interface MaclessClaimRow {
  id: string;
  hostname: string | null;
  ip: string;
  ipSource: string | null;
  ipOverride: string | null;
  lastSeen: Date | null;
  /** AssetIpHistory.lastSeen for (asset, ip); null when no history row. */
  ipLastSeen: Date | null;
  lastSeenSwitch: string | null;
  lastSeenAp: string | null;
}

export interface ArpRowLite {
  /** The gate whose cache holds the row. */
  assetId: string;
  ipAddress: string;
  macAddress: string;
  lastSeen: Date;
}

export interface FdbRowLite {
  /** The switch whose forwarding database holds the row. */
  assetId: string;
  macAddress: string;
  ifName: string;
  lastSeen: Date;
}

export interface StationRowLite {
  apAssetId: string;
  staMacAddr: string;
  staIpAddr: string | null;
  lastSeen: Date;
}

export interface IpUpstreamChainResult {
  /** MAC-less assets with a current claim on an address. */
  candidates: number;
  /** Candidates skipped because their address claim is stale. */
  staleClaims: number;
  /** Candidates whose address resolved to exactly one MAC. */
  resolvedMac: number;
  /** Addresses skipped because two MACs (or two unscoped gates) answered. */
  ambiguous: number;
  switchStamps: number;
  apStamps: number;
}

// ─── Pure decisions (unit-tested in tests/unit/ipUpstreamChain.test.ts) ──────

/**
 * Is the asset's claim on its address still current? Operator-owned claims
 * never expire (rule 40); a discovered one must have been re-asserted — or,
 * for a row with no history, the device seen — since `cutoff`.
 */
export function claimIsFresh(row: MaclessClaimRow, cutoff: Date): boolean {
  if (claimIsOperatorOwned(row)) return true;
  const ts = row.ipLastSeen ?? row.lastSeen;
  if (!ts) return false;
  return new Date(ts).getTime() >= cutoff.getTime();
}

/**
 * The one MAC the address answers on, from the ARP rows recorded for it.
 *
 * With the owning gate known, only ITS rows count. Without one, the rows are
 * accepted only when a single gate reports the address — two gates answering
 * is exactly the overlapping-RFC1918 case the scoping exists to avoid. Either
 * way, two distinct MACs is a duplicate on the wire and yields null.
 */
export function pickArpMac(
  rows: readonly ArpRowLite[],
  gateAssetId: string | null,
): { mac: string; gateAssetId: string } | "ambiguous" | null {
  let scoped: readonly ArpRowLite[];
  if (gateAssetId) {
    scoped = rows.filter((r) => r.assetId === gateAssetId);
  } else {
    const gates = new Set(rows.map((r) => r.assetId));
    if (gates.size > 1) return "ambiguous";
    scoped = rows;
  }
  if (scoped.length === 0) return null;
  const macs = new Set(scoped.map((r) => r.macAddress));
  if (macs.size > 1) return "ambiguous";
  return { mac: scoped[0].macAddress, gateAssetId: scoped[0].assetId };
}

/**
 * The port a MAC is actually attached to, out of every port that learned it.
 *
 * Lowest MAC cardinality wins (an access port with one device sees one MAC; the
 * trunk above it sees everything behind it), then the freshest sighting, then a
 * stable name order so two ties can't flip the stamp between ticks.
 */
export function pickBestSwitchPort(
  rows: readonly FdbRowLite[],
  portCardinality: ReadonlyMap<string, number>,
): FdbRowLite | null {
  let best: FdbRowLite | null = null;
  let bestRank = Infinity;
  for (const r of rows) {
    const rank = portCardinality.get(portKey(r.assetId, r.ifName)) ?? 1;
    if (
      !best ||
      rank < bestRank ||
      (rank === bestRank && r.lastSeen.getTime() > best.lastSeen.getTime()) ||
      (rank === bestRank &&
        r.lastSeen.getTime() === best.lastSeen.getTime() &&
        portKey(r.assetId, r.ifName) < portKey(best.assetId, best.ifName))
    ) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

/** `<switch>/<port>` — the format `splitLastSeenSwitch` and its two sibling
 *  parsers read. */
export function switchPortLabel(switchHostname: string, ifName: string): string {
  return `${switchHostname}/${ifName}`;
}

export function portKey(switchAssetId: string, ifName: string): string {
  return `${switchAssetId}|${ifName}`;
}

/** Case-insensitive "did the stamp move" — the station scrape's comparison. */
export function stampChanged(prev: string | null | undefined, next: string): boolean {
  return (prev ?? "").trim().toLowerCase() !== next.trim().toLowerCase();
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/** Every network-present asset with an address and no MAC. */
export async function loadMaclessClaims(): Promise<MaclessClaimRow[]> {
  return prisma.$queryRaw<MaclessClaimRow[]>`
    SELECT a.id, a.hostname, a."ipAddress" AS ip, a."ipSource", a."ipOverride",
           a."lastSeen", h."lastSeen" AS "ipLastSeen",
           a."lastSeenSwitch", a."lastSeenAp"
    FROM assets a
    LEFT JOIN asset_ip_history h ON h."assetId" = a.id AND h.ip = a."ipAddress"
    WHERE a."ipAddress" IS NOT NULL
      AND a."ipAddress" <> ''
      AND a."macAddress" IS NULL
      AND a."assetType" <> ALL(${INFRA_TYPES}::text[])
      AND a.status::text <> ALL(${UNMONITORABLE_STATUSES}::text[])
    ORDER BY a.id
    LIMIT ${CANDIDATE_CAP}
  `;
}

/**
 * Resolve, per candidate address, the firewall Asset that owns it: the
 * containing subnet's chassis serial, then its FortiManager device name,
 * through the shared parent-key precedence. Null when the address sits in no
 * known network or the gate has no Asset row.
 */
async function resolveOwningGates(ips: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ips.length === 0) return out;

  const contexts = await buildIpContexts(ips);
  const subnetIds = [...new Set([...contexts.values()].map((c) => c.subnetId))];
  if (subnetIds.length === 0) {
    for (const ip of ips) out.set(ip, null);
    return out;
  }

  const [subnets, firewalls] = await Promise.all([
    prisma.subnet.findMany({
      where: { id: { in: subnetIds } },
      select: { id: true, fortigateDevice: true, fortigateSerial: true },
    }),
    prisma.asset.findMany({
      where: { assetType: "firewall" },
      select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
    }),
  ]);
  const index = buildInfraParentIndex(firewalls as unknown as InfraParentCandidate[]);
  const gateBySubnet = new Map<string, string | null>();
  for (const s of subnets) {
    const hit = resolveInfraParentAsset(
      index,
      { serial: s.fortigateSerial ?? undefined, name: s.fortigateDevice ?? undefined },
      "firewall",
    );
    gateBySubnet.set(s.id, hit?.id ?? null);
  }
  for (const ip of ips) {
    const ctx = contexts.get(ip);
    out.set(ip, ctx ? (gateBySubnet.get(ctx.subnetId) ?? null) : null);
  }
  return out;
}

async function loadArpRows(ips: string[], cutoff: Date): Promise<Map<string, ArpRowLite[]>> {
  const byIp = new Map<string, ArpRowLite[]>();
  for (const chunk of chunkArray(ips, IN_CHUNK)) {
    const rows = await prisma.assetArpEntry.findMany({
      where: { ipAddress: { in: chunk }, lastSeen: { gte: cutoff } },
      select: { assetId: true, ipAddress: true, macAddress: true, lastSeen: true },
    });
    for (const r of rows) {
      const list = byIp.get(r.ipAddress);
      if (list) list.push(r);
      else byIp.set(r.ipAddress, [r]);
    }
  }
  return byIp;
}

async function loadFdbRows(macs: string[], cutoff: Date): Promise<{
  byMac: Map<string, FdbRowLite[]>;
  cardinality: Map<string, number>;
}> {
  const byMac = new Map<string, FdbRowLite[]>();
  const switchIds = new Set<string>();
  for (const chunk of chunkArray(macs, IN_CHUNK)) {
    const rows = await prisma.assetMacTableEntry.findMany({
      where: { macAddress: { in: chunk }, status: "learned", ifName: { not: null }, lastSeen: { gte: cutoff } },
      select: { assetId: true, macAddress: true, ifName: true, lastSeen: true },
    });
    for (const r of rows) {
      if (!r.ifName) continue;
      const lite: FdbRowLite = { assetId: r.assetId, macAddress: r.macAddress, ifName: r.ifName, lastSeen: r.lastSeen };
      switchIds.add(r.assetId);
      const list = byMac.get(r.macAddress);
      if (list) list.push(lite);
      else byMac.set(r.macAddress, [lite]);
    }
  }
  // How many MACs each involved port has learned — the rank Phase 7.5 uses.
  // Grouped in SQL and bounded to the switches that matter, not the fleet.
  const cardinality = new Map<string, number>();
  for (const chunk of chunkArray([...switchIds], IN_CHUNK)) {
    const groups = await prisma.assetMacTableEntry.groupBy({
      by: ["assetId", "ifName"],
      where: { assetId: { in: chunk }, status: "learned", ifName: { not: null } },
      _count: { _all: true },
    });
    for (const g of groups) {
      if (g.ifName) cardinality.set(portKey(g.assetId, g.ifName), g._count._all);
    }
  }
  return { byMac, cardinality };
}

async function loadStationRows(
  macs: string[],
  ips: string[],
  cutoff: Date,
): Promise<{ byMac: Map<string, StationRowLite[]>; byIp: Map<string, StationRowLite[]> }> {
  const byMac = new Map<string, StationRowLite[]>();
  const byIp = new Map<string, StationRowLite[]>();
  const push = (m: Map<string, StationRowLite[]>, k: string, r: StationRowLite) => {
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  };
  const macChunks = chunkArray(macs, IN_CHUNK);
  const ipChunks = chunkArray(ips, IN_CHUNK);
  const n = Math.max(macChunks.length, ipChunks.length);
  for (let i = 0; i < n; i++) {
    const or: Array<Record<string, unknown>> = [];
    if (macChunks[i]) or.push({ staMacAddr: { in: macChunks[i] } });
    if (ipChunks[i]) or.push({ staIpAddr: { in: ipChunks[i] } });
    const rows = await prisma.assetWirelessStation.findMany({
      where: { OR: or, lastSeen: { gte: cutoff } },
      select: { apAssetId: true, staMacAddr: true, staIpAddr: true, lastSeen: true },
    });
    for (const r of rows) {
      push(byMac, r.staMacAddr, r);
      if (r.staIpAddr) push(byIp, r.staIpAddr, r);
    }
  }
  return { byMac, byIp };
}

/**
 * One pass: derive and stamp the upstream switch port / AP for every MAC-less
 * asset whose address the network can currently account for.
 */
export async function resolveIpUpstreamForMaclessAssets(now = new Date()): Promise<IpUpstreamChainResult> {
  const result: IpUpstreamChainResult = {
    candidates: 0, staleClaims: 0, resolvedMac: 0, ambiguous: 0, switchStamps: 0, apStamps: 0,
  };

  const claimCutoff = new Date(now.getTime() - CLAIM_FRESH_DAYS * 86_400_000);
  const evidenceCutoff = new Date(now.getTime() - EVIDENCE_FRESH_MS);

  const all = await loadMaclessClaims();
  const fresh = all.filter((r) => claimIsFresh(r, claimCutoff));
  result.candidates = fresh.length;
  result.staleClaims = all.length - fresh.length;
  if (fresh.length === 0) return result;

  const ips = [...new Set(fresh.map((r) => r.ip))];
  const [gateByIp, arpByIp] = await Promise.all([
    resolveOwningGates(ips),
    loadArpRows(ips, evidenceCutoff),
  ]);

  // IP → MAC, through the owning gate.
  const macByIp = new Map<string, string>();
  for (const ip of ips) {
    const rows = arpByIp.get(ip);
    if (!rows || rows.length === 0) continue;
    const picked = pickArpMac(rows, gateByIp.get(ip) ?? null);
    if (picked === "ambiguous") { result.ambiguous++; continue; }
    if (picked) macByIp.set(ip, picked.mac);
  }
  result.resolvedMac = fresh.filter((r) => macByIp.has(r.ip)).length;

  const macs = [...new Set(macByIp.values())];
  const [fdb, stations] = await Promise.all([
    macs.length > 0 ? loadFdbRows(macs, evidenceCutoff) : Promise.resolve({ byMac: new Map<string, FdbRowLite[]>(), cardinality: new Map<string, number>() }),
    loadStationRows(macs, ips, evidenceCutoff),
  ]);

  // Device names for the labels — one query for every switch and AP involved.
  const deviceIds = new Set<string>();
  for (const rows of fdb.byMac.values()) for (const r of rows) deviceIds.add(r.assetId);
  for (const rows of stations.byMac.values()) for (const r of rows) deviceIds.add(r.apAssetId);
  for (const rows of stations.byIp.values()) for (const r of rows) deviceIds.add(r.apAssetId);
  const devices = deviceIds.size > 0
    ? await prisma.asset.findMany({
        where: { id: { in: [...deviceIds] } },
        select: { id: true, hostname: true },
      })
    : [];
  const hostnameById = new Map(devices.map((d) => [d.id, d.hostname]));

  // Decide per asset. Same address → same answer, so this is a map lookup.
  type Stamp = { row: MaclessClaimRow; switchLabel?: string; apName?: string };
  const stamps: Stamp[] = [];
  for (const row of fresh) {
    const mac = macByIp.get(row.ip) ?? null;
    const stamp: Stamp = { row };

    if (mac) {
      const port = pickBestSwitchPort(fdb.byMac.get(mac) ?? [], fdb.cardinality);
      const swName = port ? hostnameById.get(port.assetId) : null;
      if (port && swName) {
        const label = switchPortLabel(swName, port.ifName);
        if (stampChanged(row.lastSeenSwitch, label)) stamp.switchLabel = label;
      }
    }

    // AP: by the resolved MAC when there is one; otherwise by the station's own
    // recorded address, accepted only when a single station carries it.
    let staRows: StationRowLite[] | undefined;
    if (mac) staRows = stations.byMac.get(mac);
    else {
      const byIp = stations.byIp.get(row.ip);
      if (byIp && new Set(byIp.map((s) => s.staMacAddr)).size === 1) staRows = byIp;
    }
    if (staRows && staRows.length > 0) {
      const freshest = staRows.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a));
      const apName = hostnameById.get(freshest.apAssetId);
      if (apName && stampChanged(row.lastSeenAp, apName)) stamp.apName = apName;
    }

    if (stamp.switchLabel || stamp.apName) stamps.push(stamp);
  }
  if (stamps.length === 0) return result;

  // Deterministic lock order: by asset id, the persistWirelessStations fix.
  stamps.sort((a, b) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  for (const chunk of chunkArray(stamps, UPDATE_CHUNK)) {
    await retryOnDeadlock(() =>
      prisma.$transaction(
        chunk.map((s) =>
          prisma.asset.update({
            where: { id: s.row.id },
            data: {
              ...(s.switchLabel ? { lastSeenSwitch: s.switchLabel } : {}),
              ...(s.apName ? { lastSeenAp: s.apName } : {}),
            },
          }),
        ),
      ),
    );
    // Audit AFTER the commit — an Event write must not extend the lock window.
    const events = chunk.flatMap((s) => {
      const ctx = { assetId: s.row.id, assetName: s.row.hostname || s.row.ip, actor: ACTOR, source: SOURCE };
      const out = [];
      if (s.switchLabel) {
        result.switchStamps++;
        const ev = buildConnectionChangedEvent("switch", ctx, s.row.lastSeenSwitch, s.switchLabel);
        if (ev) out.push(ev);
      }
      if (s.apName) {
        result.apStamps++;
        const ev = buildConnectionChangedEvent("ap", ctx, s.row.lastSeenAp, s.apName);
        if (ev) out.push(ev);
      }
      return out;
    });
    await logEventsBatch(events);
  }

  logger.info(result, "ip upstream chain: stamped switch/AP on MAC-less assets");
  return result;
}
