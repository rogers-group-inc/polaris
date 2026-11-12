/**
 * src/services/downDetectionService.ts
 *
 * WHO DECIDES A DEVICE IS DOWN.
 *
 * Down used to be a Monitor Settings value: `recordProbeResult` compared
 * consecutiveFailures against a `failureThreshold` resolved through the
 * (integration, assetType) tier hierarchy. That put the number that decides an
 * outage in a settings card scoped by integration and asset type, while the
 * thing operators think of as "my down alert" — the automation, with its device
 * filter — could not touch it.
 *
 * Now the AUTOMATION owns it. A `monitorStatus == down` automation carries a
 * `missedPolls` count, and that count is what the probe loop compares against
 * for every device the automation covers. Which automation covers a device when
 * several match is decided by the SAME most-specific-wins ladder that already
 * governs alerting (business rule 18, `scopeRank`) — deliberately not a second
 * precedence system, because two rules that disagreed would be unexplainable.
 *
 * An asset covered by NO down-detection automation has no threshold at all:
 * `resolveDownThreshold` answers null and the asset reads "passive". It is
 * still polled and still charted — Polaris simply renders no verdict about a
 * device nobody asked it to judge.
 *
 * HOT PATH. `resolveDownThreshold` is called once per probe per asset — 2000
 * assets on a 60s cadence — so it must never query. It reads ONE Map built by
 * a snapshot that is rebuilt at most once per TTL (plus once per rule write),
 * and `createTtlCache` makes an in-flight build count as fresh, so a cold start
 * under 2000 concurrent probes performs exactly one build rather than 2000.
 *
 * Staleness contract:
 *  - RULE edits invalidate explicitly (notificationRuleService CRUD).
 *  - ASSET drift (a tag added, a type corrected, an asset moved between
 *    integrations) is covered by the TTL alone. Instrumenting every asset
 *    writer is not viable — discoveryEngine alone has dozens of write sites —
 *    and one TTL is less than one probe cycle, so the worst case is a
 *    stale-but-valid threshold for under a minute.
 *  - A brand-new asset, the one case where staleness could produce a WRONG
 *    verdict rather than a stale one, is exact: `fallback` answers from the
 *    all-assets rule, which covers any asset by definition.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { logEvent } from "./eventLogService.js";
import {
  DEFAULT_MISSED_POLLS,
  downRecoverySustainSec,
  downRecoveryPolls,
  isDownDetectionTrigger,
  scopeRank,
  deviceFilterMatch,
  DEVICE_FILTER_DIMENSIONS,
  scopeMatchesAsset,
  type ScopeAsset,
  SEVERITIES,
  type Trigger,
  type RuleScope,
} from "./notificationTypes.js";
import { decorateRelationLeafHits } from "./scopeRelationIndex.js";
import {
  recordDownDetectionBuild,
  setDownDetectionAssets,
  recordDownDetectionUnavailable,
} from "../metrics.js";

export { DEFAULT_MISSED_POLLS,  };

/**
 * How long a snapshot is served before a rebuild. Exported so tests can reason
 * about it; keep it between 30s and 120s — below that the rebuild cost stops
 * amortizing across a probe cycle, above it this becomes the only mechanism
 * catching asset scope drift and the window gets uncomfortable.
 */
export const DOWN_DETECTION_TTL_MS = 60_000;

/** The winning automation for one asset. */
export interface DownWinner {
  threshold: number;
  /**
   * The automation's reset sustain in SECONDS, or null when it neither resets
   * automatically nor asks for a hold.
   *
   * On a down-detection automation this is not only the alert's clock:
   * `recordProbeResult` converts it to a poll count at the asset's own cadence
   * and holds the asset in `recovering` until that many probes have answered,
   * so the automation owns the way back UP as well as the way down. Seconds
   * rather than polls because seconds are what the column stores — the wizard
   * collects polls and multiplies by the cadence it read at authoring time, and
   * converting back at probe time rather than trusting that frozen arithmetic
   * is what keeps the count honest after someone changes the interval.
   */
  recoverySustainSec: number | null;
  /** The same hold as the operator's own COUNT, when the reset states one —
   *  preferred over the seconds, which only round back to it while the cadence
   *  is the one they authored against. */
  recoverySustainPolls: number | null;
  /**
   * The covering automation's own severity — what the operator said this
   * outage is WORTH. Every surface that paints `down` reads it, so a device
   * governed by a `warning`-severity automation reads Down in that automation's
   * amber rather than in a red the operator never asked for. Not a threshold
   * input: it changes no verdict, only how the verdict is drawn.
   */
  severity: string;
  ruleId: string;
  ruleName: string;
  rank: number;
}

/** Two equally-specific automations asking for different counts on one asset. */
export interface DownConflict {
  assetId: string;
  hostname: string | null;
  ruleIds: string[];
  counts: number[];
  chosen: number;
}

/** A down-detection automation, pre-digested for the per-asset walk. */
export interface DownRule {
  id: string;
  name: string;
  createdAt: Date;
  scope: RuleScope;
  rank: number;
  threshold: number;
  recoverySustainSec: number | null;
  recoverySustainPolls: number | null;
  severity: string;
  dimensionFilter: Parameters<typeof deviceFilterMatch>[0];
}

interface DownDetectionIndex {
  builtAt: number;
  /** assetId → resolved winner. Absent ⇒ passive, subject to `fallback`. */
  byAsset: Map<string, DownWinner>;
  /** Winner among rules covering EVERY asset — answers for assets discovered
   *  since the last rebuild. */
  fallback: DownWinner | null;
  ruleCount: number;
  assetCount: number;
  conflicts: DownConflict[];
}

const EMPTY_INDEX: DownDetectionIndex = {
  builtAt: 0,
  byAsset: new Map(),
  fallback: null,
  ruleCount: 0,
  assetCount: 0,
  conflicts: [],
};

/** Cap on the conflicts carried on a snapshot — one bad config must not pin
 *  2000 rows in memory or write 2000 log lines. */
const MAX_CONFLICTS = 50;

const cache = createTtlCache<DownDetectionIndex>({ ttlMs: DOWN_DETECTION_TTL_MS, maxEntries: 1 });
const CACHE_KEY = "";

/** The last snapshot that built successfully — the mat under a failed rebuild,
 *  deliberately NOT cleared by invalidate(). */
let lastGoodIndex: DownDetectionIndex | null = null;

/** Whether the previous build saw zero down-detection automations, so the
 *  "nothing is being judged" Event fires on the TRANSITION rather than every
 *  rebuild. null = we have not built yet. */
let lastRuleCountWasZero: boolean | null = null;

/**
 * The asset columns the three coverage predicates read: scopeMatchesAsset,
 * evaluateScopeCondition (via the condition tree) and deviceFilterMatch.
 *
 * Deliberately NOT the engine's SCOPE_SELECT — that one also pulls
 * monitoredInterfaces / monitoredIpsecTunnels / monitoredStorage, array columns
 * this resolver never reads and which dominate the row size at 2000 assets.
 */
const DOWN_SCOPE_SELECT = {
  id: true,
  // NOTE: `interfaces` is deliberately absent even though the condition tree can
  // read it — decorateRelationLeafHits resolves those leaves in SQL instead.
  // See scopeInterfaceIndex.ts.
  hostname: true,
  assetType: true,
  tags: true,
  discoveredByIntegrationId: true,
  manufacturer: true,
  model: true,
  os: true,
  ipAddress: true,
  macAddress: true,
  status: true,
} as const;

/** Does a rule's device filter constrain anything at all? */
function filterIsActive(df: Parameters<typeof deviceFilterMatch>[0]): boolean {
  if (!df) return false;
  const rec = df as Record<string, string | undefined>;
  return DEVICE_FILTER_DIMENSIONS.some((d) => rec[d]);
}

/** Does this rule cover this asset — scope AND device filter? */
function ruleCoversAsset(rule: DownRule, asset: ScopeAsset): boolean {
  if (!scopeMatchesAsset(rule.scope, asset)) return false;
  if (!filterIsActive(rule.dimensionFilter)) return true;
  return deviceFilterMatch(rule.dimensionFilter, asset);
}

/**
 * Pick the automation that governs one asset. Pure — no DB, no cache — so the
 * precedence rules are unit-testable in isolation.
 *
 * Most specific wins (scopeRank). On a TIE, in order:
 *
 *  1. the SMALLER count wins. Two reasons. It matches the convention this
 *     codebase already settled on for the same shape of ambiguity —
 *     getMetricSeverityTiers resolves competing thresholds at one severity by
 *     taking the more sensitive, "that's where that severity first appears".
 *     And it is the safe direction for a monitoring product: choosing the
 *     larger count would silently withhold an outage the operator asked to hear
 *     about in 2 polls for 10, whereas choosing the smaller costs at most an
 *     early alert. Note both tied automations still FIRE (rule 18 leaves
 *     same-rank ties alone), so taking the smaller also means neither ever
 *     fires later than its own configuration promised.
 *  2. the older `createdAt`, then 3. the lower `id`. These only matter when the
 *     counts are equal — the threshold is then identical and the tiebreak
 *     exists solely to give the winner a stable IDENTITY for the "why is this
 *     asset's threshold N?" diagnostic. Both are immutable, so two Polaris
 *     processes never disagree.
 */
export function pickDownWinner(rules: DownRule[], asset: ScopeAsset, sink?: DownConflict[]): DownWinner | null {
  let best: DownRule | null = null;
  let tied: DownRule[] = [];

  for (const r of rules) {
    if (!ruleCoversAsset(r, asset)) continue;
    if (!best) {
      best = r;
      tied = [];
      continue;
    }
    if (r.rank > best.rank) {
      best = r;
      tied = [];
      continue;
    }
    if (r.rank < best.rank) continue;

    // Same rank — record the peer, then apply the tiebreak ladder.
    tied.push(best);
    if (r.threshold !== best.threshold) {
      if (r.threshold < best.threshold) best = r;
    } else if (r.createdAt.getTime() !== best.createdAt.getTime()) {
      if (r.createdAt.getTime() < best.createdAt.getTime()) best = r;
    } else if (r.id < best.id) {
      best = r;
    }
  }

  if (!best) return null;

  const winner = best;
  if (sink && sink.length < MAX_CONFLICTS) {
    const disagreeing = tied.filter((o) => o.threshold !== winner.threshold);
    if (disagreeing.length) {
      sink.push({
        assetId: asset.id,
        hostname: asset.hostname ?? null,
        ruleIds: [winner.id, ...disagreeing.map((o) => o.id)],
        counts: [winner.threshold, ...disagreeing.map((o) => o.threshold)],
        chosen: winner.threshold,
      });
    }
  }

  return {
    threshold: winner.threshold,
    recoverySustainSec: winner.recoverySustainSec,
    recoverySustainPolls: winner.recoverySustainPolls,
    severity: winner.severity,
    ruleId: winner.id,
    ruleName: winner.name,
    rank: winner.rank,
  };
}

/** Digest a stored rule row into the shape the per-asset walk wants. */
function toDownRule(row: {
  id: string;
  name: string;
  createdAt: Date;
  trigger: unknown;
  scope: unknown;
  reset?: unknown;
  severity?: unknown;
}): DownRule | null {
  const trigger = row.trigger as unknown as Trigger;
  if (!trigger || !isDownDetectionTrigger(trigger)) return null;
  const scope = (row.scope ?? {}) as RuleScope;
  const missed = (trigger as { missedPolls?: number }).missedPolls;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    scope,
    rank: scopeRank(scope),
    // A rule authored before the count existed still governs its devices — at
    // the number that was in force when it was written.
    threshold: typeof missed === "number" && missed > 0 ? missed : DEFAULT_MISSED_POLLS,
    recoverySustainSec: downRecoverySustainSec(row.reset),
    // The count as STATED, when the reset states one — recoveryPollsFor prefers
    // it over dividing the seconds mirror by a cadence that may have moved.
    recoverySustainPolls: downRecoveryPolls(row.reset),
    // Unrecognized or absent normalizes to `critical` — the colour Down has
    // always been drawn in, so an automation predating the severity read, or
    // one carrying a value this build does not know, changes nothing.
    severity: typeof row.severity === "string" && SEVERITIES.includes(row.severity as (typeof SEVERITIES)[number])
      ? row.severity
      : "critical",
    dimensionFilter: (trigger as { dimensionFilter?: Parameters<typeof deviceFilterMatch>[0] }).dimensionFilter,
  };
}

/** The best rule that covers EVERY asset — no scope narrowing, no filter. */
function pickFallback(rules: DownRule[]): DownWinner | null {
  const universal = rules.filter((r) => r.scope.allAssets === true && !filterIsActive(r.dimensionFilter));
  if (!universal.length) return null;
  // Same ladder; every candidate is rank 0 so this is the tie path.
  const pseudo: ScopeAsset = { id: "", assetType: null, tags: [], discoveredByIntegrationId: null };
  return pickDownWinner(universal, pseudo);
}

async function buildDownDetectionIndex(): Promise<DownDetectionIndex> {
  const startedAt = Date.now();

  // Query 1 — the rule set. Small table by nature (tens of rows). `reset` rides
  // along because on a down automation the reset sustain is the RECOVERY count
  // as well as the alert's clock — see DownWinner.recoverySustainSec.
  const rows = await prisma.notificationRule.findMany({
    where: { enabled: true },
    // `severity` rides along for the same reason `reset` does: on a down
    // automation it is not only the alert's severity, it is the colour every
    // surface paints the resulting `down` state in (business rule 36).
    select: { id: true, name: true, createdAt: true, trigger: true, scope: true, reset: true, severity: true },
  });
  const rules = rows.map(toDownRule).filter((r): r is DownRule => r !== null);

  // Query 2 — the fleet. Only monitored assets: recordProbeResult is the sole
  // consumer of byAsset and never runs for the rest.
  const assets = await prisma.asset.findMany({
    where: { monitored: true },
    select: DOWN_SCOPE_SELECT,
  });

  // Query 3 (only if some down automation filters by interface) — the one
  // condition field backed by a relation, resolved to per-asset verdicts rather
  // than joined onto DOWN_SCOPE_SELECT. Which asset each automation covers
  // decides what "down" MEANS for it (business rule 36), so an unresolved leaf
  // would leave devices reading passive.
  await decorateRelationLeafHits(assets, rules.map((r) => r.scope?.condition));

  const byAsset = new Map<string, DownWinner>();
  const conflicts: DownConflict[] = [];
  if (rules.length) {
    for (const a of assets) {
      const w = pickDownWinner(rules, a as ScopeAsset, conflicts);
      if (w) byAsset.set(a.id, w);
    }
  }

  const index: DownDetectionIndex = {
    builtAt: Date.now(),
    byAsset,
    fallback: pickFallback(rules),
    ruleCount: rules.length,
    assetCount: assets.length,
    conflicts,
  };

  recordDownDetectionBuild((Date.now() - startedAt) / 1000);
  setDownDetectionAssets(byAsset.size, assets.length - byAsset.size);
  reportBuild(index);
  return index;
}

/** Log + audit what the freshly-built snapshot says, without spamming. */
function reportBuild(index: DownDetectionIndex): void {
  // One warn per rebuild summarizing the DISTINCT conflicting rule pairs — not
  // one per asset, or a single bad config would print thousands of lines.
  if (index.conflicts.length) {
    const pairs = new Map<string, { ruleIds: string[]; counts: number[]; chosen: number; assets: number }>();
    for (const c of index.conflicts) {
      const key = c.ruleIds.slice().sort().join("|");
      const e = pairs.get(key);
      if (e) e.assets++;
      else pairs.set(key, { ruleIds: c.ruleIds, counts: c.counts, chosen: c.chosen, assets: 1 });
    }
    logger.warn(
      { pairs: Array.from(pairs.values()), truncated: index.conflicts.length >= MAX_CONFLICTS },
      "down detection: equally-specific automations disagree on the missed-poll count — using the smaller (more sensitive) value",
    );
  }

  // A fleet with NO down-detection automation is judged by nothing, and the
  // thing that would normally alert about that is exactly what was deleted. Fire
  // on the TRANSITION into that state so it is in the audit trail once, rather
  // than every 60s forever.
  const isZero = index.ruleCount === 0;
  if (isZero !== lastRuleCountWasZero) {
    if (isZero && index.assetCount > 0) {
      logger.warn(
        { monitoredAssets: index.assetCount },
        "down detection: no enabled automation defines down — every monitored asset is passive",
      );
      void logEvent({
        action: "monitor.down_detection_absent",
        level: "warning",
        resourceType: "monitor_settings",
        resourceName: "Down detection",
        actor: "system:down-detection",
        message: `No enabled automation defines when a device is down, so all ${index.assetCount} monitored device(s) are Passive — Polaris is recording their polls but will not declare any of them down.`,
        details: { monitoredAssets: index.assetCount },
      });
    } else if (!isZero && lastRuleCountWasZero === true) {
      void logEvent({
        action: "monitor.down_detection_restored",
        level: "info",
        resourceType: "monitor_settings",
        resourceName: "Down detection",
        actor: "system:down-detection",
        message: `Down detection is active again (${index.ruleCount} automation(s) define it).`,
        details: { ruleCount: index.ruleCount },
      });
    }
    lastRuleCountWasZero = isZero;
  }
}

async function getIndex(): Promise<DownDetectionIndex> {
  try {
    const idx = await cache.getOrCompute(CACHE_KEY, buildDownDetectionIndex);
    lastGoodIndex = idx;
    return idx;
  } catch (err) {
    if (lastGoodIndex) {
      logger.warn(
        { err, ageMs: Date.now() - lastGoodIndex.builtAt },
        "down-detection index rebuild failed — serving the last good snapshot",
      );
      return lastGoodIndex;
    }
    // No snapshot at all: render NO verdict rather than invent one. Every asset
    // reads passive, samples and counters still land, and it self-heals on the
    // next probe because createTtlCache never caches a rejection.
    logger.warn({ err }, "down-detection index unavailable — treating all assets as passive this tick");
    recordDownDetectionUnavailable();
    return EMPTY_INDEX;
  }
}

/** What the covering automation says about one asset, both directions. */
export interface DownDetectionVerdict {
  /** Missed polls before the asset reads `down`. */
  threshold: number;
  /** The reset sustain in seconds, or null — see DownWinner. */
  recoverySustainSec: number | null;
  /** The same hold as the operator's own COUNT, when the reset states one. */
  recoverySustainPolls: number | null;
  /** The covering automation's severity — the colour `down` is drawn in. */
  severity: string;
}

/**
 * The covering automation's verdict for one asset, or null when none covers it
 * (= passive). ONE Map lookup in the steady state.
 */
export async function resolveDownDetection(assetId: string): Promise<DownDetectionVerdict | null> {
  const idx = await getIndex();
  const hit = idx.byAsset.get(assetId) ?? idx.fallback;
  // Absent from the snapshot: either genuinely uncovered, or discovered since
  // the last rebuild. An all-assets automation covers ANY asset by definition,
  // so answering from the fallback is exact and can never over-claim — a
  // narrower rule could only raise the specificity, and it converges within one
  // TTL.
  if (!hit) return null;
  return {
    threshold: hit.threshold,
    recoverySustainSec: hit.recoverySustainSec,
    recoverySustainPolls: hit.recoverySustainPolls,
    severity: hit.severity,
  };
}

/**
 * The asset's missed-poll threshold alone, or null when no automation covers
 * it. Kept as its own export because most callers only ask the down question;
 * `resolveDownDetection` is the one the probe loop wants.
 */
export async function resolveDownThreshold(assetId: string): Promise<number | null> {
  return (await resolveDownDetection(assetId))?.threshold ?? null;
}

/**
 * How many probes must ANSWER before an asset governed by this verdict reads
 * `up` again, at the cadence it is actually polled at.
 *
 * The floor is the missed-poll count itself: the leaky bucket has to drain
 * whatever debt it accumulated, so a deep outage always costs at least that
 * many answers regardless of what the reset asks for (business rule 30). The
 * reset only ever RAISES the bar — an automation that resets immediately, or
 * one with no auto reset at all, keeps exactly the pre-2026-08-29 behavior.
 *
 * Pure, and deliberately not memoized: it is two arithmetic ops on a value the
 * probe path already has in hand.
 */
export function recoveryPollsFor(verdict: DownDetectionVerdict, intervalSec: number): number {
  const { threshold, recoverySustainSec, recoverySustainPolls } = verdict;
  // A stated COUNT needs no conversion at all — it is already the answer, and
  // it survives a cadence change that the division below would silently absorb.
  if (recoverySustainPolls && recoverySustainPolls > 0) return Math.min(100, Math.max(threshold, Math.round(recoverySustainPolls)));
  if (!recoverySustainSec || !Number.isFinite(intervalSec) || intervalSec <= 0) return threshold;
  // Round rather than ceil: the wizard produced these seconds by MULTIPLYING a
  // whole number of polls by the same cadence, so rounding returns the operator
  // their own number, while ceil would turn a 5-poll reset into 6 the moment a
  // cadence lands on a value that does not divide evenly.
  const polls = Math.round(recoverySustainSec / intervalSec);
  // Cap at the same ceiling the missed-poll count carries (notificationTypes'
  // `missedPolls` max), so a 24h sustain against a 30s cadence cannot park an
  // asset in `recovering` for 2880 probes.
  return Math.min(100, Math.max(threshold, polls));
}

/** Diagnostics for one asset: who governs it, at what count, and whether an
 *  equally-specific automation disagrees. Not the hot path — the asset modal
 *  and the effective-settings endpoint. */
export async function describeDownDetectionFor(assetId: string): Promise<{
  passive: boolean;
  winner: DownWinner | null;
  viaFallback: boolean;
  conflict: DownConflict | null;
} | null> {
  const idx = await getIndex();
  const hit = idx.byAsset.get(assetId) ?? null;
  const winner = hit ?? idx.fallback;
  return {
    passive: winner === null,
    winner,
    viaFallback: hit === null && idx.fallback !== null,
    conflict: idx.conflicts.find((c) => c.assetId === assetId) ?? null,
  };
}

/**
 * What happens to down detection if this automation goes away — the answer the
 * delete/disable confirmation needs.
 *
 * Deleting the last automation covering a device makes it PASSIVE: Polaris
 * keeps polling it and never declares it down again. That is a legitimate
 * choice, but it must be a deliberate one, and it is exactly the change nothing
 * else can warn about — the thing that would normally alert about a blind fleet
 * is the automation being deleted.
 *
 * Answers three numbers: how many devices this rule currently GOVERNS, how many
 * would fall through to a broader automation (fine), and how many would be left
 * with nothing at all (the number worth a confirmation).
 *
 * Deliberately builds its own view rather than reading the cached snapshot's
 * winners: "who would win INSTEAD" is a different question from "who wins", and
 * it only runs when an operator opens a confirm dialog.
 */
export async function previewDownDetectionRemoval(ruleId: string): Promise<{
  isDownDetection: boolean;
  governs: number;
  wouldFallBackToAnother: number;
  wouldBecomePassive: number;
  sampleHostnames: string[];
}> {
  const empty = { isDownDetection: false, governs: 0, wouldFallBackToAnother: 0, wouldBecomePassive: 0, sampleHostnames: [] };

  const rows = await prisma.notificationRule.findMany({
    where: { enabled: true },
    select: { id: true, name: true, createdAt: true, trigger: true, scope: true },
  });
  const rules = rows.map(toDownRule).filter((r): r is DownRule => r !== null);
  if (!rules.some((r) => r.id === ruleId)) return empty;

  const survivors = rules.filter((r) => r.id !== ruleId);
  const assets = await prisma.asset.findMany({ where: { monitored: true }, select: DOWN_SCOPE_SELECT });

  let governs = 0;
  let fallback = 0;
  let passive = 0;
  const samples: string[] = [];
  for (const a of assets) {
    const before = pickDownWinner(rules, a as ScopeAsset);
    if (!before || before.ruleId !== ruleId) continue;
    governs += 1;
    if (pickDownWinner(survivors, a as ScopeAsset)) fallback += 1;
    else {
      passive += 1;
      if (samples.length < 5) samples.push(a.hostname ?? a.id);
    }
  }
  return { isDownDetection: true, governs, wouldFallBackToAnother: fallback, wouldBecomePassive: passive, sampleHostnames: samples };
}

/**
 * Drop the snapshot so the next resolve rebuilds. Called unconditionally from
 * rule create/update/delete — an update can turn a rule INTO or OUT of a
 * down-detection rule, so gating on "was it one?" would be a bug waiting to
 * happen. Deliberately leaves `lastGoodIndex` alone: that is the crash mat, not
 * the answer.
 */
export function invalidateDownDetectionCache(): void {
  cache.invalidate();
}

/** Test seam — forget the crash mat and the transition state too. */
export function resetDownDetectionStateForTests(): void {
  cache.invalidate();
  lastGoodIndex = null;
  lastRuleCountWasZero = null;
}
