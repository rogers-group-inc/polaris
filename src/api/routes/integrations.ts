/**
 * src/api/routes/integrations.ts — Integration CRUD + connection testing
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { purgeDirectoryContacts } from "../../services/directorySyncService.js";
import { bumpDirectoryCache } from "../../services/directorySearchService.js";
import { requirePermission, hasPermission } from "../middleware/permissions.js";
import * as fortimanager from "../../services/fortimanagerService.js";
import { getFmgActivityForIntegration } from "../../services/fmgActivityService.js";
import { getIntegrationHealthSummary } from "../../services/integrationHealthService.js";
import * as fortigate from "../../services/fortigateService.js";
import * as windowsServer from "../../services/windowsServerService.js";
import * as entraId from "../../services/entraIdService.js";
import * as activeDirectory from "../../services/activeDirectoryService.js";
import * as vcenter from "../../services/vcenterService.js";
import * as azureArc from "../../services/azureArcService.js";
import { isValidIpAddress, ipInCidr, isPrivateIpv4 } from "../../utils/cidr.js";
import { isFortinetIntegrationType } from "../../utils/pollingCompatibility.js";
import { SECRET_MASK, isMaskedSecret } from "../../utils/secretMask.js";
import { isBlockedOutboundHost } from "../../utils/netGuard.js";
import { logEvent } from "./events.js";
import { getBaselines } from "../../services/discoveryDurationService.js";
import { requestCancel, listActiveRuns } from "../../services/discoveryRunState.js";
import { releaseDnsResolvedAt } from "../../services/dnsResolvedReservationService.js";
import { invalidateMonitorSettingsCache } from "../../services/monitoringService.js";
import * as autoMonitor from "../../services/autoMonitorInterfacesService.js";
import * as autoMonitorStorage from "../../services/autoMonitorStorageService.js";
import {
  snapshotAddAsMonitoredByAssetType,
  sweepMonitoredForIntegration,
} from "../../services/monitorOverrideService.js";
import { checkForSlowRuns, triggerDiscovery } from "../../services/discovery/discoveryEngine.js";

const router = Router();

// Detect the masked-secret sentinel the GET endpoints emit (eight or more
// U+2022 BULLET characters). The integration edit modal pre-fills sensitive
// fields with this string; if the operator saves without retyping, the form
// echoes the bullets back to us and we MUST treat them as "no change" rather
// than persisting them as the real secret. Failing to do so produces auth
// tokens like "Bearer ••••••••" which Node's HTTP layer rejects with a
// "ByteString" error on the next API call.
function isMaskedSecretSentinel(value: unknown): boolean {
  return isMaskedSecret(value);
}

// ─── Query-API per-request credential override ──────────────────────────────
//
// The ad-hoc Query API tool may send a FortiGate API token with the request,
// used for THAT call only. The need is concrete: under FMG bypass mode Polaris
// stores ONE `fortigateApiToken` for the whole managed fleet, so when a token
// works on some gates and not others the operator has no way to try a different
// one without editing the integration — which would repoint discovery, polling
// and DHCP push at an unproven credential just to run a test.
//
// The override is deliberately NOT persisted anywhere: not to the integration,
// not to Events (the audit line records only THAT an override was used), and
// not to the browser's saved-query store. It lives for the duration of one
// request. Callers must never echo it back in a response.
//
// Note this widens no privilege: the route already sits behind
// `integrations:write`, and a caller with that level can rewrite the stored
// token outright. It only avoids making a destructive edit to run a read.
const OverrideApiTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  // A masked echo from a form must never be sent to a device as a token — the
  // same trap the stored-secret merge paths guard against.
  .refine((v) => !isMaskedSecretSentinel(v), "API token override looks like a masked placeholder")
  .optional();

const OverrideApiUserSchema = z.string().trim().min(1).max(128).optional();

/**
 * Return the integration config with its FortiGate credentials swapped for the
 * per-request override, or the config unchanged when no override was supplied.
 *
 * The field the token lands in differs by integration type: a standalone
 * FortiGate authenticates with `apiToken`, while an FMG in bypass mode carries
 * the per-gate credential as `fortigateApiToken` (its own `apiToken` is the
 * FortiManager's and is still needed to resolve the device's management IP —
 * so the FMG branch must not touch it).
 *
 * Returns a SHALLOW COPY; the caller's config object is never mutated, since it
 * came from Prisma and may be shared.
 */
function overrideFortigateCreds(
  config: unknown,
  apiToken: string | undefined,
  apiUser: string | undefined,
  type: "fortigate" | "fortimanager",
): Record<string, unknown> {
  const base = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  if (!apiToken && !apiUser) return base;
  const out = { ...base };
  if (type === "fortigate") {
    if (apiToken) out.apiToken = apiToken;
    if (apiUser) out.apiUser = apiUser;
  } else {
    if (apiToken) out.fortigateApiToken = apiToken;
    if (apiUser) out.fortigateApiUser = apiUser;
  }
  return out;
}

// Safely stringify a proxy-query response, converting v8 string-limit and oversized
// payloads into a helpful 413 instead of an opaque 500.
const PROXY_RESPONSE_MAX_BYTES = 25 * 1024 * 1024;
function sendProxyJson(res: import("express").Response, result: unknown): void {
  let body: string;
  try {
    body = JSON.stringify(result);
  } catch (e) {
    if (e instanceof RangeError) {
      throw new AppError(413, "Response too large to return — narrow the query with filter= or format= parameters");
    }
    throw e;
  }
  if (body.length > PROXY_RESPONSE_MAX_BYTES) {
    const mb = (body.length / 1024 / 1024).toFixed(1);
    throw new AppError(413, `Response is ${mb} MB — narrow the query with filter= or format= parameters`);
  }
  res.type("application/json").send(body);
}

// Pre-compile every pattern in fortigate/switch/ap autoMonitor blocks so a
// syntactically broken pattern fails the save with a clear label instead of
// throwing later inside the apply pass. Dispatches on the block's `regex`
// flag — wildcards via compileWildcard, raw regex via compilePattern.
// Idempotent on configs without any byPatterns block.
function validateAutoMonitorPatterns(cfg: any): void {
  if (!cfg || typeof cfg !== "object") return;
  const labels: Record<string, string> = {
    fortigateMonitor:   "FortiGate auto-monitor",
    fortiswitchMonitor: "FortiSwitch auto-monitor",
    fortiapMonitor:     "FortiAP auto-monitor",
  };
  for (const field of Object.keys(labels)) {
    const sel = cfg[field]?.autoMonitorInterfaces;
    const byPatterns = sel?.byPatterns;
    if (!byPatterns || !Array.isArray(byPatterns.patterns)) continue;
    const isRegex = byPatterns.regex === true;
    for (const pat of byPatterns.patterns) {
      try {
        autoMonitor.compilePattern(pat, isRegex);
      } catch (err: any) {
        const flavor = isRegex ? "regex" : "pattern";
        throw new AppError(400, `${labels[field]} — invalid ${flavor} "${pat}": ${err?.message || "compile failed"}`);
      }
    }
  }
}

// GET /api/v1/integrations/health-summary — sidebar polling target. Returns
// the enabled integrations whose most recent connection test failed, so the
// sidebar can surface a notice prompting an operator to look, PLUS the
// FortiManager integrations whose fleet has outgrown the proxy transport.
// Lives in the read-gated section so any user who can see the integrations
// list also sees both indicators. Logic lives in integrationHealthService.
router.get("/health-summary", async (_req, res, next) => {
  try {
    res.json(await getIntegrationHealthSummary());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/integrations/:id/fmg-activity — live readout of this
// integration's FmgWorker proxy + native lane state, fed by the heartbeat
// snapshot written by the process that runs FMG traffic (discovery role in
// split-role prod, the single process in "all" mode). Lives in the read-gated
// section so the integrations page can poll without write access.
router.get("/:id/fmg-activity", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
      select: { id: true, type: true },
    });
    if (!integration) throw new AppError(404, "Integration not found");
    if (integration.type !== "fortimanager") {
      throw new AppError(400, "fmg-activity only applies to fortimanager integrations");
    }
    const readout = await getFmgActivityForIntegration(req.params.id);
    res.json(readout);
  } catch (err) {
    next(err);
  }
});

// /integrations is mounted with `integrations=read` at router.ts so any
// authenticated caller with read access can see the integration list. Every
// route below this line is a write — escalate the bar to `integrations=write`.
router.use(requirePermission("integrations", "write"));

// ─── Agent auto-deploy is an assets=fullwrite grant ──────────────────────
//
// `agentDeploy.enabled` on a class block makes discovery push the Polaris
// Agent to every newly-discovered agent-less device of that class — the same
// act as POST /assets/:id/agent/install, at fleet scale and unattended. That
// route is gated `assets=fullwrite` (see the deployment note in
// api/routes/assets.ts), so turning the toggle ON is gated the same way,
// CHAINED onto `integrations=write`: without it an integrations-write role
// (built-in `networkadmin`, which holds assets=read) could deploy the agent
// to the whole fleet through a checkbox it was never allowed to click on one
// device. Only the ON transition is gated — turning it OFF, and every save
// that leaves it as it was, need nothing extra, so a role that inherited an
// enabled block can still edit the rest of the integration (and switch it
// off).
const AGENT_DEPLOY_BLOCK_KEYS = ["workstationMonitor", "serverMonitor", "vmMonitor", "hostMonitor"] as const;

function agentDeployEnabledIn(config: unknown, blockKey: string): boolean {
  const block = (config as Record<string, any> | null | undefined)?.[blockKey];
  return !!block?.agentDeploy?.enabled;
}

function assertAgentDeployGrant(req: Request, prevConfig: unknown, nextConfig: unknown): void {
  const turnedOn = AGENT_DEPLOY_BLOCK_KEYS.filter(
    k => agentDeployEnabledIn(nextConfig, k) && !agentDeployEnabledIn(prevConfig, k),
  );
  if (turnedOn.length === 0) return;
  if (hasPermission(req, "assets", "fullwrite")) return;
  throw new AppError(
    403,
    "Forbidden — enabling Polaris Agent auto-deploy requires Full Read-Write on Assets " +
    "(the same grant as deploying the agent to a single device).",
  );
}


// ─── Zod Schemas ─────────────────────────────────────────────────────────────

// "Auto-Monitor Interfaces" selection persisted on each *Monitor block. The
// shape is a multi-block union — each key is optional, presence = block on,
// and the apply pass takes the UNION across whichever blocks are present.
// `null` (or all keys missing) means the whole feature is off for that class.
// Strictly additive: discovery never strips an asset's monitoredInterfaces.
//
// `.strict()` on each block catches accidental fields (e.g. `onlyUp` on
// byNames) as a 400 instead of silent strip. The outer preprocess coerces
// the legacy single-mode shape (`{mode:"names"|"wildcard"|"type", ...}`)
// produced by older clients / stored configs into the new shape so PUTs
// from older UIs and migration-pending rows keep working.
const ByNamesSchema = z.object({
  names: z.array(z.string().trim().min(1)).min(1, "Pick at least one interface name").max(200, "Too many names — pick at most 200"),
}).strict();
const ByPatternsSchema = z.object({
  patterns: z.array(z.string().trim().min(1)).min(1, "Add at least one pattern").max(50, "Too many patterns — keep it under 50"),
  regex:    z.boolean().optional().default(false),
  onlyUp:   z.boolean().optional().default(false),
}).strict();
const ByTypesSchema = z.object({
  types:  z.array(z.enum(["physical", "aggregate", "vlan", "loopback", "tunnel"])).min(1),
  onlyUp: z.boolean().optional().default(true),
  // Tunnel-only exception to onlyUp: pin fully-down IPsec tunnels too. No-op
  // unless "tunnel" is among `types` AND onlyUp is true.
  includeDownTunnels: z.boolean().optional().default(false),
}).strict();
const ByLldpSchema = z.object({
  neighborTypes: z.array(z.enum(["firewall", "switch", "access_point", "server", "workstation", "router", "printer", "other"])).min(1),
}).strict();

const AutoMonitorInterfacesSchema = z.preprocess(
  // Coerce the legacy single-mode shape into the multi-block shape so older
  // saved bodies parse cleanly. New-shape bodies fall through unchanged.
  (val: any) => {
    if (!val || typeof val !== "object") return val;
    if ("byNames" in val || "byPatterns" in val || "byTypes" in val || "byLldp" in val) return val;
    if (val.mode === "names"    && Array.isArray(val.names))    return { byNames: { names: val.names } };
    if (val.mode === "wildcard" && Array.isArray(val.patterns)) return { byPatterns: { patterns: val.patterns, regex: false, onlyUp: val.onlyUp === true } };
    if (val.mode === "type"     && Array.isArray(val.types))    return { byTypes:    { types: val.types, onlyUp: val.onlyUp !== false } };
    return val;
  },
  z.object({
    byNames:    ByNamesSchema.optional(),
    byPatterns: ByPatternsSchema.optional(),
    byTypes:    ByTypesSchema.optional(),
    byLldp:     ByLldpSchema.optional(),
  }).strict().nullable().optional().default(null),
);

// Auto-monitor STORAGE selection (AD / Entra workstation+server classes).
// Net-new — no legacy stored shape exists, so (unlike interfaces) there is no
// preprocess coercion. Storage's only sample dimension is `mountPath`
// (AssetStorageSample.mountPath), so the selection is mountPath-shaped:
//   byNames    — exact mountPaths picked from the discovered aggregate
//   byPatterns — wildcard (default) or regex matched against mountPath
//   all        — pin every observed mount on every device of the class
//                (safe here: mount counts per device are small, unlike the
//                hundreds of interfaces a firewall carries — so interfaces
//                deliberately never offered an `all` block, storage does)
// Resolved/applied by src/services/autoMonitorStorageService.ts; the matched
// mountPaths are unioned (strictly additive) into Asset.monitoredStorage.
const StorageByNamesSchema = z.object({
  names: z.array(z.string().trim().min(1)).min(1, "Pick at least one mount").max(200, "Too many mounts — pick at most 200"),
}).strict();
const StorageByPatternsSchema = z.object({
  patterns: z.array(z.string().trim().min(1)).min(1, "Add at least one pattern").max(50, "Too many patterns — keep it under 50"),
  regex:    z.boolean().optional().default(false),
}).strict();
const StorageAllSchema = z.object({
  all: z.literal(true),
}).strict();

const AutoMonitorStorageSchema = z.object({
  byNames:    StorageByNamesSchema.optional(),
  byPatterns: StorageByPatternsSchema.optional(),
  all:        StorageAllSchema.optional(),
}).strict().nullable().optional().default(null);

// Per-class per-stream config block (Phase 2). Each integration carries one
// per asset class (FortiGate / FortiSwitch / FortiAP / Workstations / Servers
// depending on type). Every field is nullable so an operator can leave
// individual cells blank and inherit from the integration tier baseline /
// source default. `failureThreshold` only applies to responseTime; the
// resolver ignores it on the other streams.
const ClassStreamSchema = z.object({
  polling:          z.enum(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled"]).nullable().optional(),
  credentialId:     z.string().uuid().nullable().optional(),
  intervalSeconds:  z.number().int().min(1).max(86400).nullable().optional(),
  timeoutMs:        z.number().int().min(100).max(120000).nullable().optional(),
  failureThreshold: z.number().int().min(1).max(100).nullable().optional(),
  // Fast-confirm re-probe cadence (business rule 30) — responseTime only, same
  // as failureThreshold: they're one policy ("how many confirmations, how fast").
  fastConfirmIntervalSec: z.number().int().min(5).max(300).nullable().optional(),
  mibId:            z.string().nullable().optional(),
}).partial();

const ClassStreamsSchema = z.object({
  responseTime: ClassStreamSchema.optional(),
  cpuMemory:    ClassStreamSchema.optional(),
  temperature:  ClassStreamSchema.optional(),
  interfaces:   ClassStreamSchema.optional(),
  lldp:         ClassStreamSchema.optional(),
  // Storage is nullable at the class block level so the FortiAP class block
  // can carry an explicit null (APs have no mountable storage). The resolver
  // drops storage entries silently for FortiAP regardless.
  storage:      ClassStreamSchema.nullable().optional(),
}).partial();

// Per-integration switch/AP monitor stamping. When `enabled` is true,
// discovery sets each newly-found FortiSwitch/FortiAP's monitorType to
// "snmp" with the chosen credential — but only when the asset has no
// operator override. `addAsMonitored` controls whether `monitored=true`
// is also stamped on those new assets; without it they're created with
// monitorType configured but `monitored=false`, so operators can opt in
// asset-by-asset later. `addAsMonitored` requires `enabled` to be true
// (a switch/AP can't be monitored without a monitorType).
//
// Phase 2: `streams` carries the per-(class, stream) per-asset-class config
// (polling method / credential / interval / timeout / mibId per stream,
// failureThreshold on responseTime only). Operators edit each class's
// streams block from its subtab on the integration's Monitoring tab; the
// resolver dispatches into this block by Asset.assetType.
const FortinetClassMonitorSchema = z.object({
  enabled:               z.boolean().optional().default(false),
  snmpCredentialId:      z.string().uuid().nullable().optional(),
  // Stored SSH credential used when the integration tier resolves any stream
  // for this asset class to "ssh". Type-aware sibling to snmpCredentialId.
  sshCredentialId:       z.string().uuid().nullable().optional(),
  addAsMonitored:        z.boolean().optional().default(false),
  autoMonitorInterfaces: AutoMonitorInterfacesSchema,
  streams:               ClassStreamsSchema.optional(),
}).optional().default({ enabled: false, snmpCredentialId: null, sshCredentialId: null, addAsMonitored: false, autoMonitorInterfaces: null });

// FortiGate-class equivalent. FortiGates always get a monitorType stamped
// at discovery (the integration's native type), so this block only carries
// the `addAsMonitored` flag — no credential/enabled toggle needed.
//
// `pullSnmpLocation` (off by default) opts the integration into pulling
// SNMP sysLocation (OID 1.3.6.1.2.1.1.6.0) from each managed FortiGate
// during discovery, surfacing it on `Asset.snmpLocation` (General tab +
// the asset edit modal's Location prefill). Uses the resolved
// integration-tier monitoring SNMP credential.
//
// `useSnmpLocationCoords` (off by default; requires `pullSnmpLocation`)
// additionally geocodes the pulled sysLocation via Nominatim and uses the
// result as the FortiGate's map position. Geocoded coords are projection
// tier-1 — they OVERRIDE coordinates learned from the device (FMG metavars
// and CMDB gui-device-latitude/longitude), which is why this is a separate
// opt-in from the pull itself. (Pre-2026-07 builds geocoded implicitly
// whenever the pull was on; installs relying on that behavior must enable
// this toggle after updating.) The FMG-only `addressMetavar` geocode path
// is independent of this toggle.
//
// `pushGeocodedCoords` (off by default; UI-disabled when no geocode source
// is active) writes the geocoded lat/lng back to the FortiGate when the
// geocode path landed coords. FMG mode writes to BOTH the per-device
// metavars (named by `latitudeMetavar` / `longitudeMetavar`, defaulting to
// `Latitude` / `Longitude`) AND the CMDB `gui-device-latitude` /
// `gui-device-longitude` fields. Standalone FortiGate writes CMDB only.
//
// `latitudeMetavar` / `longitudeMetavar` name the FMG per-device metavariables
// Polaris reads (the discovery-time coord fallback) and writes (push-back).
// They default to FMG's common `Latitude` / `Longitude` convention; operators
// using a different metavar naming scheme override them here. Blank coerces
// back to the default. FMG-only — ignored by the standalone FortiGate path.
//
// `addressMetavar` names a FMG per-device metavariable holding a street
// address. When set + populated, Polaris geocodes that address string instead
// of (and in preference to) the SNMP sysLocation — the opt-in path for
// operators who don't want to pull sysLocation. Blank = disabled (default).
// FMG-only.
const MetavarName = (fallback: string) =>
  z.string().optional().default(fallback).transform((v) => v.trim() || fallback);
const FortiGateClassMonitorSchema = z.object({
  addAsMonitored:        z.boolean().optional().default(false),
  autoMonitorInterfaces: AutoMonitorInterfacesSchema,
  pullSnmpLocation:      z.boolean().optional().default(false),
  useSnmpLocationCoords: z.boolean().optional().default(false),
  pushGeocodedCoords:    z.boolean().optional().default(false),
  latitudeMetavar:       MetavarName("Latitude"),
  longitudeMetavar:      MetavarName("Longitude"),
  addressMetavar:        z.string().optional().default("").transform((v) => v.trim()),
  streams:               ClassStreamsSchema.optional(),
}).optional().default({
  addAsMonitored: false,
  autoMonitorInterfaces: null,
  pullSnmpLocation: false,
  useSnmpLocationCoords: false,
  pushGeocodedCoords: false,
  latitudeMetavar: "Latitude",
  longitudeMetavar: "Longitude",
  addressMetavar: "",
});

// SSRF guard shared by every integration config schema that carries a `host`.
// Blocks loopback / link-local / cloud-metadata / multicast literals while
// leaving RFC1918 LAN device addresses (the normal target) allowed. Empty host
// is permitted — a not-yet-configured integration. See src/utils/netGuard.ts
// and the 2026-06-03 security review (M4).
function refineConfigHost(cfg: { host?: string }, ctx: z.RefinementCtx): void {
  if (cfg.host && isBlockedOutboundHost(cfg.host)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["host"],
      message:
        `Host "${cfg.host.trim()}" is in a blocked range (loopback / link-local / ` +
        `metadata / multicast) and cannot be used as an integration target. ` +
        `Use the device's routable LAN address.`,
    });
  }
}

const FortiManagerConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(443),
  apiUser:   z.string().optional().default(""),
  apiToken:  z.string().optional().default(""),
  adom:      z.string().optional().default("root"),
  // Default verify-ON for NEW integrations (2026-06-03 review, M1). Existing
  // rows carry an explicit stored value and the update path preserves it, so
  // this default never changes a configured integration's behavior — it only
  // makes a freshly-created one secure-by-default. Read paths honor the stored
  // value (`config.verifySsl === false` disables); an operator can still opt
  // out per-integration via the Monitoring tab (with a UI warning).
  verifySsl: z.boolean().optional().default(true),
  mgmtInterface: z.string().optional().default(""),
  interfaceInclude: z.array(z.string()).optional().default([]),
  interfaceExclude: z.array(z.string()).optional().default([]),
  dhcpInclude:   z.array(z.string()).optional().default([]),
  dhcpExclude:   z.array(z.string()).optional().default([]),
  inventoryExcludeInterfaces: z.array(z.string()).optional().default([]),
  inventoryIncludeInterfaces: z.array(z.string()).optional().default([]),
  deviceInclude: z.array(z.string()).optional().default([]),
  deviceExclude: z.array(z.string()).optional().default([]),
  discoveryParallelism: z.number().int().min(1).max(20).optional().default(5),
  useProxy: z.boolean().optional().default(true),
  fortigateApiUser:  z.string().optional().default(""),
  fortigateApiToken: z.string().optional().default(""),
  // FMG direct-mode (useProxy=false) TLS verification on the FortiGate REST
  // connections. Default verify-ON for NEW integrations (2026-06-03 review, M1).
  // Read path is `config.fortigateVerifySsl === true`, so existing rows (explicit
  // false, or legacy-undefined) keep their current no-verify behavior — only a
  // freshly-created integration is secure-by-default.
  fortigateVerifySsl: z.boolean().optional().default(true),
  // Optional: stored SNMP credential used by the integration's per-stream
  // polling-method tier-3 setting (Integration.config.monitorSettings.polling)
  // when the operator picks SNMP for a stream. Without a credential, the
  // resolver falls back to the source default and SNMP-keyed streams surface
  // a configuration error in the System tab refresh toast.
  monitorCredentialId: z.string().uuid().nullable().optional(),
  // Stored SSH credential used by the integration's per-stream polling-method
  // tier-3 setting when the operator picks SSH for a stream. Type-aware
  // sibling to monitorCredentialId (which carries the SNMP credential).
  sshCredentialId: z.string().uuid().nullable().optional(),
  // Per-class auto-monitor settings for assets discovered through this
  // integration. fortigateMonitor only carries `addAsMonitored` since
  // FortiGates always get a discoveredByIntegrationId stamp at discovery;
  // the switch / AP blocks also carry the SNMP-direct-polling toggle + credential.
  fortigateMonitor:   FortiGateClassMonitorSchema,
  fortiswitchMonitor: FortinetClassMonitorSchema,
  fortiapMonitor:     FortinetClassMonitorSchema,
  // When true, manual reservations created on subnets discovered by this
  // integration are pushed to the FortiGate at create time. Transport follows
  // useProxy: true → write via FMG /sys/proxy/json; false → write direct to
  // each FortiGate's REST API using fortigateApiUser/fortigateApiToken. The
  // push is verified by reading the entry back; any failure aborts the
  // reservation create entirely (no row persisted).
  pushReservations: z.boolean().optional().default(false),
  // When true, quarantining an asset will push MAC-based address-group
  // entries to every FortiGate seen by this integration that has sighted the
  // asset within the sightingMaxAgeDays window. Default false; operators must
  // opt in explicitly because quarantine push requires write access to the
  // FortiGate's address-group configuration.
  pushQuarantine: z.boolean().optional().default(false),
  // When true, each system-info pass for FortiGates owned by this integration
  // also pulls SD-WAN data: Performance SLA health-check metrics
  // (/api/v2/monitor/virtual-wan/health-check) and SD-WAN service-rule member
  // selection (/api/v2/cmdb/system/sdwan). Surfaced on the asset's SD-WAN tab.
  // FortiOS-only; default off. Mirrored on FortiGateConfigSchema for parity.
  pullSdwan: z.boolean().optional().default(false),
  // ARP presence sweep. When true, right before each discovery cycle reads a
  // FortiGate's ARP table, Polaris fires one fire-and-forget UDP datagram at
  // every active dhcp_reservation IP on that device's subnets — forcing the
  // gate to ARP-resolve them so live-but-quiet devices (statically
  // configured, ICMP-firewalled) land in the table and stamp
  // Reservation.lastSeenArp for stale detection. Requires Polaris→subnet
  // routing + a permitting firewall policy to have any effect; where the
  // packet can't reach, the sweep silently does nothing (absence of an ARP
  // entry is never treated as evidence of absence). Default off — an
  // unannounced sweep of every reserved IP is IDS-visible, so operators must
  // opt in. Mirrored on FortiGateConfigSchema for parity.
  arpPresenceSweep: z.boolean().optional().default(false),
  // Auto-reserve discovered Fortinet infrastructure. When true, each discovery
  // cycle writes a real MAC→IP `reserved-address` entry on the owning FortiGate
  // for managed FortiSwitches / FortiAPs that currently hold their address by
  // dynamic lease — pinning an address the device is ALREADY using, so the
  // pool's occupancy doesn't change. Requires pushReservations (the transport
  // gate) and is ignored without it. Default off, and deliberately so: every
  // other DHCP write Polaris makes is an operator acting on one IP, whereas this
  // one runs on a schedule across a fleet. Bounded per cycle, MAC taken only
  // from the gate's own lease table, verified by read-back. Mirrored on
  // FortiGateConfigSchema for parity. See business rule 23.
  autoReserveFortinetInfra: z.boolean().optional().default(false),
  // Adopt the discovered device's MAC onto a PLACEHOLDER-MAC reservation. When
  // true, discovery replaces the synthetic MAC Polaris generated for a
  // not-yet-racked device with the real MAC of whatever it now sees answering at
  // that reserved IP (ARP table / device inventory), and re-pushes the corrected
  // binding to the gate. Only ever overwrites a MAC matching the configured
  // placeholder prefix — an operator-typed MAC is never touched. Requires
  // pushReservations (the transport gate) and is ignored without it. Default off.
  // Mirrored on FortiGateConfigSchema for parity. See business rule 26.
  adoptDiscoveredMac: z.boolean().optional().default(false),
  // Description sync (Polaris-primary). When true, operator descriptions in
  // Polaris are written back to the devices this integration discovered —
  // interface comments (AssetInterfaceOverride) to FortiGate system/interface
  // `description` / FortiSwitch port `description`, and Asset.description to
  // the device (FortiGate system/global `alias`, FortiSwitch managed-switch
  // `description`, FortiAP wtp `comment`). Where Polaris has no value, the
  // device value is adopted (seeded) instead. Polaris is primary: once it
  // holds a value, device-side edits are overwritten on the next sync
  // (audited). Transport follows useProxy, same as pushReservations. Default
  // off; requires device-config write access on the FMG admin profile / API
  // token. Mirrored on FortiGateConfigSchema for parity.
  syncDescriptions: z.boolean().optional().default(false),
  // Interface name to read for a managed FortiSwitch's management-access
  // (allowaccess) during the Phase 13.6 read. Defaults to "internal" at read
  // time when unset. The firewall's own management interface reuses
  // `mgmtInterface` above. FortiOS-only; mirrored on FortiGateConfigSchema.
  switchManagementInterface: z.string().trim().optional(),
  // When true, LLDP collection skips FortiLink-enabled interfaces (the
  // fortilink-flagged aggregate + its member ports, per the FortiGate CMDB
  // `fortilink` flag), so internal FortiGate↔FortiSwitch links don't appear in
  // the asset's LLDP Neighbor column. Filters at collection time on each
  // system-info pass; excluded neighbors age out on the next per-asset replace.
  // Peer-inferred FortiLink rows (synthesized from topology) are unaffected.
  // FortiOS-only; default off. Mirrored on FortiGateConfigSchema for parity.
  excludeFortilinkLldp: z.boolean().optional().default(false),
  // When true, the next discovery cycle AND every monitor job published for
  // assets owned by this integration will emit step-by-step structured logs
  // to pino at info level (visible in `journalctl -u polaris`). High log
  // volume — operators flip on for diagnosis and flip off when done.
  verboseLogging: z.boolean().optional().default(false),
}).superRefine(refineConfigHost);

const FortiGateConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(443),
  apiUser:   z.string().optional().default(""),
  apiToken:  z.string().optional().default(""),
  vdom:      z.string().optional().default("root"),
  // Default verify-ON for NEW integrations (2026-06-03 review, M1). Existing
  // rows carry an explicit stored value and the update path preserves it, so
  // this default never changes a configured integration's behavior — it only
  // makes a freshly-created one secure-by-default. Read paths honor the stored
  // value (`config.verifySsl === false` disables); an operator can still opt
  // out per-integration via the Monitoring tab (with a UI warning).
  verifySsl: z.boolean().optional().default(true),
  mgmtInterface: z.string().optional().default(""),
  dhcpInclude:   z.array(z.string()).optional().default([]),
  dhcpExclude:   z.array(z.string()).optional().default([]),
  inventoryExcludeInterfaces: z.array(z.string()).optional().default([]),
  inventoryIncludeInterfaces: z.array(z.string()).optional().default([]),
  monitorCredentialId: z.string().uuid().nullable().optional(),
  sshCredentialId:    z.string().uuid().nullable().optional(),
  fortigateMonitor:   FortiGateClassMonitorSchema,
  fortiswitchMonitor: FortinetClassMonitorSchema,
  fortiapMonitor:     FortinetClassMonitorSchema,
  // Push manual reservations to the gate at create time — see
  // FortiManagerConfigSchema.pushReservations for shape + semantics. Transport
  // is always direct REST here (there is no FMG proxy to choose). Default off.
  //
  // These two were absent until 2026-08-31 while the shared Add/Edit modal
  // rendered the DHCP Push and Quarantine Push tabs for this type all along
  // (`_integrationTabs` gates them on `isFmg || isFgt`). z.object STRIPS
  // unknown keys, so ticking either box in the ADD flow silently dropped it:
  // the integration saved clean, the tab came back unticked, and
  // `quarantineAsset` skipped every sighting from it — surfacing as
  // "0/N FortiGate(s) accepted the push" rather than as a missing setting.
  // Only the Edit flow persisted them, and only by accident: the PUT validates
  // config as z.record(z.unknown()) and merges. Anything the UI offers on a
  // type has to exist in that type's create schema.
  pushReservations: z.boolean().optional().default(false),
  // Push asset quarantine entries to the gate — see
  // FortiManagerConfigSchema.pushQuarantine for shape + semantics. Default off.
  pushQuarantine: z.boolean().optional().default(false),
  // Pull SD-WAN Performance SLA health-check metrics + service-rule member
  // selection on each system-info pass. See FortiManagerConfigSchema.pullSdwan
  // for shape + semantics. FortiOS-only; default off.
  pullSdwan: z.boolean().optional().default(false),
  // ARP presence sweep — see FortiManagerConfigSchema.arpPresenceSweep for
  // shape + semantics. Default off.
  arpPresenceSweep: z.boolean().optional().default(false),
  // Auto-reserve discovered Fortinet infrastructure — see
  // FortiManagerConfigSchema.autoReserveFortinetInfra for shape + semantics.
  // Requires pushReservations. Default off.
  autoReserveFortinetInfra: z.boolean().optional().default(false),
  // Adopt the discovered device's MAC onto a placeholder-MAC reservation — see
  // FortiManagerConfigSchema.adoptDiscoveredMac for shape + semantics.
  // Requires pushReservations. Default off.
  adoptDiscoveredMac: z.boolean().optional().default(false),
  // Description sync (Polaris-primary) — see FortiManagerConfigSchema
  // .syncDescriptions for shape + semantics. Default off.
  syncDescriptions: z.boolean().optional().default(false),
  // Interface name to read for a managed FortiSwitch's management-access
  // (allowaccess) during the Phase 13.6 read. Defaults to "internal" when
  // unset. See FortiManagerConfigSchema.switchManagementInterface.
  switchManagementInterface: z.string().trim().optional(),
  // Exclude FortiLink-enabled interfaces from LLDP collection. See
  // FortiManagerConfigSchema.excludeFortilinkLldp for shape + semantics.
  // FortiOS-only; default off.
  excludeFortilinkLldp: z.boolean().optional().default(false),
  // Per-integration verbose debug logging — see FortiManagerConfigSchema for
  // shape + semantics. Default false.
  verboseLogging: z.boolean().optional().default(false),
}).superRefine(refineConfigHost);

// Per-class monitor block for AD / Entra / Windows Server integrations.
// Mirrors the FMG/FortiGate class blocks but with the workstation/server
// shape — no `enabled` toggle (those integrations always discover),
// no per-class snmpCredentialId / sshCredentialId at the block level
// (per-stream credentials inside `streams` cover those), and no FortiGate-
// specific pullSnmpLocation / pushGeocodedCoords.
//
// `autoMonitorInterfaces` / `autoMonitorStorage`: post-discovery the matching
// interfaces / storage mounts are unioned into Asset.monitoredInterfaces /
// Asset.monitoredStorage (strictly additive, runs every discovery). These
// devices only produce interface/storage samples once the Polaris Agent is
// deployed and reporting, so the pins land on the discovery cycle after the
// agent first checks in — self-healing by design.
//
// `agentDeploy`: opt-in (default off). When enabled, discovery pushes the
// Polaris Agent to newly-discovered, agent-less devices of this class using
// the chosen SSH and/or WinRM credential (platform inferred from the device
// OS). Bounded concurrency + a per-run kickoff ceiling pace the rollout. See
// src/services/agentAutoDeployService.ts.
const AgentDeploySchema = z.object({
  enabled:           z.boolean().optional().default(false),
  sshCredentialId:   z.string().uuid().nullable().optional(),
  winrmCredentialId: z.string().uuid().nullable().optional(),
  maxConcurrent:     z.number().int().min(1).max(20).optional().default(4),
}).strict().nullable().optional().default(null);

const WorkstationServerClassMonitorSchema = z.object({
  enabled:               z.boolean().optional().default(true),
  addAsMonitored:        z.boolean().optional().default(false),
  autoMonitorInterfaces: AutoMonitorInterfacesSchema,
  autoMonitorStorage:    AutoMonitorStorageSchema,
  agentDeploy:           AgentDeploySchema,
  streams:               ClassStreamsSchema.optional(),
}).optional().default({ enabled: true, addAsMonitored: false, autoMonitorInterfaces: null, autoMonitorStorage: null, agentDeploy: null });

const WindowsServerConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(5985),
  username:  z.string().optional().default(""),
  password:  z.string().optional().default(""),
  useSsl:    z.boolean().optional().default(false),
  domain:    z.string().optional().default(""),
  dhcpInclude: z.array(z.string()).optional().default([]),
  dhcpExclude: z.array(z.string()).optional().default([]),
  // Per-class per-stream config for assets this integration discovers.
  workstationMonitor: WorkstationServerClassMonitorSchema,
  serverMonitor:      WorkstationServerClassMonitorSchema,
  // Per-integration verbose debug logging.
  verboseLogging: z.boolean().optional().default(false),
}).superRefine(refineConfigHost);

/**
 * The GAL sync's exclusion filter. Shared verbatim by the Entra and AD config
 * schemas — the two directories differ in what they can ANSWER, not in what an
 * operator wants to exclude, so one shape keeps the Directory tab identical
 * between them.
 *
 * Defaults live in normalizeDirectorySyncFilter, not here: the service is
 * reached by the discovery pass reading a stored config that may predate any
 * given field, so it cannot rely on route validation having filled them in.
 */
const DirectorySyncFilterSchema = z.object({
  excludeDisabled:        z.boolean().optional(),
  excludeSharedMailboxes: z.boolean().optional(),
  includeGroups:          z.boolean().optional(),
  includeOrgContacts:     z.boolean().optional(),
  ouInclude:     z.array(z.string().max(512)).max(100).optional(),
  ouExclude:     z.array(z.string().max(512)).max(100).optional(),
  groupExclude:  z.array(z.string().max(512)).max(50).optional(),
  domainInclude: z.array(z.string().max(253)).max(50).optional(),
  domainExclude: z.array(z.string().max(253)).max(50).optional(),
  nameExclude:   z.array(z.string().max(200)).max(100).optional(),
  maxEntries:    z.number().int().min(1).max(50_000).optional(),
}).optional().default({});

const EntraIdConfigSchema = z.object({
  tenantId:      z.string().optional().default(""),
  clientId:      z.string().optional().default(""),
  clientSecret:  z.string().optional().default(""),
  enableIntune:  z.boolean().optional().default(false),
  deviceInclude: z.array(z.string()).optional().default([]),
  deviceExclude: z.array(z.string()).optional().default([]),
  // Post-sync network-presence verification (agent/probe signals + ICMP
  // fallback) — keeps Asset.lastSeen honest now that directory timestamps
  // no longer write it. Default ON (read-only against the targets); see
  // src/services/presenceVerificationService.ts.
  verifyPresence: z.boolean().optional().default(true),
  // Address-book GAL search (live typeahead; nothing is persisted). Default
  // OFF because it needs directory-read permissions this integration has never
  // required — without them every keystroke would 403. See
  // src/services/directorySearchService.ts.
  enableDirectorySearch: z.boolean().optional().default(false),
  // Address-book GAL SYNC (scheduled; stores the roster). Deliberately a
  // SEPARATE toggle from the search above: they need the same directory
  // grants, but they are not the same decision, because one reads and one
  // stores. Default OFF — switching it on puts employee names, addresses,
  // titles, departments and phone numbers in the database and in every
  // backup. See business rule 35 and src/services/directorySyncService.ts.
  enableDirectorySync: z.boolean().optional().default(false),
  directorySync: DirectorySyncFilterSchema,
  workstationMonitor: WorkstationServerClassMonitorSchema,
  serverMonitor:      WorkstationServerClassMonitorSchema,
  // Per-integration verbose debug logging.
  verboseLogging: z.boolean().optional().default(false),
  // Opt-in WRITE capability: lets Polaris publish the SSH onboarding scripts
  // to Intune as a Remediation (intunePublishService). Off by default because
  // it requires adding the Graph application permission
  // DeviceManagementScripts.ReadWrite.All to this app registration —
  // upgrading the credential from "reads device inventory" to "creates
  // device-management policy tenant-wide". Published policies are always left
  // UNASSIGNED; a human assigns them in Intune after reviewing the script.
  publishToIntune: z.boolean().optional().default(false),
});

// Reduced per-class block for classes that can't run the Polaris Agent and
// report no interfaces or mounts: no agent deploy, no interface/storage
// auto-monitor (those pins are agent-fed) — addAsMonitored + streams only.
// Streams still resolve per the monitor-settings hierarchy.
//
// Used by vCenter's ESXi-host class (datastore capacity renders from the
// current-state VcenterDatastore table, not the storage stream) and by Azure
// Arc's connected-Kubernetes-cluster class. Declared here, above both config
// schemas that reference it.
const VcenterHostClassMonitorSchema = z.object({
  enabled:        z.boolean().optional().default(true),
  addAsMonitored: z.boolean().optional().default(false),
  streams:        ClassStreamsSchema.optional(),
}).optional().default({ enabled: true, addAsMonitored: false });

// Azure Arc. Like Entra it has no host/port/verifySsl (the endpoint is fixed
// to management.azure.com) and therefore no .superRefine(refineConfigHost) —
// which is also why triggerDiscovery needs Arc in its hostless branch.
// Deliberately reuses workstationMonitor / serverMonitor verbatim so every
// downstream registry that keys on the BLOCK NAME (monitorOverrideService's
// raw SQL, classToBlockKey, the auto-monitor class maps) works unchanged.
const AzureArcConfigSchema = z.object({
  tenantId:     z.string().optional().default(""),
  clientId:     z.string().optional().default(""),
  clientSecret: z.string().optional().default(""),
  // Resource Graph = one query across every readable subscription. Falls back
  // to a per-subscription list automatically when ARG is unavailable.
  useResourceGraph: z.boolean().optional().default(true),
  // Explicit subscription ids; empty = every subscription the app can see.
  subscriptionInclude: z.array(z.string()).optional().default([]),
  // Wildcard filters. Resource group and tags are two INDEPENDENT axes, so
  // they get their own fields (and their own DOM ids in the modal) rather
  // than sharing the single deviceInclude/deviceExclude pair.
  resourceGroupInclude: z.array(z.string()).optional().default([]),
  resourceGroupExclude: z.array(z.string()).optional().default([]),
  deviceInclude: z.array(z.string()).optional().default([]),
  deviceExclude: z.array(z.string()).optional().default([]),
  // "key=value" / "key=*" lines matched against the Azure resource tags.
  tagInclude: z.array(z.string()).optional().default([]),
  tagExclude: z.array(z.string()).optional().default([]),
  // Opt-in WRITE capability: lets Polaris dispatch the SSH onboarding script
  // to Arc machines via Run Command (arcPublishService). Off by default —
  // discovery needs only the Reader role, while this needs one carrying
  // Microsoft.HybridCompute/machines/runCommands/write, assigned at a
  // subscription or resource-group scope. That is an Azure RBAC ROLE
  // ASSIGNMENT, not a Graph API permission like the Intune side. Unlike an
  // Intune Remediation there is no unassigned state: a run command EXECUTES
  // on creation, so the review gate is the operator's target selection.
  allowRunCommand: z.boolean().optional().default(false),
  // A Disconnected agent is a reachability statement, not a lifecycle one —
  // those machines are still assets by default.
  includeDisconnected: z.boolean().optional().default(true),
  // ONE EXTRA GET PER MACHINE — opt-in, concurrency-capped, deadline-bounded.
  fetchNetworkProfile: z.boolean().optional().default(false),
  // Phase 2/3 enrichment. Each is ONE additional Resource Graph query for the
  // whole tenant (not per machine) and NEITHER creates assets — both fold into
  // the owning machine's observed blob. Default off so an existing integration
  // keeps its current blob shape until an operator opts in.
  enableVmInstances: z.boolean().optional().default(false),
  enableSqlServer: z.boolean().optional().default(false),
  // Phase 4. Unlike the two above, connected clusters DO become assets
  // (assetType "kubernetes_cluster"), so this one changes the fleet.
  enableKubernetes: z.boolean().optional().default(false),
  // Post-sync network-presence verification — see EntraIdConfigSchema note.
  verifyPresence: z.boolean().optional().default(true),
  workstationMonitor: WorkstationServerClassMonitorSchema,
  serverMonitor:      WorkstationServerClassMonitorSchema,
  // Reduced block for connected Kubernetes clusters: a cluster runs no Polaris
  // Agent and reports no interfaces or mounts, so it takes the same shape as
  // vCenter's ESXi-host block — addAsMonitored + streams only.
  k8sMonitor:         VcenterHostClassMonitorSchema,
  // Per-integration verbose debug logging.
  verboseLogging: z.boolean().optional().default(false),
});

const ActiveDirectoryConfigSchema = z.object({
  host:            z.string().optional().default(""),
  port:            z.number().int().min(1).max(65535).optional().default(636),
  useLdaps:        z.boolean().optional().default(true),
  // Default verify-ON for NEW integrations (2026-06-03 review, M1). Existing
  // rows keep their stored value; read path is `!!config.verifyTls`.
  verifyTls:       z.boolean().optional().default(true),
  bindDn:          z.string().optional().default(""),
  bindPassword:    z.string().optional().default(""),
  baseDn:          z.string().optional().default(""),
  searchScope:     z.enum(["sub", "one"]).optional().default("sub"),
  ouInclude:       z.array(z.string()).optional().default([]),
  ouExclude:       z.array(z.string()).optional().default([]),
  includeDisabled: z.boolean().optional().default(true),
  // Post-sync network-presence verification — see EntraIdConfigSchema note.
  verifyPresence:  z.boolean().optional().default(true),
  // Address-book GAL search (live typeahead; nothing is persisted). Default
  // OFF because it needs directory-read permissions this integration has never
  // required — without them every keystroke would 403. See
  // src/services/directorySearchService.ts.
  enableDirectorySearch: z.boolean().optional().default(false),
  // Address-book GAL SYNC (scheduled; stores the roster). Deliberately a
  // SEPARATE toggle from the search above: they need the same directory
  // grants, but they are not the same decision, because one reads and one
  // stores. Default OFF — switching it on puts employee names, addresses,
  // titles, departments and phone numbers in the database and in every
  // backup. See business rule 35 and src/services/directorySyncService.ts.
  enableDirectorySync: z.boolean().optional().default(false),
  directorySync: DirectorySyncFilterSchema,
  workstationMonitor: WorkstationServerClassMonitorSchema,
  serverMonitor:      WorkstationServerClassMonitorSchema,
  // Per-integration verbose debug logging.
  verboseLogging: z.boolean().optional().default(false),
}).superRefine(refineConfigHost);

const VcenterConfigSchema = z.object({
  host:      z.string().optional().default(""),
  port:      z.number().int().min(1).max(65535).optional().default(443),
  // Default verify-ON for NEW integrations (same posture as FortiGate/AD).
  verifyTls: z.boolean().optional().default(true),
  username:  z.string().optional().default(""),
  password:  z.string().optional().default(""),
  // Wildcard filters matched against the VM name (e.g. "prod-*"). Include
  // wins when both are set (AD OU-filter semantics).
  vmInclude: z.array(z.string()).optional().default([]),
  vmExclude: z.array(z.string()).optional().default([]),
  // Post-sync network-presence verification — see EntraIdConfigSchema note.
  verifyPresence: z.boolean().optional().default(true),
  // Per-class per-stream config: VMs get the full workstation/server-style
  // block (they're guest OSes — agent deploy + auto-monitor apply); ESXi
  // hosts get the reduced block above.
  vmMonitor:   WorkstationServerClassMonitorSchema,
  hostMonitor: VcenterHostClassMonitorSchema,
  // Per-integration verbose debug logging.
  verboseLogging: z.boolean().optional().default(false),
}).superRefine(refineConfigHost);

const CreateIntegrationSchema = z.discriminatedUnion("type", [
  z.object({
    type:         z.literal("fortimanager"),
    name:         z.string().min(1, "Name is required"),
    config:       FortiManagerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("fortigate"),
    name:         z.string().min(1, "Name is required"),
    config:       FortiGateConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("windowsserver"),
    name:         z.string().min(1, "Name is required"),
    config:       WindowsServerConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(4),
  }),
  z.object({
    type:         z.literal("entraid"),
    name:         z.string().min(1, "Name is required"),
    config:       EntraIdConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("activedirectory"),
    name:         z.string().min(1, "Name is required"),
    config:       ActiveDirectoryConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("vcenter"),
    name:         z.string().min(1, "Name is required"),
    config:       VcenterConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
  z.object({
    type:         z.literal("azurearc"),
    name:         z.string().min(1, "Name is required"),
    config:       AzureArcConfigSchema,
    enabled:      z.boolean().optional().default(true),
    autoDiscover: z.boolean().optional().default(true),
    pollInterval: z.number().int().min(1).max(24).optional().default(12),
  }),
]);

const UpdateIntegrationSchema = z.object({
  name:         z.string().min(1).optional(),
  config:       z.record(z.unknown()).optional(),
  enabled:      z.boolean().optional(),
  autoDiscover: z.boolean().optional(),
  pollInterval: z.number().int().min(1).max(24).optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/integrations
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const [integrations, total] = await Promise.all([
      prisma.integration.findMany({
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.integration.count(),
    ]);
    // Attach the rolling discovery-duration baseline so the card UI can show
    // operators what to size the poll interval against. Per-FortiGate sub-keys
    // are intentionally not surfaced here — the card is per-integration.
    const baselines = await getBaselines(integrations.map((i) => i.id));
    const safe = integrations.map((i) => {
      const bl = baselines.get(i.id) ?? null;
      return {
        ...stripSecret(i),
        discoveryBaseline: bl
          ? { avgMs: Math.round(bl.avgMs), sampleCount: bl.sampleCount }
          : null,
      };
    });
    res.json({ integrations: safe, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/integrations/discoveries — active background discoveries.
// Also runs slow-detection inline so the UI sees amber within one poll cycle
// of a run exceeding its baseline, without waiting for the 30s background job.
router.get("/discoveries", async (req, res) => {
  await checkForSlowRuns().catch(() => {});
  const now = Date.now();
  const rows = await listActiveRuns();
  const running = rows.map((row) => {
    const base = (row.startedAt ?? row.createdAt).getTime();
    const devices = (row.activeDevices as { name: string; startedAt: number }[]).map((d) => d.name);
    // FMG self-as-active-device: the old in-memory path surfaced the FMG itself
    // while its worker had inflight calls (roster + mgmt-IP resolve + CMDB
    // phases). That worker state is process-local to the discovery process, so
    // here (web process) we approximate: a running FortiManager run with no
    // per-device entries yet is in those FMG-bound phases — show the FMG.
    if (row.type === "fortimanager" && row.status === "running" && devices.length === 0) {
      devices.unshift(row.integrationName);
    }
    return {
      id: row.integrationId,
      name: row.integrationName,
      type: row.type,
      startedAt: base,
      elapsedMs: now - base,
      activeDevices: devices,
      slow: row.slowAlerted,
      slowDevices: row.slowAlertedDevices as string[],
      totalDevices: row.totalDevices,
      completedCount: row.completedCount,
      skippedOfflineCount: row.skippedOfflineCount,
      skippedErrorCount: row.skippedErrorCount,
      // Single-FortiGate scoped re-discovery marker (null = full run) —
      // drives the "Discovering <device>…" label on the integration card
      // and the asset slide-over's Re-discover busy state.
      scopeDeviceName: row.scopeDeviceName ?? null,
    };
  });
  res.json({ discoveries: running });
});

// DELETE /api/v1/integrations/:id/discover — abort an in-flight discovery.
// Admin-only: the router-level guard already requires integrations:write, but
// aborting a running discovery/query is a disruptive operation we restrict to
// admin-equivalent roles (integrations:fullwrite). networkadmin (write) cannot.
router.delete("/:id/discover", requirePermission("integrations", "fullwrite"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    // Set the cancel flag on the run row; the discovery worker polls it and
    // aborts its local AbortController (the run may be executing in a separate
    // process, so there's no in-memory controller to call here).
    const cancelled = await requestCancel(id);
    if (!cancelled) { res.status(404).json({ message: "No active discovery for this integration" }); return; }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/integrations/:id
router.get("/:id", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");
    res.json(stripSecret(integration));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations
router.post("/", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    // Defensive: reject the masked-display sentinel ("••••••••") as a
    // literal secret value at create time. The edit modal pre-fills
    // sensitive fields with this string for visual masking; if a
    // workflow ever ports those values into a create call, we'd
    // otherwise persist literal bullets as the secret and the next
    // outgoing API call would fail with a "ByteString" error. The
    // PUT /:id and POST /test handlers fall back to the stored value
    // when they see this sentinel, but a fresh create has nothing to
    // fall back to — surface a clear error so the operator pastes the
    // real token instead.
    const createCfg = input.config as Record<string, unknown>;
    // A create can only ever turn auto-deploy ON (there is no prior config).
    assertAgentDeployGrant(req, null, createCfg);
    for (const field of ["apiToken", "fortigateApiToken", "password", "clientSecret", "bindPassword"] as const) {
      if (isMaskedSecretSentinel(createCfg[field])) {
        throw new AppError(
          400,
          `${field} appears to be the masked display value (a string of •). Paste the real secret value, not the placeholder.`,
        );
      }
    }
    if (isFortinetIntegrationType(input.type)) {
      const cfg = input.config as any;
      // Validate the integration-tier SNMP credential. Required whenever the
      // tier-3 polling block routes any stream through SNMP — the polling-
      // method routes already enforce that "polling=snmp + no credential"
      // is rejected, but catch it here at integration-save time too so the
      // operator sees an error before the integration is created.
      const credId = cfg.monitorCredentialId;
      if (credId) {
        const cred = await prisma.credential.findUnique({ where: { id: credId } });
        if (!cred) throw new AppError(400, "Selected monitor credential not found");
        if (cred.type !== "snmp") throw new AppError(400, "Monitor credential override must be SNMP");
      }
      const sshCredId = cfg.sshCredentialId;
      if (sshCredId) {
        const cred = await prisma.credential.findUnique({ where: { id: sshCredId } });
        if (!cred) throw new AppError(400, "Selected SSH credential not found");
        if (cred.type !== "ssh") throw new AppError(400, "SSH credential override must be SSH");
      }
      const polling = (cfg.monitorSettings && typeof cfg.monitorSettings === "object")
        ? (cfg.monitorSettings.polling as Record<string, unknown> | undefined) ?? {}
        : {};
      const snmpStreams: string[] = [];
      if (polling.responseTime === "snmp") snmpStreams.push("Response time");
      if (polling.telemetry    === "snmp") snmpStreams.push("Telemetry");
      if (polling.interfaces   === "snmp") snmpStreams.push("Interfaces");
      if (polling.lldp         === "snmp") snmpStreams.push("LLDP");
      if (snmpStreams.length > 0 && !credId) {
        throw new AppError(400, `Select an SNMP credential to route ${snmpStreams.join(", ")} via SNMP`);
      }
      const sshStreams: string[] = [];
      if (polling.responseTime === "ssh") sshStreams.push("Response time");
      if (polling.telemetry    === "ssh") sshStreams.push("Telemetry");
      if (polling.interfaces   === "ssh") sshStreams.push("Interfaces");
      if (polling.lldp         === "ssh") sshStreams.push("LLDP");
      if (sshStreams.length > 0 && !sshCredId) {
        throw new AppError(400, `Select an SSH credential to route ${sshStreams.join(", ")} via SSH`);
      }
      // Validate the per-class FortiSwitch / FortiAP monitor credentials.
      // Direct-polling SNMP requires a credential; ICMP fallback (when
      // addAsMonitored=true and direct polling is off) doesn't.
      for (const [field, label] of [
        ["fortiswitchMonitor", "FortiSwitch monitor credential"],
        ["fortiapMonitor",     "FortiAP monitor credential"],
      ] as const) {
        const block = cfg[field];
        const cId = block?.snmpCredentialId;
        if (block?.enabled && !cId) throw new AppError(400, `${label} must be selected when direct polling is enabled`);
        if (cId) {
          const cred = await prisma.credential.findUnique({ where: { id: cId } });
          if (!cred) throw new AppError(400, `${label} not found`);
          if (cred.type !== "snmp") throw new AppError(400, `${label} must be SNMP`);
        }
        const sId = block?.sshCredentialId;
        if (sId) {
          const cred = await prisma.credential.findUnique({ where: { id: sId } });
          if (!cred) throw new AppError(400, `${label.replace("monitor credential", "SSH credential")} not found`);
          if (cred.type !== "ssh") throw new AppError(400, `${label.replace("monitor credential", "SSH credential")} must be SSH`);
        }
      }
      // Pre-compile any wildcard patterns so a bad pattern is rejected with a
      // clear message instead of failing later in the apply pass.
      validateAutoMonitorPatterns(cfg);
    }
    // Stamp verboseLoggingEnabledAt when creating with verbose logging already on.
    const createConfig: Record<string, unknown> = { ...(input.config as any) };
    if (createConfig.verboseLogging === true) {
      createConfig.verboseLoggingEnabledAt = new Date().toISOString();
    }
    const integration = await prisma.integration.create({
      data: {
        type: input.type,
        name: input.name,
        config: createConfig as any,
        enabled: input.enabled,
        autoDiscover: input.autoDiscover ?? true,
        pollInterval: input.pollInterval,
      },
    });

    // Defensive: a new integration's id has no cached resolver entries yet,
    // but bumping the cache here keeps POST symmetric with PUT/DELETE and
    // covers the freshly-created → /monitor-settings/integration/:id PUT
    // path the frontend fires right after create.
    invalidateMonitorSettingsCache({ integrationId: integration.id });

    logEvent({ action: "integration.created", resourceType: "integration", resourceId: integration.id, resourceName: input.name, actor: req.session?.username, message: `Integration "${input.name}" (${input.type}) created` });

    const response: Record<string, unknown> = stripSecret(integration);

    // Auto-register FortiManager/FortiGate IP as asset/reservation.
    // Literal comparison kept (not isFortinetIntegrationType): it's the
    // discriminant TS uses to narrow `input.config` to the Fortinet shapes.
    if ((input.type === "fortimanager" || input.type === "fortigate") && input.config.host) {
      const registration = await registerFortinetHost(input.type, input.config.host, input.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // Auto-discovery on create is intentionally disabled — operators must run a
    // successful credential test, then trigger discovery explicitly.

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/integrations/:id
router.put("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Integration not found");

    const input = UpdateIntegrationSchema.parse(req.body);
    const currentConfig = existing.config as Record<string, unknown>;

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.autoDiscover !== undefined) data.autoDiscover = input.autoDiscover;
    if (input.pollInterval !== undefined) data.pollInterval = input.pollInterval;
    if (input.config) {
      // Merge config — preserve secrets if not re-submitted OR if the form
      // echoed back the masked-display sentinel (a string of U+2022 bullets).
      // The previous falsy-only check let the bullets through as the literal
      // token, which then poisoned the stored value and broke every
      // subsequent FMG/FortiGate call with a "ByteString" error.
      const newConfig = { ...currentConfig, ...input.config };
      if (!input.config.apiToken || isMaskedSecretSentinel(input.config.apiToken)) {
        newConfig.apiToken = currentConfig.apiToken;
      }
      if (!input.config.fortigateApiToken || isMaskedSecretSentinel(input.config.fortigateApiToken)) {
        newConfig.fortigateApiToken = currentConfig.fortigateApiToken;
      }
      if (!input.config.password || isMaskedSecretSentinel(input.config.password)) {
        newConfig.password = currentConfig.password;
      }
      if (!input.config.clientSecret || isMaskedSecretSentinel(input.config.clientSecret)) {
        newConfig.clientSecret = currentConfig.clientSecret;
      }
      if (!input.config.bindPassword || isMaskedSecretSentinel(input.config.bindPassword)) {
        newConfig.bindPassword = currentConfig.bindPassword;
      }
      // SSRF guard — the update path validates config as a loose record, so the
      // per-type schema's host refinement (refineConfigHost) doesn't run here.
      // Re-check the merged host explicitly so an edit can't smuggle in a
      // blocked target. See src/utils/netGuard.ts + the 2026-06-03 review (M4).
      if (typeof newConfig.host === "string" && isBlockedOutboundHost(newConfig.host)) {
        throw new AppError(
          400,
          `Host "${newConfig.host.trim()}" is in a blocked range (loopback / link-local / ` +
          `metadata / multicast) and cannot be used as an integration target. ` +
          `Use the device's routable LAN address.`,
        );
      }
      // Validate the optional FMG/FortiGate response-time SNMP override.
      // Empty string and null both mean "clear" — normalize to null so the
      // probe path sees a consistent "not set" signal.
      if (isFortinetIntegrationType(existing.type)) {
        const credId = newConfig.monitorCredentialId;
        if (credId === "" || credId == null) {
          newConfig.monitorCredentialId = null;
        } else if (typeof credId === "string") {
          const cred = await prisma.credential.findUnique({ where: { id: credId } });
          if (!cred) throw new AppError(400, "Selected monitor credential not found");
          if (cred.type !== "snmp") throw new AppError(400, "Monitor credential override must be SNMP");
        }
        const sshCredId = newConfig.sshCredentialId;
        if (sshCredId === "" || sshCredId == null) {
          newConfig.sshCredentialId = null;
        } else if (typeof sshCredId === "string") {
          const cred = await prisma.credential.findUnique({ where: { id: sshCredId } });
          if (!cred) throw new AppError(400, "Selected SSH credential not found");
          if (cred.type !== "ssh") throw new AppError(400, "SSH credential override must be SSH");
        }
        // Match the POST validation: any tier-3 polling field set to "snmp"
        // requires a credential. Reads the polling block from monitorSettings,
        // not the legacy monitor*Source toggles.
        const polling = (newConfig.monitorSettings && typeof newConfig.monitorSettings === "object")
          ? ((newConfig.monitorSettings as Record<string, unknown>).polling as Record<string, unknown> | undefined) ?? {}
          : {};
        const snmpStreams: string[] = [];
        if (polling.responseTime === "snmp") snmpStreams.push("Response time");
        if (polling.telemetry    === "snmp") snmpStreams.push("Telemetry");
        if (polling.interfaces   === "snmp") snmpStreams.push("Interfaces");
        if (polling.lldp         === "snmp") snmpStreams.push("LLDP");
        if (snmpStreams.length > 0 && !newConfig.monitorCredentialId) {
          throw new AppError(400, `Select an SNMP credential to route ${snmpStreams.join(", ")} via SNMP`);
        }
        const sshStreams: string[] = [];
        if (polling.responseTime === "ssh") sshStreams.push("Response time");
        if (polling.telemetry    === "ssh") sshStreams.push("Telemetry");
        if (polling.interfaces   === "ssh") sshStreams.push("Interfaces");
        if (polling.lldp         === "ssh") sshStreams.push("LLDP");
        if (sshStreams.length > 0 && !newConfig.sshCredentialId) {
          throw new AppError(400, `Select an SSH credential to route ${sshStreams.join(", ")} via SSH`);
        }
        // Per-class FortiSwitch / FortiAP monitor credentials. Same rules as
        // POST: the credential must exist and match the expected type.
        for (const [field, label] of [
          ["fortiswitchMonitor", "FortiSwitch monitor credential"],
          ["fortiapMonitor",     "FortiAP monitor credential"],
        ] as const) {
          const block = (newConfig as any)[field];
          if (!block) continue;
          // Normalize empty-string credentialIds to null for consistency with the probe path.
          if (block.snmpCredentialId === "") block.snmpCredentialId = null;
          if (block.sshCredentialId  === "") block.sshCredentialId  = null;
          if (block.enabled && !block.snmpCredentialId) throw new AppError(400, `${label} must be selected when direct polling is enabled`);
          if (block.snmpCredentialId) {
            const cred = await prisma.credential.findUnique({ where: { id: block.snmpCredentialId } });
            if (!cred) throw new AppError(400, `${label} not found`);
            if (cred.type !== "snmp") throw new AppError(400, `${label} must be SNMP`);
          }
          if (block.sshCredentialId) {
            const sshLabel = label.replace("monitor credential", "SSH credential");
            const cred = await prisma.credential.findUnique({ where: { id: block.sshCredentialId } });
            if (!cred) throw new AppError(400, `${sshLabel} not found`);
            if (cred.type !== "ssh") throw new AppError(400, `${sshLabel} must be SSH`);
          }
        }
        validateAutoMonitorPatterns(newConfig);
      }
      // Manage the 30-minute verbose-logging timestamp. Stamp it the first time
      // verboseLogging is enabled (don't reset the clock on subsequent saves
      // while it's already on). Clear it when verboseLogging is disabled so the
      // window resets cleanly the next time the operator enables it.
      if (newConfig.verboseLogging === true && !newConfig.verboseLoggingEnabledAt) {
        newConfig.verboseLoggingEnabledAt = new Date().toISOString();
      } else if (newConfig.verboseLogging === false) {
        delete newConfig.verboseLoggingEnabledAt;
      }
      // Chained gate: flipping any class block's agentDeploy.enabled from off
      // to on needs assets=fullwrite. Checked on the MERGED config so a PUT
      // that omits the block (the common partial save) is compared against
      // what is actually stored, not against an absent key.
      assertAgentDeployGrant(req, currentConfig, newConfig);
      data.config = newConfig;
    }

    const updated = await prisma.integration.update({
      where: { id: req.params.id },
      data,
    });

    // Editing the Monitoring tab rewrites `config.monitorSettings` (tier-3 of
    // the resolver hierarchy). The resolver memoizes tier-3 lookups per
    // integration, so without an explicit invalidation the asset's badges and
    // the next monitor tick would keep using the previously-cached polling
    // method until process restart.
    invalidateMonitorSettingsCache({ integrationId: req.params.id });

    // Auto-Monitor flag change sweep — if any per-class addAsMonitored value
    // flipped, sweep `monitored` on affected NON-override assets immediately
    // (without waiting for the next discovery cycle). Override assets are
    // left untouched: `monitorOverride` is an explicit operator pin, so a
    // flag flip respects it (operators re-align a pinned asset per-asset via
    // the Reset-to-integration-default action). We deliberately do NOT
    // recompute monitorOverride here — re-deriving it from the current
    // (monitored, flag) divergence would re-stamp pins onto assets whose
    // `monitored` only diverged for incidental reasons (decommission clamp,
    // created-before-flag-enabled, HA standby), which is exactly the bug the
    // explicit-intent model fixes. The frontend protects the operator from
    // accidental fleet-wide disables via a confirm modal at Save Changes.
    // Cheap when nothing changed — the sweep no-ops via its WHERE clause.
    {
      const oldSnap = snapshotAddAsMonitoredByAssetType(existing.type, existing.config as Record<string, unknown>);
      const newSnap = snapshotAddAsMonitoredByAssetType(existing.type, updated.config as Record<string, unknown>);
      const flipped =
        oldSnap.firewall     !== newSnap.firewall ||
        oldSnap.switch       !== newSnap.switch ||
        oldSnap.access_point !== newSnap.access_point ||
        oldSnap.workstation  !== newSnap.workstation ||
        // Under a vcenter integration the server key reads vmMonitor, so VM
        // flag flips sweep too; hypervisor covers the hostMonitor flag.
        oldSnap.server       !== newSnap.server ||
        oldSnap.hypervisor   !== newSnap.hypervisor;
      if (flipped) {
        const swept = await sweepMonitoredForIntegration(prisma, req.params.id);
        if (swept > 0) {
          logEvent({
            action: "integration.auto_monitor_swept",
            resourceType: "integration",
            resourceId: req.params.id,
            resourceName: updated.name,
            actor: req.session?.username,
            level: "info",
            message: `Auto-monitor swept ${swept} asset(s) for "${updated.name}" after addAsMonitored change`,
            details: { swept, from: oldSnap, to: newSnap },
          });
        }
      }
    }

    logEvent({ action: "integration.updated", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, message: `Integration "${updated.name}" updated` });

    // Switching the directory sync off (or disabling the integration) removes
    // the contacts it created. Leaving them would be worse than either state:
    // an employee roster nothing can refresh and nothing will ever remove,
    // still routing alerts and still in every backup, with no owner. Business
    // rule 35 — the sync only ever deletes what it wrote, and this is the
    // other half of that promise.
    const wasSyncing = existing.enabled && (existing.config as Record<string, unknown>)?.enableDirectorySync === true;
    const stillSyncing = updated.enabled && ((updated.config as Record<string, unknown>) || {}).enableDirectorySync === true;
    if (wasSyncing && !stillSyncing) {
      await purgeDirectoryContacts(
        req.params.id as string,
        updated.enabled ? "directory sync switched off" : "integration disabled",
        req.session?.username,
      ).catch((err: any) => {
        logEvent({ action: "contact.directory_sync.purge_failed", resourceType: "integration", resourceId: req.params.id, resourceName: updated.name, actor: req.session?.username, level: "error", message: `Could not remove directory-synced contacts for "${updated.name}": ${err?.message || "Unknown error"}` });
      });
    }
    // The opted-in set is cached for 60s; a config change must not leave a
    // just-disabled directory servable from it. (bumpDirectoryCache had no
    // callers at all before this — the header claimed a config change dropped
    // the cache and nothing did it.)
    if (existing.type === "entraid" || existing.type === "activedirectory") bumpDirectoryCache();

    const finalConfig = (updated.config as Record<string, unknown>) || {};
    const response: Record<string, unknown> = stripSecret(updated);

    // Auto-register FortiManager/FortiGate IP as asset/reservation
    if ((isFortinetIntegrationType(existing.type)) && finalConfig.host && typeof finalConfig.host === "string") {
      const registration = await registerFortinetHost(existing.type, finalConfig.host, updated.name, false);
      if (registration?.conflicts?.length) {
        response.conflicts = registration.conflicts;
      }
    }

    // Discovery is NOT auto-triggered on save — the operator starts it
    // explicitly from the Discover button, or the scheduler picks it up on
    // the next polling tick. Previously Save kicked off a run, which made
    // editing noisy (a filter tweak would block the next discovery slot
    // with a full run the operator didn't ask for).

    res.json(response);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/integrations/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError(404, "Integration not found");
    // BEFORE the row goes. DirectoryContactSource deliberately has no FK on
    // integrationId (a cascade would strip the provenance and strand the
    // contacts it justified), so this is the only thing that cleans up.
    await purgeDirectoryContacts(req.params.id as string, "integration deleted", req.session?.username)
      .catch((err: any) => {
        logEvent({ action: "contact.directory_sync.purge_failed", resourceType: "integration", resourceId: req.params.id, resourceName: existing.name, actor: req.session?.username, level: "error", message: `Could not remove directory-synced contacts for "${existing.name}": ${err?.message || "Unknown error"}` });
      });
    await prisma.integration.delete({ where: { id: req.params.id } });
    invalidateMonitorSettingsCache({ integrationId: req.params.id });
    if (existing.type === "entraid" || existing.type === "activedirectory") bumpDirectoryCache();
    logEvent({ action: "integration.deleted", resourceType: "integration", resourceId: req.params.id, resourceName: existing.name, actor: req.session?.username, message: `Integration "${existing.name}" deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/test
router.post("/:id/test", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    let result: { ok: boolean; message: string; version?: string };

    logEvent({ action: "integration.test.started", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: req.session?.username, message: `Connection test started for "${integration.name}"` });

    if (integration.type === "fortimanager") {
      result = await fortimanager.testConnection(config as any, integration.id);
    } else if (integration.type === "fortigate") {
      result = await fortigate.testConnection(config as any);
    } else if (integration.type === "windowsserver") {
      result = await windowsServer.testConnection(config as any);
    } else if (integration.type === "entraid") {
      result = await entraId.testConnection(config as any);
    } else if (integration.type === "activedirectory") {
      result = await activeDirectory.testConnection(config as any);
    } else if (integration.type === "vcenter") {
      result = await vcenter.testConnection(config as any);
    } else if (integration.type === "azurearc") {
      result = await azureArc.testConnection(config as any);
    } else {
      result = { ok: false, message: `Unknown integration type: ${integration.type}` };
    }

    // Save test result
    await prisma.integration.update({
      where: { id: req.params.id },
      data: { lastTestAt: new Date(), lastTestOk: result.ok },
    });

    logEvent({ action: "integration.test.completed", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: req.session?.username, level: result.ok ? "info" : "warning", message: `Connection test ${result.ok ? "succeeded" : "failed"} for "${integration.name}": ${result.message}` });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/test/fortigate-sample — direct-transport sanity check
// Pulls the FMG device list, picks a random managed FortiGate, and runs a
// FortiGate connection test against it using the stored direct-mode creds.
// Only valid for type=fortimanager integrations with useProxy=false; the
// client only invokes it after the main /:id/test call has succeeded.
router.post("/:id/test/fortigate-sample", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) throw new AppError(404, "Integration not found");
    if (integration.type !== "fortimanager") throw new AppError(400, "FortiGate sample test is only valid for FortiManager integrations");

    const cfg = integration.config as Record<string, unknown>;
    if (cfg.useProxy !== false) throw new AppError(400, "FortiGate sample test is only valid when the FMG proxy is disabled");

    const fgResult = await fortimanager.testRandomFortiGate(cfg as any, req.params.id);
    const backupNote = fgResult.ok && (fgResult.attempts?.length ?? 0) > 1
      ? ` (initial pick "${fgResult.attempts![0]}" failed; backup pick succeeded)`
      : "";
    const message = fgResult.ok
      ? `Randomly selected FortiGate "${fgResult.deviceName}" reachable${fgResult.version ? ` (FortiOS ${fgResult.version})` : ""}${backupNote}`
      : `Randomly selected FortiGate "${fgResult.deviceName}" failed: ${fgResult.message}`;

    // If the random FortiGate can't be reached, the direct-transport path
    // won't work — discovery would fail. Flip lastTestOk so the Discover
    // button reflects the real readiness, and stamp the timestamp.
    if (!fgResult.ok) {
      await prisma.integration.update({
        where: { id: req.params.id },
        data: { lastTestAt: new Date(), lastTestOk: false },
      }).catch(() => {});
    }

    logEvent({ action: "integration.test.fortigate-sample", resourceType: "integration", resourceId: req.params.id, resourceName: integration.name, actor: req.session?.username, level: fgResult.ok ? "info" : "warning", message: `FortiGate sample test ${fgResult.ok ? "succeeded" : "failed"} for "${integration.name}" on ${fgResult.deviceName} (attempts: ${(fgResult.attempts ?? [fgResult.deviceName]).join(", ")}): ${fgResult.message}` });

    res.json({ ok: fgResult.ok, message, deviceName: fgResult.deviceName });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/test/fortigate-sample — pre-save variant of the above.
// Used by the edit modal so the random-FortiGate check runs against the
// unsaved form config. If an existingId is supplied, blank secrets are
// merged from the stored config (same rule as /test).
router.post("/test/fortigate-sample", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    if (input.type !== "fortimanager") throw new AppError(400, "FortiGate sample test is only valid for FortiManager integrations");
    const cfg = input.config as Record<string, unknown>;
    if (cfg.useProxy !== false) throw new AppError(400, "FortiGate sample test is only valid when the FMG proxy is disabled");

    const existingId = typeof req.body?.id === "string" ? req.body.id : null;
    if (existingId) {
      const existing = await prisma.integration.findUnique({ where: { id: existingId } });
      if (existing) {
        const stored = existing.config as Record<string, unknown>;
        // Same masked-sentinel guard as the PUT /:id and POST /test handlers
        // — the edit modal echoes "••••••••" back as the form value when
        // the operator doesn't retype the token, and the prior falsy/typeof
        // check let the bullets through as the literal token.
        const needsRestore = (v: unknown): boolean =>
          !v || typeof v !== "string" || isMaskedSecretSentinel(v);
        if (needsRestore(cfg.apiToken)) cfg.apiToken = stored.apiToken;
        if (needsRestore(cfg.fortigateApiToken)) cfg.fortigateApiToken = stored.fortigateApiToken;
      }
    }

    const fgResult = await fortimanager.testRandomFortiGate(cfg as any, existingId ?? undefined);
    const backupNote = fgResult.ok && (fgResult.attempts?.length ?? 0) > 1
      ? ` (initial pick "${fgResult.attempts![0]}" failed; backup pick succeeded)`
      : "";
    const message = fgResult.ok
      ? `Randomly selected FortiGate "${fgResult.deviceName}" reachable${fgResult.version ? ` (FortiOS ${fgResult.version})` : ""}${backupNote}`
      : `Randomly selected FortiGate "${fgResult.deviceName}" failed: ${fgResult.message}`;

    if (existingId && !fgResult.ok) {
      await prisma.integration.update({
        where: { id: existingId },
        data: { lastTestAt: new Date(), lastTestOk: false },
      }).catch(() => {});
    }

    res.json({ ok: fgResult.ok, message, deviceName: fgResult.deviceName });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/query — proxy a manual API call to a FortiManager or FortiGate
router.post("/:id/query", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) throw new AppError(404, "Integration not found");

    if (integration.type === "fortimanager") {
      // Two transports under one endpoint:
      //  - mode "fmg" (default): JSON-RPC to FortiManager
      //  - mode "fortigate": REST direct to a managed FortiGate, using the
      //    integration's stored direct-mode credentials. FMG is still consulted
      //    to resolve the gate's real management-interface IP.
      const mode = (req.body && typeof req.body === "object" && (req.body as any).mode) || "fmg";

      if (mode === "fortigate") {
        const { deviceName, method, path, query, body, apiToken, apiUser } = z.object({
          mode: z.literal("fortigate"),
          deviceName: z.string().min(1),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
          path: z.string().min(1),
          query: z.record(z.string()).optional(),
          // JSON request body for POST/PUT (e.g. CMDB writes when testing the
          // description-sync surfaces). Ignored for GET/DELETE — fetch rejects
          // GET bodies outright.
          body: z.unknown().optional(),
          // Per-request credential override (see overrideFortigateCreds).
          apiToken: OverrideApiTokenSchema,
          apiUser: OverrideApiUserSchema,
        }).parse(req.body);
        const effectiveBody = method === "POST" || method === "PUT" ? body : undefined;
        // A non-GET through the ad-hoc tool can mutate device config — audit it.
        // `usedTokenOverride` records THAT an override was supplied, never its
        // value: Event details are readable by anyone with events access and are
        // shipped off-host by the syslog/SFTP archivers.
        if (method !== "GET") {
          logEvent({ action: "integration.query.write", resourceType: "integration", resourceId: integration.id, resourceName: integration.name, actor: req.session?.username, level: "warning", message: `Ad-hoc ${method} ${path} sent directly to FortiGate "${deviceName}"${apiToken ? " (with a per-request API token override)" : ""}`, details: { deviceName, method, path, usedTokenOverride: Boolean(apiToken), ...(effectiveBody !== undefined ? { body: effectiveBody } : {}) } });
        }
        const result = await fortimanager.proxyQueryViaFortigate(
          overrideFortigateCreds(integration.config, apiToken, apiUser, "fortimanager") as any,
          deviceName,
          method,
          path,
          query,
          integration.id,
          effectiveBody,
        );
        sendProxyJson(res, result);
        return;
      }

      const { method, params } = z.object({
        mode: z.literal("fmg").optional(),
        method: z.string().min(1),
        params: z.array(z.unknown()),
      }).parse(req.body);
      const result = await fortimanager.proxyQuery(integration.config as any, method, params, integration.id);
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "fortigate") {
      const { method, path, query, body, apiToken, apiUser } = z.object({
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
        path: z.string().min(1),
        query: z.record(z.string()).optional(),
        // JSON request body for POST/PUT — same semantics as the FMG
        // direct-to-FortiGate mode above.
        body: z.unknown().optional(),
        // Per-request credential override (see overrideFortigateCreds).
        apiToken: OverrideApiTokenSchema,
        apiUser: OverrideApiUserSchema,
      }).parse(req.body);
      const effectiveBody = method === "POST" || method === "PUT" ? body : undefined;
      if (method !== "GET") {
        logEvent({ action: "integration.query.write", resourceType: "integration", resourceId: integration.id, resourceName: integration.name, actor: req.session?.username, level: "warning", message: `Ad-hoc ${method} ${path} sent to FortiGate${apiToken ? " (with a per-request API token override)" : ""}`, details: { method, path, usedTokenOverride: Boolean(apiToken), ...(effectiveBody !== undefined ? { body: effectiveBody } : {}) } });
      }
      const result = await fortigate.proxyQuery(
        overrideFortigateCreds(integration.config, apiToken, apiUser, "fortigate") as any,
        method, path, query, effectiveBody,
      );
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "entraid") {
      const { path, query } = z.object({
        path: z.string().min(1),
        query: z.record(z.string()).optional(),
      }).parse(req.body);
      const result = await entraId.proxyQuery(integration.config as any, path, query);
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "activedirectory") {
      const body = z.object({
        filter:     z.string().optional(),
        baseDn:     z.string().optional(),
        scope:      z.enum(["sub", "one", "base"]).optional(),
        attributes: z.array(z.string()).optional(),
        sizeLimit:  z.number().int().min(1).max(500).optional(),
      }).parse(req.body);
      const result = await activeDirectory.proxyQuery(integration.config as any, body);
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "vcenter") {
      // vSphere Automation REST surface only — proxyQuery rejects paths
      // outside "/api/" (the SOAP /sdk endpoint is not exposed to the modal).
      const { method, path, query } = z.object({
        method: z.enum(["GET", "POST"]).optional().default("GET"),
        path:   z.string().min(1),
        query:  z.record(z.string()).optional(),
      }).parse(req.body);
      const result = await vcenter.proxyQuery(integration.config as any, method, path, query);
      sendProxyJson(res, result);
      return;
    }

    if (integration.type === "azurearc") {
      // Azure Resource Manager surface only. proxyQuery pins the host to
      // management.azure.com, requires an api-version, and allows POST ONLY
      // to the Resource Graph query endpoint — otherwise the console would
      // be a general-purpose ARM write tool.
      const { method, path, query, body } = z.object({
        method: z.enum(["GET", "POST"]).optional().default("GET"),
        path:   z.string().min(1),
        query:  z.record(z.string()).optional(),
        body:   z.unknown().optional(),
      }).parse(req.body);
      const result = await azureArc.proxyQuery(integration.config as any, method, path, query, body);
      sendProxyJson(res, result);
      return;
    }

    throw new AppError(400, "API query is not supported for this integration type");
  } catch (err) {
    next(err);
  }
});

// ─── Auto-Monitor Interfaces ─────────────────────────────────────────────────
// Three endpoints power the "Auto-Monitor Interfaces" card on the integration
// modal's Monitoring tab subtabs:
//   - GET  ../interface-aggregate?class=...     → "By name" checklist source
//   - POST ../interface-aggregate/preview       → live preview while editing
//   - POST ../interface-aggregate/apply         → "Save and apply now" trigger
//
// The selection itself is persisted on Integration.config under
// fortigateMonitor / fortiswitchMonitor / fortiapMonitor as
// `autoMonitorInterfaces` and validated by the existing PUT handler.

// fortigate/fortiswitch/fortiap = FMG/FortiGate classes; workstation/server =
// AD/Entra classes; virtual_machine = the vCenter VM class (a klass name only —
// the assets are typed "server"; interface auto-monitor is class-agnostic in
// the service; ESXi hosts carry no auto-monitor).
const ClassQuerySchema = z.enum(["fortigate", "fortiswitch", "fortiap", "workstation", "server", "virtual_machine"]);

// Map an auto-monitor class to the Integration.config block that holds its
// `autoMonitorInterfaces` / `autoMonitorStorage` selection.
function classToBlockKey(klass: z.infer<typeof ClassQuerySchema>): string {
  switch (klass) {
    case "fortigate":   return "fortigateMonitor";
    case "fortiswitch": return "fortiswitchMonitor";
    case "fortiap":     return "fortiapMonitor";
    case "workstation": return "workstationMonitor";
    case "server":      return "serverMonitor";
    case "virtual_machine": return "vmMonitor";
  }
}

// Mirrors AutoMonitorInterfacesSchema from the top of the file but for the
// in-flight live preview that fires on every keystroke before Save. Same
// multi-block shape, same legacy-shape coercion, so an older UI build that
// posts the single-mode form still gets a useful preview.
//
// `baselineSelection` is optional. When provided, the service computes per-
// asset pin sets for BOTH selections from a single DB fetch and returns a
// `diff` block alongside the regular preview shape. Drives the "+X / −Y"
// delta hint that lets operators see what a checkbox toggle just changed.
// Older UI builds that don't send baselineSelection get the same preview
// shape as before — no diff.
const PreviewBodySchema = z.object({
  class:             ClassQuerySchema,
  selection:         AutoMonitorInterfacesSchema,
  baselineSelection: AutoMonitorInterfacesSchema.optional(),
});

router.get("/:id/interface-aggregate", async (req, res, next) => {
  try {
    const klass = ClassQuerySchema.parse(req.query.class);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    // Serve the precomputed cache (refreshed at the end of each discovery run).
    // Fall back to a live compute only when the cache has no entry for this class
    // yet — the window before the integration's first post-feature discovery.
    const cached = await autoMonitor.getCachedInterfaceAggregate(req.params.id, klass);
    if (cached) {
      res.json({ rows: cached.rows, computedAt: cached.computedAt });
      return;
    }
    const rows = await autoMonitor.getInterfaceAggregate(req.params.id, klass);
    res.json({ rows: rows.map((r) => ({ ifName: r.ifName, ifType: r.ifType, deviceCount: r.deviceCount })), computedAt: null });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/interface-aggregate/preview", async (req, res, next) => {
  try {
    const body = PreviewBodySchema.parse(req.body);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    // Cross-check patterns syntactically here too — the resolver would throw
    // on the first call inside previewAutoMonitorForClass, but doing it up
    // front means a clearer 400 in the editor.
    const byPatterns = body.selection?.byPatterns;
    if (byPatterns) {
      for (const pat of byPatterns.patterns) autoMonitor.compilePattern(pat, byPatterns.regex === true);
    }
    // Same syntactic validation for the baseline so a stale regex in the
    // last-sent selection doesn't 500 the diff request.
    const baselineByPatterns = body.baselineSelection?.byPatterns;
    if (baselineByPatterns) {
      for (const pat of baselineByPatterns.patterns) autoMonitor.compilePattern(pat, baselineByPatterns.regex === true);
    }
    // `baselineSelection` undefined → service returns no diff (back-compat).
    // `baselineSelection === null` (key present, value null) → service treats
    // it as "no pins at all" so the diff shows the full current set as adds.
    const baseline = "baselineSelection" in body ? (body.baselineSelection ?? null) : undefined;
    const result = await autoMonitor.previewAutoMonitorForClass(
      req.params.id,
      body.class,
      body.selection ?? null,
      baseline,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/interface-aggregate/apply", async (req, res, next) => {
  try {
    const klass = ClassQuerySchema.parse(req.body?.class);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    const cfg = (integ.config ?? {}) as Record<string, any>;
    const blockKey = classToBlockKey(klass);
    // Coerce legacy `{mode, ...}` rows on the fly so apply works even before
    // the one-shot migration job has rewritten this integration's config.
    const selection = autoMonitor.coerceLegacySelection(cfg[blockKey]?.autoMonitorInterfaces ?? null);
    const actor = (req as any).session?.username;
    // Run the apply in the BACKGROUND and return 202 immediately. On a large
    // fleet applyAutoMonitorForClass resolves the selection against every asset's
    // latest interface samples (a multi-second-to-minutes query at 2000 assets),
    // and awaiting it here wedged the modal's "Applying…" state for minutes. The
    // apply is strictly additive + idempotent AND re-runs on every discovery
    // (Phase 2c), so a fire-and-forget that loses to a process restart self-heals.
    void (async () => {
      try {
        const result = await autoMonitor.applyAutoMonitorForClass(req.params.id, klass, selection, actor);
        if (result.interfacesAdded > 0) {
          logEvent({
            action:       "integration.auto_monitor_interfaces.applied",
            resourceType: "integration",
            resourceId:   integ.id,
            resourceName: integ.name,
            actor,
            message:      `Auto-monitor interfaces applied for "${integ.name}" (${klass}) — ${result.devices} device(s), ${result.interfacesAdded} interface(s) added`,
            details:      { class: klass, devices: result.devices, interfacesAdded: result.interfacesAdded },
          });
        }
      } catch (e: any) {
        logEvent({
          action:       "integration.auto_monitor_interfaces.error",
          resourceType: "integration",
          resourceId:   integ.id,
          resourceName: integ.name,
          actor,
          level:        "warning",
          message:      `Auto-monitor interfaces apply failed for "${integ.name}" (${klass}): ${e?.message || "unknown error"}`,
          details:      { class: klass },
        });
      }
    })();
    res.status(202).json({ queued: true });
  } catch (err) {
    next(err);
  }
});

// ─── Auto-Monitor Storage (AD / Entra workstation+server classes) ────────────
// Storage-mount analog of the interface routes above. AD/Entra only — storage
// auto-monitor is not offered on the Fortinet classes, so the class param is
// the narrower workstation|server enum. Selection persists on
// Integration.config under workstationMonitor / serverMonitor as
// `autoMonitorStorage` and is validated by the PUT handler.
//   - GET  ../storage-aggregate?class=...   → "By name" checklist source
//   - POST ../storage-aggregate/preview     → live preview while editing
//   - POST ../storage-aggregate/apply       → "Save and apply now" trigger

const StorageClassQuerySchema = z.enum(["workstation", "server", "virtual_machine"]);

const StoragePreviewBodySchema = z.object({
  class:     StorageClassQuerySchema,
  selection: AutoMonitorStorageSchema,
});

router.get("/:id/storage-aggregate", async (req, res, next) => {
  try {
    const klass = StorageClassQuerySchema.parse(req.query.class);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    // Serve the precomputed cache; live-compute fallback only before the first
    // post-feature discovery run has populated it for this class.
    const cached = await autoMonitorStorage.getCachedStorageAggregate(req.params.id, klass);
    if (cached) {
      res.json({ rows: cached.rows, computedAt: cached.computedAt });
      return;
    }
    const rows = await autoMonitorStorage.getStorageAggregate(req.params.id, klass);
    res.json({ rows: rows.map((r) => ({ mountPath: r.mountPath, deviceCount: r.deviceCount })), computedAt: null });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/storage-aggregate/preview", async (req, res, next) => {
  try {
    const body = StoragePreviewBodySchema.parse(req.body);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    // Cross-check patterns syntactically up front for a clear 400 in the editor.
    const byPatterns = body.selection?.byPatterns;
    if (byPatterns) {
      for (const pat of byPatterns.patterns) autoMonitor.compilePattern(pat, byPatterns.regex === true);
    }
    const result = await autoMonitorStorage.previewAutoMonitorStorageForClass(
      req.params.id,
      body.class,
      body.selection ?? null,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/storage-aggregate/apply", async (req, res, next) => {
  try {
    const klass = StorageClassQuerySchema.parse(req.body?.class);
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");
    const cfg = (integ.config ?? {}) as Record<string, any>;
    const blockKey = klass === "workstation" ? "workstationMonitor" : "serverMonitor";
    const selection = (cfg[blockKey]?.autoMonitorStorage ?? null) as autoMonitorStorage.AutoMonitorStorageSelection;
    const actor = (req as any).session?.username;
    // Background apply + 202, same rationale as interface-aggregate/apply:
    // additive + idempotent + re-runs on every discovery, so don't block the
    // request on the fleet-wide resolve.
    void (async () => {
      try {
        const result = await autoMonitorStorage.applyAutoMonitorStorageForClass(req.params.id, klass, selection, actor);
        if (result.mountsAdded > 0) {
          logEvent({
            action:       "integration.auto_monitor_storage.applied",
            resourceType: "integration",
            resourceId:   integ.id,
            resourceName: integ.name,
            actor,
            message:      `Auto-monitor storage applied for "${integ.name}" (${klass}) — ${result.devices} device(s), ${result.mountsAdded} mount(s) added`,
            details:      { class: klass, devices: result.devices, mountsAdded: result.mountsAdded },
          });
        }
      } catch (e: any) {
        logEvent({
          action:       "integration.auto_monitor_storage.error",
          resourceType: "integration",
          resourceId:   integ.id,
          resourceName: integ.name,
          actor,
          level:        "warning",
          message:      `Auto-monitor storage apply failed for "${integ.name}" (${klass}): ${e?.message || "unknown error"}`,
          details:      { class: klass },
        });
      }
    })();
    res.status(202).json({ queued: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/auto-monitor-assets/preflight
//
// Returns per-class projected impact for an in-flight integration edit so
// the frontend can render a confirmation modal at Save Changes time. The
// operator's proposed addAsMonitored values are compared against current
// asset state (filtered to assets discovered by this integration); the
// response carries enough to render "N assets would have monitoring
// enabled / M would have it disabled (P are overridden and won't be
// touched)".
//
// The body's `proposed` map keys are the five auto-monitor asset types
// (firewall / switch / access_point / workstation / server). Any missing
// key is treated as "no proposed change" for that class (omitted from
// the response).
router.post("/:id/auto-monitor-assets/preflight", async (req, res, next) => {
  try {
    const ProposedSchema = z.object({
      proposed: z.object({
        firewall:     z.boolean().optional(),
        switch:       z.boolean().optional(),
        access_point: z.boolean().optional(),
        workstation:  z.boolean().optional(),
        server:       z.boolean().optional(),
      }).default({}),
    });
    const { proposed } = ProposedSchema.parse(req.body ?? {});
    const integ = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integ) throw new AppError(404, "Integration not found");

    // Per-class current addAsMonitored derived from the stored config (NOT
    // the proposed value — proposed comes from the request body).
    const current = snapshotAddAsMonitoredByAssetType(integ.type, integ.config as Record<string, unknown>);

    type ClassKey = "firewall" | "switch" | "access_point" | "workstation" | "server";
    const out: Record<ClassKey, {
      currentAddAsMonitored: boolean | null;
      proposedAddAsMonitored: boolean;
      total: number;
      overridden: number;
      wouldEnable: number;
      wouldDisable: number;
    }> = {} as any;

    const classKeys: ClassKey[] = ["firewall", "switch", "access_point", "workstation", "server"];
    for (const k of classKeys) {
      const proposedVal = proposed[k];
      if (proposedVal === undefined) continue;
      // Three groupBy queries combined into one scoped findMany — fleet-
      // bounded by integrationId + assetType so we read at most one
      // class-worth of rows.
      const rows = await prisma.asset.findMany({
        where: {
          discoveredByIntegrationId: req.params.id,
          assetType: k,
        },
        // fortinetTopology: HA-standby detection for the firewall class only
        // (tiny per-firewall blob; the other classes ignore it).
        select: { monitored: true, monitorOverride: true, fortinetTopology: k === "firewall" },
      });
      let overridden = 0;
      let wouldEnable = 0;
      let wouldDisable = 0;
      let standbyExempt = 0;
      for (const r of rows) {
        // HA standby firewalls are exempt from the class flag (their
        // effective default is always "not monitored" — see
        // sweepMonitoredForIntegration), so the sweep would never touch
        // them; counting one as would-enable would overstate the impact.
        if (k === "firewall" && ((r as { fortinetTopology?: unknown }).fortinetTopology as Record<string, unknown> | null)?.haRole === "secondary") { standbyExempt++; continue; }
        if (r.monitorOverride) { overridden++; continue; }
        if (proposedVal && !r.monitored) wouldEnable++;
        else if (!proposedVal && r.monitored) wouldDisable++;
      }
      out[k] = {
        currentAddAsMonitored: current[k],
        proposedAddAsMonitored: proposedVal,
        total: rows.length - standbyExempt,
        overridden,
        wouldEnable,
        wouldDisable,
      };
    }

    res.json({ integrationId: req.params.id, integrationName: integ.name, classes: out });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/register — overwrite selected fields on conflicting reservation
router.post("/:id/register", async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { id: req.params.id },
    });
    if (!integration) throw new AppError(404, "Integration not found");

    const config = integration.config as Record<string, unknown>;
    if (!config.host || typeof config.host !== "string") {
      throw new AppError(400, "Integration has no host configured");
    }

    // fields: which proposed fields to apply to the existing reservation
    const fields: string[] = Array.isArray(req.body?.fields) ? req.body.fields : [];
    const result = await registerFortinetHost(integration.type, config.host as string, integration.name, true, fields);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/:id/discover — manually trigger DHCP discovery
router.post("/:id/discover", async (req, res, next) => {
  try {
    await triggerDiscovery(req.params.id, req.session?.username ?? "");
    res.status(202).json({ message: "Discovery started" });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/integrations/test — test without saving (for the create form)
router.post("/test", async (req, res, next) => {
  try {
    const input = CreateIntegrationSchema.parse(req.body);
    let result: { ok: boolean; message: string; version?: string };

    // If an existing integration id is provided, merge unmasked secrets
    // from the stored config when the form fields were left blank.
    const existingId = typeof req.body?.id === "string" ? req.body.id : null;
    if (existingId) {
      const existing = await prisma.integration.findUnique({ where: { id: existingId } });
      if (existing) {
        const stored = existing.config as Record<string, unknown>;
        const cfg = input.config as Record<string, unknown>;
        const needsRestore = (v: unknown): boolean =>
          !v || typeof v !== "string" || isMaskedSecretSentinel(v);
        if ((isFortinetIntegrationType(input.type)) && needsRestore(cfg.apiToken)) {
          cfg.apiToken = stored.apiToken;
        }
        if (input.type === "fortimanager" && needsRestore(cfg.fortigateApiToken)) {
          cfg.fortigateApiToken = stored.fortigateApiToken;
        }
        if (input.type === "windowsserver" && needsRestore(cfg.password)) {
          cfg.password = stored.password;
        }
        if (input.type === "entraid" && needsRestore(cfg.clientSecret)) {
          cfg.clientSecret = stored.clientSecret;
        }
        if (input.type === "activedirectory" && needsRestore(cfg.bindPassword)) {
          cfg.bindPassword = stored.bindPassword;
        }
        if (input.type === "vcenter" && needsRestore(cfg.password)) {
          cfg.password = stored.password;
        }
        if (input.type === "azurearc" && needsRestore(cfg.clientSecret)) {
          cfg.clientSecret = stored.clientSecret;
        }
      }
    }

    if (input.type === "fortimanager") {
      result = await fortimanager.testConnection(input.config);
    } else if (input.type === "fortigate") {
      result = await fortigate.testConnection(input.config);
    } else if (input.type === "windowsserver") {
      result = await windowsServer.testConnection(input.config);
    } else if (input.type === "entraid") {
      result = await entraId.testConnection(input.config);
    } else if (input.type === "activedirectory") {
      result = await activeDirectory.testConnection(input.config);
    } else if (input.type === "vcenter") {
      result = await vcenter.testConnection(input.config);
    } else if (input.type === "azurearc") {
      result = await azureArc.testConnection(input.config);
    } else {
      result = { ok: false, message: `Unknown integration type: ${(input as any).type}` };
    }

    // If this test was tied to an existing integration and passed, stamp the
    // card's last-tested fields so the UI and the discovery gate see the
    // success. We only persist on success — a failing draft-form test should
    // not tear down a previously-working integration's "ok" status.
    if (existingId && result.ok) {
      await prisma.integration.update({
        where: { id: existingId },
        data: { lastTestAt: new Date(), lastTestOk: true },
      }).catch(() => {});
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ConflictEntry {
  type: "reservation";
  existing: Record<string, unknown>;
  proposed: Record<string, unknown>;
}

/**
 * Register a FortiManager or FortiGate host IP as a subnet reservation and asset.
 * If force=false, returns conflicts instead of overwriting.
 * If force=true, overwrites selected fields on the existing reservation.
 */
async function registerFortinetHost(integrationType: string, host: string, integrationName: string, force: boolean, fields: string[] = []) {
  if (!isValidIpAddress(host)) return { conflicts: [], created: [] };

  const subnets = await prisma.subnet.findMany();
  const matchingSubnet = subnets.find((s) => ipInCidr(host, s.cidr));

  if (!matchingSubnet && !isPrivateIpv4(host)) return { conflicts: [], created: [] };

  const conflicts: ConflictEntry[] = [];
  const created: string[] = [];
  const hostname = integrationName.toLowerCase().replace(/\s+/g, "-");
  const isFortiGate = integrationType === "fortigate";
  const productLabel = isFortiGate ? "FortiGate" : "FortiManager";
  const assetType: "firewall" | "server" = isFortiGate ? "firewall" : "server";

  // ── Reservation ──
  const proposedReservation = {
    ipAddress: host,
    hostname,
    owner: "network-team",
    projectRef: `${productLabel} Integration`,
    notes: `Auto-registered from ${productLabel} integration: ${integrationName}`,
    status: "active" as const,
    sourceType: (isFortiGate ? "fortigate" : "fortimanager") as "fortigate" | "fortimanager",
  };

  if (matchingSubnet) {
    // Exclude dns_resolved rows — they're fallback markers that defer to any
    // authoritative source. The pre-create releaseDnsResolvedAt below flips
    // the marker so the unique-on-active constraint stays satisfied.
    const existingRes = await prisma.reservation.findFirst({
      where: {
        subnetId: matchingSubnet.id,
        ipAddress: host,
        status: "active",
        NOT: { sourceType: "dns_resolved" as any },
      },
    });

    if (existingRes) {
      if (force) {
        // Only overwrite the fields the admin selected
        const updateData: Record<string, unknown> = {};
        const allowedFields = ["hostname", "owner", "projectRef", "notes", "status"];
        for (const f of fields) {
          if (allowedFields.includes(f) && f in proposedReservation) {
            updateData[f] = (proposedReservation as Record<string, unknown>)[f];
          }
        }
        if (Object.keys(updateData).length > 0) {
          await prisma.reservation.update({
            where: { id: existingRes.id },
            data: updateData,
          });
        }
        created.push("reservation");
      } else {
        conflicts.push({
          type: "reservation",
          existing: {
            id: existingRes.id,
            ipAddress: existingRes.ipAddress,
            hostname: existingRes.hostname,
            owner: existingRes.owner,
            projectRef: existingRes.projectRef,
            notes: existingRes.notes,
            status: existingRes.status,
            subnetCidr: matchingSubnet.cidr,
          },
          proposed: { ...proposedReservation, subnetCidr: matchingSubnet.cidr },
        });
      }
    } else {
      await releaseDnsResolvedAt(matchingSubnet.id, host);
      await prisma.reservation.create({
        data: { subnetId: matchingSubnet.id, ...proposedReservation },
      });
      created.push("reservation");
    }
  }

  // ── Asset ──
  // Standalone FortiGate: skip the placeholder. The discovery's Phase 3 owns
  // FortiGate firewall asset creation as the single source of truth — it has
  // the real serial, model, OS version, geo coordinates, and resolved mgmt
  // IP (which can differ from the user-typed `host` when the FortiGate's
  // mgmt-interface lookup returns a different address). A placeholder here
  // creates a duplicate-asset risk: if the placeholder's hostname (= the
  // integration name) and IP (= `host`) don't both match what discovery
  // resolves, `findByEntry` misses and discovery creates a second asset
  // while the placeholder sits stale with no serial/coords.
  //
  // FortiManager: keep the placeholder. The FMG server itself is a separate
  // asset (assetType="server") from any FortiGate it manages (assetType=
  // "firewall"), so there's no collision with discovery's per-FortiGate
  // asset writes.
  if (!isFortiGate) {
    const existingAsset = await prisma.asset.findFirst({ where: { ipAddress: host, assetType } });
    if (!existingAsset) {
      const proposedAsset = {
        ipAddress: host,
        hostname,
        assetType,
        status: "active" as const,
        manufacturer: "Fortinet",
        model: productLabel,
        department: "Network Security",
        notes: `Auto-registered from ${productLabel} integration: ${integrationName}`,
        tags: [integrationType, "auto-registered"],
      };
      await prisma.asset.create({ data: proposedAsset });
      created.push("asset");
    }
  }

  return { conflicts, created };
}

function stripSecret(integration: Record<string, any>) {
  const config = { ...(integration.config as Record<string, unknown>) };
  for (const field of ["apiToken", "fortigateApiToken", "password", "clientSecret", "bindPassword"]) {
    if (config[field]) config[field] = SECRET_MASK;
  }
  return { ...integration, config };
}

export default router;
