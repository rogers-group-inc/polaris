/**
 * Asset monitor-override semantics.
 *
 * `Asset.monitorOverride` is an EXPLICIT operator-intent bit: it records
 * that an operator deliberately set this asset's `monitored` state to
 * something other than its discovering integration's per-class
 * `addAsMonitored` default. Discovery sweeps `monitored` to match the flag
 * on every cycle EXCEPT when the override is set — the override is what
 * protects an explicit operator choice from being clobbered.
 *
 * The value is the (monitored XOR addAsMonitored) divergence, but it is
 * only ever WRITTEN at the moment of an operator action — the asset-write
 * paths (`PUT /assets/:id`, `POST /assets/bulk-monitor`, the status-pill
 * toggle) call `recomputeMonitorOverrideForAssets` for the touched ids, and
 * the Reset-to-integration-default action clears it. Nothing re-derives it
 * from incidental state: discovery, the create path, the decommission clamp,
 * and HA-standby seeding all leave it alone. This is the critical fix over
 * the original convergent model — a divergence that arose for an INCIDENTAL
 * reason (a decommission forcing `monitored=false`, an asset created while
 * the flag was off, a standby member) must NOT masquerade as an operator
 * override, or discovery would refuse to ever auto-manage it again. Because
 * incidental divergence leaves the bit false, those cases self-heal: the
 * next discovery sweep retakes the asset to the flag's value.
 *
 * Integration-flag flips (`addAsMonitored` ON↔OFF) sweep only
 * override-false assets and respect pins — see `sweepMonitoredForIntegration`
 * + the integration-save handler, which deliberately does NOT recompute
 * overrides.
 *
 * Replaces the legacy `monitoredOperatorSet` one-way sticky flag, and the
 * subsequent convergent model whose every-boot/every-save re-derivation
 * stamped incidental divergence as override.
 */
export type AddAsMonitoredAssetType =
  | "firewall"
  | "switch"
  | "access_point"
  | "workstation"
  | "server"
  | "hypervisor"
  | "kubernetes_cluster"
  | "container";

const FORTINET_TYPES = new Set(["fortimanager", "fortigate"]);
const WORKSTATION_SERVER_TYPES = new Set([
  "activedirectory",
  "entraid",
  "windowsserver",
  // Azure Arc reuses the directory class-block NAMES verbatim
  // (workstationMonitor / serverMonitor) for its workstation/server classes,
  // which is why THOSE need no entry in classBlockKeyForAssetType and no
  // raw-SQL CASE arm — the SQL keys on the block name, not the integration
  // type. Its kubernetes_cluster class is the exception: a genuinely new
  // asset type, so it does carry its own block key and CASE arm.
  "azurearc",
]);
const VCENTER_TYPES = new Set(["vcenter"]);
// Unraid / TrueNAS SCALE / Proxmox VE reuse vCenter's class-block NAMES
// (hostMonitor for the `hypervisor` host, vmMonitor for its `server` VMs) and
// add one of their own, containerMonitor, for the `container` type only they
// produce.
const WORKLOAD_TYPES = new Set(["unraid", "truenas", "proxmox"]);
// Azure Arc is the only integration that owns connected Kubernetes clusters.
const ARC_TYPES = new Set(["azurearc"]);

/**
 * Per-class addAsMonitored is read from the integration's config blob at
 * a stable JSON path. Each path corresponds to one Asset.assetType:
 *
 *   firewall      → fortigateMonitor.addAsMonitored      (fortimanager/fortigate)
 *   switch        → fortiswitchMonitor.addAsMonitored    (fortimanager/fortigate)
 *   access_point  → fortiapMonitor.addAsMonitored        (fortimanager/fortigate)
 *   workstation   → workstationMonitor.addAsMonitored    (activedirectory/entraid/windowsserver/azurearc)
 *   server        → serverMonitor.addAsMonitored         (activedirectory/entraid/windowsserver/azurearc)
 *   server        → vmMonitor.addAsMonitored             (vcenter — VMs are plain servers;
 *                                                         the class block kept its vm name)
 *   hypervisor    → hostMonitor.addAsMonitored           (vcenter)
 *   kubernetes_cluster → k8sMonitor.addAsMonitored       (azurearc)
 *   server        → vmMonitor.addAsMonitored             (unraid/truenas/proxmox VMs)
 *   hypervisor    → hostMonitor.addAsMonitored           (unraid/truenas hosts, proxmox nodes)
 *   container     → containerMonitor.addAsMonitored      (unraid/truenas/proxmox)
 *
 * Returns null when:
 *  - the asset type doesn't map to a per-class block
 *  - the integration type doesn't carry that block
 *  - the integration is null (manually-created asset)
 *
 * Null means "override doesn't apply to this asset"; callers should leave
 * monitorOverride at its existing value (typically false).
 */
export function getAddAsMonitoredFromConfig(
  integrationType: string | null | undefined,
  integrationConfig: Record<string, unknown> | null | undefined,
  assetType: string | null | undefined,
): boolean | null {
  if (!integrationType || !integrationConfig || !assetType) return null;

  let blockKey: string | null = null;
  switch (assetType) {
    case "firewall":
      if (!FORTINET_TYPES.has(integrationType)) return null;
      blockKey = "fortigateMonitor";
      break;
    case "switch":
      if (!FORTINET_TYPES.has(integrationType)) return null;
      blockKey = "fortiswitchMonitor";
      break;
    case "access_point":
      if (!FORTINET_TYPES.has(integrationType)) return null;
      blockKey = "fortiapMonitor";
      break;
    case "workstation":
      if (!WORKSTATION_SERVER_TYPES.has(integrationType)) return null;
      blockKey = "workstationMonitor";
      break;
    case "server":
      // vCenter VMs are typed "server" — same class key, different block.
      if (VCENTER_TYPES.has(integrationType) || WORKLOAD_TYPES.has(integrationType)) blockKey = "vmMonitor";
      else if (WORKSTATION_SERVER_TYPES.has(integrationType)) blockKey = "serverMonitor";
      else return null;
      break;
    case "hypervisor":
      if (!VCENTER_TYPES.has(integrationType) && !WORKLOAD_TYPES.has(integrationType)) return null;
      blockKey = "hostMonitor";
      break;
    case "kubernetes_cluster":
      if (!ARC_TYPES.has(integrationType)) return null;
      blockKey = "k8sMonitor";
      break;
    case "container":
      if (!WORKLOAD_TYPES.has(integrationType)) return null;
      blockKey = "containerMonitor";
      break;
    default:
      return null;
  }

  const block = (integrationConfig as Record<string, unknown>)[blockKey];
  if (!block || typeof block !== "object") return false;
  const flag = (block as Record<string, unknown>).addAsMonitored;
  return flag === true;
}

/**
 * Pure compute: does the operator's `monitored` choice diverge from the
 * integration's `addAsMonitored`? Pass `null` for `addAsMonitored` when
 * the asset has no per-class block (returns false — no override possible).
 */
export function computeMonitorOverride(
  monitored: boolean,
  addAsMonitored: boolean | null,
): boolean {
  if (addAsMonitored === null) return false;
  return monitored !== addAsMonitored;
}

/**
 * Convenience helper used by operator write paths (PUT /assets/:id,
 * POST /assets/bulk-monitor, status pill toggle) — pulls the asset's
 * type + integration config and returns the override value to stamp.
 *
 * Pass `{integrationConfig, integrationType}` already resolved (cheap if
 * the caller has them; otherwise the caller should load Integration and
 * pass the fields).
 */
export function resolveMonitorOverride(input: {
  monitored: boolean;
  assetType: string | null;
  integrationType: string | null;
  integrationConfig: Record<string, unknown> | null;
}): boolean {
  const flag = getAddAsMonitoredFromConfig(
    input.integrationType,
    input.integrationConfig,
    input.assetType,
  );
  return computeMonitorOverride(input.monitored, flag);
}

/**
 * The set of asset types that participate in the auto-monitor-asset sweep.
 * Anything outside this set leaves monitorOverride at its existing value
 * and is invisible to the per-class addAsMonitored flag.
 */
export const AUTO_MONITOR_ASSET_TYPES: ReadonlySet<AddAsMonitoredAssetType> =
  new Set(["firewall", "switch", "access_point", "workstation", "server", "hypervisor", "kubernetes_cluster", "container"]);

/**
 * Maps Asset.assetType to its per-class config block key, when one applies.
 * `server` is integration-type-dependent (vCenter VMs are servers whose class
 * block kept the vmMonitor name) — pass the discovering integration's type;
 * null/unknown types resolve `server` to the directory block.
 */
export function classBlockKeyForAssetType(
  assetType: string | null | undefined,
  integrationType?: string | null,
): string | null {
  switch (assetType) {
    case "firewall":     return "fortigateMonitor";
    case "switch":       return "fortiswitchMonitor";
    case "access_point": return "fortiapMonitor";
    case "workstation":  return "workstationMonitor";
    case "server":       return integrationType && (VCENTER_TYPES.has(integrationType) || WORKLOAD_TYPES.has(integrationType)) ? "vmMonitor" : "serverMonitor";
    case "hypervisor":   return "hostMonitor";
    case "kubernetes_cluster": return "k8sMonitor";
    case "container":    return "containerMonitor";
    default:             return null;
  }
}

/**
 * Snapshot helper for the integration-save sweep + preflight endpoint.
 * Given an integration's config, returns the per-class addAsMonitored
 * flag for each of the five participating asset types (null when the
 * integration's type doesn't carry that block).
 */
export function snapshotAddAsMonitoredByAssetType(
  integrationType: string | null,
  integrationConfig: Record<string, unknown> | null,
): Record<AddAsMonitoredAssetType, boolean | null> {
  return {
    firewall:     getAddAsMonitoredFromConfig(integrationType, integrationConfig, "firewall"),
    switch:       getAddAsMonitoredFromConfig(integrationType, integrationConfig, "switch"),
    access_point: getAddAsMonitoredFromConfig(integrationType, integrationConfig, "access_point"),
    workstation:  getAddAsMonitoredFromConfig(integrationType, integrationConfig, "workstation"),
    server:       getAddAsMonitoredFromConfig(integrationType, integrationConfig, "server"),
    hypervisor:   getAddAsMonitoredFromConfig(integrationType, integrationConfig, "hypervisor"),
    kubernetes_cluster: getAddAsMonitoredFromConfig(integrationType, integrationConfig, "kubernetes_cluster"),
    container:    getAddAsMonitoredFromConfig(integrationType, integrationConfig, "container"),
  };
}

/**
 * Recompute `Asset.monitorOverride` for one or more asset ids via a single
 * SQL UPDATE — the operator-write-path post-hook. Reads each asset's
 * current `monitored` and `assetType` and the matching integration's
 * per-class `addAsMonitored` from `Integration.config`, sets override =
 * (monitored XOR addAsMonitored). Used by `PUT /assets/:id`,
 * `POST /assets/bulk-monitor`, and the status-pill toggle so the override
 * flag stays current after every operator action without per-row JS.
 *
 * Assets with no `discoveredByIntegrationId`, or whose assetType doesn't
 * map to a per-class block, are excluded by the WHERE clause and keep
 * their default (false). So are a Generic API integration's assets: it
 * carries no class blocks and holds no monitoring intent, so there is no
 * default to diverge FROM — without the exclusion every monitored generic
 * asset would read as an operator override. Same JSON-path logic as the cutover migration —
 * keep these two in sync.
 *
 * HA-standby exception (firewall class only): a standby member's effective
 * integration default is ALWAYS "not monitored" — it isn't probe-reachable
 * (its IP is nulled; the cluster IP routes to the active member) — so
 * divergence is measured against `false`, not the class flag. This is what
 * makes an operator's deliberate monitored=true on a standby compute
 * override=true (protecting it from the discovery flip-off sweep in
 * buildFortigateMonitorStamp) even while `fortigateMonitor.addAsMonitored`
 * is on for the rest of the fleet.
 */
export async function recomputeMonitorOverrideForAssets(
  prismaClient: { $executeRaw: (template: TemplateStringsArray, ...args: unknown[]) => Promise<number> },
  assetIds: string[],
): Promise<void> {
  if (assetIds.length === 0) return;
  // Tagged-template raw SQL: Prisma parameterizes the assetIds array safely.
  await prismaClient.$executeRaw`
    UPDATE "assets" a
    SET "monitorOverride" = (
      a."monitored" IS DISTINCT FROM COALESCE(
        CASE a."assetType"
          WHEN 'firewall'     THEN (CASE WHEN a."fortinetTopology" ->> 'haRole' = 'secondary'
                                         THEN false
                                         ELSE (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean END)
          WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
          WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
          WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
          WHEN 'server'       THEN (CASE WHEN i."type" IN ('vcenter', 'unraid', 'truenas', 'proxmox')
                                         THEN (i."config" #>> '{vmMonitor,addAsMonitored}')::boolean
                                         ELSE (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean END)
          WHEN 'hypervisor'   THEN (i."config" #>> '{hostMonitor,addAsMonitored}')::boolean
          WHEN 'kubernetes_cluster' THEN (i."config" #>> '{k8sMonitor,addAsMonitored}')::boolean
          WHEN 'container'    THEN (i."config" #>> '{containerMonitor,addAsMonitored}')::boolean
          ELSE NULL
        END,
        false
      )
    )
    FROM "integrations" i
    WHERE a."discoveredByIntegrationId" = i."id"
      AND a."id" = ANY(${assetIds}::text[])
      AND i."type" <> 'genericapi'
      AND a."assetType" IN ('firewall', 'switch', 'access_point', 'workstation', 'server', 'hypervisor', 'kubernetes_cluster', 'container')
  `;
}

/**
 * Integration-save sweep — runs when an operator saves an integration whose
 * per-class `addAsMonitored` flag changed. Walks every Asset whose
 * `discoveredByIntegrationId` points at this integration AND whose
 * `monitorOverride=false`, and writes `monitored = <new addAsMonitored>` per
 * the asset's class. Override-true assets are left alone — operator pins win,
 * and a flag flip never re-derives or clears them (operators re-align a
 * pinned asset per-asset via the Reset-to-integration-default action).
 *
 * HA-standby exception mirrors recomputeMonitorOverrideForAssets: a standby
 * firewall's effective default is `false` regardless of the class flag —
 * pre-fix, flipping `fortigateMonitor.addAsMonitored` ON re-enabled
 * monitoring on every override-false standby, which is exactly the
 * guaranteed-failure polling waste the standby design exists to avoid.
 *
 * Returns the count of rows whose `monitored` value actually changed (used
 * by the route handler to emit an Event with the touched-asset count).
 */
export async function sweepMonitoredForIntegration(
  prismaClient: { $executeRaw: (template: TemplateStringsArray, ...args: unknown[]) => Promise<number> },
  integrationId: string,
): Promise<number> {
  return await prismaClient.$executeRaw`
    UPDATE "assets" a
    SET "monitored" = COALESCE(
      CASE a."assetType"
        WHEN 'firewall'     THEN (CASE WHEN a."fortinetTopology" ->> 'haRole' = 'secondary'
                                       THEN false
                                       ELSE (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean END)
        WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
        WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
        WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
        WHEN 'server'       THEN (CASE WHEN i."type" IN ('vcenter', 'unraid', 'truenas', 'proxmox')
                                       THEN (i."config" #>> '{vmMonitor,addAsMonitored}')::boolean
                                       ELSE (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean END)
        WHEN 'hypervisor'   THEN (i."config" #>> '{hostMonitor,addAsMonitored}')::boolean
        WHEN 'kubernetes_cluster' THEN (i."config" #>> '{k8sMonitor,addAsMonitored}')::boolean
          WHEN 'container'    THEN (i."config" #>> '{containerMonitor,addAsMonitored}')::boolean
      END,
      false
    )
    FROM "integrations" i
    WHERE a."discoveredByIntegrationId" = i."id"
      AND i."id" = ${integrationId}::text
      AND i."type" <> 'genericapi'
      AND a."monitorOverride" = false
      AND a."assetType" IN ('firewall', 'switch', 'access_point', 'workstation', 'server', 'hypervisor', 'kubernetes_cluster', 'container')
      AND a."monitored" IS DISTINCT FROM COALESCE(
        CASE a."assetType"
          WHEN 'firewall'     THEN (CASE WHEN a."fortinetTopology" ->> 'haRole' = 'secondary'
                                         THEN false
                                         ELSE (i."config" #>> '{fortigateMonitor,addAsMonitored}')::boolean END)
          WHEN 'switch'       THEN (i."config" #>> '{fortiswitchMonitor,addAsMonitored}')::boolean
          WHEN 'access_point' THEN (i."config" #>> '{fortiapMonitor,addAsMonitored}')::boolean
          WHEN 'workstation'  THEN (i."config" #>> '{workstationMonitor,addAsMonitored}')::boolean
          WHEN 'server'       THEN (CASE WHEN i."type" IN ('vcenter', 'unraid', 'truenas', 'proxmox')
                                         THEN (i."config" #>> '{vmMonitor,addAsMonitored}')::boolean
                                         ELSE (i."config" #>> '{serverMonitor,addAsMonitored}')::boolean END)
          WHEN 'hypervisor'   THEN (i."config" #>> '{hostMonitor,addAsMonitored}')::boolean
          WHEN 'kubernetes_cluster' THEN (i."config" #>> '{k8sMonitor,addAsMonitored}')::boolean
          WHEN 'container'    THEN (i."config" #>> '{containerMonitor,addAsMonitored}')::boolean
        END,
        false
      )
  `;
}

/**
/**
 * Discovery-side sweep helper. Given the integration's resolved per-class
 * `addAsMonitored` and the existing asset's `monitored` + `monitorOverride`,
 * returns the partial update data to merge into the asset write — either
 * `{ monitored: true }`, `{ monitored: false }`, or `{}` (no change).
 *
 *  - `addAsMonitored === null` → asset type isn't subject to the sweep; no-op
 *  - `existing.monitorOverride === true` → operator wins; no-op
 *  - otherwise enforce `monitored = addAsMonitored`
 *
 * Caller is responsible for handling ineligible assets (e.g. HA standby
 * FortiGate members, whose effective default is always "not monitored" —
 * buildFortigateMonitorStamp in integrations.ts sweeps those to
 * monitored=false separately instead of calling this).
 */
export function buildMonitoredSweep(
  addAsMonitored: boolean | null,
  existing: { monitored?: boolean | null; monitorOverride?: boolean | null },
): { monitored?: boolean } {
  if (addAsMonitored === null) return {};
  if (existing.monitorOverride === true) return {};
  if (addAsMonitored && existing.monitored !== true) return { monitored: true };
  if (!addAsMonitored && existing.monitored === true) return { monitored: false };
  return {};
}
