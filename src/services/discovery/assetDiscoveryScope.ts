/**
 * src/services/discovery/assetDiscoveryScope.ts
 *
 * "Which discovery would refresh THIS asset, and how do I narrow it to just
 * this one device?"
 *
 * Backs the asset details slide-in's **Discover Now** button
 * (`POST /assets/:id/rediscover`). The route stays thin: it calls
 * `resolveDiscoveryScopeForAsset`, applies the integration filter re-check and
 * the busy check, then hands the resolved scope to `triggerDiscovery`.
 *
 * The resolution answers two separate questions, and conflating them is the bug
 * this module exists to prevent:
 *
 *   1. WHICH INTEGRATION runs. For a FortiGate that is the gate's own
 *      `discoveredByIntegration`. For a FortiSwitch/FortiAP it is the
 *      integration that owns its CONTROLLER GATE — a switch is never discovered
 *      on its own, only as a by-product of its controller's pass — and the
 *      controller is resolved through `utils/fortinetParentKey.ts`, never by
 *      matching `controllerFortigate` against `Asset.hostname` (see that
 *      module's header: FMG's device name is under no obligation to equal the
 *      gate's configured hostname, and the mismatch fails SILENTLY).
 *   2. WHAT THE RUN IS NARROWED TO — the `DiscoveryScope`, or null when the
 *      integration is inherently a single device (a standalone FortiGate) and a
 *      plain full run is already the exact equivalent.
 *
 * Everything here is one asset query plus at most one parent lookup: it runs on
 * the route, not in a fleet loop, but the slide-in opens constantly, so the
 * selects stay tight.
 *
 * Phase 1 covers the Fortinet family, which rides discovery machinery that
 * already exists (`scopeDeviceName` + the `finalize-scoped` sweep mode). The
 * directory / hypervisor / cloud source kinds are recognised and reported as
 * not-yet-supported rather than silently omitted, so the UI can say WHY a
 * device can't be refreshed instead of hiding the control.
 */

import { prisma } from "../../db.js";
import {
  readControllerStamp,
  parentAssetWhereOr,
  buildInfraParentIndex,
  resolveInfraParentAsset,
  readFirewallDeviceName,
} from "../../utils/fortinetParentKey.js";

/**
 * How a discovery run is narrowed to one device.
 *
 * Only `fmg-device` exists today — it is what `triggerDiscovery`'s
 * `scopeDeviceName` has always carried. The union shape is deliberate: the
 * directory/vCenter/Arc scopes land here as their collectors gain a target
 * parameter and their sync layers gain a sweep-disabling mode, and a union
 * makes each addition a compile-time decision at every consumer rather than a
 * silently-ignored extra string.
 */
export type DiscoveryScope = { kind: "fmg-device"; deviceName: string };

/** The integration fields every caller of a resolved scope needs. */
export interface ScopeIntegration {
  id: string;
  name: string;
  type: string;
  config: unknown;
  enabled: boolean;
}

export interface ResolvedAssetScope {
  integration: ScopeIntegration;
  /**
   * The narrowing, or null when the integration IS a single device (standalone
   * FortiGate) and a full run is already scoped by construction.
   */
  scope: DiscoveryScope | null;
  /**
   * Human label for the device the run targets — the gate's name, which for a
   * switch/AP is its CONTROLLER, not the asset the operator clicked. Used in
   * the Event message and the 202 response so "Discover Now on switch X started
   * a run against gate Y" is legible rather than surprising.
   */
  deviceName: string | null;
  /**
   * The asset row the integration include/exclude filter must be re-checked
   * against. For a switch/AP that is the CONTROLLER gate: the filters name
   * gates, and a switch's own hostname would match nothing.
   */
  filterAsset: { hostname: string | null; ipAddress: string | null; learnedLocation: string | null; assetType: string };
  /** True when the clicked asset is not itself the targeted device. */
  viaController: boolean;
}

export type AssetScopeResolution =
  | { ok: true; resolved: ResolvedAssetScope }
  /** `notFound` separates the one 404 from every 400 without the caller
   *  string-matching the human reason. */
  | { ok: false; reason: string; notFound?: true };

/** Source kinds that describe a device but name no re-runnable discovery. */
const UNREFRESHABLE_REASON: Record<string, string> = {
  "polaris-agent": "This asset is reported by the Polaris Agent, which pushes on its own schedule — there is no discovery to re-run",
  "snmp-sysdescr": "This asset's identity comes from its SNMP sysDescr, which refreshes on the next monitor pass rather than through discovery",
  manual: "This asset was created manually, so no discovery source owns it",
};

/** Directory / hypervisor / cloud kinds — recognised, not yet targetable. */
const NOT_YET_SCOPED: Record<string, string> = {
  entra: "Entra ID",
  intune: "Intune",
  ad: "Active Directory",
  "vcenter-vm": "vCenter",
  "vcenter-host": "vCenter",
  arc: "Azure Arc",
  "arc-k8s": "Azure Arc",
};

/**
 * Resolve the discovery that would refresh one asset.
 *
 * Returns `{ ok: false, reason }` for every legitimate "can't refresh this"
 * case — an unowned asset, a disabled integration, an unresolvable controller.
 * The caller turns that into a 400 with the reason as the message, so the
 * operator is told WHY rather than left with a dead button.
 */
export async function resolveDiscoveryScopeForAsset(assetId: string): Promise<AssetScopeResolution> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      hostname: true,
      ipAddress: true,
      learnedLocation: true,
      assetType: true,
      fortinetTopology: true,
      discoveredByIntegration: { select: { id: true, name: true, type: true, config: true, enabled: true } },
      sources: { select: { sourceKind: true } },
    },
  });
  if (!asset) return { ok: false, reason: "Asset not found", notFound: true };

  const topo = (asset.fortinetTopology as Record<string, unknown> | null) || null;
  const role = topo && typeof topo.role === "string" ? topo.role : null;

  if (role === "fortigate" && asset.assetType === "firewall") return resolveForGate(asset);
  if (role === "fortiswitch" || role === "fortiap") return resolveViaController(asset, topo, role);

  return { ok: false, reason: unsupportedReason(asset.sources.map((s) => s.sourceKind)) };
}

type AssetRow = {
  hostname: string | null;
  ipAddress: string | null;
  learnedLocation: string | null;
  assetType: string;
  fortinetTopology: unknown;
  discoveredByIntegration: ScopeIntegration | null;
};

/** A FortiGate refreshes through its own integration. */
function resolveForGate(asset: AssetRow): AssetScopeResolution {
  const integration = asset.discoveredByIntegration;
  if (!integration || (integration.type !== "fortimanager" && integration.type !== "fortigate")) {
    return { ok: false, reason: "This FortiGate is not owned by a FortiManager or FortiGate integration" };
  }
  if (!integration.enabled) return { ok: false, reason: `Integration "${integration.name}" is disabled` };

  // The FMG/dvmdb name is the string the scoped roster filter matches on;
  // hostname is the legacy-row fallback for gates discovered before the
  // deviceName stamp existed.
  const deviceName = readFirewallDeviceName(asset.fortinetTopology) || asset.hostname;
  if (integration.type === "fortimanager" && !deviceName) {
    return { ok: false, reason: "Asset has no resolvable FortiGate device name" };
  }

  return {
    ok: true,
    resolved: {
      integration,
      // A standalone FortiGate integration IS the one gate — a full run is the
      // exact equivalent of a scoped one, and `scopeDeviceName` is rejected for
      // non-FMG types anyway.
      scope: integration.type === "fortimanager" && deviceName ? { kind: "fmg-device", deviceName } : null,
      deviceName: integration.type === "fortimanager" ? deviceName : null,
      filterAsset: {
        hostname: asset.hostname,
        ipAddress: asset.ipAddress,
        learnedLocation: asset.learnedLocation,
        assetType: asset.assetType,
      },
      viaController: false,
    },
  };
}

/**
 * A FortiSwitch / FortiAP refreshes as a by-product of its CONTROLLER gate's
 * pass, so the scope targets the gate. This is pure reuse of shipped machinery:
 * `finalize-scoped` already runs the per-controller switch/AP decommission, so
 * a scoped run against the controller is exactly the per-gate ghost-device
 * cleanup a stale switch needs.
 */
async function resolveViaController(
  asset: AssetRow,
  topo: Record<string, unknown> | null,
  role: string,
): Promise<AssetScopeResolution> {
  const label = role === "fortiap" ? "FortiAP" : "FortiSwitch";
  const stamp = readControllerStamp(topo);
  const where = parentAssetWhereOr(stamp);
  if (where.length === 0) {
    return { ok: false, reason: `This ${label} records no controller FortiGate, so there is no discovery to scope` };
  }

  // Over-fetch every candidate the stamp could name, then let
  // resolveInfraParentAsset apply the documented precedence — findFirst with an
  // OR gives no control over which match comes back.
  const candidates = await prisma.asset.findMany({
    where: { OR: where, assetType: "firewall" },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      assetType: true,
      ipAddress: true,
      learnedLocation: true,
      fortinetTopology: true,
      discoveredByIntegration: { select: { id: true, name: true, type: true, config: true, enabled: true } },
    },
  });
  const parent = resolveInfraParentAsset(buildInfraParentIndex(candidates), stamp, "firewall");
  if (!parent) {
    return {
      ok: false,
      reason: `This ${label}'s controller FortiGate is not in Polaris yet — discover it first, and its ${label}s refresh with it`,
    };
  }

  const parentRow = candidates.find((c) => c.id === parent.id);
  if (!parentRow) return { ok: false, reason: `Could not load this ${label}'s controller FortiGate` };

  const gate = await resolveForGate(parentRow as AssetRow);
  if (!gate.ok) return gate;
  return { ok: true, resolved: { ...gate.resolved, viaController: true } };
}

/** The most useful "why not" we can offer, given the asset's source rows. */
function unsupportedReason(sourceKinds: string[]): string {
  for (const kind of sourceKinds) {
    const product = NOT_YET_SCOPED[kind];
    if (product) {
      return `Per-asset discovery is not available for ${product}-discovered assets yet — run a discovery from the Integrations page to refresh it`;
    }
  }
  for (const kind of sourceKinds) {
    const reason = UNREFRESHABLE_REASON[kind];
    if (reason) return reason;
  }
  return "No discovery source owns this asset, so there is nothing to re-run";
}
