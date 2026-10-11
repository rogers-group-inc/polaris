/**
 * src/services/genericApiService.ts — the Generic API ("build your own")
 * integration: read an operator-described REST endpoint, page through it, and
 * map each record onto an asset through JSON paths.
 *
 * Business rule 100. Inventory only (v1). The service READS and MAPS; turning mapped records into
 * assets is `services/discovery/genericApiSync.ts`. Nothing here monitors,
 * pushes or writes to the source.
 *
 * ── What keeps an operator-shaped request safe ──────────────────────────────
 *   - Every outbound host — the endpoint, an OAuth token URL, a pagination
 *     link — passes `assertOutboundHostAllowed` (utils/netGuard.ts). A
 *     pagination or Link URL must also stay on the endpoint's own origin: a
 *     feed cannot steer Polaris to a second host.
 *   - Redirects are not followed; a 3xx is reported, never chased.
 *   - Every page is size-capped (MAX_PAGE_BYTES), every request time-capped,
 *     and the run is capped in pages and records. Hitting a cap marks the read
 *     INCOMPLETE, which is what keeps the disappearance sweep from reading a
 *     truncated feed as deletions.
 *   - The mapping is JSON paths (utils/jsonPath.ts): nothing executes.
 *   - Secrets live only in the sealed keys `apiToken`, `password` and
 *     `clientSecret` (utils/configSecretFields.ts). Custom headers are NOT
 *     sealed and the form says so.
 */

import http from "node:http";
import https from "node:https";
import { AppError } from "../utils/errors.js";
import { assertOutboundHostAllowed } from "../utils/netGuard.js";
import { isValidIpAddress, normalizeCidr } from "../utils/cidr.js";
import { normalizeMacsDistinct } from "../utils/mac.js";
import { usableSerialOrNull } from "../utils/serialNumber.js";
import {
  JsonPathError,
  parseJsonPath,
  readJsonPathString,
  readJsonPathStrings,
  selectRecords,
} from "../utils/jsonPath.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { isValidGeoCoord } from "../utils/geo.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { validateStateMap } from "../utils/stateProbes.js";

// ─── Config ───────────────────────────────────────────────────────────────────

export type GenericApiAuthType = "none" | "bearer" | "basic" | "header" | "query" | "oauth2";
export type GenericApiPaginationMode = "none" | "page" | "offset" | "cursor" | "link";
export type GenericApiIdentityField = "id" | "serialNumber" | "macAddress" | "hostname";

/** The asset fields a record can be mapped onto, each by a JSON path. */
export const GENERIC_API_FIELDS = [
  "id",
  "hostname",
  "ipAddress",
  "macAddress",
  "serialNumber",
  "manufacturer",
  "model",
  "os",
  "osVersion",
  "assetType",
  "location",
  "assetTag",
  "department",
  "assignedTo",
  "description",
  "tags",
  "acquiredAt",
  "warrantyExpiry",
  "purchaseOrder",
  "latitude",
  "longitude",
] as const;
export type GenericApiField = (typeof GENERIC_API_FIELDS)[number];

/**
 * The fields a detail query can fill — every field but the record id. The
 * identity (and so presence, duplicates and the sweep) is settled by the
 * MAIN query alone, before any detail request is made: a detail request that
 * fails can cost a record some fields, never its asset.
 */
export const GENERIC_API_DETAIL_FIELDS = GENERIC_API_FIELDS.filter((f) => f !== "id");

/**
 * A second request made once per record, its path built from that record
 * ("/api/devices/{{uuid}}/hardware" — each `{{…}}` is a JSON path into the main
 * record, URL-encoded into the path). Same host, auth and headers as the
 * main request. Its paths are written against the detail RESPONSE. A field
 * mapped here wins over the same field from the main query (and a later
 * detail query over an earlier one) whenever it yields a value.
 */
export interface GenericApiDetailQuery {
  name?: string;
  path: string;
  method?: "GET" | "POST";
  body?: string;
  fieldMap?: Partial<Record<GenericApiField, string>>;
}

export interface GenericApiPagination {
  mode: GenericApiPaginationMode;
  /** page: the page-number parameter. offset: the offset parameter. */
  pageParam?: string;
  /** page / offset: the page-size parameter (blank = do not send one). */
  sizeParam?: string;
  pageSize?: number;
  /** page: the first page's number (0 or 1). */
  startPage?: number;
  /** cursor: where the next cursor (or next URL) sits in each response. */
  cursorPath?: string;
  /** cursor: the parameter the cursor is sent back in. */
  cursorParam?: string;
  maxPages?: number;
}

export interface GenericApiHeader {
  name: string;
  value: string;
}

// ─── Monitor queries (rule 100(i)) ─────────────────────────────────────────────
//
// A monitor query feeds ONE monitor stream (or a set of custom widgets) for the
// assets this integration discovered, read by the `genericapi` polling method
// (services/genericApiMonitorService.ts). Two scopes:
//   fleet — one request (paged like the inventory when `paginate`) answers for
//           every asset; each record is joined to an asset by `matchPath`,
//           normalized like the integration's identity field.
//   asset — one request per asset, its path / body a `{{path}}` template read
//           from the asset's own record as the inventory last mapped it
//           (`identity`, `hostname`, `ip`, `serial`, `mac`, …).
// Either way the result is one DOCUMENT per asset, and `map` / `itemsPath` /
// `widgets` read the stream's values out of it.

export const GENERIC_API_MONITOR_STREAMS = [
  "responseTime", "cpuMemory", "interfaces", "storage", "temperature", "lldp", "widgets",
] as const;
export type GenericApiMonitorStream = (typeof GENERIC_API_MONITOR_STREAMS)[number];

/** The keys each stream's `map` may name, and the ones it must. */
export const GENERIC_API_MONITOR_FIELDS: Record<GenericApiMonitorStream, { keys: readonly string[]; required: readonly string[][] }> = {
  responseTime: { keys: ["up", "latencyMs", "uptimeSec"], required: [["up"]] },
  cpuMemory:    { keys: ["cpuPct", "memPct", "memUsed", "memTotal", "memFree"], required: [["cpuPct", "memPct", "memUsed"]] },
  interfaces:   {
    keys: ["name", "operStatus", "adminStatus", "speedBps", "speedMbps", "inOctets", "outOctets", "inErrors", "outErrors", "macAddress", "ipAddress", "description", "alias"],
    required: [["name"]],
  },
  storage:      { keys: ["mountPath", "total", "used", "free"], required: [["mountPath"], ["total"]] },
  temperature:  { keys: ["name", "celsius"], required: [["name"], ["celsius"]] },
  lldp:         {
    keys: ["localIfName", "chassisId", "portId", "portDescription", "systemName", "systemDescription", "managementIp"],
    required: [["localIfName"], ["chassisId", "portId", "systemName"]],
  },
  widgets:      { keys: [], required: [] },
};

/** Streams whose document holds a LIST of rows (`itemsPath`). */
export const GENERIC_API_LIST_STREAMS: ReadonlySet<GenericApiMonitorStream> = new Set(["interfaces", "storage", "temperature", "lldp"]);

/** The integration-tier polling key each stream's default lives under (widgets have none). */
export const GENERIC_API_STREAM_POLLING_KEY: Partial<Record<GenericApiMonitorStream, string>> = {
  responseTime: "responseTimePolling",
  cpuMemory:    "cpuMemoryPolling",
  interfaces:   "interfacesPolling",
  storage:      "storagePolling",
  temperature:  "temperaturePolling",
  lldp:         "lldpPolling",
};

export type GenericApiByteUnit = "B" | "KB" | "MB" | "GB" | "TB";
export const GENERIC_API_BYTE_UNITS: Record<GenericApiByteUnit, number> = {
  B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4,
};

export interface GenericApiWidgetDef {
  name: string;
  type: "gauge" | "line" | "state";
  /** Path into the asset's document. */
  path: string;
  unit?: string;
  min?: number;
  max?: number;
  warningAt?: number;
  /** state only — utils/stateProbes.ts StateMap (mode, values, labels, polarity). */
  stateMap?: unknown;
}

export interface GenericApiMonitorQuery {
  name?: string;
  stream: GenericApiMonitorStream;
  scope: "fleet" | "asset";
  path: string;
  method?: "GET" | "POST";
  body?: string;
  /** fleet: where the records sit in the response. */
  recordsPath?: string;
  /** fleet: the path in each record that holds the asset's identity. */
  matchPath?: string;
  /** fleet: page through the response with the integration's pagination settings. */
  paginate?: boolean;
  /** list streams: where the rows sit in the asset's document (blank = the document is the list). */
  itemsPath?: string;
  /** stream key → path, against the document (or each row of a list stream). */
  map?: Record<string, string>;
  /** responseTime: the `up` values that mean up (case-insensitive). Blank = a common set. */
  upValues?: string[];
  /** cpuMemory / storage: the unit the byte figures are in. */
  byteUnit?: GenericApiByteUnit;
  /** widgets: the widgets this query feeds. */
  widgets?: GenericApiWidgetDef[];
  /** Set this stream's integration-tier polling method to `genericapi` (default true). */
  useByDefault?: boolean;
}

export const GENERIC_API_MONITOR_LIMITS = {
  maxQueries: 10,
  maxWidgetsPerQuery: 20,
  /** Per-asset requests in flight per integration. */
  defaultAssetConcurrency: 4,
} as const;

// ─── Network queries (rule 100(j)) ─────────────────────────────────────────────
//
// A network query reads address space out of the feed into IPAM: subnets,
// DHCP leases, DHCP reservations, or addresses allocated in another IPAM
// ("assignments"). Each is one request (paged like the inventory when
// `paginate`) whose records each map to one subnet or one address. Written by
// services/discovery/genericApiNetworkSync.ts, which owns what a feed may and
// may not do to IPAM.

export const GENERIC_API_NETWORK_KINDS = ["subnets", "leases", "reservations", "assignments"] as const;
export type GenericApiNetworkKind = (typeof GENERIC_API_NETWORK_KINDS)[number];

/** The keys each kind's `map` may name, and the groups of which one is required. */
export const GENERIC_API_NETWORK_FIELDS: Record<GenericApiNetworkKind, { keys: readonly string[]; required: readonly string[][] }> = {
  subnets:      { keys: ["cidr", "network", "prefixLength", "netmask", "name", "vlan", "purpose"], required: [["cidr", "network"]] },
  leases:       { keys: ["ipAddress", "macAddress", "hostname", "expiresAt"], required: [["ipAddress"]] },
  reservations: { keys: ["ipAddress", "macAddress", "hostname"], required: [["ipAddress"]] },
  assignments:  { keys: ["ipAddress", "hostname", "macAddress", "owner", "notes"], required: [["ipAddress"]] },
};

/** The Reservation.sourceType each address kind is written as. */
export const GENERIC_API_ADDRESS_SOURCE_TYPE = {
  leases: "dhcp_lease",
  reservations: "dhcp_reservation",
  assignments: "external",
} as const;

export interface GenericApiNetworkQuery {
  name?: string;
  kind: GenericApiNetworkKind;
  path: string;
  method?: "GET" | "POST";
  body?: string;
  recordsPath?: string;
  paginate?: boolean;
  map?: Record<string, string>;
}

export const GENERIC_API_NETWORK_LIMITS = {
  maxQueries: 10,
  /** A lease the feed gives no expiry for lives this long past the run that saw it, at least. */
  defaultLeaseHours: 24,
} as const;

export interface GenericApiConfig {
  host: string;
  port?: number;
  useHttps?: boolean;
  verifySsl?: boolean;
  /** Request path and query, e.g. "/api/v2/devices?status=active". */
  path?: string;
  method?: "GET" | "POST";
  /** POST only: the JSON body, as the operator typed it. */
  body?: string;
  headers?: GenericApiHeader[];
  authType?: GenericApiAuthType;
  /** bearer / header / query: the secret value (sealed at rest). */
  apiToken?: string;
  authHeaderName?: string;
  authQueryParam?: string;
  username?: string;
  password?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  pagination?: GenericApiPagination;
  /** Where the record list sits in a response ("data.devices", "$[*]"). */
  recordsPath?: string;
  fieldMap?: Partial<Record<GenericApiField, string>>;
  /** Per-record follow-up requests (see GenericApiDetailQuery). */
  detailQueries?: GenericApiDetailQuery[];
  /** Detail requests in flight at once. */
  detailConcurrency?: number;
  /** Requests that feed the monitor streams and custom widgets (rule 100(i)). */
  monitorQueries?: GenericApiMonitorQuery[];
  /** Integration-tier monitor settings — `syncGenericApiMonitorDefaults` keeps its polling keys in step with the queries. */
  monitorSettings?: Record<string, unknown>;
  /** Address space read into IPAM (rule 100(j)). */
  networkQueries?: GenericApiNetworkQuery[];
  /** Deprecate a subnet this feed owns once a complete read no longer lists it (off by default). */
  deprecateMissingSubnets?: boolean;
  /** Release a reservation / assignment this feed wrote once a complete read no longer lists it (on by default). */
  releaseMissingAddresses?: boolean;
  /** Off: a network-only feed — no device sync, no identity mapping (rule 100(j)). */
  readDevices?: boolean;
  identityField?: GenericApiIdentityField;
  /** The asset type for a record whose mapped type is blank or unknown. */
  assetTypeDefault?: string;
  /** The source's own type word (lower-cased) → a Polaris asset type. */
  assetTypeMap?: Record<string, string>;
  /** A constant manufacturer for a record that maps none ("Axis", "HP"). */
  manufacturerDefault?: string;
  deviceInclude?: string[];
  deviceExclude?: string[];
  decommissionMissing?: boolean;
  verifyPresence?: boolean;
  maxRecords?: number;
  requestTimeoutMs?: number;
  verboseLogging?: boolean;
}

export const GENERIC_API_LIMITS = {
  /** One page's body. A bigger answer is refused, never truncated into JSON.parse. */
  maxPageBytes: 25 * 1024 * 1024,
  defaultMaxPages: 100,
  maxMaxPages: 1000,
  defaultMaxRecords: 10_000,
  maxMaxRecords: 50_000,
  defaultTimeoutMs: 30_000,
  defaultPageSize: 100,
  maxDetailQueries: 5,
  defaultDetailConcurrency: 4,
  maxDetailConcurrency: 16,
  /** Detail requests in one run, across every record and query. */
  maxDetailRequests: 20_000,
} as const;

// ─── Normalized output ───────────────────────────────────────────────────────

/** One record after mapping — what the sync writes. */
export interface GenericApiMappedRecord {
  /** The identity value, normalized for its field (see identityKeyFor). */
  identity: string;
  hostname: string | null;
  ipAddress: string | null;
  /** Every usable MAC the record carries, colon-upper, all-zero dropped (rule 97). */
  macs: string[];
  /** Usable serial or null (rule 84 — a placeholder never becomes one). */
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  osVersion: string | null;
  /** The source's own type word, before mapping. */
  rawAssetType: string | null;
  /** The mapped Polaris type, or null to let the sync apply the default. */
  assetType: string | null;
  location: string | null;
  assetTag: string | null;
  department: string | null;
  assignedTo: string | null;
  description: string | null;
  /** Every tag the path reaches, de-duplicated. */
  tags: string[];
  /** ISO timestamps, parsed from an ISO string or epoch seconds / milliseconds. */
  acquiredAt: string | null;
  warrantyExpiry: string | null;
  purchaseOrder: string | null;
  /** Kept only as a valid pair (isValidGeoCoord), else both null. */
  latitude: number | null;
  longitude: number | null;
}

/** One detail response and the paths read against it. */
export interface GenericApiDetailLayer {
  doc: unknown;
  fieldMap: Partial<Record<GenericApiField, string>>;
}

export type GenericApiMapOutcome =
  | { ok: true; record: GenericApiMappedRecord }
  | { ok: false; reason: string };

export interface GenericApiFetchResult {
  records: Record<string, unknown>[];
  pages: number;
  /**
   * False when the read stopped early — a page failed after the first, a cap
   * was hit, a pagination link left the origin. The sync refuses to sweep on
   * an incomplete read.
   */
  complete: boolean;
  /** Why it is incomplete, or notes worth showing on a complete read. */
  warnings: string[];
  /** Items under recordsPath that were not objects. */
  skippedNonObjects: number;
}

/** The discovery engine's progress callback (DiscoveryProgressCallback's shape). */
type ProgressFn = (step: string, level: "info" | "error", message: string) => void;

// ─── Validation (shared by the route schema and the service) ──────────────────

/** Paths the config carries, each checked to parse. Returns the first problem, or null. */
export function findInvalidPath(config: Pick<GenericApiConfig, "recordsPath" | "fieldMap" | "pagination" | "detailQueries">): string | null {
  const check = (label: string, p: string | undefined): string | null => {
    if (!p || !p.trim()) return null;
    try { parseJsonPath(p); return null; } catch (err) {
      return `${label}: ${err instanceof JsonPathError ? err.message : String(err)}`;
    }
  };
  const problems = [
    check("Records path", config.recordsPath),
    check("Cursor path", config.pagination?.cursorPath),
    ...GENERIC_API_FIELDS.map((f) => check(`${f} path`, config.fieldMap?.[f])),
  ];
  (config.detailQueries ?? []).forEach((q, i) => {
    const label = `Detail query ${i + 1}${q.name?.trim() ? ` ("${q.name.trim()}")` : ""}`;
    if (!isSafeRequestPath(q.path) || !(q.path ?? "").trim()) {
      problems.push(`${label}: the path must start with a single "/"`);
    }
    for (const [where, tpl] of [["path", q.path], ["body", q.body]] as const) {
      const placeholders = detailPlaceholders(tpl);
      if (placeholders === null) problems.push(`${label}: a "{{" in the ${where} has no matching "}}"`);
      for (const p of placeholders ?? []) problems.push(check(`${label} placeholder {{${p}}}`, p));
    }
    if (q.fieldMap && "id" in q.fieldMap && q.fieldMap.id) {
      problems.push(`${label}: the record id comes from the main query only`);
    }
    for (const f of GENERIC_API_DETAIL_FIELDS) problems.push(check(`${label} ${f} path`, q.fieldMap?.[f]));
  });
  return problems.find((p) => p !== null) ?? null;
}

/**
 * The first problem with the monitor queries, or null. The route schema
 * checks shapes; this checks what only the service knows: which map keys a
 * stream takes, that every path parses, that a fleet query names its match
 * path and has no placeholders, and that widget names are unique per
 * integration (a widget's samples are keyed by its name).
 */
/**
 * The first problem with the network queries, or null: a safe path with no
 * placeholders (a network query answers for the whole feed), map keys the
 * kind takes, the required ones present, every path parsing.
 */
export function findInvalidNetworkQuery(config: Pick<GenericApiConfig, "networkQueries">): string | null {
  const checkPath = (label: string, p: string | undefined): string | null => {
    if (!p || !p.trim()) return null;
    try { parseJsonPath(p); return null; } catch (err) {
      return `${label}: ${err instanceof JsonPathError ? err.message : String(err)}`;
    }
  };
  const queries = config.networkQueries ?? [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const label = `Network query ${i + 1}${q.name?.trim() ? ` ("${q.name.trim()}")` : ""}`;
    if (!(GENERIC_API_NETWORK_KINDS as readonly string[]).includes(q.kind)) return `${label}: unknown kind "${q.kind}"`;
    if (!(q.path ?? "").trim() || !isSafeRequestPath(q.path)) return `${label}: the path must start with a single "/"`;
    for (const [where, tpl] of [["path", q.path], ["body", q.body]] as const) {
      const ph = detailPlaceholders(tpl);
      if (ph === null || ph.length > 0) return `${label}: a network query reads the whole feed at once, so its ${where} cannot hold {{…}} placeholders`;
    }
    const recBad = checkPath(`${label} records path`, q.recordsPath);
    if (recBad) return recBad;
    const spec = GENERIC_API_NETWORK_FIELDS[q.kind];
    const map = q.map ?? {};
    for (const [k, p] of Object.entries(map)) {
      if (!p || !String(p).trim()) continue;
      if (!spec.keys.includes(k)) return `${label}: "${k}" is not a ${q.kind} field (${spec.keys.join(", ")})`;
      const bad = checkPath(`${label} ${k} path`, p);
      if (bad) return bad;
    }
    for (const oneOf of spec.required) {
      if (!oneOf.some((k) => (map[k] ?? "").trim())) {
        return `${label}: map ${oneOf.length === 1 ? `"${oneOf[0]}"` : `one of ${oneOf.map((k) => `"${k}"`).join(" / ")}`} for ${q.kind}`;
      }
    }
    if (q.kind === "subnets" && !(map.cidr ?? "").trim() && !(map.prefixLength ?? "").trim() && !(map.netmask ?? "").trim()) {
      return `${label}: a network address needs "prefixLength" or "netmask" beside it (or map "cidr")`;
    }
  }
  return null;
}

export function findInvalidMonitorQuery(config: Pick<GenericApiConfig, "monitorQueries">): string | null {
  const checkPath = (label: string, p: string | undefined): string | null => {
    if (!p || !p.trim()) return null;
    try { parseJsonPath(p); return null; } catch (err) {
      return `${label}: ${err instanceof JsonPathError ? err.message : String(err)}`;
    }
  };
  const widgetNames = new Set<string>();
  const queries = config.monitorQueries ?? [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const label = `Monitor query ${i + 1}${q.name?.trim() ? ` ("${q.name.trim()}")` : ""}`;
    if (!(GENERIC_API_MONITOR_STREAMS as readonly string[]).includes(q.stream)) return `${label}: unknown stream "${q.stream}"`;
    if (!(q.path ?? "").trim() || !isSafeRequestPath(q.path)) return `${label}: the path must start with a single "/"`;
    for (const [where, tpl] of [["path", q.path], ["body", q.body]] as const) {
      const ph = detailPlaceholders(tpl);
      if (ph === null) return `${label}: a "{{" in the ${where} has no matching "}}"`;
      if (q.scope === "fleet" && ph.length > 0) {
        return `${label}: a fleet query answers for every asset at once, so its ${where} cannot hold {{…}} placeholders — use the per-asset scope`;
      }
      for (const p of ph) { const bad = checkPath(`${label} placeholder {{${p}}}`, p); if (bad) return bad; }
    }
    if (q.scope === "fleet") {
      if (!q.matchPath?.trim()) return `${label}: a fleet query needs the path that holds each record's identity`;
      const bad = checkPath(`${label} match path`, q.matchPath) ?? checkPath(`${label} records path`, q.recordsPath);
      if (bad) return bad;
    }
    const itemsBad = checkPath(`${label} items path`, q.itemsPath);
    if (itemsBad) return itemsBad;
    const spec = GENERIC_API_MONITOR_FIELDS[q.stream];
    const map = q.map ?? {};
    for (const [k, p] of Object.entries(map)) {
      if (!p || !String(p).trim()) continue;
      if (!spec.keys.includes(k)) return `${label}: "${k}" is not a ${q.stream} field (${spec.keys.join(", ")})`;
      const bad = checkPath(`${label} ${k} path`, p);
      if (bad) return bad;
    }
    for (const oneOf of spec.required) {
      if (!oneOf.some((k) => (map[k] ?? "").trim())) {
        return `${label}: map ${oneOf.length === 1 ? `"${oneOf[0]}"` : `one of ${oneOf.map((k) => `"${k}"`).join(" / ")}`} for the ${q.stream} stream`;
      }
    }
    if (q.stream === "widgets") {
      const widgets = q.widgets ?? [];
      if (widgets.length === 0) return `${label}: a widgets query needs at least one widget`;
      if (widgets.length > GENERIC_API_MONITOR_LIMITS.maxWidgetsPerQuery) return `${label}: at most ${GENERIC_API_MONITOR_LIMITS.maxWidgetsPerQuery} widgets per query`;
      for (const w of widgets) {
        const name = (w.name ?? "").trim();
        if (!name) return `${label}: every widget needs a name`;
        const key = genericApiWidgetSlug(name);
        if (widgetNames.has(key)) return `${label}: two widgets are named "${name}" — names must be unique on an integration`;
        widgetNames.add(key);
        if (!(w.path ?? "").trim()) return `${label}: widget "${name}" needs a path`;
        const bad = checkPath(`${label} widget "${name}" path`, w.path);
        if (bad) return bad;
        if (w.type === "state") {
          const stateBad = validateStateMap(w.stateMap ?? {});
          if (stateBad) return `${label}: widget "${name}": ${stateBad}`;
        }
      }
    }
  }
  return null;
}

/** A widget's stable key on its integration — samples are keyed by it, so renaming a widget starts a new series. */
export function genericApiWidgetSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "widget";
}

/** `AssetCustomWidgetSample.widgetId` / `AssetStateSample.probeId` for a Generic API widget. */
export function genericApiWidgetId(integrationId: string, name: string): string {
  return `ga:${integrationId}:${genericApiWidgetSlug(name)}`;
}

/**
 * The integration-tier settings after a save: each stream a query feeds with
 * `useByDefault` (the default) gets `genericapi` as its polling method, and a
 * stream left on `genericapi` with no query any more is cleared back to the
 * tier below. Every other key — an interval, another method the operator set
 * through the monitor-settings API — is kept. `seed` is what to start from
 * when nothing is stored yet (the manual tier, as every other integration's
 * Monitoring tab does), so a first default does not reset the cadences.
 * Returns undefined when there is nothing to store.
 */
export function syncGenericApiMonitorDefaults(
  stored: Record<string, unknown> | undefined,
  queries: GenericApiMonitorQuery[],
  seed: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const wanted = new Set<string>();
  for (const q of queries) {
    const key = GENERIC_API_STREAM_POLLING_KEY[q.stream];
    if (key && q.useByDefault !== false) wanted.add(key);
  }
  if (!stored && wanted.size === 0) return undefined;
  const out: Record<string, unknown> = { ...(stored ?? seed ?? {}) };
  for (const key of Object.values(GENERIC_API_STREAM_POLLING_KEY)) {
    if (!key) continue;
    if (wanted.has(key)) out[key] = "genericapi";
    else if (out[key] === "genericapi") delete out[key];
  }
  return out;
}

/**
 * The `{{json.path}}` placeholders in a detail path or body, in order; null
 * when a "{{" has no "}}" (it would otherwise be sent literally). Double
 * braces, so a JSON body's own braces are never mistaken for one.
 */
export function detailPlaceholders(template: string | undefined): string[] | null {
  const s = template ?? "";
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const open = s.indexOf("{{", i);
    if (open === -1) return out;
    const end = s.indexOf("}}", open + 2);
    if (end === -1) return null;
    const inner = s.slice(open + 2, end).trim();
    if (!inner || inner.includes("{{")) return null;
    out.push(inner);
    i = end + 2;
  }
}

const PLACEHOLDER_RE = /\{\{([^{}]+?)\}\}/g;

/** The request path must be origin-relative: it may never name another host. */
export function isSafeRequestPath(p: string | undefined): boolean {
  const s = (p ?? "").trim();
  if (s === "") return true;
  return s.startsWith("/") && !s.startsWith("//") && !/[\r\n]/.test(s);
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

/** The identity key a value is compared under, per identity field. */
export function identityKeyFor(field: GenericApiIdentityField, value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  switch (field) {
    case "macAddress": {
      const mac = normalizeMacsDistinct([v])[0];
      return mac ?? null;
    }
    case "serialNumber":
      return usableSerialOrNull(v);
    case "hostname":
      return v.toLowerCase().replace(/\.$/, "");
    case "id":
      return v;
  }
}

/** Include wins over exclude; empty lists keep everything (workloadSync's rule). */
export function passesDeviceFilter(name: string | null, include: string[], exclude: string[]): boolean {
  const candidate = (name ?? "").trim();
  if (include.length > 0) return candidate !== "" && include.some((p) => matchesWildcard(p, candidate));
  if (exclude.length > 0) return candidate === "" || !exclude.some((p) => matchesWildcard(p, candidate));
  return true;
}

/**
 * Map one record. Returns why a record was dropped instead of silently
 * skipping it, so the Preview can say "row 4: no value at id".
 */
export function mapGenericRecord(
  raw: Record<string, unknown>,
  config: GenericApiConfig,
  details: GenericApiDetailLayer[] = [],
): GenericApiMapOutcome {
  const fm = config.fieldMap ?? {};
  // Most specific first: the last detail query, then earlier ones, then the
  // main record. The identity is read from the main record only.
  const layers: GenericApiDetailLayer[] = [...details].reverse().concat({ doc: raw, fieldMap: fm });
  const read = (f: GenericApiField): string | null => {
    for (const l of layers) {
      const v = readJsonPathString(l.doc, l.fieldMap[f]);
      if (v !== null) return v;
    }
    return null;
  };
  const readAll = (f: GenericApiField): string[] => {
    const out: string[] = [];
    for (const l of layers) for (const v of readJsonPathStrings(l.doc, l.fieldMap[f])) if (!out.includes(v)) out.push(v);
    return out;
  };

  const ipCandidates = readAll("ipAddress");
  // Only an ADDRESS is an address: "10.0.0.5/24" is trimmed to its host, a
  // name or a URL is ignored rather than written into Asset.ipAddress.
  const ipAddress = ipCandidates
    .map((s) => s.split("/")[0].trim())
    .find((s) => isValidIpAddress(s)) ?? null;
  const macs = normalizeMacsDistinct(readAll("macAddress"));
  const serialNumber = usableSerialOrNull(read("serialNumber"));
  const hostname = read("hostname");

  const rawAssetType = read("assetType");
  let assetType: string | null = null;
  if (rawAssetType) {
    const key = rawAssetType.toLowerCase();
    const mapped = Object.entries(config.assetTypeMap ?? {}).find(([k]) => k.trim().toLowerCase() === key)?.[1];
    assetType = (mapped ?? key).trim() || null;
  }

  const identityField = config.identityField ?? "id";
  const mainOnly = (f: GenericApiField): string | null => readJsonPathString(raw, fm[f]);
  const identitySource =
    identityField === "id" ? mainOnly("id")
    : identityField === "serialNumber" ? usableSerialOrNull(mainOnly("serialNumber"))
    : identityField === "macAddress" ? (normalizeMacsDistinct(readJsonPathStrings(raw, fm.macAddress))[0] ?? null)
    : mainOnly("hostname");
  const identity = identityKeyFor(identityField, identitySource);
  if (!identity) {
    const path = fm[identityField];
    return {
      ok: false,
      reason: path
        ? `no usable ${identityField} at "${path}"`
        : `the identity field (${identityField}) is not mapped`,
    };
  }

  return {
    ok: true,
    record: {
      identity,
      hostname,
      ipAddress,
      macs,
      serialNumber,
      manufacturer: read("manufacturer") ?? (config.manufacturerDefault?.trim() || null),
      model: read("model"),
      os: read("os"),
      osVersion: read("osVersion"),
      rawAssetType,
      assetType,
      location: read("location"),
      assetTag: read("assetTag"),
      department: read("department"),
      assignedTo: read("assignedTo"),
      description: read("description"),
      tags: readAll("tags").map((t) => t.slice(0, 64)).slice(0, 50),
      acquiredAt: parseLooseDate(read("acquiredAt")),
      warrantyExpiry: parseLooseDate(read("warrantyExpiry")),
      purchaseOrder: read("purchaseOrder"),
      ...readCoordPair(read("latitude"), read("longitude")),
    },
  };
}

/**
 * A date a feed sent, as an ISO timestamp: an ISO / RFC 2822 string, or a
 * number of epoch seconds or milliseconds (told apart by size). Null for
 * anything that does not land between 1970 and 2200 — a feed's "0" or
 * "9999-12-31" placeholder is not a date anyone meant.
 */
export function parseLooseDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  let ms: number;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    ms = Math.abs(n) >= 1e11 ? n : n * 1000;
  } else {
    ms = Date.parse(s);
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 1971 || year > 2200) return null;
  return d.toISOString();
}

function readCoordPair(lat: string | null, lng: string | null): { latitude: number | null; longitude: number | null } {
  const la = lat === null ? NaN : Number(lat);
  const lo = lng === null ? NaN : Number(lng);
  return isValidGeoCoord(la, lo) ? { latitude: la, longitude: lo } : { latitude: null, longitude: null };
}

// ─── Transport ───────────────────────────────────────────────────────────────

function scheme(config: GenericApiConfig): "https" | "http" {
  return config.useHttps === false ? "http" : "https";
}

/** The endpoint's origin, e.g. "https://inv.example.com:8443". */
export function endpointOrigin(config: GenericApiConfig): string {
  const host = (config.host ?? "").trim();
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = config.port ?? (scheme(config) === "https" ? 443 : 80);
  return `${scheme(config)}://${bracketed}:${port}`;
}

/** The first page's URL: origin + path, with the query-string credential when that is the auth type. */
export function buildRequestUrl(config: GenericApiConfig, pathOverride?: string): URL {
  if (!config.host?.trim()) throw new AppError(400, "Host is required");
  assertOutboundHostAllowed(config.host);
  const path = ((pathOverride ?? config.path) ?? "").trim() || "/";
  if (!isSafeRequestPath(path)) throw new AppError(400, `Request path "${path}" must start with a single "/"`);
  const url = new URL(path, endpointOrigin(config) + "/");
  if (url.origin !== new URL(endpointOrigin(config)).origin) {
    throw new AppError(400, "Request path must stay on the configured host");
  }
  if (config.authType === "query" && config.apiToken) {
    url.searchParams.set(config.authQueryParam?.trim() || "api_key", config.apiToken);
  }
  return url;
}

export interface RawJsonResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: unknown;
  /** The body as text, capped — kept for an error message. */
  text: string;
}

export interface RequestJsonOptions {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  verifySsl: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

type RequestJsonFn = (url: URL, opts: RequestJsonOptions) => Promise<RawJsonResponse>;

/**
 * The transport. Swappable ONLY for tests (_setRequestImplForTests): the SSRF
 * guard refuses loopback, so a test cannot stand up a local server and has to
 * hand the paginator its pages directly. The URL guards run before this is
 * called, so a test still exercises them.
 */
let requestImpl: RequestJsonFn = requestJson;

/** Test seam: replace the transport (null restores the real one). */
export function _setRequestImplForTests(fn: RequestJsonFn | null): void {
  requestImpl = fn ?? requestJson;
}

/** Every outbound request goes through here: the host guard, THEN the transport. */
async function send(url: URL, opts: RequestJsonOptions): Promise<RawJsonResponse> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError(400, `Unsupported URL scheme "${url.protocol}"`);
  assertOutboundHostAllowed(url.hostname);
  return requestImpl(url, opts);
}

async function requestJson(url: URL, opts: RequestJsonOptions): Promise<RawJsonResponse> {
  const mod = url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));

  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: opts.method,
        headers,
        signal: opts.signal,
        ...(url.protocol === "https:" ? { rejectUnauthorized: opts.verifySsl } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > GENERIC_API_LIMITS.maxPageBytes) {
            req.destroy(new AppError(502, `Response from ${url.origin} is larger than ${Math.round(GENERIC_API_LIMITS.maxPageBytes / 1024 / 1024)} MB — use a smaller page size`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = undefined;
          try { json = text.trim() === "" ? null : JSON.parse(text); } catch { /* not JSON — the caller reports it */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text: text.slice(0, 2000) });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new AppError(504, `${url.origin} did not respond within ${Math.round(opts.timeoutMs / 1000)}s`)));
    req.on("error", (err: any) => {
      if (err?.name === "AbortError" || err instanceof AppError) reject(err);
      else reject(new AppError(502, `Could not reach ${url.origin}: ${err?.message || err}`));
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function describeHttpFailure(status: number, text: string, what: string): AppError {
  if (status >= 300 && status < 400) {
    return new AppError(502, `${what} answered with a redirect (HTTP ${status}); redirects are not followed — point the integration at the final URL`);
  }
  if (status === 401 || status === 403) return new AppError(502, `${what} refused the credentials (HTTP ${status})`);
  const detail = text.trim().replace(/\s+/g, " ").slice(0, 300);
  return new AppError(502, `${what} answered HTTP ${status}${detail ? `: ${detail}` : ""}`);
}

/** OAuth 2.0 client-credentials grant. The token lives for one run; nothing caches it. */
export async function fetchOauthToken(config: GenericApiConfig, signal?: AbortSignal): Promise<string> {
  if (!config.tokenUrl?.trim()) throw new AppError(400, "OAuth token URL is required");
  let url: URL;
  try { url = new URL(config.tokenUrl.trim()); } catch { throw new AppError(400, `OAuth token URL "${config.tokenUrl}" is not a URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError(400, "OAuth token URL must be http(s)");
  assertOutboundHostAllowed(url.hostname);
  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (config.clientId) form.set("client_id", config.clientId);
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  if (config.scope?.trim()) form.set("scope", config.scope.trim());
  const res = await send(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    verifySsl: config.verifySsl !== false,
    timeoutMs: config.requestTimeoutMs ?? GENERIC_API_LIMITS.defaultTimeoutMs,
    signal,
  });
  if (res.status < 200 || res.status >= 300) throw describeHttpFailure(res.status, res.text, "The OAuth token endpoint");
  const token = (res.json as any)?.access_token;
  if (typeof token !== "string" || !token) throw new AppError(502, "The OAuth token endpoint returned no access_token");
  return token;
}

/** Request headers for the configured auth type (the OAuth token already fetched). */
export function buildAuthHeaders(config: GenericApiConfig, oauthToken?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of config.headers ?? []) {
    const name = (h?.name ?? "").trim();
    // A header name with a CR/LF or colon would be header injection; Node
    // refuses those too, but say so in the operator's terms.
    if (!name || /[\r\n:]/.test(name)) continue;
    out[name] = String(h.value ?? "").replace(/[\r\n]/g, "");
  }
  switch (config.authType ?? "none") {
    case "bearer":
      if (config.apiToken) out.Authorization = `Bearer ${config.apiToken}`;
      break;
    case "basic":
      out.Authorization = `Basic ${Buffer.from(`${config.username ?? ""}:${config.password ?? ""}`).toString("base64")}`;
      break;
    case "header":
      if (config.apiToken) out[config.authHeaderName?.trim() || "X-API-Key"] = config.apiToken;
      break;
    case "oauth2":
      if (oauthToken) out.Authorization = `Bearer ${oauthToken}`;
      break;
    default:
      break;
  }
  if (config.method === "POST") out["Content-Type"] = "application/json";
  return out;
}

/** The run's request headers: the OAuth token (when that is the auth type) fetched once, then buildAuthHeaders. */
export async function buildRequestHeaders(config: GenericApiConfig, signal?: AbortSignal): Promise<Record<string, string>> {
  const oauthToken = config.authType === "oauth2" ? await fetchOauthToken(config, signal) : null;
  return buildAuthHeaders(config, oauthToken);
}

/** A page/offset/cursor parameter applied to a copy of the base URL. */
function withParams(base: URL, params: Record<string, string | number | undefined>): URL {
  const u = new URL(base.toString());
  for (const [k, v] of Object.entries(params)) {
    if (!k || v === undefined) continue;
    u.searchParams.set(k, String(v));
  }
  return u;
}

/** RFC 8288 `Link: <url>; rel="next"`, or null. */
export function parseNextLink(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return null;
  for (const part of raw.split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]+)>\s*;(.*)/);
    if (m && /rel\s*=\s*"?next"?/i.test(m[2])) return m[1].trim();
  }
  return null;
}

/**
 * A next-page URL the source handed back (Link header, or a cursor that is a
 * URL). Resolved against the current page and accepted only on the endpoint's
 * own origin — a feed must not be able to point Polaris at another host.
 */
export function resolveSameOriginUrl(next: string, current: URL, config: GenericApiConfig): URL | null {
  let u: URL;
  try { u = new URL(next, current); } catch { return null; }
  if (u.origin !== new URL(endpointOrigin(config)).origin) return null;
  return u;
}

/**
 * Read every page. The first page failing throws (the run fails, nothing is
 * written); a later page failing returns what was read, marked incomplete.
 */
export async function fetchGenericApiRecords(
  config: GenericApiConfig,
  opts: {
    signal?: AbortSignal;
    onProgress?: ProgressFn;
    maxPagesOverride?: number;
    maxRecordsOverride?: number;
    /** Headers already built for this run (buildRequestHeaders) — one OAuth token per run. */
    headers?: Record<string, string>;
  } = {},
): Promise<GenericApiFetchResult> {
  const pg: GenericApiPagination = config.pagination ?? { mode: "none" };
  const mode = pg.mode ?? "none";
  const maxPages = Math.min(
    opts.maxPagesOverride ?? pg.maxPages ?? GENERIC_API_LIMITS.defaultMaxPages,
    GENERIC_API_LIMITS.maxMaxPages,
  );
  const maxRecords = Math.min(
    opts.maxRecordsOverride ?? config.maxRecords ?? GENERIC_API_LIMITS.defaultMaxRecords,
    GENERIC_API_LIMITS.maxMaxRecords,
  );
  const timeoutMs = config.requestTimeoutMs ?? GENERIC_API_LIMITS.defaultTimeoutMs;
  const method = config.method === "POST" ? "POST" : "GET";
  let body: string | undefined;
  if (method === "POST") {
    const b = (config.body ?? "").trim();
    if (b) {
      try { JSON.parse(b); } catch { throw new AppError(400, "POST body is not valid JSON"); }
      body = b;
    } else {
      body = "{}";
    }
  }

  const base = buildRequestUrl(config);
  const headers = opts.headers ?? await buildRequestHeaders(config, opts.signal);
  const pageSize = pg.pageSize ?? GENERIC_API_LIMITS.defaultPageSize;
  const startPage = pg.startPage ?? 1;

  const records: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  let skippedNonObjects = 0;
  let complete = true;
  let pages = 0;
  /** Items consumed from the feed (objects AND skipped scalars) — the next offset. */
  let itemsRead = 0;
  let prevFingerprint: string | null = null;

  const sizeParams = (): Record<string, number | undefined> =>
    pg.sizeParam?.trim() ? { [pg.sizeParam.trim()]: pageSize } : {};
  let url: URL | null =
    mode === "page" ? withParams(base, { [pg.pageParam?.trim() || "page"]: startPage, ...sizeParams() })
    : mode === "offset" ? withParams(base, { [pg.pageParam?.trim() || "offset"]: 0, ...sizeParams() })
    : base;
  const seenUrls = new Set<string>();

  while (url) {
    if (opts.signal?.aborted) { complete = false; warnings.push("The run was cancelled"); break; }
    if (pages >= maxPages) {
      complete = false;
      warnings.push(`Stopped at the page limit (${maxPages}) — raise "Max pages" if the feed is longer`);
      break;
    }
    // A cursor or link that loops back on itself would page forever.
    if (seenUrls.has(url.toString())) { warnings.push("The feed handed back a page it had already sent; stopped"); break; }
    seenUrls.add(url.toString());

    let res: RawJsonResponse;
    try {
      res = await send(url, { method, headers, body, verifySsl: config.verifySsl !== false, timeoutMs, signal: opts.signal });
      if (res.status < 200 || res.status >= 300) throw describeHttpFailure(res.status, res.text, url.origin);
      if (res.json === undefined) throw new AppError(502, `${url.origin} did not answer with JSON`);
    } catch (err) {
      if (pages === 0) throw err;
      complete = false;
      warnings.push(`Page ${pages + 1} failed: ${(err as Error)?.message || err}`);
      break;
    }
    pages++;

    const { records: pageRecords, skipped } = selectRecords(res.json, config.recordsPath ?? "");
    skippedNonObjects += skipped;
    itemsRead += pageRecords.length + skipped;
    opts.onProgress?.("discover.page", "info", `Page ${pages}: ${pageRecords.length} record(s)`);
    // A source that ignores the page parameter answers page 1 forever; its
    // second page is then identical to its first. Stop rather than read the
    // same records maxPages times over.
    const fingerprint = pageRecords.length > 0 ? JSON.stringify(pageRecords[0]) : null;
    if (pages > 1 && fingerprint !== null && fingerprint === prevFingerprint) {
      // Whether page 1 was the whole feed cannot be told from here, so the
      // read counts as incomplete and the sweep stays off.
      complete = false;
      warnings.push("The source returned the same page twice — it may not support the configured pagination; stopped");
      break;
    }
    prevFingerprint = fingerprint;
    let took = 0;
    for (const r of pageRecords) {
      if (records.length >= maxRecords) break;
      records.push(r);
      took++;
    }
    if (records.length >= maxRecords) {
      // Records were left on this page, or more pages may follow: either way
      // the read is not the whole feed.
      if (took < pageRecords.length || mode !== "none") {
        complete = false;
        warnings.push(`Stopped at the record limit (${maxRecords}) — raise "Max records" if the feed is longer`);
      }
      break;
    }

    // Next page.
    url = null;
    if (mode === "page" || mode === "offset") {
      // An empty page is always the last one. A SHORT page is the last one
      // only when Polaris sent the page size — otherwise it does not know the
      // source's size and must ask again until a page comes back empty.
      const sentSize = !!pg.sizeParam?.trim();
      const items = pageRecords.length + skipped;
      if (items > 0 && (!sentSize || items >= pageSize)) {
        const param = pg.pageParam?.trim() || (mode === "page" ? "page" : "offset");
        const nextValue = mode === "page" ? startPage + pages : itemsRead;
        url = withParams(base, { [param]: nextValue, ...sizeParams() });
      }
    } else if (mode === "cursor") {
      const cursor = readJsonPathString(res.json, pg.cursorPath);
      if (cursor) {
        if (/^https?:\/\//i.test(cursor) || cursor.startsWith("/")) {
          url = resolveSameOriginUrl(cursor, base, config);
          if (!url) { complete = false; warnings.push("The next-page URL points at a different host; stopped"); }
        } else {
          url = withParams(base, { [pg.cursorParam?.trim() || "cursor"]: cursor });
        }
      }
    } else if (mode === "link") {
      const next = parseNextLink(res.headers.link);
      if (next) {
        url = resolveSameOriginUrl(next, base, config);
        if (!url) { complete = false; warnings.push("The Link header's next page points at a different host; stopped"); }
      }
    }
  }

  if (skippedNonObjects > 0) warnings.push(`${skippedNonObjects} item(s) under the records path were not objects and were skipped`);
  return { records, pages, complete, warnings, skippedNonObjects };
}

// ─── Detail queries ──────────────────────────────────────────────────────────

/**
 * A `{{json.path}}` template filled from the main record. In a PATH each value
 * is URL-encoded, so it can never add a segment, a query parameter or a host;
 * a value of "." or ".." is refused because the URL parser would resolve it
 * into a different path on the host. In a JSON BODY each value is
 * string-escaped. A placeholder with no value fails the query for that record.
 */
export function fillDetailTemplate(
  template: string,
  raw: Record<string, unknown>,
  target: "path" | "body",
): { ok: true; value: string } | { ok: false; reason: string } {
  if (detailPlaceholders(template) === null) return { ok: false, reason: "a \"{{\" has no matching \"}}\"" };
  const missing: string[] = [];
  const value = template.replace(PLACEHOLDER_RE, (_m, inner: string) => {
    const p = inner.trim();
    const v = readJsonPathString(raw, p);
    if (v === null || (target === "path" && (v === "." || v === ".."))) {
      missing.push(p);
      return "";
    }
    return target === "path" ? encodeURIComponent(v) : JSON.stringify(v).slice(1, -1);
  });
  if (missing.length > 0) return { ok: false, reason: `the record has no usable value at {{${missing[0]}}}` };
  return { ok: true, value };
}

export interface GenericApiDetailFetch {
  /** One layer per detail query that answered, in query order. */
  layers: GenericApiDetailLayer[];
  /** "query name: why", one per query that did not answer. */
  failures: string[];
  requests: number;
  /** Preview only: each query's request path and response. */
  responses?: Array<{ name: string; path: string | null; ok: boolean; response: unknown; error: string | null }>;
}

function detailQueryName(q: GenericApiDetailQuery, i: number): string {
  return q.name?.trim() || `Detail query ${i + 1}`;
}

/** Every detail query for one record, in order. Never throws for a failed query. */
export async function fetchDetailsForRecord(
  raw: Record<string, unknown>,
  config: GenericApiConfig,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal; keepResponses?: boolean } = {},
): Promise<GenericApiDetailFetch> {
  const out: GenericApiDetailFetch = { layers: [], failures: [], requests: 0, ...(opts.keepResponses ? { responses: [] } : {}) };
  const queries = (config.detailQueries ?? []).slice(0, GENERIC_API_LIMITS.maxDetailQueries);
  const timeoutMs = config.requestTimeoutMs ?? GENERIC_API_LIMITS.defaultTimeoutMs;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const name = detailQueryName(q, i);
    let path: string | null = null;
    try {
      if (opts.signal?.aborted) throw new AppError(499, "The run was cancelled");
      const filled = fillDetailTemplate(q.path ?? "", raw, "path");
      if (!filled.ok) throw new AppError(400, filled.reason);
      path = filled.value;
      const method = q.method === "POST" ? "POST" : "GET";
      let body: string | undefined;
      if (method === "POST") {
        const b = fillDetailTemplate((q.body ?? "").trim() || "{}", raw, "body");
        if (!b.ok) throw new AppError(400, b.reason);
        try { JSON.parse(b.value); } catch { throw new AppError(400, "the request body is not valid JSON once the record's values are filled in"); }
        body = b.value;
      }
      const reqHeaders = { ...headers };
      if (method === "POST") reqHeaders["Content-Type"] = "application/json";
      else delete reqHeaders["Content-Type"];
      const url = buildRequestUrl(config, path);
      out.requests++;
      const res = await send(url, { method, headers: reqHeaders, body, verifySsl: config.verifySsl !== false, timeoutMs, signal: opts.signal });
      if (res.status < 200 || res.status >= 300) throw describeHttpFailure(res.status, res.text, name);
      if (res.json === undefined) throw new AppError(502, `${name} did not answer with JSON`);
      out.layers.push({ doc: res.json, fieldMap: q.fieldMap ?? {} });
      out.responses?.push({ name, path, ok: true, response: res.json, error: null });
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      out.failures.push(`${name}: ${msg}`);
      out.responses?.push({ name, path, ok: false, response: null, error: msg });
    }
  }
  return out;
}

/**
 * One request on the endpoint's origin, returning its JSON or why not —
 * never throwing. `notFound` is a 404 / 410: the source answered that this
 * thing does not exist, which a monitor reads as a finding, where any other
 * failure means Polaris could not ask.
 */
export async function fetchJsonDocument(
  config: GenericApiConfig,
  req: { path: string; method?: "GET" | "POST"; body?: string },
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: true; doc: unknown } | { ok: false; notFound: boolean; error: string }> {
  try {
    const method = req.method === "POST" ? "POST" : "GET";
    let body: string | undefined;
    if (method === "POST") {
      body = (req.body ?? "").trim() || "{}";
      try { JSON.parse(body); } catch { return { ok: false, notFound: false, error: "the request body is not valid JSON" }; }
    }
    const reqHeaders = { ...headers };
    if (method === "POST") reqHeaders["Content-Type"] = "application/json";
    else delete reqHeaders["Content-Type"];
    const url = buildRequestUrl(config, req.path);
    const res = await send(url, {
      method, headers: reqHeaders, body,
      verifySsl: config.verifySsl !== false,
      timeoutMs: config.requestTimeoutMs ?? GENERIC_API_LIMITS.defaultTimeoutMs,
      signal,
    });
    if (res.status === 404 || res.status === 410) return { ok: false, notFound: true, error: `${url.origin} answered HTTP ${res.status} (not found)` };
    if (res.status < 200 || res.status >= 300) return { ok: false, notFound: false, error: describeHttpFailure(res.status, res.text, url.origin).message };
    if (res.json === undefined) return { ok: false, notFound: false, error: `${url.origin} did not answer with JSON` };
    return { ok: true, doc: res.json };
  } catch (err) {
    return { ok: false, notFound: false, error: (err as Error)?.message || String(err) };
  }
}

export interface GenericApiDetailRun {
  /** Aligned with the input records; an empty fetch for a record past the cap. */
  perRecord: GenericApiDetailFetch[];
  requests: number;
  /** Records at least one detail query failed for. */
  recordsWithFailures: number;
  failureSamples: string[];
  warnings: string[];
}

/**
 * Detail queries across a run's records, `detailConcurrency` in flight. The
 * request cap is split across the queries; records past it keep their
 * main-query fields and the run says so. A failed detail request costs that
 * record the fields it would have filled — never the record, and never the
 * read's completeness, which is the main query's alone.
 */
export async function fetchGenericApiDetails(
  records: Record<string, unknown>[],
  config: GenericApiConfig,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal; onProgress?: ProgressFn; keepResponses?: boolean } = {},
): Promise<GenericApiDetailRun> {
  const queryCount = Math.min((config.detailQueries ?? []).length, GENERIC_API_LIMITS.maxDetailQueries);
  const empty = (): GenericApiDetailFetch => ({ layers: [], failures: [], requests: 0 });
  if (queryCount === 0 || records.length === 0) {
    return { perRecord: records.map(empty), requests: 0, recordsWithFailures: 0, failureSamples: [], warnings: [] };
  }
  const limit = Math.max(1, Math.min(config.detailConcurrency ?? GENERIC_API_LIMITS.defaultDetailConcurrency, GENERIC_API_LIMITS.maxDetailConcurrency));
  const maxRecords = Math.floor(GENERIC_API_LIMITS.maxDetailRequests / queryCount);
  const eligible = records.slice(0, maxRecords);
  const warnings: string[] = [];
  if (records.length > eligible.length) {
    warnings.push(`Detail queries ran for the first ${eligible.length} record(s) only (at most ${GENERIC_API_LIMITS.maxDetailRequests} detail requests per run); the rest kept their main-query fields`);
  }
  opts.onProgress?.("discover.details", "info", `Detail queries: ${eligible.length} record(s) × ${queryCount} quer${queryCount === 1 ? "y" : "ies"}, ${limit} at a time`);
  let done = 0;
  const fetched = await mapWithConcurrency(eligible, limit, async (raw) => {
    if (opts.signal?.aborted) return empty();
    const r = await fetchDetailsForRecord(raw, config, headers, { signal: opts.signal, keepResponses: opts.keepResponses });
    done++;
    if (done % 250 === 0) opts.onProgress?.("discover.details", "info", `Detail queries: ${done} of ${eligible.length} record(s)`);
    return r;
  });
  if (opts.signal?.aborted) warnings.push("The run was cancelled during the detail queries; records not reached kept their main-query fields");
  const perRecord = records.map((_, i) => fetched[i] ?? empty());
  const failureSamples: string[] = [];
  let recordsWithFailures = 0;
  let requests = 0;
  perRecord.forEach((d, i) => {
    requests += d.requests;
    if (d.failures.length === 0) return;
    recordsWithFailures++;
    if (failureSamples.length < 5) failureSamples.push(`record ${i + 1}: ${d.failures[0]}`);
  });
  if (recordsWithFailures > 0) {
    warnings.push(`Detail queries failed for ${recordsWithFailures} record(s) — those records kept their main-query fields (${failureSamples.join("; ")})`);
  }
  return { perRecord, requests, recordsWithFailures, failureSamples, warnings };
}

// ─── Discovery, test, preview ────────────────────────────────────────────────


export interface GenericApiDiscoveryResult {
  /** Records that mapped and passed the device filter. */
  records: GenericApiMappedRecord[];
  /** Every identity the feed carried, BEFORE the device filter (rule 70(b)). */
  presentIdentities: string[];
  complete: boolean;
  pages: number;
  rawCount: number;
  /** Records dropped for a missing identity, with the first few reasons. */
  unmapped: number;
  unmappedReasons: string[];
  /** Identities seen twice — the second is dropped (one record, one asset). */
  duplicates: number;
  filtered: number;
  /** Detail requests made this run, and the records any of them failed for. */
  detailRequests: number;
  detailFailures: number;
  warnings: string[];
}

export async function discoverGenericApi(
  config: GenericApiConfig,
  signal?: AbortSignal,
  onProgress?: ProgressFn,
): Promise<GenericApiDiscoveryResult> {
  const headers = await buildRequestHeaders(config, signal);
  const fetched = await fetchGenericApiRecords(config, { signal, onProgress, headers });
  const include = (config.deviceInclude ?? []).filter((s) => s.trim());
  const exclude = (config.deviceExclude ?? []).filter((s) => s.trim());
  const present = new Set<string>();
  const unmappedReasons: string[] = [];
  let unmapped = 0;
  let duplicates = 0;
  let filtered = 0;

  // Pass 1 — the identity, from the main record alone. Presence, duplicates
  // and the sweep's identity set are settled here, before any detail request.
  const kept: Record<string, unknown>[] = [];
  fetched.records.forEach((raw, i) => {
    const outcome = mapGenericRecord(raw, config);
    if (!outcome.ok) {
      unmapped++;
      if (unmappedReasons.length < 5) unmappedReasons.push(`record ${i + 1}: ${outcome.reason}`);
      return;
    }
    if (present.has(outcome.record.identity)) { duplicates++; return; }
    present.add(outcome.record.identity);
    kept.push(raw);
  });

  // Pass 2 — detail queries for the records that survived, then the full map.
  const details = await fetchGenericApiDetails(kept, config, headers, { signal, onProgress });
  const records: GenericApiMappedRecord[] = [];
  kept.forEach((raw, i) => {
    const outcome = mapGenericRecord(raw, config, details.perRecord[i]?.layers ?? []);
    if (!outcome.ok) return; // cannot happen: the identity is read from the main record only
    if (!passesDeviceFilter(outcome.record.hostname, include, exclude)) { filtered++; return; }
    records.push(outcome.record);
  });
  return {
    records,
    presentIdentities: [...present],
    complete: fetched.complete,
    pages: fetched.pages,
    rawCount: fetched.records.length,
    unmapped,
    unmappedReasons,
    duplicates,
    filtered,
    detailRequests: details.requests,
    detailFailures: details.recordsWithFailures,
    warnings: [...fetched.warnings, ...details.warnings],
  };
}

export interface GenericApiTestResult {
  ok: boolean;
  message: string;
}

/**
 * One page, mapped, plus the detail queries for the first record that maps.
 * Succeeds only when the records path finds records, at least one maps, and
 * every detail query answers for that record.
 */
export async function testConnection(config: GenericApiConfig): Promise<GenericApiTestResult> {
  try {
    const bad = findInvalidPath(config) ?? findInvalidNetworkQuery(config);
    if (bad) return { ok: false, message: bad };
    const headers = await buildRequestHeaders(config);
    const device = config.readDevices === false ? null : await testDeviceRead(config, headers);
    if (device && !device.ok) return device;
    // Network queries (rule 100(j)): each must answer and map on its first page.
    const net = await previewGenericApiNetwork(config, headers, 1);
    const failed = net.find((n) => !n.ok);
    if (failed) return { ok: false, message: `${device ? `${device.message}; but n` : "N"}etwork query "${failed.name}" — ${failed.message}` };
    const netNote = net.length ? `${net.length} network quer${net.length === 1 ? "y" : "ies"} answered` : "";
    if (!device) return { ok: true, message: `Connected — ${netNote || "no network queries"}` };
    return { ok: true, message: `${device.message}${netNote ? `; ${netNote}` : ""}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Connection failed" };
  }
}

/** The device half of Test Connection: one page, mapped, and the detail queries for the first record. */
async function testDeviceRead(config: GenericApiConfig, headers: Record<string, string>): Promise<GenericApiTestResult> {
  {
    const fetched = await fetchGenericApiRecords(config, { maxPagesOverride: 1, headers });
    if (fetched.records.length === 0) {
      return {
        ok: false,
        message: `Connected, but the records path ${config.recordsPath ? `"${config.recordsPath}"` : "(the response root)"} found no records on the first page`,
      };
    }
    const mappable = fetched.records.filter((r) => mapGenericRecord(r, config).ok);
    if (mappable.length === 0) {
      const first = mapGenericRecord(fetched.records[0], config);
      return { ok: false, message: `Connected and read ${fetched.records.length} record(s), but none mapped: ${first.ok ? "" : first.reason}` };
    }
    let detailNote = "";
    const queryCount = (config.detailQueries ?? []).length;
    if (queryCount > 0) {
      const d = await fetchDetailsForRecord(mappable[0], config, headers);
      if (d.failures.length > 0) {
        return { ok: false, message: `Connected and mapped the first page, but a detail query failed for the first record — ${d.failures[0]}` };
      }
      detailNote = `; ${queryCount} detail quer${queryCount === 1 ? "y" : "ies"} answered for the first record`;
    }
    return { ok: true, message: `Connected — first page: ${fetched.records.length} record(s), ${mappable.length} mapped${detailNote}` };
  }
}

export interface GenericApiNetworkPreview {
  name: string;
  kind: GenericApiNetworkKind;
  ok: boolean;
  message: string;
  sampleRecord: Record<string, unknown> | null;
  rows: Array<{ index: number; outcome: { ok: true; value: GenericApiMappedSubnet | GenericApiMappedAddress } | { ok: false; reason: string } }>;
}

/** Each network query's first page, mapped — the Preview tab's network half and Test Connection's. */
export async function previewGenericApiNetwork(
  config: GenericApiConfig,
  headers: Record<string, string>,
  limit = 10,
): Promise<GenericApiNetworkPreview[]> {
  const out: GenericApiNetworkPreview[] = [];
  for (const q of (config.networkQueries ?? []).slice(0, GENERIC_API_NETWORK_LIMITS.maxQueries)) {
    const name = q.name?.trim() || q.kind;
    try {
      const fetched = await fetchGenericApiRecords({
        ...config, path: q.path, method: q.method ?? "GET", body: q.body ?? "", recordsPath: q.recordsPath ?? "",
        pagination: q.paginate ? config.pagination : { mode: "none" },
      }, { maxPagesOverride: 1, headers });
      const rows = fetched.records.slice(0, Math.max(1, Math.min(limit, 50))).map((rec, index) => ({
        index,
        outcome: q.kind === "subnets" ? mapNetworkSubnet(rec, q) : mapNetworkAddress(rec, q),
      }));
      const mapped = fetched.records.filter((rec) => (q.kind === "subnets" ? mapNetworkSubnet(rec, q) : mapNetworkAddress(rec, q)).ok).length;
      const ok = fetched.records.length > 0 && mapped > 0;
      out.push({
        name, kind: q.kind, ok, rows, sampleRecord: fetched.records[0] ?? null,
        message: fetched.records.length === 0
          ? `the records path ${q.recordsPath ? `"${q.recordsPath}"` : "(the response root)"} found no records on the first page`
          : mapped === 0
            ? `read ${fetched.records.length} record(s), but none mapped: ${(rows[0]?.outcome as { reason?: string })?.reason ?? ""}`
            : `first page: ${fetched.records.length} record(s), ${mapped} mapped`,
      });
    } catch (err: any) {
      out.push({ name, kind: q.kind, ok: false, message: err?.message || "Request failed", sampleRecord: null, rows: [] });
    }
  }
  return out;
}

export interface GenericApiPreview {
  ok: boolean;
  message: string;
  /** The first raw record, so the operator can write paths against it. */
  sampleRecord: Record<string, unknown> | null;
  /** Each detail query's request and response for the first mapped record — paths are written against these. */
  sampleDetails: NonNullable<GenericApiDetailFetch["responses"]>;
  /** Up to `limit` records as they would be written (or why not). */
  rows: Array<{ index: number; outcome: GenericApiMapOutcome; filteredOut: boolean; detailFailures: string[] }>;
  recordsOnFirstPage: number;
  warnings: string[];
  /** Each network query's first page, mapped (rule 100(j)). */
  network: GenericApiNetworkPreview[];
}

/** First page only — the Preview tab's answer to "what would discovery write?". */
export async function previewGenericApi(config: GenericApiConfig, limit = 10): Promise<GenericApiPreview> {
  const empty = { sampleRecord: null, sampleDetails: [], rows: [], recordsOnFirstPage: 0, warnings: [], network: [] };
  const bad = findInvalidPath(config) ?? findInvalidNetworkQuery(config);
  if (bad) return { ok: false, message: bad, ...empty };
  try {
    const headers = await buildRequestHeaders(config);
    if (config.readDevices === false) {
      const network = await previewGenericApiNetwork(config, headers, limit);
      return {
        ...empty,
        ok: network.length > 0 && network.every((n) => n.ok),
        message: "Devices are not read from this API — network queries only",
        network,
      };
    }
    const fetched = await fetchGenericApiRecords(config, { maxPagesOverride: 1, headers });
    const include = (config.deviceInclude ?? []).filter((s) => s.trim());
    const exclude = (config.deviceExclude ?? []).filter((s) => s.trim());
    const shown = fetched.records.slice(0, Math.max(1, Math.min(limit, 50)));
    // Detail queries only for rows whose identity maps — discovery would not
    // make them for the others either.
    const mappable = shown.map((raw) => mapGenericRecord(raw, config).ok);
    const details = await fetchGenericApiDetails(shown.filter((_, i) => mappable[i]), config, headers, { keepResponses: true });
    let cursor = 0;
    const rows = shown.map((raw, index) => {
      const d = mappable[index] ? details.perRecord[cursor++] : undefined;
      const outcome = mapGenericRecord(raw, config, d?.layers ?? []);
      const filteredOut = outcome.ok && !passesDeviceFilter(outcome.record.hostname, include, exclude);
      return { index, outcome, filteredOut, detailFailures: d?.failures ?? [] };
    });
    const mapped = rows.filter((r) => r.outcome.ok).length;
    return {
      ok: fetched.records.length > 0 && mapped > 0,
      message: fetched.records.length === 0
        ? "Connected, but the records path found no records on the first page"
        : `First page: ${fetched.records.length} record(s); showing ${rows.length}, ${mapped} mapped` +
          (details.requests > 0 ? `; ${details.requests} detail request(s)` : ""),
      sampleRecord: fetched.records[0] ?? null,
      sampleDetails: details.perRecord[0]?.responses ?? [],
      rows,
      recordsOnFirstPage: fetched.records.length,
      warnings: [...fetched.warnings, ...details.warnings],
      network: await previewGenericApiNetwork(config, headers, limit),
    };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Request failed", ...empty };
  }
}

// ─── Network discovery (rule 100(j)) ─────────────────────────────────────────

export interface GenericApiMappedSubnet {
  /** Normalized IPv4 CIDR (host bits zeroed, rule 5). */
  cidr: string;
  name: string | null;
  vlan: number | null;
  purpose: string | null;
}

export interface GenericApiMappedAddress {
  ipAddress: string;
  /** Colon-upper; the all-zero MAC is no MAC (rule 97). */
  macAddress: string | null;
  hostname: string | null;
  /** leases: ISO expiry when the feed gives one. */
  expiresAt: string | null;
  owner: string | null;
  notes: string | null;
}

/**
 * One record → one IPv4 subnet, or why not. A CIDR may be mapped whole
 * ("10.1.0.0/24") or as a network beside a prefix length or a dotted netmask.
 * IPv6 is refused by name: IPAM's address math (utils/cidr.ts, netmask) is
 * IPv4, and a v6 network written half-supported would mis-place every
 * address in it.
 */
export function mapNetworkSubnet(
  rec: Record<string, unknown>,
  q: GenericApiNetworkQuery,
): { ok: true; value: GenericApiMappedSubnet } | { ok: false; reason: string } {
  const m = q.map ?? {};
  let raw = readJsonPathString(rec, m.cidr);
  if (!raw) {
    const net = readJsonPathString(rec, m.network);
    const len = readJsonPathString(rec, m.prefixLength) ?? readJsonPathString(rec, m.netmask);
    if (!net || !len) return { ok: false, reason: `no network at "${m.cidr || m.network}"` };
    raw = `${net.trim()}/${len.trim().replace(/^\//, "")}`;
  }
  const s = raw.trim();
  if (s.includes(":")) return { ok: false, reason: `${s} is IPv6 — only IPv4 networks are read` };
  let cidr: string;
  try {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/(\d{1,2}|\d{1,3}(\.\d{1,3}){3})$/.test(s)) throw new Error("not a CIDR");
    cidr = normalizeCidr(s);
  } catch {
    return { ok: false, reason: `"${s}" is not an IPv4 network` };
  }
  const vlanRaw = readJsonPathString(rec, m.vlan);
  const vlanNum = vlanRaw !== null ? Number.parseInt(vlanRaw, 10) : NaN;
  return {
    ok: true,
    value: {
      cidr,
      name: readJsonPathString(rec, m.name)?.slice(0, 200) ?? null,
      vlan: Number.isInteger(vlanNum) && vlanNum >= 1 && vlanNum <= 4094 ? vlanNum : null,
      purpose: readJsonPathString(rec, m.purpose)?.slice(0, 500) ?? null,
    },
  };
}

/** One record → one IPv4 address with what the kind carries, or why not. */
export function mapNetworkAddress(
  rec: Record<string, unknown>,
  q: GenericApiNetworkQuery,
): { ok: true; value: GenericApiMappedAddress } | { ok: false; reason: string } {
  const m = q.map ?? {};
  const rawIp = readJsonPathString(rec, m.ipAddress);
  if (!rawIp) return { ok: false, reason: `no address at "${m.ipAddress}"` };
  const ip = rawIp.split("/")[0].trim();
  if (ip.includes(":")) return { ok: false, reason: `${ip} is IPv6 — only IPv4 addresses are read` };
  if (!isValidIpAddress(ip)) return { ok: false, reason: `"${rawIp}" is not an IPv4 address` };
  const mac = normalizeMacsDistinct(readJsonPathStrings(rec, m.macAddress))[0] ?? null;
  return {
    ok: true,
    value: {
      ipAddress: ip,
      macAddress: mac,
      hostname: readJsonPathString(rec, m.hostname)?.slice(0, 255) ?? null,
      expiresAt: q.kind === "leases" ? parseLooseDate(readJsonPathString(rec, m.expiresAt)) : null,
      owner: q.kind === "assignments" ? (readJsonPathString(rec, m.owner)?.slice(0, 255) ?? null) : null,
      notes: q.kind === "assignments" ? (readJsonPathString(rec, m.notes)?.slice(0, 2000) ?? null) : null,
    },
  };
}

export interface GenericApiNetworkQueryResult {
  index: number;
  query: GenericApiNetworkQuery;
  subnets: GenericApiMappedSubnet[];
  addresses: GenericApiMappedAddress[];
  /** False when the read stopped early, or failed — the sweeps never act on it. */
  complete: boolean;
  rawCount: number;
  unmapped: number;
  unmappedReasons: string[];
  warnings: string[];
  /** Set when the query could not be read at all. */
  error: string | null;
}

/**
 * Read every network query. One query failing costs that query (marked
 * incomplete with its error) and never the others, nor the asset sync that
 * already ran.
 */
export async function discoverGenericApiNetwork(
  config: GenericApiConfig,
  signal?: AbortSignal,
  onProgress?: ProgressFn,
): Promise<GenericApiNetworkQueryResult[]> {
  const queries = (config.networkQueries ?? []).slice(0, GENERIC_API_NETWORK_LIMITS.maxQueries);
  if (queries.length === 0) return [];
  let headers: Record<string, string>;
  try {
    headers = await buildRequestHeaders(config, signal);
  } catch (err) {
    const error = (err as Error)?.message || "Could not authenticate";
    return queries.map((query, index) => emptyNetworkResult(index, query, error));
  }
  const out: GenericApiNetworkQueryResult[] = [];
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index];
    if (signal?.aborted) { out.push(emptyNetworkResult(index, query, "The run was cancelled")); continue; }
    const readCfg: GenericApiConfig = {
      ...config,
      path: query.path,
      method: query.method ?? "GET",
      body: query.body ?? "",
      recordsPath: query.recordsPath ?? "",
      pagination: query.paginate ? config.pagination : { mode: "none" },
    };
    try {
      const fetched = await fetchGenericApiRecords(readCfg, { signal, headers });
      const r = emptyNetworkResult(index, query, null);
      r.complete = fetched.complete;
      r.rawCount = fetched.records.length;
      r.warnings = fetched.warnings;
      for (const [i, rec] of fetched.records.entries()) {
        const mapped = query.kind === "subnets" ? mapNetworkSubnet(rec, query) : mapNetworkAddress(rec, query);
        if (!mapped.ok) {
          r.unmapped++;
          if (r.unmappedReasons.length < 5) r.unmappedReasons.push(`record ${i + 1}: ${mapped.reason}`);
          continue;
        }
        if (query.kind === "subnets") r.subnets.push(mapped.value as GenericApiMappedSubnet);
        else r.addresses.push(mapped.value as GenericApiMappedAddress);
      }
      onProgress?.("discover.network", "info", `${query.name || query.kind}: ${r.rawCount} record(s), ${r.unmapped} unmapped${r.complete ? "" : " — not read to the end"}`);
      out.push(r);
    } catch (err) {
      const error = (err as Error)?.message || "The network query failed";
      onProgress?.("discover.network", "error", `${query.name || query.kind}: ${error}`);
      out.push(emptyNetworkResult(index, query, error));
    }
  }
  return out;
}

function emptyNetworkResult(index: number, query: GenericApiNetworkQuery, error: string | null): GenericApiNetworkQueryResult {
  return { index, query, subnets: [], addresses: [], complete: error === null, rawCount: 0, unmapped: 0, unmappedReasons: [], warnings: [], error };
}
