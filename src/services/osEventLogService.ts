/**
 * src/services/osEventLogService.ts — OS event-log → audit Event ingest
 *
 * Transport-agnostic. Consumed by the agent `/samples` eventLog branch today
 * and (later phases) by the SSH / WinRM / FortiOS-REST pollers. Each incoming
 * OS event-log entry is curated into a normal audit `Event` row
 * (action `os_event.<channel>`, resourceType `asset`) so it shows up in the
 * asset Events tab AND rides the existing syslog/SFTP archival for free.
 *
 * Volume control (the audit table is NOT a hypertable): the agent already
 * filters by min-severity + dedupes + caps, but this layer defends in depth —
 * re-filters by min-level, collapses identical entries, applies a per-push cap,
 * and a per-asset hourly rate cap (overflow collapses into one
 * `os_event.suppressed` event). See polaris-agent -> cross-cutting-polaris-agent.md (OS event log).
 *
 * The pure helpers (mapOsLevelToAudit / dedupeEntries / sanitizeChannel /
 * buildAuditInputs) are exported for unit tests; ingestOsEventLog wires them to
 * the DB + the per-asset rate cap.
 */

import { prisma } from "../db.js";
import { logEventsBatch } from "./eventLogService.js";

/** Operator-tunable global config (Setting "agentEventLog"). */
export interface AgentEventLogConfig {
  /** Master opt-in. Default false — nothing collected until an operator enables it. */
  enabled: boolean;
  /** Minimum severity an entry must meet to be ingested. */
  minLevel: "info" | "warning" | "error";
  /** Windows channels the agent reads (delivered to the agent via /config). */
  windowsChannels: string[];
  /** Linux journald priority ceiling (0 emerg … 7 debug); entries with PRIORITY <= this are read. */
  linuxMinPriority: number;
  /** Max entries accepted per push (defense-in-depth on top of the agent cap). */
  maxPerPush: number;
  /** Max `os_event.*` audit rows written per asset per rolling hour. */
  perAssetHourlyCap: number;
}

const DEFAULT_AGENT_EVENT_LOG_CONFIG: AgentEventLogConfig = {
  enabled: false,
  minLevel: "error",
  windowsChannels: ["System", "Application"],
  linuxMinPriority: 3, // err
  maxPerPush: 100,
  perAssetHourlyCap: 500,
};

const SETTING_KEY = "agentEventLog";

/** One incoming OS event-log entry (matches the agent EventLogSample wire shape). */
export interface OsEventLogEntry {
  timestamp?: string | null;
  channel: string;
  provider?: string | null;
  eventId?: number | null;
  /** Agent-normalized severity: "critical" | "error" | "warning" | "info". */
  level: string;
  message: string;
  /** Dedup count within the source poll (>=1). */
  count?: number | null;
}

const AUDIT_LEVEL_ORDER: Record<string, number> = { info: 0, warning: 1, error: 2 };

/**
 * Map an agent-normalized OS level to the 3-value audit level. Windows
 * Critical+Error and journald emerg..err all fold to "error"; Warning →
 * "warning"; everything else (info/notice/debug) → "info".
 */
export function mapOsLevelToAudit(level: string): "info" | "warning" | "error" {
  const l = (level || "").toLowerCase();
  if (l === "critical" || l === "error" || l === "err" || l === "alert" || l === "emerg") return "error";
  if (l === "warning" || l === "warn") return "warning";
  return "info";
}

/** True when `auditLevel` meets the configured minimum. */
export function meetsMinAuditLevel(auditLevel: string, minLevel: string): boolean {
  return (AUDIT_LEVEL_ORDER[auditLevel] ?? 0) >= (AUDIT_LEVEL_ORDER[minLevel] ?? 0);
}

/**
 * Collapse identical entries within one batch, summing `count`. Dedup key is
 * (channel, eventId, level, message) — the same key the agent uses. Keeps the
 * earliest timestamp seen. Pure; order-preserving by first occurrence.
 */
export function dedupeEntries(entries: OsEventLogEntry[]): OsEventLogEntry[] {
  const byKey = new Map<string, OsEventLogEntry>();
  for (const e of entries) {
    const key = `${e.channel}\u0000${e.eventId ?? ""}\u0000${e.level}\u0000${e.message}`;
    const existing = byKey.get(key);
    const c = e.count && e.count > 0 ? e.count : 1;
    if (existing) {
      existing.count = (existing.count ?? 1) + c;
    } else {
      byKey.set(key, { ...e, count: c });
    }
  }
  return Array.from(byKey.values());
}

/** Sanitize a channel/source name into the `os_event.<channel>` action suffix. */
export function sanitizeChannel(channel: string): string {
  const c = (channel || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return c.length > 0 ? c : "other";
}

/** Build the audit `Event` inputs for a deduped, filtered entry set. Pure. */
export function buildAuditInputs(
  assetId: string,
  hostname: string | null,
  entries: OsEventLogEntry[],
): Array<{
  action: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  level: "info" | "warning" | "error";
  message: string;
  details: Record<string, unknown>;
}> {
  return entries.map((e) => {
    const auditLevel = mapOsLevelToAudit(e.level);
    const count = e.count && e.count > 0 ? e.count : 1;
    const countSuffix = count > 1 ? ` (×${count})` : "";
    return {
      action: `os_event.${sanitizeChannel(e.channel)}`,
      resourceType: "asset",
      resourceId: assetId,
      resourceName: hostname || undefined,
      level: auditLevel,
      message: `[${e.channel}${e.provider ? "/" + e.provider : ""}] ${e.message}${countSuffix}`,
      details: {
        channel: e.channel,
        provider: e.provider ?? null,
        eventId: e.eventId ?? null,
        osLevel: e.level,
        count,
        source: "os-event-log",
      },
    };
  });
}

/** Read the operator-tuned global config, falling back to safe defaults. */
export async function getAgentEventLogConfig(): Promise<AgentEventLogConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    if (!row?.value || typeof row.value !== "object") return { ...DEFAULT_AGENT_EVENT_LOG_CONFIG };
    const v = row.value as Record<string, unknown>;
    return {
      enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_AGENT_EVENT_LOG_CONFIG.enabled,
      minLevel: v.minLevel === "info" || v.minLevel === "warning" || v.minLevel === "error" ? v.minLevel : DEFAULT_AGENT_EVENT_LOG_CONFIG.minLevel,
      windowsChannels: Array.isArray(v.windowsChannels) ? (v.windowsChannels as unknown[]).filter((s): s is string => typeof s === "string") : DEFAULT_AGENT_EVENT_LOG_CONFIG.windowsChannels,
      linuxMinPriority: typeof v.linuxMinPriority === "number" ? v.linuxMinPriority : DEFAULT_AGENT_EVENT_LOG_CONFIG.linuxMinPriority,
      maxPerPush: typeof v.maxPerPush === "number" && v.maxPerPush > 0 ? v.maxPerPush : DEFAULT_AGENT_EVENT_LOG_CONFIG.maxPerPush,
      perAssetHourlyCap: typeof v.perAssetHourlyCap === "number" && v.perAssetHourlyCap > 0 ? v.perAssetHourlyCap : DEFAULT_AGENT_EVENT_LOG_CONFIG.perAssetHourlyCap,
    };
  } catch {
    return { ...DEFAULT_AGENT_EVENT_LOG_CONFIG };
  }
}

/**
 * Merge a partial operator update into the stored config (clamping ranges) and
 * persist it. Unspecified fields keep their current value. Returns the full
 * resolved config. Validation lives here so the route stays thin.
 */
export async function updateAgentEventLogConfig(
  patch: Partial<AgentEventLogConfig>,
): Promise<AgentEventLogConfig> {
  const current = await getAgentEventLogConfig();
  const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = typeof v === "number" ? Math.round(v) : NaN;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const next: AgentEventLogConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    minLevel:
      patch.minLevel === "info" || patch.minLevel === "warning" || patch.minLevel === "error"
        ? patch.minLevel
        : current.minLevel,
    windowsChannels: Array.isArray(patch.windowsChannels)
      ? patch.windowsChannels
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.length <= 128)
          .slice(0, 32)
      : current.windowsChannels,
    linuxMinPriority: patch.linuxMinPriority === undefined ? current.linuxMinPriority : clampInt(patch.linuxMinPriority, 0, 7, current.linuxMinPriority),
    maxPerPush: patch.maxPerPush === undefined ? current.maxPerPush : clampInt(patch.maxPerPush, 1, 5000, current.maxPerPush),
    perAssetHourlyCap: patch.perAssetHourlyCap === undefined ? current.perAssetHourlyCap : clampInt(patch.perAssetHourlyCap, 1, 100000, current.perAssetHourlyCap),
  };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
  return next;
}

export interface IngestResult {
  accepted: number;
  suppressed: number;
}

/**
 * Ingest a batch of OS event-log entries for one asset into the audit Event
 * table. Filters by min-level, dedupes, applies the per-push cap, then the
 * per-asset rolling-hour cap (overflow → one `os_event.suppressed` summary
 * event). Returns counts. Never throws (logEventsBatch swallows write errors).
 */
export async function ingestOsEventLog(
  assetId: string,
  hostname: string | null,
  entries: OsEventLogEntry[],
  cfg: AgentEventLogConfig,
): Promise<IngestResult> {
  if (entries.length === 0) return { accepted: 0, suppressed: 0 };

  // Min-level filter (defense-in-depth — the agent already filtered) + dedupe.
  const filtered = entries.filter((e) => meetsMinAuditLevel(mapOsLevelToAudit(e.level), cfg.minLevel));
  const deduped = dedupeEntries(filtered);

  // Per-push cap: keep the first N after dedupe.
  let suppressed = 0;
  let kept = deduped;
  if (deduped.length > cfg.maxPerPush) {
    suppressed += deduped.length - cfg.maxPerPush;
    kept = deduped.slice(0, cfg.maxPerPush);
  }

  // Per-asset rolling-hour cap. One bounded COUNT query per push; cheap even at
  // 2000 assets pushing hourly. Protects the non-hypertable audit table from a
  // flapping host spamming os_event rows.
  const since = new Date(Date.now() - 60 * 60 * 1000);
  let remaining = cfg.perAssetHourlyCap;
  try {
    const recent = await prisma.event.count({
      where: { resourceType: "asset", resourceId: assetId, action: { startsWith: "os_event." }, timestamp: { gte: since } },
    });
    remaining = Math.max(0, cfg.perAssetHourlyCap - recent);
  } catch {
    // If the count fails, fall back to the per-push cap only (don't block ingest).
    remaining = cfg.maxPerPush;
  }
  if (kept.length > remaining) {
    suppressed += kept.length - remaining;
    kept = kept.slice(0, remaining);
  }

  const inputs = buildAuditInputs(assetId, hostname, kept);
  const accepted = await logEventsBatch(inputs);

  // Summarize the suppressed tail so operators see that data was dropped (the
  // "no silent caps" rule). Only when something was actually dropped.
  if (suppressed > 0) {
    await logEventsBatch([
      {
        action: "os_event.suppressed",
        resourceType: "asset",
        resourceId: assetId,
        resourceName: hostname || undefined,
        level: "warning",
        message: `${suppressed} OS event-log ${suppressed === 1 ? "entry" : "entries"} suppressed (rate cap reached)`,
        details: { suppressed, perAssetHourlyCap: cfg.perAssetHourlyCap, maxPerPush: cfg.maxPerPush },
      },
    ]);
  }

  return { accepted, suppressed };
}
