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
 * Covered: the Fortinet family (FortiGate directly, FortiSwitch/FortiAP through
 * their controller), the directory types (Entra/Intune by `deviceId`, AD by
 * `objectGUID`), vCenter (VM/host by moref, read off `Asset.virtualization` —
 * the source row's externalId is the instanceUuid, not the moref) and Azure Arc
 * (by ARM resource id). Anything left — an agent-only, sysDescr-only or manual
 * asset — is reported with a REASON rather than silently omitted, so the UI can
 * say why a device can't be refreshed instead of hiding the control.
 */

import { prisma } from "../../db.js";
import type { DiscoveryScope } from "./discoveryScope.js";
import {
  readControllerStamp,
  parentAssetWhereOr,
  buildInfraParentIndex,
  resolveInfraParentAsset,
  readFirewallDeviceName,
} from "../../utils/fortinetParentKey.js";

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
  filterAsset: {
    hostname: string | null;
    ipAddress: string | null;
    learnedLocation: string | null;
    assetType: string;
    /** The AD source’s `observed.ouPath`. `assetMatchesIntegrationFilter`
     *  prefers it over `learnedLocation` when matching ouInclude/ouExclude. */
    adOuPath?: string | null;
  };
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

/**
 * Kinds recognised but not targetable. Empty as of Phase 3 — every discovery
 * source can now be scoped — but kept as the seam a new source kind lands in,
 * because "we know what this is and here is why it can't refresh" is a far
 * better answer than the generic no-source message.
 */
const NOT_YET_SCOPED: Record<string, string> = {
  // `arc-k8s` is a connected Kubernetes CLUSTER, not a machine: it has no
  // per-resource refresh of its own — it is created by the cluster query a
  // full Arc run performs, which a scoped run deliberately skips.
  "arc-k8s": "Azure Arc (connected Kubernetes cluster)",
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
      virtualization: true,
      discoveredByIntegration: { select: { id: true, name: true, type: true, config: true, enabled: true } },
      sources: {
        select: {
          sourceKind: true,
          externalId: true,
          observed: true,
          integration: { select: { id: true, name: true, type: true, config: true, enabled: true } },
        },
      },
    },
  });
  if (!asset) return { ok: false, reason: "Asset not found", notFound: true };

  const topo = (asset.fortinetTopology as Record<string, unknown> | null) || null;
  const role = topo && typeof topo.role === "string" ? topo.role : null;

  if (role === "fortigate" && asset.assetType === "firewall") return resolveForGate(asset);
  if (role === "fortiswitch" || role === "fortiap") return resolveViaController(asset, topo, role);

  // Directory sources. Tried in trust order (Intune enrichment rides the same
  // Entra run, so an intune row resolves to the entra-device scope) and only
  // when the row still names an integration of the matching type — a source
  // left behind by a deleted integration must read as unrefreshable, not as a
  // run against whatever integration happens to be first.
  const directory = resolveFromDirectorySources(asset);
  if (directory) return directory;

  return { ok: false, reason: unsupportedReason(asset.sources.map((s) => s.sourceKind)) };
}

/** One AssetSource row as the resolver selects it. */
type SourceRow = {
  sourceKind: string;
  externalId: string;
  observed: unknown;
  integration: ScopeIntegration | null;
};

/**
 * Entra / Intune / AD: the identity the collector needs is already the source
 * row's `externalId` (Entra `deviceId`, AD `objectGUID`) — which is exactly why
 * these two could be scoped without inventing a new identity concept.
 *
 * Returns null when no directory source applies, so the caller falls through to
 * the "why not" message rather than this function guessing one.
 */
function resolveFromDirectorySources(asset: {
  hostname: string | null;
  ipAddress: string | null;
  learnedLocation: string | null;
  assetType: string;
  virtualization: unknown;
  sources: SourceRow[];
}): AssetScopeResolution | null {
  const pick = (kind: string, type: string) =>
    asset.sources.find((r) => r.sourceKind === kind && r.integration?.type === type && r.externalId);

  const entra = pick("entra", "entraid") || pick("intune", "entraid");
  if (entra?.integration) {
    if (!entra.integration.enabled) {
      return { ok: false, reason: `Integration "${entra.integration.name}" is disabled` };
    }
    return {
      ok: true,
      resolved: {
        integration: entra.integration,
        scope: { kind: "entra-device", deviceId: entra.externalId },
        deviceName: asset.hostname,
        filterAsset: baseFilterAsset(asset),
        viaController: false,
      },
    };
  }

  // vCenter: the moref lives on `Asset.virtualization`, NOT on the source row —
  // the vcenter-vm externalId is the instanceUuid (with an
  // `<integrationId>:<moref>` fallback), so parsing it would be wrong for every
  // VM that reports a UUID.
  const vc = pick("vcenter-vm", "vcenter") || pick("vcenter-host", "vcenter");
  if (vc?.integration) {
    if (!vc.integration.enabled) {
      return { ok: false, reason: `Integration "${vc.integration.name}" is disabled` };
    }
    const v = (asset.virtualization as Record<string, unknown> | null) || {};
    const moref = v.role === "vm" ? v.vmMoref : v.role === "host" ? v.hostMoref : null;
    if (typeof moref !== "string" || !moref) {
      return { ok: false, reason: "This asset has no vCenter managed-object reference recorded yet — it refreshes on the next full vCenter discovery" };
    }
    return {
      ok: true,
      resolved: {
        integration: vc.integration,
        scope: v.role === "vm" ? { kind: "vcenter-vm", moref } : { kind: "vcenter-host", moref },
        deviceName: asset.hostname,
        filterAsset: baseFilterAsset(asset),
        viaController: false,
      },
    };
  }

  const arc = pick("arc", "azurearc");
  if (arc?.integration) {
    if (!arc.integration.enabled) {
      return { ok: false, reason: `Integration "${arc.integration.name}" is disabled` };
    }
    return {
      ok: true,
      resolved: {
        integration: arc.integration,
        // The arc source's externalId IS the ARM resource id.
        scope: { kind: "arc-machine", resourceId: arc.externalId },
        deviceName: asset.hostname,
        filterAsset: baseFilterAsset(asset),
        viaController: false,
      },
    };
  }

  const ad = pick("ad", "activedirectory");
  if (ad?.integration) {
    if (!ad.integration.enabled) {
      return { ok: false, reason: `Integration "${ad.integration.name}" is disabled` };
    }
    const observed = (ad.observed as Record<string, unknown> | null) || {};
    const ouPath = typeof observed.ouPath === "string" ? observed.ouPath : null;
    return {
      ok: true,
      resolved: {
        integration: ad.integration,
        scope: { kind: "ad-object", objectGuid: ad.externalId },
        deviceName: asset.hostname,
        // ouPath is what the AD include/exclude patterns match on; without it
        // the filter falls back to learnedLocation and can read as "no OU".
        filterAsset: { ...baseFilterAsset(asset), adOuPath: ouPath },
        viaController: false,
      },
    };
  }

  return null;
}

function baseFilterAsset(asset: {
  hostname: string | null; ipAddress: string | null; learnedLocation: string | null; assetType: string;
}) {
  return {
    hostname: asset.hostname,
    ipAddress: asset.ipAddress,
    learnedLocation: asset.learnedLocation,
    assetType: asset.assetType,
  };
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
