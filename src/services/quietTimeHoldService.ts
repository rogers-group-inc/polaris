/**
 * src/services/quietTimeHoldService.ts
 *
 * THE quiet-time decision (business rule 92): is this alert, at this instant,
 * inside a quiet window that holds its people-facing sends — and if so, whose
 * window, and when does it end?
 *
 * Two kinds of source answer it, in a fixed order:
 *
 *   1. The automation's OWN `quietTime`. When an automation carries one it is
 *      the only candidate: its windows and severities decide, and every global
 *      schedule is ignored for that automation whatever they say. ("Quiet
 *      times in an automation override the global quiet times" — the
 *      operator's words, 2026-10-03.) The column may instead hold the
 *      exemption marker `{ignoreGlobal: true}` — the step's "Ignore Global
 *      Quiet Time" setting — which is the answer "never quiet" for that
 *      automation. An automation whose own quiet time does
 *      not match right now is therefore NOT quiet, even inside a global window.
 *   2. The enabled `QuietTimeSchedule` rows, oldest first, for an automation
 *      with no quiet time of its own: a schedule holds the alert when its
 *      window is open, its severities include the alert's, its alert kinds
 *      include the alert's metric (or say "any"), and its scope selects the
 *      device (an unconstrained scope selects every device; an alert with no
 *      device — a host metric, a system event — is selected only by one).
 *
 * The answer is a property of (source config, severity, metric, asset, now),
 * so callers that ask many times in one pass — the escalation sweep over
 * hundreds of live alerts — hand in a `QuietHoldMemo` and the recurrence is
 * evaluated once per distinct question. The configs themselves sit in a
 * short-TTL cache that every schedule and rule write bumps (`bumpQuietTimeCache`),
 * so a fresh window is honoured on the next fire, not in fifteen seconds.
 *
 * What this module does NOT do: it never writes. Holding a send, stamping the
 * alert and sending the summary belong to automationActionService,
 * notificationRecipientService and quietTimeSummaryService.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { logger } from "../utils/logger.js";
import {
  quietTimeConfigSchema,
  isIgnoreGlobalQuietTime,
  quietWindowNow,
  quietResumesAt,
  quietHoldsKind,
  quietHoldsSend,
  type QuietSend,
  type QuietTimeConfig,
} from "../utils/quietTime.js";
import {
  scopeSchema,
  scopeIsUnconstrained,
  scopeMatchesAsset,
  type RuleScope,
  type ScopeAsset,
} from "./notificationTypes.js";
import { decorateRelationLeafHits } from "./scopeRelationIndex.js";

export type QuietSourceKind = "automation" | "global";

export interface QuietSource {
  kind: QuietSourceKind;
  id: string;
  name: string;
}

export interface QuietHold {
  source: QuietSource;
  config: QuietTimeConfig;
  /** When the whole quiet stretch containing `now` ends (abutting windows chained). */
  windowEnd: Date;
}

interface GlobalSchedule {
  id: string;
  name: string;
  scope: RuleScope;
  config: QuietTimeConfig;
  createdAt: Date;
}

interface RuleQuiet {
  id: string;
  name: string;
  /** The automation's own policy — or null for "no quiet time at all" (`{ignoreGlobal: true}`). */
  config: QuietTimeConfig | null;
}

interface QuietCatalog {
  schedules: GlobalSchedule[];
  /** ruleId → the automation's own setting. Only rules that said SOMETHING —
   *  a policy or the exemption; either way the global schedules stand aside. */
  rules: Map<string, RuleQuiet>;
}

// 15 s: long enough that a 60 s sweep and a burst of fires share one read,
// short enough that a save the bump somehow missed is honoured within a tick.
const CATALOG_TTL_MS = 15_000;
const _catalog = createTtlCache<QuietCatalog>({ ttlMs: CATALOG_TTL_MS, maxEntries: 1 });

/** Drop the cached schedules + rule configs. Called by every schedule and rule write. */
export function bumpQuietTimeCache(): void {
  _catalog.invalidate();
}

/** A stored config, or null when it no longer parses (hand-edited row). A bad
 *  blob fails toward "not quiet" — the loud direction, exactly as rule 44 did. */
export function parseQuietTimeConfig(raw: unknown): QuietTimeConfig | null {
  if (raw == null) return null;
  const r = quietTimeConfigSchema.safeParse(raw);
  return r.success ? r.data : null;
}

function parseScope(raw: unknown): RuleScope {
  const r = scopeSchema.safeParse(raw ?? {});
  return r.success ? r.data : ({} as RuleScope);
}

const EMPTY_CATALOG: QuietCatalog = { schedules: [], rules: new Map() };

/**
 * The catalog, or an EMPTY one when it cannot be read. Failing toward "not
 * quiet" is the rule-44 posture carried forward: a database hiccup on the
 * alerting hot path must cost an operator one page too many, never an outage
 * nobody was told about. Logged at warn so the hiccup is still visible.
 */
async function loadCatalog(): Promise<QuietCatalog> {
  try {
    return await loadCatalogUncached();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "quiet-time catalog unreadable — treating every alert as not quiet");
    return EMPTY_CATALOG;
  }
}

async function loadCatalogUncached(): Promise<QuietCatalog> {
  return _catalog.getOrCompute("", async () => {
    const [schedRows, ruleRows] = await Promise.all([
      prisma.quietTimeSchedule.findMany({
        where: { enabled: true },
        select: { id: true, name: true, scope: true, quiet: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.notificationRule.findMany({
        where: { NOT: { quietTime: { equals: Prisma.AnyNull } } },
        select: { id: true, name: true, quietTime: true },
      }),
    ]);
    const schedules: GlobalSchedule[] = [];
    for (const s of schedRows) {
      const config = parseQuietTimeConfig(s.quiet);
      if (!config) {
        logger.warn({ scheduleId: s.id, name: s.name }, "quiet-time schedule has an unreadable config and is ignored");
        continue;
      }
      schedules.push({ id: s.id, name: s.name, scope: parseScope(s.scope), config, createdAt: s.createdAt });
    }
    const rules = new Map<string, RuleQuiet>();
    for (const r of ruleRows) {
      // The exemption marker is an answer too ("never quiet"); an unreadable
      // blob is not, and the global schedules apply to that rule as if the
      // column were null — the same direction a bad global config fails.
      if (isIgnoreGlobalQuietTime(r.quietTime)) { rules.set(r.id, { id: r.id, name: r.name, config: null }); continue; }
      const config = parseQuietTimeConfig(r.quietTime);
      if (config) rules.set(r.id, { id: r.id, name: r.name, config });
    }
    return { schedules, rules };
  });
}

/** The fields a global schedule's scope can ask about, as one asset read. The
 *  engine's SCOPE_SELECT carries polling state this decision never needs. */
const QUIET_SCOPE_SELECT = {
  id: true, assetType: true, tags: true, discoveredByIntegrationId: true,
  hostname: true, manufacturer: true, model: true, os: true, ipAddress: true,
  status: true, osVersion: true, department: true, location: true, learnedLocation: true,
} as const;

type QuietScopeRow = Prisma.AssetGetPayload<{ select: typeof QUIET_SCOPE_SELECT }>;

function toScopeAsset(row: QuietScopeRow): ScopeAsset {
  return { ...row, status: String(row.status) };
}

/**
 * Per-pass memo. `holds` keys the final answer; `assets` keys the device rows
 * already read (and decorated for the schedules' relation leaves) so a sweep
 * reads each device once however many alerts it carries.
 */
export interface QuietHoldMemo {
  holds: Map<string, QuietHold | null>;
  assets: Map<string, ScopeAsset | null>;
}

export function newQuietHoldMemo(): QuietHoldMemo {
  return { holds: new Map(), assets: new Map() };
}

async function scopeAssetFor(assetId: string, catalog: QuietCatalog, memo: QuietHoldMemo): Promise<ScopeAsset | null> {
  if (memo.assets.has(assetId)) return memo.assets.get(assetId)!;
  const row = await prisma.asset.findUnique({ where: { id: assetId }, select: QUIET_SCOPE_SELECT });
  const asset = row ? toScopeAsset(row) : null;
  if (asset) {
    // Relation-backed leaves (interfaceName / ssid / agentInstalled) resolve in
    // SQL onto the row; no schedule uses one ⇒ no query.
    await decorateRelationLeafHits([asset], catalog.schedules.map((s) => s.scope.condition));
  }
  memo.assets.set(assetId, asset);
  return asset;
}

/**
 * Pre-read the device rows a batch of alerts will ask about — the escalation
 * sweep calls this once with every live alert's asset so the per-alert
 * `resolveQuietHold` calls below hit the memo. A no-op when no global schedule
 * has a constrained scope, which is every install without one.
 */
export async function primeQuietHoldAssets(assetIds: Iterable<string>, memo: QuietHoldMemo): Promise<void> {
  const catalog = await loadCatalog();
  if (!catalog.schedules.some((s) => !scopeIsUnconstrained(s.scope))) return;
  const want = Array.from(new Set(assetIds)).filter((id) => !memo.assets.has(id));
  if (want.length === 0) return;
  const rows = await prisma.asset.findMany({ where: { id: { in: want } }, select: QUIET_SCOPE_SELECT });
  const assets = rows.map(toScopeAsset);
  await decorateRelationLeafHits(assets, catalog.schedules.map((s) => s.scope.condition));
  for (const id of want) memo.assets.set(id, null);
  for (const a of assets) memo.assets.set(a.id, a);
}

export interface QuietHoldQuestion {
  /** The automation that raised the alert; null for a rule-less alert (which no quiet time holds). */
  ruleId: string | null | undefined;
  /** The alert's CURRENT severity (band-resolved). */
  severity: string;
  /** Notification.metric — the kind of alert; null on event/change alerts. */
  metric: string | null | undefined;
  assetId: string | null | undefined;
  /**
   * What is about to be sent: `fire` (the first alert, or a grouped alert's
   * growth update), `reminder` (the repeat pass), `escalation` (a tier's first
   * run) or `escalationReminder` (a tier's repeat run). The policy says, per
   * severity, which of the four it holds (`heldKindsFor`). Default `fire`.
   */
  send?: QuietSend;
  now?: Date;
  memo?: QuietHoldMemo;
}

function holdFromConfig(source: QuietSource, config: QuietTimeConfig, severity: string, now: Date, send: QuietSend): QuietHold | null {
  if (!quietHoldsSend(config, severity, send)) return null;
  if (!quietWindowNow(config, now)) return null;
  const windowEnd = quietResumesAt(config, now);
  return windowEnd ? { source, config, windowEnd } : null;
}

/**
 * Is this alert quiet right now, and whose window holds it? See the module
 * header for the precedence. Null = not quiet: deliver as usual.
 */
export async function resolveQuietHold(q: QuietHoldQuestion): Promise<QuietHold | null> {
  if (!q.ruleId) return null;
  const now = q.now ?? new Date();
  const send = q.send ?? "fire";
  const memo = q.memo ?? newQuietHoldMemo();
  const key = `${send}|${q.ruleId}|${q.severity}|${q.metric ?? ""}|${q.assetId ?? ""}`;
  if (memo.holds.has(key)) return memo.holds.get(key)!;

  const catalog = await loadCatalog();
  let answer: QuietHold | null = null;

  const own = catalog.rules.get(q.ruleId);
  if (own) {
    // The automation's own setting is the whole answer, matching or not — and
    // "ignore the global quiet times" (config null) is the answer "never quiet".
    answer = own.config
      ? holdFromConfig({ kind: "automation", id: own.id, name: own.name }, own.config, q.severity, now, send)
      : null;
  } else {
    for (const s of catalog.schedules) {
      if (!quietHoldsKind(s.config, q.metric)) continue;
      // Severity + send kind, then the window. Scope last: it needs a device read.
      const hold = holdFromConfig({ kind: "global", id: s.id, name: s.name }, s.config, q.severity, now, send);
      if (!hold) continue;
      if (!scopeIsUnconstrained(s.scope)) {
        if (!q.assetId) continue;
        const asset = await scopeAssetFor(q.assetId, catalog, memo);
        if (!asset || !scopeMatchesAsset(s.scope, asset)) continue;
      }
      answer = hold;
      break;
    }
  }

  memo.holds.set(key, answer);
  return answer;
}

/**
 * A quiet source's current config and name, by the `{kind, id}` an alert was
 * stamped with — what the summary job reads to learn the send time, the
 * recurrence threshold and the channel. Reads the row directly rather than the
 * catalog: a DISABLED or deleted source still owes its summary, and the
 * catalog only knows enabled ones.
 */
export async function quietSourceConfig(
  source: { kind: QuietSourceKind; id: string },
): Promise<{ name: string; config: QuietTimeConfig; exists: boolean } | null> {
  if (source.kind === "global") {
    const row = await prisma.quietTimeSchedule.findUnique({ where: { id: source.id }, select: { name: true, quiet: true } });
    if (!row) return null;
    const config = parseQuietTimeConfig(row.quiet);
    return config ? { name: row.name, config, exists: true } : null;
  }
  const row = await prisma.notificationRule.findUnique({ where: { id: source.id }, select: { name: true, quietTime: true } });
  if (!row) return null;
  const config = parseQuietTimeConfig(row.quietTime);
  return config ? { name: row.name, config, exists: true } : null;
}
