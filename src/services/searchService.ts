/**
 * src/services/searchService.ts — Global fuzzy search across the domain
 *
 * Detects what the user typed (IP, CIDR, MAC, or plain text) and runs the
 * appropriate set of database queries in parallel. Returns a grouped hit list
 * capped at PER_GROUP_LIMIT per entity type so the UI typeahead can render a
 * compact dropdown.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { isValidIpAddress, normalizeCidr, ipInCidr } from "../utils/cidr.js";
import { macColonUpperOrNull } from "../utils/mac.js";
import { MONITOR_STATUS_LABELS } from "../utils/monitorStatus.js";
import { findAssetIdsByDiscoveredHostname } from "./discoveredHostnameService.js";
import { activeAlertSummaryByAsset, type AssetActiveAlertSummary } from "./notificationService.js";

export interface SearchHit {
  type: "block" | "subnet" | "reservation" | "asset" | "ip" | "site";
  id: string;
  title: string;       // Primary label (hostname, name, IP, etc.)
  subtitle?: string;   // Secondary label (CIDR, MAC, owner, etc.)
  // Asset/site hits only: the same five-state monitor pill the assets table
  // shows (plus the Dep. Down / Dependency Test overlays). `kind` keys the
  // dropdown's badge-class map; `label` is the display text.
  status?: { kind: string; label: string };
  // Asset/site hits only: the same active-alert summary the Assets list's
  // indicator reads ({severity, count, unacknowledged}), absent when nothing
  // is firing on that device. Both search surfaces draw it as the strobing
  // dot beside the name, so a device that looks alarmed in the list looks
  // alarmed when you search for it. Stamped by withAlertSummaries.
  alert?: AssetActiveAlertSummary;
  // Type-specific context needed for client-side navigation
  context?: Record<string, unknown>;
}

export interface SearchResults {
  query: string;
  blocks: SearchHit[];
  subnets: SearchHit[];
  reservations: SearchHit[];
  assets: SearchHit[];
  ips: SearchHit[];
  /**
   * Firewall assets that have lat/lng coordinates set — i.e. they
   * appear as pins on the Device Map. Surfaced as a separate group so
   * the dropdown can render a "Device Map" section that lets the
   * operator pan-to-marker. Excluded from `assets` to avoid showing
   * the same FortiGate twice.
   */
  sites: SearchHit[];
}

const PER_GROUP_LIMIT = 8;
// When the operator scopes a search to one group via a `block:` / `network:`
// / `asset:` / `reservation:` / `map:` prefix (or the short forms `b:` /
// `n:` / `a:` / `r:` / `m:`), the per-group cap is lifted to this value.
// Picked to be much larger than the default cap while still bounded so a
// pathological query can't scan the entire fleet — operators who want to
// enumerate a whole category have the dedicated page for that.
const SCOPED_LIMIT = 200;

// ─── Input classification ────────────────────────────────────────────────────

type SearchScope = "block" | "asset" | "reservation" | "map" | "network" | "tag";

// Recognize `block:` / `asset:` / `reservation:` / `map:` / `network:` / `tag:`
// and their short forms `b:` / `a:` / `r:` / `m:` / `n:` / `t:`. Case-
// insensitive; trims whitespace after the colon so `asset:  foo` works. The
// scopes are mutually exclusive with the `entra:` / `ad:` / `fgt:` source-kind
// prefix consumed inside `stripSourceKindPrefix` — none of those start with the
// scope letters. `tag` is listed before the bare `t` so `tag:` binds to the
// tag scope rather than the short form.
function parseSearchScope(raw: string): { scope: SearchScope | null; query: string } {
  // No `\s*` before the capture — `\s*(.*)$` backtracks polynomially on
  // long runs of whitespace (CodeQL js/polynomial-redos); the .trim() on
  // the captured rest below handles the post-colon whitespace instead.
  const m = raw.match(/^(block|asset|reservation|map|network|tag|b|a|r|m|n|t):(.*)$/i);
  if (!m) return { scope: null, query: raw };
  const prefix = m[1].toLowerCase();
  const rest = m[2].trim();
  let scope: SearchScope;
  if (prefix === "block" || prefix === "b") scope = "block";
  else if (prefix === "asset" || prefix === "a") scope = "asset";
  else if (prefix === "reservation" || prefix === "r") scope = "reservation";
  else if (prefix === "network" || prefix === "n") scope = "network";
  else if (prefix === "tag" || prefix === "t") scope = "tag";
  else scope = "map";
  return { scope, query: rest };
}

/**
 * Split a (scope-stripped) query into search terms. Whitespace separates
 * terms; a double-quoted run is kept as a single term so an operator can
 * search for a value that itself contains spaces (e.g. `"acme plant" metro`
 * → ["acme plant", "metro"]). A dangling opening quote with no closer is
 * tolerated — everything after it becomes one phrase. Quote characters are
 * stripped from the returned terms; empty terms are dropped.
 *
 * The returned terms are AND-combined by the query helpers: every term must
 * match at least one searched column for a row to be returned.
 */
export function parseSearchTerms(raw: string): string[] {
  const terms: string[] = [];
  // Either a (optionally unterminated) "quoted phrase" or a run of non-space.
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    // Guard against zero-width matches (e.g. a lone `"`) looping forever.
    if (m.index === re.lastIndex) re.lastIndex++;
    const term = (m[1] !== undefined ? m[1] : m[2] ?? "").trim();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Normalize a MAC to UPPER:CASE:COLON:FORM if recognizable, else null.
 * Deliberately the LOOSE form (all-zero allowed) — searching for the zero
 * MAC should find rows that carry it.
 */
export function normalizeMac(raw: string): string | null {
  return macColonUpperOrNull(raw);
}

/**
 * Interpret a search term as a partial-MAC PREFIX and return the inclusive
 * canonical-form bounds of the MAC interval it denotes ("AA:BB:C" →
 * [AA:BB:C0:00:00:00, AA:BB:CF:FF:FF:FF]). Range rows in AssetMacAddress
 * overlap that interval iff they contain a MAC with the prefix. Returns null
 * when the term isn't hex-and-separators (then it can't be a MAC fragment).
 */
export function macPrefixBounds(term: string): { low: string; high: string } | null {
  const compact = term.replace(/[\s:\-.]/g, "");
  if (!/^[0-9a-fA-F]{1,12}$/.test(compact)) return null;
  const toColon = (hex: string) => hex.toUpperCase().match(/.{2}/g)!.join(":");
  return {
    low: toColon(compact.padEnd(12, "0")),
    high: toColon(compact.padEnd(12, "f")),
  };
}

function isCidrLike(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){0,3}(\/\d{1,2})?$/.test(s);
}

function isIpLike(s: string): boolean {
  return isValidIpAddress(s);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Per-group visibility for a search call, derived from the caller's role at
 * the route layer (blocks→ipBlocks, subnets→subnets, reservations→reservations,
 * assets→assets, sites→deviceMap; the ips group needs subnets AND reservations
 * since resolveIp reveals both). Denied groups come back empty — the query
 * helpers for them are never executed. Defaults to all-allowed so non-route
 * callers keep the historical behavior.
 */
export interface SearchAllowed {
  blocks: boolean;
  subnets: boolean;
  reservations: boolean;
  assets: boolean;
  sites: boolean;
}

const ALLOW_ALL: SearchAllowed = {
  blocks: true, subnets: true, reservations: true, assets: true, sites: true,
};

export async function searchAll(
  rawQuery: string,
  allowed: SearchAllowed = ALLOW_ALL,
): Promise<SearchResults> {
  return withAlertSummaries(await runSearch(rawQuery, allowed));
}

/**
 * Stamp every asset-backed hit with its active-alert summary.
 *
 * ONE indexed query for the whole result set, never one per hit — the same
 * discipline `activeAlertSummaryByAsset` exists to enforce for the Assets
 * list, and search is typed into a keystroke at a time. Both groups are
 * covered because a `site` hit IS an asset (a pinned FortiGate), and a
 * firewall that is down is exactly the one an operator is searching for.
 *
 * The hits are mutated in place, which is what carries the summary onto the
 * mobile renderer's virtual Device Map rows: those are cloned from the asset
 * hits AFTER this runs.
 */
async function withAlertSummaries(results: SearchResults): Promise<SearchResults> {
  const hits = [...results.assets, ...results.sites];
  if (hits.length === 0) return results;
  const summaries = await activeAlertSummaryByAsset(hits.map((h) => h.id));
  if (summaries.size === 0) return results;
  for (const h of hits) {
    const s = summaries.get(h.id);
    if (s) h.alert = s;
  }
  return results;
}

async function runSearch(
  rawQuery: string,
  allowed: SearchAllowed = ALLOW_ALL,
): Promise<SearchResults> {
  const trimmed = rawQuery.trim();
  // Always echo the original query back to the client; the dropdown
  // stale-response check compares against what was typed, not the
  // post-scope-strip form.
  const empty: SearchResults = {
    query: trimmed,
    blocks: [], subnets: [], reservations: [], assets: [], ips: [], sites: [],
  };

  const { scope, query: scopedQuery } = parseSearchScope(trimmed);
  // Scoped searches accept any non-empty query (so `block:f` works);
  // unscoped queries keep the 2-char min so accidental keystrokes don't
  // fan out across every entity table.
  const minLen = scope ? 1 : 2;
  const q = scopedQuery;
  if (q.length < minLen) return empty;

  // Split into AND-combined terms (quoted phrases stay whole). The IP / CIDR
  // / MAC special-casing below is a single-value concept, so it only applies
  // when the operator typed exactly one term — a multi-term query is always a
  // plain text "match all of these" search.
  const terms = parseSearchTerms(q);
  if (terms.length === 0) return empty;
  const singleTerm = terms.length === 1;

  const mac = singleTerm ? normalizeMac(q) : null;
  // Memoized once per search — see DiscoveredHostnameLookup.
  let discoveredOnce: Promise<Map<string, string>> | null = null;
  const discovered: DiscoveredHostnameLookup = () =>
    (discoveredOnce ??= findAssetIdsByDiscoveredHostname(terms));
  const isIp = singleTerm && isIpLike(q);
  const isCidr = singleTerm && !isIp && isCidrLike(q) && q.includes("/");

  // Scoped path: run only the requested group's query with the elevated
  // cap and return everything else empty. Operators who pick a scope
  // explicitly want the full enumeration, not the typeahead-tuned top 8.
  if (scope === "block") {
    if (!allowed.blocks) return empty;
    const blocks = await searchBlocks(terms, SCOPED_LIMIT);
    return { ...empty, blocks: blocks.map(blockHit) };
  }
  if (scope === "network") {
    if (!allowed.subnets) return empty;
    const subnets = await searchSubnets(terms, isCidr ? q : null, SCOPED_LIMIT);
    return { ...empty, subnets: subnets.map(subnetHit) };
  }
  if (scope === "reservation") {
    if (!allowed.reservations) return empty;
    const reservations = await searchReservations(terms, isIp ? q : null, SCOPED_LIMIT);
    return { ...empty, reservations: reservations.map(reservationHit) };
  }
  if (scope === "map") {
    if (!allowed.sites) return empty;
    const sites = await searchPinnedFirewalls(terms, mac, SCOPED_LIMIT, discovered);
    return { ...empty, sites: sites.map(siteHit) };
  }
  if (scope === "asset") {
    if (!allowed.assets) return empty;
    const assetRows = await searchAssets(terms, mac, SCOPED_LIMIT, discovered);
    const originBySrcId = await resolveOriginFortigates(assetRows.map((a) => a.id));
    const assetHits = assetRows.map((a) => decorateAssetHit(a, originBySrcId.get(a.id)));
    return { ...empty, assets: assetHits };
  }
  if (scope === "tag") {
    // Tag scope spans every tag-bearing entity (blocks / subnets / assets):
    // each term must match (ILIKE, substring) at least one tag in the row's
    // `tags[]` array. Returns all three groups so the dropdown shows tagged
    // networks and assets together.
    const [blocks, subnets, assetRows] = await Promise.all([
      allowed.blocks ? searchBlocksByTag(terms, SCOPED_LIMIT) : Promise.resolve([]),
      allowed.subnets ? searchSubnetsByTag(terms, SCOPED_LIMIT) : Promise.resolve([]),
      allowed.assets ? searchAssetsByTag(terms, SCOPED_LIMIT) : Promise.resolve([]),
    ]);
    const originBySrcId = await resolveOriginFortigates(assetRows.map((a) => a.id));
    return {
      ...empty,
      blocks: blocks.map(blockHit),
      subnets: subnets.map(subnetHit),
      assets: assetRows.map((a) => decorateAssetHit(a, originBySrcId.get(a.id))),
    };
  }

  // Run all queries in parallel. Pinned firewalls are queried as their
  // own group (`sites`) with an independent PER_GROUP_LIMIT budget so
  // they don't get crowded out of `assets` by alphabetically-earlier
  // workstations/switches matching the same site code on large fleets.
  const [blocks, subnets, reservations, assets, sites, ipHit] = await Promise.all([
    allowed.blocks       ? searchBlocks(terms)                          : Promise.resolve([]),
    allowed.subnets      ? searchSubnets(terms, isCidr ? q : null)      : Promise.resolve([]),
    allowed.reservations ? searchReservations(terms, isIp ? q : null)   : Promise.resolve([]),
    allowed.assets       ? searchAssets(terms, mac, PER_GROUP_LIMIT, discovered)          : Promise.resolve([]),
    allowed.sites        ? searchPinnedFirewalls(terms, mac, PER_GROUP_LIMIT, discovered) : Promise.resolve([]),
    isIp && allowed.subnets && allowed.reservations ? resolveIp(q) : Promise.resolve(null),
  ]);

  const assetsWithoutSites = assets;

  // Resolve the origin FortiGate (a pinned site on the Device Map)
  // for each asset hit. When set, the dropdown's map-page handler can
  // open that FortiGate's topology modal and highlight where the
  // workstation/endpoint plugs in — instead of opening the asset
  // details page when the operator clearly wants the connectivity
  // view. Pinned-only filter ensures we only return FortiGates the
  // map page can actually navigate to.
  const originBySrcId = await resolveOriginFortigates(
    assetsWithoutSites.map((a) => a.id),
  );
  const assetHits = assetsWithoutSites.map((a) =>
    decorateAssetHit(a, originBySrcId.get(a.id)),
  );

  return {
    query: q,
    blocks: blocks.map(blockHit),
    subnets: subnets.map(subnetHit),
    reservations: reservations.map(reservationHit),
    assets: assetHits,
    ips: ipHit ? [ipHit] : [],
    sites: sites.map(siteHit),
  };
}

/**
 * For each asset id, find the FortiGate that asset was discovered on,
 * and only return the ones whose FortiGate is pinned on the Device Map
 * (lat/lng set — otherwise the map page can't navigate to it). Most-
 * recent DHCP sighting wins; falls back to `Asset.learnedLocation`
 * when no sighting exists (Entra/AD-discovered hosts that haven't been
 * seen on a FortiGate yet won't have one — that's fine, they fall
 * through to the asset-details navigation).
 */
async function resolveOriginFortigates(
  assetIds: string[],
): Promise<Map<string, { siteId: string; hostname: string }>> {
  const out = new Map<string, { siteId: string; hostname: string }>();
  if (assetIds.length === 0) return out;

  const sightings = await prisma.assetFortigateSighting.findMany({
    where: { assetId: { in: assetIds } },
    select: { assetId: true, fortigateDevice: true, lastSeen: true },
    orderBy: { lastSeen: "desc" },
  });
  const sightingByAsset = new Map<string, string>();
  for (const s of sightings) {
    if (!sightingByAsset.has(s.assetId)) sightingByAsset.set(s.assetId, s.fortigateDevice);
  }

  // learnedLocation fallback for assets without DHCP sightings (e.g.
  // Entra/AD-discovered with no FortiGate dance yet).
  const fallbackAssets = assetIds.filter((id) => !sightingByAsset.has(id));
  const learnedByAsset = new Map<string, string>();
  if (fallbackAssets.length > 0) {
    const rows = await prisma.asset.findMany({
      where: { id: { in: fallbackAssets }, learnedLocation: { not: null } },
      select: { id: true, learnedLocation: true },
    });
    for (const r of rows) {
      if (r.learnedLocation) learnedByAsset.set(r.id, r.learnedLocation);
    }
  }

  const candidateHostnames = new Set<string>([
    ...sightingByAsset.values(),
    ...learnedByAsset.values(),
  ]);
  if (candidateHostnames.size === 0) return out;

  const firewalls = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      hostname: { in: Array.from(candidateHostnames) },
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { id: true, hostname: true },
  });
  const fgByHostname = new Map<string, { siteId: string; hostname: string }>();
  for (const fg of firewalls) {
    if (fg.hostname) fgByHostname.set(fg.hostname, { siteId: fg.id, hostname: fg.hostname });
  }

  // A firewall is never its own origin: a pinned FortiGate's sighting /
  // learnedLocation resolves back to itself, and stamping that would make
  // the dropdown synthesize a virtual Device Map entry duplicating the
  // gate's real `sites` hit.
  for (const [assetId, fgHostname] of sightingByAsset) {
    const fg = fgByHostname.get(fgHostname);
    if (fg && fg.siteId !== assetId) out.set(assetId, fg);
  }
  for (const [assetId, fgHostname] of learnedByAsset) {
    const fg = fgByHostname.get(fgHostname);
    if (fg && fg.siteId !== assetId) out.set(assetId, fg);
  }
  return out;
}

// ─── Query helpers ───────────────────────────────────────────────────────────

// Build an `AND: [{ OR: [col contains term, ...] }, ...]` clause: every term
// must match at least one of the named columns. Each column entry is produced
// by `cols(term)`. A single term collapses to a one-element AND, preserving
// the pre-multi-term single-`contains` behavior exactly.
function andOfTerms(terms: string[], cols: (t: string) => any[]): any[] {
  return terms.map((t) => ({ OR: cols(t) }));
}

async function searchBlocks(terms: string[], limit = PER_GROUP_LIMIT) {
  return prisma.ipBlock.findMany({
    where: {
      AND: andOfTerms(terms, (t) => [
        { name: { contains: t, mode: "insensitive" } },
        { description: { contains: t, mode: "insensitive" } },
        { cidr: { contains: t, mode: "insensitive" } },
      ]),
    },
    take: limit,
    orderBy: { name: "asc" },
  });
}

async function searchSubnets(terms: string[], cidrExact: string | null, limit = PER_GROUP_LIMIT) {
  let cidrNormalized: string | null = null;
  if (cidrExact) {
    try { cidrNormalized = normalizeCidr(cidrExact); } catch { /* ignore */ }
  }

  const andClauses = andOfTerms(terms, (t) => [
    { cidr: { contains: t, mode: "insensitive" as const } },
    { name: { contains: t, mode: "insensitive" as const } },
    { purpose: { contains: t, mode: "insensitive" as const } },
    { fortigateDevice: { contains: t, mode: "insensitive" as const } },
  ]);

  return prisma.subnet.findMany({
    // `cidrExact` is only set for single-term CIDR queries; OR the normalized
    // exact-CIDR match alongside the term scan so `network:10.1.1.0/24` still
    // resolves the exact subnet even when the stored host bits differ.
    where: cidrNormalized
      ? { OR: [{ cidr: cidrNormalized }, { AND: andClauses }] }
      : { AND: andClauses },
    take: limit,
    orderBy: { name: "asc" },
  });
}

async function searchReservations(terms: string[], ipExact: string | null, limit = PER_GROUP_LIMIT) {
  const andClauses = andOfTerms(terms, (t) => [
    { hostname: { contains: t, mode: "insensitive" as const } },
    { owner: { contains: t, mode: "insensitive" as const } },
    { projectRef: { contains: t, mode: "insensitive" as const } },
    { notes: { contains: t, mode: "insensitive" as const } },
    { ipAddress: { contains: t, mode: "insensitive" as const } },
  ]);

  return prisma.reservation.findMany({
    // `ipExact` is single-term only; OR the exact-IP match alongside the term
    // scan so an IP query resolves the reservation regardless of which column
    // the substring would have hit.
    where: {
      status: "active",
      ...(ipExact
        ? { OR: [{ ipAddress: ipExact }, { AND: andClauses }] }
        : { AND: andClauses }),
    },
    include: { subnet: { select: { id: true, cidr: true, name: true } } },
    take: limit,
    orderBy: { hostname: "asc" },
  });
}

async function searchAssets(
  terms: string[],
  mac: string | null,
  limit = PER_GROUP_LIMIT,
  discovered?: DiscoveredHostnameLookup,
) {
  return runAssetSearch(terms, mac, {}, limit, discovered);
}

// ─── Tag-scope helpers (`tag:` / `t:`) ─────────────────────────────────────────

// AND of per-term EXISTS clauses over a row's `tags text[]` column: every term
// must match (case-insensitive substring) at least one tag in the array. The
// `tags` column name is identical across assets / subnets / ip_blocks, so one
// fragment serves all three. Parameterized — terms are bound, never interpolated.
function tagExistsAnd(terms: string[]): Prisma.Sql {
  return Prisma.join(
    terms.map(
      (t) => Prisma.sql`EXISTS (SELECT 1 FROM unnest(tags) tg WHERE tg ILIKE ${"%" + t + "%"})`,
    ),
    " AND ",
  );
}

async function searchAssetsByTag(terms: string[], limit = PER_GROUP_LIMIT) {
  const where = tagExistsAnd(terms);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM assets WHERE ${where} ORDER BY hostname ASC NULLS LAST LIMIT ${limit}
  `;
  if (rows.length === 0) return [];
  const assets = await prisma.asset.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    orderBy: { hostname: "asc" },
  });
  return assets;
}

async function searchSubnetsByTag(terms: string[], limit = PER_GROUP_LIMIT) {
  const where = tagExistsAnd(terms);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM subnets WHERE ${where} ORDER BY name ASC NULLS LAST LIMIT ${limit}
  `;
  if (rows.length === 0) return [];
  return prisma.subnet.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    orderBy: { name: "asc" },
  });
}

async function searchBlocksByTag(terms: string[], limit = PER_GROUP_LIMIT) {
  const where = tagExistsAnd(terms);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM ip_blocks WHERE ${where} ORDER BY name ASC NULLS LAST LIMIT ${limit}
  `;
  if (rows.length === 0) return [];
  return prisma.ipBlock.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    orderBy: { name: "asc" },
  });
}

async function searchPinnedFirewalls(
  terms: string[],
  mac: string | null,
  limit = PER_GROUP_LIMIT,
  discovered?: DiscoveredHostnameLookup,
) {
  return runAssetSearch(terms, mac, {
    assetType: "firewall",
    latitude: { not: null },
    longitude: { not: null },
  }, limit, discovered);
}

/**
 * Thunk resolving the discovered-hostname matches for the current search. A
 * thunk, and shared: `assets` and `sites` are two groups over the same terms,
 * so both await ONE lookup instead of issuing the pair of queries twice per
 * keystroke — and a scope that never touches assets fires it not at all.
 */
type DiscoveredHostnameLookup = () => Promise<Map<string, string>>;

async function runAssetSearch(
  terms: string[],
  mac: string | null,
  baseFilter: any,
  limit = PER_GROUP_LIMIT,
  discovered: DiscoveredHostnameLookup = () => findAssetIdsByDiscoveredHostname(terms),
) {
  // Per-term OR across the Asset's own columns. AND-combined below so every
  // term must hit at least one column (multi-word "match all" search). `mac`
  // is set only for single-term MAC queries — stored MAC case is inconsistent
  // (monitoringService / FMG CMDB uppercase; FMG endpoint clients as-is, often
  // lowercase), so match the normalized form case-insensitively rather than a
  // substring of the typed separators.
  const assetCols = (t: string): any[] => {
    const cols: any[] = [
      { hostname: { contains: t, mode: "insensitive" as const } },
      { dnsName: { contains: t, mode: "insensitive" as const } },
      { assetTag: { contains: t, mode: "insensitive" as const } },
      { serialNumber: { contains: t, mode: "insensitive" as const } },
      { ipAddress: { contains: t, mode: "insensitive" as const } },
      { manufacturer: { contains: t, mode: "insensitive" as const } },
      { model: { contains: t, mode: "insensitive" as const } },
      { assignedTo: { contains: t, mode: "insensitive" as const } },
      { department: { contains: t, mode: "insensitive" as const } },
    ];
    cols.push(
      mac
        ? { macAddress: { equals: mac, mode: "insensitive" as const } }
        : { macAddress: { contains: t, mode: "insensitive" as const } },
    );
    return cols;
  };
  const assetAnd = andOfTerms(terms, assetCols);

  // AssetSource cross-search — operator-typed searches by Entra deviceId,
  // AD objectGUID, or FortiGate serial used to hit `Asset.assetTag`
  // (entra:..., ad:..., fgt:... prefixes). After Phase 4d cuts those
  // assetTag writes, the canonical key is on AssetSource.externalId.
  // Run both queries in parallel and merge — old rows still match the
  // legacy assetTag column, new rows match via AssetSource. The "<kind>:"
  // prefix is a single-token paste form, so only strip it when there's one
  // term; multi-term searches match each term as-is.
  const sourceTerms = terms.length === 1 ? [stripSourceKindPrefix(terms[0])] : terms;
  const jsonLimit = limit * 4;
  // Per-term ILIKE fragments AND-combined within each side of the JSON UNION.
  const usersWhere = Prisma.join(
    terms.map((t) => Prisma.sql`"associatedUsers"::text ILIKE ${`%${t}%`}`),
    " AND ",
  );
  const observedWhere = Prisma.join(
    terms.map((t) => Prisma.sql`observed::text ILIKE ${`%${t}%`}`),
    " AND ",
  );
  const [byAsset, sourceHits, macSideHits, ipSideHits, ipHistHits, jsonHitIds, discoveredHostnames] = await Promise.all([
    prisma.asset.findMany({
      where: { ...baseFilter, AND: assetAnd },
      take: limit,
      orderBy: { hostname: "asc" },
    }),
    prisma.assetSource.findMany({
      where: {
        AND: sourceTerms.map((t) => ({ externalId: { contains: t, mode: "insensitive" as const } })),
        asset: baseFilter,
      },
      include: {
        asset: true,
      },
      take: limit,
    }),
    // Full MAC history (the side table) — `Asset.macAddress` only carries the
    // most-recently-seen value, so historical MACs from prior NICs / sightings
    // would otherwise be invisible to search. Range rows (interface-fold rows
    // with macEnd set — see AssetMacAddress in schema.prisma) match by
    // lexicographic containment: bounds are canonical colon-uppercase, so
    // `mac <= X AND macEnd >= X` is numeric containment. A full typed MAC
    // matches the range containing it; a partial term is additionally tried
    // as a MAC PREFIX against ranges (a mid-string fragment can't be resolved
    // against a range without expansion and only matches single-MAC rows).
    prisma.assetMacAddress.findMany({
      where: {
        ...(mac
          ? {
              OR: [
                { mac: { equals: mac, mode: "insensitive" as const } },
                { AND: [{ macEnd: { not: null } }, { mac: { lte: mac } }, { macEnd: { gte: mac } }] },
              ],
            }
          : {
              AND: terms.map((t) => {
                const clauses: object[] = [{ mac: { contains: t, mode: "insensitive" as const } }];
                const bounds = macPrefixBounds(t);
                if (bounds) {
                  clauses.push({
                    AND: [{ macEnd: { not: null } }, { mac: { lte: bounds.high } }, { macEnd: { gte: bounds.low } }],
                  });
                }
                return { OR: clauses };
              }),
            }),
        asset: baseFilter,
      },
      include: { asset: true },
      take: limit,
      orderBy: { lastSeen: "desc" },
    }),
    // Secondary interface IPs — `Asset.ipAddress` is the primary; multi-NIC
    // servers / FortiGates with several VIPs hold their other IPs in this
    // side table.
    prisma.assetAssociatedIp.findMany({
      where: {
        AND: terms.map((t) => ({ ip: { contains: t, mode: "insensitive" as const } })),
        asset: baseFilter,
      },
      include: { asset: true },
      take: limit,
      orderBy: { lastSeen: "desc" },
    }),
    // Historical IPs — the IP-history timeline keeps every IP an asset has
    // held (primary + associated, incl. public WAN / secondary addresses
    // folded in by the systemInfo scrape). `Asset.ipAddress` and
    // AssetAssociatedIp cover only what the asset holds *now*; this branch
    // makes a since-rotated-off address still resolve to the asset.
    prisma.assetIpHistory.findMany({
      where: {
        AND: terms.map((t) => ({ ip: { contains: t, mode: "insensitive" as const } })),
        asset: baseFilter,
      },
      include: { asset: true },
      take: limit,
      orderBy: { lastSeen: "desc" },
    }),
    // JSON-blob substring search across `Asset.associatedUsers` (logged-in
    // users from FortiGate DHCP sightings, shape `[{user, domain?, lastSeen,
    // source?}]`) and `AssetSource.observed` (Entra/AD/Intune raw blobs —
    // SID, UPN, onPremisesSecurityIdentifier, etc.). Backed by GIN trigram
    // indexes added in 20260507200000_search_json_trgm_indexes; falls back
    // to a seq scan only for queries shorter than 3 chars. Multi-term ANDs
    // each term's ILIKE within a single blob (e.g. first + last name).
    prisma.$queryRaw<{ assetId: string }[]>`
      SELECT id AS "assetId" FROM assets
      WHERE ${usersWhere}
      UNION
      SELECT "assetId" FROM asset_sources
      WHERE ${observedWhere}
      LIMIT ${jsonLimit}
    `,
    // Assets whose DISCOVERED hostname matches — the second line the list and
    // the slide-over print under an overridden hostname. `Asset.hostname`
    // carries only the pin, so the discovered half of the name is invisible to
    // the column scan above; this branch makes typing either of a pinned
    // device's two names find it. Restricted to pinned assets and confirmed
    // against the projection inside the service — see
    // discoveredHostnameService.findAssetIdsByDiscoveredHostname.
    discovered(),
  ]);
  // The raw query returns asset ids only; load the asset rows with the
  // baseFilter applied so the firewall vs. non-firewall partition still
  // holds (a pinned-firewall hit via observed-blob substring would otherwise
  // leak into the regular Assets group).
  const jsonAssets = jsonHitIds.length
    ? await prisma.asset.findMany({
        where: { ...baseFilter, id: { in: jsonHitIds.map((r) => r.assetId) } },
        take: limit,
        orderBy: { hostname: "asc" },
      })
    : [];
  // Same shape for the discovered-hostname hits: ids in, rows out, `baseFilter`
  // re-applied so a pinned firewall can't leak out of the Device Map group.
  const discoveredAssets = discoveredHostnames.size
    ? await prisma.asset.findMany({
        where: { ...baseFilter, id: { in: Array.from(discoveredHostnames.keys()) } },
        take: limit,
        orderBy: { hostname: "asc" },
      })
    : [];
  // Merge dedup by asset id; the byAsset query wins on hostname-sort order
  // for ties so existing presentation is preserved. Discovered-hostname hits
  // come next, then source/MAC/current-IP/historical-IP side hits and JSON-blob
  // hits fill any remaining budget in that order (current associated IPs rank
  // above since-rotated-off ones).
  const seen = new Set<string>();
  const merged: typeof byAsset = [];
  const tryPush = (a: any) => {
    if (!a || !a.id || seen.has(a.id)) return;
    seen.add(a.id);
    merged.push(a);
  };
  for (const a of byAsset) tryPush(a);
  // Ranked directly behind the column matches: matching one of a device's two
  // names is the same class of signal as matching its hostname column. The
  // projected name rides along on the row so the hit can say why it matched.
  for (const a of discoveredAssets) {
    if (merged.length >= limit) break;
    tryPush(Object.assign(a, { hostnameDiscovered: discoveredHostnames.get(a.id) ?? null }));
  }
  for (const s of sourceHits) {
    if (merged.length >= limit) break;
    tryPush(s.asset);
  }
  for (const m of macSideHits) {
    if (merged.length >= limit) break;
    tryPush(m.asset);
  }
  for (const ip of ipSideHits) {
    if (merged.length >= limit) break;
    tryPush(ip.asset);
  }
  for (const ip of ipHistHits) {
    if (merged.length >= limit) break;
    tryPush(ip.asset);
  }
  for (const a of jsonAssets) {
    if (merged.length >= limit) break;
    tryPush(a);
  }
  return merged.slice(0, limit);
}

// Build an asset SearchHit + stamp the origin-FortiGate context onto it when
// the asset was seen on a pinned firewall. Extracted from `searchAll` so the
// scoped `asset:` path can reuse the same shape.
function decorateAssetHit(
  a: { id: string; hostname: string | null; ipAddress: string | null; macAddress: string | null; assetTag: string | null; assetType: string; manufacturer: string | null; model: string | null; hostnameDiscovered?: string | null } & AssetMonitorPillFields,
  origin: { siteId: string; hostname: string } | undefined,
): SearchHit {
  const hit = assetHit(a);
  if (origin) {
    hit.context = {
      ...(hit.context ?? {}),
      siteId: origin.siteId,
      siteHostname: origin.hostname,
      focusHostname: a.hostname ?? null,
      focusIpAddress: a.ipAddress ?? null,
      focusMacAddress: a.macAddress ?? null,
      focusAssetId: a.id,
    };
  }
  return hit;
}

// Strip the "entra:" / "ad:" / "fgt:" / "intune:" / "fortiswitch:" / "fortiap:"
// prefix from a query so an operator pasting `entra:abcd-1234` matches the
// AssetSource externalId that just stores `abcd-1234`. Anything not
// matching one of the known prefixes passes through unchanged.
function stripSourceKindPrefix(q: string): string {
  const m = q.match(/^(entra|intune|ad|fgt|fortiswitch|fortiap):(.+)$/i);
  return m ? m[2].trim() : q;
}

// Find which subnet contains the IP and whether there is an active reservation.
async function resolveIp(ip: string): Promise<SearchHit | null> {
  const subnets = await prisma.subnet.findMany({
    where: { status: { not: "deprecated" } },
    select: { id: true, cidr: true, name: true },
  });
  const containing = subnets.find((s) => {
    try { return ipInCidr(ip, s.cidr); } catch { return false; }
  });
  if (!containing) return null;

  const reservation = await prisma.reservation.findFirst({
    where: { subnetId: containing.id, ipAddress: ip, status: "active" },
    select: { id: true, hostname: true, owner: true },
  });

  return {
    type: "ip",
    id: `${containing.id}|${ip}`,
    title: ip,
    subtitle: reservation
      ? `${reservation.hostname || reservation.owner || "reserved"} — in ${containing.cidr}`
      : `free — in ${containing.cidr} (${containing.name})`,
    context: {
      subnetId: containing.id,
      subnetCidr: containing.cidr,
      subnetName: containing.name,
      ipAddress: ip,
      reservationId: reservation?.id ?? null,
    },
  };
}

// ─── Hit shapers ─────────────────────────────────────────────────────────────

function blockHit(b: { id: string; name: string; cidr: string; description: string | null }): SearchHit {
  return {
    type: "block",
    id: b.id,
    title: b.name,
    subtitle: b.cidr + (b.description ? ` — ${b.description}` : ""),
  };
}

function subnetHit(s: { id: string; name: string; cidr: string; purpose: string | null }): SearchHit {
  return {
    type: "subnet",
    id: s.id,
    title: s.name,
    subtitle: s.cidr + (s.purpose ? ` — ${s.purpose}` : ""),
    context: { cidr: s.cidr },
  };
}

function reservationHit(
  r: { id: string; hostname: string | null; ipAddress: string | null; owner: string | null; subnet: { id: string; cidr: string; name: string } | null },
): SearchHit {
  return {
    type: "reservation",
    id: r.id,
    title: r.hostname || r.ipAddress || "reservation",
    subtitle: [r.ipAddress, r.subnet?.cidr, r.owner].filter(Boolean).join(" — "),
    context: {
      subnetId: r.subnet?.id ?? null,
      ipAddress: r.ipAddress,
    },
  };
}

/** Fields of an Asset row the monitor pill is derived from. */
export interface AssetMonitorPillFields {
  monitored: boolean | null;
  monitorStatus: string | null;
  dependencySuppressed?: boolean | null;
  dependencyTestUntil?: Date | null;
}

/**
 * Derive the monitor Status pill for a search hit — mirrors the precedence
 * of `assetMonitorBadge` in public/js/assets.js (the assets-table Status
 * column): unmonitored → Dependency Test overlay → Dep. Down overlay →
 * five-state machine (unknown/null renders as Pending). `kind` maps 1:1
 * onto the existing `.badge-*` monitor classes client-side.
 */
export function assetMonitorPillState(a: AssetMonitorPillFields): { kind: string; label: string } {
  if (!a.monitored) return { kind: "unmonitored", label: "Unmonitored" };
  if (a.dependencyTestUntil && a.dependencyTestUntil.getTime() > Date.now()) {
    return { kind: "dep-test", label: "Dependency Test" };
  }
  if (a.dependencySuppressed) return { kind: "dep-down", label: "Dep. Down" };
  const s = a.monitorStatus || "unknown";
  if (s === "up")         return { kind: "up",         label: "Up" };
  // "Missed" not "Warning" — see MONITOR_STATUS_LABELS in utils/monitorStatus.
  if (s === "warning")    return { kind: "warning",    label: MONITOR_STATUS_LABELS.warning };
  if (s === "down")       return { kind: "down",       label: "Down" };
  if (s === "recovering") return { kind: "recovering", label: "Recovering" };
  // Explicit, not folded into the Pending fallback: passive means "no
  // down-detection automation covers this device", which is a very different
  // statement from "never probed".
  if (s === "passive")    return { kind: "passive",    label: "Passive" };
  return { kind: "pending", label: "Pending" };
}

function assetHit(
  a: { id: string; hostname: string | null; ipAddress: string | null; macAddress: string | null; assetTag: string | null; assetType: string; manufacturer: string | null; model: string | null; hostnameDiscovered?: string | null } & AssetMonitorPillFields,
): SearchHit {
  // `hostnameDiscovered` is stamped only on rows that were FOUND by their
  // discovered name (runAssetSearch's pinned-hostname branch) — the title shows
  // the pin, so without naming the other half the hit looks like it matched
  // nothing the operator typed.
  const discovered = a.hostnameDiscovered && a.hostnameDiscovered !== a.hostname
    ? `discovered: ${a.hostnameDiscovered}`
    : null;
  const secondary = [discovered, a.ipAddress, a.macAddress, [a.manufacturer, a.model].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
  return {
    type: "asset",
    id: a.id,
    title: a.hostname || a.assetTag || "asset",
    subtitle: secondary || a.assetType,
    status: assetMonitorPillState(a),
  };
}

function siteHit(
  a: { id: string; hostname: string | null; serialNumber: string | null; ipAddress: string | null; model: string | null; learnedLocation: string | null; hostnameDiscovered?: string | null } & AssetMonitorPillFields,
): SearchHit {
  // Site label leads with hostname; subtitle pulls model + IP/serial so
  // the operator can disambiguate FortiGates whose hostnames overlap
  // (e.g. multiple branch units of the same model).
  const bits: string[] = [];
  // Same as assetHit: stamped only when the DISCOVERED name is what matched,
  // and the title is showing the pin instead.
  if (a.hostnameDiscovered && a.hostnameDiscovered !== a.hostname) {
    bits.push(`discovered: ${a.hostnameDiscovered}`);
  }
  if (a.model) bits.push(a.model);
  if (a.ipAddress) bits.push(a.ipAddress);
  if (a.serialNumber) bits.push(a.serialNumber);
  if (a.learnedLocation && a.learnedLocation !== a.hostname) bits.push(a.learnedLocation);
  return {
    type: "site",
    id: a.id,
    title: a.hostname || a.serialNumber || "FortiGate",
    subtitle: bits.join(" — "),
    status: assetMonitorPillState(a),
  };
}
