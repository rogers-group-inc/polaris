/**
 * src/services/azureArcService.ts — Azure Arc (Arc-enabled servers) discovery
 *
 * Authenticates via OAuth2 client credentials against **Azure Resource
 * Manager** (scope https://management.azure.com/.default — NOT Microsoft
 * Graph; this integration needs no Graph permissions at all) and enumerates
 * `Microsoft.HybridCompute/machines`: hosts running the Azure Connected
 * Machine agent (`himds`). The agent runs IN the guest, so it reports the
 * live OS SKU, the real domain-joined FQDN, SMBIOS serial/manufacturer/model,
 * and a heartbeat status — host truth rather than a directory record.
 *
 * Two read paths, both normalizing through `normalizeArcMachine` so callers
 * never learn which one ran:
 *
 *   1. **Azure Resource Graph** (default, `config.useResourceGraph`) — ONE
 *      POST returns machines across every subscription the service principal
 *      can read. At a 60-subscription tenant that's ~2 requests instead of
 *      ~65. ARG is an indexed snapshot that trails the resource provider by
 *      seconds-to-minutes; on a 12-hour discovery poll that is irrelevant, so
 *      don't debug it as a bug. ARG also cannot supply `networkProfile`.
 *   2. **Per-subscription list** — `GET /subscriptions` then a paged
 *      `.../providers/Microsoft.HybridCompute/machines` per subscription.
 *      Used when `useResourceGraph` is off and as the automatic fallback when
 *      ARG is unavailable (403 / provider not registered).
 *
 * RBAC: the app registration's service principal needs **Reader**, ideally at
 * the management-group root. ARG returns only what the principal can already
 * read, so a PARTIAL Reader assignment silently yields a PARTIAL roster
 * rather than a 403 — which is why `testConnection` reports the subscription
 * count it can actually see. That is the single most common misconfiguration.
 *
 * ARM differences from Graph that matter (see entraIdService.ts for the shape
 * this file mirrors):
 *   • paging key is `nextLink`, not `@odata.nextLink`
 *   • ARG pages by `$skipToken` in the request BODY, not by a URL
 *   • 429 is normal operation, not an error — ARM's per-subscription fan-out
 *     plus ARG's 15-requests/5s quota make throttling routine, so the backoff
 *     lives in the low-level fetchers and both paths inherit it
 *
 * API versions are module-level consts, never inlined, so a bump is a one-line
 * diff. They and the `detectedProperties` key names are VERIFY-ON-REAL-TENANT
 * (same convention as the FortiOS field shapes in descriptionSyncService.ts):
 * `detectedProperties` is a loose bag whose keys vary by Connected Machine
 * agent version, so every read of it is optional and defensive.
 */

import { AppError } from "../utils/errors.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { buildClientCredentialsTokenRequest } from "../utils/entraClientCredentials.js";
import { mapSettledWithConcurrency } from "../utils/concurrency.js";

// ─── API versions (verify-on-real-tenant) ───────────────────────────────────

const ARC_MACHINES_API_VERSION = "2024-07-10";
const SUBSCRIPTIONS_API_VERSION = "2022-12-01";
const RESOURCE_GRAPH_API_VERSION = "2022-10-01";
// The Phase 2/3 extension resources (Microsoft.ConnectedVMwarevSphere and
// Microsoft.ScVmm virtualMachineInstances, Microsoft.AzureArcData
// sqlServerInstances) carry no api-version constant here on purpose: they are
// read ONLY through Resource Graph — see attachExtensionResources — which
// queries the index rather than each resource provider, so one query covers
// the whole tenant instead of one GET per machine. A direct-read path would
// need `2023-12-01` / `2023-10-07` / `2023-01-15-preview` respectively (the
// last is a PREVIEW surface — re-verify before relying on it).

const ARM_HOST = "management.azure.com";
const ARM_BASE = `https://${ARM_HOST}`;
const ARM_SCOPE = "https://management.azure.com/.default";

/** Upper bound on machines pulled in one run — mirrors Entra's DEVICES_HARD_CAP. */
const MACHINES_HARD_CAP = 20_000;
/** ARG returns at most 1000 rows per page. */
const ARG_PAGE_SIZE = 1000;
/** Concurrency for the optional per-machine networkProfile fetch. */
const NETWORK_PROFILE_CONCURRENCY = 8;
/** Wall-clock ceiling for the whole networkProfile pass. */
const NETWORK_PROFILE_DEADLINE_MS = 120_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AzureArcConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  useResourceGraph?: boolean;      // Default true
  subscriptionInclude?: string[];  // Explicit subscription ids; empty = every readable subscription
  resourceGroupInclude?: string[]; // Wildcards, matched against the resource group name
  resourceGroupExclude?: string[];
  deviceInclude?: string[];        // Wildcards, matched against displayName (same semantics as Entra)
  deviceExclude?: string[];
  tagInclude?: string[];           // "key=value" / "key=*" against the Azure resource tags
  tagExclude?: string[];
  includeDisconnected?: boolean;   // Default true — a Disconnected agent is still an asset
  fetchNetworkProfile?: boolean;   // Default false — one extra GET per machine
  // Phase 2/3 enrichment. Each costs ONE additional Resource Graph query for
  // the whole tenant (not per machine), and neither creates assets — both fold
  // into the owning machine's observed blob.
  enableVmInstances?: boolean;
  enableSqlServer?: boolean;
  // Phase 4. UNLIKE the two above, connected clusters become ASSETS of their
  // own — this toggle changes the fleet, not just an existing machine's blob.
  enableKubernetes?: boolean;
}

/**
 * Arc-enabled VMware / SCVMM placement for a machine (Phase 2).
 *
 * These are CHILD EXTENSION RESOURCES of a HybridCompute machine, not
 * resources in their own right, so they never create an asset — they describe
 * a machine Phase 1 already discovered.
 */
export interface ArcVmInstance {
  platform: "vmware" | "scvmm";
  /** The parent HybridCompute machine's ARM id, lowercased. */
  parentMachineId: string;
  /** vCenter's instanceUuid — EXACTLY the value vcenterService.pickVmExternalId prefers. */
  instanceUuid: string | null;
  biosGuid: string | null;
  moRefId: string | null;
  vCenterId: string | null;
  inventoryItemId: string | null;
  hostName: string | null;
  cpuCount: number | null;
  memoryMB: number | null;
  folderPath: string | null;
}

/** An Arc-enabled SQL Server instance running on a machine (Phase 3). */
export interface ArcSqlInstance {
  /** The parent HybridCompute machine's ARM id, lowercased. */
  parentMachineId: string;
  name: string;
  instanceName: string | null;
  edition: string | null;
  version: string | null;
  patchLevel: string | null;
  status: string | null;
  licenseType: string | null;
  vCoreCount: number | null;
}

export interface DiscoveredArcMachine {
  /** Lowercased ARM resource id — the AssetSource externalId. */
  armId: string;
  name: string;
  subscriptionId: string;
  subscriptionName: string | null;
  resourceGroup: string;
  /** Azure REGION of the resource record — NEVER a physical location. */
  azureRegion: string;
  displayName: string;
  /** properties.vmUuid — the SMBIOS UUID, normalized. Cross-links to vCenter. */
  vmUuid: string | null;
  /** The endian-swapped variant of vmUuid — see swapVmUuidEndianness. */
  vmUuidSwapped: string | null;
  adFqdn: string | null;
  dnsFqdn: string | null;
  domainName: string | null;
  osType: string | null;    // "windows" | "linux"
  osName: string | null;
  osSku: string | null;
  osVersion: string | null;
  status: string | null;    // "Connected" | "Disconnected" | "Expired"
  lastStatusChange: string | null;
  agentVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  processorCount: number | null;
  totalPhysicalMemoryBytes: number | null;
  cloudProvider: string | null;          // detectedProperties.cloudprovider — "VMware" | "HCI" | "AWS" | …
  parentClusterResourceId: string | null;
  tags: Record<string, string>;
  ipAddresses: string[];                 // Populated only when fetchNetworkProfile is on
  /** Phase 2 — set only when enableVmInstances is on and the machine is Arc-enabled VMware/SCVMM. */
  vmInstance: ArcVmInstance | null;
  /** Phase 3 — set only when enableSqlServer is on; empty for machines with no SQL. */
  sqlInstances: ArcSqlInstance[];
}

/**
 * An Arc-enabled Kubernetes cluster (Phase 4).
 *
 * The only Arc entity that is NOT just detail on a machine — a connected
 * cluster becomes its own asset, typed `kubernetes_cluster`. It runs no
 * Polaris Agent and reports no interfaces or mounts, so its per-class block
 * is the reduced addAsMonitored+streams shape.
 */
export interface DiscoveredArcCluster {
  /** Lowercased ARM resource id — the AssetSource externalId. */
  armId: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  azureRegion: string;
  kubernetesVersion: string | null;
  distribution: string | null;
  infrastructure: string | null;
  totalNodeCount: number | null;
  totalCoreCount: number | null;
  agentVersion: string | null;
  connectivityStatus: string | null;
  provisioningState: string | null;
  tags: Record<string, string>;
}

export interface ArcDiscoveryResult {
  machines: DiscoveredArcMachine[];
  /** Phase 4 — empty unless enableKubernetes is on. */
  clusters: DiscoveredArcCluster[];
  subscriptionsQueried: number;
  /** True when the ARG path failed and the per-subscription list ran instead. */
  usedFallback: boolean;
}

export type ArcDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// ─── Access token cache ─────────────────────────────────────────────────────
// Keyed tenantId:clientId (the scope is fixed for this service, unlike the
// shared entraClientCredentials helper which several scopes ride).

interface CachedToken {
  token: string;
  expiresAt: number; // Unix ms
}
const tokenCache = new Map<string, CachedToken>();

function cacheKey(config: AzureArcConfig): string {
  return `${config.tenantId}:${config.clientId}`;
}

async function getAccessToken(config: AzureArcConfig, signal?: AbortSignal): Promise<string> {
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  // Reuse the shared request builder rather than forking it — see
  // src/utils/entraClientCredentials.ts. Only the scope differs from Graph.
  const { url, body } = buildClientCredentialsTokenRequest({
    tenantId: config.tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: ARM_SCOPE,
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
      throw new AppError(502, `Azure Arc token request failed: ${describeAadTokenError(text, res.status)}`);
    }

    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new AppError(502, "Azure Arc token response missing access_token");
    }
    const expiresInMs = (parsed.expires_in ?? 3600) * 1000;
    tokenCache.set(key, { token: parsed.access_token, expiresAt: Date.now() + expiresInMs });
    return parsed.access_token;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Invalidate the cached token for this config (e.g. after a 401). */
function invalidateToken(config: AzureArcConfig): void {
  tokenCache.delete(cacheKey(config));
}

/**
 * Turn an AAD token-endpoint failure body into something an operator can act
 * on. The AADSTS codes below are the three that account for nearly every
 * real-world failure; anything else falls back to the raw description.
 * Exported for unit testing — the message is what the operator sees on the
 * Test Connection button.
 */
export function describeAadTokenError(body: string, status: number): string {
  let description = "";
  try {
    const parsed = JSON.parse(body);
    description = String(parsed.error_description || parsed.error || "");
  } catch {
    description = body.slice(0, 200);
  }
  if (description.includes("AADSTS7000215")) return "Client secret is invalid or expired.";
  if (description.includes("AADSTS700016")) return "Client ID not found in this tenant — check the tenant ID and the app registration.";
  if (description.includes("AADSTS90002")) return "Tenant not found — check the tenant ID.";
  const firstLine = description.split(/\r?\n/)[0].trim();
  return firstLine || `HTTP ${status}`;
}

// ─── ARM transport ──────────────────────────────────────────────────────────

/**
 * Extract an operator-readable message from an ARM error body. ARM nests it
 * as `{ error: { code, message } }`; Resource Graph adds a `details` array.
 * Exported for unit testing.
 */
export function extractArmError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error ?? parsed;
    const detail = Array.isArray(err?.details) && err.details.length > 0
      ? ` (${err.details.map((d: any) => d?.message || d?.code).filter(Boolean).join("; ")})`
      : "";
    const base = err?.message || err?.code;
    return base ? `${base}${detail}` : body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

/**
 * How long to wait before retrying a throttled ARM request. Prefers the
 * standard `Retry-After` header (seconds), then Resource Graph's
 * `x-ms-user-quota-resets-after` (an HH:MM:SS duration), then a 5s floor.
 * Clamped to 60s so a hostile/garbled header can't wedge a discovery run.
 * Exported for unit testing.
 */
export function throttleDelayMs(headers: {
  get(name: string): string | null;
}): number {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);

  const quota = headers.get("x-ms-user-quota-resets-after");
  if (quota) {
    const parts = quota.split(":").map((p) => Number(p));
    if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) {
      const seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (seconds > 0) return Math.min(seconds * 1000, 60_000);
    }
  }
  return 5_000;
}

const MAX_THROTTLE_RETRIES = 3;

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

interface ArmRequestOptions {
  // PUT is reachable ONLY from dispatchRunCommand at the bottom of this file.
  // proxyQuery (the operator query console) still allowlists GET plus POST to
  // Resource Graph alone — widening this union does not widen that.
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
  retryOn401?: boolean;
  throttleAttempt?: number;
}

async function armRequest(
  config: AzureArcConfig,
  url: string,
  opts: ArmRequestOptions = {},
): Promise<any> {
  const { method = "GET", body, signal, retryOn401 = true, throttleAttempt = 0 } = opts;
  const token = await getAccessToken(config, signal);

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
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    if (res.status === 401 && retryOn401) {
      invalidateToken(config);
      return armRequest(config, url, { ...opts, retryOn401: false });
    }
    if (res.status === 429 && throttleAttempt < MAX_THROTTLE_RETRIES) {
      const delay = throttleDelayMs(res.headers);
      await sleep(delay, signal);
      if (signal?.aborted) throw new AppError(502, "Azure Arc request aborted while throttled");
      return armRequest(config, url, { ...opts, throttleAttempt: throttleAttempt + 1 });
    }
    if (res.status === 429) {
      throw new AppError(502, "Azure throttled the request (429) — retry in a moment.");
    }
    if (res.status === 403) {
      const text = await res.text();
      throw new AppError(502, `Azure Resource Manager permission denied (403): ${extractArmError(text)}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(502, `Azure Resource Manager HTTP ${res.status}: ${extractArmError(text)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Page through an ARM collection, concatenating `value` arrays until
 * `nextLink` is absent or hardCap items have been collected. Note the paging
 * key — ARM uses `nextLink`, Graph uses `@odata.nextLink`.
 */
async function armPage(
  config: AzureArcConfig,
  initialUrl: string,
  hardCap: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const results: any[] = [];
  let url: string | undefined = initialUrl;
  while (url) {
    if (signal?.aborted) break;
    const page: any = await armRequest(config, url, { signal });
    if (Array.isArray(page.value)) results.push(...page.value);
    if (results.length >= hardCap) break;
    url = page.nextLink;
  }
  return results.slice(0, hardCap);
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Normalize an operator-entered subscription id: lowercase, trim, tolerate a
 * pasted `/subscriptions/<guid>` prefix, and REQUIRE a well-formed GUID.
 * Returns null for anything else.
 *
 * This is a security boundary, not just hygiene: the validated ids are the
 * only operator-controlled values interpolated into the Resource Graph KQL
 * (every other filter is applied client-side precisely so it never reaches
 * the query language). A value that isn't a bare GUID never gets there.
 */
export function normalizeSubscriptionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  const m = v.match(/^\/?subscriptions\/([^/]+)/);
  if (m) v = m[1];
  v = v.replace(/^\/+|\/+$/g, "");
  return GUID_RE.test(v) ? v : null;
}

/**
 * Build the Resource Graph KQL for the Arc machine roster.
 *
 * ONLY GUID-validated subscription ids are interpolated. Resource-group, tag,
 * and name filters are deliberately applied client-side in `filterArcMachines`
 * rather than compiled into KQL: they're free-form operator wildcards, and
 * keeping them out of the query language removes the injection surface
 * entirely at the cost of a few hundred KB of response body on a large tenant.
 */
export function buildArcMachinesQuery(opts: { subscriptionIds?: string[] } = {}): string {
  const subs = (opts.subscriptionIds ?? [])
    .map(normalizeSubscriptionId)
    .filter((s): s is string => s !== null);

  const clauses = [`where type =~ 'microsoft.hybridcompute/machines'`];
  if (subs.length > 0) {
    clauses.push(`where subscriptionId in~ (${subs.map((s) => `'${s}'`).join(", ")})`);
  }
  clauses.push(
    "project id, name, type, location, tags, properties, subscriptionId, resourceGroup",
  );
  return `Resources | ${clauses.join(" | ")}`;
}

/**
 * Normalize an SMBIOS UUID: strip braces/whitespace, lowercase, require a
 * well-formed GUID, and REJECT the all-zero GUID.
 *
 * The all-zero rejection is load-bearing (it's the lesson Entra's
 * `isMeaningfulDeviceId` encodes): a fleet of machines whose BIOS reports
 * 00000000-… would all collapse onto one map key and mass-merge into a single
 * asset. Same for the all-F variant some hypervisors emit.
 */
export function normalizeVmUuid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^[{(]|[})]$/g, "").toLowerCase();
  if (!GUID_RE.test(v)) return null;
  const bare = v.replace(/-/g, "");
  if (/^0+$/.test(bare)) return null;
  if (/^f+$/.test(bare)) return null;
  return v;
}

/**
 * Byte-swap the first three fields of a UUID (8-4-4), leaving the last two
 * alone.
 *
 * The SMBIOS UUID's first three fields are little-endian on the wire, and
 * Windows (`Win32_ComputerSystemProduct.UUID`), Linux `dmidecode`, and VMware
 * have historically disagreed about whether to swap them. So the same physical
 * machine can present as either form depending on who read it. Both variants
 * are indexed at match time — if only one were, every Arc-on-VMware machine
 * would silently create a duplicate asset instead of merging onto its
 * vCenter-discovered VM, which looks like nothing at all until someone
 * notices the fleet has doubled.
 *
 * Involutive: swap(swap(x)) === x.
 */
export function swapVmUuidEndianness(uuid: string | null): string | null {
  if (!uuid || !GUID_RE.test(uuid)) return null;
  const [a, b, c, d, e] = uuid.split("-");
  const flip = (hex: string) => (hex.match(/../g) ?? []).reverse().join("");
  return [flip(a), flip(b), flip(c), d, e].join("-");
}

export interface ParsedArmResourceId {
  subscriptionId: string;
  resourceGroup: string;
  provider: string;
  type: string;
  name: string;
}

/**
 * Parse an ARM resource id into its parts. Handles the plain machine id and
 * the child extension-resource shape (…/machines/x/providers/Microsoft.Foo/
 * bar/default) by taking the LAST provider segment. Returns null when the id
 * doesn't carry a subscription + resource group + provider triple.
 */
export function parseArmResourceId(id: unknown): ParsedArmResourceId | null {
  if (typeof id !== "string" || !id) return null;
  const parts = id.split("/").filter(Boolean);
  const subIdx = parts.findIndex((p) => p.toLowerCase() === "subscriptions");
  const rgIdx = parts.findIndex((p) => p.toLowerCase() === "resourcegroups");
  if (subIdx < 0 || rgIdx < 0 || !parts[subIdx + 1] || !parts[rgIdx + 1]) return null;

  // Last `providers` wins so an extension resource reports its own type.
  let provIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].toLowerCase() === "providers") { provIdx = i; break; }
  }
  if (provIdx < 0 || !parts[provIdx + 1] || !parts[provIdx + 2] || !parts[provIdx + 3]) return null;

  return {
    subscriptionId: parts[subIdx + 1].toLowerCase(),
    resourceGroup: parts[rgIdx + 1],
    provider: parts[provIdx + 1],
    type: parts[provIdx + 2],
    name: parts.slice(provIdx + 3).join("/"),
  };
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Read a `detectedProperties` value, tolerating the casing drift between
 * Connected Machine agent versions (`serialNumber` vs `serialnumber`).
 */
function detected(bag: any, ...keys: string[]): string | null {
  if (!bag || typeof bag !== "object") return null;
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(bag)) lowered.set(k.toLowerCase(), v);
  for (const k of keys) {
    const hit = str(lowered.get(k.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/**
 * Normalize one raw machine into the typed record the sync consumes.
 *
 * Accepts BOTH shapes identically: a Resource Graph row (subscriptionId /
 * resourceGroup as projected columns) and a resource-provider list row (both
 * derivable from `id` alone). That equivalence is the regression guard for
 * the dual-path design — if it ever drifts, the ARG and fallback paths would
 * produce different assets for the same machine.
 *
 * Returns null when the row carries no usable ARM id.
 */
export function normalizeArcMachine(
  raw: any,
  subscriptionNameById?: Map<string, string>,
): DiscoveredArcMachine | null {
  if (!raw || typeof raw !== "object") return null;
  const armId = str(raw.id)?.toLowerCase() ?? null;
  if (!armId) return null;
  const parsed = parseArmResourceId(armId);

  const p = raw.properties ?? {};
  const dp = p.detectedProperties ?? {};

  const subscriptionId = str(raw.subscriptionId)?.toLowerCase() ?? parsed?.subscriptionId ?? "";
  const resourceGroup = str(raw.resourceGroup) ?? parsed?.resourceGroup ?? "";
  const name = str(raw.name) ?? parsed?.name ?? "";
  const vmUuid = normalizeVmUuid(p.vmUuid);

  const memGb = num(detected(dp, "totalPhysicalMemoryInGigabytes"));
  const memBytes = num(detected(dp, "totalPhysicalMemoryInBytes"))
    ?? (memGb !== null ? Math.round(memGb * 1024 * 1024 * 1024) : null);

  const tags: Record<string, string> = {};
  if (raw.tags && typeof raw.tags === "object") {
    for (const [k, v] of Object.entries(raw.tags)) {
      if (typeof v === "string") tags[k] = v;
    }
  }

  return {
    armId,
    name,
    subscriptionId,
    subscriptionName: subscriptionNameById?.get(subscriptionId) ?? null,
    resourceGroup,
    azureRegion: str(raw.location) ?? "",
    displayName: str(p.displayName) ?? name,
    vmUuid,
    vmUuidSwapped: swapVmUuidEndianness(vmUuid),
    adFqdn: str(p.adFqdn),
    dnsFqdn: str(p.dnsFqdn) ?? str(p.machineFqdn),
    domainName: str(p.domainName),
    osType: str(p.osType)?.toLowerCase() ?? null,
    osName: str(p.osName),
    osSku: str(p.osSku),
    osVersion: str(p.osVersion),
    status: str(p.status),
    lastStatusChange: str(p.lastStatusChange),
    agentVersion: str(p.agentVersion),
    manufacturer: detected(dp, "manufacturer"),
    model: detected(dp, "model"),
    serialNumber: detected(dp, "serialNumber", "serialnumber"),
    processorCount: num(detected(dp, "logicalCoreCount", "coreCount", "processorCount")),
    totalPhysicalMemoryBytes: memBytes,
    cloudProvider: detected(dp, "cloudprovider", "cloudProvider"),
    parentClusterResourceId: str(p.parentClusterResourceId),
    tags,
    ipAddresses: extractIpAddresses(p.networkProfile),
    vmInstance: null,
    sqlInstances: [],
  };
}

/** Pull IPv4/IPv6 addresses out of an ARM `networkProfile` blob. */
export function extractIpAddresses(networkProfile: any): string[] {
  const out: string[] = [];
  const nics = networkProfile?.networkInterfaces;
  if (!Array.isArray(nics)) return out;
  for (const nic of nics) {
    const addrs = nic?.ipAddresses;
    if (!Array.isArray(addrs)) continue;
    for (const a of addrs) {
      const ip = str(typeof a === "string" ? a : a?.address);
      if (ip && !out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

const SERVER_SKU_RE = /server|datacenter/i;
const WINDOWS_CLIENT_RE = /windows\s*(10|11|8|7)\b/i;
const LINUX_DESKTOP_RE = /\b(desktop|workstation)\b/i;

/**
 * Infer an asset type from what Arc reports about the OS.
 *
 * Deliberately NOT `inferAssetTypeFromChassis` — Arc reports no chassis, and
 * that helper defaults to "workstation", which would type an entire Linux
 * server estate as workstations and route them through the wrong per-class
 * config block. Arc-enabled Linux is overwhelmingly server-class (unlike
 * Entra, where Linux endpoints are frequently laptops), so a Linux machine
 * with no desktop marker resolves to "server".
 */
export function inferArcAssetType(
  m: Pick<DiscoveredArcMachine, "osType" | "osSku" | "osName">,
): "workstation" | "server" | "other" {
  const text = [m.osSku, m.osName].filter(Boolean).join(" ");
  // An explicit server edition wins outright.
  if (SERVER_SKU_RE.test(text)) return "server";
  // An explicit CLIENT edition is the only reliable "this is a workstation"
  // signal Arc gives us.
  if (WINDOWS_CLIENT_RE.test(text)) return "workstation";

  // osType is the authoritative field, but fall back to sniffing the SKU/name
  // text when an older agent didn't populate it.
  const osType = (m.osType || "").toLowerCase()
    || (/windows/i.test(text) ? "windows" : /linux/i.test(text) ? "linux" : "");

  // Absent a client marker, an Arc machine is a SERVER on both platforms.
  // Arc onboarding is overwhelmingly a server-estate play; client Windows and
  // Linux desktops are the exception, and when they ARE present the SKU says
  // so and is caught above.
  //
  // This used to default Windows the other way, which silently typed every
  // Windows host whose osSku was empty as a workstation — Arc frequently
  // reports only `osName: "windows"` — and that is not cosmetic: assetType
  // selects the per-class config block, so those machines resolved
  // workstationMonitor instead of serverMonitor and picked up the wrong
  // addAsMonitored / agent-deploy / auto-monitor settings.
  if (osType === "linux") return LINUX_DESKTOP_RE.test(text) ? "workstation" : "server";
  if (osType === "windows") return "server";
  return "other";
}

/** True when Arc's heartbeat says the agent is currently reporting in. */
export function arcStatusIsConnected(status: string | null | undefined): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "connected";
}

/**
 * Match a machine's Azure resource tags against one `key=value` filter line.
 * `key=*` matches any value of that key; the value side supports the same
 * glob-lite wildcards as every other filter. A line with no `=` matches on
 * key presence alone.
 */
export function matchesTagFilter(tags: Record<string, string>, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const eq = trimmed.indexOf("=");
  const key = (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim().toLowerCase();
  const pattern = eq >= 0 ? trimmed.slice(eq + 1).trim() : "*";
  if (!key) return false;
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() !== key) continue;
    if (matchesWildcard(pattern, v ?? "")) return true;
  }
  return false;
}

/**
 * Apply the resource-group, display-name, and tag filters.
 *
 * Per-axis semantics match the rest of Polaris: a non-empty include list keeps
 * only matches; an exclude list drops matches; include wins when both are set
 * on the same axis. Axes AND together, so a machine must survive all three.
 */
export function filterArcMachines(
  machines: DiscoveredArcMachine[],
  config: Pick<
    AzureArcConfig,
    "resourceGroupInclude" | "resourceGroupExclude" | "deviceInclude" | "deviceExclude" | "tagInclude" | "tagExclude"
  >,
): DiscoveredArcMachine[] {
  const axis = <T>(
    list: T[],
    include: string[] | undefined,
    exclude: string[] | undefined,
    test: (item: T, pattern: string) => boolean,
  ): T[] => {
    const inc = (include ?? []).filter((p) => p.trim() !== "");
    const exc = (exclude ?? []).filter((p) => p.trim() !== "");
    if (inc.length > 0) return list.filter((item) => inc.some((p) => test(item, p)));
    if (exc.length > 0) return list.filter((item) => !exc.some((p) => test(item, p)));
    return list;
  };

  let out = machines;
  out = axis(out, config.resourceGroupInclude, config.resourceGroupExclude,
    (m, p) => matchesWildcard(p, m.resourceGroup));
  out = axis(out, config.deviceInclude, config.deviceExclude,
    (m, p) => matchesWildcard(p, m.displayName));
  out = axis(out, config.tagInclude, config.tagExclude,
    (m, p) => matchesTagFilter(m.tags, p));
  return out;
}

/**
 * The hostname candidates this machine offers, FQDN first.
 *
 * `fqdn` is only reported when the value actually contains a dot — a
 * dot-less adFqdn is a short name wearing the wrong field, and letting it
 * through would put a NetBIOS name into the FQDN projection rule.
 */
export function arcHostnameCandidates(
  m: Pick<DiscoveredArcMachine, "dnsFqdn" | "adFqdn" | "displayName" | "name">,
): { fqdn: string | null; short: string | null } {
  const candidate = m.dnsFqdn || m.adFqdn || null;
  const fqdn = candidate && candidate.includes(".") ? candidate : null;
  const short = m.displayName || m.name || (candidate ? candidate.split(".")[0] : null) || null;
  return { fqdn, short };
}

/**
 * The `AssetSource.observed` blob for an arc row — "as Azure Arc said it".
 * Keys are named so the assetProjection rules read them directly.
 *
 * `azureRegion` is deliberately NOT called `location`: it's where the Arc
 * resource RECORD lives, not where the machine is, and must never be
 * projected into `Asset.learnedLocation` (the resource group is what fills
 * that role).
 */
export function buildArcObservedBlob(
  m: DiscoveredArcMachine,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "arc",
    syncedAt: syncedAt.toISOString(),
    armId: m.armId,
    name: m.name,
    displayName: m.displayName,
    subscriptionId: m.subscriptionId,
    subscriptionName: m.subscriptionName,
    resourceGroup: m.resourceGroup,
    azureRegion: m.azureRegion,
    vmUuid: m.vmUuid,
    vmUuidSwapped: m.vmUuidSwapped,
    adFqdn: m.adFqdn,
    dnsFqdn: m.dnsFqdn,
    domainName: m.domainName,
    osType: m.osType,
    osName: m.osName,
    osSku: m.osSku,
    osVersion: m.osVersion,
    status: m.status,
    lastStatusChange: m.lastStatusChange,
    agentVersion: m.agentVersion,
    manufacturer: m.manufacturer,
    model: m.model,
    serialNumber: m.serialNumber,
    processorCount: m.processorCount,
    totalPhysicalMemoryBytes: m.totalPhysicalMemoryBytes,
    cloudProvider: m.cloudProvider,
    parentClusterResourceId: m.parentClusterResourceId,
    azureTags: m.tags,
    ipAddresses: m.ipAddresses,
    // Phase 2/3. Null / empty when the toggles are off, so an operator who
    // never enabled them sees no change in the blob shape.
    vmInstance: m.vmInstance,
    sqlInstances: m.sqlInstances,
  };
}


/**
 * The parent HybridCompute machine id for a child extension resource.
 *
 * An extension resource id nests its own provider path under the parent's:
 *   /subscriptions/S/resourceGroups/RG/providers/Microsoft.HybridCompute/machines/NAME
 *     /providers/Microsoft.ConnectedVMwarevSphere/virtualMachineInstances/default
 *
 * so the parent is everything before the LAST `/providers/`. Returns null when
 * the id has no nested provider segment (i.e. it isn't an extension resource)
 * or the parent doesn't look like a machine.
 */
export function parentMachineIdFromExtensionId(id: unknown): string | null {
  if (typeof id !== "string" || !id) return null;
  const lower = id.toLowerCase();
  const cut = lower.lastIndexOf("/providers/");
  if (cut <= 0) return null;
  const parent = lower.slice(0, cut);
  if (!parent.includes("/providers/microsoft.hybridcompute/machines/")) return null;
  return parent;
}

/** Resource Graph query for the Arc-enabled VMware + SCVMM VM instances. */
export function buildArcVmInstancesQuery(opts: { subscriptionIds?: string[] } = {}): string {
  const subs = (opts.subscriptionIds ?? [])
    .map(normalizeSubscriptionId)
    .filter((s): s is string => s !== null);
  const clauses = [
    "where type =~ 'microsoft.connectedvmwarevsphere/virtualmachineinstances'"
      + " or type =~ 'microsoft.scvmm/virtualmachineinstances'",
  ];
  if (subs.length > 0) {
    clauses.push(`where subscriptionId in~ (${subs.map((s) => `'${s}'`).join(", ")})`);
  }
  clauses.push("project id, name, type, properties, subscriptionId, resourceGroup");
  return `Resources | ${clauses.join(" | ")}`;
}

/** Resource Graph query for Arc-enabled SQL Server instances. */
export function buildArcSqlInstancesQuery(opts: { subscriptionIds?: string[] } = {}): string {
  const subs = (opts.subscriptionIds ?? [])
    .map(normalizeSubscriptionId)
    .filter((s): s is string => s !== null);
  const clauses = ["where type =~ 'microsoft.azurearcdata/sqlserverinstances'"];
  if (subs.length > 0) {
    clauses.push(`where subscriptionId in~ (${subs.map((s) => `'${s}'`).join(", ")})`);
  }
  clauses.push("project id, name, type, properties, subscriptionId, resourceGroup");
  return `Resources | ${clauses.join(" | ")}`;
}

/** Resource Graph query for Arc-enabled Kubernetes clusters. */
export function buildArcClustersQuery(opts: { subscriptionIds?: string[] } = {}): string {
  const subs = (opts.subscriptionIds ?? [])
    .map(normalizeSubscriptionId)
    .filter((s): s is string => s !== null);
  const clauses = ["where type =~ 'microsoft.kubernetes/connectedclusters'"];
  if (subs.length > 0) {
    clauses.push(`where subscriptionId in~ (${subs.map((s) => `'${s}'`).join(", ")})`);
  }
  clauses.push("project id, name, type, location, tags, properties, subscriptionId, resourceGroup");
  return `Resources | ${clauses.join(" | ")}`;
}

/**
 * Normalize one connected-cluster row. Returns null without a usable ARM id.
 * Accepts the ARG projection and the resource-provider shape identically, for
 * the same reason normalizeArcMachine does.
 */
export function normalizeArcCluster(raw: any): DiscoveredArcCluster | null {
  if (!raw || typeof raw !== "object") return null;
  const armId = str(raw.id)?.toLowerCase() ?? null;
  if (!armId) return null;
  const parsed = parseArmResourceId(armId);
  const p = raw.properties ?? {};

  const tags: Record<string, string> = {};
  if (raw.tags && typeof raw.tags === "object") {
    for (const [k, v] of Object.entries(raw.tags)) {
      if (typeof v === "string") tags[k] = v;
    }
  }

  return {
    armId,
    name: str(raw.name) ?? parsed?.name ?? "",
    subscriptionId: str(raw.subscriptionId)?.toLowerCase() ?? parsed?.subscriptionId ?? "",
    resourceGroup: str(raw.resourceGroup) ?? parsed?.resourceGroup ?? "",
    azureRegion: str(raw.location) ?? "",
    kubernetesVersion: str(p.kubernetesVersion),
    distribution: str(p.distribution),
    infrastructure: str(p.infrastructure),
    totalNodeCount: num(p.totalNodeCount),
    totalCoreCount: num(p.totalCoreCount),
    agentVersion: str(p.agentVersion),
    connectivityStatus: str(p.connectivityStatus),
    provisioningState: str(p.provisioningState),
    tags,
  };
}

/** The `AssetSource.observed` blob for an `arc-k8s` row. */
export function buildArcClusterObservedBlob(
  c: DiscoveredArcCluster,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "arc-k8s",
    syncedAt: syncedAt.toISOString(),
    armId: c.armId,
    name: c.name,
    subscriptionId: c.subscriptionId,
    resourceGroup: c.resourceGroup,
    azureRegion: c.azureRegion,
    kubernetesVersion: c.kubernetesVersion,
    distribution: c.distribution,
    infrastructure: c.infrastructure,
    totalNodeCount: c.totalNodeCount,
    totalCoreCount: c.totalCoreCount,
    agentVersion: c.agentVersion,
    connectivityStatus: c.connectivityStatus,
    provisioningState: c.provisioningState,
    azureTags: c.tags,
  };
}

/**
 * Normalize one Arc-enabled VMware/SCVMM VM-instance row. Returns null when the
 * row carries no resolvable parent machine — without that link there is nothing
 * to attach it to.
 */
export function normalizeArcVmInstance(raw: any): ArcVmInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const parentMachineId = parentMachineIdFromExtensionId(raw.id);
  if (!parentMachineId) return null;

  const p = raw.properties ?? {};
  const infra = p.infrastructureProfile ?? {};
  const hw = p.hardwareProfile ?? {};
  const type = String(raw.type ?? "").toLowerCase();
  const platform: "vmware" | "scvmm" = type.includes("scvmm") ? "scvmm" : "vmware";

  return {
    platform,
    parentMachineId,
    instanceUuid: normalizeVmUuid(infra.instanceUuid ?? infra.uuid ?? p.uuid),
    biosGuid: normalizeVmUuid(infra.biosGuid ?? p.biosGuid),
    moRefId: str(infra.moRefId ?? infra.vmName ?? p.vmName),
    vCenterId: str(infra.vCenterId ?? p.vmmServerId),
    inventoryItemId: str(infra.inventoryItemId),
    hostName: str(p.hostName ?? infra.folderPath),
    cpuCount: num(hw.numCPUs ?? hw.cpuCount),
    memoryMB: num(hw.memorySizeMB ?? hw.memoryMB),
    folderPath: str(infra.folderPath),
  };
}

/**
 * Normalize one Arc-enabled SQL Server instance row. The parent link is
 * `properties.containerResourceId` (NOT the id path — a SQL instance is a
 * top-level resource that POINTS AT its machine rather than nesting under it).
 */
export function normalizeArcSqlInstance(raw: any): ArcSqlInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw.properties ?? {};
  const container = str(p.containerResourceId);
  const parentMachineId = container ? container.toLowerCase() : null;
  if (!parentMachineId || !parentMachineId.includes("/providers/microsoft.hybridcompute/machines/")) {
    return null;
  }
  return {
    parentMachineId,
    name: str(raw.name) ?? "",
    instanceName: str(p.instanceName),
    edition: str(p.edition),
    version: str(p.version),
    patchLevel: str(p.patchLevel),
    status: str(p.status),
    licenseType: str(p.licenseType),
    vCoreCount: num(p.vCore ?? p.vCoreCount ?? p.cores),
  };
}

// ─── Subscription enumeration ───────────────────────────────────────────────

interface SubscriptionInfo {
  subscriptionId: string;
  displayName: string;
}

async function listSubscriptions(
  config: AzureArcConfig,
  signal?: AbortSignal,
): Promise<SubscriptionInfo[]> {
  const rows = await armPage(
    config,
    `${ARM_BASE}/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`,
    1000,
    signal,
  );
  return rows
    .map((r: any) => {
      const id = normalizeSubscriptionId(r?.subscriptionId);
      return id ? { subscriptionId: id, displayName: String(r?.displayName ?? id) } : null;
    })
    .filter((s): s is SubscriptionInfo => s !== null);
}

/**
 * The subscriptions this run should query: the operator's explicit list when
 * set (validated), otherwise every subscription the principal can enumerate.
 */
async function resolveSubscriptions(
  config: AzureArcConfig,
  signal?: AbortSignal,
): Promise<SubscriptionInfo[]> {
  const explicit = (config.subscriptionInclude ?? [])
    .map(normalizeSubscriptionId)
    .filter((s): s is string => s !== null);

  if (explicit.length > 0) {
    // Still enumerate so the run can label subscriptions by name — but never
    // let an enumeration failure block an explicitly-scoped run.
    let names = new Map<string, string>();
    try {
      const all = await listSubscriptions(config, signal);
      names = new Map(all.map((s) => [s.subscriptionId, s.displayName]));
    } catch { /* explicit scope doesn't require the list permission */ }
    return explicit.map((id) => ({ subscriptionId: id, displayName: names.get(id) ?? id }));
  }

  return listSubscriptions(config, signal);
}

// ─── Machine enumeration — Resource Graph ───────────────────────────────────

/**
 * Run one Resource Graph query to exhaustion. ARG pages by `$skipToken` in the
 * request BODY rather than by a URL, so this can't reuse armPage.
 */
async function runResourceGraphQuery(
  config: AzureArcConfig,
  query: string,
  subscriptionIds: string[],
  cap: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const url = `${ARM_BASE}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API_VERSION}`;
  const rows: any[] = [];
  let skipToken: string | undefined;

  do {
    if (signal?.aborted) break;
    const body: Record<string, unknown> = {
      query,
      options: { resultFormat: "objectArray", $top: ARG_PAGE_SIZE, ...(skipToken ? { $skipToken: skipToken } : {}) },
      ...(subscriptionIds.length > 0 ? { subscriptions: subscriptionIds } : {}),
    };
    const page: any = await armRequest(config, url, { method: "POST", body, signal });
    if (Array.isArray(page?.data)) rows.push(...page.data);
    skipToken = typeof page?.$skipToken === "string" ? page.$skipToken : undefined;
  } while (skipToken && rows.length < cap);

  return rows.slice(0, cap);
}

async function fetchMachinesViaResourceGraph(
  config: AzureArcConfig,
  subscriptionIds: string[],
  signal?: AbortSignal,
): Promise<any[]> {
  return runResourceGraphQuery(
    config, buildArcMachinesQuery({ subscriptionIds }), subscriptionIds, MACHINES_HARD_CAP, signal,
  );
}

/**
 * Phase 2/3 enrichment: attach Arc-enabled VMware/SCVMM placement and
 * Arc-enabled SQL Server instances to the machines already discovered.
 *
 * NEITHER CREATES AN ASSET. Both describe a machine the main pass already
 * found, so they fold into that machine's record (and from there into its
 * observed blob) rather than into the sync's create path.
 *
 * Resource-Graph-only by design: each is ONE query for the whole tenant, where
 * reading them off the resource provider would be one GET per machine. When the
 * main pass fell back to the per-subscription list (ARG unavailable), the
 * enrichment is skipped with a logged line rather than silently degrading to
 * that per-machine cost.
 */
async function attachExtensionResources(
  config: AzureArcConfig,
  machines: DiscoveredArcMachine[],
  subscriptionIds: string[],
  signal?: AbortSignal,
  onProgress?: ArcDiscoveryProgressCallback,
): Promise<void> {
  const log = onProgress || (() => {});
  const byArmId = new Map(machines.map((m) => [m.armId, m]));

  if (config.enableVmInstances) {
    try {
      const rows = await runResourceGraphQuery(
        config, buildArcVmInstancesQuery({ subscriptionIds }), subscriptionIds, MACHINES_HARD_CAP, signal,
      );
      let attached = 0;
      let orphaned = 0;
      for (const row of rows) {
        const vm = normalizeArcVmInstance(row);
        if (!vm) { orphaned++; continue; }
        const machine = byArmId.get(vm.parentMachineId);
        // A VM instance whose machine this run filtered out is not an error.
        if (!machine) { orphaned++; continue; }
        machine.vmInstance = vm;
        attached++;
      }
      log("discover.arc.vm_instances", "info",
        `Azure Arc: ${attached} machine(s) matched to Arc-enabled VMware/SCVMM placement`
          + (orphaned > 0 ? ` (${orphaned} row(s) had no in-scope parent machine)` : ""));
    } catch (err: any) {
      log("discover.arc.vm_instances", "error",
        `Azure Arc: VMware/SCVMM instance query failed — ${err?.message || "unknown error"}`);
    }
  }

  if (config.enableSqlServer) {
    try {
      const rows = await runResourceGraphQuery(
        config, buildArcSqlInstancesQuery({ subscriptionIds }), subscriptionIds, MACHINES_HARD_CAP, signal,
      );
      let attached = 0;
      let orphaned = 0;
      for (const row of rows) {
        const sql = normalizeArcSqlInstance(row);
        if (!sql) { orphaned++; continue; }
        const machine = byArmId.get(sql.parentMachineId);
        if (!machine) { orphaned++; continue; }
        machine.sqlInstances.push(sql);
        attached++;
      }
      log("discover.arc.sql_instances", "info",
        `Azure Arc: ${attached} Arc-enabled SQL Server instance(s) attached`
          + (orphaned > 0 ? ` (${orphaned} row(s) had no in-scope parent machine)` : ""));
    } catch (err: any) {
      log("discover.arc.sql_instances", "error",
        `Azure Arc: SQL Server instance query failed — ${err?.message || "unknown error"}`);
    }
  }
}

// ─── Machine enumeration — per-subscription list (fallback) ─────────────────

async function fetchMachinesViaSubscriptionList(
  config: AzureArcConfig,
  subscriptions: SubscriptionInfo[],
  signal?: AbortSignal,
  onProgress?: ArcDiscoveryProgressCallback,
): Promise<any[]> {
  const rows: any[] = [];
  for (const sub of subscriptions) {
    if (signal?.aborted) break;
    if (rows.length >= MACHINES_HARD_CAP) break;
    const url = `${ARM_BASE}/subscriptions/${sub.subscriptionId}`
      + `/providers/Microsoft.HybridCompute/machines?api-version=${ARC_MACHINES_API_VERSION}`;
    try {
      const page = await armPage(config, url, MACHINES_HARD_CAP - rows.length, signal);
      rows.push(...page);
    } catch (err: any) {
      // One unreadable subscription (no Reader, provider not registered) must
      // not abort the whole roster — record it and keep going.
      onProgress?.(
        "discover.arc.subscription",
        "error",
        `Azure Arc: subscription ${sub.displayName} could not be read — ${err?.message || "unknown error"}`,
      );
    }
  }
  return rows;
}

// ─── Optional per-machine network profile ───────────────────────────────────

/**
 * Fill in `ipAddresses` with a per-machine GET. This is ONE REQUEST PER
 * MACHINE — at 2000 machines that is 2000 round trips against a rate-limited
 * API, which is why it's opt-in, concurrency-capped, and deadline-bounded.
 * Machines skipped by the deadline keep an empty ipAddresses rather than
 * blocking the run, and the count is reported rather than silently dropped.
 */
async function fillNetworkProfiles(
  config: AzureArcConfig,
  machines: DiscoveredArcMachine[],
  signal?: AbortSignal,
  onProgress?: ArcDiscoveryProgressCallback,
): Promise<void> {
  const deadline = Date.now() + NETWORK_PROFILE_DEADLINE_MS;
  const pending = machines.filter((m) => m.ipAddresses.length === 0);
  let cursor = 0;
  let skipped = 0;
  let failed = 0;

  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const idx = cursor++;
      if (idx >= pending.length) return;
      if (Date.now() > deadline) { skipped++; continue; }
      const m = pending[idx];
      try {
        const detail: any = await armRequest(
          config,
          `${ARM_BASE}${m.armId}?api-version=${ARC_MACHINES_API_VERSION}`,
          { signal },
        );
        m.ipAddresses = extractIpAddresses(detail?.properties?.networkProfile);
      } catch {
        failed++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(NETWORK_PROFILE_CONCURRENCY, pending.length) }, worker),
  );

  if (skipped > 0 || failed > 0) {
    onProgress?.(
      "discover.arc.network_profile",
      "info",
      `Azure Arc: network profile — ${pending.length - skipped - failed} fetched`
        + (skipped > 0 ? `, ${skipped} skipped (pass deadline reached)` : "")
        + (failed > 0 ? `, ${failed} failed` : ""),
    );
  }
}

// ─── Connection test ────────────────────────────────────────────────────────

/**
 * Probe three levels deep and report the deepest one reached:
 *   1. acquire an ARM token          → tenant + client id + secret are valid
 *   2. read each configured subscription → the Reader role is actually assigned
 *   3. list machines in one of them  → Microsoft.HybridCompute is registered
 *
 * Step 2 is non-optional. A valid app registration with NO role assignment
 * acquires a token happily, so a token-only test reports a false success on
 * by far the most common misconfiguration.
 */
export async function testConnection(config: AzureArcConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!config.tenantId) return { ok: false, message: "Tenant ID is required" };
  if (!config.clientId) return { ok: false, message: "Client ID is required" };
  if (!config.clientSecret) return { ok: false, message: "Client secret is required" };

  const badIds = (config.subscriptionInclude ?? [])
    .filter((s) => s.trim() !== "" && normalizeSubscriptionId(s) === null);
  if (badIds.length > 0) {
    return { ok: false, message: `Not a valid subscription ID: ${badIds[0]}` };
  }

  try {
    // Always exercise the freshly-typed secret rather than a cached token.
    invalidateToken(config);

    const subs = await resolveSubscriptions(config);
    if (subs.length === 0) {
      return {
        ok: false,
        message: "Authenticated, but the app registration can't see any subscriptions — "
          + "assign it the Reader role on the subscriptions (or management group) holding your Arc machines.",
      };
    }

    // Confirm the Reader grant really resolves on each configured subscription.
    for (const sub of subs) {
      try {
        await armRequest(
          config,
          `${ARM_BASE}/subscriptions/${sub.subscriptionId}?api-version=${SUBSCRIPTIONS_API_VERSION}`,
        );
      } catch (err: any) {
        return {
          ok: false,
          message: `Authenticated, but subscription ${sub.displayName} could not be read — `
            + `check that the app registration has the Reader role on it. (${err?.message || "unknown error"})`,
        };
      }
    }

    // Bounded machine probe against the first subscription — proves the
    // Microsoft.HybridCompute resource provider is registered.
    let machineCount = 0;
    try {
      const probe: any = await armRequest(
        config,
        `${ARM_BASE}/subscriptions/${subs[0].subscriptionId}`
          + `/providers/Microsoft.HybridCompute/machines?api-version=${ARC_MACHINES_API_VERSION}&$top=5`,
      );
      machineCount = Array.isArray(probe?.value) ? probe.value.length : 0;
    } catch (err: any) {
      return {
        ok: false,
        message: `Subscription ${subs[0].displayName} is readable, but listing Arc machines failed — `
          + `the Microsoft.HybridCompute resource provider may not be registered in it. (${err?.message || "unknown error"})`,
      };
    }

    const subLabel = `${subs.length} subscription${subs.length === 1 ? "" : "s"}`;
    // Zero machines is a success with a warning, not a failure — an empty
    // subscription is a legitimate state, and the operator may have scoped to
    // one that simply hasn't been onboarded yet.
    const machineLabel = machineCount > 0
      ? `Arc machines found in ${subs[0].displayName}`
      : `no Arc machines yet in ${subs[0].displayName}`;
    return { ok: true, message: `Connected to Azure Arc — ${subLabel} reachable, ${machineLabel}` };
  } catch (err: any) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    if (err?.cause?.code === "ENOTFOUND") {
      return { ok: false, message: "Host not found — check network connectivity to management.azure.com" };
    }
    if (err?.cause?.code === "ETIMEDOUT" || err?.name === "TimeoutError" || err?.name === "AbortError") {
      return { ok: false, message: "Connection timed out contacting Azure Resource Manager" };
    }
    return { ok: false, message: err?.message || "Unknown error" };
  }
}

// ─── Manual query (UI tool) ─────────────────────────────────────────────────

/**
 * Proxy a read against Azure Resource Manager using stored credentials, for
 * the manual API query tool in the UI.
 *
 * Host is pinned to management.azure.com and the path must begin `/subscriptions/`
 * or `/providers/` so stored credentials can't be exfiltrated to an arbitrary
 * endpoint (the same anti-exfiltration shape as entraIdService.proxyQuery).
 * POST is allowed ONLY to the Resource Graph query endpoint — otherwise the
 * query console would be a general-purpose ARM write tool.
 */
export async function proxyQuery(
  config: AzureArcConfig,
  method: "GET" | "POST",
  path: string,
  query?: Record<string, string>,
  body?: unknown,
): Promise<unknown> {
  if (!path.startsWith("/subscriptions/") && !path.startsWith("/providers/")) {
    throw new AppError(400, "Path must begin with /subscriptions/ or /providers/");
  }
  if (method === "POST" && path.toLowerCase() !== "/providers/microsoft.resourcegraph/resources") {
    throw new AppError(400, "POST is only permitted to /providers/Microsoft.ResourceGraph/resources");
  }

  const url = new URL(ARM_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (k) url.searchParams.set(k, v);
    }
  }
  if (!url.searchParams.get("api-version")) {
    throw new AppError(400, "An api-version query parameter is required (e.g. api-version=2024-07-10)");
  }
  if (url.host !== ARM_HOST) {
    throw new AppError(400, "Host must be management.azure.com");
  }

  return armRequest(config, url.toString(), {
    method,
    ...(method === "POST" ? { body: body ?? {} } : {}),
  });
}

// ─── Machine discovery ──────────────────────────────────────────────────────

export async function discoverMachines(
  config: AzureArcConfig,
  signal?: AbortSignal,
  onProgress?: ArcDiscoveryProgressCallback,
  /**
   * Narrow the run to ONE Arc machine, by ARM resource id. Backs the asset
   * slide-in's "Discover Now".
   *
   * Applied CLIENT-SIDE, beside the resource-group/name/tag filters, and
   * deliberately not pushed into the Resource Graph query: only GUID-validated
   * subscription ids are ever interpolated into that KQL, and a resource id is
   * free-form operator-adjacent text. There is nothing to gain by pushing it
   * down either — Arc discovery is a fixed ~3 queries regardless of fleet size
   * (no per-machine fan-out), so the value of scoping here is that only this
   * asset gets written, not fewer API calls.
   */
  scope?: { resourceId: string },
): Promise<ArcDiscoveryResult> {
  const log = onProgress || (() => {});

  // 1. Resolve scope.
  let subscriptions: SubscriptionInfo[];
  try {
    subscriptions = await resolveSubscriptions(config, signal);
  } catch (err: any) {
    log("discover.arc.subscriptions", "error",
      `Azure Arc: failed to resolve subscriptions — ${err?.message || "Unknown error"}`);
    throw err;
  }
  if (subscriptions.length === 0) {
    log("discover.arc.subscriptions", "error",
      "Azure Arc: the app registration can't see any subscriptions — check its Reader role assignment");
    return { machines: [], clusters: [], subscriptionsQueried: 0, usedFallback: false };
  }
  log("discover.arc.subscriptions", "info",
    `Azure Arc: ${subscriptions.length} subscription(s) in scope`);

  const subIds = subscriptions.map((s) => s.subscriptionId);
  const subNames = new Map(subscriptions.map((s) => [s.subscriptionId, s.displayName]));

  // 2. Fetch the roster — Resource Graph first, per-subscription list as the
  //    transparent fallback.
  let rawRows: any[] = [];
  let usedFallback = false;
  const wantsArg = config.useResourceGraph !== false;

  if (wantsArg) {
    try {
      rawRows = await fetchMachinesViaResourceGraph(config, subIds, signal);
      log("discover.arc.machines", "info",
        `Azure Arc: Resource Graph returned ${rawRows.length} machine(s)`);
    } catch (err: any) {
      usedFallback = true;
      log("discover.arc.arg_fallback", "info",
        `Azure Arc: Resource Graph unavailable (${err?.message || "unknown error"}) — `
          + "falling back to a per-subscription list");
    }
  }

  if (!wantsArg || usedFallback) {
    rawRows = await fetchMachinesViaSubscriptionList(config, subscriptions, signal, onProgress);
    log("discover.arc.machines", "info",
      `Azure Arc: retrieved ${rawRows.length} machine(s) across ${subscriptions.length} subscription(s)`);
  }

  if (rawRows.length >= MACHINES_HARD_CAP) {
    log("discover.arc.machines", "error",
      `Azure Arc: hit the ${MACHINES_HARD_CAP} machine cap — some machines were not retrieved`);
  }

  // 3. Normalize.
  const normalized: DiscoveredArcMachine[] = [];
  let unusable = 0;
  for (const row of rawRows) {
    const m = normalizeArcMachine(row, subNames);
    if (m) normalized.push(m);
    else unusable++;
  }
  if (unusable > 0) {
    log("discover.arc.filter.unusable", "info",
      `Azure Arc: skipping ${unusable} row(s) with no usable resource id`);
  }

  // 4. Filter (resource group / display name / tags — all client-side).
  let machines = filterArcMachines(normalized, config);
  if (scope) {
    // ARM resource ids are case-insensitive.
    // `armId` is already lowercased at normalization; ARM ids are
    // case-insensitive, so lowercase the wanted value to match.
    const want = scope.resourceId.trim().toLowerCase();
    machines = machines.filter((m) => m.armId === want);
    log("discover.arc.scope", "info",
      `Azure Arc: scoped to one machine — ${machines.length} match(es) for ${scope.resourceId}`);
  }
  const dropped = normalized.length - machines.length;
  if (dropped > 0) {
    log("discover.filter", "info", `Azure Arc filter: ${machines.length} included, ${dropped} excluded`);
  } else {
    log("discover.filter", "info", `Azure Arc total: ${machines.length} machine(s)`);
  }

  // 5. Optionally drop disconnected agents entirely.
  if (config.includeDisconnected === false) {
    const connected = machines.filter((m) => arcStatusIsConnected(m.status));
    const disconnected = machines.length - connected.length;
    if (disconnected > 0) {
      log("discover.arc.filter.disconnected", "info",
        `Azure Arc: skipping ${disconnected} disconnected machine(s) (includeDisconnected=false)`);
    }
    machines = connected;
  }

  // 6. Optional per-machine IP addresses.
  if (config.fetchNetworkProfile && machines.length > 0 && !signal?.aborted) {
    await fillNetworkProfiles(config, machines, signal, onProgress);
  }

  // 7. Phase 2/3 extension-resource enrichment (one extra query each, no new
  //    assets). Resource-Graph-only — see attachExtensionResources.
  const wantsExtensions = config.enableVmInstances || config.enableSqlServer;
  if (wantsExtensions && machines.length > 0 && !signal?.aborted) {
    if (usedFallback || !wantsArg) {
      log("discover.arc.extensions_skipped", "info",
        "Azure Arc: skipping VMware/SCVMM + SQL enrichment — it needs Resource Graph, "
          + "which this run could not use");
    } else {
      await attachExtensionResources(config, machines, subIds, signal, onProgress);
    }
  }

  // 8. Phase 4 — connected Kubernetes clusters. These DO become assets, so
  //    unlike the phase 2/3 enrichment they're returned as their own list.
  //    Resource-Graph-only for the same cost reason.
  //    Skipped entirely on a scoped run: clusters are separate assets from the
  //    machine being refreshed, so a "refresh this server" click has no business
  //    creating or updating them.
  const clusters: DiscoveredArcCluster[] = [];
  if (config.enableKubernetes && !scope && !signal?.aborted) {
    if (usedFallback || !wantsArg) {
      log("discover.arc.clusters_skipped", "info",
        "Azure Arc: skipping connected Kubernetes clusters — they need Resource Graph, "
          + "which this run could not use");
    } else {
      try {
        const rows = await runResourceGraphQuery(
          config, buildArcClustersQuery({ subscriptionIds: subIds }), subIds, MACHINES_HARD_CAP, signal,
        );
        for (const row of rows) {
          const c = normalizeArcCluster(row);
          if (c) clusters.push(c);
        }
        log("discover.arc.clusters", "info",
          `Azure Arc: retrieved ${clusters.length} connected Kubernetes cluster(s)`);
      } catch (err: any) {
        log("discover.arc.clusters", "error",
          `Azure Arc: connected-cluster query failed — ${err?.message || "unknown error"}`);
      }
    }
  }

  return { machines, clusters, subscriptionsQueried: subscriptions.length, usedFallback };
}

// ─── Run Command (the ONLY ARM write in this file) ──────────────────────────
//
// Everything above is read-only, and `proxyQuery` deliberately refuses
// arbitrary writes so the query console can't become a general-purpose tenant
// mutation tool. This is the single, narrow exception: dispatching the SSH
// onboarding script to Arc-connected machines.
//
// Exported as a PURPOSE-BUILT function rather than by exporting `armRequest`,
// so the write surface stays exactly one verb against exactly one resource
// type. If a second write is ever needed, add a second named function — do not
// widen this one.
//
// THREE THINGS SHAPE THE DESIGN:
//
// 1. There is NO inert state. Unlike an Intune Remediation (created unassigned,
//    doing nothing until a human targets it), a run command EXECUTES on
//    creation. The review gate is therefore the caller's target selection,
//    which is why this takes an explicit machine list and never a filter it
//    expands itself.
// 2. Arc runs PowerShell on Windows machines and shell on Linux ones, so the
//    caller supplies both scripts and each machine gets the matching one. A
//    machine whose OS we cannot determine is SKIPPED, never guessed — guessing
//    wrong means running a PowerShell script through a shell as root.
// 3. The PUT is a long-running ARM operation: it returns when the command is
//    ACCEPTED, not when the script finishes. So this reports DISPATCH, and
//    `readRunCommandResult` polls a machine afterwards. Blocking on N script
//    executions inside one HTTP request would time out long before a real
//    fleet finished.

/**
 * API version for Microsoft.HybridCompute runCommands — distinct from
 * ARC_MACHINES_API_VERSION on purpose, since the two resource types version
 * independently. If Azure rejects it, `extractArmError` surfaces ARM's own
 * message, which names the versions it does accept.
 */
const ARC_RUN_COMMAND_API_VERSION = "2024-07-10";

/** Cap on concurrent ARM writes. ARM throttles per subscription. */
const ARC_RUN_COMMAND_CONCURRENCY = 4;

export interface ArcRunCommandTarget {
  armId: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  /** Azure REGION of the machine resource — required on the runCommand body. */
  azureRegion: string;
  /** "windows" | "linux" — selects which script is sent. */
  osType: string | null;
  status?: string | null;
}

export interface ArcRunCommandDispatch {
  armId: string;
  name: string;
  dispatched: boolean;
  /** Set when the machine was deliberately not attempted. */
  skipped?: string;
  error?: string;
}

export interface ArcRunCommandScripts {
  windows: string;
  linux: string;
}

function runCommandUrl(t: ArcRunCommandTarget, runCommandName: string): string {
  return (
    `${ARM_BASE}/subscriptions/${encodeURIComponent(t.subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(t.resourceGroup)}` +
    `/providers/Microsoft.HybridCompute/machines/${encodeURIComponent(t.name)}` +
    `/runCommands/${encodeURIComponent(runCommandName)}` +
    `?api-version=${ARC_RUN_COMMAND_API_VERSION}`
  );
}

/**
 * Dispatch a script to each target. Per-item tolerant: one machine's failure
 * never aborts the batch (the discipline `fillNetworkProfiles` already uses),
 * so a partially-reachable fleet still gets the machines it can reach.
 *
 * Returns one row per target INCLUDING the skipped ones — a caller that only
 * saw successes could not tell "42 machines onboarded" from "42 attempted, 30
 * skipped for unknown OS".
 */
export async function dispatchRunCommand(
  config: AzureArcConfig,
  targets: readonly ArcRunCommandTarget[],
  scripts: ArcRunCommandScripts,
  opts: { runCommandName: string; concurrency?: number; signal?: AbortSignal },
): Promise<ArcRunCommandDispatch[]> {
  if ((config as any).allowRunCommand !== true) {
    throw new AppError(
      400,
      "Running scripts on Arc machines is not enabled for this integration — turn on " +
        "the run-script option on its Script Publishing tab first.",
    );
  }
  const limit = Math.max(1, opts.concurrency ?? ARC_RUN_COMMAND_CONCURRENCY);

  const settled = await mapSettledWithConcurrency(
    targets,
    limit,
    async (t): Promise<ArcRunCommandDispatch> => {
      const os = (t.osType || "").toLowerCase();
      const script = os === "windows" ? scripts.windows : os === "linux" ? scripts.linux : null;
      if (!script) {
        return { armId: t.armId, name: t.name, dispatched: false, skipped: `unknown OS type (${t.osType || "none"})` };
      }
      if (!t.azureRegion) {
        return { armId: t.armId, name: t.name, dispatched: false, skipped: "no Azure region on the machine resource" };
      }
      try {
        await armRequest(config, runCommandUrl(t, opts.runCommandName), {
          method: "PUT",
          signal: opts.signal,
          body: {
            location: t.azureRegion,
            properties: {
              source: { script },
              // Let ARM own the execution; we report dispatch and poll results
              // separately rather than holding a request open per machine.
              asyncExecution: true,
              timeoutInSeconds: 600,
            },
          },
        });
        return { armId: t.armId, name: t.name, dispatched: true };
      } catch (err: any) {
        return { armId: t.armId, name: t.name, dispatched: false, error: err?.message || "dispatch failed" };
      }
    },
  );

  // A rejection here would be a bug in the mapper above, not a machine failure —
  // every expected error path already returns a row.
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          armId: targets[i]!.armId,
          name: targets[i]!.name,
          dispatched: false,
          error: String((r.reason as any)?.message ?? r.reason),
        },
  );
}

export interface ArcRunCommandResult {
  provisioningState: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
}

/** Read one machine's run-command outcome. Null when it was never created. */
export async function readRunCommandResult(
  config: AzureArcConfig,
  target: ArcRunCommandTarget,
  runCommandName: string,
  signal?: AbortSignal,
): Promise<ArcRunCommandResult | null> {
  const url = runCommandUrl(target, runCommandName) + "&$expand=instanceView";
  let res: any;
  try {
    res = await armRequest(config, url, { method: "GET", signal });
  } catch (err: any) {
    if (typeof err?.message === "string" && /HTTP 404/.test(err.message)) return null;
    throw err;
  }
  const iv = res?.properties?.instanceView ?? {};
  return {
    provisioningState: res?.properties?.provisioningState ?? null,
    exitCode: typeof iv.exitCode === "number" ? iv.exitCode : null,
    stdout: typeof iv.output === "string" ? iv.output : null,
    stderr: typeof iv.error === "string" ? iv.error : null,
  };
}

/**
 * Arc machines eligible as run-command targets. Thin wrapper over the same
 * roster read discovery uses — the picker needs identity + OS + connection
 * state, not the enrichment passes.
 */
export async function listRunCommandTargets(
  config: AzureArcConfig,
  signal?: AbortSignal,
): Promise<ArcRunCommandTarget[]> {
  const subscriptions = await resolveSubscriptions(config, signal);
  if (subscriptions.length === 0) return [];
  // The two fetchers take different scope shapes — the ARG one wants bare
  // subscription ids, the per-subscription lister wants the full records.
  const machines = config.useResourceGraph === false
    ? await fetchMachinesViaSubscriptionList(config, subscriptions, signal)
    : await fetchMachinesViaResourceGraph(config, subscriptions.map((s) => s.subscriptionId), signal);
  return filterArcMachines(machines, config).map((m) => ({
    armId: m.armId,
    name: m.name,
    subscriptionId: m.subscriptionId,
    resourceGroup: m.resourceGroup,
    azureRegion: m.azureRegion,
    osType: m.osType,
    status: m.status,
  }));
}
