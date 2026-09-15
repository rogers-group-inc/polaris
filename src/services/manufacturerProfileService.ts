/**
 * src/services/manufacturerProfileService.ts
 *
 * CRUD + cached resolver for the editable `ManufacturerProfile` data model.
 * Replaces the hardcoded VENDOR_TELEMETRY_PROFILES constant at runtime in a
 * follow-up commit; this commit only owns the persistence + read paths.
 *
 * The cache is module-local and refreshed on every write. The hot probe
 * path (Slice 6c) will call `getProfileFor(manufacturer)` which is sync
 * after the boot warm-up — same shape as oidRegistry's API.
 */

import { prisma } from "../db.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import {
  isTransformKind,
  isCombinerKind,
  type TransformKind,
  type CombinerKind,
} from "../utils/symbolTransforms.js";
import { AppError } from "../utils/errors.js";
import { symbolReadiness, ensureRegistryLoaded, type SymbolReadiness } from "./oidRegistry.js";
import { logEvent } from "./eventLogService.js";
import { validateHttpCheckDefinition } from "./credentialService.js";
import { logger } from "../utils/logger.js";
import {
  normalizeStateMap,
  validateStateMap,
  type StateMap,
} from "../utils/stateProbes.js";

export type MetricKey =
  | "cpu"
  | "memory"
  | "temperature"
  | "interfaces"
  | "lldp"
  | "storage"
  | "wirelessStations";

export const METRIC_KEYS: MetricKey[] = [
  "cpu", "memory", "temperature", "interfaces", "lldp", "storage", "wirelessStations",
];

// Allowed display-only standard-MIB hints an operator can pin on a profile
// metric or override. Must stay in sync with the frontend `_SNMP_STANDARD_MIBS`
// table in `public/js/assets.js` (the SNMP Walk dropdown) — the keys are
// shared so the same labels render in both surfaces.
export const STD_MIB_KEYS = new Set<string>([
  "std:system",
  "std:interfaces",
  "std:if-ext",
  "std:host-resources",
  "std:entity",
  "std:entity-sensor",
  "std:lldp",
  "std:poe",
  "std:bridge",
  "std:q-bridge",
  "std:rstp",
  // IP-MIB: ipNetToPhysicalTable / ipNetToMediaTable — the neighbour cache
  // behind the ARP table stream. Was browsable and walkable but not pinnable
  // on a profile row until 2026-09.
  "std:ip",
]);

function asStdMibKeyOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(400, "MIB std key must be a string");
  }
  if (!STD_MIB_KEYS.has(value)) {
    throw new AppError(400, `Unknown standard MIB key: ${value}`);
  }
  return value;
}

// Metric-row Type values. `scalar` is the original single-OID shape; `table`
// is a single OID returning multiple rows; `double_scalar` is the
// generalized multi-OID shape that replaced the memory-only `composition`
// blob — the resolver fetches `symbol` AND `symbolB` and combines them via
// the `transform` field (which carries a CombinerKind in this case rather
// than the usual unary TransformKind).
export type MetricRowType = "scalar" | "double_scalar" | "table";

/**
 * Per-row provenance the profile page renders in the MIB cell: does this
 * row's symbol resolve at the manufacturer's scope, via which module and
 * layer — and when it does not, what to upload. `b` is the second symbol of a
 * double_scalar row. Filled by `annotateReadiness` on every read; absent on
 * the cached row the probe path uses (the probe resolves for itself).
 */
export interface RowReadiness {
  a: SymbolReadiness;
  b: SymbolReadiness | null;
}

export interface MetricOverrideRow {
  id:           string;
  modelPattern: string;
  symbol:       string;
  symbolB:      string | null;
  mibId:        string | null;
  mibStdKey:    string | null;
  type:         MetricRowType;
  transform:    TransformKind | CombinerKind | null;
  order:        number;
  readiness?:   RowReadiness;
}

export interface MetricRow {
  id:               string;
  metricKey:        MetricKey;
  defaultSymbol:    string | null;
  defaultSymbolB:   string | null;
  defaultMibId:     string | null;
  defaultMibStdKey: string | null;
  defaultType:      MetricRowType;
  defaultTransform: TransformKind | CombinerKind | null;
  overrides:        MetricOverrideRow[];
  /** Null when the row is unconfigured (built-in seed answers); see RowReadiness. */
  readiness?:       RowReadiness | null;
}

export interface CustomWidgetRow {
  id:             string;
  name:           string;
  /** NULL on an "http" widget, which names a request rather than an OID. */
  symbol:         string | null;
  /** NULL on an "http" widget — there is no MIB behind a URL. */
  mibId:          string | null;
  type:           "scalar" | "table";
  widgetType:     "gauge" | "line" | "table" | "state" | "http";
  transform:      TransformKind | null;
  displayOptions: Record<string, unknown>;
  order:          number;
  modelPattern:   string | null;
  /** Normalized state-probe mapping; null on gauge/line/table widgets. */
  stateMap:       StateMap | null;
  /** Sibling symbol supplying table-row names (state probes only). */
  labelSymbol:    string | null;
  /** The check definition; null on every non-http widget. */
  httpCheck:      Record<string, unknown> | null;
  /** `http`-typed Credential supplying auth; null = unauthenticated check. */
  credentialId:   string | null;
}

export interface ProfileSummary {
  id:                 string;
  manufacturer:       string;
  metricCount:        number;
  overrideCount:      number;
  widgetCount:        number;
  scopedMibCount:     number;
  createdAt:          string;
  updatedAt:          string;
  /** Every configured symbol resolves at this manufacturer's scope. */
  ready:              boolean;
  /** Some resolve, some do not. */
  partial:            boolean;
  unresolvedCount:    number;
  /** The unresolved symbols, deduplicated, for the collapsed header's tooltip. */
  unresolvedSymbols:  string[];
}

export interface ProfileFull {
  id:           string;
  manufacturer: string;
  createdBy:    string | null;
  createdAt:    string;
  updatedAt:    string;
  metrics:      MetricRow[];
  widgets:      CustomWidgetRow[];
}

const profileCache = new Map<string, ProfileFull>();
let cacheLoaded = false;

function asMetricKey(value: unknown): MetricKey {
  if (typeof value !== "string" || !(METRIC_KEYS as string[]).includes(value)) {
    throw new AppError(400, "Invalid metricKey");
  }
  return value as MetricKey;
}

function asMetricRowType(value: unknown): MetricRowType {
  if (value === "scalar" || value === "double_scalar" || value === "table") return value;
  throw new AppError(400, "Invalid type — expected 'scalar' | 'double_scalar' | 'table'");
}

// Custom widgets still only support scalar/table — double_scalar applies to
// metric rows where the resolver knows how to combine the two readings; the
// widget renderer doesn't.
//
// "state" is the 0/1 probe (see src/utils/stateProbes.ts): same walk, but the
// reading is mapped to a boolean at scrape time and lands in AssetStateSample
// instead of AssetCustomWidgetSample, which is what makes it alertable per row.
function asWidgetType(value: unknown): "gauge" | "line" | "table" | "state" | "http" {
  if (value === "gauge" || value === "line" || value === "table" || value === "state" || value === "http") return value;
  throw new AppError(400, "Invalid widgetType — expected gauge | line | table | state | http");
}

/**
 * An "http" widget is the odd one out: it carries a check definition instead of
 * an OID, so `symbol` and `mibId` are null on it and required on everything
 * else. That asymmetry is enforced here rather than by a column constraint,
 * because the requirement is per-widgetType and the DB cannot express it.
 *
 * The check itself is validated by the SAME function the credential Test
 * Connection flow uses, which is what stops a check passing a live test and
 * then being rejected when the operator tries to save it.
 */
async function httpFieldsForWrite(
  widgetType: string,
  httpCheck: unknown,
  credentialId: string | null | undefined,
): Promise<{ httpCheck: Record<string, unknown> | null; credentialId: string | null }> {
  if (widgetType !== "http") return { httpCheck: null, credentialId: null };

  const check: Record<string, unknown> =
    httpCheck && typeof httpCheck === "object" && !Array.isArray(httpCheck)
      ? { ...(httpCheck as Record<string, unknown>) }
      : {};
  validateHttpCheckDefinition(check);

  const credId = credentialId ? String(credentialId) : null;
  if (credId) {
    // Verified at save so a mistyped or deleted id fails in the form rather
    // than once per asset per interval, which is the same reasoning behind
    // compiling the regex here.
    const cred = await prisma.credential.findUnique({ where: { id: credId }, select: { id: true, type: true } });
    if (!cred) throw new AppError(400, "The selected HTTP credential no longer exists");
    if (cred.type !== "http") {
      throw new AppError(400, "An HTTP check widget needs an HTTP-typed credential");
    }
  }
  return { httpCheck: check, credentialId: credId };
}

function asWidgetSymbolType(value: unknown): "scalar" | "table" {
  if (value === "scalar" || value === "table") return value;
  throw new AppError(400, "Invalid widget symbol type — expected 'scalar' or 'table'");
}

/**
 * State-probe fields for a write. Only meaningful on `widgetType === "state"`;
 * the mapping is REQUIRED there, since a state probe with no mapping has no
 * definition of true and would silently record nothing. Non-state widgets are
 * normalized to nulls so flipping a widget's type can't leave a stale mapping
 * behind that a later type flip would resurrect.
 */
function stateFieldsForWrite(
  widgetType: "gauge" | "line" | "table" | "state" | "http",
  stateMap: unknown,
  labelSymbol: unknown,
): { stateMap: StateMap | null; labelSymbol: string | null } {
  if (widgetType !== "state") return { stateMap: null, labelSymbol: null };
  const reason = validateStateMap(stateMap ?? {});
  if (reason) throw new AppError(400, reason);
  const label = typeof labelSymbol === "string" ? labelSymbol.trim() : "";
  return { stateMap: normalizeStateMap(stateMap ?? {}), labelSymbol: label || null };
}

// For scalar / table types `transform` is a unary TransformKind (or null).
// For double_scalar `transform` is a binary CombinerKind. The validator is
// type-aware so a typo (combiner on a scalar row, transform on a double row)
// errors at write time instead of silently being persisted.
function asTransformForType(value: unknown, type: MetricRowType): TransformKind | CombinerKind | null {
  if (value === null || value === undefined || value === "") {
    // double_scalar requires a combiner to be useful, but we accept null at
    // write time so the operator can save a partially-configured row and
    // come back to it. The resolver treats double_scalar with no combiner
    // as a no-op.
    return null;
  }
  if (type === "double_scalar") {
    if (isCombinerKind(value)) return value;
    throw new AppError(400, `Invalid combiner for double_scalar type: ${String(value)}`);
  }
  // scalar / table
  if (isTransformKind(value)) return value;
  throw new AppError(400, `Invalid transform: ${String(value)}`);
}

// Reads a stored transform from the DB without knowing the row's type — used
// only in the shapeProfile path. Tries both registries; returns null if the
// value matches neither. The DB always stores values written through
// asTransformForType, so this only sees legitimate values.
function readStoredTransform(value: unknown): TransformKind | CombinerKind | null {
  if (value === null || value === undefined || value === "") return null;
  if (isTransformKind(value)) return value;
  if (isCombinerKind(value)) return value;
  return null;
}

// modelPattern is an operator-authored regex by design (matched against
// device model strings). Validate it compiles and cap its length so a
// pathological pattern can't be stored — the 2026-06-11 CodeQL sweep
// dismissed the js/regex-injection alerts on these sites as intended
// behavior (admin-gated feature) with this cap as hardening.
function assertValidModelPattern(pattern: string): void {
  if (pattern.length > 512) {
    throw new AppError(400, "modelPattern is too long (max 512 characters)");
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new AppError(400, "modelPattern must be a valid regex");
  }
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

// Validate that the per-row shape is internally consistent:
//   scalar:        symbol required, symbolB must be null
//   double_scalar: symbol + symbolB both required
//   table:         symbol required, symbolB must be null, transform must be null
// Caller passes the EFFECTIVE values (after merging input with the stored
// row for update paths) so partial updates that leave a row invalid are
// rejected before the DB write lands.
//
// Empty-row exception: a metric row with symbol+symbolB+transform all null
// is the legitimate "use built-in seed for this metric" state. It passes
// validation regardless of type (which defaults to "scalar"). Override
// rows always require a symbol because their whole purpose is to override
// the parent metric row's defaults.
function validateMetricRowShape(args: {
  type:      MetricRowType;
  symbol:    string | null;
  symbolB:   string | null;
  transform: TransformKind | CombinerKind | null;
  // "metric" or "override" — used in error messages AND to gate the
  // empty-row exception (only metric rows can be unconfigured).
  label:     "metric" | "override";
}): void {
  const { type, symbol, symbolB, transform, label } = args;
  if (label === "metric" && !symbol && !symbolB && !transform) {
    return; // unconfigured metric row = "use built-in seed"
  }
  if (type === "table") {
    if (!symbol) throw new AppError(400, `${label}: symbol is required`);
    if (symbolB) throw new AppError(400, `${label}: symbolB must be null on type="table"`);
    if (transform) throw new AppError(400, `${label}: transform must be null on type="table"`);
    return;
  }
  if (type === "scalar") {
    if (!symbol) throw new AppError(400, `${label}: symbol is required`);
    if (symbolB) throw new AppError(400, `${label}: symbolB must be null on type="scalar"`);
    return;
  }
  // double_scalar
  if (!symbol)  throw new AppError(400, `${label}: symbol (A) is required for type="double_scalar"`);
  if (!symbolB) throw new AppError(400, `${label}: symbolB (B) is required for type="double_scalar"`);
}

function shapeProfile(row: any): ProfileFull {
  const metrics: MetricRow[] = (row.metrics || []).map((m: any) => ({
    id:               m.id,
    metricKey:        asMetricKey(m.metricKey),
    defaultSymbol:    m.defaultSymbol ?? null,
    defaultSymbolB:   m.defaultSymbolB ?? null,
    defaultMibId:     m.defaultMibId ?? null,
    defaultMibStdKey: m.defaultMibStdKey ?? null,
    defaultType:      asMetricRowType(m.defaultType),
    defaultTransform: readStoredTransform(m.defaultTransform),
    overrides: (m.overrides || []).map((o: any) => ({
      id:           o.id,
      modelPattern: o.modelPattern,
      symbol:       o.symbol,
      symbolB:      o.symbolB ?? null,
      mibId:        o.mibId ?? null,
      mibStdKey:    o.mibStdKey ?? null,
      type:         asMetricRowType(o.type),
      transform:    readStoredTransform(o.transform),
      order:        o.order,
    })),
  }));
  // Same shaping as the write paths return (state fields included) — one
  // function so the cached read and a just-written row can't disagree.
  const widgets: CustomWidgetRow[] = (row.widgets || []).map((w: any) => shapeWidget(w));
  return {
    id:           row.id,
    manufacturer: row.manufacturer,
    createdBy:    row.createdBy ?? null,
    createdAt:    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:    row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    metrics,
    widgets,
  };
}

export async function refreshProfileCache(): Promise<void> {
  const rows = await (prisma as any).manufacturerProfile.findMany({
    include: {
      metrics: { include: { overrides: { orderBy: { order: "asc" } } } },
      widgets: { orderBy: { order: "asc" } },
    },
  });
  profileCache.clear();
  for (const row of rows) {
    const shaped = shapeProfile(row);
    profileCache.set(shaped.manufacturer.toLowerCase(), shaped);
  }
  cacheLoaded = true;
}

/**
 * Sync getter for the hot probe path. Returns null when the cache hasn't
 * loaded yet OR no profile exists for the given manufacturer. The Slice 6c
 * resolver swap will call this; for now it's exposed for future use and
 * unit-test convenience.
 */
export function getProfileFor(manufacturer: string | null | undefined): ProfileFull | null {
  if (!cacheLoaded || !manufacturer) return null;
  const canonical = normalizeManufacturer(manufacturer);
  if (!canonical) return null;
  return profileCache.get(canonical.toLowerCase()) ?? null;
}

/** One state probe, flattened out of its profile. */
export interface StateProbeSummary {
  id:           string;
  name:         string;
  manufacturer: string;
  /** "table" = one boolean per walked row; "scalar" = one per device. */
  type:         "scalar" | "table";
  modelPattern: string | null;
  stateMap:     StateMap;
}

/**
 * Every state probe defined across all manufacturer profiles, for the
 * automation builder. Reads the in-memory profile cache — a probe id is an
 * opaque UUID on a sample row, so the builder needs this to offer NAMES, and
 * the stored automation needs it to render "…is Alarm" rather than "…== 1".
 *
 * Returns [] before the cache warms (the boot order that leaves it cold also
 * means no probe has produced a sample yet). Sorted for a stable picker.
 */
export function listStateProbes(): StateProbeSummary[] {
  const out: StateProbeSummary[] = [];
  for (const profile of profileCache.values()) {
    for (const w of profile.widgets) {
      if (w.widgetType !== "state" || !w.stateMap) continue;
      out.push({
        id:           w.id,
        name:         w.name,
        manufacturer: profile.manufacturer,
        type:         w.type,
        modelPattern: w.modelPattern,
        stateMap:     w.stateMap,
      });
    }
  }
  return out.sort((a, b) =>
    a.manufacturer.localeCompare(b.manufacturer) || a.name.localeCompare(b.name));
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const rows = await (prisma as any).manufacturerProfile.findMany({
    include: {
      metrics: { include: { overrides: true } },
      widgets: true,
    },
    orderBy: { manufacturer: "asc" },
  });
  // Scoped MIB counts — joined separately so the count matches the
  // operator's mental model: "MIBs uploaded under this manufacturer."
  const mibCounts = new Map<string, number>();
  for (const row of rows) {
    const cnt = await (prisma as any).mibFile.count({ where: { manufacturer: row.manufacturer } });
    mibCounts.set(row.id, cnt);
  }
  await ensureRegistryLoaded();
  return rows.map((row: any): ProfileSummary => {
    const overrideCount = (row.metrics || []).reduce(
      (acc: number, m: any) => acc + ((m.overrides || []).length || 0),
      0,
    );
    return {
      id:             row.id,
      manufacturer:   row.manufacturer,
      metricCount:    row.metrics?.length ?? 0,
      overrideCount,
      widgetCount:    row.widgets?.length ?? 0,
      scopedMibCount: mibCounts.get(row.id) ?? 0,
      createdAt:      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt:      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      ...readinessSummary(shapeProfile(row)),
    };
  });
}

/**
 * `symbolWarnings` keyed by profile id — what the write routes have in hand.
 * Reads the cache (every write path refreshes it before returning), so the
 * lookup is a scan over tens of profiles at most.
 */
export function symbolWarningsForProfile(profileId: string, symbols: Array<{ symbol: string | null; mibId: string | null }>): string[] {
  for (const p of profileCache.values()) {
    if (p.id === profileId) return symbolWarnings(p.manufacturer, symbols);
  }
  return [];
}

/**
 * Typeahead source for the "+ Add Manufacturer" box: every manufacturer name
 * Polaris already knows about, so the operator picks the spelling the rest of
 * the system uses instead of minting a near-duplicate ("Aruba Networks" vs
 * "Aruba") that `getProfileFor` would then never resolve.
 *
 * Three contributors, merged case-insensitively and each value run through
 * `normalizeManufacturer` so what's offered is exactly what `createProfile`
 * would store:
 *   - `asset`  — distinct `Asset.manufacturer` (carries a device count).
 *   - `alias`  — `ManufacturerAlias.canonical`, the operator's own canonical
 *                spellings from MAC & Vendor Identification.
 *   - `oui`    — the `manufacturer` on each static OUI override, same card.
 * The raw IEEE OUI database is deliberately NOT a contributor: ~35k legal
 * names ("Cisco Systems, Inc.") is neither shippable to the browser nor the
 * canonical form profiles key on.
 *
 * Manufacturers that already have a profile are dropped — creating one 409s,
 * so offering it is noise. Distinct/groupBy queries only; cheap at 2000 assets.
 */
export async function listManufacturerSuggestions(): Promise<ManufacturerSuggestion[]> {
  const { getOuiOverrides } = await import("./ouiService.js");
  const [assetRows, aliasRows, overrides, profiles] = await Promise.all([
    prisma.asset.groupBy({
      by: ["manufacturer"],
      where: { manufacturer: { not: null } },
      _count: { _all: true },
    }),
    prisma.manufacturerAlias.findMany({
      select: { canonical: true },
      distinct: ["canonical"],
    }),
    getOuiOverrides().catch(() => []),
    (prisma as any).manufacturerProfile.findMany({ select: { manufacturer: true } }),
  ]);

  return mergeManufacturerSuggestions({
    assets:   assetRows.map((r) => ({ manufacturer: r.manufacturer, count: r._count?._all ?? 0 })),
    aliases:  aliasRows.map((r) => r.canonical),
    oui:      overrides.map((o) => o.manufacturer),
    existing: (profiles as { manufacturer: string }[]).map((p) => p.manufacturer),
  });
}

export type ManufacturerSuggestionSource = "asset" | "alias" | "oui";

export interface ManufacturerSuggestion {
  value:      string;
  sources:    ManufacturerSuggestionSource[];
  assetCount: number;
}

/**
 * Pure merge behind `listManufacturerSuggestions` — separated so the dedupe,
 * exclusion and ordering rules are unit-testable without a database.
 *
 * Every value is canonicalized through `normalizeManufacturer` (so "Aruba
 * Networks" and "Aruba" collapse to one row rather than offering both), keyed
 * case-insensitively, and dropped if a profile already claims it. Ordering is
 * device-count desc then alphabetical.
 */
export function mergeManufacturerSuggestions(input: {
  assets:   { manufacturer: string | null; count: number }[];
  aliases:  string[];
  oui:      string[];
  existing: string[];
}): ManufacturerSuggestion[] {
  const taken = new Set<string>(
    input.existing
      .map((m) => normalizeManufacturer(m ?? null)?.toLowerCase())
      .filter((m): m is string => !!m),
  );

  // key = lowercased canonical; first spelling seen wins as the display value.
  const merged = new Map<
    string,
    { value: string; sources: Set<ManufacturerSuggestionSource>; assetCount: number }
  >();
  const add = (raw: string | null, source: ManufacturerSuggestionSource, count = 0): void => {
    const canonical = normalizeManufacturer(raw ?? null);
    if (!canonical) return;
    const key = canonical.toLowerCase();
    if (taken.has(key)) return;
    const entry = merged.get(key)
      ?? { value: canonical, sources: new Set<ManufacturerSuggestionSource>(), assetCount: 0 };
    entry.sources.add(source);
    entry.assetCount += count;
    merged.set(key, entry);
  };

  for (const r of input.assets) add(r.manufacturer, "asset", r.count);
  for (const a of input.aliases) add(a, "alias");
  for (const o of input.oui) add(o, "oui");

  return Array.from(merged.values())
    .map((e) => ({ value: e.value, sources: Array.from(e.sources), assetCount: e.assetCount }))
    // Most-used first, then alphabetical — the vendor with 400 devices is far
    // likelier to be what the operator is typing than an alias-only entry.
    .sort((a, b) => b.assetCount - a.assetCount || a.value.localeCompare(b.value));
}

export async function getProfile(id: string): Promise<ProfileFull | null> {
  const row = await (prisma as any).manufacturerProfile.findUnique({
    where: { id },
    include: {
      metrics: { include: { overrides: { orderBy: { order: "asc" } } } },
      widgets: { orderBy: { order: "asc" } },
    },
  });
  if (!row) return null;
  await ensureRegistryLoaded();
  return annotateReadiness(shapeProfile(row));
}

// ─── Readiness ─────────────────────────────────────────────────────────────
//
// A profile row names a SYMBOL; whether that symbol resolves to an OID at the
// manufacturer's scope depends on which MIBs are loaded. Until 2026-09 the page
// could not tell the operator either way, so a row that saved cleanly and
// collected nothing looked identical to one that worked. These helpers read
// the registry (synchronously, after the boot warm-up) and stamp each
// configured symbol with where it came from or what to upload.

function rowReadiness(manufacturer: string, symbol: string | null, symbolB: string | null, mibId: string | null): RowReadiness | null {
  if (!symbol && !symbolB) return null;
  return {
    a: symbolReadiness(manufacturer, symbol ?? "", mibId),
    b: symbolB ? symbolReadiness(manufacturer, symbolB, mibId) : null,
  };
}

/** Return a copy of `profile` with `readiness` filled on every configured metric row and override. */
export function annotateReadiness(profile: ProfileFull): ProfileFull {
  return {
    ...profile,
    metrics: profile.metrics.map((m) => ({
      ...m,
      readiness: rowReadiness(profile.manufacturer, m.defaultSymbol, m.defaultSymbolB, m.defaultMibId),
      overrides: m.overrides.map((o) => ({
        ...o,
        readiness: rowReadiness(profile.manufacturer, o.symbol, o.symbolB, o.mibId) ?? undefined,
      })),
    })),
  };
}

/** The collapsed-header rollup: ready / partial / how many symbols are unresolved, and which. */
export function readinessSummary(profile: ProfileFull): Pick<ProfileSummary, "ready" | "partial" | "unresolvedCount" | "unresolvedSymbols"> {
  const annotated = annotateReadiness(profile);
  const all: SymbolReadiness[] = [];
  for (const m of annotated.metrics) {
    if (m.readiness) { all.push(m.readiness.a); if (m.readiness.b) all.push(m.readiness.b); }
    for (const o of m.overrides) {
      if (o.readiness) { all.push(o.readiness.a); if (o.readiness.b) all.push(o.readiness.b); }
    }
  }
  const unresolved = all.filter((r) => !r.resolved);
  const unresolvedSymbols = [...new Set(unresolved.map((r) => r.symbol))].sort();
  const resolvedCount = all.length - unresolved.length;
  return {
    ready:             all.length > 0 && unresolved.length === 0,
    partial:           resolvedCount > 0 && unresolved.length > 0,
    unresolvedCount:   unresolved.length,
    unresolvedSymbols,
  };
}

/**
 * Human-readable warnings for a write that just landed — the route returns
 * them beside the row and the UI toasts them. A warning, not a refusal: the
 * natural order is "type the symbol, then upload the MIB", and blocking the
 * first step would make the page unusable for exactly the operator it is
 * meant to help.
 */
export function symbolWarnings(manufacturer: string, symbols: Array<{ symbol: string | null; mibId: string | null }>): string[] {
  const out: string[] = [];
  for (const { symbol, mibId } of symbols) {
    if (!symbol) continue;
    const r = symbolReadiness(manufacturer, symbol, mibId);
    if (r.resolved) continue;
    out.push(describeUnresolved(manufacturer, r));
  }
  return out;
}

function describeUnresolved(manufacturer: string, r: SymbolReadiness): string {
  if (r.hint?.kind === "imports") {
    const mods = [...new Set(r.hint.roots.map((x) => x.module ?? x.symbol))];
    return `${r.symbol} does not resolve for ${manufacturer}: ${r.hint.mibModuleName} is missing ${mods.join(", ")} — upload it too`;
  }
  return `${r.symbol} does not resolve for ${manufacturer}: no uploaded MIB defines it — upload the vendor's MIB`;
}

/**
 * One warning-level Event per profile with unresolved symbols, emitted after
 * the boot warm-up. This is what puts "your Fortinet rows stopped resolving"
 * in the Events log the moment an upgrade removes a seed, instead of leaving
 * it to be discovered as a chart that quietly stopped.
 */
export async function emitProfileReadinessEvents(): Promise<number> {
  await ensureRegistryLoaded();
  let emitted = 0;
  for (const profile of profileCache.values()) {
    const s = readinessSummary(profile);
    if (s.unresolvedCount === 0) continue;
    const annotated = annotateReadiness(profile);
    const reasons = new Map<string, string>();
    for (const m of annotated.metrics) {
      for (const r of [m.readiness?.a, m.readiness?.b, ...m.overrides.flatMap((o) => [o.readiness?.a, o.readiness?.b])]) {
        if (r && !r.resolved && !reasons.has(r.symbol)) reasons.set(r.symbol, describeUnresolved(profile.manufacturer, r));
      }
    }
    await logEvent({
      action:       "manufacturer_profile.unresolved",
      level:        "warning",
      resourceType: "manufacturer_profile",
      resourceId:   profile.id,
      resourceName: profile.manufacturer,
      message:      `${profile.manufacturer}: ${s.unresolvedCount} profile symbol${s.unresolvedCount === 1 ? "" : "s"} do not resolve — ${s.unresolvedSymbols.join(", ")}. Telemetry using them is not being collected.`,
      details:      { unresolved: [...reasons.values()] },
    });
    emitted += 1;
  }
  return emitted;
}

export async function createProfile(input: {
  manufacturer: string;
  createdBy?:   string | null;
}): Promise<ProfileFull> {
  const canonical = normalizeManufacturer(input.manufacturer);
  if (!canonical) throw new AppError(400, "Manufacturer is required");

  // Pre-populate one empty metric row per metric key so the operator's
  // first encounter with the modal shows the full canvas. defaultSymbol
  // null = "use built-in seed for this metric" — i.e. no change yet.
  const id = (await import("crypto")).randomUUID();
  await prisma.$transaction([
    (prisma as any).manufacturerProfile.create({
      data: {
        id,
        manufacturer: canonical,
        createdBy:    input.createdBy ?? null,
      },
    }),
    ...METRIC_KEYS.map((mk) =>
      (prisma as any).manufacturerProfileMetric.create({
        data: {
          profileId:   id,
          metricKey:   mk,
          defaultType: "scalar",
        },
      }),
    ),
  ]).catch((err: any) => {
    if (err && err.code === "P2002") {
      throw new AppError(409, `A profile for "${canonical}" already exists`);
    }
    throw err;
  });

  await refreshProfileCache();
  const created = await getProfile(id);
  if (!created) throw new AppError(500, "Profile creation failed");
  return created;
}

export async function updateMetricRow(
  profileId: string,
  metricKey: string,
  input: {
    defaultSymbol?:    string | null;
    defaultSymbolB?:   string | null;
    defaultMibId?:     string | null;
    defaultMibStdKey?: string | null;
    defaultType?:      string;
    defaultTransform?: string | null;
  },
): Promise<MetricRow> {
  const mk = asMetricKey(metricKey);
  const row = await (prisma as any).manufacturerProfileMetric.findUnique({
    where: { profileId_metricKey: { profileId, metricKey: mk } },
  });
  if (!row) throw new AppError(404, "Metric row not found for this profile");

  // Mutual exclusion: a metric row points at AT MOST one MIB source —
  // either an uploaded MibFile (defaultMibId) or a built-in standard MIB
  // hint (defaultMibStdKey). The UI surfaces both via a single dropdown so
  // selecting one clears the other; reject on the wire if a caller sends
  // both as non-null in the same request.
  const nextMibId  = input.defaultMibId     === undefined ? row.defaultMibId     : (input.defaultMibId  ?? null);
  const nextStdKey = input.defaultMibStdKey === undefined
    ? row.defaultMibStdKey
    : asStdMibKeyOrNull(input.defaultMibStdKey);
  if (nextMibId && nextStdKey) {
    throw new AppError(400, "defaultMibId and defaultMibStdKey are mutually exclusive");
  }

  // Resolve effective values (merge input with existing row) so the shape
  // validator sees the post-write state and can reject invalid combos
  // (e.g. flipping to double_scalar without supplying symbolB).
  const nextType      = input.defaultType      === undefined ? asMetricRowType(row.defaultType) : asMetricRowType(input.defaultType);
  const nextSymbol    = input.defaultSymbol    === undefined ? (row.defaultSymbol ?? null)      : trimOrNull(input.defaultSymbol);
  const nextSymbolB   = input.defaultSymbolB   === undefined ? (row.defaultSymbolB ?? null)     : trimOrNull(input.defaultSymbolB);
  const nextTransform = input.defaultTransform === undefined
    ? readStoredTransform(row.defaultTransform)
    : asTransformForType(input.defaultTransform, nextType);

  validateMetricRowShape({
    type:      nextType,
    symbol:    nextSymbol,
    symbolB:   nextSymbolB,
    transform: nextTransform,
    label:     "metric",
  });

  const updated = await (prisma as any).manufacturerProfileMetric.update({
    where: { id: row.id },
    data: {
      defaultSymbol:    input.defaultSymbol    === undefined ? undefined : (nextSymbol ?? null),
      // When type is not double_scalar, force symbolB null at write time
      // so accidental leftovers from an earlier double_scalar config don't
      // get re-promoted later.
      defaultSymbolB:   nextType === "double_scalar" ? (nextSymbolB ?? null) : null,
      defaultMibId:     input.defaultMibId     === undefined ? undefined : (input.defaultMibId ?? null),
      defaultMibStdKey: input.defaultMibStdKey === undefined ? undefined : nextStdKey,
      defaultType:      input.defaultType      === undefined ? undefined : nextType,
      defaultTransform: input.defaultTransform === undefined ? undefined : (nextTransform ?? null),
    },
    include: { overrides: { orderBy: { order: "asc" } } },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return {
    id:               updated.id,
    metricKey:        mk,
    defaultSymbol:    updated.defaultSymbol ?? null,
    defaultSymbolB:   updated.defaultSymbolB ?? null,
    defaultMibId:     updated.defaultMibId ?? null,
    defaultMibStdKey: updated.defaultMibStdKey ?? null,
    defaultType:      asMetricRowType(updated.defaultType),
    defaultTransform: readStoredTransform(updated.defaultTransform),
    overrides: (updated.overrides || []).map((o: any) => ({
      id:           o.id,
      modelPattern: o.modelPattern,
      symbol:       o.symbol,
      symbolB:      o.symbolB ?? null,
      mibId:        o.mibId ?? null,
      mibStdKey:    o.mibStdKey ?? null,
      type:         asMetricRowType(o.type),
      transform:    readStoredTransform(o.transform),
      order:        o.order,
    })),
  };
}

export async function createOverride(
  profileId: string,
  metricKey: string,
  input: {
    modelPattern: string;
    symbol?:      string;
    symbolB?:     string | null;
    mibId?:       string | null;
    mibStdKey?:   string | null;
    type?:        string;
    transform?:   string | null;
    order?:       number;
  },
): Promise<MetricOverrideRow> {
  const mk = asMetricKey(metricKey);
  const row = await (prisma as any).manufacturerProfileMetric.findUnique({
    where: { profileId_metricKey: { profileId, metricKey: mk } },
  });
  if (!row) throw new AppError(404, "Metric row not found for this profile");
  if (!input.modelPattern || !input.modelPattern.trim()) {
    throw new AppError(400, "modelPattern is required");
  }
  assertValidModelPattern(input.modelPattern);
  const stdKey = asStdMibKeyOrNull(input.mibStdKey ?? null);
  if (input.mibId && stdKey) {
    throw new AppError(400, "mibId and mibStdKey are mutually exclusive");
  }

  const type      = asMetricRowType(input.type ?? "scalar");
  const symbol    = trimOrNull(input.symbol);
  const symbolB   = trimOrNull(input.symbolB);
  const transform = asTransformForType(input.transform ?? null, type);
  validateMetricRowShape({ type, symbol, symbolB, transform, label: "override" });

  const created = await (prisma as any).manufacturerProfileMetricOverride.create({
    data: {
      metricRowId:  row.id,
      modelPattern: input.modelPattern,
      symbol:       symbol ?? "",
      symbolB:      type === "double_scalar" ? (symbolB ?? null) : null,
      mibId:        input.mibId ?? null,
      mibStdKey:    stdKey,
      type,
      transform:    transform ?? null,
      order:        Number.isFinite(input.order) ? Number(input.order) : 0,
    },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return {
    id:           created.id,
    modelPattern: created.modelPattern,
    symbol:       created.symbol,
    symbolB:      created.symbolB ?? null,
    mibId:        created.mibId ?? null,
    mibStdKey:    created.mibStdKey ?? null,
    type:         asMetricRowType(created.type),
    transform:    readStoredTransform(created.transform),
    order:        created.order,
  };
}

export async function updateOverride(
  overrideId: string,
  input: {
    modelPattern?: string;
    symbol?:       string;
    symbolB?:      string | null;
    mibId?:        string | null;
    mibStdKey?:    string | null;
    type?:         string;
    transform?:    string | null;
    order?:        number;
  },
): Promise<MetricOverrideRow> {
  const existing = await (prisma as any).manufacturerProfileMetricOverride.findUnique({
    where: { id: overrideId },
    include: { metricRow: true },
  });
  if (!existing) throw new AppError(404, "Override not found");

  // Mutual exclusion: an override row points at AT MOST one MIB source.
  const nextMibId  = input.mibId     === undefined ? existing.mibId     : (input.mibId  ?? null);
  const nextStdKey = input.mibStdKey === undefined
    ? existing.mibStdKey
    : asStdMibKeyOrNull(input.mibStdKey);
  if (nextMibId && nextStdKey) {
    throw new AppError(400, "mibId and mibStdKey are mutually exclusive");
  }
  if (input.modelPattern !== undefined) {
    if (!input.modelPattern.trim()) throw new AppError(400, "modelPattern is required");
    assertValidModelPattern(input.modelPattern);
  }

  const nextType      = input.type      === undefined ? asMetricRowType(existing.type) : asMetricRowType(input.type);
  const nextSymbol    = input.symbol    === undefined ? (existing.symbol ?? null)     : trimOrNull(input.symbol);
  const nextSymbolB   = input.symbolB   === undefined ? (existing.symbolB ?? null)    : trimOrNull(input.symbolB);
  const nextTransform = input.transform === undefined
    ? readStoredTransform(existing.transform)
    : asTransformForType(input.transform, nextType);

  validateMetricRowShape({
    type:      nextType,
    symbol:    nextSymbol,
    symbolB:   nextSymbolB,
    transform: nextTransform,
    label:     "override",
  });

  const updated = await (prisma as any).manufacturerProfileMetricOverride.update({
    where: { id: overrideId },
    data: {
      modelPattern: input.modelPattern === undefined ? undefined : input.modelPattern,
      symbol:       input.symbol       === undefined ? undefined : (nextSymbol ?? ""),
      symbolB:      nextType === "double_scalar" ? (nextSymbolB ?? null) : null,
      mibId:        input.mibId        === undefined ? undefined : (input.mibId ?? null),
      mibStdKey:    input.mibStdKey    === undefined ? undefined : nextStdKey,
      type:         input.type         === undefined ? undefined : nextType,
      transform:    input.transform    === undefined ? undefined : (nextTransform ?? null),
      order:        input.order        === undefined ? undefined : Number(input.order),
    },
  });
  await touchProfile(existing.metricRow.profileId);
  await refreshProfileCache();
  return {
    id:           updated.id,
    modelPattern: updated.modelPattern,
    symbol:       updated.symbol,
    symbolB:      updated.symbolB ?? null,
    mibId:        updated.mibId ?? null,
    mibStdKey:    updated.mibStdKey ?? null,
    type:         asMetricRowType(updated.type),
    transform:    readStoredTransform(updated.transform),
    order:        updated.order,
  };
}

export async function deleteOverride(overrideId: string): Promise<void> {
  const existing = await (prisma as any).manufacturerProfileMetricOverride.findUnique({
    where: { id: overrideId },
    include: { metricRow: true },
  });
  if (!existing) return;
  await (prisma as any).manufacturerProfileMetricOverride.delete({ where: { id: overrideId } });
  await touchProfile(existing.metricRow.profileId);
  await refreshProfileCache();
}

export async function createWidget(
  profileId: string,
  input: {
    name:           string;
    symbol:         string;
    mibId:          string;
    type?:          string;
    widgetType:     string;
    transform?:     string | null;
    displayOptions?: Record<string, unknown>;
    order?:         number;
    modelPattern?:  string | null;
    stateMap?:      unknown;
    labelSymbol?:   string | null;
    httpCheck?:     unknown;
    credentialId?:  string | null;
    createdBy?:     string | null;
  },
): Promise<CustomWidgetRow> {
  if (!input.name || !input.name.trim()) throw new AppError(400, "Widget name is required");
  const widgetType = asWidgetType(input.widgetType);
  // An http widget names a request, not an OID, so the SNMP pair is required
  // for every OTHER type rather than universally.
  if (widgetType !== "http") {
    if (!input.symbol || !input.symbol.trim()) throw new AppError(400, "symbol is required");
    if (!input.mibId) throw new AppError(400, "mibId is required for custom widgets");
  }
  if (input.modelPattern) {
    assertValidModelPattern(input.modelPattern);
  }
  const state = stateFieldsForWrite(widgetType, input.stateMap, input.labelSymbol);
  const http = await httpFieldsForWrite(widgetType, input.httpCheck, input.credentialId);
  const created = await (prisma as any).manufacturerCustomWidget.create({
    data: {
      profileId,
      name:           input.name.trim(),
      symbol:         widgetType === "http" ? null : (input.symbol as string).trim(),
      mibId:          widgetType === "http" ? null : input.mibId,
      type:           asWidgetSymbolType(input.type ?? "scalar"),
      widgetType,
      transform:      asTransformForType(input.transform ?? null, "scalar") as TransformKind | null,
      displayOptions: input.displayOptions ?? {},
      order:          Number.isFinite(input.order) ? Number(input.order) : 0,
      modelPattern:   input.modelPattern ?? null,
      stateMap:       state.stateMap as any,
      labelSymbol:    state.labelSymbol,
      httpCheck:      http.httpCheck as any,
      credentialId:   http.credentialId,
      createdBy:      input.createdBy ?? null,
    },
  });
  await touchProfile(profileId);
  await refreshProfileCache();
  return shapeWidget(created);
}

export async function updateWidget(
  widgetId: string,
  input: {
    name?:          string;
    symbol?:        string;
    mibId?:         string;
    type?:          string;
    widgetType?:    string;
    transform?:     string | null;
    displayOptions?: Record<string, unknown>;
    order?:         number;
    modelPattern?:  string | null;
    stateMap?:      unknown;
    labelSymbol?:   string | null;
    httpCheck?:     unknown;
    credentialId?:  string | null;
  },
): Promise<CustomWidgetRow> {
  const existing = await (prisma as any).manufacturerCustomWidget.findUnique({ where: { id: widgetId } });
  if (!existing) throw new AppError(404, "Widget not found");
  if (input.modelPattern) {
    assertValidModelPattern(input.modelPattern);
  }
  // The state fields are decided from the EFFECTIVE type (posted, else stored),
  // so a partial edit that doesn't mention widgetType keeps a probe's mapping,
  // and one that flips a probe to a gauge clears it rather than leaving a stale
  // mapping for a later flip back to resurrect.
  const effectiveType = asWidgetType(input.widgetType ?? existing.widgetType);
  let stateWrite: { stateMap?: any; labelSymbol?: string | null };
  if (effectiveType !== "state") {
    stateWrite = { stateMap: null, labelSymbol: null };
  } else if (input.stateMap !== undefined || !existing.stateMap) {
    // Provided, or the widget is becoming a probe and needs a mapping to exist.
    const state = stateFieldsForWrite(effectiveType, input.stateMap ?? existing.stateMap ?? {}, input.labelSymbol);
    stateWrite = {
      stateMap:    state.stateMap as any,
      labelSymbol: input.labelSymbol === undefined ? undefined : state.labelSymbol,
    };
  } else {
    stateWrite = {
      labelSymbol: input.labelSymbol === undefined
        ? undefined
        : ((input.labelSymbol ?? "").trim() || null),
    };
  }
  // Same EFFECTIVE-type reasoning as the state fields above: an edit that does
  // not mention widgetType keeps the stored check, one that flips a widget away
  // from http clears it, and one that flips a widget TO http must supply a
  // check (an empty definition validates to "GET / expecting any 2xx", which is
  // a legitimate check, so this cannot fail closed on a partial edit).
  const httpWrite = effectiveType !== "http"
    ? { httpCheck: null, credentialId: null }
    : await httpFieldsForWrite(
        effectiveType,
        input.httpCheck === undefined ? (existing.httpCheck ?? {}) : input.httpCheck,
        input.credentialId === undefined ? (existing.credentialId ?? null) : input.credentialId,
      );

  const updated = await (prisma as any).manufacturerCustomWidget.update({
    where: { id: widgetId },
    data: {
      name:           input.name === undefined           ? undefined : input.name.trim(),
      // An http widget has no OID; flipping a widget to http clears the pair
      // rather than leaving a stale symbol that a later flip back would silently
      // resurrect (the stateMap precedent directly above).
      symbol:         effectiveType === "http" ? null : (input.symbol === undefined ? undefined : input.symbol.trim()),
      mibId:          effectiveType === "http" ? null : (input.mibId === undefined ? undefined : input.mibId),
      type:           input.type === undefined           ? undefined : asWidgetSymbolType(input.type),
      widgetType:     input.widgetType === undefined     ? undefined : asWidgetType(input.widgetType),
      transform:      input.transform === undefined      ? undefined : (asTransformForType(input.transform, "scalar") as TransformKind | null ?? null),
      displayOptions: input.displayOptions === undefined ? undefined : (input.displayOptions ?? {}),
      order:          input.order === undefined          ? undefined : Number(input.order),
      modelPattern:   input.modelPattern === undefined   ? undefined : (input.modelPattern ?? null),
      ...stateWrite,
      httpCheck:      httpWrite.httpCheck as any,
      credentialId:   httpWrite.credentialId,
    },
  });
  await touchProfile(existing.profileId);
  await refreshProfileCache();
  return shapeWidget(updated);
}

export async function deleteWidget(widgetId: string): Promise<void> {
  const existing = await (prisma as any).manufacturerCustomWidget.findUnique({ where: { id: widgetId } });
  if (!existing) return;
  await (prisma as any).manufacturerCustomWidget.delete({ where: { id: widgetId } });
  await touchProfile(existing.profileId);
  await refreshProfileCache();
}

export async function deleteProfile(profileId: string): Promise<void> {
  // No usage-count refusal here yet — the resolver swap (Slice 6c) is the
  // commit that introduces dependency. Today deleting a profile is purely
  // additive removal since monitoring still consults the hardcoded constant.
  await (prisma as any).manufacturerProfile.delete({ where: { id: profileId } });
  await refreshProfileCache();
}

function shapeWidget(w: any): CustomWidgetRow {
  const widgetType = asWidgetType(w.widgetType);
  return {
    id:             w.id,
    name:           w.name,
    symbol:         w.symbol,
    mibId:          w.mibId,
    type:           asWidgetSymbolType(w.type),
    widgetType,
    transform:      w.transform && isTransformKind(w.transform) ? (w.transform as TransformKind) : null,
    displayOptions: (w.displayOptions ?? {}) as Record<string, unknown>,
    order:          w.order,
    modelPattern:   w.modelPattern ?? null,
    // Read through normalizeStateMap rather than trusted verbatim: a probe row
    // written before a mode was added (or hand-edited in SQL) still yields a
    // usable mapping instead of throwing on the telemetry hot path.
    stateMap:       widgetType === "state" ? normalizeStateMap(w.stateMap ?? {}) : null,
    labelSymbol:    widgetType === "state" ? (w.labelSymbol ?? null) : null,
    httpCheck:      widgetType === "http" ? ((w.httpCheck ?? {}) as Record<string, unknown>) : null,
    credentialId:   widgetType === "http" ? (w.credentialId ?? null) : null,
  };
}

async function touchProfile(profileId: string): Promise<void> {
  try {
    await (prisma as any).manufacturerProfile.update({
      where: { id: profileId },
      data:  { updatedAt: new Date() },
    });
  } catch (err) {
    logger.debug({ err, profileId }, "Failed to bump manufacturer profile updatedAt");
  }
}
