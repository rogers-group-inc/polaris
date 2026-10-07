/**
 * src/services/applicationMapService.ts — the Application Map graph builder,
 * per-asset connection reads, and the shared page layout.
 *
 * Data source: AssetProcessConnection (accumulate+age socket facts collected
 * per-minute for MAPPED processes — Asset.mappedProcesses — AND for the units
 * an operator maps from the Services tab — Asset.mappedServices, matched on the
 * row's owning `unit`). The graph:
 *
 *   nodes — one compound-parent node per asset with mapped processes/services,
 *     one child node per mapped process AND per mapped service unit (both
 *     render even with zero connections — they come from the mapped list, not
 *     from connection rows), plus grey "unknown" nodes for external
 *     IPs (grouped per /24 (v6: /64) when >5 unknowns share the subnet,
 *     hard-capped at 100 after grouping + one overflow node).
 *   edges — outbound rows resolve remoteIp against known assets
 *     (Asset.ipAddress → AssetAssociatedIp.ip, then a TIME-SCOPED
 *     AssetIpHistory fallback — see resolveIpsViaHistory: the history row
 *     whose seen-interval best covers the connection's own last observation
 *     wins, so an IP two assets held at different times attributes to the
 *     holder most likely current when the traffic was seen; a bare
 *     history-wide match was previously excluded outright because it drew
 *     edges to rotated-off former holders). A resolved destination with a
 *     mapped process LISTENING on that (proto, port) lands process→process;
 *     otherwise process→asset; otherwise process→unknown-ip. Inbound rows
 *     fill the reverse direction and are deduped against outbound-derived
 *     edges (outbound wins — it knows the source process). One rendered edge
 *     per (source, target) carrying a per-port breakdown (cap 16 + overflow
 *     count); each port carries the distinct remote/local IPs the connection
 *     was actually seen against (`ips`, cap 6) so the UI can state WHICH
 *     address a service dialed — the disambiguator for multi-IP hosts and
 *     same-asset service→service edges.
 *
 * Node ids are DETERMINISTIC (asset:<id>, proc:<assetId>:<b64url(name)>,
 * ip:<ip>, ipgroup:<cidr>) so saved layouts survive refresh.
 *
 * buildGraphFromRows is pure (no prisma) and unit-tested directly;
 * buildApplicationMapGraph is the DB-touching orchestrator behind
 * GET /api/v1/application-map.
 */

import { reverse as dnsReverse } from "node:dns/promises";

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { isPrivateIpv4 } from "../utils/cidr.js";
import type { Prisma } from "../generated/prisma/client.js";
import { loadIconResolutionCache, resolveIconUrl } from "./deviceIconService.js";
import { sanitizePositions, type TopologyPositions } from "./topologyLayoutService.js";
import { getAppMapConnectionRetentionDays, FOREVER } from "./sampleRetentionService.js";

// ─── Shapes ───────────────────────────────────────────────────────────

export interface MappedAssetLite {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string | null;
  monitorStatus: string | null;
  manufacturer: string | null;
  model: string | null;
  /** Asset.tags — carried to the asset node for the App Map's `tag` filter pill. */
  tags?: string[];
  mappedProcesses: string[];
  mappedServices: string[];
}

export interface ProcessConnectionRow {
  assetId: string;
  processName: string;
  unit: string | null; // owning systemd unit / Windows service, if resolved
  kind: string;   // listen | outbound | inbound
  proto: string;  // tcp | udp
  localAddr: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  firstSeen: Date;
  lastSeen: Date;
}

export interface AppMapNode {
  id: string;
  kind: "asset" | "process" | "service" | "unknown-ip" | "unknown-ip-group" | "unknown-overflow";
  parent?: string;
  assetId?: string;
  hostname?: string | null;
  ipAddress?: string | null;
  assetType?: string | null;
  monitorStatus?: string | null;
  iconUrl?: string | null;
  /** True on asset nodes that have mapped processes/services of their own
   * (compound parents); false on assets that appear only as resolved edge
   * targets. */
  hasMappedProcesses?: boolean;
  /** Asset nodes only, and only when the asset carries tags: Asset.tags, for
   *  the client's `tag` filter pill (exact match, expanded to the asset's
   *  process/service children like a host pill). */
  tags?: string[];
  processName?: string;
  serviceUnit?: string;
  listenPorts?: Array<{ proto: string; port: number }>;
  ip?: string;
  cidr?: string;
  ips?: string[];
  /** unknown-ip only: a name for an IP that matched no Asset — from the IP
   *  registry (see resolveIpsToNameHints) or, for public IPs, reverse DNS
   *  (see resolvePtrNames). Label-only — there is no asset to open. */
  ipHostname?: string | null;
  ipNameSource?: "reservation" | "dns" | null;
  connCount?: number;
  overflowCount?: number;
}

export interface AppMapEdgePort {
  proto: string;
  port: number;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Distinct addresses this port's connections were actually observed
   *  against (outbound: the dialed remote IP; inbound: the local address the
   *  connection landed on). Capped at EDGE_PORT_IP_CAP; "" observations are
   *  skipped. This is what tells apart a service dialing the host's LAN IP
   *  from one dialing a secondary address — loopback never appears because
   *  the agent drops loopback peers at collection. */
  ips: string[];
}

export interface AppMapEdge {
  id: string;
  source: string;
  target: string;
  kind: "process" | "asset" | "external" | "external-inbound";
  ports: AppMapEdgePort[];
  portOverflow: number;
  lastSeen: string;
}

export interface AppMapStats {
  assetCount: number;
  processCount: number;
  serviceCount: number;
  unknownIpCount: number;
  edgeCount: number;
  truncated: { unknownIps: number };
}

export interface AppMapLayoutDto {
  view: string;
  positions: TopologyPositions;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AppMapGraph {
  generatedAt: string;
  nodes: AppMapNode[];
  edges: AppMapEdge[];
  savedLayout: AppMapLayoutDto | null;
  stats: AppMapStats;
  /** Configured `appMapConnections` retention window in days (FOREVER = -1).
   *  The client builds its "Seen within" range from this, so the widest option
   *  reflects what is actually retained instead of a hardcoded guess. */
  retentionDays: number;
}
// Unknown-IP hygiene.
const UNKNOWN_GROUP_THRESHOLD = 5;   // >5 unknowns in one subnet → group node
const UNKNOWN_NODE_CAP = 100;        // after grouping; overflow collapses
const EDGE_PORT_CAP = 16;
const EDGE_PORT_IP_CAP = 6;          // distinct observed IPs kept per edge port

// ─── Node-id helpers (deterministic — saved layouts key on these) ──────

export function assetNodeId(assetId: string): string {
  return `asset:${assetId}`;
}

export function processNodeId(assetId: string, processName: string): string {
  return `proc:${assetId}:${Buffer.from(processName, "utf8").toString("base64url")}`;
}

export function serviceNodeId(assetId: string, unit: string): string {
  return `svc:${assetId}:${Buffer.from(unit, "utf8").toString("base64url")}`;
}

// ─── Noise filter ─────────────────────────────────────────────────────

// Loopback, unspecified, link-local, multicast, broadcast — never map-worthy.
export function isNoiseIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (!v) return true;
  if (v === "::1" || v === "::" || v === "0.0.0.0" || v === "255.255.255.255") return true;
  if (v.startsWith("127.")) return true;
  if (v.startsWith("169.254.")) return true;
  if (v.startsWith("fe80:")) return true;
  if (v.startsWith("ff")) {
    // v6 multicast ff00::/8 — only when it's actually a v6 literal.
    if (v.includes(":")) return true;
  }
  const firstOctet = Number(v.split(".")[0]);
  if (Number.isFinite(firstOctet) && firstOctet >= 224 && firstOctet <= 239 && v.includes(".")) return true;
  return false;
}

/** /24 for v4, /64 for v6 — the unknown-IP grouping bucket. */
export function subnetKeyOf(ip: string): string {
  if (ip.includes(":")) {
    // First four hextets of the expanded form ≈ /64. Cheap textual expansion:
    // split on "::" and pad.
    const [head, tail] = ip.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - headParts.length - tailParts.length;
    const full = [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts];
    return full.slice(0, 4).map((h) => h || "0").join(":") + "::/64";
  }
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
}

// ─── Bulk IP → asset resolution ───────────────────────────────────────

const ASSET_LITE_SELECT = {
  id: true, hostname: true, ipAddress: true, assetType: true,
  monitorStatus: true, manufacturer: true, model: true, tags: true,
} as const;

export type ResolvedAssetLite = Omit<MappedAssetLite, "mappedProcesses" | "mappedServices">;

// Decommissioned hardware is gone; live traffic must never attribute to it.
// (Compound parents already drop via monitored=false — this closes the
// resolved-edge-TARGET path, where a retired device holding a since-reused IP
// would otherwise soak up other assets' connections.)
const RESOLVABLE_ASSET_WHERE = { status: { not: "decommissioned" } } as const;

/**
 * Resolve remote IPs to known assets: primary Asset.ipAddress first, then the
 * AssetAssociatedIp side table (multi-NIC / VIP addresses). Decommissioned
 * assets never resolve (RESOLVABLE_ASSET_WHERE). AssetIpHistory is NOT
 * consulted here — the time-scoped fallback lives in resolveIpsViaHistory so
 * callers opt in with an observation time. Two findMany-in queries total.
 */
export async function resolveIpsToAssets(ips: string[]): Promise<Map<string, ResolvedAssetLite>> {
  const out = new Map<string, ResolvedAssetLite>();
  if (ips.length === 0) return out;
  const primary = await prisma.asset.findMany({
    where: { ipAddress: { in: ips }, ...RESOLVABLE_ASSET_WHERE },
    select: ASSET_LITE_SELECT,
  });
  for (const a of primary) {
    if (a.ipAddress && !out.has(a.ipAddress)) out.set(a.ipAddress, a);
  }
  const remaining = ips.filter((ip) => !out.has(ip));
  if (remaining.length > 0) {
    const assoc = await prisma.assetAssociatedIp.findMany({
      where: { ip: { in: remaining } },
      select: { ip: true, assetId: true },
    });
    if (assoc.length > 0) {
      const byId = new Map(
        (await prisma.asset.findMany({
          where: { id: { in: [...new Set(assoc.map((r) => r.assetId))] }, ...RESOLVABLE_ASSET_WHERE },
          select: ASSET_LITE_SELECT,
        })).map((a) => [a.id, a]),
      );
      for (const r of assoc) {
        const a = byId.get(r.assetId);
        if (a && !out.has(r.ip)) out.set(r.ip, a);
      }
    }
  }
  return out;
}

// ─── Time-scoped AssetIpHistory fallback ──────────────────────────────

export interface IpHistoryCandidate {
  assetId: string;
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * Pick the asset that most likely held an IP at `refTimeMs` (the newest
 * connection observation referencing that IP). PURE — exported for tests.
 *
 * Preference order:
 *   1. rows whose [firstSeen, lastSeen] interval covers refTime — latest
 *      firstSeen wins (the asset that took the IP most recently);
 *   2. otherwise the row whose interval sits closest to refTime, ties broken
 *      by latest lastSeen, then assetId (determinism).
 */
export function pickHistoryHolder(rows: IpHistoryCandidate[], refTimeMs: number): string | null {
  if (rows.length === 0) return null;
  const covering = rows.filter((r) => r.firstSeen.getTime() <= refTimeMs && r.lastSeen.getTime() >= refTimeMs);
  const pool = covering.length > 0 ? covering : rows;
  const distance = (r: IpHistoryCandidate): number => {
    if (covering.length > 0) return 0;
    return r.lastSeen.getTime() < refTimeMs
      ? refTimeMs - r.lastSeen.getTime()
      : r.firstSeen.getTime() - refTimeMs;
  };
  const best = [...pool].sort((a, b) =>
    distance(a) - distance(b) ||
    b.firstSeen.getTime() - a.firstSeen.getTime() ||
    b.lastSeen.getTime() - a.lastSeen.getTime() ||
    a.assetId.localeCompare(b.assetId),
  )[0];
  return best.assetId;
}

/**
 * History fallback for IPs the current-truth tables didn't resolve: an
 * AssetIpHistory row names a PAST holder, so it only counts when scoped to
 * when the traffic was actually seen — `refTimeByIp` carries, per IP, the
 * newest connection-row lastSeen referencing it. When several assets held the
 * same IP, pickHistoryHolder chooses the one most plausibly current at that
 * time. Decommissioned assets are excluded like everywhere else.
 */
export async function resolveIpsViaHistory(
  refTimeByIp: Map<string, number>,
): Promise<Map<string, ResolvedAssetLite>> {
  const out = new Map<string, ResolvedAssetLite>();
  const ips = [...refTimeByIp.keys()];
  if (ips.length === 0) return out;
  const hist = await prisma.assetIpHistory.findMany({
    where: { ip: { in: ips } },
    select: { ip: true, assetId: true, firstSeen: true, lastSeen: true },
  });
  if (hist.length === 0) return out;
  const byIp = new Map<string, IpHistoryCandidate[]>();
  for (const h of hist) {
    let list = byIp.get(h.ip);
    if (!list) { list = []; byIp.set(h.ip, list); }
    list.push(h);
  }
  const chosen = new Map<string, string>(); // ip → assetId
  for (const [ip, rows] of byIp) {
    const id = pickHistoryHolder(rows, refTimeByIp.get(ip) ?? Date.now());
    if (id) chosen.set(ip, id);
  }
  if (chosen.size === 0) return out;
  const byId = new Map(
    (await prisma.asset.findMany({
      where: { id: { in: [...new Set(chosen.values())] }, ...RESOLVABLE_ASSET_WHERE },
      select: ASSET_LITE_SELECT,
    })).map((a) => [a.id, a]),
  );
  for (const [ip, assetId] of chosen) {
    const a = byId.get(assetId);
    if (a) out.set(ip, a);
  }
  return out;
}

/**
 * IPAM fallback for IPs that matched no Asset: an ACTIVE Reservation's hostname.
 *
 * Polaris is the IP registry, so an unresolved internal endpoint is often already
 * named there even though no Asset exists for it — a statically-assigned appliance,
 * a DHCP reservation, a manually-recorded host. Showing "172.25.87.17" when the
 * registry says what it is makes the map harder to read than it needs to be.
 *
 * Label-only: these do NOT become asset nodes (there's no asset to open), they just
 * name the grey unknown-IP node. `status: "active"` because a released/expired row
 * is history, not current truth, and `hostname` non-empty because a reservation with
 * no name tells us nothing the IP doesn't.
 *
 * Deliberately narrower than the reservation table's full richness: `owner` is
 * display metadata and `description` is free text, so neither is a reliable name.
 */
export interface IpNameHint {
  hostname: string;
  /** What named it — shown in the info rail so the operator knows this is
   *  IPAM data / a PTR record, not a discovered asset. */
  source: "reservation" | "dns";
}

export async function resolveIpsToNameHints(ips: string[]): Promise<Map<string, IpNameHint>> {
  const out = new Map<string, IpNameHint>();
  if (ips.length === 0) return out;
  const rows = await prisma.reservation.findMany({
    where: { ipAddress: { in: ips }, status: "active", hostname: { not: null } },
    select: { ipAddress: true, hostname: true },
  });
  for (const r of rows) {
    const ip = r.ipAddress;
    const hostname = (r.hostname ?? "").trim();
    if (!ip || !hostname || out.has(ip)) continue;
    out.set(ip, { hostname, source: "reservation" });
  }
  return out;
}

// ─── Reverse DNS (PTR) for public unknown IPs ─────────────────────────
//
// A service dialing a public address usually reads better as the PTR name
// ("ec2-52-1-2-3.compute-1.amazonaws.com", "smtp.office365.com") than as a
// bare IP. PUBLIC addresses only: internal IPs are the registry's job
// (resolveIpsToNameHints) and blasting the site resolver with PTR queries for
// RFC1918 space is noise. Lookups are cached in-process (positive 6h,
// negative 30m) and budgeted per build — uncached IPs beyond the budget just
// resolve on a later refresh, so one graph build never fans out unbounded DNS.

/** Public = routable unicast we'd plausibly PTR: not noise (loopback / link-
 *  local / multicast / unspecified), not RFC1918, not CGN 100.64/10, not v6
 *  ULA fc00::/7. Exported for tests. */
export function isPublicIp(ip: string): boolean {
  const v = (ip || "").trim().toLowerCase();
  if (!v || isNoiseIp(v)) return false;
  if (v.includes(":")) {
    return !(v.startsWith("fc") || v.startsWith("fd"));
  }
  const parts = v.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (isPrivateIpv4(v)) return false;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false; // CGN
  return true;
}

const PTR_POSITIVE_TTL_MS = 6 * 3600 * 1000;
const PTR_NEGATIVE_TTL_MS = 30 * 60 * 1000;
const PTR_LOOKUP_TIMEOUT_MS = 1500;
const PTR_LOOKUPS_PER_BUILD = 25;
const PTR_CACHE_MAX = 5000;

const ptrCache = new Map<string, { name: string | null; expires: number }>();

/** Test hook — the cache is module-level state. */
export function clearPtrCacheForTests(): void {
  ptrCache.clear();
}

/**
 * PTR names for the PUBLIC subset of `ips`. Cached results answer instantly;
 * at most PTR_LOOKUPS_PER_BUILD uncached lookups run (concurrently, each
 * bounded to PTR_LOOKUP_TIMEOUT_MS — a dead resolver must not stall the graph
 * build). Failures negative-cache so a dark IP isn't re-queried every 60s
 * refresh. `lookup` is injectable for tests; production uses node:dns reverse.
 */
export async function resolvePtrNames(
  ips: string[],
  lookup: (ip: string) => Promise<string[]> = dnsReverse,
): Promise<Map<string, IpNameHint>> {
  const out = new Map<string, IpNameHint>();
  const now = Date.now();
  const misses: string[] = [];
  for (const ip of ips) {
    if (!isPublicIp(ip)) continue;
    const hit = ptrCache.get(ip);
    if (hit && hit.expires > now) {
      if (hit.name) out.set(ip, { hostname: hit.name, source: "dns" });
    } else {
      misses.push(ip);
    }
  }
  const batch = misses.slice(0, PTR_LOOKUPS_PER_BUILD);
  if (batch.length === 0) return out;
  // Bounded fill, not LRU: PTR churn is low and the map rebuild repopulates
  // hot entries within a refresh or two.
  if (ptrCache.size + batch.length > PTR_CACHE_MAX) ptrCache.clear();
  await Promise.all(batch.map(async (ip) => {
    let name: string | null = null;
    try {
      const names = await Promise.race([
        lookup(ip),
        new Promise<string[]>((resolve) => { setTimeout(() => resolve([]), PTR_LOOKUP_TIMEOUT_MS).unref?.(); }),
      ]);
      name = (names && names[0]) ? String(names[0]).trim() || null : null;
    } catch {
      name = null; // NXDOMAIN / refused / timeout — negative-cache below
    }
    ptrCache.set(ip, { name, expires: Date.now() + (name ? PTR_POSITIVE_TTL_MS : PTR_NEGATIVE_TTL_MS) });
    if (name) out.set(ip, { hostname: name, source: "dns" });
  }));
  return out;
}

// ─── Pure graph core ──────────────────────────────────────────────────

const EDGE_KIND_RANK: Record<AppMapEdge["kind"], number> = {
  process: 3, asset: 2, external: 1, "external-inbound": 1,
};

export function buildGraphFromRows(
  assets: MappedAssetLite[],
  rows: ProcessConnectionRow[],
  ipToAsset: Map<string, ResolvedAssetLite>,
  /** Optional IPAM name hints for IPs that matched no asset. Label-only. */
  ipNameHints?: Map<string, IpNameHint>,
): { nodes: AppMapNode[]; edges: AppMapEdge[]; stats: AppMapStats } {
  const mappedProcByAsset = new Map(assets.map((a) => [a.id, new Set(a.mappedProcesses)]));
  const mappedSvcByAsset = new Map(assets.map((a) => [a.id, new Set(a.mappedServices)]));

  // The child nodes a given row is attributed to. A row can satisfy BOTH a
  // mapped process (by program name) AND a mapped service (by owning unit) —
  // e.g. a Spring app mapped as the `java` process and as `myapp.service`; it
  // then shows on both children. Rows matching neither are dropped (rows for a
  // just-unmapped process/service are deleted at the PUT, but belt-and-
  // suspenders here too).
  const ownerNodeIds = (r: ProcessConnectionRow): string[] => {
    const out: string[] = [];
    if (mappedProcByAsset.get(r.assetId)?.has(r.processName)) out.push(processNodeId(r.assetId, r.processName));
    if (r.unit && mappedSvcByAsset.get(r.assetId)?.has(r.unit)) out.push(serviceNodeId(r.assetId, r.unit));
    return out;
  };
  const liveRows = rows.filter((r) => ownerNodeIds(r).length > 0);

  // Listen index: assetId → "proto/port" → set of listening child-node ids
  // (a port can be attributed to a process node AND a service node). Also
  // per-child listen-port lists for the node payload.
  const listenIndex = new Map<string, Map<string, Set<string>>>();
  const listenPortsByNode = new Map<string, Array<{ proto: string; port: number }>>();
  for (const r of liveRows) {
    if (r.kind !== "listen") continue;
    let m = listenIndex.get(r.assetId);
    if (!m) { m = new Map(); listenIndex.set(r.assetId, m); }
    const key = `${r.proto}/${r.localPort}`;
    let set = m.get(key);
    if (!set) { set = new Set(); m.set(key, set); }
    for (const nodeId of ownerNodeIds(r)) {
      set.add(nodeId);
      let list = listenPortsByNode.get(nodeId);
      if (!list) { list = []; listenPortsByNode.set(nodeId, list); }
      if (!list.some((p) => p.proto === r.proto && p.port === r.localPort)) {
        list.push({ proto: r.proto, port: r.localPort });
      }
    }
  }
  const sortedPorts = (nodeId: string): Array<{ proto: string; port: number }> =>
    (listenPortsByNode.get(nodeId) ?? []).sort((x, y) => x.proto.localeCompare(y.proto) || x.port - y.port);

  // ─ Nodes: mapped assets (compound parents) + process/service children ─
  const nodes: AppMapNode[] = [];
  const nodeIds = new Set<string>();
  const pushNode = (n: AppMapNode): void => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  let processCount = 0;
  let serviceCount = 0;
  for (const a of assets) {
    pushNode({
      id: assetNodeId(a.id), kind: "asset", assetId: a.id,
      hostname: a.hostname, ipAddress: a.ipAddress, assetType: a.assetType,
      monitorStatus: a.monitorStatus, hasMappedProcesses: true,
      ...(a.tags?.length ? { tags: a.tags } : {}),
    });
    for (const name of a.mappedProcesses) {
      const pid = processNodeId(a.id, name);
      pushNode({
        id: pid, kind: "process", parent: assetNodeId(a.id), assetId: a.id,
        processName: name, listenPorts: sortedPorts(pid),
      });
      processCount++;
    }
    for (const unit of a.mappedServices) {
      const sid = serviceNodeId(a.id, unit);
      pushNode({
        id: sid, kind: "service", parent: assetNodeId(a.id), assetId: a.id,
        serviceUnit: unit, listenPorts: sortedPorts(sid),
      });
      serviceCount++;
    }
  }
  // Resolved-target assets that have no mapped processes of their own get a
  // plain (childless) asset node on first reference, via ensureTargetAsset.
  const ensureTargetAsset = (a: ResolvedAssetLite): string => {
    const id = assetNodeId(a.id);
    if (!nodeIds.has(id)) {
      pushNode({
        id, kind: "asset", assetId: a.id,
        hostname: a.hostname, ipAddress: a.ipAddress, assetType: a.assetType,
        monitorStatus: a.monitorStatus, hasMappedProcesses: false,
        ...(a.tags?.length ? { tags: a.tags } : {}),
      });
    }
    return id;
  };

  // ─ Edge accumulation (merged per (source, target)) ─
  interface EdgeAcc {
    source: string; target: string; kind: AppMapEdge["kind"];
    ports: Map<string, AppMapEdgePort>;
    lastSeen: number;
  }
  const edgeAcc = new Map<string, EdgeAcc>();
  // Outbound-observation keys for inbound dedup: src|dstNode|proto|port.
  const outboundKeys = new Set<string>();
  const unknownConnCount = new Map<string, number>();

  // Record an observed address on a port (dedup + cap). "" = not observed.
  const addPortIp = (p: AppMapEdgePort, ip: string): void => {
    if (!ip || p.ips.includes(ip)) return;
    if (p.ips.length < EDGE_PORT_IP_CAP) p.ips.push(ip);
  };

  const addEdge = (
    source: string, target: string, kind: AppMapEdge["kind"],
    proto: string, port: number, firstSeen: Date, lastSeen: Date,
    viaIp: string,
  ): void => {
    const key = `${source}|${target}`;
    let acc = edgeAcc.get(key);
    if (!acc) {
      acc = { source, target, kind, ports: new Map(), lastSeen: 0 };
      edgeAcc.set(key, acc);
    }
    if (EDGE_KIND_RANK[kind] > EDGE_KIND_RANK[acc.kind]) acc.kind = kind;
    const pk = `${proto}/${port}`;
    const existing = acc.ports.get(pk);
    if (existing) {
      existing.count++;
      if (firstSeen.toISOString() < existing.firstSeen) existing.firstSeen = firstSeen.toISOString();
      if (lastSeen.toISOString() > existing.lastSeen) existing.lastSeen = lastSeen.toISOString();
      addPortIp(existing, viaIp);
    } else {
      const p: AppMapEdgePort = { proto, port, count: 1, firstSeen: firstSeen.toISOString(), lastSeen: lastSeen.toISOString(), ips: [] };
      addPortIp(p, viaIp);
      acc.ports.set(pk, p);
    }
    if (lastSeen.getTime() > acc.lastSeen) acc.lastSeen = lastSeen.getTime();
  };

  // The address an INBOUND connection landed on — the closest thing the listen
  // side knows to "which IP did the peer dial". Wildcard binds tell us nothing.
  const inboundLocalAddr = (r: ProcessConnectionRow): string => {
    const a = (r.localAddr || "").trim();
    return a === "0.0.0.0" || a === "::" ? "" : a;
  };

  // Pass 1: outbound rows. Each row has ≥1 source child node (process and/or
  // service); a resolved destination can have >1 listening child node on the
  // port (process + service both attributed) — draw an edge per (source,
  // listener) pair.
  for (const r of liveRows) {
    if (r.kind !== "outbound" || !r.remoteIp || isNoiseIp(r.remoteIp)) continue;
    const sources = ownerNodeIds(r);
    const target = ipToAsset.get(r.remoteIp);
    if (target) {
      const listeners = listenIndex.get(target.id)?.get(`${r.proto}/${r.remotePort}`);
      for (const srcNode of sources) {
        if (listeners && listeners.size > 0) {
          for (const listenerNode of listeners) {
            if (target.id === r.assetId && listenerNode === srcNode) continue; // same-node self-loop
            addEdge(srcNode, listenerNode, "process", r.proto, r.remotePort, r.firstSeen, r.lastSeen, r.remoteIp);
            outboundKeys.add(`${r.assetId}|${listenerNode}|${r.proto}|${r.remotePort}`);
          }
        } else {
          const targetNode = ensureTargetAsset(target);
          addEdge(srcNode, targetNode, "asset", r.proto, r.remotePort, r.firstSeen, r.lastSeen, r.remoteIp);
          outboundKeys.add(`${r.assetId}|${targetNode}|${r.proto}|${r.remotePort}`);
        }
      }
    } else {
      unknownConnCount.set(r.remoteIp, (unknownConnCount.get(r.remoteIp) ?? 0) + 1);
      for (const srcNode of sources) {
        addEdge(srcNode, `ip:${r.remoteIp}`, "external", r.proto, r.remotePort, r.firstSeen, r.lastSeen, r.remoteIp);
      }
    }
  }

  // Pass 2: inbound rows — reverse-direction edges, deduped against outbound
  // observations of the same logical connection (outbound wins: it knows the
  // source child node; the inbound side only knows the peer IP).
  for (const r of liveRows) {
    if (r.kind !== "inbound" || !r.remoteIp || isNoiseIp(r.remoteIp)) continue;
    const dsts = ownerNodeIds(r);
    const peer = ipToAsset.get(r.remoteIp);
    if (!peer) unknownConnCount.set(r.remoteIp, (unknownConnCount.get(r.remoteIp) ?? 0) + 1);
    for (const dstNode of dsts) {
      if (peer) {
        if (outboundKeys.has(`${peer.id}|${dstNode}|${r.proto}|${r.localPort}`)) continue;
        if (peer.id === r.assetId) continue; // self-connection seen from the listen side
        addEdge(ensureTargetAsset(peer), dstNode, "asset", r.proto, r.localPort, r.firstSeen, r.lastSeen, inboundLocalAddr(r));
      } else {
        addEdge(`ip:${r.remoteIp}`, dstNode, "external-inbound", r.proto, r.localPort, r.firstSeen, r.lastSeen, inboundLocalAddr(r));
      }
    }
  }

  // ─ Unknown-IP hygiene: /24 (v6 /64) grouping + hard cap ─
  // Group when a subnet holds more than UNKNOWN_GROUP_THRESHOLD unknowns; a
  // grouped member's edges are re-pointed at the group node.
  const bySubnet = new Map<string, string[]>();
  for (const ip of unknownConnCount.keys()) {
    const key = subnetKeyOf(ip);
    let list = bySubnet.get(key);
    if (!list) { list = []; bySubnet.set(key, list); }
    list.push(ip);
  }
  const ipRedirect = new Map<string, string>(); // ip:<ip> node id → group node id
  interface UnknownNode { id: string; node: AppMapNode; connCount: number }
  const unknownNodes: UnknownNode[] = [];
  for (const [cidr, ips] of bySubnet) {
    if (ips.length > UNKNOWN_GROUP_THRESHOLD) {
      const groupId = `ipgroup:${cidr}`;
      const connCount = ips.reduce((s, ip) => s + (unknownConnCount.get(ip) ?? 0), 0);
      for (const ip of ips) ipRedirect.set(`ip:${ip}`, groupId);
      unknownNodes.push({
        id: groupId, connCount,
        node: { id: groupId, kind: "unknown-ip-group", cidr, ips: ips.sort(), connCount },
      });
    } else {
      for (const ip of ips) {
        const connCount = unknownConnCount.get(ip) ?? 0;
        unknownNodes.push({
          id: `ip:${ip}`, connCount,
          node: {
            id: `ip:${ip}`, kind: "unknown-ip", ip, connCount,
            // Name it from the IP registry when no Asset matched, so an internal
            // endpoint reads as what it is instead of a bare address.
            ipHostname: ipNameHints?.get(ip)?.hostname ?? null,
            ipNameSource: ipNameHints?.get(ip)?.source ?? null,
          },
        });
      }
    }
  }
  unknownNodes.sort((a, b) => b.connCount - a.connCount || a.id.localeCompare(b.id));
  const kept = unknownNodes.slice(0, UNKNOWN_NODE_CAP);
  const dropped = unknownNodes.slice(UNKNOWN_NODE_CAP);
  const OVERFLOW_ID = "ip:overflow";
  for (const d of dropped) {
    // Redirect every edge touching a dropped unknown node to the overflow node.
    if (d.node.kind === "unknown-ip-group") {
      for (const ip of d.node.ips ?? []) ipRedirect.set(`ip:${ip}`, OVERFLOW_ID);
    } else {
      ipRedirect.set(d.id, OVERFLOW_ID);
    }
  }
  for (const k of kept) pushNode(k.node);
  if (dropped.length > 0) {
    pushNode({
      id: OVERFLOW_ID, kind: "unknown-overflow",
      overflowCount: dropped.reduce((s, d) => s + (d.node.kind === "unknown-ip-group" ? (d.node.ips?.length ?? 1) : 1), 0),
      connCount: dropped.reduce((s, d) => s + d.connCount, 0),
    });
  }

  // ─ Finalize edges: apply redirects, re-merge collisions, emit ─
  const finalAcc = new Map<string, EdgeAcc>();
  for (const acc of edgeAcc.values()) {
    const source = ipRedirect.get(acc.source) ?? acc.source;
    const target = ipRedirect.get(acc.target) ?? acc.target;
    const key = `${source}|${target}`;
    const existing = finalAcc.get(key);
    if (!existing) {
      finalAcc.set(key, { ...acc, source, target });
      continue;
    }
    if (EDGE_KIND_RANK[acc.kind] > EDGE_KIND_RANK[existing.kind]) existing.kind = acc.kind;
    for (const [pk, p] of acc.ports) {
      const ep = existing.ports.get(pk);
      if (ep) {
        ep.count += p.count;
        if (p.firstSeen < ep.firstSeen) ep.firstSeen = p.firstSeen;
        if (p.lastSeen > ep.lastSeen) ep.lastSeen = p.lastSeen;
        for (const ip of p.ips) addPortIp(ep, ip);
      } else {
        existing.ports.set(pk, { ...p, ips: [...p.ips] });
      }
    }
    if (acc.lastSeen > existing.lastSeen) existing.lastSeen = acc.lastSeen;
  }
  const edges: AppMapEdge[] = [];
  for (const acc of finalAcc.values()) {
    const ports = [...acc.ports.values()].sort((a, b) => b.count - a.count || a.port - b.port);
    edges.push({
      id: `e:${acc.source}|${acc.target}`,
      source: acc.source,
      target: acc.target,
      kind: acc.kind,
      ports: ports.slice(0, EDGE_PORT_CAP),
      portOverflow: Math.max(0, ports.length - EDGE_PORT_CAP),
      lastSeen: new Date(acc.lastSeen).toISOString(),
    });
  }
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    stats: {
      assetCount: nodes.filter((n) => n.kind === "asset").length,
      processCount,
      serviceCount,
      unknownIpCount: kept.length,
      edgeCount: edges.length,
      truncated: { unknownIps: dropped.length },
    },
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────

export async function buildApplicationMapGraph(): Promise<AppMapGraph> {
  // Only actively-monitored hosts appear as compound-parent nodes. `monitored`
  // is false for stop-monitored assets and for decommissioned/disabled ones
  // (business rule 10), so this drops a host off the map when the operator stops
  // monitoring it (or removes its agent) WITHOUT clearing the map pins — the
  // selection is preserved and the host reappears if monitoring is re-enabled.
  // (Resolved-target assets that are merely edge endpoints are added separately
  // via ipToAsset regardless of this filter — they show only while live traffic
  // references them.)
  const assets: MappedAssetLite[] = await prisma.asset.findMany({
    where: { monitored: true, OR: [{ mappedProcesses: { isEmpty: false } }, { mappedServices: { isEmpty: false } }] },
    select: { ...ASSET_LITE_SELECT, mappedProcesses: true, mappedServices: true },
  });
  // Bound the read by the SAME window the prune uses, so the client's widest
  // "Seen within" option can't promise history that was already deleted (and
  // can't hide history that's still there). FOREVER = no lower bound.
  const retentionDays = await getAppMapConnectionRetentionDays();
  const since = retentionDays === FOREVER
    ? null
    : new Date(Date.now() - Math.max(0, retentionDays) * 24 * 3600 * 1000);
  const rows: ProcessConnectionRow[] = assets.length === 0 ? [] : await prisma.assetProcessConnection.findMany({
    where: {
      assetId: { in: assets.map((a) => a.id) },
      ...(since ? { lastSeen: { gte: since } } : {}),
    },
    select: {
      assetId: true, processName: true, unit: true, kind: true, proto: true,
      localAddr: true, localPort: true, remoteIp: true, remotePort: true,
      firstSeen: true, lastSeen: true,
    },
  });
  const remoteIps = [...new Set(rows.map((r) => r.remoteIp).filter((ip) => ip && !isNoiseIp(ip)))];
  const ipToAsset = await resolveIpsToAssets(remoteIps);
  // History fallback for the leftovers, scoped to when each IP's traffic was
  // last observed (newest connection-row lastSeen per IP) so a shared IP
  // attributes to whichever asset most plausibly held it in this window.
  const refTimeByIp = new Map<string, number>();
  for (const r of rows) {
    if (!r.remoteIp || ipToAsset.has(r.remoteIp) || isNoiseIp(r.remoteIp)) continue;
    const t = r.lastSeen.getTime();
    if (t > (refTimeByIp.get(r.remoteIp) ?? 0)) refTimeByIp.set(r.remoteIp, t);
  }
  for (const [ip, a] of await resolveIpsViaHistory(refTimeByIp)) {
    if (!ipToAsset.has(ip)) ipToAsset.set(ip, a);
  }
  // Only the still-unresolved need name hints — an IP that resolved to an
  // asset has a real node and doesn't want a label. The registry
  // (reservation) hint wins over reverse DNS; PTR fills in for public IPs the
  // registry can't know about.
  const unresolvedIps = remoteIps.filter((ip) => !ipToAsset.has(ip));
  const ipNameHints = await resolveIpsToNameHints(unresolvedIps);
  const ptrHints = await resolvePtrNames(unresolvedIps.filter((ip) => !ipNameHints.has(ip)));
  for (const [ip, hint] of ptrHints) ipNameHints.set(ip, hint);
  const graph = buildGraphFromRows(assets, rows, ipToAsset, ipNameHints);

  // Device icons for asset nodes (same recipe as the topology endpoint).
  const iconCache = await loadIconResolutionCache();
  const liteById = new Map<string, ResolvedAssetLite>();
  for (const a of assets) liteById.set(a.id, a);
  for (const a of ipToAsset.values()) if (!liteById.has(a.id)) liteById.set(a.id, a);
  for (const n of graph.nodes) {
    if (n.kind !== "asset" || !n.assetId) continue;
    const lite = liteById.get(n.assetId);
    if (!lite) continue;
    n.iconUrl = resolveIconUrl(
      { manufacturer: lite.manufacturer, model: lite.model, assetType: lite.assetType },
      iconCache,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    savedLayout: await getAppMapLayout("global"),
    stats: graph.stats,
    retentionDays,
  };
}

// ─── Per-asset detail (process slide-in "Ports & Connections") ─────────

export interface ProcessConnectionsDto {
  listening: Array<{ processName: string; proto: string; port: number; bindAddr: string; firstSeen: string; lastSeen: string }>;
  outbound:  Array<{ processName: string; proto: string; remoteIp: string; remotePort: number; remoteAssetId: string | null; remoteHostname: string | null; firstSeen: string; lastSeen: string }>;
  inbound:   Array<{ processName: string; proto: string; localPort: number; remoteIp: string; remoteAssetId: string | null; remoteHostname: string | null; firstSeen: string; lastSeen: string }>;
}

const DETAIL_SECTION_CAP = 500;

export async function getAssetProcessConnections(assetId: string, processName?: string, unit?: string): Promise<ProcessConnectionsDto> {
  const rows = await prisma.assetProcessConnection.findMany({
    where: { assetId, ...(processName ? { processName } : {}), ...(unit ? { unit } : {}) },
    orderBy: { lastSeen: "desc" },
  });
  const remoteIps = [...new Set(rows.map((r) => r.remoteIp).filter((ip) => ip.length > 0))];
  const ipToAsset = await resolveIpsToAssets(remoteIps);
  const out: ProcessConnectionsDto = { listening: [], outbound: [], inbound: [] };
  for (const r of rows) {
    if (r.kind === "listen" && out.listening.length < DETAIL_SECTION_CAP) {
      out.listening.push({
        processName: r.processName, proto: r.proto, port: r.localPort, bindAddr: r.localAddr,
        firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString(),
      });
    } else if (r.kind === "outbound" && out.outbound.length < DETAIL_SECTION_CAP) {
      const remote = ipToAsset.get(r.remoteIp);
      out.outbound.push({
        processName: r.processName, proto: r.proto, remoteIp: r.remoteIp, remotePort: r.remotePort,
        remoteAssetId: remote?.id ?? null, remoteHostname: remote?.hostname ?? null,
        firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString(),
      });
    } else if (r.kind === "inbound" && out.inbound.length < DETAIL_SECTION_CAP) {
      const remote = ipToAsset.get(r.remoteIp);
      out.inbound.push({
        processName: r.processName, proto: r.proto, localPort: r.localPort, remoteIp: r.remoteIp,
        remoteAssetId: remote?.id ?? null, remoteHostname: remote?.hostname ?? null,
        firstSeen: r.firstSeen.toISOString(), lastSeen: r.lastSeen.toISOString(),
      });
    }
  }
  return out;
}

// ─── Shared layout (ApplicationMapLayout) ─────────────────────────────

// One global map today; the view key future-proofs sub-views without a
// migration. Conservative charset, same spirit as isValidViewKey.
const VIEW_KEY_RE = /^[a-z0-9_-]{1,64}$/i;

function assertViewKey(view: string): void {
  if (!VIEW_KEY_RE.test(view)) throw new AppError(400, "Invalid view key");
}

function layoutToDto(row: { view: string; positions: Prisma.JsonValue; updatedBy: string | null; updatedAt: Date }): AppMapLayoutDto {
  return {
    view: row.view,
    positions: row.positions as unknown as TopologyPositions,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getAppMapLayout(view = "global"): Promise<AppMapLayoutDto | null> {
  assertViewKey(view);
  const row = await prisma.applicationMapLayout.findUnique({ where: { view } });
  return row ? layoutToDto(row) : null;
}

export async function saveAppMapLayout(
  view: string,
  positions: unknown,
  actor: string | null,
): Promise<AppMapLayoutDto> {
  assertViewKey(view);
  const clean = sanitizePositions(positions);
  const json = clean as unknown as Prisma.InputJsonValue;
  const row = await prisma.applicationMapLayout.upsert({
    where:  { view },
    create: { view, positions: json, updatedBy: actor },
    update: { positions: json, updatedBy: actor },
  });
  return layoutToDto(row);
}

export async function deleteAppMapLayout(view = "global"): Promise<boolean> {
  assertViewKey(view);
  const res = await prisma.applicationMapLayout.deleteMany({ where: { view } });
  return res.count > 0;
}
