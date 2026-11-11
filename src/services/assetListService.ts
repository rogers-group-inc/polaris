/**
 * src/services/assetListService.ts — The assets list engine behind GET /api/v1/assets: the query contract
 * (AssetListQuerySchema), the sort and text-filter whitelists, the where
 * builder, ordering, favorites-first paging, and the per-row enrichment
 * (monitoring methods, alerts, management access, HA, address confidence).
 * Moved out of routes/assets/list.ts (CQ-B062 slice 2); the route parses the
 * query and adds the caller's per-row write-scope flags (rule 141 (e)).
 *
 * The query schema lives here, not beside the route, because it IS this
 * service's input vocabulary: buildAssetListWhere is typed by it.
 */

import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ipv4TermToMatchPrefixes } from "../utils/cidr.js";
import { buildIpContexts } from "./subnetService.js";
import { getDiscoveredHostnames, findAssetIdsByDiscoveredHostname } from "./discoveredHostnameService.js";
import { buildTagFilter, findAssetIdsByTagSubstring, pageAssetIdsByTags, tagFilterNeedsLookup } from "./assetTagListService.js";
import { shapeMacRows, MAC_ROW_SELECT } from "../utils/macAddresses.js";
import { csvParam } from "../utils/text.js";
import { buildPrismaTextFilter, TEXT_FILTER_OPS } from "../utils/prismaTextFilter.js";
import { resolveMonitorSettings } from "./monitoringService.js";
import { shapeManagementAccessForClient } from "./fortinetManagementAccessService.js";
import { activeAlertSummaryByAsset } from "./notificationService.js";
import { type PollingMethod } from "../utils/pollingCompatibility.js";
import { buildAddressConfidence } from "./addressConfidenceService.js";
import { shapeAssociatedIps, ASSOCIATED_IP_SELECT } from "./assetAddressService.js";

// ─── Asset list: server-side filter / sort / pagination ────────────────────
//
// The assets table runs TableSF in *server-side mode* (mirrors the Events page,
// see polaris-ui-canon → "Sortable + filterable data table (server-side mode)"):
// every filter + sort the operator sets on a column header is translated into
// query params here, and only one page of rows is shipped to the browser. This
// is what keeps the page fast at 12k+ assets — the prior frontend pulled the
// entire table into memory and filtered/sorted/paginated in JS.

// Sort whitelist — Prisma orderBy must never accept user-supplied strings
// unvalidated. Keys are the table's data-sf-key values; values are the real
// Asset column. `_monitor` → monitorStatus, `_server` → location (handled
// specially below so the learnedLocation fallback participates).
const ASSET_SORT_COLUMNS: Record<string, string> = {
  hostname: "hostname",
  ipAddress: "ipAddress",
  serialNumber: "serialNumber",
  assetType: "assetType",
  status: "status",
  _monitor: "monitorStatus",
  _server: "location",
  assetTag: "assetTag",
  manufacturer: "manufacturer",
  model: "model",
  os: "os",
  macAddress: "macAddress",
  assignedTo: "assignedTo",
  purchaseOrder: "purchaseOrder",
  dnsName: "dnsName",
  description: "description",
  latitude: "latitude",
  longitude: "longitude",
  lastSeen: "lastSeen",
  createdAt: "createdAt",
  // String[] — Prisma cannot order by it; the list handler routes this key
  // through pageAssetIdsByTags instead of buildAssetOrderBy.
  tags: "tags",
};

// Operator-aware text-filter columns (column key → Asset column). Every one is
// a nullable String on Asset, so empty / is_not_empty carry a null arm.
const ASSET_TEXT_COLUMNS: Record<string, string> = {
  hostname: "hostname",
  ipAddress: "ipAddress",
  serialNumber: "serialNumber",
  assetTag: "assetTag",
  manufacturer: "manufacturer",
  model: "model",
  os: "os",
  macAddress: "macAddress",
  assignedTo: "assignedTo",
  purchaseOrder: "purchaseOrder",
  dnsName: "dnsName",
  description: "description",
};

const ASSET_TEXT_OPS = TEXT_FILTER_OPS;

/** CSV → string[]; empty entries dropped; returns undefined for no value. */
const csvToArray = csvParam;

/**
 * Translate a text-filter op + value into a where fragment for a nullable
 * Asset string column, or undefined for a no-op. Where-level (not field-level)
 * because empty / is_not_empty need OR / AND composition; the caller ANDs the
 * fragments together.
 */
const buildAssetTextFilter = buildPrismaTextFilter;

// Cap on the IP Address column's network terms — each can expand to 256 match
// entries (ipv4TermToMatchPrefixes), so this bounds the OR at ~12.8k arms.
const IP_NETWORK_TERMS_MAX = 50;

/**
 * The IP Address column's `in_networks` op: `value` is a CSV of IPv4 terms —
 * partial addresses ("10", "10.1.2"), suffixes (".50", ".1.50" — the last
 * octets), full addresses, or CIDRs — and a row
 * matches when its primary IP falls in ANY of them. Matched as exact values +
 * dotted prefixes on the string column (never an inet cast: one malformed
 * Asset.ipAddress would make the cast throw for the whole list). A term that
 * is not valid IPv4 is a 400, not silently ignored — dropping it would widen
 * the filter to more devices than the operator asked for.
 */
function buildIpNetworksFilter(value: string | undefined): Record<string, unknown> | undefined {
  const terms = (value || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return undefined;
  if (terms.length > IP_NETWORK_TERMS_MAX) {
    throw new AppError(400, `At most ${IP_NETWORK_TERMS_MAX} networks can be filtered at once`);
  }
  const equals = new Set<string>();
  const startsWith = new Set<string>();
  const endsWith = new Set<string>();
  for (const t of terms) {
    const m = ipv4TermToMatchPrefixes(t);
    if (!m) throw new AppError(400, `Not an IPv4 address, prefix, suffix or CIDR: ${t}`);
    m.equals.forEach((e) => equals.add(e));
    m.startsWith.forEach((p) => startsWith.add(p));
    (m.endsWith ?? []).forEach((s) => endsWith.add(s));
  }
  const arms: Record<string, unknown>[] = [];
  if (equals.size) arms.push({ ipAddress: { in: Array.from(equals) } });
  startsWith.forEach((p) => arms.push({ ipAddress: { startsWith: p } }));
  endsWith.forEach((s) => arms.push({ ipAddress: { endsWith: s } }));
  return arms.length === 1 ? arms[0] : { OR: arms };
}

/**
 * The `_server` column displays `location || learnedLocation`, so its filter
 * spans both columns: contains → match either, not_contains → match neither,
 * empty → both blank, is_not_empty → either set.
 */
function buildServerFilter(
  value: string | undefined,
  op: string | undefined,
): Record<string, unknown> | undefined {
  const operator = op && ASSET_TEXT_OPS.has(op) ? op : "contains";
  const cols = ["location", "learnedLocation"];
  if (operator === "empty") {
    return { AND: cols.map((c) => ({ OR: [{ [c]: null }, { [c]: "" }] })) };
  }
  if (operator === "is_not_empty") {
    return { OR: cols.map((c) => ({ AND: [{ [c]: { not: null } }, { [c]: { not: "" } }] })) };
  }
  const v = (value || "").trim();
  if (!v) return undefined;
  if (operator === "not_contains") {
    return { AND: cols.map((c) => ({ [c]: { not: { contains: v }, mode: "insensitive" } })) };
  }
  return { OR: cols.map((c) => ({ [c]: { contains: v, mode: "insensitive" } })) };
}

/**
 * Translate one `_monitor` synthetic-column chip into a where fragment. Mirrors
 * the client's `_mapAsset` mapping: "Monitored"/"Unmonitored" gate on the
 * `monitored` flag; "Dep. Down" is every dependency-suppressed monitored row
 * (regardless of the underlying probe state — matches the Status pill, which
 * gives suppression precedence over the five-state machine); the directional
 * chips pin monitorStatus and exclude suppressed rows so a row filters under
 * exactly the label its pill shows; "Pending" is everything monitored that
 * hasn't landed a directional status yet. Multiple selected chips are OR-ed
 * by the caller.
 */
function monitorClause(v: string): Record<string, unknown> | null {
  switch (v) {
    case "Unmonitored": return { monitored: false };
    case "Monitored":   return { monitored: true };
    case "Dep. Down":   return { monitored: true, dependencySuppressed: true };
    case "Up":          return { monitored: true, dependencySuppressed: false, monitorStatus: "up" };
    // "Warning" is the pre-2026-08 chip label, kept as an alias: it is persisted
    // verbatim inside SavedTableFilter.state and UserTableTabs rows, so dropping
    // it would silently turn every stored preset naming it into "no filter".
    case "Missed":
    case "Warning":     return { monitored: true, dependencySuppressed: false, monitorStatus: "warning" };
    case "Down":        return { monitored: true, dependencySuppressed: false, monitorStatus: "down" };
    case "Recovering":  return { monitored: true, dependencySuppressed: false, monitorStatus: "recovering" };
    case "Passive":     return { monitored: true, dependencySuppressed: false, monitorStatus: "passive" };
    // "Pending" is the catch-all for everything without its own chip, so every
    // named status must be excluded here or its rows filter under the wrong
    // label — the rule this file already states: a row filters under exactly
    // the label its pill shows.
    case "Pending":     return { monitored: true, dependencySuppressed: false, monitorStatus: { notIn: ["up", "warning", "down", "recovering", "passive"] } };
    default:            return null;
  }
}

// Shared list payload select. Omits heavy fields (notes, associatedUsers) and
// anything the list table + CSV/PDF export never reference; the single-asset
// GET /:id below still returns the full record for the view/edit modal.
const ASSET_LIST_SELECT = {
  id: true,
  // Rule 141 (e): the list computes `canEdit` / `canQuarantine` per row.
  createdBy: true,
  hostname: true,
  // Operator hostname pin. The list needs it to mark the cell as overridden and
  // to know which rows to look up a discovered hostname for (enrichAssetList).
  hostnameOverride: true,
  dnsName: true,
  assetTag: true,
  ipAddress: true,
  macAddress: true,
  macAddressRows: { select: MAC_ROW_SELECT },
  associatedIpRows: { select: ASSOCIATED_IP_SELECT },
  serialNumber: true,
  manufacturer: true,
  model: true,
  os: true,
  osVersion: true,
  assignedTo: true,
  purchaseOrder: true,
  description: true,
  assetType: true,
  status: true,
  statusChangedAt: true,
  statusChangedBy: true,
  location: true,
  learnedLocation: true,
  // Tags list column (sort + filter: assetTagListService).
  tags: true,
  // Latitude / Longitude list columns (hidden by default) — the geographic pin
  // that places a firewall on the Device Map.
  latitude: true,
  longitude: true,
  lastSeen: true,
  acquiredAt: true,
  createdAt: true,
  monitored: true,
  monitorStatus: true,
  lastMonitorAt: true,
  lastResponseTimeMs: true,
  discoveredByIntegrationId: true,
  // "Monitored Via" column: the resolved per-stream polling methods + agent
  // state are reduced to a compact `monitoringMethods` array by
  // computeMonitoringMethods() in enrichAssetList. The six *Polling scalars
  // feed the monitor-settings resolver; the discovering integration's type
  // supplies the source default; an active ManagedAgent short-circuits to
  // ["agent"] (the agent owns all streams).
  responseTimePolling: true,
  cpuMemoryPolling: true,
  temperaturePolling: true,
  interfacesPolling: true,
  lldpPolling: true,
  storagePolling: true,
  discoveredByIntegration: { select: { type: true } },
  managedAgent: { select: { installStatus: true } },
  dependencyLayer: true,
  dependencySuppressed: true,
  dependencyTestUntil: true,
  // Maintenance pill: the parked pre-window status shows in the tooltip and
  // is what the "End maintenance now" popover restores.
  maintenanceReturnStatus: true,
  // HA standby pill + cluster-IP display: selected only to feed the compact
  // `ha` projection (shapeHaInfo) — enrichAssetList strips the raw blob so
  // list rows never ship the full fortinetTopology JSON.
  fortinetTopology: true,
  // Row-menu Open HTTPS / Open SSH gate: the `allowaccess` list read during
  // FMG/FortiGate discovery. Reduced to four fields by shapeManagementAccess
  // so the list never ships the whole blob; null on every asset discovery has
  // never read an access list for, which is most of the fleet.
  managementAccess: true,
} as const;

const ASSET_LIST_DEFAULT_LIMIT = 50;

const ASSET_LIST_MAX_LIMIT = 10000;

// Defensive cap on the favorites-first id list (operator-curated; realistically
// dozens). Keeps the IN/NOT IN clause bounded if the localStorage set is huge.
const ASSET_FAVORITES_MAX = 5000;

export const AssetListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ASSET_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  // Multi-value enum filters (CSV). Single value → { equals }, many → { in }.
  status: z.string().optional(),
  assetType: z.string().optional(),
  monitor: z.string().optional(),
  // Existing scalar filters.
  department: z.string().optional(),
  createdBy: z.string().optional(),
  search: z.string().optional(),
  // lastSeen date range (YYYY-MM-DD from the date-column popover).
  lastSeenFrom: z.string().optional(),
  lastSeenTo: z.string().optional(),
  // Favorites-first ordering: the operator's starred asset ids (CSV).
  favoriteIds: z.string().optional(),
  // Sort whitelist; validated below.
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
}).passthrough();

 // per-column text filters (<col>, <col>Op) read off req.query

/**
 * Asset ids that match a filter term through their DISCOVERED hostname rather
 * than the `hostname` column — i.e. rows whose hostname is pinned, where the
 * list prints the discovered name as a second line under the pin. Typing
 * either of those two names has to find the row, and only the pin is in a
 * column, so the other half is resolved here (one indexed lookup per term-
 * bearing filter; nothing at all when neither filter carries a term).
 *
 * Deliberately NOT run for the `empty` / `is_not_empty` ops: those ask about
 * the Hostname cell's own value, which a pinned row always has.
 */
interface DiscoveredHostnameMatches {
  /** Hostname-column filter term hits, or null for "nothing to add". */
  hostnameIds: string[] | null;
  /** Free-text `search` param hits, or null. */
  searchIds: string[] | null;
}

const NO_DISCOVERED_MATCHES: DiscoveredHostnameMatches = { hostnameIds: null, searchIds: null };

/**
 * Ids matching the Tags column's term (contains / not_contains), or null when
 * the tags filter carries no term. Resolved before buildAssetListWhere for the
 * same reason as the discovered-hostname ids: a substring inside a String[] is
 * not expressible as a Prisma where.
 */
async function resolveTagMatches(raw: Record<string, unknown>): Promise<string[] | null> {
  const value = typeof raw["tags"] === "string" ? (raw["tags"] as string) : undefined;
  const op = typeof raw["tagsOp"] === "string" ? (raw["tagsOp"] as string) : undefined;
  if (!tagFilterNeedsLookup(value, op)) return null;
  return findAssetIdsByTagSubstring(value as string);
}

async function resolveDiscoveredHostnameMatches(
  q: z.infer<typeof AssetListQuerySchema>,
  raw: Record<string, unknown>,
): Promise<DiscoveredHostnameMatches> {
  const rawOp = typeof raw["hostnameOp"] === "string" ? (raw["hostnameOp"] as string) : undefined;
  // Mirror buildPrismaTextFilter's op resolution exactly — an unrecognized op
  // falls back to `contains` there, so it must here too.
  const op = rawOp && ASSET_TEXT_OPS.has(rawOp) ? rawOp : "contains";
  const hostnameTerm = op === "contains" || op === "not_contains"
    ? (typeof raw["hostname"] === "string" ? (raw["hostname"] as string).trim() : "")
    : "";
  const searchTerm = (q.search ?? "").trim();
  if (!hostnameTerm && !searchTerm) return NO_DISCOVERED_MATCHES;

  const empty = new Map<string, string>();
  const [hostnameHits, searchHits] = await Promise.all([
    hostnameTerm ? findAssetIdsByDiscoveredHostname([hostnameTerm]) : Promise.resolve(empty),
    searchTerm ? findAssetIdsByDiscoveredHostname([searchTerm]) : Promise.resolve(empty),
  ]);
  return {
    hostnameIds: hostnameHits.size ? Array.from(hostnameHits.keys()) : null,
    searchIds: searchHits.size ? Array.from(searchHits.keys()) : null,
  };
}

/**
 * Build the Prisma `where` from validated list-query params. Shared by the list
 * endpoint and the "export filtered" path so both honor exactly the same
 * filters.
 */
function buildAssetListWhere(
  q: z.infer<typeof AssetListQuerySchema>,
  raw: Record<string, unknown>,
  sessionUsername: string | undefined,
  discovered: DiscoveredHostnameMatches = NO_DISCOVERED_MATCHES,
  tagIds: string[] | null = null,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];

  const statuses = csvToArray(q.status);
  if (statuses) where.status = statuses.length === 1 ? statuses[0] : { in: statuses };

  const assetTypes = csvToArray(q.assetType);
  if (assetTypes) where.assetType = assetTypes.length === 1 ? assetTypes[0] : { in: assetTypes };

  if (q.department) where.department = { contains: q.department, mode: "insensitive" };
  if (q.createdBy === "me") where.createdBy = sessionUsername ?? null;
  else if (q.createdBy) where.createdBy = q.createdBy;

  if (q.search) {
    where.OR = [
      { hostname:   { contains: q.search, mode: "insensitive" } },
      { dnsName:    { contains: q.search, mode: "insensitive" } },
      { ipAddress:  { contains: q.search, mode: "insensitive" } },
      { macAddress: { contains: q.search, mode: "insensitive" } },
      { assetTag:   { contains: q.search, mode: "insensitive" } },
      { assignedTo: { contains: q.search, mode: "insensitive" } },
    ];
    // Pinned rows whose DISCOVERED hostname matches — the `hostname` column
    // above only ever holds the pin.
    if (discovered.searchIds) {
      (where.OR as Record<string, unknown>[]).push({ id: { in: discovered.searchIds } });
    }
  }

  // Per-column operator-aware text filters.
  for (const [key, column] of Object.entries(ASSET_TEXT_COLUMNS)) {
    const value = typeof raw[key] === "string" ? (raw[key] as string) : undefined;
    const op = typeof raw[key + "Op"] === "string" ? (raw[key + "Op"] as string) : undefined;
    if (value == null && op == null) continue;
    if (key === "ipAddress" && op === "in_networks") {
      const netFrag = buildIpNetworksFilter(value);
      if (netFrag) and.push(netFrag);
      continue;
    }
    const frag = buildAssetTextFilter(column, value, op);
    if (!frag) continue;
    // The Hostname cell shows two names on a pinned row (the pin, plus the
    // discovered name underneath), so its filter spans both: `contains` matches
    // either, `not_contains` has to reject the row if EITHER name matches.
    if (key === "hostname" && discovered.hostnameIds) {
      const isNot = op === "not_contains";
      and.push(isNot
        ? { AND: [frag, { id: { notIn: discovered.hostnameIds } }] }
        : { OR: [frag, { id: { in: discovered.hostnameIds } }] });
      continue;
    }
    and.push(frag);
  }
  // `_server` spans location + learnedLocation.
  const serverVal = typeof raw["server"] === "string" ? (raw["server"] as string) : undefined;
  const serverOp = typeof raw["serverOp"] === "string" ? (raw["serverOp"] as string) : undefined;
  if (serverVal != null || serverOp != null) {
    const frag = buildServerFilter(serverVal, serverOp);
    if (frag) and.push(frag);
  }

  // Tags column (Asset.tags is a String[]; see assetTagListService).
  const tagsVal = typeof raw["tags"] === "string" ? (raw["tags"] as string) : undefined;
  const tagsOp = typeof raw["tagsOp"] === "string" ? (raw["tagsOp"] as string) : undefined;
  if (tagsVal != null || tagsOp != null) {
    const frag = buildTagFilter(tagsVal, tagsOp, tagIds ?? [], raw["tagsUntagged"] === "1");
    if (frag) and.push(frag);
  }

  // `_monitor` multi-select → OR of chip clauses.
  const monitorVals = csvToArray(q.monitor);
  if (monitorVals) {
    const clauses = monitorVals.map(monitorClause).filter((c): c is Record<string, unknown> => c !== null);
    if (clauses.length) and.push(clauses.length === 1 ? clauses[0] : { OR: clauses });
  }

  // lastSeen date range.
  if (q.lastSeenFrom || q.lastSeenTo) {
    const range: Record<string, Date> = {};
    if (q.lastSeenFrom) {
      const d = new Date(q.lastSeenFrom + "T00:00:00");
      if (!isNaN(+d)) range.gte = d;
    }
    if (q.lastSeenTo) {
      const d = new Date(q.lastSeenTo + "T23:59:59.999");
      if (!isNaN(+d)) range.lte = d;
    }
    if (range.gte || range.lte) where.lastSeen = range;
  }

  if (and.length) where.AND = and;
  return where;
}

/** Resolve a validated sort param into a Prisma orderBy. */
function buildAssetOrderBy(
  sortBy: string | undefined,
  sortDir: "asc" | "desc" | undefined,
): Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[] {
  if (!sortBy) return { createdAt: "desc" };
  if (!ASSET_SORT_COLUMNS[sortBy]) throw new AppError(400, `Invalid sortBy: ${sortBy}`);
  const dir: "asc" | "desc" = sortDir ?? "asc";
  // `_server` orders by location then its learnedLocation fallback.
  if (sortBy === "_server") return [{ location: dir }, { learnedLocation: dir }];
  return { [ASSET_SORT_COLUMNS[sortBy]]: dir };
}

// Compact HA projection for list rows. Non-null only for HA cluster members
// (fortinetTopology carrying haMode + haRole — stamped by the FMG/FortiGate
// firewall fan-out). `memberStatus` is the roster-reported member health
// ("up"/"down", absent when the roster carried no signal); `clusterIp` is the
// display-only cluster IP stamped on standby members (Asset.ipAddress stays
// null on the standby by design — see the fan-out comments in integrations.ts).
function shapeHaInfo(topo: unknown): { mode: string; role: string; memberStatus?: string; clusterIp?: string } | null {
  const t = topo as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;
  const { haMode: mode, haRole: role, haMemberStatus: memberStatus, haClusterIp: clusterIp } = t;
  if (typeof mode !== "string" || mode === "standalone" || typeof role !== "string") return null;
  return {
    mode,
    role,
    ...(typeof memberStatus === "string" ? { memberStatus } : {}),
    ...(typeof clusterIp === "string" ? { clusterIp } : {}),
  };
}

/**
 * Reduce `Asset.managementAccess` to the four fields the Assets list needs to
 * decide whether a row's menu offers Open HTTPS / Open SSH (`_assetMgmtAccess`
 * in public/js/assets.js). The stored blob also carries source / interfaceName
 * / profileName / snmp / checkedAt, which only the slide-over reads — and the
 * slide-over loads the full asset from GET /assets/:id.
 *
 * `protocols` is passed through as a NULL-vs-not signal only: null means the
 * access list could not be read (the best-effort switch path) and the client
 * then offers both verbs optimistically, so collapsing it to a boolean here
 * would be collapsing the very distinction the client branches on.
 */
function shapeManagementAccess(ma: unknown): { mgmtIp: string | null; protocols: string[] | null; https: boolean; ssh: boolean } | null {
  return shapeManagementAccessForClient(ma);
}

// Reduce an asset's monitoring transports to the compact array the
// "Monitored Via" list column renders. Empty = not monitored / nothing to
// show. An active Polaris Agent owns all streams, so it short-circuits to
// ["agent"]. Otherwise the six per-stream polling methods are resolved through
// the monitor-settings hierarchy (cached tiers — no per-row DB hit) and de-
// duplicated. ICMP is reachability-only and pairs with every telemetry
// transport, so it's treated as subordinate: a device with any non-ICMP
// transport reports that transport (or "Multiple" when several differ), and
// ICMP surfaces only when it's the sole method (ping-only monitoring).
async function computeMonitoringMethods(a: {
  monitored?: boolean;
  assetType?: unknown;
  ipAddress?: unknown;
  discoveredByIntegrationId?: unknown;
  discoveredByIntegration?: { type?: string | null } | null;
  managedAgent?: { installStatus?: string | null } | null;
  responseTimePolling?: unknown;
  cpuMemoryPolling?: unknown;
  temperaturePolling?: unknown;
  interfacesPolling?: unknown;
  lldpPolling?: unknown;
  storagePolling?: unknown;
}): Promise<string[]> {
  if (!a.monitored) return [];
  if (a.managedAgent?.installStatus === "active") return ["agent"];
  const resolved = await resolveMonitorSettings({
    assetType:                   typeof a.assetType === "string" ? a.assetType : "other",
    // Read by the Unraid / TrueNAS response-time default (ICMP only when pingable).
    ipAddress:                   typeof a.ipAddress === "string" ? a.ipAddress : null,
    discoveredByIntegrationId:   typeof a.discoveredByIntegrationId === "string" ? a.discoveredByIntegrationId : null,
    discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
    monitorIntervalSec:     null,
    cpuMemoryIntervalSec:   null,
    temperatureIntervalSec: null,
    systemInfoIntervalSec:  null,
    probeTimeoutMs:         null,
    responseTimePolling: typeof a.responseTimePolling === "string" ? a.responseTimePolling : null,
    cpuMemoryPolling:    typeof a.cpuMemoryPolling    === "string" ? a.cpuMemoryPolling    : null,
    temperaturePolling:  typeof a.temperaturePolling  === "string" ? a.temperaturePolling  : null,
    interfacesPolling:   typeof a.interfacesPolling   === "string" ? a.interfacesPolling   : null,
    lldpPolling:         typeof a.lldpPolling         === "string" ? a.lldpPolling         : null,
    storagePolling:      typeof a.storagePolling      === "string" ? a.storagePolling      : null,
  });
  const all = [
    resolved.responseTimePolling,
    resolved.cpuMemoryPolling,
    resolved.temperaturePolling,
    resolved.interfacesPolling,
    resolved.lldpPolling,
    resolved.storagePolling,
  ].filter((m): m is PollingMethod => m != null && m !== "disabled");
  const nonIcmp = [...new Set<string>(all.filter((m) => m !== "icmp"))];
  if (nonIcmp.length > 0) return nonIcmp;
  return all.includes("icmp") ? ["icmp"] : [];
}

async function enrichAssetList(
  assets: Array<{ ipAddress: string | null; associatedIpRows: unknown; macAddressRows: unknown; fortinetTopology?: unknown; managementAccess?: unknown } & Record<string, unknown>>,
) {
  // `hostnameDiscovered` — what discovery says the hostname is, for the rows
  // where an operator pin is currently overriding it (the list renders it as a
  // second line under the pinned name). Only pinned rows are looked up, so a
  // page with no overrides pays no query at all.
  const overriddenIds = assets
    .filter((a) => typeof a.hostnameOverride === "string" && a.hostnameOverride)
    .map((a) => a.id as string);

  // The three page-level lookups depend only on the fetched rows, not on each
  // other — one Promise.all instead of three serialized round trips on the
  // hottest list endpoint. `activeAlert` is the Name column's alert indicator
  // (worst live alert per device; ONE query for the whole page, see
  // activeAlertSummaryByAsset).
  // `addressConfidence` (business rule 103) — the list carries only score and
  // band per address; the full breakdown is the detail endpoint's, so a large
  // page doesn't ship every address's evidence list.
  const [discoveredHostnames, alertSummaries, ipCtx, confidence] = await Promise.all([
    overriddenIds.length ? getDiscoveredHostnames(overriddenIds) : Promise.resolve(new Map<string, string | null>()),
    activeAlertSummaryByAsset(assets.map((a) => a.id as string)),
    buildIpContexts(assets.map((a) => a.ipAddress).filter(Boolean) as string[]),
    buildAddressConfidence(assets.map((a) => a.id as string)),
  ]);
  const compactConfidence = (id: string): Record<string, { score: number; band: string }> => {
    const out: Record<string, { score: number; band: string }> = {};
    for (const [ip, r] of confidence.get(id) ?? []) out[ip] = { score: r.score, band: r.band };
    return out;
  };

  return Promise.all(assets.map(async ({
    associatedIpRows, macAddressRows, fortinetTopology, managementAccess,
    // Strip the raw resolver inputs from the wire shape — only the reduced
    // `monitoringMethods` array is surfaced to the list.
    responseTimePolling, cpuMemoryPolling, temperaturePolling, interfacesPolling, lldpPolling, storagePolling,
    discoveredByIntegration, managedAgent,
    ...a
  }) => ({
    ...a,
    associatedIps: shapeAssociatedIps(associatedIpRows as never),
    macAddresses: shapeMacRows(macAddressRows as never),
    hostnameDiscovered: discoveredHostnames.get(a.id as string) ?? null,
    ipContext: a.ipAddress ? (ipCtx.get(a.ipAddress) || null) : null,
    ha: shapeHaInfo(fortinetTopology),
    managementAccess: shapeManagementAccess(managementAccess),
    activeAlert: alertSummaries.get(a.id as string) ?? null,
    addressConfidence: compactConfidence(a.id as string),
    monitoringMethods: await computeMonitoringMethods({
      monitored: a.monitored as boolean | undefined,
      assetType: a.assetType,
      discoveredByIntegrationId: a.discoveredByIntegrationId,
      discoveredByIntegration: discoveredByIntegration as { type?: string | null } | null,
      managedAgent: managedAgent as { installStatus?: string | null } | null,
      responseTimePolling, cpuMemoryPolling, temperaturePolling, interfacesPolling, lldpPolling, storagePolling,
    }),
  })));
}

/**
 * One page of the assets list: resolve the discovered-hostname and tag
 * lookups, build the where clause, order (tags sort in memory, favorites
 * first when `favoriteIds` is given, else plain orderBy), page, and enrich.
 * `raw` is the untyped query, for the operator-aware `<col>Op` params the
 * schema does not name.
 */
export async function listAssetsPage(
  q: z.infer<typeof AssetListQuerySchema>,
  raw: Record<string, unknown>,
  actor: string | undefined,
): Promise<{ enriched: unknown[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(q.limit ?? ASSET_LIST_DEFAULT_LIMIT, ASSET_LIST_MAX_LIMIT);
  const offset = q.offset ?? 0;

  const [discovered, tagIds] = await Promise.all([
    resolveDiscoveredHostnameMatches(q, raw),
    resolveTagMatches(raw),
  ]);
  const where = buildAssetListWhere(q, raw, actor, discovered, tagIds);

  let favoriteIds = csvToArray(q.favoriteIds);
  if (favoriteIds && favoriteIds.length > ASSET_FAVORITES_MAX) {
    favoriteIds = favoriteIds.slice(0, ASSET_FAVORITES_MAX);
  }

  let assets: Array<Record<string, unknown>>;
  let total: number;

  if (q.sortBy === "tags") {
    // Tags sort: order the matching ids in memory (favorites first), then
    // load the page's rows and put them back in that order.
    const page = await pageAssetIdsByTags(where, q.sortDir ?? "asc", offset, limit, favoriteIds);
    total = page.total;
    const rows = page.ids.length
      ? await prisma.asset.findMany({ where: { id: { in: page.ids } }, select: ASSET_LIST_SELECT })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    assets = page.ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => r != null);
  } else if (favoriteIds && favoriteIds.length) {
    const orderBy = buildAssetOrderBy(q.sortBy, q.sortDir);
    // Two-bucket ordering: favorites (matching the active filters, sorted)
    // occupy virtual positions [0, favTotal); non-favorites follow. The
    // requested window may straddle the boundary, so query each bucket with
    // the appropriate skip/take and concatenate.
    const favWhere = { AND: [where, { id: { in: favoriteIds } }] };
    const nonFavWhere = { AND: [where, { id: { notIn: favoriteIds } }] };
    const [favTotal, totalCount] = await Promise.all([
      prisma.asset.count({ where: favWhere }),
      prisma.asset.count({ where }),
    ]);
    total = totalCount;
    const favPart = offset < favTotal
      ? await prisma.asset.findMany({ where: favWhere, orderBy, skip: offset, take: limit, select: ASSET_LIST_SELECT })
      : [];
    const remaining = limit - favPart.length;
    let nonFavPart: typeof favPart = [];
    if (remaining > 0) {
      const nonFavSkip = Math.max(0, offset - favTotal);
      nonFavPart = await prisma.asset.findMany({ where: nonFavWhere, orderBy, skip: nonFavSkip, take: remaining, select: ASSET_LIST_SELECT });
    }
    assets = [...favPart, ...nonFavPart];
  } else {
    const orderBy = buildAssetOrderBy(q.sortBy, q.sortDir);
    const [rows, totalCount] = await Promise.all([
      prisma.asset.findMany({ where, orderBy, skip: offset, take: limit, select: ASSET_LIST_SELECT }),
      prisma.asset.count({ where }),
    ]);
    assets = rows;
    total = totalCount;
  }

  const enriched = await enrichAssetList(assets as never);
  return { enriched: enriched as unknown[], total, limit, offset };
}
