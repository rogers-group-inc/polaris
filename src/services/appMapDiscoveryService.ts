/**
 * src/services/appMapDiscoveryService.ts
 *
 * Service & process DISCOVERY RULES (formerly the Application Map's "map rules"):
 * named rules that pin process programs and service units onto the assets an
 * operator chose — the ones that exist now and the ones discovered later. The
 * rules list lives on Integrations → Polaris Agent (the inventory these rules
 * select from is agent-fed), not on the Application Map page.
 *
 * Each rule carries a MODE: "map" rules put items on the Application Map AND
 * monitor them (mapping implies monitoring); "monitor" rules only pin the
 * monitoring surfaces (per-program CPU/RAM + logs, per-unit journal tailing) and
 * never touch the map pins.
 *
 * Each rule also carries a SOURCE: "manual" rules are operator-authored in the
 * wizard; "auto" rules are created by recordOperatorPinChanges when someone ticks
 * a Monitor/Map checkbox on an asset's Services tab. Auto rules are single-item,
 * target explicit assetIds, and CONSOLIDATE: pinning the same item on a second
 * asset adds that asset to the existing auto rule instead of minting another.
 * Manual rules are never consolidated into or edited by the hook.
 *
 * Why rules rather than a bulk action: pinning is per-asset (Asset.mappedProcesses
 * / Asset.mappedServices, one Services-tab checkbox at a time), so "map nginx on
 * the truckscale hosts" was N clicks that a newly-built host silently missed. A
 * rule is stored once and re-applied by the reconcileAppMapAutoMap job, so a host
 * that installs an agent tomorrow picks up the same pins.
 *
 * Why MANY rules rather than one selection: a single fleet-wide selection could
 * only express "every asset that reports this program", which over-pins — an
 * operator who wants truckscale.service mapped on the three truckscale hosts does
 * not want it on every host that happens to run it. Each rule carries its own
 * asset scope, so the same unit can be mapped in one part of the fleet and left
 * alone in another. (The pre-rules single-selection shape folds forward into one
 * rule at read time — see normalizeConfig.)
 *
 * Structure is modeled on autoMonitorStorageService (aggregate → preview →
 * additive apply), with the periodic-reconciler entry point borrowed from
 * tagAssignmentService/reconcileTagAssignments. Two deliberate differences:
 *
 *   - Scope is per-rule asset CRITERIA, not per-integration. These pins are
 *     agent-fed, and an agent host's discovering integration says nothing about
 *     whether its nginx belongs on the map. The criteria vocabulary is
 *     tagAssignmentService's rather than a second one.
 *
 *   - MAPPING IMPLIES MONITORING, one-way: everything a rule maps is also pinned
 *     for monitoring (per-program CPU/RAM + logs, per-unit journal tailing),
 *     because caring enough to put a service on the map means wanting its
 *     telemetry. Monitoring something is NOT a request to publish its connections,
 *     so nothing here writes a map pin from a monitor pin.
 *
 *   - Apply is STRICTLY ADDITIVE and never strips. `mappedProcesses` /
 *     `mappedServices` are operator-owned — someone may have pinned a program by
 *     hand on one host — so removing an item from a rule (or disabling the rule)
 *     stops FUTURE auto-pinning rather than retroactively unpinning.
 *     `unmapEverywhere` is the explicit, separately-invoked strip.
 *
 * Scale: the aggregates are bounded GROUP BY queries regardless of fleet size.
 * Never load per-asset AssetProcess rows to count them in memory — at 2000 hosts
 * that is ~400k rows on a modal open. Apply resolves each rule's scope once, then
 * loads the inventory for the UNION of in-scope assets a single time and evaluates
 * every rule against it in memory.
 */

import { chunkArray } from "../utils/chunk.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { compilePattern } from "./autoMonitorInterfacesService.js";
import {
  normalizeCriteria,
  resolveMatchingAssetIds,
  type TagCriteria,
} from "./tagAssignmentService.js";

export const SETTING_KEY = "appMapAutoMap";

/** Cap on rows returned per aggregate — a busy fleet has a long tail of
 *  one-host-only programs and the modal is a picker, not a report. */
const AGGREGATE_LIMIT = 2000;
/** Same per-array ceiling the assets PUT enforces on the pin fields. */
const MAX_SELECTION_ENTRIES = 64;
/**
 * Asset types Polaris actually collects a process / service inventory from, and
 * therefore the only ones a map rule can meaningfully target.
 *
 * Inventory comes from the Polaris Agent (or the agentless SSH/WinRM processes
 * cadence), which only ever lands on general-purpose hosts — never on appliances.
 * Without this filter "All monitored assets" counted every firewall, switch, AP
 * and printer in the fleet, so the device count on the wizard's Devices step
 * promised work that could never happen: those assets report nothing, so
 * `resolveBlockPins` finds nothing to pin on them.
 *
 * Applied to every CANDIDATE query (inventory aggregate, scope preview, apply) so
 * the count the operator sees is the count that can actually be pinned — including
 * for an explicitly-scoped rule, which likewise can't pin a switch. Deliberately
 * NOT applied to the fleet-wide already-pinned count (`pinnedCounts`), which must
 * still surface a hand-applied pin wherever it lives so Unmap-everywhere means
 * everywhere.
 *
 * `server` covers vCenter VMs too — they're typed `server` since the dedicated
 * virtual_machine type was retired. ESXi hosts (`hypervisor`) are excluded: no
 * agent runs on them. Widen this list when process collection reaches network
 * hardware; it's the single place that decides.
 */
export const PROCESS_CAPABLE_ASSET_TYPES = ["workstation", "server"] as const;

/** Enough for real fleet segmentation without turning the list into a page.
 *  Raised from 50 when auto rules landed — they're single-item, so a fleet that
 *  pins by hand accumulates more (smaller) rules than one authored in the wizard. */
const MAX_RULES = 200;
const MAX_NAME_LEN = 64;
/** Per-rule cap on explicit asset targets. Auto-rule consolidation grows this
 *  one asset per operator click, so the cap is generous but still a bound. */
const MAX_ASSET_IDS = 1000;
const BATCH_SIZE = 50;

// ─── Rule shape ─────────────────────────────────────────────────────────────

export interface AutoMapNameBlock {
  /** Explicit names/units ticked in the wizard. */
  names: string[];
  /** Wildcard (or regex, per `regex`) patterns. */
  patterns: string[];
  regex: boolean;
}

/** "map" pins the Application Map surfaces AND the monitoring surfaces (mapping
 *  implies monitoring); "monitor" pins only the monitoring surfaces. */
export type AppMapRuleMode = "map" | "monitor";
/** "manual" = wizard-authored; "auto" = created/consolidated from a per-asset
 *  Services-tab pin toggle (recordOperatorPinChanges). */
export type AppMapRuleSource = "manual" | "auto";

export interface AppMapRule {
  id: string;
  name: string;
  enabled: boolean;
  mode: AppMapRuleMode;
  source: AppMapRuleSource;
  /** Asset criteria. null = every monitored asset — UNLESS assetIds is set. */
  scope: TagCriteria | null;
  /**
   * Explicit asset targets, unioned with the scope's matches (the
   * MaintenanceSchedule targets = union(criteria, assetIds) precedent). A null
   * scope with a non-empty assetIds means JUST those assets — this is how auto
   * rules stay pinned to the assets whose checkboxes created them. An auto rule
   * that loses its last assetId is deleted rather than left to decay into a
   * null-scope match-everything rule.
   */
  assetIds: string[];
  processes: AutoMapNameBlock;
  services: AutoMapNameBlock;
}

export interface AppMapAutoMapConfig {
  version: 2;
  rules: AppMapRule[];
}

function emptyBlock(): AutoMapNameBlock {
  return { names: [], patterns: [], regex: false };
}

export function emptyConfig(): AppMapAutoMapConfig {
  return { version: 2, rules: [] };
}

/** True when a rule would pin nothing (no items selected). A scope alone pins
 *  nothing — it only narrows what the item lists apply to. */
export function isRuleEmpty(r: AppMapRule): boolean {
  const dead = (b: AutoMapNameBlock) => b.names.length === 0 && b.patterns.length === 0;
  return dead(r.processes) && dead(r.services);
}

function blockHasItems(b: AutoMapNameBlock): boolean {
  return b.names.length > 0 || b.patterns.length > 0;
}

// ─── Validation / normalization ─────────────────────────────────────────────

function normalizeStrings(raw: unknown, label: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AppError(400, `${label} must be an array of strings`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") throw new AppError(400, `${label} must be an array of strings`);
    const t = v.trim();
    if (!t) continue;
    // Case-insensitive dedup, but the FIRST spelling is what we keep: pins are
    // matched against inventory case-sensitively, so we must not fold case.
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  if (out.length > MAX_SELECTION_ENTRIES) {
    throw new AppError(400, `${label} may not exceed ${MAX_SELECTION_ENTRIES} entries`);
  }
  return out;
}

function normalizeBlock(raw: unknown, label: string): AutoMapNameBlock {
  if (raw == null) return emptyBlock();
  if (typeof raw !== "object") throw new AppError(400, `${label} must be an object`);
  const r = raw as Record<string, unknown>;
  const regex = r.regex === true;
  const patterns = normalizeStrings(r.patterns, `${label}.patterns`);
  // Compile up front so a bad pattern is a 400 on save rather than a silent
  // no-match on every reconcile tick.
  for (const p of patterns) compilePattern(p, regex);
  return { names: normalizeStrings(r.names, `${label}.names`), patterns, regex };
}

/** Asset ids are opaque exact-match keys, so unlike normalizeStrings this dedups
 *  case-SENSITIVELY and carries its own (much higher) cap. */
function normalizeAssetIds(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AppError(400, "assetIds must be an array of strings");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") throw new AppError(400, "assetIds must be an array of strings");
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  if (out.length > MAX_ASSET_IDS) {
    throw new AppError(400, `assetIds may not exceed ${MAX_ASSET_IDS} entries`);
  }
  return out;
}

/** Validate + normalize one posted rule. Throws AppError(400) on bad input. */
export function normalizeRule(raw: unknown): AppMapRule {
  if (raw == null || typeof raw !== "object") throw new AppError(400, "Rule must be an object");
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) throw new AppError(400, "Rule name is required");
  if (name.length > MAX_NAME_LEN) throw new AppError(400, `Rule name may not exceed ${MAX_NAME_LEN} characters`);
  return {
    id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : randomUUID(),
    name,
    enabled: r.enabled !== false,
    // Pre-mode rules were all map rules, so "map" is the compatible default.
    mode: r.mode === "monitor" ? "monitor" : "map",
    source: r.source === "auto" ? "auto" : "manual",
    // normalizeCriteria returns null when there are no usable rules, which is
    // exactly "no scope" — an empty tree must not mean "match nothing".
    scope: r.scope == null ? null : normalizeCriteria(r.scope),
    assetIds: normalizeAssetIds(r.assetIds),
    processes: normalizeBlock(r.processes, "processes"),
    services:  normalizeBlock(r.services,  "services"),
  };
}

/**
 * Validate + normalize a whole rule set. Also folds the PRE-RULES single
 * selection shape (`{version:1, processes, services, scope}`) forward into one
 * rule so an install that configured the old modal doesn't silently lose its
 * pins — done here at read time rather than in a migration job, same trick as
 * the flat retention default.
 */
export function normalizeConfig(raw: unknown): AppMapAutoMapConfig {
  if (raw == null) return emptyConfig();
  if (typeof raw !== "object") throw new AppError(400, "Config must be an object");
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.rules) && (r.processes != null || r.services != null)) {
    const folded = normalizeRule({
      name: "Imported selection",
      enabled: true,
      scope: r.scope ?? null,
      processes: r.processes,
      services: r.services,
    });
    return { version: 2, rules: isRuleEmpty(folded) ? [] : [folded] };
  }

  const rulesIn = Array.isArray(r.rules) ? r.rules : [];
  if (rulesIn.length > MAX_RULES) throw new AppError(400, `At most ${MAX_RULES} rules are supported`);
  const rules = rulesIn.map(normalizeRule);

  // Names are how operators refer to these in conversation and in Events, so
  // keep them unambiguous. Ids must be unique too or edits would fan out.
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const rule of rules) {
    const key = rule.name.toLowerCase();
    if (names.has(key)) throw new AppError(409, `Duplicate rule name "${rule.name}"`);
    names.add(key);
    if (ids.has(rule.id)) throw new AppError(400, "Duplicate rule id");
    ids.add(rule.id);
  }
  return { version: 2, rules };
}

// ─── Persistence ────────────────────────────────────────────────────────────

export async function getConfig(): Promise<AppMapAutoMapConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return emptyConfig();
  try {
    return normalizeConfig(row.value);
  } catch {
    // A stored blob that no longer validates (hand-edited, or written by a newer
    // version) must not brick the modal — fall back to "no rules".
    return emptyConfig();
  }
}

export async function saveConfig(cfg: AppMapAutoMapConfig): Promise<void> {
  await prisma.setting.upsert({
    where:  { key: SETTING_KEY },
    update: { value: cfg as any },
    create: { key: SETTING_KEY, value: cfg as any },
  });
}

// ─── Pure resolver ──────────────────────────────────────────────────────────

/**
 * Which of `available` names one block selects. Pure: no DB, no I/O. UNION of the
 * explicit names and the patterns; an empty block selects nothing. The caller
 * unions the result with the asset's existing pins.
 */
export function resolveBlockPins(block: AutoMapNameBlock, available: string[]): string[] {
  if (!block || available.length === 0) return [];
  if (block.names.length === 0 && block.patterns.length === 0) return [];
  const picked = new Set<string>();

  if (block.names.length > 0) {
    const want = new Set(block.names);
    for (const n of available) if (want.has(n)) picked.add(n);
  }
  if (block.patterns.length > 0) {
    const regexes = block.patterns.map((p) => compilePattern(p, block.regex));
    for (const n of available) if (regexes.some((rx) => rx.test(n))) picked.add(n);
  }
  return [...picked];
}

// ─── Aggregates (power the wizard's item picker) ─────────────────────────────

export interface AggregateRow {
  /** Program name (processes) or unit name (services). */
  name: string;
  /** Distinct in-scope monitored hosts reporting it. */
  deviceCount: number;
  /** Distinct hosts that already carry it as a map pin (fleet-wide). */
  mappedCount: number;
  /** systemd / windows — services only. */
  platform?: string | null;
  displayName?: string | null;
}

type CountRow = { name: string; count: number };

/** Hosts already pinning each name, from the pin arrays themselves. Fleet-wide
 *  on purpose: it answers "is this already on the map anywhere", which is what
 *  makes the Unmap-everywhere affordance meaningful. */
async function pinnedCounts(column: "mappedProcesses" | "mappedServices"): Promise<Map<string, number>> {
  // unnest + GROUP BY keeps this one bounded round-trip instead of reading every
  // asset's array into memory.
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(
    `SELECT x."name" AS "name", COUNT(*)::int AS "count"
       FROM "assets" a, unnest(a."${column}") AS x("name")
      WHERE a."monitored" = true
      GROUP BY 1`,
  );
  return new Map(rows.map((r) => [r.name, Number(r.count)]));
}

/**
 * Asset ids a scope selects, or null for "no scope" (caller skips the filter).
 * Every caller additionally intersects with monitored=true (matching the
 * Application Map's own filter — pinning a host the map won't render is wasted
 * work) AND with PROCESS_CAPABLE_ASSET_TYPES, so neither an unscoped rule nor one
 * scoped at an appliance can claim devices that report no inventory.
 */
async function scopedAssetIds(scope: TagCriteria | null): Promise<Set<string> | null> {
  if (!scope) return null;
  return resolveMatchingAssetIds(scope);
}

/**
 * The assets ONE RULE targets: union(scope matches, explicit assetIds), or null
 * for "every monitored asset". A null scope means "all" only while assetIds is
 * empty — with assetIds set it contributes nothing, so an auto rule targets
 * exactly the assets whose checkboxes created it.
 */
async function ruleTargetIds(rule: AppMapRule): Promise<Set<string> | null> {
  if (rule.assetIds.length === 0) return scopedAssetIds(rule.scope);
  const set = rule.scope ? new Set(await resolveMatchingAssetIds(rule.scope)) : new Set<string>();
  for (const id of rule.assetIds) set.add(id);
  return set;
}

/**
 * Aggregate the programs / units reported by the assets a scope selects. The
 * wizard calls this with the scope from its asset-selection step, so the item
 * picker lists what THOSE hosts actually run instead of the whole fleet's
 * inventory — that's the granularity the flat fleet-wide picker couldn't express.
 */
// COUNT(*) rather than COUNT(DISTINCT assetId): asset_processes is unique on
// (assetId, name) and asset_services on (assetId, unit), so a group can hold at
// most one row per asset and the two are equivalent — but DISTINCT costs a sort
// or hash per group over the whole table, which is most of what made this slow.
// Deliberately NOT adding an index on name/unit to speed the GROUP BY: both
// tables are written per asset per scrape by persistAssetProcesses /
// persistAssetServices (a delta now, but every created row still pays for
// every index), so an extra index would tax those writes fleet-wide to speed
// up one wizard step.
export async function getInventoryAggregate(
  scope: TagCriteria | null,
): Promise<{ processes: AggregateRow[]; services: AggregateRow[] }> {
  const allowed = await scopedAssetIds(scope);
  if (allowed && allowed.size === 0) return { processes: [], services: [] };
  const ids = allowed ? [...allowed] : null;
  // Prisma's tagged template needs a real array binding for = ANY.
  const TYPES = [...PROCESS_CAPABLE_ASSET_TYPES];

  const [procRows, svcRows, procPinned, svcPinned] = await Promise.all([
    ids
      ? prisma.$queryRaw<CountRow[]>`
          SELECT p."name" AS "name", COUNT(*)::int AS "count"
            FROM "asset_processes" p
            JOIN "assets" a ON a."id" = p."assetId"
           WHERE a."monitored" = true AND a."assetType" = ANY(${TYPES}::text[])
             AND p."assetId" = ANY(${ids}::text[])
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`
      : prisma.$queryRaw<CountRow[]>`
          SELECT p."name" AS "name", COUNT(*)::int AS "count"
            FROM "asset_processes" p
            JOIN "assets" a ON a."id" = p."assetId"
           WHERE a."monitored" = true AND a."assetType" = ANY(${TYPES}::text[])
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`,
    ids
      ? prisma.$queryRaw<Array<CountRow & { platform: string | null; displayName: string | null }>>`
          SELECT s."unit" AS "name", COUNT(*)::int AS "count",
                 MIN(s."platform") AS "platform", MIN(s."displayName") AS "displayName"
            FROM "asset_services" s
            JOIN "assets" a ON a."id" = s."assetId"
           WHERE a."monitored" = true AND a."assetType" = ANY(${TYPES}::text[])
             AND s."assetId" = ANY(${ids}::text[])
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`
      : prisma.$queryRaw<Array<CountRow & { platform: string | null; displayName: string | null }>>`
          SELECT s."unit" AS "name", COUNT(*)::int AS "count",
                 MIN(s."platform") AS "platform", MIN(s."displayName") AS "displayName"
            FROM "asset_services" s
            JOIN "assets" a ON a."id" = s."assetId"
           WHERE a."monitored" = true AND a."assetType" = ANY(${TYPES}::text[])
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${AGGREGATE_LIMIT}`,
    pinnedCounts("mappedProcesses"),
    pinnedCounts("mappedServices"),
  ]);

  return {
    processes: procRows.map((r) => ({
      name: r.name, deviceCount: Number(r.count), mappedCount: procPinned.get(r.name) ?? 0,
    })),
    services: svcRows.map((r) => ({
      name: r.name, deviceCount: Number(r.count), mappedCount: svcPinned.get(r.name) ?? 0,
      platform: r.platform, displayName: r.displayName,
    })),
  };
}

// ─── Candidate assets + their reported inventory ────────────────────────────

interface CandidateAsset {
  id: string;
  hostname: string | null;
  mappedProcesses: string[];
  mappedServices: string[];
  monitoredProcesses: string[];
  monitoredServices: string[];
}

/** Every monitored, process-capable asset, once. Rule scopes are applied in
 *  memory against this so a 10-rule config doesn't re-query the asset table 10
 *  times. */
async function loadMonitoredAssets(): Promise<CandidateAsset[]> {
  return prisma.asset.findMany({
    where: { monitored: true, assetType: { in: [...PROCESS_CAPABLE_ASSET_TYPES] } },
    select: {
      id: true, hostname: true, mappedProcesses: true, mappedServices: true,
      // Mapping implies monitoring (see computePending), so the monitor pin sets
      // are part of the diff.
      monitoredProcesses: true, monitoredServices: true,
    },
  });
}

/** assetId → reported names, for whichever inventories the rules need. */
async function loadInventories(
  assetIds: string[],
  needProcesses: boolean,
  needServices: boolean,
): Promise<{ processes: Map<string, string[]>; services: Map<string, string[]> }> {
  const processes = new Map<string, string[]>();
  const services = new Map<string, string[]>();
  if (assetIds.length === 0) return { processes, services };

  const push = (m: Map<string, string[]>, key: string, v: string) => {
    const cur = m.get(key);
    if (cur) cur.push(v);
    else m.set(key, [v]);
  };

  await Promise.all([
    needProcesses
      ? prisma.assetProcess
          .findMany({ where: { assetId: { in: assetIds } }, select: { assetId: true, name: true } })
          .then((rows) => { for (const r of rows) push(processes, r.assetId, r.name); })
      : Promise.resolve(),
    needServices
      ? prisma.assetService
          .findMany({ where: { assetId: { in: assetIds } }, select: { assetId: true, unit: true } })
          .then((rows) => { for (const r of rows) push(services, r.assetId, r.unit); })
      : Promise.resolve(),
  ]);
  return { processes, services };
}

interface PendingUpdate {
  assetId: string;
  hostname: string | null;
  freshProcesses: string[];
  freshServices: string[];
  nextProcesses: string[];
  nextServices: string[];
  /** Monitor pins implied by the map pins — see the note in computePending. */
  freshMonProcesses: string[];
  freshMonServices: string[];
  nextMonProcesses: string[];
  nextMonServices: string[];
}

/**
 * Everything a rule set WOULD add, computed in memory. Shared by preview and
 * apply so the two can never disagree.
 *
 * One asset can be matched by several rules; the pins union per asset, which is
 * why this can't just loop rules independently.
 */
async function computePending(rules: AppMapRule[]): Promise<PendingUpdate[]> {
  const live = rules.filter((r) => r.enabled && !isRuleEmpty(r));
  if (live.length === 0) return [];

  const assets = await loadMonitoredAssets();
  if (assets.length === 0) return [];
  const byId = new Map(assets.map((a) => [a.id, a]));

  // Resolve each rule's target set (scope ∪ explicit assetIds) once.
  const targetSets = await Promise.all(live.map((r) => ruleTargetIds(r)));

  // Which assets any rule touches, and what each needs loaded.
  const touched = new Set<string>();
  let needProcesses = false;
  let needServices = false;
  live.forEach((rule, i) => {
    const allowed = targetSets[i];
    if (blockHasItems(rule.processes)) needProcesses = true;
    if (blockHasItems(rule.services)) needServices = true;
    for (const a of assets) {
      if (allowed && !allowed.has(a.id)) continue;
      touched.add(a.id);
    }
  });
  if (touched.size === 0) return [];

  const inv = await loadInventories([...touched], needProcesses, needServices);

  // Union the pins each rule contributes, per asset — split by surface. MAP
  // wants come from "map"-mode rules only; MONITOR wants come from every rule
  // (mapping implies monitoring, so a map rule contributes to both, while a
  // "monitor"-mode rule contributes only here and never touches the map pins).
  const wantProc = new Map<string, Set<string>>();
  const wantSvc = new Map<string, Set<string>>();
  const wantMonProc = new Map<string, Set<string>>();
  const wantMonSvc = new Map<string, Set<string>>();
  const addAll = (m: Map<string, Set<string>>, id: string, vals: string[]) => {
    if (vals.length === 0) return;
    let s = m.get(id);
    if (!s) { s = new Set(); m.set(id, s); }
    for (const v of vals) s.add(v);
  };
  live.forEach((rule, i) => {
    const allowed = targetSets[i];
    const maps = rule.mode === "map";
    for (const a of assets) {
      if (allowed && !allowed.has(a.id)) continue;
      if (blockHasItems(rule.processes)) {
        const picked = resolveBlockPins(rule.processes, inv.processes.get(a.id) ?? []);
        if (maps) addAll(wantProc, a.id, picked);
        addAll(wantMonProc, a.id, picked);
      }
      if (blockHasItems(rule.services)) {
        const picked = resolveBlockPins(rule.services, inv.services.get(a.id) ?? []);
        if (maps) addAll(wantSvc, a.id, picked);
        addAll(wantMonSvc, a.id, picked);
      }
    }
  });

  const pending: PendingUpdate[] = [];
  for (const id of touched) {
    const a = byId.get(id);
    if (!a) continue;
    const haveProc = new Set(a.mappedProcesses);
    const haveSvc = new Set(a.mappedServices);
    const freshProcesses = [...(wantProc.get(id) ?? [])].filter((n) => !haveProc.has(n));
    const freshServices  = [...(wantSvc.get(id)  ?? [])].filter((n) => !haveSvc.has(n));

    // MAPPING IMPLIES MONITORING, one-way. Everything a rule maps is also pinned
    // for monitoring (per-program CPU/RAM + logs, per-unit journal tailing),
    // because an operator who cares enough about a service to put it on the map
    // wants its telemetry too. The reverse does NOT hold: monitoring something is
    // not a request to publish its connections, so nothing here ever writes
    // mappedProcesses/mappedServices from a monitor pin.
    //
    // Computed against the FULL want-set, not just what was fresh for mapping —
    // otherwise an item already mapped but never monitored (mapped before this
    // behaviour existed, or monitor-unpinned by hand) would never catch up.
    const haveMonProc = new Set(a.monitoredProcesses);
    const haveMonSvc = new Set(a.monitoredServices);
    const freshMonProcesses = [...(wantMonProc.get(id) ?? [])].filter((n) => !haveMonProc.has(n));
    const freshMonServices  = [...(wantMonSvc.get(id)  ?? [])].filter((n) => !haveMonSvc.has(n));

    if (freshProcesses.length === 0 && freshServices.length === 0 &&
        freshMonProcesses.length === 0 && freshMonServices.length === 0) continue;
    pending.push({
      assetId: a.id,
      hostname: a.hostname,
      freshProcesses,
      freshServices,
      nextProcesses: [...a.mappedProcesses, ...freshProcesses],
      nextServices:  [...a.mappedServices,  ...freshServices],
      freshMonProcesses,
      freshMonServices,
      nextMonProcesses: [...a.monitoredProcesses, ...freshMonProcesses],
      nextMonServices:  [...a.monitoredServices,  ...freshMonServices],
    });
  }
  return pending;
}

// ─── Preview (writes nothing) ───────────────────────────────────────────────

export interface AutoMapPreview {
  deviceCount: number;
  processPins: number;
  servicePins: number;
  /** Monitor pins implied by the map pins (mapping implies monitoring, one-way). */
  monitorPins: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; processes: string[]; services: string[] }>;
}

function summarize(pending: PendingUpdate[]): AutoMapPreview {
  return {
    deviceCount: pending.length,
    processPins: pending.reduce((n, p) => n + p.freshProcesses.length, 0),
    servicePins: pending.reduce((n, p) => n + p.freshServices.length, 0),
    monitorPins: pending.reduce((n, p) => n + p.freshMonProcesses.length + p.freshMonServices.length, 0),
    sampleDevices: pending.slice(0, 10).map((p) => ({
      assetId: p.assetId,
      hostname: p.hostname,
      processes: p.freshProcesses,
      services: p.freshServices,
    })),
  };
}

/** What ONE rule would add right now (the wizard's review step). */
export async function previewRule(rule: AppMapRule): Promise<AutoMapPreview> {
  return summarize(await computePending([rule]));
}

/**
 * Assets a scope selects, for the wizard's asset-selection step. Reports the
 * count plus a sample so the operator can see they picked the hosts they meant.
 */
export interface ScopePreview {
  total: number;
  assets: Array<{ id: string; hostname: string | null; ipAddress: string | null; assetType: string | null }>;
}

export async function previewScope(
  scope: TagCriteria | null,
  assetIds: string[] = [],
): Promise<ScopePreview> {
  // Same union semantics as ruleTargetIds: explicit assetIds join the scope's
  // matches, and a null scope with assetIds means JUST those assets.
  let allowed: Set<string> | null;
  if (assetIds.length === 0) {
    allowed = await scopedAssetIds(scope);
  } else {
    allowed = scope ? new Set(await resolveMatchingAssetIds(scope)) : new Set<string>();
    for (const id of assetIds) allowed.add(id);
  }
  const rows = await prisma.asset.findMany({
    where: {
      monitored: true,
      // Same process-capable filter the apply uses, so the count on the Devices
      // step is the count that can actually be pinned rather than a fleet total
      // padded with appliances that report no inventory.
      assetType: { in: [...PROCESS_CAPABLE_ASSET_TYPES] },
      ...(allowed ? { id: { in: [...allowed] } } : {}),
    },
    select: { id: true, hostname: true, ipAddress: true, assetType: true },
    orderBy: [{ hostname: "asc" }],
  });
  return { total: rows.length, assets: rows.slice(0, 100) };
}

// ─── Apply (additive) ───────────────────────────────────────────────────────

export interface AutoMapApplyResult {
  devices: number;
  processPins: number;
  servicePins: number;
  monitorPins: number;
  sampleDevices: Array<{ assetId: string; hostname: string | null; processes: string[]; services: string[] }>;
}

/**
 * Pin everything the enabled rules resolve to. Strictly additive — pins are the
 * union of existing and computed, and an asset with nothing fresh is skipped
 * entirely so a back-to-back reconcile is silent. Chunked Promise.allSettled so a
 * 2000-host fleet doesn't serialize a thousand updates behind the request (or the
 * job tick). Idempotent: a half-landed batch yields the same final set on re-run.
 */
export async function applyRules(rules: AppMapRule[]): Promise<AutoMapApplyResult> {
  const empty: AutoMapApplyResult = { devices: 0, processPins: 0, servicePins: 0, monitorPins: 0, sampleDevices: [] };
  const pending = await computePending(rules);
  if (pending.length === 0) return empty;

  let devices = 0;
  let processPins = 0;
  let servicePins = 0;
  let monitorPins = 0;
  for (const chunk of chunkArray(pending, BATCH_SIZE)) {
    const results = await Promise.allSettled(
      chunk.map((p) =>
        prisma.asset.update({
          where: { id: p.assetId },
          data: {
            ...(p.freshProcesses.length ? { mappedProcesses: p.nextProcesses } : {}),
            ...(p.freshServices.length  ? { mappedServices:  p.nextServices  } : {}),
            // Mapping implies monitoring (one-way) — see computePending.
            ...(p.freshMonProcesses.length ? { monitoredProcesses: p.nextMonProcesses } : {}),
            ...(p.freshMonServices.length  ? { monitoredServices:  p.nextMonServices  } : {}),
          },
        }),
      ),
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      const p = chunk[k];
      if (!r || !p || r.status !== "fulfilled") continue;
      devices += 1;
      processPins += p.freshProcesses.length;
      servicePins += p.freshServices.length;
      monitorPins += p.freshMonProcesses.length + p.freshMonServices.length;
    }
  }

  return { ...summarize(pending), devices, processPins, servicePins, monitorPins };
}

// ─── Explicit un-map (the only subtractive path) ────────────────────────────

export interface UnmapResult {
  devices: number;
  connectionRowsDeleted: number;
}

/**
 * Remove one name from every asset's map pins and delete its connection rows —
 * the same cleanup the per-asset PUT does when a pin is un-ticked, applied fleet-
 * wide. Separate from apply on purpose: additive apply can never un-map, so
 * "actually take this off the map everywhere" has to be its own deliberate action.
 *
 * Also drops the name from EVERY rule, otherwise the next reconcile would put it
 * straight back.
 */
export async function unmapEverywhere(kind: "process" | "service", name: string): Promise<UnmapResult> {
  const target = String(name ?? "").trim();
  if (!target) throw new AppError(400, "Name is required");
  const isProc = kind === "process";
  const column = isProc ? "mappedProcesses" : "mappedServices";

  const assets = await prisma.asset.findMany({
    where: { [column]: { has: target } } as any,
    select: { id: true, mappedProcesses: true, mappedServices: true },
  });

  let devices = 0;
  let connectionRowsDeleted = 0;
  for (const chunk of chunkArray(assets, BATCH_SIZE)) {
    const results = await Promise.allSettled(chunk.map(async (a) => {
      const next = (isProc ? a.mappedProcesses : a.mappedServices).filter((n) => n !== target);
      await prisma.asset.update({
        where: { id: a.id },
        data: isProc ? { mappedProcesses: next } : { mappedServices: next },
      });
      const { count } = await prisma.assetProcessConnection.deleteMany({
        where: isProc ? { assetId: a.id, processName: target } : { assetId: a.id, unit: target },
      });
      return count;
    }));
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      devices += 1;
      connectionRowsDeleted += r.value;
    }
  }

  // Stop the reconciler from re-pinning what was just removed. Only "map"-mode
  // rules can re-pin the MAP surfaces, so monitor-only rules keep their names —
  // unmap-everywhere takes things off the map, it doesn't stop monitoring them.
  const cfg = await getConfig();
  let changed = false;
  for (const rule of cfg.rules) {
    if (rule.mode !== "map") continue;
    const block = isProc ? rule.processes : rule.services;
    const before = block.names.length;
    block.names = block.names.filter((n) => n !== target);
    if (block.names.length !== before) changed = true;
  }
  // An auto rule that just lost its only item is spent — delete it rather than
  // leaving an inert row in the list. Manual rules stay: the operator authored
  // them and may re-add items in the wizard.
  const kept = cfg.rules.filter((r) => !(r.source === "auto" && isRuleEmpty(r)));
  if (kept.length !== cfg.rules.length) {
    cfg.rules = kept;
    changed = true;
  }
  if (changed) await saveConfig(cfg);

  return { devices, connectionRowsDeleted };
}

// ─── Auto rules from per-asset pin toggles ──────────────────────────────────

/** One Services-tab checkbox flip, as observed by the assets PUT diff. */
export interface OperatorPinChange {
  assetId: string;
  kind: "process" | "service";
  name: string;
  /** Which checkbox column moved: Monitor or Map. */
  surface: "monitor" | "map";
  action: "added" | "removed";
}

export interface PinChangeOutcome {
  changed: boolean;
  /** Auto rule names created for a first-time pin. */
  createdRules: string[];
  /** Auto rule names that gained an asset (consolidation). */
  updatedRules: string[];
  /** Auto rule names that lost this asset on an unpin. */
  trimmedRules: string[];
  /** Auto rule names deleted because the unpin removed their last asset. */
  prunedRules: string[];
  /** Additions that could not be recorded (rule/asset caps). The direct pin on
   *  the asset still stands — only the future-assets bookkeeping is skipped. */
  skipped: number;
  /** Ids of rules to re-apply inline (so a map pin's implied monitor pin lands
   *  now rather than on the next reconcile tick). */
  touchedRuleIds: string[];
}

/** True when `rule` is the machine-managed single-item auto rule for
 *  (kind, name, mode) — the only shape consolidation ever adds assets to. */
function isSingleItemAutoRule(
  rule: AppMapRule,
  kind: "process" | "service",
  name: string,
  mode: AppMapRuleMode,
): boolean {
  if (rule.source !== "auto" || rule.mode !== mode) return false;
  const mine = kind === "process" ? rule.processes : rule.services;
  const other = kind === "process" ? rule.services : rule.processes;
  return (
    mine.names.length === 1 && mine.names[0] === name && mine.patterns.length === 0 &&
    other.names.length === 0 && other.patterns.length === 0
  );
}

/** "Auto: <item>" (+ " (monitor)" for monitor-only), truncated to the name cap
 *  and disambiguated with a counter if an operator already used the name. */
function uniqueAutoRuleName(takenLower: Set<string>, itemName: string, mode: AppMapRuleMode): string {
  const suffix = mode === "monitor" ? " (monitor)" : "";
  for (let n = 1; ; n++) {
    const counter = n === 1 ? "" : ` ${n}`;
    const budget = MAX_NAME_LEN - "Auto: ".length - suffix.length - counter.length;
    const item = itemName.length > budget ? itemName.slice(0, Math.max(1, budget - 1)) + "…" : itemName;
    const candidate = `Auto: ${item}${suffix}${counter}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Fold a batch of operator pin flips into the rule set. PURE (mutates only the
 * passed cfg): no DB, no I/O — recordOperatorPinChanges owns persistence.
 *
 * Adds consolidate: the first pin of an item mints a single-item AUTO rule
 * targeting just that asset; pinning the same item on another asset adds that
 * asset to the existing auto rule's assetIds. MANUAL rules are never candidates —
 * an operator-authored rule keeps exactly the shape its author gave it.
 *
 * Removes are the mirror image, auto rules only: the asset comes off every auto
 * rule pinning that item on the matching surface, and an auto rule that loses its
 * LAST asset is deleted — it must never survive as {scope:null, assetIds:[]},
 * which would read as "every monitored asset". (Un-ticking a box on a host inside
 * a MANUAL rule's scope keeps today's behavior: the reconcile re-pins it, because
 * the rule says so.)
 */
export function applyPinChangesToConfig(
  cfg: AppMapAutoMapConfig,
  changes: OperatorPinChange[],
): PinChangeOutcome {
  const out: PinChangeOutcome = {
    changed: false, createdRules: [], updatedRules: [], trimmedRules: [],
    prunedRules: [], skipped: 0, touchedRuleIds: [],
  };
  const touch = (id: string) => { if (!out.touchedRuleIds.includes(id)) out.touchedRuleIds.push(id); };

  for (const c of changes) {
    const mode: AppMapRuleMode = c.surface === "map" ? "map" : "monitor";

    if (c.action === "added") {
      const hit = cfg.rules.find((r) => isSingleItemAutoRule(r, c.kind, c.name, mode));
      if (hit) {
        if (!hit.assetIds.includes(c.assetId)) {
          if (hit.assetIds.length >= MAX_ASSET_IDS) { out.skipped += 1; continue; }
          hit.assetIds.push(c.assetId);
          out.changed = true;
          out.updatedRules.push(hit.name);
          touch(hit.id);
        }
        continue;
      }
      if (cfg.rules.length >= MAX_RULES) { out.skipped += 1; continue; }
      const taken = new Set(cfg.rules.map((r) => r.name.toLowerCase()));
      const block: AutoMapNameBlock = { names: [c.name], patterns: [], regex: false };
      const rule: AppMapRule = {
        id: randomUUID(),
        name: uniqueAutoRuleName(taken, c.name, mode),
        enabled: true,
        mode,
        source: "auto",
        scope: null,
        assetIds: [c.assetId],
        processes: c.kind === "process" ? block : emptyBlock(),
        services:  c.kind === "service" ? block : emptyBlock(),
      };
      cfg.rules.push(rule);
      out.changed = true;
      out.createdRules.push(rule.name);
      touch(rule.id);
      continue;
    }

    // action === "removed"
    const survivors: AppMapRule[] = [];
    for (const r of cfg.rules) {
      const block = c.kind === "process" ? r.processes : r.services;
      const applies = r.source === "auto" && r.mode === mode &&
        block.names.includes(c.name) && r.assetIds.includes(c.assetId);
      if (!applies) { survivors.push(r); continue; }
      r.assetIds = r.assetIds.filter((id) => id !== c.assetId);
      out.changed = true;
      if (r.assetIds.length === 0 && !r.scope) {
        out.prunedRules.push(r.name);
        continue; // dropped — see the doc comment on why it must not survive
      }
      out.trimmedRules.push(r.name);
      survivors.push(r);
    }
    cfg.rules = survivors;
  }
  return out;
}

// Read-modify-write of the Setting row is not atomic, so concurrent checkbox
// flips (two operators, two tabs) could lose one another's bookkeeping. Browser
// PUTs all land on the web role, so an in-process chain is a sufficient lock.
let pinChangeChain: Promise<unknown> = Promise.resolve();

/**
 * The assets-PUT hook: record operator pin flips as auto rules. Never throws —
 * the pin itself already landed on the asset row, and rule bookkeeping must not
 * fail the operator's save. Returns the outcome (null when nothing changed) so
 * the route can log the audit Event.
 */
export async function recordOperatorPinChanges(
  changes: OperatorPinChange[],
): Promise<PinChangeOutcome | null> {
  const valid = changes.filter((c) => c.assetId && c.name);
  if (valid.length === 0) return null;
  const run = pinChangeChain.then(async () => {
    const cfg = await getConfig();
    const outcome = applyPinChangesToConfig(cfg, valid);
    if (!outcome.changed) return null;
    await saveConfig(cfg);
    // Re-apply only the touched rules inline so a map pin's implied monitor pin
    // lands now; assets discovered later still ride the reconcile tick.
    const touched = cfg.rules.filter((r) => outcome.touchedRuleIds.includes(r.id));
    if (touched.length > 0) await applyRules(touched);
    return outcome;
  });
  pinChangeChain = run.catch(() => undefined); // keep the chain alive after a failure
  return run;
}

/** Hostname (or IP, or id) per explicitly-targeted asset, for rendering an auto
 *  rule's Devices cell — one bounded query across every rule's assetIds. */
export async function resolveRuleAssetLabels(cfg: AppMapAutoMapConfig): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const r of cfg.rules) for (const id of r.assetIds) ids.add(id);
  if (ids.size === 0) return {};
  const rows = await prisma.asset.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, hostname: true, ipAddress: true },
  });
  const out: Record<string, string> = {};
  for (const row of rows) out[row.id] = row.hostname || row.ipAddress || row.id;
  return out;
}

// ─── Reconcile entry point (periodic job + inline on save) ──────────────────

export interface AutoMapReconcileSummary extends Record<string, unknown> {
  devices: number;
  processPins: number;
  servicePins: number;
}

/** Re-apply every enabled rule. The "future assets" mechanism: a host that
 *  installs an agent and reports its inventory picks up its pins on the next
 *  tick. No-op (and silent) when nothing is configured or nothing is missing. */
export async function reconcileAutoMap(): Promise<AutoMapReconcileSummary> {
  const cfg = await getConfig();
  const r = await applyRules(cfg.rules);
  return { devices: r.devices, processPins: r.processPins, servicePins: r.servicePins };
}
