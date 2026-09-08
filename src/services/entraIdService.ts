/**
 * src/services/entraIdService.ts — Microsoft Entra ID (Azure AD) device discovery
 *
 * Authenticates via OAuth2 client credentials and queries Microsoft Graph:
 *   • /v1.0/devices — every Entra-registered device (hostname, OS, trust type)
 *   • /v1.0/deviceManagement/managedDevices — Intune enrolled devices (serial,
 *     MAC, model, manufacturer, primary user, compliance) — only when
 *     config.enableIntune is true
 *
 * Results from both endpoints are merged on deviceId ↔ azureADDeviceId; Intune
 * data wins on any field present in both sources.
 */

import { AppError } from "../utils/errors.js";
import type { DirectoryPerson, DirectorySyncFilter } from "./directorySyncService.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { normalizeMacOrNull } from "../utils/mac.js";
import { buildClientCredentialsTokenRequest } from "../utils/entraClientCredentials.js";
import { sleep } from "../utils/sleep.js";
// Pure headers→ms backoff policy, shared so the two Azure surfaces cannot
// diverge on throttle handling. See the note on graphRequest.
import { throttleDelayMs } from "./azureArcService.js";

export interface EntraIdConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  enableIntune?: boolean;
  includeDisabled?: boolean;  // Default true — disabled (accountEnabled=false) devices become `decommissioned` assets
  deviceInclude?: string[];  // Match against displayName; wildcards supported
  deviceExclude?: string[];
}

export interface DiscoveredEntraDevice {
  // Which Graph endpoints contributed to this merged record. Entra-registered
  // devices that haven't been Intune-enrolled show ["entra"]; Intune-managed
  // devices that lack an Entra registration (rare) show ["intune"]; the
  // common hybrid case shows ["entra", "intune"]. Drives the AssetSource
  // write split in syncEntraDevices — each contributing source gets its own
  // row so the asset details modal can render side-by-side.
  sources: ("entra" | "intune")[];
  // Original entra-side displayName, kept distinct from `displayName` (which
  // is intune-overridden when intune contributed). Used by the entra source
  // observed blob so it reflects what Entra actually said. Undefined when
  // entra didn't contribute (intune-only devices).
  entraDisplayName?: string;
  // Original intune-side deviceName. Undefined when intune didn't contribute.
  intuneDeviceName?: string;
  deviceId: string;            // Azure AD deviceId — stable identifier across both endpoints
  displayName: string;         // Hostname in Entra; deviceName in Intune
  operatingSystem: string;
  operatingSystemVersion: string;
  trustType: string;           // "AzureAd" | "Workplace" | "ServerAd" | ""
  accountEnabled: boolean;     // false → disabled in Entra; maps to `decommissioned` status
  onPremisesSecurityIdentifier?: string; // On-prem AD SID for hybrid-joined devices (cross-link to AD integration)
  registrationDateTime?: string;
  approximateLastSignInDateTime?: string;
  isCompliant?: boolean;
  isManaged?: boolean;
  // Intune-only fields (present only when enableIntune and a matching managed device was found)
  serialNumber?: string;
  // Primary MAC for back-compat callers — populated as ethernetMacAddress preferred,
  // falling back to wifiMacAddress. Prefer reading the typed fields below when
  // wiring new behaviour (e.g. cross-asset merging should use Ethernet only,
  // since WiFi MAC randomizes on modern Windows/iOS/Android).
  macAddress?: string;
  wifiMacAddress?: string;       // Intune `wiFiMacAddress`
  ethernetMacAddress?: string;   // Intune `ethernetMacAddress`
  manufacturer?: string;
  model?: string;
  userPrincipalName?: string;
  chassisType?: string;        // "desktop" | "laptop" | "tablet" | "phone" | ...
  complianceState?: string;    // "compliant" | "noncompliant" | "unknown" | ...
  lastSyncDateTime?: string;
  ipAddress?: string;
}

export interface EntraDiscoveryResult {
  devices: DiscoveredEntraDevice[];
}

export type EntraDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// ─── Access token cache ─────────────────────────────────────────────────────
// Keyed by tenantId:clientId — value includes token and expiry timestamp.
// Tokens are refreshed 60s before expiry to avoid mid-request expiration.

interface CachedToken {
  token: string;
  expiresAt: number; // Unix ms
}
const tokenCache = new Map<string, CachedToken>();

function cacheKey(config: EntraIdConfig): string {
  return `${config.tenantId}:${config.clientId}`;
}

/**
 * Returns the app-only access token, minting one when the cache is cold.
 *
 * `fromCache` is part of the return because a client-credentials token carries
 * its `roles` claim FROZEN at issuance: an admin who grants a new Graph
 * application permission changes nothing about a token already minted. Callers
 * that hit an authorization failure need to know whether re-asking could
 * plausibly help (cached token, possibly pre-dating the grant) or whether the
 * app genuinely lacks the permission (token minted seconds ago).
 */
async function getAccessToken(
  config: EntraIdConfig,
  signal?: AbortSignal,
): Promise<{ token: string; fromCache: boolean }> {
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { token: cached.token, fromCache: true };
  }

  const { url, body } = buildClientCredentialsTokenRequest({
    tenantId: config.tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error_description) msg = String(parsed.error_description).split(/\r?\n/)[0];
        else if (parsed.error) msg = String(parsed.error);
      } catch { /* ignore */ }
      throw new AppError(502, `Entra ID token request failed: ${msg}`);
    }

    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new AppError(502, "Entra ID token response missing access_token");
    }
    const expiresInMs = (parsed.expires_in ?? 3600) * 1000;
    tokenCache.set(key, { token: parsed.access_token, expiresAt: Date.now() + expiresInMs });
    return { token: parsed.access_token, fromCache: false };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Invalidate the cached token for this config (e.g. after a 401 or 403). */
function invalidateToken(config: EntraIdConfig): void {
  tokenCache.delete(cacheKey(config));
}

// ─── Graph request (GET + write verbs) with paging ──────────────────────────

/** Graph's fixed host. Every URL this module builds is asserted against it. */
export const GRAPH_HOST = "graph.microsoft.com";

const MAX_GRAPH_THROTTLE_RETRIES = 3;

export interface GraphRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON-serialized when present; also sets Content-Type. */
  body?: unknown;
  signal?: AbortSignal;
  retryOn401?: boolean;
  /** Internal: false once a 403 has already been retried on a fresh token. */
  retryOn403?: boolean;
  throttleAttempt?: number;
  /** Return null instead of throwing on 404 (upsert lookups). */
  allow404?: boolean;
}

/**
 * One Graph call. Generalized from the former GET-only `graphGet` so write
 * verbs (Intune script publishing) share the token cache, the 401/403
 * invalidate-and-retry, and the host pinning rather than hand-rolling a second
 * transport — the repo already carries one hand-rolled Graph POST
 * (emailChannel.sendM365Email) and a second would be two too many.
 *
 * 429 handling is NEW here: reads tolerate a throttle badly enough that the
 * GET path never grew one, but Graph throttles writes hard, and a failed
 * publish that silently did nothing is worse than a slow one. The backoff
 * policy is `throttleDelayMs`, imported from azureArcService rather than
 * copied — it is a pure headers→ms function and forking it would give the two
 * Azure surfaces divergent throttle behaviour.
 * (Direction is admittedly odd for a service→service import; it belongs in a
 * util. Left as an import to keep this change off azureArcService.ts while a
 * concurrent branch owns that file.)
 */
async function graphRequest(
  config: EntraIdConfig,
  url: string,
  opts: GraphRequestOptions = {},
): Promise<any> {
  const {
    method = "GET", body, signal,
    retryOn401 = true, retryOn403 = true, throttleAttempt = 0, allow404 = false,
  } = opts;

  // Host pinning. `new URL()` alone is not enough — a crafted path can move
  // the authority — so assert equality after construction. This mirrors
  // azureArcService's ARM_HOST check; the read-only `proxyQuery` below
  // predates it and only prefix-checks the path.
  const parsed = new URL(url);
  if (parsed.host !== GRAPH_HOST) {
    throw new AppError(400, `Graph host must be ${GRAPH_HOST}`);
  }

  const { token, fromCache } = await getAccessToken(config, signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "ConsistencyLevel": "eventual",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    if (res.status === 401 && retryOn401) {
      invalidateToken(config);
      return graphRequest(config, url, { ...opts, retryOn401: false });
    }
    if (res.status === 429 && throttleAttempt < MAX_GRAPH_THROTTLE_RETRIES) {
      const delay = throttleDelayMs(res.headers);
      await sleep(delay);
      if (signal?.aborted) throw new AppError(502, "Graph request aborted while throttled");
      return graphRequest(config, url, { ...opts, throttleAttempt: throttleAttempt + 1 });
    }
    if (res.status === 429) {
      throw new AppError(502, "Microsoft Graph throttled the request (429) — retry in a moment.");
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 403 && retryOn403 && fromCache) {
      // An app-only token's `roles` claim is fixed at issuance, so a permission
      // an admin granted five minutes ago is invisible to a token minted before
      // it — and this cache holds one for up to an hour. Without this retry the
      // operator fixes the grant in Entra, presses the button again, and gets a
      // byte-identical 403; the only cures were restarting Polaris or pressing
      // Test Connection (which invalidates for its own reasons). Discard and
      // re-mint ONCE. Bounded: only when the token was cached, so a genuinely
      // unauthorized app costs one extra token fetch per operator click, not a
      // loop.
      invalidateToken(config);
      return graphRequest(config, url, { ...opts, retryOn403: false });
    }
    if (res.status === 403) {
      const text = await res.text();
      throw new AppError(502, `Graph API permission denied (403): ${extractGraphError(text)}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(502, `Graph API HTTP ${res.status}: ${extractGraphError(text)}`);
    }
    // 204 (and any empty body) would blow up res.json().
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Read-only wrapper — the shape every pre-existing caller uses. */
async function graphGet(
  config: EntraIdConfig,
  url: string,
  signal?: AbortSignal,
  retryOn401 = true,
): Promise<any> {
  return graphRequest(config, url, { method: "GET", signal, retryOn401 });
}

/**
 * Graph transport for other services (intunePublishService). Deliberately
 * exported as a bound-to-a-config call rather than exposing `graphRequest`
 * itself, so callers cannot reach a different host or skip the pinning.
 */
export async function graphApiRequest(
  config: EntraIdConfig,
  url: string,
  opts: GraphRequestOptions = {},
): Promise<any> {
  return graphRequest(config, url, opts);
}

function extractGraphError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

// Page through a Graph collection, concatenating `value` arrays until
// nextLink is absent or hardCap items have been collected.
async function graphPage(
  config: EntraIdConfig,
  initialUrl: string,
  hardCap: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const results: any[] = [];
  let url: string | undefined = initialUrl;
  while (url) {
    if (signal?.aborted) break;
    const page = await graphGet(config, url, signal);
    if (Array.isArray(page.value)) results.push(...page.value);
    if (results.length >= hardCap) break;
    url = page["@odata.nextLink"];
  }
  return results.slice(0, hardCap);
}

// ─── Directory (GAL) search ─────────────────────────────────────────────────
//
// The address book's live lookup into the organization's directory. NOTHING is
// persisted — results exist for the duration of one typeahead; only an address
// an operator actually picks becomes a rule recipient or a saved Contact.
//
// This is the ONLY people-facing query in the integration, which otherwise
// reads /devices + /deviceManagement/managedDevices. It therefore needs Graph
// application permissions the integration has never requested — User.Read.All,
// Group.Read.All and OrgContact.Read.All (or Directory.Read.All covering all
// three) — which is why it is gated behind the per-integration
// `enableDirectorySearch` opt-in: without the grant every keystroke would 403.

/** One directory hit, normalized to the address-book entry shape. */
export interface DirectoryHit {
  id: string;
  email: string;
  name: string | null;
  description: string | null;
  kind: "person" | "group";
}

function escapeSearchTerm(q: string): string {
  // $search values are double-quoted phrases; a stray quote or backslash would
  // break the expression, so drop them rather than trying to escape.
  return q.replace(/["\\]/g, "").trim();
}

/**
 * Search people, mail-enabled groups (distribution lists) and org contacts.
 * The three queries run in parallel and degrade independently — a tenant that
 * granted User.Read.All but not Group.Read.All still gets people rather than an
 * error.
 *
 * VERIFY ON A REAL TENANT: the `$search` + `$filter` + `$count=true`
 * combination on /groups is the shape most likely to need adjusting (Graph
 * requires ConsistencyLevel: eventual for it, which graphGet always sends).
 */
export async function searchDirectoryEntra(
  config: EntraIdConfig,
  query: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<DirectoryHit[]> {
  const q = escapeSearchTerm(query);
  if (q.length < 2) return [];
  const enc = encodeURIComponent(`"displayName:${q}" OR "mail:${q}"`);

  const [users, groups, contacts] = await Promise.all([
    graphPage(
      config,
      `https://graph.microsoft.com/v1.0/users?$search=${enc}&$select=id,displayName,mail,userPrincipalName,jobTitle,department&$top=${limit}`,
      limit,
      signal,
    ).catch(() => [] as any[]),
    graphPage(
      config,
      `https://graph.microsoft.com/v1.0/groups?$search=${enc}&$filter=mailEnabled%20eq%20true&$count=true&$select=id,displayName,mail,description&$top=${limit}`,
      limit,
      signal,
    ).catch(() => [] as any[]),
    graphPage(
      config,
      `https://graph.microsoft.com/v1.0/contacts?$search=${enc}&$select=id,displayName,mail,companyName&$top=${limit}`,
      limit,
      signal,
    ).catch(() => [] as any[]),
  ]);

  const out: DirectoryHit[] = [];
  for (const u of users) {
    // A mailbox-less account (a service principal, an unlicensed user) can't
    // receive email, so it isn't a recipient. UPN is NOT a fallback: it often
    // isn't a routable address.
    if (!u?.mail) continue;
    const bits = [u.jobTitle, u.department].filter(Boolean);
    out.push({ id: String(u.id), email: String(u.mail), name: u.displayName ?? null, description: bits.join(" — ") || null, kind: "person" });
  }
  for (const g of groups) {
    if (!g?.mail) continue;
    out.push({ id: String(g.id), email: String(g.mail), name: g.displayName ?? null, description: g.description || "Distribution list", kind: "group" });
  }
  for (const c of contacts) {
    if (!c?.mail) continue;
    out.push({ id: String(c.id), email: String(c.mail), name: c.displayName ?? null, description: c.companyName || "Org contact", kind: "person" });
  }
  return out.slice(0, limit);
}

// ─── Connection test ────────────────────────────────────────────────────────

export async function testConnection(config: EntraIdConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!config.tenantId) return { ok: false, message: "Tenant ID is required" };
  if (!config.clientId) return { ok: false, message: "Client ID is required" };
  if (!config.clientSecret) return { ok: false, message: "Client secret is required" };

  try {
    // Invalidate any cached token so the test always exercises the fresh secret
    invalidateToken(config);

    // Primary probe — Device.Read.All is the minimum required permission
    await graphGet(config, "https://graph.microsoft.com/v1.0/devices?$top=1&$select=id");

    if (config.enableIntune) {
      try {
        await graphGet(config, "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=1&$select=id");
      } catch (err: any) {
        return {
          ok: false,
          message: `Entra device scope OK, but Intune query failed — ${err.message || "check DeviceManagementManagedDevices.Read.All permission"}`,
        };
      }
    }

    // Optional — fetch the tenant display name for a friendlier success message.
    // Requires Organization.Read.All, which most integrations won't have; swallow
    // any failure and fall back to a generic message.
    let tenantName: string | undefined;
    try {
      const org = await graphGet(config, "https://graph.microsoft.com/v1.0/organization?$select=displayName");
      tenantName = org?.value?.[0]?.displayName;
    } catch { /* no Organization.Read.All — that's fine */ }

    return { ok: true, message: tenantName ? `Connected — tenant "${tenantName}"` : "Connected successfully" };
  } catch (err: any) {
    if (err instanceof AppError) {
      return { ok: false, message: err.message };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: "Host not found — check network connectivity" };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, message: "Connection timed out contacting Microsoft Graph" };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}


// ─── Directory (GAL) bulk read ──────────────────────────────────────────────
//
// The scheduled sync's reader (business rule 35). Same grants as the live
// search above, a different query shape: a full enumeration wants every
// mail-enabled principal, not the ones matching a term.
//
// Deliberately NO `$search`. Paging with $select + $filter + $top is the
// ordinary Graph collection read, which also means this path does not inherit
// the `VERIFY ON A REAL TENANT` risk attached to the live search's
// $search + $filter + $count=true combination on /groups — that shape stays
// owned by the code that needs term matching.

/** Graph's page ceiling for these collections. */
const GAL_PAGE_SIZE = 999;

function galPhone(u: any): string | null {
  const business = Array.isArray(u?.businessPhones) ? u.businessPhones.find((p: unknown) => typeof p === "string" && p.trim()) : null;
  const v = business || u?.mobilePhone;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Every mail-enabled principal in the tenant, for the address-book sync.
 *
 * The three collections run in parallel and degrade INDEPENDENTLY, the same
 * posture as the live search: a tenant that granted User.Read.All but not
 * Group.Read.All syncs people rather than failing the whole pass. That matters
 * more here than there — a thrown error would abort the run, and an aborted run
 * writes nothing, so one missing grant would keep the address book permanently
 * empty with no partial result to diagnose from.
 *
 * The `$filter` does the two exclusions Graph can actually answer
 * (accountEnabled, userType). It does NOT attempt shared / room / equipment
 * mailboxes: Graph exposes no mailbox type on /users, only
 * `mailboxSettings.userPurpose`, which is a PER-USER call needing
 * MailboxSettings.Read.All — twenty thousand extra requests per run. Those
 * entries are reported as mailboxKind "unknown" so directoryExclusionReason
 * leaves them alone rather than guessing, and the operator excludes them by
 * name or domain instead. The UI says so.
 */
export async function listDirectoryPeople(
  config: EntraIdConfig,
  filter: DirectorySyncFilter,
  signal?: AbortSignal,
): Promise<DirectoryPerson[]> {
  const cap = filter.maxEntries;
  const userFilter = encodeURIComponent("accountEnabled eq true and userType eq 'Member'");

  const [users, groups, orgContacts] = await Promise.all([
    graphPage(
      config,
      "https://graph.microsoft.com/v1.0/users" +
        "?$select=id,displayName,mail,jobTitle,department,businessPhones,mobilePhone,accountEnabled,userType,onPremisesDistinguishedName" +
        `&$filter=${userFilter}&$top=${GAL_PAGE_SIZE}`,
      cap,
      signal,
    ).catch(() => [] as any[]),
    filter.includeGroups
      ? graphPage(
          config,
          "https://graph.microsoft.com/v1.0/groups" +
            `?$filter=mailEnabled%20eq%20true&$select=id,displayName,mail,description&$top=${GAL_PAGE_SIZE}`,
          cap,
          signal,
        ).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    filter.includeOrgContacts
      ? graphPage(
          config,
          "https://graph.microsoft.com/v1.0/contacts" +
            `?$select=id,displayName,mail,companyName,jobTitle,department,phones&$top=${GAL_PAGE_SIZE}`,
          cap,
          signal,
        ).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
  ]);

  const out: DirectoryPerson[] = [];
  for (const u of users) {
    // A mailbox-less account cannot receive email, so it is not a recipient.
    // UPN is NOT a fallback — it frequently isn't a routable address.
    if (!u?.mail) continue;
    out.push({
      externalId: String(u.id),
      email: String(u.mail),
      name: u.displayName ?? null,
      jobTitle: u.jobTitle ?? null,
      department: u.department ?? null,
      phone: galPhone(u),
      description: null,
      kind: "person",
      // Present on hybrid-joined users; lets the OU filters work against a
      // tenant synced from on-prem AD even with no AD integration configured.
      distinguishedName: u.onPremisesDistinguishedName ?? undefined,
      disabled: u.accountEnabled === false,
      mailboxKind: "unknown",
    });
  }
  for (const g of groups) {
    if (!g?.mail) continue;
    out.push({
      externalId: String(g.id),
      email: String(g.mail),
      name: g.displayName ?? null,
      jobTitle: null,
      department: null,
      phone: null,
      description: g.description || "Distribution list",
      kind: "group",
    });
  }
  for (const c of orgContacts) {
    if (!c?.mail) continue;
    const phones = Array.isArray(c.phones)
      ? c.phones.find((p: any) => typeof p?.number === "string" && p.number.trim())?.number ?? null
      : null;
    out.push({
      externalId: String(c.id),
      email: String(c.mail),
      name: c.displayName ?? null,
      jobTitle: c.jobTitle ?? null,
      department: c.department ?? null,
      phone: phones,
      description: c.companyName || "Org contact",
      kind: "person",
    });
  }
  return out.slice(0, cap);
}

// ─── Manual query (UI tool) ─────────────────────────────────────────────────

/**
 * Proxy an arbitrary GET against Microsoft Graph using stored credentials.
 * Used by the manual API query tool in the UI. Path must begin with `/v1.0/`
 * or `/beta/` — the host is fixed to graph.microsoft.com so credentials cannot
 * be exfiltrated to an arbitrary endpoint.
 */
export async function proxyQuery(
  config: EntraIdConfig,
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  if (!path.startsWith("/v1.0/") && !path.startsWith("/beta/")) {
    throw new AppError(400, "Path must begin with /v1.0/ or /beta/");
  }
  const url = new URL("https://graph.microsoft.com" + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (k) url.searchParams.set(k, v);
    }
  }
  return graphGet(config, url.toString());
}

// ─── Device discovery ───────────────────────────────────────────────────────

const DEVICES_HARD_CAP = 10_000;

export async function discoverDevices(
  config: EntraIdConfig,
  signal?: AbortSignal,
  onProgress?: EntraDiscoveryProgressCallback,
): Promise<EntraDiscoveryResult> {
  const log = onProgress || (() => {});

  // 1. Entra ID core devices
  const entraUrl = "https://graph.microsoft.com/v1.0/devices?$top=999&$select=" + [
    "id",
    "deviceId",
    "displayName",
    "operatingSystem",
    "operatingSystemVersion",
    "trustType",
    "accountEnabled",
    "onPremisesSecurityIdentifier",
    "registrationDateTime",
    "approximateLastSignInDateTime",
    "isCompliant",
    "isManaged",
  ].join(",");

  let entraDevices: any[] = [];
  try {
    entraDevices = await graphPage(config, entraUrl, DEVICES_HARD_CAP, signal);
    log("discover.entra.devices", "info", `Entra ID: retrieved ${entraDevices.length} device(s)`);
  } catch (err: any) {
    log("discover.entra.devices", "error", `Entra ID: failed to list devices — ${err.message || "Unknown error"}`);
    throw err;
  }

  // 2. Intune managed devices (optional overlay)
  const intuneByDeviceId = new Map<string, any>();
  if (config.enableIntune && !signal?.aborted) {
    const intuneUrl = "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=999&$select=" + [
      "id",
      "azureADDeviceId",
      "deviceName",
      "operatingSystem",
      "osVersion",
      "serialNumber",
      "wiFiMacAddress",
      "ethernetMacAddress",
      "manufacturer",
      "model",
      "userPrincipalName",
      "complianceState",
      "lastSyncDateTime",
    ].join(",");

    try {
      const intuneDevices = await graphPage(config, intuneUrl, DEVICES_HARD_CAP, signal);
      for (const d of intuneDevices) {
        const key = String(d.azureADDeviceId || "").toLowerCase();
        if (key) intuneByDeviceId.set(key, d);
      }
      log("discover.intune.devices", "info", `Intune: retrieved ${intuneDevices.length} managed device(s)`);
    } catch (err: any) {
      log("discover.intune.devices", "error", `Intune: failed to list managed devices — ${err.message || "Unknown error"}`);
      // Continue with Entra-only results rather than failing the whole run
    }
  }

  // 3. Merge — Intune wins on fields present in both
  const merged: DiscoveredEntraDevice[] = [];
  const seenDeviceIds = new Set<string>();
  let nullIdSkipped = 0;

  for (const e of entraDevices) {
    const deviceId = String(e.deviceId || "").toLowerCase();
    if (!isMeaningfulDeviceId(deviceId)) {
      nullIdSkipped++;
      continue;
    }
    seenDeviceIds.add(deviceId);

    const intune = intuneByDeviceId.get(deviceId);
    const wifi = formatMac(intune?.wiFiMacAddress);
    const eth = formatMac(intune?.ethernetMacAddress);
    const sources: ("entra" | "intune")[] = ["entra"];
    if (intune) sources.push("intune");
    merged.push({
      sources,
      entraDisplayName: e.displayName ? String(e.displayName) : undefined,
      intuneDeviceName: intune?.deviceName ? String(intune.deviceName) : undefined,
      deviceId,
      displayName: (intune?.deviceName || e.displayName || "") as string,
      operatingSystem: (intune?.operatingSystem || e.operatingSystem || "") as string,
      operatingSystemVersion: (intune?.osVersion || e.operatingSystemVersion || "") as string,
      trustType: String(e.trustType || ""),
      accountEnabled: e.accountEnabled !== false,
      onPremisesSecurityIdentifier: e.onPremisesSecurityIdentifier ? String(e.onPremisesSecurityIdentifier) : undefined,
      registrationDateTime: e.registrationDateTime || undefined,
      approximateLastSignInDateTime: e.approximateLastSignInDateTime || undefined,
      isCompliant: typeof e.isCompliant === "boolean" ? e.isCompliant : undefined,
      isManaged: typeof e.isManaged === "boolean" ? e.isManaged : undefined,
      serialNumber: intune?.serialNumber || undefined,
      macAddress: (eth || wifi) || undefined,
      wifiMacAddress: wifi || undefined,
      ethernetMacAddress: eth || undefined,
      manufacturer: intune?.manufacturer || undefined,
      model: intune?.model || undefined,
      userPrincipalName: intune?.userPrincipalName || undefined,
      chassisType: intune?.chassisType || undefined,
      complianceState: intune?.complianceState || undefined,
      lastSyncDateTime: intune?.lastSyncDateTime || undefined,
    });
  }

  // Intune-only devices (not yet registered in Entra — rare but possible)
  for (const [deviceId, intune] of intuneByDeviceId) {
    if (seenDeviceIds.has(deviceId)) continue;
    if (!isMeaningfulDeviceId(deviceId)) {
      nullIdSkipped++;
      continue;
    }
    const wifi = formatMac(intune.wiFiMacAddress);
    const eth = formatMac(intune.ethernetMacAddress);
    merged.push({
      sources: ["intune"],
      intuneDeviceName: intune.deviceName ? String(intune.deviceName) : undefined,
      deviceId,
      displayName: String(intune.deviceName || ""),
      operatingSystem: String(intune.operatingSystem || ""),
      operatingSystemVersion: String(intune.osVersion || ""),
      trustType: "",
      accountEnabled: true, // Intune-only devices have no Entra accountEnabled — assume active
      serialNumber: intune.serialNumber || undefined,
      macAddress: (eth || wifi) || undefined,
      wifiMacAddress: wifi || undefined,
      ethernetMacAddress: eth || undefined,
      manufacturer: intune.manufacturer || undefined,
      model: intune.model || undefined,
      userPrincipalName: intune.userPrincipalName || undefined,
      chassisType: intune.chassisType || undefined,
      complianceState: intune.complianceState || undefined,
      lastSyncDateTime: intune.lastSyncDateTime || undefined,
    });
  }

  if (nullIdSkipped > 0) {
    log("discover.filter.null_id", "info", `Skipping ${nullIdSkipped} device(s) with empty or null deviceId (e.g. 00000000-0000-0000-0000-000000000000)`);
  }

  // 4. Apply device include/exclude filter (match displayName)
  const filtered = filterDevices(merged, config.deviceInclude, config.deviceExclude);
  const dropped = merged.length - filtered.length;
  if (dropped > 0) {
    log("discover.filter", "info", `Device filter: ${filtered.length} included, ${dropped} excluded`);
  } else {
    log("discover.filter", "info", `Merged total: ${filtered.length} device(s)`);
  }

  // 5. If includeDisabled is explicitly false, skip disabled devices entirely
  if (config.includeDisabled === false) {
    const active = filtered.filter((d) => d.accountEnabled);
    const disabledCount = filtered.length - active.length;
    if (disabledCount > 0) {
      log("discover.filter.disabled", "info", `Skipping ${disabledCount} disabled Entra device(s) (includeDisabled=false)`);
    }
    return { devices: active };
  }

  return { devices: filtered };
}

// Reject Entra device IDs that are empty or the canonical null GUID. Some
// devices land in the Graph response with deviceId="00000000-0000-0000-0000-000000000000"
// (typically broken/half-registered records) — accepting them produces an asset
// with assetTag="entra:00000000-..." that all collide on the same key.
function isMeaningfulDeviceId(id: string): boolean {
  if (!id) return false;
  return id.replace(/[-0]/g, "").length > 0;
}

// Normalize a single MAC value from Intune (returned without separators, e.g.
// "A0B1C2D3E4F5") into Polaris's storage convention: colon-separated uppercase.
// Unrecognizable or all-zero input yields "" (falsy → field omitted) — the
// previous fallback stored the raw value uppercased, which poisoned the
// MAC-match cascade with un-normalized junk.
function formatMac(mac: unknown): string {
  if (!mac) return "";
  return normalizeMacOrNull(String(mac)) ?? "";
}

// matchesWildcard is imported from ../utils/integrationFilter.js — the
// canonical glob-lite matcher shared by every device/VM/interface filter.

function filterDevices(
  devices: DiscoveredEntraDevice[],
  include?: string[],
  exclude?: string[],
): DiscoveredEntraDevice[] {
  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchesWildcard(p, d.displayName)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchesWildcard(p, d.displayName)));
  }
  return devices;
}
