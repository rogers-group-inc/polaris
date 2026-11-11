/**
 * src/api/routes/assets/list.ts — The asset collection: the server-side list (filter / sort / page), tags and
 * by-tag, settings (IP history, source priority, sightings), bulk monitor / tags,
 * mass pinning, quarantine availability, IP check. Split out of routes/assets.ts
 * (CQ-B062) and mounted FIRST, so these literal paths win over GET /:id.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, hasPermission, credentialUseActor, assertTagChangeAllowed } from "../../middleware/permissions.js";
import { resolveWriteScope, inWriteScope } from "../../../services/writeScopeService.js";
import { scopeAssetIds, requireFleetWide, idsFromBody } from "../../middleware/writeScope.js";
import { recordCredentialUse, assetCredentialDestination } from "../../../services/credentialUseAuditService.js";
import { checkIpForIncomingClaim } from "../../../services/duplicateIpConflictService.js";
import { requestActor } from "../../middleware/auth.js";
import { logEvent } from "../events.js";
import { statusAllowsMonitoring } from "../../../utils/assetInvariants.js";
import { getHistorySettings, updateHistorySettings, pruneOldHistory } from "../../../services/assetIpHistoryService.js";
import { getSightingSettings, updateSightingSettings } from "../../../services/assetSightingService.js";
import { getQuarantinePushAvailability } from "../../../services/assetQuarantineService.js";
import { isValidIpAddress, ipv4TermToMatchPrefixes } from "../../../utils/cidr.js";
import { buildIpContexts } from "../../../services/subnetService.js";
import { recomputeMonitorOverrideForAssets } from "../../../services/monitorOverrideService.js";
import { listAssetTags } from "../../../services/tagAssignmentService.js";
import { bulkEditAssetTags } from "../../../services/assetBulkTagService.js";
import { getDiscoveredHostnames, findAssetIdsByDiscoveredHostname } from "../../../services/discoveredHostnameService.js";
import { buildTagFilter, findAssetIdsByTagSubstring, listAssetsWithTag, pageAssetIdsByTags, tagFilterNeedsLookup } from "../../../services/assetTagListService.js";
import { shapeMacRows, MAC_ROW_SELECT } from "../../../utils/macAddresses.js";
import { isAllZeroMac } from "../../../utils/mac.js";
import { csvParam } from "../../../utils/text.js";
import { buildPrismaTextFilter, TEXT_FILTER_OPS } from "../../../utils/prismaTextFilter.js";
import { resolveMonitorSettings } from "../../../services/monitoringService.js";
import { shapeManagementAccessForClient } from "../../../services/fortinetManagementAccessService.js";
import { activeAlertSummaryByAsset } from "../../../services/notificationService.js";
import { listScopeOptions } from "../../../services/notificationRuleService.js";
import { SCOPE_FIELD_OPS, scopeConditionMeta, scopeConditionSchema } from "../../../services/notificationTypes.js";
import { loadScopeAssetIds } from "../../../services/notificationEngine.js";
import { listAssetTypes } from "../../../services/assetTypeService.js";
import { applyMassPins, getPinInventoryForAssets, MASS_PIN_MAX_ASSETS, MASS_PIN_MAX_DELTAS } from "../../../services/massPinService.js";
import { type PollingMethod } from "../../../utils/pollingCompatibility.js";
import { buildAddressConfidence } from "../../../services/addressConfidenceService.js";
import { shapeAssociatedIps, ASSOCIATED_IP_SELECT, clampMonitoredState, assertCredentialAssignments } from "./shared.js";

const router = Router();

// ─── ipContext helpers ──────────────────────────────────────────────────────
//
// buildIpContexts + IpContext moved to subnetService (2026-08 audit): the
// most-specific-containing-subnet SQL now has a single implementation shared
// with the dns_resolved reconciler.

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

const AssetsByTagQuerySchema = z.object({
  tag: z.string().trim().min(1).max(128),
});

const AssetListQuerySchema = z.object({
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

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/assets — list assets (all authenticated users). Server-side
// filter / sort / pagination; favorites-first ordering when `favoriteIds` is
// supplied (operator's starred ids float to the top of the whole result set,
// not just the current page).
router.get("/", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const parsed = AssetListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query: " + parsed.error.issues[0].message);
    }
    const q = parsed.data;
    const limit = Math.min(q.limit ?? ASSET_LIST_DEFAULT_LIMIT, ASSET_LIST_MAX_LIMIT);
    const offset = q.offset ?? 0;

    const raw = req.query as Record<string, unknown>;
    const [discovered, tagIds] = await Promise.all([
      resolveDiscoveredHostnameMatches(q, raw),
      resolveTagMatches(raw),
    ]);
    const where = buildAssetListWhere(q, raw, requestActor(req), discovered, tagIds);

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
    // Rule 141 (e): what THIS caller may change, per row — server-computed so
    // the page never re-derives tag matching. Pure set lookups over columns
    // already selected; nothing more at 2000 rows.
    const [editScope, quarantineScope, maintScope] = await Promise.all([resolveWriteScope(req, "assets"), resolveWriteScope(req, "assetsQuarantine"), resolveWriteScope(req, "maintenanceManagement")]);
    const flagged = (enriched as Array<Record<string, unknown>>).map((a) => ({
      ...a,
      canEdit: inWriteScope(editScope, a as { createdBy: string | null; tags?: string[] }),
      canQuarantine: inWriteScope(quarantineScope, a as { createdBy: string | null; tags?: string[] }),
      canMaintain: inWriteScope(maintScope, a as { createdBy: string | null; tags?: string[] }),
    }));
    res.json({ assets: flagged, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-history-settings — get history retention settings (all authenticated users)
// Must be defined before /:id to avoid route shadowing.
router.get("/ip-history-settings", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    res.json(await getHistorySettings());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/tags — distinct tags across all assets, for autocomplete
// (notification-rule scope picker, etc.). One scan with a tight select.
router.get("/tags", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const rows = await prisma.asset.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { tags: true } });
    const set = new Set<string>();
    for (const r of rows) for (const t of r.tags) set.add(t);
    res.json({ tags: Array.from(set).sort() });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/by-tag?tag=<name> — the assets carrying exactly this tag
// (case-sensitive, as Asset.tags stores it). Drives the Server Settings tag
// registry's "assets with this tag" slide-over. The list endpoint's Tags filter
// is a substring match ("prod" also finds "production"), so it cannot answer
// this. Capped; `total` is the uncapped count.
router.get("/by-tag", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const parsed = AssetsByTagQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, "Invalid query: " + parsed.error.issues[0].message);
    res.json(await listAssetsWithTag(parsed.data.tag));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/agent-signing-alert — the durable "last agent build
// shipped UNSIGNED Windows binaries" stamp (Setting `agent.signing.lastFailure`,
// written by agentBuildService's fail-open signing step; cleared by the next
// fully-signed build or by disabling signing). Drives the dismissable sidebar
// alert in app.js. Gated assets:write — the agent-DEPLOY permission (same gate
// as /:id/agent/install below) — deliberately NOT under /server-settings,
// whose router-level serverSettingsSystem gate only admin passes.
router.get("/agent-signing-alert", requirePermission("assets", "write"), async (_req, res, next) => {
  try {
    const { getSigningAlert } = await import("../../../services/agentSigningService.js");
    res.json(await getSigningAlert());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/source-priority — the operator's Sources-column priority
// (which discovery source's learned location wins) plus the catalogue of what
// each source contributes, so the drag-and-drop list renders its labels and
// hints from the server rather than hardcoding them. Before /:id.
router.get("/source-priority", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const { getSourcePrioritySettings } = await import("../../../services/assetSourcePriorityService.js");
    res.json(await getSourcePrioritySettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/source-priority — reorder / toggle the integration-name
// prefix. assets:write, matching the other settings on the Assets → Settings
// modal; the service audits the change with the previous order.
router.put("/source-priority", requirePermission("assets", "write"), requireFleetWide("assets", "the source priority"), async (req, res, next) => {
  try {
    const body = z.object({
      order: z.array(z.string()).optional(),
      integrationPrefix: z.boolean().optional(),
    }).parse(req.body);
    const { saveSourceLocationPriority, getSourcePrioritySettings } =
      await import("../../../services/assetSourcePriorityService.js");
    await saveSourceLocationPriority(body, requestActor(req));
    res.json(await getSourcePrioritySettings());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-context?ip=10.4.12.63 — everything Polaris already
// knows about one address, for the manual Add Asset form: the containing
// network, the lease/reservation sitting on it, the gate ARP caches and
// FortiGate sightings that have resolved it, the switch port its MAC shows up
// on, and any asset already carrying it. Read-only; creates nothing. Before
// /:id (a bare word would otherwise be captured as an asset id).
//
// Gated assets:read, with the two IPAM halves gated a second time on the
// caller's own subnets/reservations access — the dashboard precedent. Which
// sections were consulted rides back in `visibility`, so a role that can't see
// networks reads "not shown" rather than a confident "no network found".
router.get("/ip-context", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const ip = typeof req.query.ip === "string" ? req.query.ip : "";
    const { lookupIpContext } = await import("../../../services/ipContextService.js");
    const result = await lookupIpContext(ip, {
      includeSubnets: hasPermission(req, "subnets", "read"),
      includeReservations: hasPermission(req, "reservations", "read"),
    });
    // A half-typed address is the normal case on a debounced keystroke, not an
    // error — answer 200 with nothing found rather than 400-ing per character.
    res.json(result ?? { ip: ip.trim(), unparseable: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/ip-history-settings — update retention settings (assets admin)
router.put("/ip-history-settings", requirePermission("assets", "write"), requireFleetWide("assets", "the IP-history settings"), async (req, res, next) => {
  try {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(0).max(3650) }).parse(req.body);
    await updateHistorySettings({ retentionDays });
    const pruned = await pruneOldHistory();
    logEvent({ action: "asset.history_settings.updated", actor: requestActor(req), message: `IP history retention set to ${retentionDays} day(s)${pruned ? `; pruned ${pruned} old record(s)` : ""}` });
    res.json({ ok: true, pruned });
  } catch (err) {
    next(err);
  }
});

// Note: the legacy GET/PUT /monitor-settings routes were retired with the
// move to the four-tier hierarchy. Operators now use:
//   - /api/v1/monitor-settings/manual                → global manual tier
//   - /api/v1/monitor-settings/integration/:id       → per-integration tier
//   - /api/v1/monitor-settings/class-overrides       → (class + integration)
//   - PUT /api/v1/assets/:id  with monitorIntervalSec / probeTimeoutMs / etc.
//                                                    → per-asset overrides
// See src/api/routes/monitorSettings.ts.

// POST /api/v1/assets/bulk-monitor — enable/disable monitoring on a set of assets.
// Body: { ids, monitored, monitorCredentialId?, monitorIntervalSec?, probeTimeoutMs? }.
// On enable: applies the same credential + cadence overrides uniformly. The
// polling method comes from the resolver (per-asset overrides set via PUT,
// class overrides, integration-tier setting, source default) — the bulk
// endpoint isn't the place to choose a method, since one selection rarely
// fits a heterogeneous batch. Operators picking a method per-asset use the
// asset edit modal's Monitoring tab.
// Returns per-id error list for any rejected rows.
router.post("/bulk-monitor", requirePermission("assets", "write"), scopeAssetIds("assets", "change monitoring on devices", idsFromBody), async (req, res, next) => {
  try {
    const body = z.object({
      ids:                 z.array(z.string().uuid()).min(1),
      monitored:           z.boolean(),
      monitorCredentialId: z.string().uuid().nullable().optional(),
      monitorIntervalSec:  z.number().int().min(5).max(86400).nullable().optional(),
      probeTimeoutMs:      z.number().int().min(100).max(60000).nullable().optional(),
    }).parse(req.body);

    // Existence only, and deliberately so: the batch carries ONE credential id
    // for every asset in it, so this is a single query no matter how many ids
    // were selected. The per-stream TYPE check the PUT does would need each
    // asset's own polling columns — 2000 rows of them on a full-fleet select —
    // to answer a question this endpoint cannot ask anyway, since it only sets
    // the asset-level default, which is never type-checked.
    await assertCredentialAssignments({ monitorCredentialId: body.monitorCredentialId }, null);

    // Build the per-asset data shape ONCE — every selected asset gets the
    // same monitor config in a bulk operation. monitorOverride is NOT set
    // here because it depends on each asset's discoveredByIntegrationId +
    // assetType (per-asset-varying) — instead we recompute it in one SQL
    // pass against the touched ids after the updateMany lands.
    const data: Record<string, unknown> = {
      monitored: body.monitored,
    };
    if (body.monitorCredentialId !== undefined) data.monitorCredentialId = body.monitorCredentialId;
    if (body.monitorIntervalSec !== undefined)  data.monitorIntervalSec  = body.monitorIntervalSec;
    if (body.probeTimeoutMs !== undefined)      data.probeTimeoutMs      = body.probeTimeoutMs;
    clampMonitoredState(data);

    // Identify which of the requested ids actually exist so the response
    // can flag missing rows. One round-trip vs the previous N-asset loop.
    const found = await prisma.asset.findMany({
      where: { id: { in: body.ids } },
      select: { id: true, status: true, hostname: true, dnsName: true, ipAddress: true, monitorCredentialId: true },
    });
    const foundSet = new Set(found.map((a) => a.id));
    const errors: Array<{ id: string; error: string }> = body.ids
      .filter((id) => !foundSet.has(id))
      .map((id) => ({ id, error: "Asset not found" }));

    // Enabling monitoring on a status that can't carry it (business rule 10):
    // named per id rather than left to the db.ts clamp. A mixed selection is
    // the normal case here — the operator multi-selected a page of assets —
    // so the skipped rows are REPORTED and the rest still go through, instead
    // of failing the whole batch or silently updating rows whose box stays
    // clear.
    if (body.monitored) {
      for (const a of found) {
        if (statusAllowsMonitoring(a.status)) continue;
        foundSet.delete(a.id);
        errors.push({ id: a.id, error: `A ${String(a.status)} asset cannot be monitored` });
      }
    }

    // Single bulk update — Postgres' `WHERE id = ANY(...)` planner walks
    // the (newly-added) primary key once and applies the uniform data
    // change to every matched row. Was 1000 sequential round-trips, is
    // now one statement.
    let updatedCount = 0;
    if (foundSet.size > 0) {
      const result = await prisma.asset.updateMany({
        where: { id: { in: [...foundSet] } },
        data: data as any,
      });
      updatedCount = result.count;
      // Recompute monitorOverride for every touched asset in one SQL UPDATE.
      // Each asset's override depends on its discoveredByIntegrationId +
      // assetType, so it has to be done per-asset against the integration's
      // per-class addAsMonitored. Assets without an integration link are
      // skipped by the WHERE clause and keep monitorOverride=false.
      await recomputeMonitorOverrideForAssets(prisma, [...foundSet]);
      // Rule 112: the credential now goes to every touched asset's address.
      if (body.monitorCredentialId) {
        const credId = body.monitorCredentialId;
        const uses = found
          .filter((a) => foundSet.has(a.id) && a.monitorCredentialId !== credId)
          .map((a) => ({ credentialId: credId, destination: assetCredentialDestination(a), assetId: a.id, assetName: a.hostname ?? a.ipAddress }));
        if (uses.length) await recordCredentialUse(credentialUseActor(req), "asset.bulk-monitor", uses);
      }
    }

    logEvent({
      action: body.monitored ? "monitor.bulk_enabled" : "monitor.bulk_disabled",
      resourceType: "asset",
      actor: requestActor(req),
      message: `Bulk ${body.monitored ? "enabled" : "disabled"} monitoring on ${updatedCount} asset(s)` + (errors.length ? `; ${errors.length} error(s)` : ""),
      details: errors.length ? { errors } : undefined,
    });
    res.json({ updated: updatedCount, errors });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/bulk-tags — add / remove / replace tags on a set of
// assets (Assets page bulk bar "Tags"). Body: { ids, mode, tags }. Same gate
// as PUT /:id, which is the single-asset tag write. Semantics — including the
// managed prefixes a replace keeps — live in assetBulkTagService.
const BulkTagsSchema = z.object({
  ids:  z.array(z.string().uuid()).min(1).max(10000),
  mode: z.enum(["add", "remove", "replace"]),
  tags: z.array(z.string().max(128)).max(200),
});

router.post("/bulk-tags", requirePermission("assets", "write"), scopeAssetIds("assets", "tag devices", idsFromBody), async (req, res, next) => {
  try {
    const body = BulkTagsSchema.parse(req.body);
    // The whole verb is a tag change, so it is the Tags key's grant chained
    // on the asset edit it also is.
    assertTagChangeAllowed(req, [], body.tags.length ? body.tags : ["(any)"]);
    const result = await bulkEditAssetTags(body);
    const verb = body.mode === "add" ? "Added" : body.mode === "remove" ? "Removed" : "Replaced";
    const tagList = result.tags.length ? result.tags.join(", ") : "(none)";
    logEvent({
      action: "asset.bulk_tags",
      resourceType: "asset",
      actor: requestActor(req),
      message: `${verb} tags [${tagList}] on ${result.updated} asset(s)` +
        (result.unchanged ? `; ${result.unchanged} already matched` : "") +
        (result.notFound.length ? `; ${result.notFound.length} not found` : ""),
      details: { mode: body.mode, tags: result.tags, updated: result.updated, unchanged: result.unchanged, notFound: result.notFound },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Mass Pinning (Assets → Settings → Mass Pinning section) ─────────────────
//
// Manual bulk pin/unpin of fast-cadence targets (interfaces incl. IPsec
// tunnels, storage mounts) across a condition-filtered device set. Three
// endpoints; business logic lives in services/massPinService.ts. The UI button
// is data-admin-only, but the endpoints are gated assets:read / assets:write
// for API-token parity (the bulk-monitor posture).

// The device-filter scope: the automations condition-tree vocabulary
// (SCOPE_FIELD_OPS), or the explicit all-assets flag. One of the two is
// required — a bare {} must never quietly mean "the whole fleet".
const MassPinScopeSchema = z.object({
  allAssets: z.boolean().optional(),
  condition: scopeConditionSchema.optional(),
}).refine((v) => v.allAssets === true || v.condition !== undefined, {
  message: "Provide a condition or allAssets: true",
});

// GET /api/v1/assets/pin-filter-schema — the condition builder's vocabulary +
// value suggestions for the Mass Pinning section. Its own route rather than
// /automations/schema + /scope-options because those are gated
// automationManagement:read, and pinning interfaces must not require
// permission to edit automations (the contacts /filter-schema precedent).
// Built from the same shared scopeConditionMeta so vocabularies can't drift —
// this one carries the NARROW automations field set, matching what the
// automation wizard's Devices step offers.
router.get("/pin-filter-schema", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const [options, assetTypes, tags] = await Promise.all([
      listScopeOptions(),
      listAssetTypes(),
      listAssetTags(),
    ]);
    res.json({
      scopeCondition: scopeConditionMeta(SCOPE_FIELD_OPS),
      options: {
        ...options,
        assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
        tags,
      },
      maxAssets: MASS_PIN_MAX_ASSETS,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/pin-inventory — resolve the device filter server-side
// (the client never ships thousands of ids) and return the matched assets'
// facet inventory aggregated by name, with per-device pinned state so the
// client renders tri-state checkboxes from one call. mode:"count" is the
// cheap half the debounced filter preview uses. Matched sets over
// MASS_PIN_MAX_ASSETS refuse the full inventory (overCap) rather than
// truncating — a cut device list would make "pinned on ALL devices" a lie.
router.post("/pin-inventory", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const body = MassPinScopeSchema.and(z.object({
      facet: z.enum(["interfaces", "storage"]),
      mode:  z.enum(["count", "full"]).default("full"),
    })).parse(req.body);

    const ids = await loadScopeAssetIds(
      body.allAssets === true ? { allAssets: true } : { condition: body.condition as any },
    );
    if (body.mode === "count") {
      res.json({ matchedCount: ids.length });
      return;
    }
    if (ids.length > MASS_PIN_MAX_ASSETS) {
      res.json({ matchedCount: ids.length, overCap: true });
      return;
    }
    const inventory = await getPinInventoryForAssets(ids, body.facet);
    res.json({ matchedCount: ids.length, overCap: false, inventory });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/mass-pins — apply staged pin/unpin deltas. Deltas (not
// final arrays) so a concurrent hand-pin of an unrelated name on the same
// asset is never clobbered; the 64-per-array cap is re-enforced per asset in
// the service (overflow = per-asset skip with reason, never a batch 400).
router.post("/mass-pins", requirePermission("assets", "write"), scopeAssetIds("assets", "pin interfaces on devices", (r) => [...((r.body && r.body.pin) || []), ...((r.body && r.body.unpin) || [])].map((d: { assetId?: unknown }) => (d && typeof d.assetId === "string" ? d.assetId : ""))), async (req, res, next) => {
  try {
    const DeltaSchema = z.object({
      assetId: z.string().uuid(),
      name:    z.string().min(1).max(256),
      field:   z.enum(["interfaces", "ipsecTunnels", "storage"]),
    });
    const body = z.object({
      pin:   z.array(DeltaSchema).max(MASS_PIN_MAX_DELTAS).default([]),
      unpin: z.array(DeltaSchema).max(MASS_PIN_MAX_DELTAS).default([]),
    }).refine((b) => b.pin.length + b.unpin.length > 0, { message: "No pin changes supplied" })
      .parse(req.body);

    res.json(await applyMassPins(body, requestActor(req) ?? "unknown"));
  } catch (err) { next(err); }
});

// GET /api/v1/assets/agent-install-scripts — curated install-method catalog
// for the deploy modal's picker. MUST stay above GET /:id so the literal path
// isn't captured as an asset id. Read-only metadata (no secrets); gated read.
router.get("/agent-install-scripts", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const { AGENT_INSTALL_SCRIPTS } = await import("../../../services/agentInstallScripts.js");
    res.json({ scripts: AGENT_INSTALL_SCRIPTS });
  } catch (err) { next(err); }
});

// GET /api/v1/assets/quarantine-availability — is quarantine push configured
// on ANY enabled FortiManager / FortiGate integration? Drives whether the
// frontends offer the quarantine verbs at all (row menu, bulk bar, details
// tab): with the per-integration toggle off fleet-wide a push can only fail
// with "0/0 FortiGate(s) accepted the push". MUST stay above GET /:id so the
// literal path isn't captured as an asset id. Gated on the quarantine key at
// read level — the callers already hold `assetsQuarantine:write`, and the
// answer says nothing about any individual integration.
router.get(
  "/quarantine-availability",
  requirePermission("assetsQuarantine", "read"),
  async (_req, res, next) => {
    try {
      res.json(await getQuarantinePushAvailability());
    } catch (err) { next(err); }
  },
);

// GET|PUT /api/v1/assets/sighting-settings — the quarantine sighting max-age.
// MUST stay above GET /:id and PUT /:id (the quarantine-availability rule):
// these two literals sat BELOW the parameterized routes from the day they
// shipped, so Express captured them as id="sighting-settings" and both verbs
// answered 404 "Asset not found" — unreachable until 2026-09-02. Nothing in
// the UI calls them (the api.js wrappers are unused), so only external API
// callers ever hit the shadowing; found while authoring /api docs.
router.get("/sighting-settings", requirePermission("assetsQuarantine", "read"), async (_req, res, next) => {
  try {
    res.json(await getSightingSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/sighting-settings", requirePermission("assetsQuarantine", "write"), requireFleetWide("assetsQuarantine", "the sighting settings"), async (req, res, next) => {
  try {
    const Schema = z.object({ sightingMaxAgeDays: z.number().int().min(0).max(3650) });
    const input = Schema.parse(req.body);
    await updateSightingSettings(input);
    logEvent({
      action: "asset.sighting_settings_updated",
      actor: requestActor(req),
      message: `Quarantine sighting max-age set to ${input.sightingMaxAgeDays} day(s)`,
    });
    res.json(input);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id — get single asset (all authenticated users)
// GET /api/v1/assets/ip-check?ip=&excludeAssetId=&assetType=&macAddress=
//
// The asset form's pre-save question (business rule 40(i)): who else is on
// this address, and would saving raise a duplicate-ip conflict? Answered by
// SIMULATING the incoming claim through the same grouping the sweep uses, so
// what the dialog warns about is exactly what the save will raise. Read-only;
// `assets:read` because the assets list already exposes every IP it names.
//
// `canMerge` rides along so the form's "review merge" button is gated by the
// SERVER's answer rather than a client-side re-derivation of the matrix — the
// too-strict-client-gate trap this codebase has hit before.
//
// Declared above `/:id` so Express does not read "ip-check" as an asset id.
const IpCheckQuerySchema = z.object({
  ip: z.string().trim().min(1),
  excludeAssetId: z.string().trim().min(1).optional(),
  assetType: z.string().trim().min(1).optional(),
  macAddress: z.string().trim().min(1).optional(),
});

router.get("/ip-check", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const q = IpCheckQuerySchema.parse(req.query);
    if (!isValidIpAddress(q.ip)) throw new AppError(400, `"${q.ip}" is not a valid IP address`);
    const result = await checkIpForIncomingClaim({
      ip: q.ip,
      excludeAssetId: q.excludeAssetId ?? null,
      assetType: q.assetType ?? null,
      // All-zero → null: no incoming device is identified by "no MAC".
      macAddress: q.macAddress && !isAllZeroMac(q.macAddress) ? q.macAddress.toUpperCase().replace(/-/g, ":") : null,
    });
    // Merging any two assets is its own key from 2026-11-03; release 2 of the
    // write-scope change adds "or you own both" at assets:write.
    res.json({ ...result, canMerge: hasPermission(req, "assetMerge", "write") });
  } catch (err) {
    next(err);
  }
});

export default router;
