/**
 * src/services/connectivityCheckService.ts — agent-run connectivity checks.
 *
 * WHAT A CHECK IS
 * An operator-defined reachability probe — HTTP / HTTPS (status + optional body
 * match + TLS), TCP connect, or ICMP echo, each with an optional traceroute —
 * that the Polaris Agent on every matching host runs on its own cadence. The
 * result is a sample ABOUT THE PATH FROM THAT HOST, never about the host: it
 * does not move `monitorStatus`, `consecutiveFailures` or the host's own
 * response-time stream. A host that cannot reach a website is not a host that
 * is down.
 *
 * A CHECK HAS NO THRESHOLD
 * Whether 800 ms is a breach, how many failures in a row page someone, and who
 * gets the email all live in the automation that watches the conn* metrics —
 * the same split business rule 36 makes for "down". The check says what to
 * measure; the automation says what measuring it badly means.
 *
 * WHO RUNS IT
 * `scope` is an automation-shaped device filter, implicitly AND'd with "has an
 * ACTIVE Polaris Agent", plus `assetIds` pins kept even when the filter no
 * longer matches. `reconcileConnectivityCheckSources` materializes that into
 * `connectivity_check_sources` (one row per check × agent host); the agent's
 * GET /agents/config reads those rows. Membership deliberately ignores
 * `monitored` — whether a result may ALERT is business rule 37's question,
 * asked by the engine at fire time, not this one.
 *
 * WHERE IT MAY POINT
 * The vendor HTTP check (business rule 33) skips netGuard because its target is
 * the monitored device's own address. A connectivity check's target is
 * operator-chosen, so that exemption does NOT carry over: loopback, link-local
 * (incl. cloud metadata), unspecified and multicast literals are refused here,
 * and the agent refuses the same ranges again AFTER resolving the name, which
 * catches a hostname pointed at 127.0.0.1. Polaris's own addresses are refused
 * too — the agent's responseTime stream already measures that path, and a
 * fleet of agents aimed at the server on a schedule is a load generator, not a
 * measurement. RFC1918 stays allowed: checking internal services is the point.
 */

import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { isValidIpAddress } from "../utils/cidr.js";
import { parseStatusSpec, agentRegexProblem } from "../utils/httpCheck.js";
import { versionAtLeast } from "../utils/version.js";
import { logEvent } from "./eventLogService.js";
import { publishConfigRefresh } from "./agentCommandWake.js";
import { loadScopeAssetIds } from "./notificationEngine.js";
import { scopeIsUnconstrained, type RuleScope } from "./notificationTypes.js";
import { AGENT_SERVER_URL_SETTING_KEY } from "./agentInstallService.js";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const CHECK_KINDS = ["http", "https", "tcp", "icmp"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const BODY_MATCH_MODES = ["contains", "regex", "exact"] as const;
export type BodyMatchMode = (typeof BODY_MATCH_MODES)[number];

export const MIN_INTERVAL_SEC = 60;
export const MAX_INTERVAL_SEC = 3600;
export const MIN_TIMEOUT_MS = 500;
export const MAX_TIMEOUT_MS = 30_000;
/** Fleet-wide cap on ENABLED checks — each one is traffic from every member. */
export const MAX_ENABLED_CHECKS = 50;
/** Per-agent cap. The agent itself stops at 64; this is the operative one. */
export const MAX_CHECKS_PER_AGENT = 20;
/** First agent version whose config loop runs connectivity checks. */
export const MIN_AGENT_CONNECTIVITY_VERSION = "0.21.0";
/** Preview / results list caps. */
const PREVIEW_ROW_CAP = 100;

export interface CheckBodyMatch {
  mode: BodyMatchMode;
  pattern: string;
  caseSensitive: boolean;
}

export interface CheckHttpConfig {
  /** Accepted status spec, e.g. "200,204,300-399". Empty = any 2xx. */
  expectStatus: string;
  bodyMatch: CheckBodyMatch | null;
  verifyTls: boolean;
}

export interface CheckTracerouteConfig {
  enabled: boolean;
  everyNRuns: number;
  maxHops: number;
  probesPerHop: number;
  probeTimeoutMs: number;
}

export const DEFAULT_TRACEROUTE: CheckTracerouteConfig = {
  enabled: true,
  everyNRuns: 5,
  maxHops: 30,
  probesPerHop: 3,
  probeTimeoutMs: 1000,
};

export interface ConnectivityCheckInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  kind: CheckKind;
  target: string;
  intervalSec?: number;
  timeoutMs?: number;
  http?: {
    expectStatus?: string;
    bodyMatch?: { mode: BodyMatchMode; pattern: string; caseSensitive?: boolean } | null;
    verifyTls?: boolean;
  } | null;
  traceroute?: Partial<CheckTracerouteConfig> | null;
  keepBodyExcerpt?: boolean;
  scope?: RuleScope | null;
  assetIds?: string[];
}

/** The normalized definition a check row stores. */
export interface NormalizedCheck {
  name: string;
  description: string | null;
  enabled: boolean;
  kind: CheckKind;
  target: string;
  intervalSec: number;
  timeoutMs: number;
  http: CheckHttpConfig | null;
  traceroute: CheckTracerouteConfig;
  keepBodyExcerpt: boolean;
  scope: RuleScope;
  assetIds: string[];
}

/**
 * The definition as the AGENT receives it (GET /agents/config →
 * connectivityChecks[]). Hand-mirrored by `transport.ConnectivityCheckDef` in
 * agent/internal/transport/client.go — rename a field here and every deployed
 * agent silently reads its zero value.
 */
export interface AgentCheckDef {
  id: string;
  name: string;
  kind: CheckKind;
  target: string;
  intervalSec: number;
  timeoutMs: number;
  expectStatus: string;
  expectBody: { mode: BodyMatchMode; value: string; caseSensitive: boolean } | null;
  verifyTls: boolean;
  keepBodyExcerpt: boolean;
  traceroute: CheckTracerouteConfig;
  revision: string;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(hi, Math.max(lo, n));
}

export function normalizeTraceroute(t: Partial<CheckTracerouteConfig> | null | undefined): CheckTracerouteConfig {
  const src = t ?? {};
  return {
    enabled: src.enabled === undefined ? DEFAULT_TRACEROUTE.enabled : src.enabled === true,
    everyNRuns: clampInt(src.everyNRuns, 1, 100, DEFAULT_TRACEROUTE.everyNRuns),
    maxHops: clampInt(src.maxHops, 1, 64, DEFAULT_TRACEROUTE.maxHops),
    probesPerHop: clampInt(src.probesPerHop, 1, 5, DEFAULT_TRACEROUTE.probesPerHop),
    probeTimeoutMs: clampInt(src.probeTimeoutMs, 100, 5000, DEFAULT_TRACEROUTE.probeTimeoutMs),
  };
}

/** Split "host:port" / "[v6]:port" / "host". Returns null port when absent. */
export function splitHostPort(target: string): { host: string; port: number | null } | null {
  const t = target.trim();
  if (!t) return null;
  if (t.startsWith("[")) {
    const end = t.indexOf("]");
    if (end < 0) return null;
    const host = t.slice(1, end);
    const rest = t.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(":")) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) ? { host, port } : null;
  }
  const colons = (t.match(/:/g) ?? []).length;
  if (colons === 0) return { host: t, port: null };
  if (colons > 1) return { host: t, port: null }; // bare IPv6 literal
  const idx = t.lastIndexOf(":");
  const port = Number(t.slice(idx + 1));
  if (!Number.isInteger(port)) return null;
  return { host: t.slice(0, idx), port };
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function isPlausibleHost(host: string): boolean {
  return isValidIpAddress(host) || HOSTNAME_RE.test(host);
}

/** The literal host a target names (no DNS), per kind. Throws AppError 400. */
export function targetHostOf(kind: CheckKind, target: string): string {
  const t = target.trim();
  if (!t) throw new AppError(400, "Target is required");
  if (t.length > 512) throw new AppError(400, "Target is longer than 512 characters");
  if (kind === "http" || kind === "https") {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      throw new AppError(400, `Target must be a full URL, e.g. ${kind}://intranet.example/health`);
    }
    if (u.protocol !== `${kind}:`) {
      throw new AppError(400, `A ${kind.toUpperCase()} check needs a ${kind}:// URL`);
    }
    if (u.username || u.password) {
      throw new AppError(400, "Credentials in the URL are not supported — the check sends no authentication");
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!host) throw new AppError(400, "The URL has no host");
    return host;
  }
  const hp = splitHostPort(t);
  if (!hp || !hp.host) throw new AppError(400, "Target must be a host name or IP address");
  if (kind === "tcp") {
    if (hp.port === null) throw new AppError(400, "A TCP check needs a port, e.g. db01.example:5432");
    if (hp.port < 1 || hp.port > 65535) throw new AppError(400, "Port must be between 1 and 65535");
  } else if (hp.port !== null) {
    throw new AppError(400, "An ICMP check takes a host only, without a port");
  }
  if (!isPlausibleHost(hp.host)) throw new AppError(400, `"${hp.host}" is not a valid host name or IP address`);
  return hp.host;
}

/** IPv4-only in v1: the agent's probes (IP_TTL, IcmpSendEcho2) are v4 sockets. */
function isIpv6Literal(host: string): boolean {
  return host.includes(":") && isValidIpAddress(host);
}

/**
 * The set of names and addresses that ARE this Polaris server. Resolved lazily
 * (one Setting read) — only the save path calls it.
 */
async function polarisOwnHosts(): Promise<Set<string>> {
  const out = new Set<string>();
  const addUrlHost = (raw: string | null | undefined) => {
    if (!raw) return;
    try {
      out.add(new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase());
    } catch { /* not a URL */ }
  };
  addUrlHost(process.env.POLARIS_PUBLIC_URL);
  try {
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SERVER_URL_SETTING_KEY } });
    const v = row?.value as unknown;
    addUrlHost(typeof v === "string" ? v : (v as { url?: string } | null)?.url);
  } catch { /* setting table unavailable — the other names still apply */ }
  const hn = os.hostname().toLowerCase();
  if (hn) {
    out.add(hn);
    out.add(hn.split(".")[0]);
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) out.add(ni.address.toLowerCase());
  }
  return out;
}

/** Refuse a target host literal Polaris will not aim agents at. */
export async function assertTargetHostAllowed(host: string): Promise<void> {
  const h = host.trim().toLowerCase();
  if (isBlockedOutboundHost(h)) {
    throw new AppError(400, `"${host}" is a loopback / link-local / metadata / multicast address and cannot be a check target`);
  }
  if (isIpv6Literal(h)) {
    throw new AppError(400, "IPv6 targets are not supported yet — use an IPv4 address or a name that resolves to one");
  }
  const own = await polarisOwnHosts();
  if (own.has(h)) {
    throw new AppError(400, `"${host}" is this Polaris server — the agent already measures its own path here (Response Time)`);
  }
}

/**
 * Validate + normalize a check body. Pure except for the own-host lookup.
 * Every refusal is an AppError(400) naming the field.
 */
export async function normalizeCheckInput(input: ConnectivityCheckInput): Promise<NormalizedCheck> {
  const name = (input.name ?? "").trim();
  if (!name) throw new AppError(400, "Name is required");
  if (name.length > 120) throw new AppError(400, "Name is longer than 120 characters");
  if (!CHECK_KINDS.includes(input.kind)) throw new AppError(400, `Kind must be one of ${CHECK_KINDS.join(", ")}`);
  const kind = input.kind;
  const target = input.target.trim();
  const host = targetHostOf(kind, target);
  await assertTargetHostAllowed(host);

  const intervalSec = input.intervalSec ?? 60;
  if (!Number.isInteger(intervalSec) || intervalSec % 60 !== 0 || intervalSec < MIN_INTERVAL_SEC || intervalSec > MAX_INTERVAL_SEC) {
    throw new AppError(400, "Interval must be a whole number of minutes between 1 and 60");
  }
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AppError(400, `Timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms`);
  }
  if (timeoutMs * 2 > intervalSec * 1000) {
    throw new AppError(400, "Timeout must be at most half the interval");
  }

  let http: CheckHttpConfig | null = null;
  if (kind === "http" || kind === "https") {
    const src = input.http ?? {};
    const expectStatus = (src.expectStatus ?? "").trim();
    const parsed = parseStatusSpec(expectStatus);
    if (parsed.error) throw new AppError(400, `Accepted status codes: ${parsed.error}`);
    let bodyMatch: CheckBodyMatch | null = null;
    if (src.bodyMatch && typeof src.bodyMatch.pattern === "string" && src.bodyMatch.pattern !== "") {
      const mode = src.bodyMatch.mode;
      if (!BODY_MATCH_MODES.includes(mode)) throw new AppError(400, `Body match mode must be one of ${BODY_MATCH_MODES.join(", ")}`);
      if (src.bodyMatch.pattern.length > 1024) throw new AppError(400, "Body match pattern is longer than 1024 characters");
      if (mode === "regex") {
        const problem = agentRegexProblem(src.bodyMatch.pattern);
        if (problem) throw new AppError(400, `Body match: ${problem}`);
      }
      bodyMatch = { mode, pattern: src.bodyMatch.pattern, caseSensitive: src.bodyMatch.caseSensitive === true };
    }
    http = {
      expectStatus,
      bodyMatch,
      // Default ON: an https check that silently accepts any certificate is a
      // check that cannot notice the one failure TLS exists to catch.
      verifyTls: kind === "https" ? src.verifyTls !== false : false,
    };
  }

  const scope: RuleScope = (input.scope ?? {}) as RuleScope;
  const assetIds = [...new Set((input.assetIds ?? []).filter((s) => typeof s === "string" && s))];
  if (assetIds.length > 2000) throw new AppError(400, "At most 2000 pinned hosts");
  const hasScope = scope.allAssets === true || !!scope.condition || Object.keys(scope).some((k) => {
    const v = (scope as Record<string, unknown>)[k];
    return Array.isArray(v) && v.length > 0;
  });
  if (!hasScope && assetIds.length === 0) {
    throw new AppError(400, "Choose which agent hosts run this check: add a condition, pin a host, or pick All agent hosts");
  }

  return {
    name,
    description: input.description?.trim() || null,
    enabled: input.enabled !== false,
    kind,
    target,
    intervalSec,
    timeoutMs,
    http,
    traceroute: normalizeTraceroute(input.traceroute),
    keepBodyExcerpt: input.keepBodyExcerpt === true && (kind === "http" || kind === "https"),
    scope,
    assetIds,
  };
}

interface CheckDefinitionRow {
  id: string;
  name: string;
  kind: string;
  target: string;
  intervalSec: number;
  timeoutMs: number;
  http: unknown;
  traceroute: unknown;
  keepBodyExcerpt: boolean;
  definitionSha256?: string;
}

/** Build the agent-facing definition from a stored row (revision excluded). */
function agentDefCore(row: CheckDefinitionRow): Omit<AgentCheckDef, "revision"> {
  const http = (row.http ?? null) as CheckHttpConfig | null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as CheckKind,
    target: row.target,
    intervalSec: row.intervalSec,
    timeoutMs: row.timeoutMs,
    expectStatus: http?.expectStatus ?? "",
    expectBody: http?.bodyMatch
      ? { mode: http.bodyMatch.mode, value: http.bodyMatch.pattern, caseSensitive: http.bodyMatch.caseSensitive }
      : null,
    verifyTls: http?.verifyTls ?? false,
    keepBodyExcerpt: row.keepBodyExcerpt,
    traceroute: normalizeTraceroute(row.traceroute as Partial<CheckTracerouteConfig> | null),
  };
}

/**
 * sha256 of the canonical agent definition. This is what both config ETags
 * fold, so it must change whenever anything the agent receives changes — and
 * only then (a description edit must not make 800 agents refetch).
 */
export function definitionSha256(row: CheckDefinitionRow): string {
  // A replacer that sorts every object level, so the hash is stable across
  // property order in the stored JSON columns.
  const stable = JSON.stringify(agentDefCore(row), (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
  return createHash("sha256").update(stable).digest("hex");
}

export function toAgentCheckDef(row: CheckDefinitionRow): AgentCheckDef {
  return { ...agentDefCore(row), revision: row.definitionSha256 ?? definitionSha256(row) };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export interface CheckSummary {
  sourceCount: number;
  okCount: number;
  failCount: number;
  lastRunAt: Date | null;
}

async function summariesFor(checkIds: string[]): Promise<Map<string, CheckSummary>> {
  const out = new Map<string, CheckSummary>();
  if (checkIds.length === 0) return out;
  const rows = await prisma.connectivityCheckSource.groupBy({
    by: ["checkId", "lastOk"],
    where: { checkId: { in: checkIds } },
    _count: { _all: true },
    _max: { lastSampleAt: true },
  });
  for (const r of rows) {
    const s = out.get(r.checkId) ?? { sourceCount: 0, okCount: 0, failCount: 0, lastRunAt: null };
    s.sourceCount += r._count._all;
    if (r.lastOk === true) s.okCount += r._count._all;
    if (r.lastOk === false) s.failCount += r._count._all;
    const m = r._max.lastSampleAt;
    if (m && (!s.lastRunAt || m > s.lastRunAt)) s.lastRunAt = m;
    out.set(r.checkId, s);
  }
  return out;
}

export async function listChecks() {
  const checks = await prisma.connectivityCheck.findMany({ orderBy: { name: "asc" } });
  const sums = await summariesFor(checks.map((c) => c.id));
  return checks.map((c) => ({
    ...c,
    ...(sums.get(c.id) ?? { sourceCount: 0, okCount: 0, failCount: 0, lastRunAt: null }),
  }));
}

/** The id → name/kind registry the automation builder renders conn* sentences
 *  and the checkId picker from (GET /automations/schema). No sources, no
 *  results — the builder needs names, and it is read on every wizard open. */
export async function listCheckCatalog() {
  return prisma.connectivityCheck.findMany({
    select: { id: true, name: true, kind: true, target: true, enabled: true },
    orderBy: { name: "asc" },
  });
}

export async function getCheck(id: string) {
  const check = await prisma.connectivityCheck.findUnique({ where: { id } });
  if (!check) throw new AppError(404, "Connectivity check not found");
  const sums = await summariesFor([id]);
  return { ...check, ...(sums.get(id) ?? { sourceCount: 0, okCount: 0, failCount: 0, lastRunAt: null }) };
}

async function assertEnabledCap(excludeId?: string): Promise<void> {
  const n = await prisma.connectivityCheck.count({ where: { enabled: true, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (n >= MAX_ENABLED_CHECKS) {
    throw new AppError(409, `At most ${MAX_ENABLED_CHECKS} connectivity checks can be enabled at once`);
  }
}

function jsonOf<T>(v: T): object {
  return v as unknown as object;
}

export async function createCheck(input: ConnectivityCheckInput, actor?: string) {
  const n = await normalizeCheckInput(input);
  if (n.enabled) await assertEnabledCap();
  const dupe = await prisma.connectivityCheck.findUnique({ where: { name: n.name } });
  if (dupe) throw new AppError(409, `A connectivity check named "${n.name}" already exists`);
  const id = randomUUID();
  const sha = definitionSha256({ id, ...n, http: n.http, traceroute: n.traceroute });
  const check = await prisma.connectivityCheck.create({
    data: {
      id,
      name: n.name,
      description: n.description,
      enabled: n.enabled,
      kind: n.kind,
      target: n.target,
      intervalSec: n.intervalSec,
      timeoutMs: n.timeoutMs,
      http: n.http ? jsonOf(n.http) : undefined,
      traceroute: jsonOf(n.traceroute),
      keepBodyExcerpt: n.keepBodyExcerpt,
      scope: jsonOf(n.scope),
      assetIds: n.assetIds,
      definitionSha256: sha,
      createdBy: actor ?? null,
    },
  });
  await logEvent({
    action: "connectivity_check.created",
    resourceType: "connectivity-check",
    resourceId: check.id,
    resourceName: check.name,
    actor,
    // Always audit-worthy: a new check directs agents to send traffic.
    level: "warning",
    message: `Connectivity check "${check.name}" created (${check.kind} ${check.target}, every ${check.intervalSec / 60} min)`,
    details: { kind: check.kind, target: check.target, intervalSec: check.intervalSec },
  });
  await reconcileConnectivityCheckSources(check.id, { refreshAllMembers: true });
  return getCheck(check.id);
}

export async function updateCheck(id: string, input: ConnectivityCheckInput, actor?: string) {
  const existing = await prisma.connectivityCheck.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Connectivity check not found");
  const n = await normalizeCheckInput(input);
  if (n.enabled && !existing.enabled) await assertEnabledCap(id);
  if (n.name !== existing.name) {
    const dupe = await prisma.connectivityCheck.findUnique({ where: { name: n.name } });
    if (dupe) throw new AppError(409, `A connectivity check named "${n.name}" already exists`);
  }
  const sha = definitionSha256({ id, ...n, http: n.http, traceroute: n.traceroute });
  const targetChanged = existing.target !== n.target || existing.kind !== n.kind;
  const check = await prisma.connectivityCheck.update({
    where: { id },
    data: {
      name: n.name,
      description: n.description,
      enabled: n.enabled,
      kind: n.kind,
      target: n.target,
      intervalSec: n.intervalSec,
      timeoutMs: n.timeoutMs,
      http: n.http ? jsonOf(n.http) : Prisma.DbNull,
      traceroute: jsonOf(n.traceroute),
      keepBodyExcerpt: n.keepBodyExcerpt,
      scope: jsonOf(n.scope),
      assetIds: n.assetIds,
      definitionSha256: sha,
    },
  });
  await logEvent({
    action: "connectivity_check.updated",
    resourceType: "connectivity-check",
    resourceId: id,
    resourceName: check.name,
    actor,
    level: targetChanged ? "warning" : "info",
    message: targetChanged
      ? `Connectivity check "${check.name}" TARGET changed: ${existing.kind} ${existing.target} → ${check.kind} ${check.target}`
      : `Connectivity check "${check.name}" updated`,
    details: {
      previousTarget: existing.target, target: check.target,
      previousKind: existing.kind, kind: check.kind,
      definitionChanged: sha !== existing.definitionSha256,
      enabled: check.enabled,
    },
  });
  // A changed path makes every stored path hash describe a different target;
  // forget them so the first new traceroute is a baseline, not a "change".
  if (targetChanged) {
    await prisma.connectivityCheckSource.updateMany({
      where: { checkId: id },
      data: { lastPathHash: null, lastOk: null, lastHopCount: null, lastTracerouteComplete: null },
    });
  }
  await reconcileConnectivityCheckSources(id, {
    refreshAllMembers: sha !== existing.definitionSha256 || check.enabled !== existing.enabled,
  });
  return getCheck(id);
}

export async function setCheckEnabled(id: string, enabled: boolean, actor?: string) {
  const existing = await prisma.connectivityCheck.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Connectivity check not found");
  if (existing.enabled === enabled) return getCheck(id);
  if (enabled) await assertEnabledCap(id);
  await prisma.connectivityCheck.update({ where: { id }, data: { enabled } });
  await logEvent({
    action: enabled ? "connectivity_check.enabled" : "connectivity_check.disabled",
    resourceType: "connectivity-check",
    resourceId: id,
    resourceName: existing.name,
    actor,
    message: `Connectivity check "${existing.name}" ${enabled ? "enabled" : "disabled"}`,
  });
  await reconcileConnectivityCheckSources(id, { refreshAllMembers: true });
  return getCheck(id);
}

export async function deleteCheck(id: string, actor?: string) {
  const existing = await prisma.connectivityCheck.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Connectivity check not found");
  const members = await prisma.connectivityCheckSource.findMany({
    where: { checkId: id },
    select: { asset: { select: { managedAgent: { select: { id: true } } } } },
  });
  // Sources cascade. Samples and traceroutes are NOT deleted: they live in
  // compressed hypertable chunks, and a row DELETE there decompresses the
  // chunk (the 2026-06-08 incident). They age out on the retention schedule.
  await prisma.connectivityCheck.delete({ where: { id } });
  await logEvent({
    action: "connectivity_check.deleted",
    resourceType: "connectivity-check",
    resourceId: id,
    resourceName: existing.name,
    actor,
    level: "warning",
    message: `Connectivity check "${existing.name}" deleted (${existing.kind} ${existing.target})`,
    details: { kind: existing.kind, target: existing.target },
  });
  await publishConfigRefresh(members.map((m) => m.asset.managedAgent?.id ?? "").filter(Boolean));
}

// ─── Membership ─────────────────────────────────────────────────────────────

interface ActiveAgent {
  id: string;
  assetId: string;
  agentVersion: string | null;
}

async function activeAgents(): Promise<Map<string, ActiveAgent>> {
  const rows = await prisma.managedAgent.findMany({
    where: { installStatus: "active" },
    select: { id: true, assetId: true, agentVersion: true },
  });
  return new Map(rows.map((r) => [r.assetId, r]));
}

/** The asset ids a check resolves to: (scope ∪ pins) ∩ active agents. */
async function membersFor(
  scope: RuleScope,
  pins: readonly string[],
  agents: Map<string, ActiveAgent>,
): Promise<{ members: Map<string, { explicit: boolean; agent: ActiveAgent }>; filterIds: Set<string> }> {
  const members = new Map<string, { explicit: boolean; agent: ActiveAgent }>();
  let filterIds: Set<string>;
  if (scope.allAssets === true) {
    // No need to load the fleet: every active agent's host matches.
    filterIds = new Set(agents.keys());
  } else if (scopeIsUnconstrained(scope)) {
    // `{}` or an empty tree from this builder means "nothing chosen" — a check
    // saved with only pins. (The event-automation reading of `{}` as "any
    // device" is business rule 46's legacy concern, not this one.)
    filterIds = new Set();
  } else {
    filterIds = new Set(await loadScopeAssetIds(scope));
  }
  for (const assetId of filterIds) {
    const agent = agents.get(assetId);
    if (agent) members.set(assetId, { explicit: false, agent });
  }
  for (const assetId of pins) {
    const agent = agents.get(assetId);
    if (agent) members.set(assetId, { explicit: true, agent });
  }
  return { members, filterIds };
}

export interface ReconcileResult {
  checks: number;
  added: number;
  removed: number;
  refreshedAgents: number;
}

/** Hosts over MAX_CHECKS_PER_AGENT at the last full reconcile — an Event is
 *  written when the set CHANGES, not on every 5-minute tick. */
let _overCapLast = new Set<string>();

/**
 * Rebuild `connectivity_check_sources` for one check (a write path) or all of
 * them (the 5-minute job). Batched throughout — one agent query, one source
 * query, then createMany / deleteMany / updateMany — so the 2000-host fleet
 * costs a handful of statements per check, never a query per host.
 *
 * Disabled checks keep their membership: the fleet view still shows their
 * last results, and GET /agents/config filters on `enabled`.
 */
export async function reconcileConnectivityCheckSources(
  checkId?: string,
  opts: { refreshAllMembers?: boolean } = {},
): Promise<ReconcileResult> {
  const checks = await prisma.connectivityCheck.findMany({
    where: checkId ? { id: checkId } : {},
    select: { id: true, name: true, scope: true, assetIds: true },
  });
  const result: ReconcileResult = { checks: checks.length, added: 0, removed: 0, refreshedAgents: 0 };
  if (checks.length === 0) return result;
  const agents = await activeAgents();
  const existing = await prisma.connectivityCheckSource.findMany({
    where: { checkId: { in: checks.map((c) => c.id) } },
    select: { id: true, checkId: true, assetId: true, explicit: true },
  });
  const byCheck = new Map<string, typeof existing>();
  for (const s of existing) {
    const list = byCheck.get(s.checkId) ?? [];
    list.push(s);
    byCheck.set(s.checkId, list);
  }
  const refresh = new Set<string>();
  const toCreate: { checkId: string; assetId: string; explicit: boolean }[] = [];
  const toDelete: string[] = [];
  const toExplicit: string[] = [];
  const toImplicit: string[] = [];
  for (const c of checks) {
    const { members } = await membersFor((c.scope ?? {}) as RuleScope, c.assetIds, agents);
    const have = new Map((byCheck.get(c.id) ?? []).map((s) => [s.assetId, s]));
    for (const [assetId, m] of members) {
      const row = have.get(assetId);
      if (!row) {
        toCreate.push({ checkId: c.id, assetId, explicit: m.explicit });
        refresh.add(m.agent.id);
      } else if (row.explicit !== m.explicit) {
        (m.explicit ? toExplicit : toImplicit).push(row.id);
      }
      if (opts.refreshAllMembers) refresh.add(m.agent.id);
    }
    for (const [assetId, row] of have) {
      if (!members.has(assetId)) {
        toDelete.push(row.id);
        const agent = agents.get(assetId);
        if (agent) refresh.add(agent.id);
      }
    }
  }
  const ops = [];
  if (toCreate.length) ops.push(prisma.connectivityCheckSource.createMany({ data: toCreate, skipDuplicates: true }));
  if (toDelete.length) ops.push(prisma.connectivityCheckSource.deleteMany({ where: { id: { in: toDelete } } }));
  if (toExplicit.length) ops.push(prisma.connectivityCheckSource.updateMany({ where: { id: { in: toExplicit } }, data: { explicit: true } }));
  if (toImplicit.length) ops.push(prisma.connectivityCheckSource.updateMany({ where: { id: { in: toImplicit } }, data: { explicit: false } }));
  ops.push(prisma.connectivityCheck.updateMany({ where: { id: { in: checks.map((c) => c.id) } }, data: { lastReconciledAt: new Date() } }));
  await prisma.$transaction(ops);
  result.added = toCreate.length;
  result.removed = toDelete.length;
  result.refreshedAgents = refresh.size;
  if (refresh.size) await publishConfigRefresh([...refresh]);
  await reportOverCap(checkId === undefined);
  return result;
}

/**
 * MAX_CHECKS_PER_AGENT is enforced in GET /agents/config (oldest checks win,
 * deterministically). This names the hosts it bites on instead of letting the
 * newest checks go quietly unrun there.
 */
async function reportOverCap(fullPass: boolean): Promise<void> {
  const rows = await prisma.connectivityCheckSource.groupBy({
    by: ["assetId"],
    where: { check: { enabled: true } },
    _count: { _all: true },
    having: { assetId: { _count: { gt: MAX_CHECKS_PER_AGENT } } },
  });
  const now = new Set(rows.map((r) => r.assetId));
  const fresh = [...now].filter((id) => !_overCapLast.has(id));
  if (fullPass) _overCapLast = now;
  else for (const id of fresh) _overCapLast.add(id);
  if (fresh.length === 0) return;
  const assets = await prisma.asset.findMany({ where: { id: { in: fresh } }, select: { id: true, hostname: true, ipAddress: true } });
  await Promise.all(assets.map((a) => {
    const count = rows.find((r) => r.assetId === a.id)?._count._all ?? 0;
    return logEvent({
      action: "connectivity_check.agent_over_cap",
      resourceType: "asset",
      resourceId: a.id,
      resourceName: a.hostname || a.ipAddress || a.id,
      level: "warning",
      message: `${a.hostname || a.ipAddress} matches ${count} enabled connectivity checks; its agent runs only the oldest ${MAX_CHECKS_PER_AGENT}`,
      details: { count, cap: MAX_CHECKS_PER_AGENT },
    });
  }));
}

// ─── Read surfaces ──────────────────────────────────────────────────────────

/** Is the agent live right now? A WS session is the strong signal; a recent
 *  bearer call is the fallback when the WS is blocked by a proxy. */
export function agentOnline(a: { wsConnectedAt: Date | null; wsDisconnectedAt: Date | null; lastSeenAt: Date | null }, now = Date.now()): boolean {
  if (a.wsConnectedAt && (!a.wsDisconnectedAt || a.wsConnectedAt > a.wsDisconnectedAt)) return true;
  return !!a.lastSeenAt && now - a.lastSeenAt.getTime() < 10 * 60_000;
}

export interface PreviewSourcesInput {
  scope?: RuleScope | null;
  assetIds?: string[];
}

export async function previewSources(input: PreviewSourcesInput) {
  const scope = (input.scope ?? {}) as RuleScope;
  const pins = [...new Set(input.assetIds ?? [])];
  const agents = await activeAgents();
  const { members, filterIds } = await membersFor(scope, pins, agents);
  const ids = [...members.keys()];
  const shown = ids.slice(0, PREVIEW_ROW_CAP);
  const pinnedMissing = pins.filter((id) => !agents.has(id));
  const [assets, missing] = await Promise.all([
    prisma.asset.findMany({
      where: { id: { in: shown } },
      select: {
        id: true, hostname: true, ipAddress: true, os: true,
        managedAgent: { select: { agentVersion: true, wsConnectedAt: true, wsDisconnectedAt: true, lastSeenAt: true } },
      },
      orderBy: { hostname: "asc" },
    }),
    pinnedMissing.length
      ? prisma.asset.findMany({ where: { id: { in: pinnedMissing } }, select: { id: true, hostname: true, ipAddress: true } })
      : Promise.resolve([]),
  ]);
  const matchedNoAgent = [...filterIds].filter((id) => !agents.has(id)).length;
  return {
    total: ids.length,
    pinned: ids.filter((id) => members.get(id)!.explicit).length,
    matchedWithoutAgent: matchedNoAgent,
    agents: assets.map((a) => ({
      assetId: a.id,
      hostname: a.hostname,
      ipAddress: a.ipAddress,
      os: a.os,
      agentVersion: a.managedAgent?.agentVersion ?? null,
      online: a.managedAgent ? agentOnline(a.managedAgent) : false,
      supported: versionAtLeast(a.managedAgent?.agentVersion, MIN_AGENT_CONNECTIVITY_VERSION),
      pinned: members.get(a.id)?.explicit === true,
      pinnedOnly: members.get(a.id)?.explicit === true && !filterIds.has(a.id),
    })),
    pinnedWithoutAgent: missing.map((a) => ({ assetId: a.id, hostname: a.hostname, ipAddress: a.ipAddress })),
    minAgentVersion: MIN_AGENT_CONNECTIVITY_VERSION,
  };
}

const SOURCE_RESULT_SELECT = {
  id: true, checkId: true, assetId: true, explicit: true,
  lastOk: true, lastSampleAt: true, lastLatencyMs: true, lastHttpStatus: true,
  lastError: true, lastResolvedIp: true, lastFailAt: true, lastHopCount: true,
  lastTracerouteComplete: true, lastTracerouteAt: true,
} as const;

/** Fleet view of one check: every member host with its latest result. */
export async function listCheckResults(checkId: string) {
  const check = await prisma.connectivityCheck.findUnique({ where: { id: checkId }, select: { id: true } });
  if (!check) throw new AppError(404, "Connectivity check not found");
  const rows = await prisma.connectivityCheckSource.findMany({
    where: { checkId },
    select: {
      ...SOURCE_RESULT_SELECT,
      asset: {
        select: {
          hostname: true, ipAddress: true, os: true, monitorStatus: true,
          managedAgent: { select: { agentVersion: true, wsConnectedAt: true, wsDisconnectedAt: true, lastSeenAt: true } },
        },
      },
    },
  });
  return rows
    .map(({ asset, ...s }) => ({
      ...s,
      hostname: asset.hostname,
      ipAddress: asset.ipAddress,
      os: asset.os,
      agentVersion: asset.managedAgent?.agentVersion ?? null,
      online: asset.managedAgent ? agentOnline(asset.managedAgent) : false,
      supported: versionAtLeast(asset.managedAgent?.agentVersion, MIN_AGENT_CONNECTIVITY_VERSION),
    }))
    .sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
}

/** The checks one host runs, with its latest result for each. */
export async function getAssetChecks(assetId: string) {
  const rows = await prisma.connectivityCheckSource.findMany({
    where: { assetId },
    select: {
      ...SOURCE_RESULT_SELECT,
      check: {
        select: {
          id: true, name: true, description: true, enabled: true, kind: true, target: true,
          intervalSec: true, timeoutMs: true, traceroute: true, http: true, keepBodyExcerpt: true,
        },
      },
    },
  });
  return {
    checks: rows
      .map(({ check, ...latest }) => ({ ...check, latest }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The definitions GET /agents/config ships to one agent: enabled checks it is
 * a member of, oldest first, capped at MAX_CHECKS_PER_AGENT — and NONE for an
 * agent older than MIN_AGENT_CONNECTIVITY_VERSION, which would ignore the
 * field anyway and whose operator should see "upgrade" rather than silence.
 */
export async function agentConfigChecks(assetId: string, agentVersion: string | null | undefined): Promise<AgentCheckDef[]> {
  if (!versionAtLeast(agentVersion, MIN_AGENT_CONNECTIVITY_VERSION)) return [];
  const rows = await prisma.connectivityCheckSource.findMany({
    where: { assetId, check: { enabled: true } },
    select: {
      check: {
        select: {
          id: true, name: true, kind: true, target: true, intervalSec: true, timeoutMs: true,
          http: true, traceroute: true, keepBodyExcerpt: true, definitionSha256: true, createdAt: true,
        },
      },
    },
  });
  return rows
    .map((r) => r.check)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .slice(0, MAX_CHECKS_PER_AGENT)
    .map((c) => toAgentCheckDef(c));
}

/** The compact fold both config ETags carry: check id + revision, in order. */
export function connectivityEtagFold(defs: readonly AgentCheckDef[]): string {
  return defs.map((d) => `${d.id}:${d.revision}`).join("\u0001");
}
