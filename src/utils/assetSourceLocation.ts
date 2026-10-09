/**
 * src/utils/assetSourceLocation.ts
 *
 * The catalogue of which discovery sources can answer "where was this asset
 * learned?", what each one contributes, and the operator-orderable priority
 * between them. Pure — no DB, no config reads.
 *
 * This is the backing vocabulary for the Assets table's **Sources** column
 * (`location || learnedLocation`) and for the drag-and-drop priority list on
 * Assets → Settings → Sources. Before this existed the order was hardcoded in
 * `assetProjection.ts`'s LEARNED_LOCATION_RULES; operators with an asset
 * learned from several sources at once (a domain-joined laptop that is also
 * Intune-enrolled, Arc-onboarded, AND sighted behind a FortiGate) had no way
 * to say which of those "wheres" they wanted to read in the column.
 *
 * Two kinds of contributor:
 *
 *   - **field** — the source carries a real location string: AD's OU path, the
 *     controller FortiGate's name, the vCenter cluster. That value is the
 *     contribution.
 *   - **label** — the source knows the asset but has nothing location-shaped
 *     to say (Entra, Intune, Arc). It contributes its own friendly NAME, so
 *     the column reads "Microsoft Intune" rather than sitting blank. This is
 *     deliberately what Azure Arc does: Arc's only location-ish field is the
 *     Azure **resource group**, which is a billing/management container whose
 *     name ("updatemanager", "rg-arc-onboarding") tells an operator nothing
 *     about where the machine is. The resource group is still on the source's
 *     observed blob and still rendered on the Sources tab — it just stopped
 *     being what the location column shows.
 *
 * NEVER add the Azure REGION as a contributor: it says where the Arc resource
 * RECORD lives, not where the machine is.
 *
 * Sources absent from the catalogue (`polaris-agent`, `manual`,
 * `fortigate-firewall`) contribute nothing by design. The agent runs ON the
 * host and has no vantage point on where that host sits; a firewall's own
 * location label is its hostname, which is already on the Asset row (see the
 * note in assetProjection's LEARNED_LOCATION_RULES).
 */

/** How a contributor derives its value from the source's observed blob. */
export type LocationContributorMode = "field" | "label";

export interface LocationContributor {
  /** AssetSource.sourceKind — the priority-list entry key. */
  kind: string;
  /** Friendly source name. Doubles as the contributed value in "label" mode. */
  label: string;
  mode: LocationContributorMode;
  /** Operator-facing one-liner: what this source puts in the column. */
  describe: string;
  /**
   * Observed-blob keys tried in order (field mode only). First non-empty wins,
   * so a source can name a preferred key with a fallback.
   */
  observedKeys?: string[];
  /**
   * True when the value is a Fortinet device name that the integration-name
   * prefix option applies to (`<integration name>:<fortigate name>`).
   */
  fortinetDevice?: boolean;
}

/**
 * Every source kind that can contribute a learned location, in the DEFAULT
 * priority order. Declaration order IS the default — see DEFAULT_LOCATION_ORDER.
 *
 * The order answers "which of these is closest to a PLACE?", which is the
 * question the column is actually asked:
 *
 *   1. The sighting FortiGate first. It is the only contributor that names
 *      where the device physically is — the gate serving its network is its
 *      site. (Which is also why getting this one WRONG is the loudest failure:
 *      see the blob-laundering note in discoveryEngine's
 *      buildFortigateEndpointObservedBlob.)
 *   2. Then the label-only cloud sources (Arc, Intune, Entra, Arc-K8s). They
 *      say nothing about place, but for a cloud-only device nothing else can
 *      either, so naming who knows it beats a blank cell.
 *   3. Then vCenter's cluster / ESXi host — a real place for a VM, but one an
 *      operator chasing a physical device rarely wants over the two above.
 *   4. Active Directory LAST among the endpoint sources. An OU path
 *      ("OU=Computer Workstation2") is ORG structure, not a location, and it
 *      reads as one only by accident of most sites naming OUs after buildings.
 *   5. FortiSwitch / FortiAP at the bottom, where their rank is inert: those
 *      source kinds only ever exist on switch / AP assets, which have no other
 *      contributor to lose to.
 *
 * Changing this order is not retroactive and does not touch an install that has
 * saved its own (that Setting wins) — each integration's assets re-project on
 * its next discovery run. See business rule 22.
 */
export const LOCATION_CONTRIBUTORS: LocationContributor[] = [
  {
    kind: "fortigate-endpoint",
    label: "FortiGate / FortiManager (endpoint)",
    mode: "field",
    observedKeys: ["learnedLocation"],
    fortinetDevice: true,
    describe: "The FortiGate that sighted the device as a DHCP / ARP client.",
  },
  {
    kind: "arc",
    label: "Azure Arc",
    mode: "label",
    describe: 'Always "Azure Arc" — Arc\'s only location-ish field is the Azure resource group, which is a billing container, not a place. The resource group is still on the Sources tab.',
  },
  {
    kind: "intune",
    label: "Microsoft Intune",
    mode: "label",
    describe: 'Always "Microsoft Intune" — Intune enrollment carries no location field.',
  },
  {
    kind: "entra",
    label: "Microsoft Entra ID",
    mode: "label",
    describe: 'Always "Microsoft Entra ID" — an Entra device record carries no location field.',
  },
  {
    kind: "arc-k8s",
    label: "Azure Arc (Kubernetes)",
    mode: "label",
    describe: 'Always "Azure Arc (Kubernetes)" — same reasoning as Azure Arc.',
  },
  {
    kind: "vcenter-vm",
    label: "VMware vCenter (VM)",
    mode: "field",
    observedKeys: ["clusterName", "hostName"],
    describe: "The VM's vSphere cluster, else the ESXi host it runs on.",
  },
  {
    kind: "vcenter-host",
    label: "VMware vCenter (ESXi host)",
    mode: "field",
    observedKeys: ["clusterName"],
    describe: "The host's vSphere cluster. A standalone host contributes nothing.",
  },
  // Unraid / TrueNAS / Proxmox: a VM or container is placed on its host — a
  // real place for a workload, ranked with vCenter's for the same reason. The
  // hosts themselves contribute nothing (they are the place).
  ...([
    ["unraid-vm", "Unraid (VM)"],
    ["unraid-container", "Unraid (container)"],
    ["truenas-vm", "TrueNAS SCALE (VM)"],
    ["truenas-app", "TrueNAS SCALE (App)"],
    ["proxmox-qemu", "Proxmox VE (VM)"],
    ["proxmox-lxc", "Proxmox VE (container)"],
  ] as const).map(([kind, label]): LocationContributor => ({
    kind,
    label,
    mode: "field",
    observedKeys: ["hostName"],
    describe: "The Unraid / TrueNAS host or Proxmox node it runs on.",
  })),
  {
    kind: "ad",
    label: "Active Directory",
    mode: "field",
    observedKeys: ["ouPath"],
    describe: "The computer object's OU path.",
  },
  {
    kind: "fortiswitch",
    label: "FortiSwitch",
    mode: "field",
    observedKeys: ["controllerFortigate"],
    fortinetDevice: true,
    describe: "The controller FortiGate the switch is managed by.",
  },
  {
    kind: "fortiap",
    label: "FortiAP",
    mode: "field",
    observedKeys: ["controllerFortigate"],
    fortinetDevice: true,
    describe: "The controller FortiGate the AP is managed by.",
  },
];

const CONTRIBUTOR_BY_KIND = new Map(LOCATION_CONTRIBUTORS.map((c) => [c.kind, c]));

/** The default priority order — the catalogue's declaration order. */
export const DEFAULT_LOCATION_ORDER: string[] = LOCATION_CONTRIBUTORS.map((c) => c.kind);

export interface SourceLocationPriority {
  /** Source kinds, most-authoritative first. */
  order: string[];
  /**
   * Render Fortinet device names as `<integration name>:<device name>` when the
   * source row recorded which integration sighted it. Off by default — turning
   * it on rewrites the location column for every Fortinet-learned asset.
   */
  integrationPrefix: boolean;
}

export function defaultSourceLocationPriority(): SourceLocationPriority {
  return { order: DEFAULT_LOCATION_ORDER.slice(), integrationPrefix: false };
}

export function locationContributor(kind: string): LocationContributor | undefined {
  return CONTRIBUTOR_BY_KIND.get(kind);
}

/**
 * Coerce a stored / posted priority blob into a usable config.
 *
 * Self-healing in both directions, because the catalogue and the persisted row
 * drift apart across upgrades: unknown kinds (a retired source, a typo) are
 * dropped, duplicates collapse to their first mention, and any catalogue kind
 * the row doesn't mention is APPENDED in default order. That last part is what
 * makes adding a new source kind safe — it lands at the bottom of every
 * operator's existing order rather than silently contributing nothing.
 */
export function normalizeSourceLocationPriority(raw: unknown): SourceLocationPriority {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const seen = new Set<string>();
  const order: string[] = [];
  if (Array.isArray(src.order)) {
    for (const entry of src.order) {
      if (typeof entry !== "string") continue;
      const kind = entry.trim();
      if (!kind || seen.has(kind) || !CONTRIBUTOR_BY_KIND.has(kind)) continue;
      seen.add(kind);
      order.push(kind);
    }
  }
  for (const kind of DEFAULT_LOCATION_ORDER) {
    if (!seen.has(kind)) order.push(kind);
  }

  return { order, integrationPrefix: src.integrationPrefix === true };
}

/**
 * Strip any `<integration>:` prefixes that leaked back onto a Fortinet device
 * name, returning the bare name.
 *
 * A FortiGate / FortiManager device name can't contain a colon, so everything
 * before the LAST one is rendering, not identity. The strip exists because the
 * `fortigate-endpoint` observed blob USED TO be stamped from
 * `Asset.learnedLocation` (discoveryEngine's buildFortigateEndpointObservedBlob)
 * — which is the projection's own OUTPUT. With `integrationPrefix` on, that
 * read-back made the projection non-idempotent: every discovery cycle prefixed
 * the already-prefixed value, growing `FMG1:FMG1:…:SWITCH-1` by one segment per
 * run until an operator noticed (prod, 2026-08).
 *
 * That feedback loop is now cut at the source — the blob is built from the
 * sighting pathway's own device name and never reads the Asset row — but this
 * strip stays as the read-side backstop: it heals rows already polluted, and it
 * means no future writer that stamps a rendered location into a source blob can
 * restart the growth.
 */
export function bareFortinetDeviceName(value: string): string {
  const idx = value.lastIndexOf(":");
  if (idx < 0) return value;
  return value.slice(idx + 1).trim() || value.trim();
}

/** Trimmed string at `key`, or null for anything else / empty. */
function observedString(observed: Record<string, unknown> | null, key: string): string | null {
  if (!observed) return null;
  const v = observed[key];
  if (typeof v !== "string") return null;
  return v.trim() || null;
}

/**
 * What one source contributes to the location column, or null when it has
 * nothing to say. `integrationPrefix` only affects Fortinet device names, and
 * only when the source row recorded `observed.integrationName` — rows written
 * before that stamp existed fall back to the bare device name rather than
 * rendering a dangling ":".
 */
export function contributedLocation(
  kind: string,
  observed: Record<string, unknown> | null,
  opts?: { integrationPrefix?: boolean },
): string | null {
  const contributor = CONTRIBUTOR_BY_KIND.get(kind);
  if (!contributor) return null;

  if (contributor.mode === "label") return contributor.label;

  let value: string | null = null;
  for (const key of contributor.observedKeys ?? []) {
    value = observedString(observed, key);
    if (value) break;
  }
  if (!value) return null;

  // Always bare the device name first — with the prefix OFF a polluted blob
  // would otherwise render its accumulated prefixes verbatim, and with it ON
  // the prefix would be appended to them.
  if (contributor.fortinetDevice) value = bareFortinetDeviceName(value);

  if (opts?.integrationPrefix && contributor.fortinetDevice) {
    const integrationName = observedString(observed, "integrationName");
    if (integrationName) return `${integrationName}:${value}`;
  }
  return value;
}
