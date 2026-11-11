/**
 * src/services/assetWriteService.ts — Creating and updating an asset: the create / update body schemas, the
 * create path (normalise, stamp, create, rule 112 record, asset.created, the
 * write-time duplicate-ip check), the PUT pipeline (load, validate, build the
 * patch, write, side effects, credential record, rule 40(i) re-check of a moved
 * address), and resetting a monitor-override pin to the integration default.
 * Moved out of routes/assets/write.ts (CQ-B062 slice 2). The route keeps the
 * checks that need the request: the Tags permission (assertTagChangeAllowed)
 * and the integration-token retarget (rule 111(c)), run in the original order.
 *
 * The schemas live here because the pipeline's functions are typed by them.
 * The contract tests are tests/integration/assetPutContract.test.ts.
 */

import { z } from "zod";
import { prisma } from "../db.js";
import { chunkArray } from "../utils/chunk.js";
import { AppError } from "../utils/errors.js";
import { recordCredentialUse, assetCredentialUses, type AssetCredentialSlots, type CredentialUseVia, type CredentialUseActor } from "./credentialUseAuditService.js";
import { reconcileDuplicateIpForAddresses, type WriteTimeIpConflict } from "./duplicateIpConflictService.js";
import { logEvent, buildChanges, buildFirmwareChangedEvent } from "./eventLogService.js";
import { clampAcquiredToLastSeen, statusAllowsMonitoring, UNMONITORABLE_STATUSES, clampMonitoredState } from "../utils/assetInvariants.js";
import { syncDescriptionsOnSave } from "./descriptionSyncService.js";
import { isKnownAssetType } from "../utils/assetTypes.js";
import { recomputeMonitorOverrideForAssets, getAddAsMonitoredFromConfig } from "./monitorOverrideService.js";
import { reconcileTagsForAsset } from "./tagAssignmentService.js";
import { manualCoordPatchError } from "../utils/geo.js";
import { reconcileMapRegions, assertAddedRegionTagsNameARegion } from "./mapRegionService.js";
import { withArcOwnedTags } from "../utils/tagNormalize.js";
import { projectAssetFromSources } from "../utils/assetProjection.js";
import { resolvePendingIpOverrideConflicts } from "./ipOverrideService.js";
import { archiveAgentHostPins, reinstateAgentHostPins, resolvePendingCheckinConflicts } from "./agentHostPinService.js";
import { isAllZeroMac } from "../utils/mac.js";
import { operatorReleaseAsset } from "./maintenanceScheduleService.js";
import { releaseInfraReservationsForAssets } from "./reservationService.js";
import { recordOperatorPinChanges, type OperatorPinChange } from "./appMapDiscoveryService.js";
import { type PollingMethod, type Stream, assetSourceKindFromIntegrationType, isMethodValidForStream, isPollingMethodCompatible, isWorkloadPollingMethod, pollingMethodLabel } from "../utils/pollingCompatibility.js";
import { workloadPlatformLabel, workloadSourceKindsFor } from "../utils/workloadSources.js";
import { collectorCapability } from "../utils/pollingCapability.js";
import { logger } from "../utils/logger.js";
import { CLEAR_PRIMARY_ADDRESS_PIN, gateForPinnedAddress } from "./primaryAddressService.js";
import { assertQuarantineStatusUntouched } from "./assetQuarantineService.js";
import { assertCredentialAssignments } from "./credentialService.js";
import { isAzureTag } from "../utils/tagNormalize.js";
import { syncAzureTagRegistry } from "./tagAssignmentService.js";
import { afterAssetsDeleted } from "./assetRemovalService.js";
import { releaseDnsResolvedForAsset } from "./dnsResolvedReservationService.js";

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

// Asset type is now a free-form string validated against the AssetTypeDef
// registry (eight built-ins + any operator-added custom types). The synchronous
// `isKnownAssetType` reads the in-memory cache populated at boot by
// assetTypeService.refreshCache(); until the cache loads it falls back to
// accepting the eight built-in names, which keeps early-boot writes legal.
const AssetTypeEnum = z.string().min(2).max(32).refine(
  (v) => isKnownAssetType(v),
  { message: "Unknown asset type. Add it under Assets → Manage asset types first." },
);

const AssetStatusEnum = z.enum([
  "active", "maintenance", "decommissioned", "storage", "disabled", "quarantined",
]);

const macRegex = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;

// An asset's address is later put into a generated .rdp file, an ssh:// link and
// a copy-and-paste `ssh` / `mstsc` command line (public/js/assets.js), so it may
// hold only what an IPv4 / IPv6 address or a hostname can: letters, digits and
// . _ : % [ ] -. No whitespace or control character, and no shell or RDP-file
// metacharacter. (A line break in it added lines to the .rdp file — scan
// finding F257; rule 107.)
const ASSET_ADDRESS_RE = /^[A-Za-z0-9._:%\[\]-]+$/;

const AssetAddressSchema = z
  .string()
  .max(255)
  .regex(ASSET_ADDRESS_RE, "ipAddress may contain only letters, digits and . _ : % [ ] -");

export const CreateAssetSchema = z.object({
  ipAddress:     AssetAddressSchema.min(1).optional(),
  // The all-zero MAC is "no MAC", never an address: it parses to null, so a
  // create stores none and an update clears the field (which is also how an
  // asset still carrying a zero from before this check sheds it the next
  // time its edit form is saved, instead of that save being refused).
  macAddress:    z.string().regex(macRegex, "Invalid MAC address format (expected AA:BB:CC:DD:EE:FF)")
                   .transform((v) => (isAllZeroMac(v) ? null : v)).optional(),
  hostname:      z.string().optional(),
  dnsName:       z.string().optional(),
  assetTag:      z.string().optional(),
  serialNumber:  z.string().optional(),
  manufacturer:  z.string().optional(),
  model:         z.string().optional(),
  assetType:     AssetTypeEnum.optional().default("other"),
  status:        AssetStatusEnum.optional().default("active"),
  location:      z.string().optional(),
  // Manual geo pin (decimal degrees). Travels as a pair — both numbers, both
  // null (clear), or both omitted; pair semantics enforced in the handlers
  // via manualCoordPatchError. Setting stamps coordSource="manual" so the
  // discovery-projected coords can't overwrite; clearing resets coordSource
  // so discovery may repopulate on its next cycle.
  latitude:      z.number().min(-90).max(90).nullable().optional(),
  longitude:     z.number().min(-180).max(180).nullable().optional(),
  department:    z.string().optional(),
  assignedTo:    z.string().optional(),
  os:            z.string().optional(),
  acquiredAt:    z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  warrantyExpiry:z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  purchaseOrder: z.string().optional(),
  notes:         z.string().optional(),
  // Operator-owned device description. On Fortinet assets whose originating
  // integration syncs this device class (utils/descriptionSyncFlags.ts), the PUT handler mirrors it to the
  // device (Polaris-primary; see descriptionSyncService). Device-side caps
  // are tighter for some targets (FortiGate alias ~35) — the push truncates.
  description:   z.string().max(255).optional(),
  tags:          z.array(z.string()).optional(),
});

// Mirrors PollingMethod in src/utils/pollingCompatibility.ts. Source-kind
// compatibility is enforced at resolution time, not here — the resolver
// silently falls through to the next tier when a per-asset override doesn't
// apply to the asset's source. Includes "disabled" (universally allowed
// opt-out) and "agent" (Polaris Agent; allowed on AD/Entra/WinServer/Manual
// sources, ignored on fortimanager/fortigate).
const PollingMethodEnum = z.enum(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter", "fortimanager", "unraid", "truenas", "proxmox", "genericapi"]);

export const UpdateAssetSchema = CreateAssetSchema.partial().extend({
  // Unlike create (min(1)), update accepts "" — blanking the IP Address field
  // of an asset that HAS an address pins it to no address (Asset.ipBlankPinned):
  // discovery can no longer fill it. `ipRevertToDiscovered: true` is the
  // other way out of a pin — release it and take the discovery-projected
  // address (it wins over `ipAddress` in the same body).
  ipAddress:             AssetAddressSchema.or(z.literal("")).optional(),
  ipRevertToDiscovered:  z.literal(true).optional(),
  monitored:             z.boolean().optional(),
  monitorCredentialId:          z.string().uuid().nullable().optional(),
  responseTimeCredentialId:     z.string().uuid().nullable().optional(),
  cpuMemoryCredentialId:        z.string().uuid().nullable().optional(),
  temperatureCredentialId:      z.string().uuid().nullable().optional(),
  interfacesCredentialId:       z.string().uuid().nullable().optional(),
  lldpCredentialId:             z.string().uuid().nullable().optional(),
  // Per-stream MIB overrides ("std:<key>" | uploaded MIB UUID | null = inherit)
  responseTimeMibId:            z.string().nullable().optional(),
  cpuMemoryMibId:               z.string().nullable().optional(),
  temperatureMibId:             z.string().nullable().optional(),
  interfacesMibId:              z.string().nullable().optional(),
  lldpMibId:                    z.string().nullable().optional(),
  monitorIntervalSec:           z.number().int().min(5).max(86400).nullable().optional(),
  // Per-asset probe timeout override. 100..60000 ms; null inherits from the
  // resolved tier-3 setting. The frontend renders a soft warning at <500 ms.
  probeTimeoutMs:        z.number().int().min(100).max(60000).nullable().optional(),
  // Per-asset overrides for the heavy collectors. 1000..120000 ms; null = inherit.
  // Wider range than probeTimeoutMs — these scrapes pull dozens of OIDs or
  // multi-MB FortiOS payloads, and a too-tight ceiling false-fails the run.
  cpuMemoryTimeoutMs:    z.number().int().min(1000).max(120000).nullable().optional(),
  temperatureTimeoutMs:  z.number().int().min(1000).max(120000).nullable().optional(),
  systemInfoTimeoutMs:   z.number().int().min(1000).max(120000).nullable().optional(),
  // Per-stream polling-method overrides — top-tier override, falls through
  // to the class override / integration tier / source default. Compatibility
  // with the asset's source kind is enforced at PUT time below.
  responseTimePolling:   PollingMethodEnum.nullable().optional(),
  cpuMemoryPolling:      PollingMethodEnum.nullable().optional(),
  temperaturePolling:    PollingMethodEnum.nullable().optional(),
  interfacesPolling:     PollingMethodEnum.nullable().optional(),
  lldpPolling:           PollingMethodEnum.nullable().optional(),
  storagePolling:        PollingMethodEnum.nullable().optional(),
  // Per-asset request path for the "http" response-time check, overriding the
  // path used by an HTTP-check widget. Blank clears the override (see
  // the trim below) — it does NOT mean "/", so emptying the box returns the
  // device to the credential's path rather than repointing it at the web root.
  httpCheckPath:         z.string().max(1024).nullable().optional(),
  // Per-asset cadence overrides for the System tab. Null falls back to the
  // resolved tier-3 cadence (cpuMemory / temperature / system-info).
  cpuMemoryIntervalSec:   z.number().int().min(15).max(86400).nullable().optional(),
  temperatureIntervalSec: z.number().int().min(15).max(86400).nullable().optional(),
  systemInfoIntervalSec:  z.number().int().min(60).max(86400).nullable().optional(),
  // ifNames the operator pinned for fast-cadence polling on the System tab.
  // Cap at 64 so an accidental "select-all on a 200-port chassis" can't
  // saturate the device every probe interval.
  monitoredInterfaces:   z.array(z.string().min(1)).max(64).optional(),
  // hrStorage mountPaths pinned for fast-cadence polling. Same model + cap as
  // monitoredInterfaces — keeps a server with hundreds of mountpoints from
  // re-walking the full storage table once per minute by accident.
  monitoredStorage:      z.array(z.string().min(1)).max(64).optional(),
  // Phase-1 IPsec tunnel names pinned for fast-cadence polling. The full
  // /api/v2/monitor/vpn/ipsec endpoint can be slow on busy gateways so it's
  // skipped on the fast cadence by default; pinning issues a targeted scrape.
  monitoredIpsecTunnels: z.array(z.string().min(1)).max(64).optional(),
  // Process names pinned for per-minute CPU/RAM telemetry + log tailing
  // (Processes-tab "Monitor" checkbox). Same 64 cap.
  monitoredProcesses:    z.array(z.string().min(1)).max(64).optional(),
  // Process names flagged for future alerting (Processes-tab "Alert" checkbox).
  alertWatchedProcesses: z.array(z.string().min(1)).max(64).optional(),
  // Process names toggled for Application Map connection discovery
  // (Processes-tab "Map" checkbox). Same 64 cap; independent of the Monitor pin.
  mappedProcesses:       z.array(z.string().min(1)).max(64).optional(),
  // Service/unit names pinned for per-unit journalctl tailing (Services-tab
  // "Logs" checkbox) and Application Map connection attribution ("Map"
  // checkbox). Services-tab siblings of monitored/mappedProcesses.
  monitoredServices:     z.array(z.string().min(1)).max(64).optional(),
  mappedServices:        z.array(z.string().min(1)).max(64).optional(),
});

/**
 * Refuse a write that would leave monitoring ON in a status that can't carry
 * it (business rule 10). The clamp in db.ts would silently rewrite
 * `monitored` to false, which is the right BACKSTOP but the wrong answer to an
 * operator who just ticked the box: the form would save "successfully" and
 * come back with the box clear and no explanation. So the two operator-facing
 * write paths (this one and POST /bulk-monitor) say why instead.
 */
function assertMonitorableStatus(monitored: unknown, status: unknown): void {
  if (monitored !== true) return;
  if (statusAllowsMonitoring(status)) return;
  throw new AppError(
    409,
    `A ${String(status)} asset cannot be monitored — ${UNMONITORABLE_STATUSES.join(" / ")} assets are not polled. ` +
      "Change the status first, then enable monitoring.",
  );
}

// NOTE: process/service start/stop/restart control was removed (Satellite-posture
// change). The former POST /:id/processes/:name/control, POST /:id/services/:unit/
// control, and GET /:id/process-command/:commandId routes no longer exist; the
// agent no longer accepts control actions. Automation script runs stay (they ride
// the AgentCommand queue with action="run_script").

// POST /api/v1/assets — create (assets admin)
/**
 * Business rule 40(i): re-evaluate the duplicate-ip conflicts for the
 * addresses an operator write touched and hand back the one on the address
 * it wrote (`null` when the save raised nothing). A failure here must never
 * cost the save that already landed — the sweep re-derives the same answer
 * within ten minutes — so it degrades to `null` with a log line.
 */
async function writeTimeIpConflictFor(
  touched: readonly (string | null | undefined)[],
  writtenIp: string | null | undefined,
): Promise<WriteTimeIpConflict | null> {
  try {
    const byIp = await reconcileDuplicateIpForAddresses(touched);
    return writtenIp ? (byIp.get(writtenIp) ?? null) : null;
  } catch (err: any) {
    logger.warn({ err: err?.message, touched }, "write-time duplicate-ip check failed; the sweep will re-evaluate");
    return null;
  }
}

/**
 * Pre-checks of a create that need no request: the quarantine-status guard and
 * the manual-coordinate pair. The route runs these, then the Tags permission
 * check (which needs the request), then createAsset — the original order.
 */
export function validateAssetCreate(input: CreateAssetInput): void {
  assertQuarantineStatusUntouched(input.status, null);
  const coordErr = manualCoordPatchError(input.latitude, input.longitude);
  if (coordErr) throw new AppError(400, coordErr);
}

/**
 * POST /assets after its permission checks: the region-tag guard, normalise
 * the body, stamp status / creator, create, record the credential use
 * (rule 112), write asset.created, the best-effort auto-tag and region
 * refresh, and the write-time duplicate-ip check (rule 40(i)).
 */
export async function createAsset(
  input: CreateAssetInput,
  actor: string | undefined,
  credentialActor: CredentialUseActor,
): Promise<Record<string, unknown> & { ipConflict: WriteTimeIpConflict | null }> {
  if (input.tags) await assertAddedRegionTagsNameARegion([], input.tags);
  const data: Record<string, unknown> = { ...input };
  // `azure:` tags are the Arc sync's alone; an operator cannot mint one.
  if (input.tags) data.tags = withArcOwnedTags([], input.tags);
  if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
  // Description: empty string clears to null (an empty Polaris description
  // is re-seeded from the device on the next discovery when the
  // integration's description-sync toggle for its device class is on).
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  // Hostname: trim; an empty box means "not provided", not "" (the edit
  // form now always sends the field, including blank).
  if (typeof input.hostname === "string") data.hostname = input.hostname.trim() || null;
  // Location: same — the form always sends it, and "" is "none", not a value.
  if (typeof input.location === "string") data.location = input.location.trim() || null;
  if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
  if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
  if (input.ipAddress) data.ipSource = "manual";
  if (typeof input.latitude === "number") data.coordSource = "manual";
  // Always stamp status tracking on creation (status is always set here)
  data.statusChangedAt = new Date();
  data.statusChangedBy = actor ?? "manual";
  data.createdBy = actor ?? null;
  clampAcquiredToLastSeen(data);
  const asset = await prisma.asset.create({ data: data as any });
  await auditAssetCredentialUse(credentialActor, "asset.create", null, asset as unknown as AssetCredentialSlots);
  logEvent({ action: "asset.created", resourceType: "asset", resourceId: asset.id, resourceName: input.hostname || input.ipAddress, actor: actor, message: `Asset "${input.hostname || input.ipAddress || "unknown"}" created` });
  // Apply any criteria-based auto-tags to the new asset (best-effort).
  reconcileTagsForAsset(asset.id).catch(() => {});
  // Manual coords on a firewall may move it into/out of a map region —
  // refresh membership now instead of waiting for the periodic job.
  if (asset.assetType === "firewall" && typeof input.latitude === "number") {
    reconcileMapRegions().catch(() => {});
  }
  // Business rule 40(i): an operator just put a device on an address. If
  // something else network-present already records it, the collision is
  // raised NOW — a duplicate-ip conflict card plus the `conflict.detected`
  // Event the baseline automation alerts on — rather than on the sweep's
  // next tick, and the response names the card so the form can open it or
  // hand the pair to the merge review. Awaited, not fire-and-forget: the
  // whole point is that the person who caused the collision is told.
  const ipConflict = await writeTimeIpConflictFor(asset.ipAddress ? [asset.ipAddress] : [], asset.ipAddress);
  return { ...asset, ipConflict };
}

// PUT /api/v1/assets/:id — update (assets admin)
// ─── PUT /:id phases (split 2026-08 — the contract tests in
// tests/integration/assetPutContract.test.ts pin the guards, the pin/override
// semantics, the status stamps, and the unmap side effect). requestActor is
// resolved once in the handler and threaded down.

type UpdateAssetInput = z.infer<typeof UpdateAssetSchema>;

type CreateAssetInput = z.infer<typeof CreateAssetSchema>;

export async function loadAssetForUpdate(id: string) {
  return prisma.asset.findUnique({
    where:   { id },
    include: { discoveredByIntegration: { select: { type: true } } },
  });
}

type ExistingAssetForUpdate = NonNullable<Awaited<ReturnType<typeof loadAssetForUpdate>>>;

// Phase 1 — request-level guards that must 400 before anything is staged.
async function validateAssetUpdate(id: string, existing: ExistingAssetForUpdate, input: UpdateAssetInput): Promise<void> {
  // A `region:` tag the operator is ADDING must name a region that exists. The
  // ones already on the row pass through untouched — the edit modal PUTs the
  // whole array back — and hand-applying a live region's tag to a device its
  // polygon misses stays legal. Costs no query unless a region tag was added.
  if (input.tags) await assertAddedRegionTagsNameARegion(existing.tags ?? [], input.tags);

  // Per-asset polling overrides must be valid for the asset's source kind.
  // Falling through silently at the resolver would leave the operator
  // confused about why their selection didn't take.
  {
    const sourceKind = assetSourceKindFromIntegrationType(existing.discoveredByIntegration?.type ?? null);
    const fields: Array<["responseTimePolling" | "cpuMemoryPolling" | "temperaturePolling" | "interfacesPolling" | "lldpPolling" | "storagePolling", PollingMethod | null | undefined]> = [
      ["responseTimePolling", input.responseTimePolling],
      ["cpuMemoryPolling",    input.cpuMemoryPolling],
      ["temperaturePolling",  input.temperaturePolling],
      ["interfacesPolling",   input.interfacesPolling],
      ["lldpPolling",         input.lldpPolling],
      ["storagePolling",      input.storagePolling],
    ];
    for (const [name, value] of fields) {
      if (!value) continue;
      if (!isPollingMethodCompatible(sourceKind, value)) {
        throw new AppError(
          400,
          `${pollingMethodLabel(value)} polling is not supported for ${sourceKind} assets (field: ${name})`,
        );
      }
      // "vcenter" reads the vCenter server's batched per-integration fetch, so
      // it covers only the streams that fetch can answer (VCENTER_STREAMS:
      // responseTime / cpuMemory / interfaces / storage) AND requires a vCenter
      // AssetSource to resolve the integration through. The matrix allows the
      // method on the directory source kinds (merged VMs); this is the precise
      // check.
      // NOTE: the "http" polling method was retired (2026-08) — the HTTP check
      // it performed is now a manufacturer custom widget, so there is no
      // per-stream guard for it here any more. The schema enum rejects the
      // value outright.
      if (value === "vcenter") {
        const stream = name.replace(/Polling$/, "") as Stream;
        if (!isMethodValidForStream(stream, "vcenter")) {
          throw new AppError(400, `vCenter polling does not apply to the ${stream} stream (field: ${name})`);
        }
        // Either role: a VM's stats come from the VirtualMachine fetch, an ESXi
        // host's from the HostSystem fetch. Both resolve the integration the
        // same way.
        const vcSource = await prisma.assetSource.findFirst({
          where: { assetId: id, sourceKind: { in: ["vcenter-vm", "vcenter-host"] } },
          select: { id: true },
        });
        if (!vcSource) {
          throw new AppError(400, "vCenter polling requires this asset to be a vCenter-discovered VM or ESXi host (no vCenter source on file)");
        }
      }
      // "unraid" / "truenas" / "proxmox": the vCenter guard for the workload integrations —
      // the stream must be one the host's API answers, and the asset must carry
      // a source row of THAT platform to resolve the integration through.
      if (isWorkloadPollingMethod(value)) {
        const stream = name.replace(/Polling$/, "") as Stream;
        const label = workloadPlatformLabel(value);
        if (!isMethodValidForStream(stream, value)) {
          throw new AppError(400, `${label} polling does not apply to the ${stream} stream (field: ${name})`);
        }
        const wlSource = await prisma.assetSource.findFirst({
          where: { assetId: id, sourceKind: { in: workloadSourceKindsFor(value) } },
          select: { id: true },
        });
        if (!wlSource) {
          throw new AppError(400, `${label} polling requires this asset to be discovered by a ${label} integration (no ${label} source on file)`);
        }
      }
      // "genericapi": the integration's own monitor queries answer for the
      // asset (rule 100(i)), so it needs a Generic API record to resolve the
      // integration through, and a stream a query can map.
      if (value === "genericapi") {
        const stream = name.replace(/Polling$/, "") as Stream;
        if (!isMethodValidForStream(stream, value)) {
          throw new AppError(400, `Generic API polling does not apply to the ${stream} stream (field: ${name})`);
        }
        const gaSource = await prisma.assetSource.findFirst({
          where: { assetId: id, sourceKind: "generic-api" },
          select: { id: true },
        });
        if (!gaSource) {
          throw new AppError(400, "Generic API polling requires this asset to be listed by a Generic API integration (no Generic API record on file)");
        }
      }
      // "fortimanager" reads FMG's own device roster — reachability and nothing
      // else — so it covers response time only, and needs an actual
      // FortiManager to ask. The source-kind check above already rejects it on
      // a standalone FortiGate; this catches the stream half, plus the asset
      // having a serial to join the roster on (the probe identifies a chassis
      // by serial, never by name).
      if (value === "fortimanager") {
        const stream = name.replace(/Polling$/, "") as Stream;
        if (!isMethodValidForStream(stream, "fortimanager")) {
          throw new AppError(
            400,
            `FortiManager polling only applies to the response-time stream — FortiManager's database carries reachability, not metrics (field: ${name})`,
          );
        }
        if (!existing.serialNumber) {
          throw new AppError(400, "FortiManager polling identifies the device by serial number, and this asset has none recorded");
        }
      }
      const stream = name.replace(/Polling$/, "") as Stream;
      // ICMP carries no payload, so it can only answer a response-time probe.
      // The integration-tier and class-override validators have always refused
      // this; the per-asset path never did, so `PUT /assets/:id` accepted it,
      // the resolver adopted it, and the stream then fell into its
      // `{supported:false}` branch forever.
      if (value === "icmp" && stream !== "responseTime") {
        throw new AppError(400, `ICMP polling is only valid for the response-time stream (field: ${name})`);
      }
      // Warn — don't refuse — when no collector exists. Refusing would break an
      // operator merely re-saving an asset that already holds the value.
      const cap = collectorCapability(sourceKind, stream, value, { assetType: existing.assetType });
      if (!cap.implemented) {
        logger.warn(
          { assetId: id, sourceKind, stream, method: value, reason: cap.reason },
          `Asset update accepted a polling method with no collector — this stream will silently collect nothing: ${cap.reason}`,
        );
      }
    }
  }
  // Lock assetType on Fortinet infrastructure discovered via an integration.
  // The next discovery cycle would re-stamp the asset anyway, so accepting
  // the change just to revert it is misleading.
  if (
    input.assetType !== undefined &&
    input.assetType !== existing.assetType &&
    existing.discoveredByIntegrationId &&
    (existing.assetType === "firewall" || existing.assetType === "switch" || existing.assetType === "access_point")
  ) {
    throw new AppError(400, `Asset type is locked — discovered as ${existing.assetType} by an integration`);
  }
  // Quarantine status is owned by the dedicated quarantine endpoints —
  // setting it via the generic asset PUT would skip the FortiGate push
  // (or skip the device-side unpush on release), creating divergence
  // between Polaris's view and the FortiGate's enforcement state.
  if (input.status === "quarantined" && existing.status !== "quarantined") {
    throw new AppError(400, "Use POST /assets/:id/quarantine to quarantine an asset");
  }
  if (input.status !== undefined && input.status !== "quarantined" && existing.status === "quarantined") {
    throw new AppError(400, "Use DELETE /assets/:id/quarantine to release the quarantine before changing status");
  }
  const coordErr = manualCoordPatchError(input.latitude, input.longitude);
  if (coordErr) throw new AppError(400, coordErr);
  // Last: it is the only guard here that queries, so the cheap refusals above
  // get to fail first.
  await assertCredentialAssignments(input, existing);
}

// Phase 2 — stage the update patch: field normalization, the hostname/IP
// operator pins (set / echo / clear semantics), date coercion, the manual-
// coordinate pin, status stamps (+ the operator-wins maintenance release),
// and the monitored/acquiredAt clamps. Returns the patch plus the flags the
// post-write side effects branch on.
async function buildAssetUpdatePatch(
  id: string,
  existing: ExistingAssetForUpdate,
  input: UpdateAssetInput,
  actor: string | undefined,
): Promise<{ data: Record<string, unknown>; ipOverrideTouched: boolean; coordChanged: boolean }> {
  const data: Record<string, unknown> = { ...input };
  // `azure:` tags are the Arc sync's alone and the edit form's tag picker has
  // no chip for them, so its wholesale PUT omits them: keep the ones the asset
  // carries and drop any the body tries to add or remove.
  if (input.tags) data.tags = withArcOwnedTags(existing.tags ?? [], input.tags);
  if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
  // Description: empty string clears to null (an empty Polaris description
  // is re-seeded from the device on the next discovery when the
  // integration's description-sync toggle for its device class is on).
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  // Notes: empty string clears to null (notes are operator-only — an
  // emptied box is an intentional clear, not "not provided").
  if (typeof input.notes === "string") data.notes = input.notes.trim() || null;
  // Location: empty string clears to null (operator-set; the display then
  // falls back to learnedLocation). The edit form always sends the field.
  if (typeof input.location === "string") data.location = input.location.trim() || null;
  // HTTP-check path override: empty string clears to null. Stored null rather
  // than "" so "no override" has one representation in the column — the probe's
  // resolveHttpTarget treats both as absent, but a column carrying "" would
  // read as a configured value in exports and the edit form alike.
  if (typeof input.httpCheckPath === "string") data.httpCheckPath = input.httpCheckPath.trim() || null;
  // Discovery projection (lazy, computed at most once) — needed when a
  // pin-clear reverts hostname or ipAddress to the projected value.
  let _projection: ReturnType<typeof projectAssetFromSources> | null = null;
  const loadProjection = async () => {
    if (!_projection) {
      const overrideSources = await prisma.assetSource.findMany({
        where: { assetId: id },
        select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
      });
      _projection = projectAssetFromSources(
        overrideSources.map((s) => ({
          sourceKind: s.sourceKind,
          inferred: s.inferred,
          observed: s.observed as Record<string, unknown> | null,
          lastSeen: s.lastSeen,
        })),
      );
    }
    return _projection;
  };
  // Hostname: an edit-time write is an operator override (coordSource-style
  // pin — the db.ts extension re-asserts it over discovery projection
  // writes). Only a real change pins, since the edit form echoes the
  // current hostname back on every save. Clearing (empty string) releases
  // the pin and reverts hostname to the discovery-projected value (null
  // when no source has an opinion, e.g. manually-created assets).
  if (input.hostname !== undefined) {
    const trimmed = input.hostname.trim();
    if (!trimmed) {
      data.hostnameOverride = null;
      data.hostname = (await loadProjection()).projected.hostname;
    } else if (trimmed !== existing.hostname) {
      data.hostname = trimmed;
      data.hostnameOverride = trimmed;
    } else {
      delete data.hostname;
    }
  }
  // IP Address: same operator-override pattern as Hostname, with
  // discovery-gets-a-vote semantics on later writes (see Asset.ipOverride
  // in schema.prisma: discovery reporting the pinned IP releases the pin;
  // a different IP re-asserts it and raises an ip-override Conflict).
  // Only a real change pins. Clearing an address the asset HAS pins it to no
  // address (ipBlankPinned) — it used to re-project, which put a discovered
  // address straight back on save. A blank that is already blank is a no-op
  // (the form re-sends the empty field on every save; pinning there would
  // lock every address-less asset against discovery). "Revert to discovered"
  // (`ipRevertToDiscovered`) releases either pin and re-projects. Any
  // set/clear/revert closes the asset's pending ip-override conflict — the
  // operator just made the call the conflict was asking about.
  let ipOverrideTouched = false;
  delete data.ipRevertToDiscovered;
  if (input.ipRevertToDiscovered) {
    const { projected, provenance } = await loadProjection();
    data.ipOverride = null;
    data.ipBlankPinned = false;
    data.ipAddress = projected.ipAddress;
    data.ipSource = projected.ipAddress ? (provenance.ipAddress ?? "discovery") : null;
    // Revert releases the primary-address pin too (business rule 102) — all
    // three pins are operator choices this action undoes.
    Object.assign(data, CLEAR_PRIMARY_ADDRESS_PIN);
    ipOverrideTouched = !!existing.ipOverride || existing.ipBlankPinned;
  } else if (input.ipAddress !== undefined) {
    const trimmed = input.ipAddress.trim();
    if (!trimmed && !existing.ipAddress) {
      // Already blank — a blank pin, a rule 40(j) hold (blanked from a
      // duplicate-IP card, waiting for discovery), or simply no address.
      // Re-sending the empty field changes none of them.
      delete data.ipAddress;
    } else if (!trimmed) {
      data.ipAddress = null;
      data.ipOverride = null;
      data.ipBlankPinned = true;
      data.ipSource = null;
      data.ipCleared = null; // the pin supersedes any rule 40(j) hold
      Object.assign(data, CLEAR_PRIMARY_ADDRESS_PIN); // pins are mutually exclusive (rule 102)
      ipOverrideTouched = true;
    } else if (trimmed !== existing.ipAddress) {
      data.ipAddress = trimmed;
      data.ipOverride = trimmed;
      data.ipBlankPinned = false;
      data.ipSource = "manual";
      data.ipCleared = null; // a typed address ends any rule 40(j) blank hold
      Object.assign(data, CLEAR_PRIMARY_ADDRESS_PIN); // pins are mutually exclusive (rule 102)
      ipOverrideTouched = true;
      // Business rule 101(b): the last-seen FortiGate follows the pinned
      // address. Fortinet infra keeps its own (its learnedLocation is itself).
      if (!["firewall", "switch", "access_point"].includes(existing.assetType)) {
        const gate = await gateForPinnedAddress(trimmed, [existing.learnedLocation]);
        if (gate && gate !== existing.learnedLocation) data.learnedLocation = gate;
      }
    } else {
      delete data.ipAddress;
    }
  }
  if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
  else if (input.acquiredAt === undefined) delete data.acquiredAt;
  if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
  else if (input.warrantyExpiry === undefined) delete data.warrantyExpiry;
  // Manual coordinates: only a real change stamps coordSource — the edit
  // form echoes the current values back on every save, and silently pinning
  // discovery-stamped coords as "manual" would freeze discovery updates for
  // the asset. Clearing (null pair) releases the pin so discovery may
  // repopulate on its next cycle.
  let coordChanged = false;
  if (input.latitude !== undefined) {
    coordChanged = input.latitude !== existing.latitude || input.longitude !== existing.longitude;
    if (coordChanged) {
      data.coordSource = input.latitude === null ? null : "manual";
    } else {
      delete data.latitude;
      delete data.longitude;
    }
  }
  if (input.status !== undefined) {
    data.statusChangedAt = new Date();
    data.statusChangedBy = actor ?? "manual";
  }
  // Operator moves status OFF "maintenance" while maintenance windows are
  // open: the operator wins. Close the windows first (endReason "operator"
  // — suppresses scheduler re-entry for each schedule's current occurrence)
  // so the reconcile can't re-flip this write.
  if (
    input.status !== undefined &&
    input.status !== "maintenance" &&
    existing.status === "maintenance"
  ) {
    await operatorReleaseAsset(id, actor);
  }
  // Effective status after this write — the edit form can flip status and
  // monitoring in the same save, and it's the RESULT that has to be legal.
  assertMonitorableStatus(data.monitored, input.status ?? existing.status);
  clampMonitoredState(data);
  clampAcquiredToLastSeen(data, existing);
  return { data, ipOverrideTouched, coordChanged };
}

// Phase 3 — post-write side effects: monitor-override recompute, the
// unmap-deletes-connections cleanups, pin-flip auto-rule bookkeeping,
// pending ip-override conflict resolution, the audit Event, description
// sync, tag reconcile, and the map-region refresh.
async function applyAssetUpdateSideEffects(
  id: string,
  existing: ExistingAssetForUpdate,
  asset: Awaited<ReturnType<typeof prisma.asset.update>>,
  input: UpdateAssetInput,
  actor: string | undefined,
  flags: { ipOverrideTouched: boolean; coordChanged: boolean },
): Promise<void> {
  // When the operator's `monitored` choice changes (or assetType changes,
  // which moves the asset into a different per-class block), recompute
  // monitorOverride against the discovering integration's addAsMonitored.
  // A single SQL UPDATE handles the JSON-path lookup in one round-trip.
  if (input.monitored !== undefined || input.assetType !== undefined) {
    await recomputeMonitorOverrideForAssets(prisma, [id]);
  }
  // An operator decommissioning a managed FortiSwitch/FortiAP gives its address
  // back, same as the discovery-side sweeps do. Scoped to the two infra types on
  // purpose: a server carrying an operator-pushed reservation is not something a
  // status change should quietly unpush. Post-write so it reads the row's
  // committed state; never throws.
  if (
    input.status === "decommissioned" &&
    existing.status !== "decommissioned" &&
    (asset.assetType === "switch" || asset.assetType === "access_point")
  ) {
    await releaseInfraReservationsForAssets([id], {
      reason: "decommissioned by operator",
      actor,
    });
  }
  // Business rule 123: an agent host's pinned SSH host key / WinRM certificate
  // is archived while it is decommissioned and reinstated when it returns. The
  // reconcileAgentHostPins job repeats this for every other status writer, so
  // a failure here is logged, not thrown — the status change already landed.
  if (input.status !== undefined && input.status !== existing.status) {
    try {
      if (input.status === "decommissioned") {
        await archiveAgentHostPins(id, actor);
      } else if (existing.status === "decommissioned") {
        if (await reinstateAgentHostPins(id, actor)) {
          await resolvePendingCheckinConflicts(id, actor ?? "manual");
        }
      }
    } catch (err) {
      logger.warn({ err, assetId: id }, "agent host-pin archive/reinstate failed; the reconcile job will retry");
    }
  }
  // Unmapping a process removes its accumulated connection rows immediately —
  // the Application Map must not keep drawing edges for up to the retention
  // window after the operator opted the process out.
  if (input.mappedProcesses !== undefined) {
    const kept = new Set(input.mappedProcesses);
    const removed = (existing.mappedProcesses ?? []).filter((n) => !kept.has(n));
    if (removed.length > 0) {
      await prisma.assetProcessConnection.deleteMany({
        where: { assetId: id, processName: { in: removed } },
      });
    }
  }
  // Unmapping a UNIT likewise drops its accumulated connection rows now
  // (Phase 3) — rows carry the owning unit, so delete by unit.
  if (input.mappedServices !== undefined) {
    const kept = new Set(input.mappedServices);
    const removed = (existing.mappedServices ?? []).filter((u) => !kept.has(u));
    if (removed.length > 0) {
      await prisma.assetProcessConnection.deleteMany({
        where: { assetId: id, unit: { in: removed } },
      });
    }
  }
  // Pin flips become AUTO discovery rules (Integrations → Polaris Agent):
  // ticking Monitor/Map on this asset mints (or consolidates into) a
  // single-item auto rule targeting it; un-ticking takes the asset off the
  // matching auto rules so the reconcile can't re-pin what was just removed.
  // Fire-and-forget: the pin already landed on the asset row above, and rule
  // bookkeeping must not fail or slow the operator's save.
  {
    const pinChanges: OperatorPinChange[] = [];
    const diffPins = (
      field: "monitoredProcesses" | "mappedProcesses" | "monitoredServices" | "mappedServices",
      kind: "process" | "service",
      surface: "monitor" | "map",
    ) => {
      const posted = (input as any)[field] as string[] | undefined;
      if (posted === undefined) return;
      const was = new Set(((existing as any)[field] ?? []) as string[]);
      const now = new Set(posted);
      for (const n of now) if (!was.has(n)) pinChanges.push({ assetId: id, kind, name: n, surface, action: "added" });
      for (const n of was) if (!now.has(n)) pinChanges.push({ assetId: id, kind, name: n, surface, action: "removed" });
    };
    diffPins("monitoredProcesses", "process", "monitor");
    diffPins("mappedProcesses", "process", "map");
    diffPins("monitoredServices", "service", "monitor");
    diffPins("mappedServices", "service", "map");
    if (pinChanges.length > 0) {
      const hostLabel = asset.hostname || asset.ipAddress || id;
      recordOperatorPinChanges(pinChanges)
        .then((outcome) => {
          if (!outcome || !outcome.changed) return;
          const bits: string[] = [];
          if (outcome.createdRules.length) bits.push(`created ${outcome.createdRules.join(", ")}`);
          if (outcome.updatedRules.length) bits.push(`added ${hostLabel} to ${outcome.updatedRules.join(", ")}`);
          if (outcome.trimmedRules.length) bits.push(`removed ${hostLabel} from ${outcome.trimmedRules.join(", ")}`);
          if (outcome.prunedRules.length) bits.push(`deleted ${outcome.prunedRules.join(", ")}`);
          logEvent({
            action: "application_map.autorule.synced",
            resourceType: "application_map",
            resourceId: "discovery",
            actor,
            message: `Discovery auto-rules updated from pins on "${hostLabel}": ${bits.join("; ")}`,
            details: { assetId: id, changes: pinChanges, outcome } as any,
          });
        })
        .catch(() => {});
    }
  }
  // Operator set/cleared the IP pin: any pending ip-override conflict is
  // now moot (best-effort — a leftover pending row would only linger until
  // the next discovery cycle refreshes or re-raises it).
  if (flags.ipOverrideTouched) {
    resolvePendingIpOverrideConflicts(id, actor ?? "manual").catch(() => {});
  }
  // `os` is in the tracked set; `osVersion` deliberately isn't, because
  // UpdateAssetSchema doesn't accept it — firmware is discovery/agent-owned.
  const trackFields = ["hostname", "hostnameOverride", "ipAddress", "ipOverride", "ipBlankPinned", "macAddress", "manufacturer", "model", "serialNumber", "assetType", "status", "location", "latitude", "longitude", "notes", "description", "dnsName", "os"] as const;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const f of trackFields) { before[f] = (existing as any)[f]; after[f] = (asset as any)[f]; }
  const changes = buildChanges(before, after);
  logEvent({ action: "asset.updated", resourceType: "asset", resourceId: id, resourceName: asset.hostname || asset.ipAddress || undefined, actor, message: `Asset "${asset.hostname || asset.ipAddress || "unknown"}" updated`, details: changes ? { changes } : undefined });
  // An operator retyping the OS is a firmware change like any other — same
  // action string, so one automation covers operator and discovery edits alike.
  if (input.os !== undefined) {
    const firmwareEvent = buildFirmwareChangedEvent(
      {
        assetId: id,
        assetName: asset.hostname || asset.ipAddress || null,
        actor: actor ?? "manual",
        source: "operator",
      },
      { os: (existing as any).os },
      { os: (asset as any).os },
    );
    if (firmwareEvent) void logEvent(firmwareEvent);
  }
  // Description sync (Polaris-primary): a changed device description on a
  // Fortinet asset whose integration opted in is mirrored to the device.
  // Fire-and-forget — the Polaris row is authoritative and already saved;
  // failures stamp Asset.descriptionSync + a warning Event inside the
  // service, and the per-discovery reconcile self-heals.
  if (input.description !== undefined && (existing as any).description !== asset.description) {
    syncDescriptionsOnSave({ assetId: id, scope: "device", actor }).catch(() => {});
  }
  // Re-evaluate criteria-based auto-tags when a criteria-relevant field changed
  // (best-effort; the periodic job is the safety net).
  const TAG_CRITERIA_FIELDS = ["manufacturer", "model", "os", "osVersion", "hostname", "department", "location", "assetType", "status", "ipAddress"] as const;
  if (TAG_CRITERIA_FIELDS.some((f) => (input as any)[f] !== undefined)) {
    reconcileTagsForAsset(id).catch(() => {});
  }
  // A firewall's coords drive map-region membership (region: tags) —
  // refresh now instead of waiting for the periodic reconcile job.
  if (flags.coordChanged && asset.assetType === "firewall") {
    reconcileMapRegions().catch(() => {});
  }
}

/** Record (rule 112) the credentials an asset write pointed at a destination. Never throws. */
async function auditAssetCredentialUse(
  credentialActor: CredentialUseActor,
  via: CredentialUseVia,
  before: AssetCredentialSlots | null,
  after: AssetCredentialSlots,
): Promise<void> {
  const uses = assetCredentialUses(before, after);
  if (uses.length) await recordCredentialUse(credentialActor, via, uses);
}

/**
 * PUT /assets/:id after the route's request-bound checks (integration-token
 * retarget, Tags permission): validate, build the patch, write, run the side
 * effects, record the credential use (rule 112), and re-evaluate both ends of
 * a moved address (rule 40(i)).
 */
export async function updateAsset(
  id: string,
  existing: ExistingAssetForUpdate,
  input: UpdateAssetInput,
  actor: string | undefined,
  credentialActor: CredentialUseActor,
): Promise<Record<string, unknown> & { ipConflict: WriteTimeIpConflict | null }> {
  await validateAssetUpdate(id, existing, input);
  const { data, ipOverrideTouched, coordChanged } = await buildAssetUpdatePatch(id, existing, input, actor);
  const asset = await prisma.asset.update({ where: { id }, data: data as any });
  await applyAssetUpdateSideEffects(id, existing, asset, input, actor, { ipOverrideTouched, coordChanged });
  await auditAssetCredentialUse(credentialActor, "asset.update", existing as unknown as AssetCredentialSlots, asset as unknown as AssetCredentialSlots);
  // Business rule 40(i): when the edit MOVED the address, re-evaluate both
  // ends — the new address may now be a collision (raise it, tell the
  // operator), and the old one may have just stopped being one (close it,
  // rather than leaving the card up for ten minutes). Unchanged address ⇒
  // nothing to ask; the sweep owns the steady state.
  const ipMoved = (asset.ipAddress ?? null) !== (existing.ipAddress ?? null);
  const ipConflict = ipMoved
    ? await writeTimeIpConflictFor([existing.ipAddress, asset.ipAddress], asset.ipAddress)
    : null;
  return { ...asset, ipConflict };
}

/**
 * POST /assets/:id/monitor-override/reset: clear the operator pin and realign
 * `monitored` to the discovering integration's per-class Auto-Monitor default
 * (an HA standby firewall's default is always off), then write
 * monitor.override_reset. 404 for an unknown asset; 400 when there is no
 * integration or the asset type is not subject to Auto-Monitor. Lives here, not
 * in monitorOverrideService, because db.ts imports that module and it must not
 * import prisma back (CQ-B062 slice 2).
 */
export async function resetMonitorOverrideToIntegrationDefault(id: string, actor: string | undefined) {
  const existing = await prisma.asset.findUnique({
    where: { id },
    select: {
      id: true,
      hostname: true,
      ipAddress: true,
      assetType: true,
      monitored: true,
      monitorOverride: true,
      discoveredByIntegrationId: true,
      fortinetTopology: true,
    },
  });
  if (!existing) throw new AppError(404, "Asset not found");
  if (!existing.discoveredByIntegrationId) {
    throw new AppError(400, "Asset has no discovering integration — there is no Auto-Monitor default to reset to");
  }
  const integration = await prisma.integration.findUnique({
    where: { id: existing.discoveredByIntegrationId },
    select: { type: true, config: true },
  });
  let flag = getAddAsMonitoredFromConfig(
    integration?.type ?? null,
    (integration?.config as Record<string, unknown> | null) ?? null,
    existing.assetType,
  );
  if (flag === null) {
    throw new AppError(400, "Asset type is not subject to integration Auto-Monitor — nothing to reset");
  }
  // HA standby firewall: the effective integration default is always "not
  // monitored" (the cluster IP routes to the active member), regardless of
  // the firewall class flag — mirrors recomputeMonitorOverrideForAssets /
  // sweepMonitoredForIntegration and the discovery flip-off sweep.
  if (
    existing.assetType === "firewall" &&
    ((existing.fortinetTopology as Record<string, unknown> | null)?.haRole === "secondary")
  ) {
    flag = false;
  }
  // Realign to the flag and drop the pin. The DB-layer clamp still forces
  // monitored=false for decommissioned/disabled assets; that's fine — the
  // override is cleared either way and discovery won't monitor them.
  const asset = await prisma.asset.update({
    where: { id },
    data: { monitored: flag, monitorOverride: false },
  });
  logEvent({
    action: "monitor.override_reset",
    resourceType: "asset",
    resourceId: id,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor,
    message: `Reset monitor override on "${asset.hostname || asset.ipAddress || "unknown"}" to integration default (monitored=${flag})`,
  });
  return asset;
}

/**
 * DELETE /assets (bulk): refuse the whole call (409) when any id is
 * quarantined, release the managed-infra rows' reservations first, delete in
 * one statement, write asset.bulk_deleted, then drop `azure:` registry rows no
 * asset carries any more. Returns the deleted count. Moved out of
 * routes/assets/addresses.ts (CQ-B062 slice 2).
 */
export async function bulkDeleteAssets(ids: string[], actor: string | undefined): Promise<number> {
  // ONE read answers both questions about this id set — which rows are
  // quarantined (refuse the delete) and which are managed infra (release
  // their reservations first). They used to be two findMany calls over the
  // same ids.
  const targets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, status: true, assetType: true },
  });
  // Refuse to bulk-delete any quarantined asset — the operator must release
  // the quarantine first so the device-side targets get cleaned up.
  const quarantined = targets.filter((a) => a.status === "quarantined");
  if (quarantined.length > 0) {
    const names = quarantined.map((a) => a.hostname || a.ipAddress || a.id).slice(0, 5);
    const more = quarantined.length > 5 ? ` (+${quarantined.length - 5} more)` : "";
    throw new AppError(409, `Cannot delete quarantined asset(s): ${names.join(", ")}${more}. Release the quarantine first.`);
  }
  // Same as the single delete: release before the rows go away, and only for
  // the managed-infra types.
  const infraIds = targets
    .filter((a) => a.assetType === "switch" || a.assetType === "access_point")
    .map((a) => a.id);
  if (infraIds.length > 0) {
    await releaseInfraReservationsForAssets(infraIds, { reason: "asset deleted", actor });
  }
  // Rule 156: `deleteMany` runs no per-row delete hook, so the dns_resolved
  // reservations the single delete releases in src/db.ts are released here
  // first, while each asset's hostname and address can still be read.
  for (const chunk of chunkArray(targets.map((a) => a.id), 25)) {
    await Promise.all(chunk.map((id) => releaseDnsResolvedForAsset(id)));
  }
  const { count } = await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  // Rule 156: everything that named these assets without a foreign key.
  await afterAssetsDeleted(targets.map((a) => a.id));
  logEvent({ action: "asset.bulk_deleted", resourceType: "asset", actor, message: `Bulk deleted ${count} asset(s)` });
  // An `azure:` registry row no remaining asset carries goes with them.
  void syncAzureTagRegistry();
  return count;
}

/**
 * DELETE /assets/:id: 404 / 409 (quarantined), release a switch's or AP's
 * infra reservation BEFORE the row goes, delete, resync the `azure:` registry
 * when the asset carried one, write asset.deleted.
 */
export async function deleteAsset(id: string, actor: string | undefined): Promise<void> {
  const existing = await prisma.asset.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "Asset not found");
  if (existing.status === "quarantined") {
    throw new AppError(409, `Cannot delete quarantined asset "${existing.hostname || existing.ipAddress || id}". Release the quarantine first.`);
  }
  // Give the address back BEFORE the row goes away — the release resolves the
  // reservation from the asset's ipAddress, which is unreadable once deleted.
  if (existing.assetType === "switch" || existing.assetType === "access_point") {
    await releaseInfraReservationsForAssets([id], { reason: "asset deleted", actor });
  }
  await prisma.asset.delete({ where: { id } });
  // Rule 156: everything that named this asset without a foreign key.
  await afterAssetsDeleted([id]);
  if (existing.tags.some(isAzureTag)) void syncAzureTagRegistry();
  logEvent({ action: "asset.deleted", resourceType: "asset", resourceId: id, resourceName: existing.hostname || existing.ipAddress || undefined, actor, message: `Asset "${existing.hostname || existing.ipAddress || "unknown"}" deleted` });
}
