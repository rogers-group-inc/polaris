/**
 * src/services/pathCheckService.ts — agent-run path checks.
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
 * gets the email all live in the automation that watches the path* metrics —
 * the same split business rule 36 makes for "down". The check says what to
 * measure; the automation says what measuring it badly means.
 *
 * WHO RUNS IT
 * `scope` is an automation-shaped device filter, implicitly AND'd with "has an
 * ACTIVE Polaris Agent", plus `assetIds` pins kept even when the filter no
 * longer matches. `reconcilePathCheckSources` materializes that into
 * `path_check_sources` (one row per check × agent host); the agent's
 * GET /agents/config reads those rows. Membership deliberately ignores
 * `monitored` — whether a result may ALERT is business rule 37's question,
 * asked by the engine at fire time, not this one.
 *
 * `runOnServer` adds ONE more source: the Polaris server itself, run by
 * jobs/runServerPathChecks on the scheduler role. The server is not an asset,
 * so its source row has assetId NULL and its samples carry the reserved
 * subject id POLARIS_SERVER_SUBJECT. The alert engine resolves path* readings
 * per ASSET, so a server-run result is charted and listed but raises no
 * automation alert (business rule 85, "The Polaris server as a source").
 *
 * WHERE IT MAY POINT
 * The vendor HTTP check (business rule 33) skips netGuard because its target is
 * the monitored device's own address. A path check's target is
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
import { parseStatusSpec, agentRegexProblem, resolveHttpAuthMode, type HttpAuthConfig } from "../utils/httpCheck.js";
import { versionAtLeast } from "../utils/version.js";
import { logEvent } from "./eventLogService.js";
import { publishConfigRefresh } from "./agentCommandWake.js";
import { loadScopeAssetIds } from "./notificationEngine.js";
import { scopeIsUnconstrained, type RuleScope } from "./notificationTypes.js";
import { AGENT_SERVER_URL_SETTING_KEY } from "./agentInstallService.js";
import { POLARIS_SERVER_SUBJECT, POLARIS_SERVER_LABEL } from "./pathCheckIngestService.js";

import { runServerCheck, type RunCapture } from "./pathCheckServerRunner.js";

export { POLARIS_SERVER_SUBJECT, POLARIS_SERVER_LABEL };

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
/** First agent version whose config loop runs path checks. */
export const MIN_AGENT_PATH_CHECK_VERSION = "0.21.0";
/** Preview / results list caps. */
const PREVIEW_ROW_CAP = 100;

export interface CheckBodyMatch {
  mode: BodyMatchMode;
  pattern: string;
  caseSensitive: boolean;
  /** true = the body must NOT contain / equal / match (SolarWinds "Fail If Found"). */
  negate?: boolean;
}

export const HTTP_METHODS = ["GET", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
/** Redirect hops a check that follows redirects takes at most. */
export const MAX_REDIRECTS = 5;

export interface CheckHttpConfig {
  /** Accepted status spec, e.g. "200,204,300-399". Empty = any 2xx. */
  expectStatus: string;
  bodyMatch: CheckBodyMatch | null;
  verifyTls: boolean;
  /** GET (default) or HEAD — nothing that writes; PUT/POST/DELETE are refused by design. */
  method?: HttpMethod;
  /** Sent as Host (and the TLS SNI name) instead of the URL's host — test one backend by address. */
  hostHeader?: string | null;
  /** Follow up to MAX_REDIRECTS redirects and judge the LAST response. Default off. */
  followRedirects?: boolean;
}

/**
 * First agent version that runs checks using the 2026-09-30 request options
 * (HEAD, a Host header, redirects, a negated body match). An older agent would
 * ignore the fields it does not know and run a DIFFERENT check under the same
 * name — so such a check is not shipped to it at all, and the UI says
 * "upgrade" (requiredAgentVersion).
 */
export const MIN_AGENT_REQUEST_OPTIONS_VERSION = "0.23.0";

/** The credential authModes a path check may authenticate with. */
export const PATH_CHECK_AUTH_MODES = ["bearer", "basic", "digest"] as const;

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

export interface PathCheckInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  kind: CheckKind;
  target: string;
  intervalSec?: number;
  timeoutMs?: number;
  http?: {
    expectStatus?: string;
    bodyMatch?: { mode: BodyMatchMode; pattern: string; caseSensitive?: boolean; negate?: boolean } | null;
    verifyTls?: boolean;
    method?: HttpMethod;
    hostHeader?: string | null;
    followRedirects?: boolean;
  } | null;
  /** An `http` Credential to authenticate with — makes the check server-only. */
  credentialId?: string | null;
  traceroute?: Partial<CheckTracerouteConfig> | null;
  keepBodyExcerpt?: boolean;
  scope?: RuleScope | null;
  assetIds?: string[];
  runOnServer?: boolean;
  /** The wizard's finder filter ({ condition }) — stored for display, never membership. */
  sourceFilter?: RuleScope | null;
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
  runOnServer: boolean;
  sourceFilter: RuleScope | null;
  credentialId: string | null;
}

/**
 * The definition as the AGENT receives it (GET /agents/config →
 * pathChecks[]). Hand-mirrored by `transport.PathCheckDef` in
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
  expectBody: { mode: BodyMatchMode; value: string; caseSensitive: boolean; negate?: boolean } | null;
  verifyTls: boolean;
  /** Present only when not the default ("GET" / none / false): omitted keys keep old definitions' hashes. */
  method?: HttpMethod;
  hostHeader?: string;
  followRedirects?: boolean;
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
export async function normalizeCheckInput(input: PathCheckInput): Promise<NormalizedCheck> {
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
      if (src.bodyMatch.negate === true) bodyMatch.negate = true;
    }
    const method = src.method ?? "GET";
    if (!HTTP_METHODS.includes(method)) {
      throw new AppError(400, "Method must be GET or HEAD — a check never sends a request that changes anything");
    }
    if (method === "HEAD" && bodyMatch) throw new AppError(400, "A HEAD request has no body to match — use GET, or clear the body check");
    const hostHeader = normalizeHostHeader(src.hostHeader);
    http = {
      expectStatus,
      bodyMatch,
      // Default ON: an https check that silently accepts any certificate is a
      // check that cannot notice the one failure TLS exists to catch.
      verifyTls: kind === "https" ? src.verifyTls !== false : false,
    };
    // Written only when not the default, so every check saved before these
    // options existed keeps its definition hash (and its agents' baselines).
    if (method !== "GET") http.method = method;
    if (hostHeader) http.hostHeader = hostHeader;
    if (src.followRedirects === true) http.followRedirects = true;
  }

  // Authentication makes the check SERVER-ONLY: the secret is used by this
  // Polaris server and is never sent to an agent (business rule 85).
  let credentialId: string | null = null;
  if (input.credentialId) {
    if (kind !== "http" && kind !== "https") throw new AppError(400, "Only an HTTP or HTTPS check can authenticate");
    const cred = await prisma.credential.findUnique({ where: { id: input.credentialId }, select: { id: true, type: true, config: true } });
    if (!cred) throw new AppError(400, "That credential no longer exists");
    const mode = cred.type === "http" ? resolveHttpAuthMode((cred.config ?? {}) as HttpAuthConfig) : null;
    if (!mode || !(PATH_CHECK_AUTH_MODES as readonly string[]).includes(mode)) {
      throw new AppError(400, "A path check authenticates with an HTTP credential using Bearer, Basic or Digest");
    }
    credentialId = cred.id;
  }

  const scope: RuleScope = (input.scope ?? {}) as RuleScope;
  const assetIds = [...new Set((input.assetIds ?? []).filter((s) => typeof s === "string" && s))];
  if (assetIds.length > 2000) throw new AppError(400, "At most 2000 pinned hosts");
  const hasScope = scope.allAssets === true || !!scope.condition || Object.keys(scope).some((k) => {
    const v = (scope as Record<string, unknown>)[k];
    return Array.isArray(v) && v.length > 0;
  });
  if (credentialId && (hasScope || assetIds.length > 0)) {
    throw new AppError(400, "A check that authenticates runs only from this Polaris server, so its credential never reaches an agent — remove its agent hosts");
  }
  const runOnServer = input.runOnServer === true || credentialId !== null;
  if (!hasScope && assetIds.length === 0 && !runOnServer) {
    throw new AppError(400, "Choose where this check runs: this Polaris server, or agent hosts (add a condition, pin a host, or pick All agent hosts)");
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
    runOnServer,
    // Only a condition is kept, and only on an agent-run check; it is the
    // wizard's finder, so it never reaches membersFor.
    sourceFilter: !runOnServer && input.sourceFilter?.condition ? { condition: input.sourceFilter.condition } : null,
    credentialId,
  };
}

const HOST_HEADER_RE = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?(?::\d{1,5})?$/i;

/** A Host header value: a name or IPv4 address, optional :port. Null when blank. Pure (tested). */
export function normalizeHostHeader(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (v.length > 260 || !HOST_HEADER_RE.test(v)) {
    throw new AppError(400, `Host header "${v.slice(0, 60)}" must be a host name or address, optionally with :port`);
  }
  const port = /:(\d+)$/.exec(v);
  if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) throw new AppError(400, "Host header port must be 1–65535");
  return v.toLowerCase();
}

/** Pure: the agent version a definition needs (the request options raise it). */
export function requiredAgentVersion(def: Pick<AgentCheckDef, "method" | "hostHeader" | "followRedirects" | "expectBody">): string {
  const usesOptions = (def.method && def.method !== "GET") || !!def.hostHeader || def.followRedirects === true || def.expectBody?.negate === true;
  return usesOptions ? MIN_AGENT_REQUEST_OPTIONS_VERSION : MIN_AGENT_PATH_CHECK_VERSION;
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
      ? {
          mode: http.bodyMatch.mode, value: http.bodyMatch.pattern, caseSensitive: http.bodyMatch.caseSensitive,
          ...(http.bodyMatch.negate ? { negate: true } : {}),
        }
      : null,
    verifyTls: http?.verifyTls ?? false,
    keepBodyExcerpt: row.keepBodyExcerpt,
    traceroute: normalizeTraceroute(row.traceroute as Partial<CheckTracerouteConfig> | null),
    ...(http?.method && http.method !== "GET" ? { method: http.method } : {}),
    ...(http?.hostHeader ? { hostHeader: http.hostHeader } : {}),
    ...(http?.followRedirects ? { followRedirects: true } : {}),
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
  /** Of failCount: sources whose failing run still got an HTTP answer (wrong
   *  status or body) — the list shows those as "Unexpected response". */
  unexpectedCount: number;
  lastRunAt: Date | null;
}

const EMPTY_SUMMARY: CheckSummary = { sourceCount: 0, okCount: 0, failCount: 0, unexpectedCount: 0, lastRunAt: null };

async function summariesFor(checkIds: string[]): Promise<Map<string, CheckSummary>> {
  const out = new Map<string, CheckSummary>();
  if (checkIds.length === 0) return out;
  const [rows, unexpected] = await Promise.all([
    prisma.pathCheckSource.groupBy({
      by: ["checkId", "lastOk"],
      where: { checkId: { in: checkIds } },
      _count: { _all: true },
      _max: { lastSampleAt: true },
    }),
    prisma.pathCheckSource.groupBy({
      by: ["checkId"],
      where: { checkId: { in: checkIds }, lastOk: false, lastHttpStatus: { not: null } },
      _count: { _all: true },
    }),
  ]);
  for (const r of rows) {
    const s = out.get(r.checkId) ?? { ...EMPTY_SUMMARY };
    s.sourceCount += r._count._all;
    if (r.lastOk === true) s.okCount += r._count._all;
    if (r.lastOk === false) s.failCount += r._count._all;
    const m = r._max.lastSampleAt;
    if (m && (!s.lastRunAt || m > s.lastRunAt)) s.lastRunAt = m;
    out.set(r.checkId, s);
  }
  for (const r of unexpected) {
    const s = out.get(r.checkId);
    if (s) s.unexpectedCount = r._count._all;
  }
  return out;
}

export async function listChecks() {
  const checks = await prisma.pathCheck.findMany({ orderBy: { name: "asc" } });
  const sums = await summariesFor(checks.map((c) => c.id));
  return checks.map((c) => ({
    ...c,
    ...(sums.get(c.id) ?? EMPTY_SUMMARY),
  }));
}

/** The id → name/kind registry the automation builder renders path* sentences
 *  and the checkId picker from (GET /automations/schema). No sources, no
 *  results — the builder needs names, and it is read on every wizard open. */
export async function listCheckCatalog() {
  return prisma.pathCheck.findMany({
    select: { id: true, name: true, kind: true, target: true, enabled: true },
    orderBy: { name: "asc" },
  });
}

export async function getCheck(id: string) {
  const check = await prisma.pathCheck.findUnique({ where: { id } });
  if (!check) throw new AppError(404, "Path check not found");
  const sums = await summariesFor([id]);
  return { ...check, ...(sums.get(id) ?? EMPTY_SUMMARY) };
}

async function assertEnabledCap(excludeId?: string): Promise<void> {
  const n = await prisma.pathCheck.count({ where: { enabled: true, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (n >= MAX_ENABLED_CHECKS) {
    throw new AppError(409, `At most ${MAX_ENABLED_CHECKS} path checks can be enabled at once`);
  }
}

function jsonOf<T>(v: T): object {
  return v as unknown as object;
}

/**
 * Who may point the SERVER at a target. A server-run check probes from the
 * Polaris server's own network position — often a management segment no agent
 * host sits on — and an HTTP check hands back what came back (the excerpt).
 * That is the Discovery key's concern (an operator-chosen sweep from the
 * server), so directing the server needs `networkScan:write` ON TOP of
 * `pathChecks:write` — the chained-gate precedent of POST /network-scans/…/adopt.
 * The route answers `mayRunOnServer` from the caller's matrix.
 */
export interface CheckWriteOpts {
  mayRunOnServer?: boolean;
  /** The caller's `credentials` level — any rung (read and up) may USE a stored secret. */
  credentialAccess?: "none" | "read" | "write" | "fullwrite";
}

export const CREDENTIAL_USE_MESSAGE =
  "Using a stored credential in a path check needs at least Read-Only on Credentials";

/**
 * Pointing a stored secret at an operator-chosen target is USING it. The
 * operator's decision (2026-09-30): anyone who can SEE the credential list
 * (`credentials:read`) may pick any credential for a check and test with it —
 * deliberately looser than credential test-by-id (business rule 43, own rows
 * at write), because a path check is aimed by someone who already holds
 * pathChecks:write AND networkScan:write. Changing the credential itself stays
 * on the Credentials page's own ownership rules. What still holds: the secret
 * never leaves the server (no agent source), never follows a redirect off the
 * target's origin, and every create / re-aim / test is audited with the
 * credential id.
 */
async function assertMayUseCredential(_credentialId: string, opts: CheckWriteOpts | undefined): Promise<void> {
  const level = opts?.credentialAccess ?? "none";
  if (level === "read" || level === "write" || level === "fullwrite") return;
  throw new AppError(403, CREDENTIAL_USE_MESSAGE);
}

export const SERVER_SOURCE_PERMISSION_MESSAGE =
  "Running a check from this Polaris server also needs Read-Write on Network Discovery — ask an administrator, or run it from agent hosts only";

function assertMayRunOnServer(opts: CheckWriteOpts | undefined): void {
  if (!opts?.mayRunOnServer) throw new AppError(403, SERVER_SOURCE_PERMISSION_MESSAGE);
}

export async function createCheck(input: PathCheckInput, actor?: string, opts?: CheckWriteOpts) {
  const n = await normalizeCheckInput(input);
  if (n.runOnServer) assertMayRunOnServer(opts);
  if (n.credentialId) await assertMayUseCredential(n.credentialId, opts);
  if (n.enabled) await assertEnabledCap();
  const dupe = await prisma.pathCheck.findUnique({ where: { name: n.name } });
  if (dupe) throw new AppError(409, `A path check named "${n.name}" already exists`);
  const id = randomUUID();
  const sha = definitionSha256({ id, ...n, http: n.http, traceroute: n.traceroute });
  const check = await prisma.pathCheck.create({
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
      runOnServer: n.runOnServer,
      sourceFilter: n.sourceFilter ? jsonOf(n.sourceFilter) : Prisma.DbNull,
      credentialId: n.credentialId,
      definitionSha256: sha,
      createdBy: actor ?? null,
    },
  });
  await logEvent({
    action: "path_check.created",
    resourceType: "path-check",
    resourceId: check.id,
    resourceName: check.name,
    actor,
    // Always audit-worthy: a new check directs agents to send traffic.
    level: "warning",
    message: `Path check "${check.name}" created (${check.kind} ${check.target}, every ${check.intervalSec / 60} min)`,
    details: { kind: check.kind, target: check.target, intervalSec: check.intervalSec, runOnServer: check.runOnServer, credentialId: check.credentialId },
  });
  await reconcilePathCheckSources(check.id, { refreshAllMembers: true });
  return getCheck(check.id);
}

export async function updateCheck(id: string, input: PathCheckInput, actor?: string, opts?: CheckWriteOpts) {
  const existing = await prisma.pathCheck.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Path check not found");
  const n = await normalizeCheckInput(input);
  if (n.enabled && !existing.enabled) await assertEnabledCap(id);
  if (n.name !== existing.name) {
    const dupe = await prisma.pathCheck.findUnique({ where: { name: n.name } });
    if (dupe) throw new AppError(409, `A path check named "${n.name}" already exists`);
  }
  const sha = definitionSha256({ id, ...n, http: n.http, traceroute: n.traceroute });
  // Anything that makes the SERVER send different traffic — turning it on,
  // re-aiming it, re-enabling it — needs the chained key. Renaming a server-run
  // check, editing its Sources or turning the server OFF does not. (The name
  // is part of the agent definition hash, so compare with it blanked.)
  const traffic = (row: CheckDefinitionRow) => definitionSha256({ ...row, name: "" });
  const reAimed = traffic({ id, ...n }) !== traffic({ ...existing, id });
  if (n.runOnServer && (!existing.runOnServer || reAimed || (n.enabled && !existing.enabled))) {
    assertMayRunOnServer(opts);
  }
  // A new credential, or the same one aimed somewhere new, is a new USE of it.
  if (n.credentialId && (n.credentialId !== existing.credentialId || reAimed)) {
    await assertMayUseCredential(n.credentialId, opts);
  }
  const targetChanged = existing.target !== n.target || existing.kind !== n.kind;
  const check = await prisma.pathCheck.update({
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
      runOnServer: n.runOnServer,
      sourceFilter: n.sourceFilter ? jsonOf(n.sourceFilter) : Prisma.DbNull,
      credentialId: n.credentialId,
      definitionSha256: sha,
    },
  });
  await logEvent({
    action: "path_check.updated",
    resourceType: "path-check",
    resourceId: id,
    resourceName: check.name,
    actor,
    level: targetChanged ? "warning" : "info",
    message: targetChanged
      ? `Path check "${check.name}" TARGET changed: ${existing.kind} ${existing.target} → ${check.kind} ${check.target}`
      : `Path check "${check.name}" updated`,
    details: {
      previousTarget: existing.target, target: check.target,
      previousKind: existing.kind, kind: check.kind,
      definitionChanged: sha !== existing.definitionSha256,
      enabled: check.enabled,
      runOnServer: check.runOnServer,
      ...(existing.runOnServer !== check.runOnServer ? { previousRunOnServer: existing.runOnServer } : {}),
      credentialId: check.credentialId,
      ...(existing.credentialId !== check.credentialId ? { previousCredentialId: existing.credentialId } : {}),
    },
  });
  // A changed path makes every stored path hash describe a different target;
  // forget them so the first new traceroute is a baseline, not a "change".
  if (targetChanged) {
    await prisma.pathCheckSource.updateMany({
      where: { checkId: id },
      data: { lastPathHash: null, lastOk: null, lastHopCount: null, lastTracerouteComplete: null },
    });
  }
  await reconcilePathCheckSources(id, {
    refreshAllMembers: sha !== existing.definitionSha256 || check.enabled !== existing.enabled,
  });
  return getCheck(id);
}

export async function setCheckEnabled(id: string, enabled: boolean, actor?: string, opts?: CheckWriteOpts) {
  const existing = await prisma.pathCheck.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Path check not found");
  if (existing.enabled === enabled) return getCheck(id);
  if (enabled && existing.runOnServer) assertMayRunOnServer(opts);
  if (enabled) await assertEnabledCap(id);
  await prisma.pathCheck.update({ where: { id }, data: { enabled } });
  await logEvent({
    action: enabled ? "path_check.enabled" : "path_check.disabled",
    resourceType: "path-check",
    resourceId: id,
    resourceName: existing.name,
    actor,
    message: `Path check "${existing.name}" ${enabled ? "enabled" : "disabled"}`,
  });
  await reconcilePathCheckSources(id, { refreshAllMembers: true });
  return getCheck(id);
}

export async function deleteCheck(id: string, actor?: string) {
  const existing = await prisma.pathCheck.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Path check not found");
  const members = await prisma.pathCheckSource.findMany({
    where: { checkId: id },
    select: { asset: { select: { managedAgent: { select: { id: true } } } } },
  });
  // Sources cascade. Samples and traceroutes are NOT deleted: they live in
  // compressed hypertable chunks, and a row DELETE there decompresses the
  // chunk (the 2026-06-08 incident). They age out on the retention schedule.
  await prisma.pathCheck.delete({ where: { id } });
  await logEvent({
    action: "path_check.deleted",
    resourceType: "path-check",
    resourceId: id,
    resourceName: existing.name,
    actor,
    level: "warning",
    message: `Path check "${existing.name}" deleted (${existing.kind} ${existing.target})`,
    details: { kind: existing.kind, target: existing.target },
  });
  await publishConfigRefresh(members.map((m) => m.asset?.managedAgent?.id ?? "").filter(Boolean));
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
 * Rebuild `path_check_sources` for one check (a write path) or all of
 * them (the 5-minute job). Batched throughout — one agent query, one source
 * query, then createMany / deleteMany / updateMany — so the 2000-host fleet
 * costs a handful of statements per check, never a query per host.
 *
 * Disabled checks keep their membership: the fleet view still shows their
 * last results, and GET /agents/config filters on `enabled`.
 */
export async function reconcilePathCheckSources(
  checkId?: string,
  opts: { refreshAllMembers?: boolean } = {},
): Promise<ReconcileResult> {
  const checks = await prisma.pathCheck.findMany({
    where: checkId ? { id: checkId } : {},
    select: { id: true, name: true, scope: true, assetIds: true, runOnServer: true, credentialId: true },
  });
  const result: ReconcileResult = { checks: checks.length, added: 0, removed: 0, refreshedAgents: 0 };
  if (checks.length === 0) return result;
  const agents = await activeAgents();
  const existing = await prisma.pathCheckSource.findMany({
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
  const toCreate: { checkId: string; assetId: string | null; explicit: boolean }[] = [];
  const toDelete: string[] = [];
  const toExplicit: string[] = [];
  const toImplicit: string[] = [];
  for (const c of checks) {
    // An authenticating check is server-only: no agent is ever a member, whatever
    // its stored scope says (normalizeCheckInput already refuses one).
    const { members } = c.credentialId
      ? { members: new Map<string, { explicit: boolean; agent: ActiveAgent }>() }
      : await membersFor((c.scope ?? {}) as RuleScope, c.assetIds, agents);
    const rows = byCheck.get(c.id) ?? [];
    // The server's own row (assetId NULL) follows runOnServer and nothing else.
    // No agent to refresh: the server job reads the definitions directly.
    const serverRows = rows.filter((s) => s.assetId === null);
    if (c.runOnServer && serverRows.length === 0) toCreate.push({ checkId: c.id, assetId: null, explicit: true });
    for (const row of c.runOnServer ? serverRows.slice(1) : serverRows) toDelete.push(row.id);
    const have = new Map(rows.filter((s) => s.assetId !== null).map((s) => [s.assetId as string, s]));
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
  if (toCreate.length) ops.push(prisma.pathCheckSource.createMany({ data: toCreate, skipDuplicates: true }));
  if (toDelete.length) ops.push(prisma.pathCheckSource.deleteMany({ where: { id: { in: toDelete } } }));
  if (toExplicit.length) ops.push(prisma.pathCheckSource.updateMany({ where: { id: { in: toExplicit } }, data: { explicit: true } }));
  if (toImplicit.length) ops.push(prisma.pathCheckSource.updateMany({ where: { id: { in: toImplicit } }, data: { explicit: false } }));
  ops.push(prisma.pathCheck.updateMany({ where: { id: { in: checks.map((c) => c.id) } }, data: { lastReconciledAt: new Date() } }));
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
  const rows = await prisma.pathCheckSource.groupBy({
    by: ["assetId"],
    // The server's own rows are no agent's: it runs every check it is given.
    where: { check: { enabled: true }, assetId: { not: null } },
    _count: { _all: true },
    having: { assetId: { _count: { gt: MAX_CHECKS_PER_AGENT } } },
  });
  const now = new Set(rows.map((r) => r.assetId).filter((id): id is string => id !== null));
  const fresh = [...now].filter((id) => !_overCapLast.has(id));
  if (fullPass) _overCapLast = now;
  else for (const id of fresh) _overCapLast.add(id);
  if (fresh.length === 0) return;
  const assets = await prisma.asset.findMany({ where: { id: { in: fresh } }, select: { id: true, hostname: true, ipAddress: true } });
  await Promise.all(assets.map((a) => {
    const count = rows.find((r) => r.assetId === a.id)?._count._all ?? 0;
    return logEvent({
      action: "path_check.agent_over_cap",
      resourceType: "asset",
      resourceId: a.id,
      resourceName: a.hostname || a.ipAddress || a.id,
      level: "warning",
      message: `${a.hostname || a.ipAddress} matches ${count} enabled path checks; its agent runs only the oldest ${MAX_CHECKS_PER_AGENT}`,
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

// ─── Test run (the wizard's Expectations step) ──────────────────────────────

/** Test runs a caller may start per minute — each is a request FROM the server. */
export const TEST_RUNS_PER_MINUTE = 10;
const _testRuns = new Map<string, number[]>();

/** Test seam. */
export function _resetTestRunLimiter(): void {
  _testRuns.clear();
}

/**
 * Run a DRAFT check once from this Polaris server and return what came back —
 * the verdict under the draft's expectations, the timings, and (HTTP/HTTPS)
 * the response headers and the first 64 KB of the body — so the operator can
 * write the expectation from the real answer. Nothing is stored but an audit
 * Event. The same gate as aiming the server (networkScan:write): a test IS a
 * request from the server's network position. Rate-limited per caller.
 */
export async function testCheck(input: PathCheckInput, actor?: string, opts?: CheckWriteOpts) {
  assertMayRunOnServer(opts);
  const who = actor ?? "anonymous";
  const now = Date.now();
  const recent = (_testRuns.get(who) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= TEST_RUNS_PER_MINUTE) {
    throw new AppError(429, `At most ${TEST_RUNS_PER_MINUTE} test runs a minute — wait a moment and try again`);
  }
  recent.push(now);
  _testRuns.set(who, recent);

  // A draft on step 2 may have no name or Sources yet; neither changes what
  // the probe sends, so the validator gets harmless stand-ins for both.
  // A credential makes the stored check server-only; for a TEST the draft's
  // agent Sources are irrelevant, so drop them rather than refuse.
  const n = await normalizeCheckInput({
    ...input, name: input.name?.trim() || "Test run", runOnServer: true,
    ...(input.credentialId ? { scope: {}, assetIds: [] } : {}),
  });
  if (n.credentialId) await assertMayUseCredential(n.credentialId, opts);
  const def = toAgentCheckDef({
    id: "test", ...n,
    keepBodyExcerpt: true,
    traceroute: { ...n.traceroute, enabled: false },
  });
  const capture: RunCapture = {};
  const auth = await loadServerCheckAuth(n.credentialId);
  const { sample } = await runServerCheck(def, "never", undefined, capture, auth);
  await logEvent({
    action: "path_check.tested",
    resourceType: "path-check",
    resourceName: n.name,
    actor,
    level: "info",
    message: `Path check test run from the Polaris server: ${n.kind} ${n.target} → ${sample.ok ? "passed" : "failed"}${sample.httpStatus != null ? ` (HTTP ${sample.httpStatus})` : ""}`,
    details: { kind: n.kind, target: n.target, ok: sample.ok, httpStatus: sample.httpStatus ?? null, error: sample.error ?? null, credentialId: n.credentialId },
  });
  return {
    source: "server" as const,
    sample,
    headers: capture.headers ?? null,
    httpVersion: capture.httpVersion ?? null,
    body: capture.body ?? null,
    // Only when redirects moved it — the URL the verdict was judged on.
    finalUrl: capture.finalUrl && capture.finalUrl !== new URL(n.target).toString() ? capture.finalUrl : null,
  };
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
    // Every member, not just the rows shown, so the wizard's Select all can
    // tick hosts past PREVIEW_ROW_CAP (the pin list caps at 2000 anyway).
    ids: ids.slice(0, 2000),
    pinned: ids.filter((id) => members.get(id)!.explicit).length,
    matchedWithoutAgent: matchedNoAgent,
    agents: assets.map((a) => ({
      assetId: a.id,
      hostname: a.hostname,
      ipAddress: a.ipAddress,
      os: a.os,
      agentVersion: a.managedAgent?.agentVersion ?? null,
      online: a.managedAgent ? agentOnline(a.managedAgent) : false,
      supported: versionAtLeast(a.managedAgent?.agentVersion, MIN_AGENT_PATH_CHECK_VERSION),
      pinned: members.get(a.id)?.explicit === true,
      pinnedOnly: members.get(a.id)?.explicit === true && !filterIds.has(a.id),
    })),
    pinnedWithoutAgent: missing.map((a) => ({ assetId: a.id, hostname: a.hostname, ipAddress: a.ipAddress })),
    minAgentVersion: MIN_AGENT_PATH_CHECK_VERSION,
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
  const check = await prisma.pathCheck.findUnique({
    where: { id: checkId },
    select: { id: true, name: true, kind: true, target: true, intervalSec: true, timeoutMs: true, http: true, traceroute: true, keepBodyExcerpt: true },
  });
  if (!check) throw new AppError(404, "Path check not found");
  // An agent below the version THIS definition needs is a member that runs nothing.
  const needs = requiredAgentVersion(agentDefCore(check));
  const rows = await prisma.pathCheckSource.findMany({
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
  const hosts = rows
    .filter((r) => r.asset !== null)
    .map(({ asset, ...s }) => ({
      ...s,
      server: false,
      hostname: asset!.hostname,
      ipAddress: asset!.ipAddress,
      os: asset!.os,
      agentVersion: asset!.managedAgent?.agentVersion ?? null,
      online: asset!.managedAgent ? agentOnline(asset!.managedAgent) : false,
      supported: versionAtLeast(asset!.managedAgent?.agentVersion, needs),
      requiredAgentVersion: needs,
    }))
    .sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
  // The server's own row leads: it is the one source every operator has.
  const server = rows
    .filter((r) => r.asset === null)
    .map(({ asset: _asset, ...s }) => ({
      ...s,
      server: true,
      hostname: POLARIS_SERVER_LABEL,
      ipAddress: null,
      os: null,
      agentVersion: null,
      online: true,
      supported: true,
    }));
  return [...server, ...hosts];
}

/**
 * One check as the SERVER runs it — the same `{checks: [...]}` shape as
 * getAssetChecks, so the slide-over's Paths renderer draws it unchanged. An
 * empty list when the check does not run on the server.
 */
export async function getServerCheck(checkId: string) {
  const row = await prisma.pathCheckSource.findFirst({
    where: { checkId, assetId: null },
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
  if (!row) {
    const exists = await prisma.pathCheck.findUnique({ where: { id: checkId }, select: { id: true } });
    if (!exists) throw new AppError(404, "Path check not found");
    return { checks: [] };
  }
  const latestSample = await prisma.assetPathCheckSample.findFirst({
    where: { assetId: POLARIS_SERVER_SUBJECT, checkId },
    orderBy: { timestamp: "desc" },
    select: {
      timestamp: true, ok: true, latencyMs: true, dnsMs: true, connectMs: true, tlsMs: true, ttfbMs: true,
      httpStatus: true, bodyMatched: true, bodySha256: true, bodyBytes: true, bodyExcerpt: true,
      error: true, resolvedIp: true, tlsNotAfter: true, tlsIssuer: true,
    },
  });
  const { check, ...latest } = row;
  return { checks: [{ ...check, latest, latestSample }] };
}

/** The newest traceroutes the SERVER ran for one check (the asset route's twin). */
export async function listServerTraceroutes(checkId: string, limit: number) {
  const exists = await prisma.pathCheck.findUnique({ where: { id: checkId }, select: { id: true } });
  if (!exists) throw new AppError(404, "Path check not found");
  return prisma.assetPathCheckTraceroute.findMany({
    where: { assetId: POLARIS_SERVER_SUBJECT, checkId },
    orderBy: { timestamp: "desc" },
    take: Math.min(50, Math.max(1, limit)),
  });
}

/**
 * The definitions the server job runs: every ENABLED check with a server
 * source row, in the agent's wire shape (the runner mirrors the agent's probe,
 * so it reads the same definition). No per-host cap — the fleet-wide
 * MAX_ENABLED_CHECKS already bounds it.
 */
/** A server-run definition: the agent's wire shape plus the server-only credential. */
export type ServerCheckDef = AgentCheckDef & { credentialId: string | null };

export async function serverCheckDefinitions(): Promise<ServerCheckDef[]> {
  const rows = await prisma.pathCheckSource.findMany({
    where: { assetId: null, check: { enabled: true, runOnServer: true } },
    select: {
      check: {
        select: {
          id: true, name: true, kind: true, target: true, intervalSec: true, timeoutMs: true,
          http: true, traceroute: true, keepBodyExcerpt: true, definitionSha256: true, createdAt: true, credentialId: true,
        },
      },
    },
  });
  return rows
    .map((r) => r.check)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    // The credential is part of the revision key so re-pointing it re-baselines.
    .map((c) => {
      const d = toAgentCheckDef(c);
      return { ...d, revision: c.credentialId ? `${d.revision}:${c.credentialId}` : d.revision, credentialId: c.credentialId };
    });
}

/**
 * The auth a server run presents, opened from the credential (the Prisma
 * client opens sealed values on read). Null for an unauthenticated check, or
 * one whose credential no longer resolves to a usable mode.
 */
export async function loadServerCheckAuth(credentialId: string | null): Promise<HttpAuthConfig | null> {
  if (!credentialId) return null;
  const cred = await prisma.credential.findUnique({ where: { id: credentialId }, select: { type: true, config: true } });
  if (!cred || cred.type !== "http") return null;
  const cfg = (cred.config ?? {}) as HttpAuthConfig;
  const mode = resolveHttpAuthMode(cfg);
  if (!(PATH_CHECK_AUTH_MODES as readonly string[]).includes(mode)) return null;
  return { authMode: mode, username: cfg.username, password: cfg.password, apiToken: cfg.apiToken };
}

/** The checks one host runs, with its latest result for each. */
export async function getAssetChecks(assetId: string) {
  const rows = await prisma.pathCheckSource.findMany({
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
  // The newest SAMPLE per check — the body fingerprint, TLS facts and (on a
  // failed run, or a check that keeps them) the excerpt live there, not on the
  // source row. One indexed findFirst per check; a host runs at most
  // MAX_CHECKS_PER_AGENT, and this serves one slide-over open.
  const newest = await Promise.all(rows.map((r) => prisma.assetPathCheckSample.findFirst({
    where: { assetId, checkId: r.checkId },
    orderBy: { timestamp: "desc" },
    select: {
      timestamp: true, ok: true, latencyMs: true, dnsMs: true, connectMs: true, tlsMs: true, ttfbMs: true,
      httpStatus: true, bodyMatched: true, bodySha256: true, bodyBytes: true, bodyExcerpt: true,
      error: true, resolvedIp: true, tlsNotAfter: true, tlsIssuer: true,
    },
  })));
  return {
    checks: rows
      .map(({ check, ...latest }, i) => ({ ...check, latest, latestSample: newest[i] }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The definitions GET /agents/config ships to one agent: enabled checks it is
 * a member of, oldest first, capped at MAX_CHECKS_PER_AGENT — and NONE for an
 * agent older than MIN_AGENT_PATH_CHECK_VERSION, which would ignore the
 * field anyway and whose operator should see "upgrade" rather than silence.
 */
export async function agentConfigChecks(assetId: string, agentVersion: string | null | undefined): Promise<AgentCheckDef[]> {
  if (!versionAtLeast(agentVersion, MIN_AGENT_PATH_CHECK_VERSION)) return [];
  const rows = await prisma.pathCheckSource.findMany({
    // credentialId: null — defence in depth: an authenticating check never has
    // an agent source, and is never shipped to one if a row somehow exists.
    where: { assetId, check: { enabled: true, credentialId: null } },
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
    .map((c) => toAgentCheckDef(c))
    // A definition this agent would half-understand is not shipped at all.
    .filter((d) => versionAtLeast(agentVersion, requiredAgentVersion(d)));
}

/** The compact fold both config ETags carry: check id + revision, in order. */
export function pathCheckEtagFold(defs: readonly AgentCheckDef[]): string {
  return defs.map((d) => `${d.id}:${d.revision}`).join("\u0001");
}
