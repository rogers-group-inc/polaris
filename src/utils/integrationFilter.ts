/**
 * Decide whether an asset would still be in scope for the integration that
 * originally discovered it. Used by the manual /assets/:id/probe-now refresh
 * to short-circuit when the operator has since narrowed the integration's
 * deviceInclude / deviceExclude — a refresh shouldn't pull data from a
 * device the next discovery sweep would skip.
 *
 * Per-integration matching:
 *   - fortimanager / fortigate: deviceInclude/deviceExclude vs hostname
 *   - entraid:                   deviceInclude/deviceExclude vs hostname (Entra displayName lands in Asset.hostname)
 *   - azurearc:                  deviceInclude/deviceExclude vs hostname. Its
 *     resourceGroup/tag filters are deliberately not re-evaluated here — see
 *     the note at that branch.
 *   - activedirectory:           ouInclude/ouExclude vs the AD AssetSource's
 *     observed.ouPath when supplied; falls back to Asset.learnedLocation for
 *     callers that haven't been threaded through to the source row yet.
 *     Source-side data is preferred because the merged learnedLocation field
 *     can drift between integrations (e.g. a FortiGate-discovered location
 *     overwriting AD's OU path), but the AD source's own observation is
 *     authoritative for AD's own filter.
 *   - vcenter:                   vmInclude/vmExclude vs the vCenter VM name
 *     (the vcenter-vm source's observed.name when supplied via vmName; falls
 *     back to Asset.hostname). ESXi hosts are never name-filtered.
 *   - unraid / truenas:          vmInclude/vmExclude for VMs (`server`),
 *     containerInclude/containerExclude for containers / Apps, both vs the
 *     platform's own name (vmName carries the workload source's observed.name).
 *     The host is never name-filtered.
 *
 * Returns { included: true } for any other integration type (we don't have
 * authoritative match data for it) so we never block a refresh on a hunch.
 */

interface IntegrationLite {
  type: string;
  config: unknown;
}

interface AssetLite {
  hostname: string | null;
  learnedLocation: string | null;
  // Optional AD source observed.ouPath. When supplied, takes priority over
  // learnedLocation in the activedirectory filter — see header comment for
  // rationale.
  adOuPath?: string | null;
  // Optional vCenter VM name (the vcenter-vm source's observed.name). The
  // vmInclude/vmExclude filters match the vCenter-side VM name, which can
  // differ from the merged Asset.hostname (guest hostname wins projection).
  vmName?: string | null;
  // Optional Asset.assetType — lets the vcenter branch skip name-filtering
  // ESXi hosts (vmInclude/vmExclude apply to VMs only).
  assetType?: string | null;
}

/**
 * Case-insensitive glob-lite matcher: bare `*` matches everything,
 * `*x*` contains, `*x` ends-with, `x*` starts-with, else exact. THE
 * canonical copy — the discovery services (FMG/FortiGate/AD/Entra/vCenter),
 * monitoringService's interface filter, and this module's own filters all
 * share it, and discovery filters MUST agree with the post-hoc asset
 * filter here.
 */
export function matchesWildcard(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return v.includes(p.slice(1, -1));
  if (p.startsWith("*")) return v.endsWith(p.slice(1));
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return v === p;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export interface FilterResult {
  included: boolean;
  reason?: string;
}

export function assetMatchesIntegrationFilter(
  asset: AssetLite,
  integration: IntegrationLite,
): FilterResult {
  const cfg = (integration.config && typeof integration.config === "object")
    ? integration.config as Record<string, unknown>
    : {};
  const type = integration.type;

  // FMG / FortiGate / Entra / Azure Arc: filter on hostname.
  //
  // Arc note: its resource-group and tag filters are NOT re-evaluated here.
  // Those match against the Arc source's observed blob, which this helper
  // isn't threaded with, and the failure mode of skipping them is benign
  // (a probe-now refresh proceeds on an asset the next sweep might drop),
  // whereas guessing would block legitimate refreshes.
  if (type === "fortimanager" || type === "fortigate" || type === "entraid" || type === "azurearc") {
    const include = asStringArray(cfg.deviceInclude);
    const exclude = asStringArray(cfg.deviceExclude);
    const candidate = asset.hostname || "";
    if (!candidate) return { included: true }; // can't evaluate without a hostname

    if (include.length > 0) {
      const ok = include.some((p) => matchesWildcard(p, candidate));
      if (!ok) return { included: false, reason: `Excluded by ${type} integration deviceInclude (${candidate} matches no pattern)` };
    } else if (exclude.length > 0) {
      const blocked = exclude.find((p) => matchesWildcard(p, candidate));
      if (blocked) return { included: false, reason: `Excluded by ${type} integration deviceExclude pattern "${blocked}"` };
    }
    return { included: true };
  }

  // Active Directory: filter on the OU path. learnedLocation carries the
  // OU path the AD sync wrote (computed from distinguishedName); the AD
  // discovery filter matches against the *full* DN, so we do the same here
  // by reconstructing the closest approximation from CN + learnedLocation.
  if (type === "activedirectory") {
    const include = asStringArray(cfg.ouInclude);
    const exclude = asStringArray(cfg.ouExclude);
    // Prefer the AD source's own observed.ouPath; fall back to the merged
    // learnedLocation when the caller hasn't loaded sources.
    const ouPath = (asset.adOuPath || asset.learnedLocation || "").trim();
    if (!ouPath) return { included: true };
    const candidates = [ouPath, asset.hostname ? `CN=${asset.hostname},${ouPath}` : ""].filter(Boolean);

    if (include.length > 0) {
      const ok = include.some((p) => candidates.some((c) => matchesWildcard(p, c)));
      if (!ok) return { included: false, reason: `Excluded by activedirectory integration ouInclude (no pattern matches OU "${ouPath}")` };
    } else if (exclude.length > 0) {
      const blocked = exclude.find((p) => candidates.some((c) => matchesWildcard(p, c)));
      if (blocked) return { included: false, reason: `Excluded by activedirectory integration ouExclude pattern "${blocked}"` };
    }
    return { included: true };
  }

  // vCenter: filter on the VM name (vmInclude wins over vmExclude, same
  // semantics as the discovery-side filterVms). Hosts are always in scope.
  if (type === "vcenter") {
    if (asset.assetType === "hypervisor") return { included: true };
    const include = asStringArray(cfg.vmInclude);
    const exclude = asStringArray(cfg.vmExclude);
    const candidate = (asset.vmName || asset.hostname || "").trim();
    if (!candidate) return { included: true };

    if (include.length > 0) {
      const ok = include.some((p) => matchesWildcard(p, candidate));
      if (!ok) return { included: false, reason: `Excluded by vcenter integration vmInclude (${candidate} matches no pattern)` };
    } else if (exclude.length > 0) {
      const blocked = exclude.find((p) => matchesWildcard(p, candidate));
      if (blocked) return { included: false, reason: `Excluded by vcenter integration vmExclude pattern "${blocked}"` };
    }
    return { included: true };
  }

  // Unraid / TrueNAS: the vCenter rule, split by class — VMs against the VM
  // pair, containers / Apps against the container pair. Same include-wins
  // semantics as the discovery-side filter (services/workloadSync.ts).
  if (type === "unraid" || type === "truenas") {
    if (asset.assetType === "hypervisor") return { included: true };
    const isContainer = asset.assetType === "container";
    const incKey = isContainer ? "containerInclude" : "vmInclude";
    const excKey = isContainer ? "containerExclude" : "vmExclude";
    const include = asStringArray(cfg[incKey]);
    const exclude = asStringArray(cfg[excKey]);
    const candidate = (asset.vmName || asset.hostname || "").trim();
    if (!candidate) return { included: true };

    if (include.length > 0) {
      const ok = include.some((p) => matchesWildcard(p, candidate));
      if (!ok) return { included: false, reason: `Excluded by ${type} integration ${incKey} (${candidate} matches no pattern)` };
    } else if (exclude.length > 0) {
      const blocked = exclude.find((p) => matchesWildcard(p, candidate));
      if (blocked) return { included: false, reason: `Excluded by ${type} integration ${excKey} pattern "${blocked}"` };
    }
    return { included: true };
  }

  return { included: true };
}
