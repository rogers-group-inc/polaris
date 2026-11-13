/**
 * src/services/arcgisService.ts — the client for an ArcGIS integration
 * (ArcGIS Online, ArcGIS Location Platform or an ArcGIS Enterprise portal).
 *
 * The integration discovers nothing (adapter `discovery: null`). It is the one
 * place Polaris signs in to an ArcGIS portal, for two later uses: satellite
 * imagery for the Device Map, and writing cable runs back to a hosted feature
 * layer. This file owns the sign-in, the REST transport and the connection test.
 *
 * Sign-in methods (`authMode`):
 *   - "none"           — no token; only public services answer (Esri World Imagery).
 *   - "apiKey"         — a developer API key (stored as `apiToken`), sent as `token`.
 *   - "appCredentials" — OAuth 2.0 client credentials (`clientId` + `clientSecret`)
 *                        exchanged at `<portal>/sharing/rest/oauth2/token`.
 *   - "userPassword"   — a named user (`username` + `password`) exchanged at
 *                        `<portal>/sharing/rest/generateToken` (ArcGIS Enterprise).
 * Short-lived tokens are cached per process until a minute before they expire.
 *
 * Transport: undici fetch through `tlsFetch` (verifySsl false = certificate
 * pinning, rule 113(e)), redirects refused so a token never follows a redirect
 * to another host, a timeout per request, and a cap on the response size. The
 * ArcGIS REST API answers most errors with HTTP 200 and an `{ error }` body;
 * `arcgisRequest` turns those into an `ArcgisError`.
 */

import type { RequestInit } from "undici";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { tlsFetch } from "../utils/tlsDispatcher.js";

export const ARCGIS_ONLINE_PORTAL = "https://www.arcgis.com";
export const ARCGIS_AUTH_MODES = ["none", "apiKey", "appCredentials", "userPassword"] as const;
type ArcgisAuthMode = (typeof ARCGIS_AUTH_MODES)[number];

export interface ArcgisConfig {
  portalUrl?: string;
  authMode?: ArcgisAuthMode;
  apiToken?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  verifySsl?: boolean;
  verboseLogging?: boolean;
  // The satellite basemap (rule 183). Flat keys, not a nested block, so
  // `imageryUrl` is a rule-111 destination key like any other address a token
  // is sent to.
  basemapEnabled?: boolean;
  basemapSource?: ArcgisBasemapSource;
  imageryUrl?: string;
  basemapAttribution?: string;
  basemapMaxZoom?: number;
}

export const ARCGIS_BASEMAP_SOURCES = ["world_imagery", "service"] as const;
type ArcgisBasemapSource = (typeof ARCGIS_BASEMAP_SOURCES)[number];

/** Esri World Imagery, public (no token) and the keyed Location Platform host. */
const WORLD_IMAGERY_PUBLIC = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const WORLD_IMAGERY_KEYED = "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer";
export const WORLD_IMAGERY_ATTRIBUTION = "Esri, Maxar, Earthstar Geographics, and the GIS User Community";

/** An error the ArcGIS REST API answered (or the transport hit). */
export class ArcgisError extends Error {
  constructor(message: string, readonly code?: number, readonly details?: string[]) {
    super(message);
    this.name = "ArcgisError";
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Requested lifetime of a short-lived token, minutes. */
const TOKEN_LIFETIME_MIN = 120;
/** A cached token is renewed this long before it expires. */
const TOKEN_RENEW_MARGIN_MS = 60_000;

// ─── Portal URL ──────────────────────────────────────────────────────────────

/**
 * Why a portal URL cannot be used, or null. https only; no credentials, query
 * or fragment; a host outside the blocked ranges (loopback / link-local /
 * metadata / multicast — netGuard).
 */
export function portalUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return "Portal URL must be a full address, e.g. https://www.arcgis.com"; }
  if (u.protocol !== "https:") return "Portal URL must start with https://";
  if (u.username || u.password) return "Portal URL may not contain a user name or password";
  if (u.search || u.hash) return "Portal URL may not contain a query (?…) or fragment (#…)";
  if (isBlockedOutboundHost(u.hostname)) {
    return `Portal host "${u.hostname}" is in a blocked range (loopback / link-local / metadata / multicast)`;
  }
  return null;
}

/**
 * Why an imagery service URL cannot be used, or null: https, no credentials /
 * query / fragment, a host outside the blocked ranges, and a path ending in a
 * cached MapServer or ImageServer (its tiles are `<url>/tile/{z}/{y}/{x}`).
 */
export function imageryUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return "Imagery service URL must be a full address ending in /MapServer or /ImageServer"; }
  if (u.protocol !== "https:") return "Imagery service URL must start with https://";
  if (u.username || u.password) return "Imagery service URL may not contain a user name or password";
  if (u.search || u.hash) return "Imagery service URL may not contain a query (?…) or fragment (#…)";
  if (isBlockedOutboundHost(u.hostname)) {
    return `Imagery host "${u.hostname}" is in a blocked range (loopback / link-local / metadata / multicast)`;
  }
  if (!/\/(MapServer|ImageServer)$/i.test(u.pathname.replace(/\/+$/, ""))) {
    return "Imagery service URL must end in /MapServer or /ImageServer";
  }
  return null;
}

/**
 * The imagery service a config's basemap draws from, and whether the token is
 * sent to it. World Imagery: the keyed host with an API key, the public host
 * otherwise (no token goes there). A portal service always gets the token.
 */
export function basemapService(config: ArcgisConfig): { root: string; sendToken: boolean } {
  if ((config.basemapSource ?? "world_imagery") === "service") {
    return { root: (config.imageryUrl ?? "").trim().replace(/\/+$/, ""), sendToken: (config.authMode ?? "apiKey") !== "none" };
  }
  return (config.authMode ?? "apiKey") === "apiKey" && config.apiToken
    ? { root: WORLD_IMAGERY_KEYED, sendToken: true }
    : { root: WORLD_IMAGERY_PUBLIC, sendToken: false };
}

/** The upstream address of one imagery tile (ArcGIS tile order is z / y / x). */
export function basemapTileUrl(config: ArcgisConfig, token: string | null, z: number, x: number, y: number): string {
  const { root, sendToken } = basemapService(config);
  const url = `${root}/tile/${z}/${y}/${x}`;
  return sendToken && token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

/** The portal's base URL with no trailing slash (ArcGIS Online when unset). */
export function portalBase(config: ArcgisConfig): string {
  const raw = (config.portalUrl ?? "").trim() || ARCGIS_ONLINE_PORTAL;
  return raw.replace(/\/+$/, "");
}

/** `<portal>/sharing/rest` — the portal's REST root. */
function sharingRest(config: ArcgisConfig): string {
  return `${portalBase(config)}/sharing/rest`;
}

// ─── Transport ───────────────────────────────────────────────────────────────

export interface ArcgisHttpRequest {
  url: string;
  method: "GET" | "POST";
  /** application/x-www-form-urlencoded body (POST). */
  form?: Record<string, string>;
  verifySsl: boolean;
}
interface ArcgisHttpResponse { status: number; body: string }
type RequestImpl = (req: ArcgisHttpRequest) => Promise<ArcgisHttpResponse>;

async function defaultRequest(req: ArcgisHttpRequest): Promise<ArcgisHttpResponse> {
  const init: RequestInit = {
    method: req.method,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  };
  if (req.form) {
    init.body = new URLSearchParams(req.form).toString();
    init.headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  }
  const res = await tlsFetch(req.url, init, req.verifySsl);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_RESPONSE_BYTES) throw new ArcgisError(`ArcGIS answered ${len} bytes — more than the ${MAX_RESPONSE_BYTES}-byte limit`);
  const body = await res.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new ArcgisError(`ArcGIS answered more than the ${MAX_RESPONSE_BYTES}-byte limit`);
  return { status: res.status, body };
}

let requestImpl: RequestImpl = defaultRequest;

/** Test seam: replace the HTTP transport (null restores the real one). */
export function _setRequestImplForTests(impl: RequestImpl | null): void {
  requestImpl = impl ?? defaultRequest;
  tokenCache.clear();
}

/** The message of an `{ error: { code, message, details } }` body, or null. */
function restError(json: unknown): ArcgisError | null {
  if (!json || typeof json !== "object") return null;
  const err = (json as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; message?: unknown; details?: unknown };
  const details = Array.isArray(e.details) ? e.details.filter((d): d is string => typeof d === "string") : [];
  const base = typeof e.message === "string" && e.message ? e.message : "ArcGIS returned an error";
  const msg = details.length && !details.includes(base) ? `${base} (${details.join("; ")})` : base;
  return new ArcgisError(msg, typeof e.code === "number" ? e.code : undefined, details);
}

/**
 * One ArcGIS REST call. Adds `f=json` (and `token` when given), parses JSON,
 * and throws an ArcgisError for a transport failure, a non-2xx status or an
 * `{ error }` body.
 */
export async function arcgisRequest<T = Record<string, unknown>>(
  config: ArcgisConfig,
  url: string,
  opts: { method?: "GET" | "POST"; params?: Record<string, string>; token?: string | null } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const params: Record<string, string> = { ...(opts.params ?? {}), f: "json" };
  if (opts.token) params.token = opts.token;
  let target = url;
  let form: Record<string, string> | undefined;
  if (method === "GET") {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    target = u.toString();
  } else {
    form = params;
  }
  const verifySsl = config.verifySsl !== false;
  if (config.verboseLogging) logger.debug({ method, url }, "ArcGIS request");
  let res: ArcgisHttpResponse;
  try {
    res = await requestImpl({ url: target, method, form, verifySsl });
  } catch (err) {
    if (err instanceof ArcgisError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ArcgisError(`Could not reach ${new URL(url).host}: ${msg}`);
  }
  let json: unknown;
  try { json = JSON.parse(res.body); } catch {
    throw new ArcgisError(`${new URL(url).host} answered HTTP ${res.status} with a body that is not JSON — is this an ArcGIS REST address?`);
  }
  const restErr = restError(json);
  if (restErr) throw restErr;
  if (res.status < 200 || res.status >= 300) throw new ArcgisError(`${new URL(url).host} answered HTTP ${res.status}`);
  return json as T;
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

interface CachedToken { secret: string; token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

function cacheKey(config: ArcgisConfig): string {
  const mode = config.authMode ?? "apiKey";
  const who = mode === "appCredentials" ? config.clientId ?? "" : config.username ?? "";
  return `${portalBase(config)}|${mode}|${who}`;
}

/** Forget every cached token (a saved integration changed its credentials). */
export function clearArcgisTokenCache(): void {
  tokenCache.clear();
}

/**
 * The token to send with a request, or null for `authMode: "none"`. Throws an
 * ArcgisError when the credentials are missing or refused.
 */
export async function getArcgisToken(config: ArcgisConfig): Promise<string | null> {
  const mode = config.authMode ?? "apiKey";
  if (mode === "none") return null;
  if (mode === "apiKey") {
    if (!config.apiToken) throw new ArcgisError("No API key is configured");
    return config.apiToken;
  }
  const secret = mode === "appCredentials" ? config.clientSecret ?? "" : config.password ?? "";
  const key = cacheKey(config);
  const hit = tokenCache.get(key);
  if (hit && hit.secret === secret && hit.expiresAt - TOKEN_RENEW_MARGIN_MS > Date.now()) return hit.token;

  let token: string;
  let expiresAt: number;
  if (mode === "appCredentials") {
    if (!config.clientId || !config.clientSecret) throw new ArcgisError("App credentials need a client ID and a client secret");
    const r = await arcgisRequest<{ access_token?: string; expires_in?: number }>(config, `${sharingRest(config)}/oauth2/token`, {
      method: "POST",
      params: {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "client_credentials",
        expiration: String(TOKEN_LIFETIME_MIN),
      },
    });
    if (!r.access_token) throw new ArcgisError("The portal accepted the app credentials but returned no token");
    token = r.access_token;
    expiresAt = Date.now() + (typeof r.expires_in === "number" ? r.expires_in : TOKEN_LIFETIME_MIN * 60) * 1000;
  } else {
    if (!config.username || !config.password) throw new ArcgisError("A named-user sign-in needs a username and a password");
    const r = await arcgisRequest<{ token?: string; expires?: number }>(config, `${sharingRest(config)}/generateToken`, {
      method: "POST",
      params: {
        username: config.username,
        password: config.password,
        client: "referer",
        referer: portalBase(config),
        expiration: String(TOKEN_LIFETIME_MIN),
      },
    });
    if (!r.token) throw new ArcgisError("The portal accepted the sign-in but returned no token");
    token = r.token;
    // `expires` is an epoch in milliseconds.
    expiresAt = typeof r.expires === "number" ? r.expires : Date.now() + TOKEN_LIFETIME_MIN * 60_000;
  }
  tokenCache.set(key, { secret, token, expiresAt });
  return token;
}

// ─── Connection test ─────────────────────────────────────────────────────────

const MODE_LABEL: Record<ArcgisAuthMode, string> = {
  none: "without signing in",
  apiKey: "with an API key",
  appCredentials: "as an app",
  userPassword: "as a named user",
};

interface PortalSelf {
  name?: string;
  portalName?: string;
  currentVersion?: string;
  user?: { username?: string };
}

/**
 * Sign in and read the portal's description. With no sign-in, read the
 * portal's public `info` instead (only proves the portal answers).
 */
export async function testConnection(config: ArcgisConfig): Promise<{ ok: boolean; message: string; version?: string }> {
  const problem = portalUrlProblem(portalBase(config));
  if (problem) return { ok: false, message: problem };
  const mode = config.authMode ?? "apiKey";
  try {
    const token = await getArcgisToken(config);
    if (!token) {
      const info = await arcgisRequest<{ owningSystemUrl?: string; fullVersion?: string }>(config, `${sharingRest(config)}/info`);
      return {
        ok: true,
        message: `Reached ${new URL(portalBase(config)).host} ${MODE_LABEL.none} — only public services (such as Esri World Imagery) will be available`,
        ...(info.fullVersion ? { version: info.fullVersion } : {}),
      };
    }
    const self = await arcgisRequest<PortalSelf>(config, `${sharingRest(config)}/portals/self`, { token });
    const org = self.name || self.portalName || new URL(portalBase(config)).host;
    const who = self.user?.username ? ` (${self.user.username})` : "";
    return {
      ok: true,
      message: `Signed in to ${org} ${MODE_LABEL[mode]}${who}`,
      ...(self.currentVersion ? { version: self.currentVersion } : {}),
    };
  } catch (err) {
    if (err instanceof ArcgisError) return { ok: false, message: err.message };
    if (err instanceof AppError) return { ok: false, message: err.message };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
