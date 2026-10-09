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
import { isValidIpAddress } from "../utils/cidr.js";
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
] as const;
export type GenericApiField = (typeof GENERIC_API_FIELDS)[number];

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
export function findInvalidPath(config: Pick<GenericApiConfig, "recordsPath" | "fieldMap" | "pagination">): string | null {
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
  return problems.find((p) => p !== null) ?? null;
}

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
export function mapGenericRecord(raw: Record<string, unknown>, config: GenericApiConfig): GenericApiMapOutcome {
  const fm = config.fieldMap ?? {};
  const read = (f: GenericApiField): string | null => readJsonPathString(raw, fm[f]);

  const ipCandidates = readJsonPathStrings(raw, fm.ipAddress);
  // Only an ADDRESS is an address: "10.0.0.5/24" is trimmed to its host, a
  // name or a URL is ignored rather than written into Asset.ipAddress.
  const ipAddress = ipCandidates
    .map((s) => s.split("/")[0].trim())
    .find((s) => isValidIpAddress(s)) ?? null;
  const macs = normalizeMacsDistinct(readJsonPathStrings(raw, fm.macAddress));
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
  const identitySource =
    identityField === "id" ? read("id")
    : identityField === "serialNumber" ? serialNumber
    : identityField === "macAddress" ? (macs[0] ?? null)
    : hostname;
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
    },
  };
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
export function buildRequestUrl(config: GenericApiConfig): URL {
  if (!config.host?.trim()) throw new AppError(400, "Host is required");
  assertOutboundHostAllowed(config.host);
  const path = (config.path ?? "").trim() || "/";
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
  opts: { signal?: AbortSignal; onProgress?: ProgressFn; maxPagesOverride?: number; maxRecordsOverride?: number } = {},
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
  const oauthToken = config.authType === "oauth2" ? await fetchOauthToken(config, opts.signal) : null;
  const headers = buildAuthHeaders(config, oauthToken);
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
  warnings: string[];
}

export async function discoverGenericApi(
  config: GenericApiConfig,
  signal?: AbortSignal,
  onProgress?: ProgressFn,
): Promise<GenericApiDiscoveryResult> {
  const fetched = await fetchGenericApiRecords(config, { signal, onProgress });
  const include = (config.deviceInclude ?? []).filter((s) => s.trim());
  const exclude = (config.deviceExclude ?? []).filter((s) => s.trim());
  const records: GenericApiMappedRecord[] = [];
  const present = new Set<string>();
  const unmappedReasons: string[] = [];
  let unmapped = 0;
  let duplicates = 0;
  let filtered = 0;
  fetched.records.forEach((raw, i) => {
    const outcome = mapGenericRecord(raw, config);
    if (!outcome.ok) {
      unmapped++;
      if (unmappedReasons.length < 5) unmappedReasons.push(`record ${i + 1}: ${outcome.reason}`);
      return;
    }
    const r = outcome.record;
    if (present.has(r.identity)) { duplicates++; return; }
    present.add(r.identity);
    if (!passesDeviceFilter(r.hostname, include, exclude)) { filtered++; return; }
    records.push(r);
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
    warnings: fetched.warnings,
  };
}

export interface GenericApiTestResult {
  ok: boolean;
  message: string;
}

/** One page, mapped. Succeeds only when the records path finds records and at least one maps. */
export async function testConnection(config: GenericApiConfig): Promise<GenericApiTestResult> {
  try {
    const bad = findInvalidPath(config);
    if (bad) return { ok: false, message: bad };
    const fetched = await fetchGenericApiRecords(config, { maxPagesOverride: 1 });
    if (fetched.records.length === 0) {
      return {
        ok: false,
        message: `Connected, but the records path ${config.recordsPath ? `"${config.recordsPath}"` : "(the response root)"} found no records on the first page`,
      };
    }
    const mapped = fetched.records.filter((r) => mapGenericRecord(r, config).ok).length;
    if (mapped === 0) {
      const first = mapGenericRecord(fetched.records[0], config);
      return { ok: false, message: `Connected and read ${fetched.records.length} record(s), but none mapped: ${first.ok ? "" : first.reason}` };
    }
    return { ok: true, message: `Connected — first page: ${fetched.records.length} record(s), ${mapped} mapped` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Connection failed" };
  }
}

export interface GenericApiPreview {
  ok: boolean;
  message: string;
  /** The first raw record, so the operator can write paths against it. */
  sampleRecord: Record<string, unknown> | null;
  /** Up to `limit` records as they would be written (or why not). */
  rows: Array<{ index: number; outcome: GenericApiMapOutcome; filteredOut: boolean }>;
  recordsOnFirstPage: number;
  warnings: string[];
}

/** First page only — the Preview tab's answer to "what would discovery write?". */
export async function previewGenericApi(config: GenericApiConfig, limit = 10): Promise<GenericApiPreview> {
  const bad = findInvalidPath(config);
  if (bad) return { ok: false, message: bad, sampleRecord: null, rows: [], recordsOnFirstPage: 0, warnings: [] };
  try {
    const fetched = await fetchGenericApiRecords(config, { maxPagesOverride: 1 });
    const include = (config.deviceInclude ?? []).filter((s) => s.trim());
    const exclude = (config.deviceExclude ?? []).filter((s) => s.trim());
    const rows = fetched.records.slice(0, Math.max(1, Math.min(limit, 50))).map((raw, index) => {
      const outcome = mapGenericRecord(raw, config);
      const filteredOut = outcome.ok && !passesDeviceFilter(outcome.record.hostname, include, exclude);
      return { index, outcome, filteredOut };
    });
    const mapped = rows.filter((r) => r.outcome.ok).length;
    return {
      ok: fetched.records.length > 0 && mapped > 0,
      message: fetched.records.length === 0
        ? "Connected, but the records path found no records on the first page"
        : `First page: ${fetched.records.length} record(s); showing ${rows.length}, ${mapped} mapped`,
      sampleRecord: fetched.records[0] ?? null,
      rows,
      recordsOnFirstPage: fetched.records.length,
      warnings: fetched.warnings,
    };
  } catch (err: any) {
    return { ok: false, message: err?.message || "Request failed", sampleRecord: null, rows: [], recordsOnFirstPage: 0, warnings: [] };
  }
}
