/**
 * src/utils/assetProjection.ts
 *
 * Pure projection of an asset's discovery-owned fields from its AssetSource
 * rows. Phase 3b.0 (shadow): integration writes still own field values on
 * the Asset row directly; this projection is computed alongside and any
 * disagreement is logged for analysis. Phase 3b.1 will cut Asset writes to
 * use the projection as the source of truth.
 *
 * Priority rules below were tuned against real shadow-drift logs from
 * production discovery cycles. Specifically:
 *   - hostname: AD's `dnsHostName` wins when it's an FQDN (contains a dot)
 *     because operators value the FQDN form for DNS / log searches.
 *     Otherwise priority falls through Intune → Entra → AD short forms.
 *   - os: AD wins when present — its `operatingSystem` carries the Windows
 *     edition ("Windows 10 Pro") that Intune/Entra collapse to "Windows".
 *   - manufacturer: Intune's value is normalized through the manufacturer
 *     alias map before projection so it matches the canonicalized form
 *     that the Prisma extension stamps on Asset.manufacturer (otherwise
 *     "Dell Inc." vs "Dell" produces noise drift on every cycle).
 *   - ipAddress: infrastructure mgmtIp wins over the fortigate-endpoint
 *     sighting. A newly-deployed FortiGate/FortiSwitch/FortiAP is often
 *     first discovered as a DHCP client of an existing gate (a
 *     fortigate-endpoint source with the leased IP), then adopted into
 *     FMG — after adoption the management IP is the address Polaris must
 *     use (monitoring probes, Open HTTPS/SSH), not the pre-adoption lease.
 *     Plain endpoints have no infrastructure source, so for them the
 *     fortigate-endpoint rule still wins (freshest DHCP/ARP binding; MDM
 *     sources don't carry IP at all).
 *
 * Per-field priority order (first truthy wins). Inferred sources are
 * skipped — they're phase-1 backfill skeletons, not authoritative
 * observations, and including them would falsely flag drift on assets
 * that haven't been re-discovered yet.
 *
 * Fields the projection owns:
 *   hostname, serialNumber, manufacturer, model, os, osVersion,
 *   learnedLocation, ipAddress, latitude, longitude
 *
 * See the "Asset projection priority table" section in polaris-monitoring-discovery -> discovery-fortinet.md for
 * the full per-field × per-source-kind priority matrix.
 *
 * Fields the projection deliberately does NOT own (for now):
 *   - macAddress / macAddresses — DHCP discovery writes these directly to
 *     Asset; no AssetSource carries them yet.
 *   - status / quarantine* — multi-actor (discovery, quarantine code,
 *     decommission job, manual). Out of scope.
 *   - assetType — usually inferred at create and stable thereafter.
 *   - location, department, assignedTo, notes, tags, monitor*, dns* —
 *     operator-owned or system-owned (not from discovery sources).
 *
 * `null` in the returned ProjectedAsset means "no source has an opinion on
 * this field." Drift detection should treat that as no-comment, NOT as a
 * disagreement against an Asset value.
 */

import { normalizeManufacturer } from "./manufacturerNormalize.js";
import { normalizeWindowsOs } from "./osNormalize.js";
import { isValidGeoCoord } from "./geo.js";
import {
  contributedLocation,
  defaultSourceLocationPriority,
  locationContributor,
  type SourceLocationPriority,
} from "./assetSourceLocation.js";

export type AssetSourceKind =
  | "entra"
  | "intune"
  | "ad"
  | "fortigate-firewall"
  | "fortiswitch"
  | "fortiap"
  | "fortigate-endpoint"
  | "polaris-agent"
  | "vcenter-vm"
  | "vcenter-host"
  | "arc"
  | "arc-k8s"
  // The device's OWN answer to sysDescr, parsed through its vendor's
  // documented format (utils/snmpDescrIdentity.ts) on the monitor path.
  // ENRICHMENT, not ownership: it says what the device claims to be, never
  // that the device is in anyone's inventory — see ENRICHMENT_SOURCE_KINDS.
  | "snmp-sysdescr"
  | "manual";

/**
 * Source kinds that describe a device without CLAIMING it.
 *
 * Every other kind is written by something that holds the device in an
 * inventory — a directory, a hypervisor, a controller, an operator. Their
 * presence answers "does anything still say this device exists?", which is
 * what the vCenter disappearance sweep asks before decommissioning an asset
 * that left the inventory (business rule: absence only counts when nothing
 * else claims it).
 *
 * An enrichment row answers a different question: "what did the device say
 * about itself when we last spoke to it?" A camera that answered sysDescr is
 * not evidence that a VM still exists in vCenter, so counting one as a claim
 * would leave a deleted VM active forever. Callers asking about EXISTENCE
 * filter these out; callers asking about IDENTITY (projection) do not.
 */
export const ENRICHMENT_SOURCE_KINDS: readonly AssetSourceKind[] = ["snmp-sysdescr"];

/** True when this kind's presence means "something still holds this device". */
export function sourceClaimsExistence(kind: string): boolean {
  return !ENRICHMENT_SOURCE_KINDS.includes(kind as AssetSourceKind);
}

export interface AssetSourceForProjection {
  sourceKind: AssetSourceKind | string;
  inferred: boolean;
  observed: Record<string, unknown> | null;
  /**
   * Row freshness (AssetSource.lastSeen). Optional. When an asset carries
   * SEVERAL rows of the same kind — a device that changed NICs keeps one
   * `fortigate-endpoint` row per MAC, since that kind's externalId IS the
   * MAC — the freshest row speaks for the kind; without this, the pick was
   * whichever row the unordered query returned first, so a stale NIC's blob
   * could keep reverting ipAddress/hostname on every projection apply.
   * Callers that omit it keep first-row-in-list behavior.
   */
  lastSeen?: Date | null;
}

export interface ProjectedAsset {
  hostname: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  osVersion: string | null;
  learnedLocation: string | null;
  ipAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  snmpLocation: string | null;
  learnedAddress: string | null;
  /**
   * What the device calls ITSELF ("Network Camera") — not a type, a phrase.
   * Only a source that reads the device directly can state it, so today only
   * `snmp-sysdescr` does. Feeds the device-type match rules as its own fact,
   * which is what lets ONE rule type a camera fleet without a regex over the
   * whole self-description (that also reads hostname, so it typed an NVR
   * called CAMERA-NVR-01 as a camera).
   */
  productType: string | null;
}

export type ProjectionProvenance = Partial<Record<keyof ProjectedAsset, AssetSourceKind | string>>;

export interface ProjectionResult {
  projected: ProjectedAsset;
  provenance: ProjectionProvenance;
}

// Internal: typed accessor for an observed JSON blob. Returns the value as
// unknown so callers narrow per use; treats null/undefined uniformly.
function obsString(o: Record<string, unknown> | null, key: string): string | null {
  if (!o) return null;
  const v = o[key];
  if (typeof v === "string") {
    const t = v.trim();
    return t || null;
  }
  return null;
}

function obsNumber(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null;
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Per-field priority: ordered list of (sourceKind, accessor). First accessor
// returning a non-null/non-empty value wins. Each accessor receives the
// matching source's `observed` blob. The shape is wide so the type system
// helps when adding new fields.
type FieldRule = {
  sourceKind: AssetSourceKind;
  pick: (o: Record<string, unknown> | null) => string | number | null;
  /**
   * Optional gate over the FULL source list: when present and false, the
   * rule is skipped entirely. Lets a rule express "only when no
   * authoritative source of kind X exists" — e.g. a firewall's
   * pre-adoption fortigate-endpoint sighting must not supply
   * learnedLocation once a fortigate-firewall source is on file.
   */
  applies?: (sources: AssetSourceForProjection[]) => boolean;
};

/** True when a non-inferred source of the given kind exists. */
function hasSource(sources: AssetSourceForProjection[], kind: AssetSourceKind): boolean {
  return sources.some((s) => s.sourceKind === kind && !s.inferred);
}

const HOSTNAME_RULES: FieldRule[] = [
  // Polaris Agent runs ON the host — it knows the configured hostname
  // (os.Hostname / Win32 GetComputerNameEx / Darwin sysctl) authoritatively.
  // Wins over every inferred source (AD, Entra, Intune) because those infer
  // hostname from elsewhere (DNS, MDM enrollment, computer-object name)
  // and can drift from what the host actually answers to.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "hostname") },
  // vCenter is definitive over every source except the in-guest agent
  // (project decision, 2026-07). The guest hostname comes from VMware Tools
  // (the OS's own report relayed through the hypervisor) — nearly
  // agent-grade; the VM display name is the fallback when Tools is off.
  { sourceKind: "vcenter-vm", pick: (o) => obsString(o, "guestHostname") || obsString(o, "name") },
  // ESXi hosts: the name they were added to vCenter by (usually the FQDN).
  { sourceKind: "vcenter-host", pick: (o) => obsString(o, "name") },
  // Azure Arc's FQDN — the Connected Machine agent runs IN the guest and
  // reports the OS's own domain-joined FQDN, refreshed continuously. Ranked
  // above AD because AD's dnsHostName only updates when the computer object
  // re-registers (the same argument the OS rules make), and below vCenter to
  // leave the 2026-07 "vCenter is definitive" decision untouched. Only
  // reported when it actually contains a dot — arcHostnameCandidates gates
  // that, so a short name in the adFqdn field can't reach this rule.
  { sourceKind: "arc", pick: (o) => {
      const v = obsString(o, "dnsFqdn") || obsString(o, "adFqdn");
      return v && v.includes(".") ? v : null;
    }
  },
  // FQDN from AD wins next — when an AD source has a dnsHostName containing a
  // dot, that's the FQDN form operators search for in DNS / DHCP / logs.
  // Tuned from production shadow-drift logs where ~7k entries per 24h
  // showed Asset.hostname (FQDN) drifting against an Intune/Entra-only
  // projection (short form). Falls through if AD has no dnsHostName, or
  // if its dnsHostName is short-form (rare — usually means cn-derived
  // fallback).
  { sourceKind: "ad", pick: (o) => {
      const v = obsString(o, "dnsHostName");
      return v && v.includes(".") ? v : null;
    }
  },
  // Intune wins next — intune.deviceName is the freshest hands-on signal
  // for non-AD-joined devices (BYO laptops, mobile devices). The split
  // observed blobs keep the original entra/intune-side names separate so
  // these priorities work correctly in the new model.
  { sourceKind: "intune", pick: (o) => obsString(o, "deviceName") },
  { sourceKind: "entra",  pick: (o) => obsString(o, "displayName") },
  // Arc short form — the Azure resource displayName (or resource name).
  // Below the MDM short forms because it's an ARM label that an operator can
  // rename independently of the machine.
  { sourceKind: "arc", pick: (o) => obsString(o, "displayName") || obsString(o, "name") },
  // An Arc-enabled Kubernetes cluster has only its ARM resource name.
  { sourceKind: "arc-k8s", pick: (o) => obsString(o, "name") },
  // AD non-FQDN fallback — short dnsHostName or cn (NetBIOS).
  { sourceKind: "ad", pick: (o) => obsString(o, "dnsHostName") || obsString(o, "cn") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "hostname") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "switchId") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "name") },
  // fortigate-endpoint hostname — the FortiGate's DHCP client identifier.
  // Lowest priority because DHCP client IDs are operator-set and may not
  // match the device's "real" hostname (random strings, owner names,
  // serial numbers). Useful only when no MDM/AD source has an opinion.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "hostname") },
];

const SERIAL_RULES: FieldRule[] = [
  // Polaris Agent reads DMI/SMBIOS directly (/sys/class/dmi/id/product_serial
  // on Linux; ioreg IOPlatformSerialNumber on macOS; HKLM\HARDWARE\DESCRIPTION
  // \System\BIOS on Windows). Authoritative — beats MDM serial fields that
  // are populated by inventory-time enrollment and can be empty/cached.
  // On hardened Linux hosts product_serial may be 0400 (root only); the
  // agent's DynamicUser then gets no value and the projection falls through
  // to Intune.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "serialNumber") },
  // Arc reads SMBIOS in-guest on every agent check-in. Beats Intune, whose
  // serial is an enrollment-time inventory value that can be stale or empty;
  // below the Polaris Agent, which reads DMI directly with no cloud hop.
  { sourceKind: "arc", pick: (o) => obsString(o, "serialNumber") },
  { sourceKind: "intune", pick: (o) => obsString(o, "serialNumber") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "serial") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "serial") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "serial") },
];

const MANUFACTURER_RULES: FieldRule[] = [
  // Polaris Agent reads DMI sys_vendor / IOPlatformManufacturer / BIOS
  // registry — the manufacturer string the firmware itself reports. Run
  // through normalizeManufacturer so it matches the canonical Asset value.
  { sourceKind: "polaris-agent", pick: (o) => {
      const raw = obsString(o, "manufacturer");
      return raw ? normalizeManufacturer(raw) : null;
    }
  },
  // Arc's detectedProperties.manufacturer is the firmware string read in the
  // guest. Same alias normalization as the other rules so the projected value
  // matches what the Prisma extension canonicalizes onto Asset.manufacturer —
  // otherwise "VMware, Inc." vs "VMware" fires drift every cycle. Ranked
  // above vCenter's constant only matters for PHYSICAL hosts; on a VM both
  // say VMware, so the ordering is a no-op in the common case.
  { sourceKind: "arc", pick: (o) => {
      const raw = obsString(o, "manufacturer");
      return raw ? normalizeManufacturer(raw) : null;
    }
  },
  // A vCenter VM's "hardware" is always VMware's virtual platform — constant
  // pick (the SMBIOS the guest sees says the same thing). No vcenter-host
  // rule: the REST host list exposes no hardware vendor/model.
  { sourceKind: "vcenter-vm", pick: () => normalizeManufacturer("VMware, Inc.") },
  // Intune carries the actual hardware vendor ("Dell Inc.", "LENOVO", ...)
  // pre-canonicalization. Run through normalizeManufacturer so the
  // projected value matches what the Prisma extension stamps on
  // Asset.manufacturer post-canonicalization (e.g. "Dell Inc." → "Dell").
  // Without this, drift fires on every cycle for the gap between the raw
  // vendor string and the canonical brand name.
  { sourceKind: "intune", pick: (o) => {
      const raw = obsString(o, "manufacturer");
      return raw ? normalizeManufacturer(raw) : null;
    }
  },
  // Fortinet infrastructure: always literally "Fortinet" — already canonical.
  { sourceKind: "fortigate-firewall", pick: () => "Fortinet" },
  { sourceKind: "fortiswitch", pick: () => "Fortinet" },
  { sourceKind: "fortiap", pick: () => "Fortinet" },
  // The device's OWN answer, parsed through its vendor's documented sysDescr
  // format. Ranked HERE — directly above fortigate-endpoint and no higher —
  // because the claim is narrow and defensible: a device's own SNMP
  // self-report beats a gate's DHCP/device-inventory FINGERPRINT, which
  // answers with a category ("ip camera") rather than a vendor. It stays BELOW
  // the agent / Arc / vCenter / MDM rows deliberately — those read the
  // running system from inside it, and outranking them is a claim this
  // parser has no business making. A row exists only where
  // parseVendorSysDescr recognized the layout, so today it can only be an
  // AXIS device: a Windows host answering "Hardware: Intel64 Family 6 -
  // Software: Windows Version 6.3" never gets one, and cannot displace
  // Intune's model with it.
  { sourceKind: "snmp-sysdescr", pick: (o) => {
      const raw = obsString(o, "manufacturer");
      return raw ? normalizeManufacturer(raw) : null;
    } },
  // fortigate-endpoint hardwareVendor — populated from FortiOS device-
  // inventory or OUI lookup at discovery time. Coarser than Intune
  // (vendor only, no model fidelity) but better than nothing for assets
  // that have no MDM source. Same alias-normalization pass as Intune so
  // "Dell Inc." → "Dell" matches the canonical Asset value.
  { sourceKind: "fortigate-endpoint", pick: (o) => {
      const raw = obsString(o, "hardwareVendor");
      return raw ? normalizeManufacturer(raw) : null;
    }
  },
];

const MODEL_RULES: FieldRule[] = [
  // Polaris Agent reads DMI product_name / IOPlatformProduct / BIOS
  // registry. Beats Intune for the same DMI-is-authoritative reason as
  // manufacturer; falls through when DMI is unreadable.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "model") },
  // Arc's detectedProperties.model — the SMBIOS product name. Same reasoning
  // as manufacturer: only decisive on physical hosts.
  { sourceKind: "arc", pick: (o) => obsString(o, "model") },
  // Constant for VMs — matches the SMBIOS product name VMware exposes to
  // guests, so the agent (when installed) projects the same value.
  { sourceKind: "vcenter-vm", pick: () => "VMware Virtual Platform" },
  { sourceKind: "intune", pick: (o) => obsString(o, "model") },
  // FortiSwitch's observed blob always carries `model: "FortiSwitch"` which
  // is too generic to be useful — skip it here and let the asset row keep
  // whatever the legacy create path stamped (also "FortiSwitch"). Firewall
  // and AP do carry a meaningful model string.
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "model") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "model") },
  // The device's OWN answer, parsed through its vendor's documented sysDescr
  // format. Ranked HERE — directly above fortigate-endpoint and no higher —
  // because the claim is narrow and defensible: a device's own SNMP
  // self-report beats a gate's DHCP/device-inventory FINGERPRINT, which
  // answers with a category ("ip camera") rather than a model. It stays BELOW
  // the agent / Arc / vCenter / MDM rows deliberately — those read the
  // running system from inside it, and outranking them is a claim this
  // parser has no business making. A row exists only where
  // parseVendorSysDescr recognized the layout, so today it can only be an
  // AXIS device: a Windows host answering "Hardware: Intel64 Family 6 -
  // Software: Windows Version 6.3" never gets one, and cannot displace
  // Intune's model with it.
  { sourceKind: "snmp-sysdescr", pick: (o) => obsString(o, "model") },
  // fortigate-endpoint model — DHCP fingerprint or device-inventory model
  // string. Coarse signal but better than nothing for non-MDM assets.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "model") },
];

const OS_RULES: FieldRule[] = [
  // Polaris Agent reads os-release on Linux (PRETTY_NAME → "Red Hat
  // Enterprise Linux 8.10"), sw_vers on macOS ("macOS 14.4.1"), or
  // Windows version registry. Beats AD's edition string because the
  // agent reflects what's actually running right now (post-upgrade,
  // post-reimage), whereas AD's operatingSystem only updates when
  // a domain-joined client re-registers — which can lag months on
  // long-running servers.
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "os") },
  // Arc's osSku carries the exact edition read from the RUNNING OS
  // ("Windows Server 2022 Datacenter", "Ubuntu 22.04.4 LTS"), refreshed on
  // every agent check-in. Strictly better than AD's operatingSystem (stale
  // until the computer object re-registers) and than Tools' guestOsFullName
  // (the CONFIGURED guest-OS identifier, not necessarily what booted).
  { sourceKind: "arc", pick: (o) => obsString(o, "osSku") || obsString(o, "osName") },
  // Constant: a connected cluster has no guest OS of its own. The
  // distribution (aks / openshift / rancher …) is the operationally useful
  // half, so fold it in when Arc reports one.
  { sourceKind: "arc-k8s", pick: (o) => {
      const dist = obsString(o, "distribution");
      return dist ? `Kubernetes (${dist})` : "Kubernetes";
    }
  },
  // VMware Tools' guest OS full name ("Microsoft Windows Server 2022
  // (64-bit)", "Ubuntu Linux (64-bit)") — the running OS as the hypervisor
  // sees it. Beats AD's edition string because Tools reflects the current
  // install (post-upgrade), while AD lags until re-registration.
  { sourceKind: "vcenter-vm", pick: (o) => obsString(o, "guestOsFullName") },
  // ESXi hosts are definitionally ESXi (REST exposes no version — no
  // OS_VERSION rule below).
  { sourceKind: "vcenter-host", pick: () => "VMware ESXi" },
  // AD's operatingSystem carries the Windows edition ("Windows 10 Pro",
  // "Windows 11 Enterprise"). Intune/Entra collapse to just "Windows".
  // Edition is operationally meaningful — keep AD when present.
  { sourceKind: "ad", pick: (o) => obsString(o, "operatingSystem") },
  { sourceKind: "intune", pick: (o) => obsString(o, "operatingSystem") },
  { sourceKind: "entra", pick: (o) => obsString(o, "operatingSystem") },
  // NOTE: deliberately NO `snmp-sysdescr` rule here.
  //
  // This source's `os` is the RAW sysDescr, which is a record of the
  // reading rather than a value an operator reads: the asset page renders
  // OS / Firmware as `[os, osVersion]`, so contributing it printed
  // "; AXIS M2025-LE; Network Camera; 8.40.3; Sep 06 2019 17:30; 727; 1; 8.40.3"
  // where "8.40.3" belonged. The raw text stays verbatim on the source
  // row's observed blob — the Sources tab is where what each source SAID
  // belongs — and the parsed halves land in model / osVersion /
  // productType. A device whose format we cannot read gets no row at all
  // and keeps whatever `os` it already had.
  // fortigate-endpoint os — FortiGate device-inventory's OS detection
  // (rough fingerprint based on DHCP options + traffic). Coarse but
  // useful when no MDM/AD source has the device.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "os") },
];

const OS_VERSION_RULES: FieldRule[] = [
  // Polaris Agent reports VERSION_ID from os-release (Linux) or the
  // actual kernel / OS build (macOS sw_vers, Windows registry).
  // Authoritative for "what version is actually running now."
  { sourceKind: "polaris-agent", pick: (o) => obsString(o, "osVersion") },
  // Same in-guest, refreshed-continuously argument as the OS rule above.
  { sourceKind: "arc", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "arc-k8s", pick: (o) => obsString(o, "kubernetesVersion") },
  { sourceKind: "intune", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "entra", pick: (o) => obsString(o, "operatingSystemVersion") },
  { sourceKind: "ad", pick: (o) => obsString(o, "operatingSystemVersion") },
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "osVersion") },
  // The device's OWN answer, parsed through its vendor's documented sysDescr
  // format. Ranked HERE — directly above fortigate-endpoint and no higher —
  // because the claim is narrow and defensible: a device's own SNMP
  // self-report beats a gate's DHCP/device-inventory FINGERPRINT, which
  // answers with a category ("ip camera") rather than a firmware version. It stays BELOW
  // the agent / Arc / vCenter / MDM rows deliberately — those read the
  // running system from inside it, and outranking them is a claim this
  // parser has no business making. A row exists only where
  // parseVendorSysDescr recognized the layout, so today it can only be an
  // AXIS device: a Windows host answering "Hardware: Intel64 Family 6 -
  // Software: Windows Version 6.3" never gets one, and cannot displace
  // Intune's model with it.
  { sourceKind: "snmp-sysdescr", pick: (o) => obsString(o, "osVersion") },
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "osVersion") },
];

/**
 * learnedLocation is the one projected field whose priority order is
 * OPERATOR-CONFIGURABLE (Assets → Settings → Sources; the Assets table's
 * "Sources" column reads `location || learnedLocation`). An asset learned from
 * several sources at once has several competing answers to "where is it?" — an
 * AD OU path, a controller FortiGate, an Azure Arc onboarding — and which one
 * an operator wants to read is a site convention, not something Polaris can
 * decide. So the rule list is BUILT from the priority config rather than
 * declared here; the catalogue of who can contribute what lives in
 * utils/assetSourceLocation.ts.
 *
 * Notes that survive the move:
 *   - Firewalls contribute nothing: a firewall's location label is its own
 *     hostname, already on Asset.hostname, so learnedLocation stays null for
 *     them and the legacy "set when null" inline rule keeps working.
 *   - The fortigate-endpoint rule is suppressed on any asset that ALSO has a
 *     Fortinet infrastructure source (fortigate-firewall / fortiswitch /
 *     fortiap), whatever the operator's order says. A managed device's site
 *     label is its own identity or its controller — the gate that happened to
 *     sight it as a DHCP client pre-adoption is not its location, and that
 *     stale endpoint row outlives the adoption. An invariant, not a
 *     preference: it held by accident while the default order happened to put
 *     fortiswitch/fortiap above fortigate-endpoint, and has to be stated now
 *     that the sighting gate leads that order.
 */
const LOCATION_SUPPRESSING_INFRA_SOURCES: AssetSourceKind[] = [
  "fortigate-firewall",
  "fortiswitch",
  "fortiap",
];

function buildLearnedLocationRules(config: SourceLocationPriority): FieldRule[] {
  return config.order
    .filter((kind) => locationContributor(kind))
    .map((kind) => {
      const rule: FieldRule = {
        sourceKind: kind as AssetSourceKind,
        pick: (o) => contributedLocation(kind, o, { integrationPrefix: config.integrationPrefix }),
      };
      if (kind === "fortigate-endpoint") {
        rule.applies = (sources) =>
          !LOCATION_SUPPRESSING_INFRA_SOURCES.some((k) => hasSource(sources, k));
      }
      return rule;
    });
}

/**
 * Process-wide learned-location priority, seeded with the default order and
 * refreshed from the `assetSourcePriority` Setting by
 * services/assetSourcePriorityService.refreshProjectionPriority() — at boot and
 * at the start of every discovery run, which is what propagates an operator's
 * edit into the split-role discovery process.
 *
 * Module state in an otherwise-pure util is a deliberate trade: there are ~25
 * projectAssetFromSources() call sites across discoveryEngine / routes /
 * drift detection, and threading a config object through all of them to serve
 * one field's ordering would be far more invasive than one refresh seam. Tests
 * and any caller that wants determinism pass `opts.learnedLocation` explicitly
 * and never observe this value.
 */
let activeLocationPriority: SourceLocationPriority = defaultSourceLocationPriority();
let activeLearnedLocationRules: FieldRule[] = buildLearnedLocationRules(activeLocationPriority);

/** Install the operator's order process-wide. Idempotent; cheap to re-call. */
export function setLearnedLocationPriority(config: SourceLocationPriority): void {
  activeLocationPriority = config;
  activeLearnedLocationRules = buildLearnedLocationRules(config);
}

/** The order currently in force — for diagnostics / the settings GET. */
export function getLearnedLocationPriority(): SourceLocationPriority {
  return activeLocationPriority;
}

/**
 * Product type: the device's own words, and nobody else's.
 *
 * One rule, because no directory, hypervisor or controller publishes this —
 * they publish a model, or a category they inferred from one. If one ever
 * does, it ranks by the question every other list here answers: who read the
 * device more directly?
 */
const PRODUCT_TYPE_RULES: FieldRule[] = [
  { sourceKind: "snmp-sysdescr", pick: (o) => obsString(o, "productType") },
];

const IP_ADDRESS_RULES: FieldRule[] = [
  // Infrastructure management IP wins. A newly-deployed FortiGate/switch/AP
  // is often first sighted as a DHCP client of an existing gate — that
  // pre-adoption fortigate-endpoint source (with the leased IP) can coexist
  // with the infrastructure source after FMG adoption, and the mgmt IP is
  // the address Polaris must use once the device is managed. The discovery
  // firewall branch also sweeps the stale endpoint source, but the priority
  // here must not depend on that cleanup having run.
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "mgmtIp") },
  { sourceKind: "fortiswitch", pick: (o) => obsString(o, "mgmtIp") },
  { sourceKind: "fortiap", pick: (o) => obsString(o, "mgmtIp") },
  // VMware Tools' live guest IP — the address the OS itself reports through
  // the hypervisor. Beats the fortigate-endpoint DHCP/ARP sighting
  // (Tools is current-state; a lease row can be stale), but stays below
  // the infra mgmtIp rules — a virtual FortiGate's management IP is the
  // address Polaris must probe, not whichever guest interface Tools
  // happened to report first.
  { sourceKind: "vcenter-vm", pick: (o) => obsString(o, "guestIp") },
  // ESXi hosts: DNS-resolved from the host's vCenter name (REST exposes no
  // mgmt IP).
  { sourceKind: "vcenter-host", pick: (o) => obsString(o, "resolvedIp") },
  // Arc's networkProfile addresses (only populated when the integration's
  // fetchNetworkProfile toggle is on — it costs one GET per machine). Below
  // vCenter because Tools reports live guest IPs on a tight cadence while
  // networkProfile refreshes on the agent's slower interval; above
  // fortigate-endpoint because a DHCP/ARP binding is a network-side
  // observation while this is host-side truth.
  { sourceKind: "arc", pick: (o) => {
      const list = o?.ipAddresses;
      if (!Array.isArray(list)) return null;
      const first = list.find((v) => typeof v === "string" && v.trim() !== "");
      return typeof first === "string" ? first.trim() : null;
    }
  },
  // Endpoint IPs: fortigate-endpoint sees the live DHCP/ARP binding —
  // freshest signal for plain endpoints (which have no infrastructure
  // source, so this rule is effectively first for them). MDM sources
  // don't carry IP at all.
  { sourceKind: "fortigate-endpoint", pick: (o) => obsString(o, "ipAddress") },
];

// Coord resolution priority on the fortigate-firewall source. SNMP sysLocation
// is pulled via the FortiOS REST API (`/api/v2/cmdb/system.snmp/sysinfo`) when
// `fortigateMonitor.pullSnmpLocation` is on, then geocoded via Nominatim. When
// the geocoder returns valid coords, that pair is authoritative — sysLocation
// is configured on the FortiGate itself, the natural place network engineers
// record device location.
//
//   1. SNMP-geocoded sysLocation (highest priority; only populated in the
//      observed blob when the REST pull + geocode both succeeded)
//   2. FMG metavars `Latitude` / `Longitude` (operator-managed fallback when
//      SNMP is off or returns no usable location)
//   3. CMDB `gui-device-latitude` / `gui-device-longitude` (FortiOS GUI
//      values; pre-feature source)
//
// Each picker validates the (lat, lng) pair as a whole via isValidGeoCoord
// so a half-valid tier (e.g. metavar lat set, metavar lng=0) falls through
// to the next tier rather than mixing tiers. The rule order is the SAME
// for latitude and longitude — when one resolves at tier N, the other will
// too because the pair-validity check inside each picker has the same
// outcome.
const LATITUDE_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "snmpGeocodedLatitude");
    const lng = obsNumber(o, "snmpGeocodedLongitude");
    return isValidGeoCoord(lat, lng) ? lat : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "metavarLatitude");
    const lng = obsNumber(o, "metavarLongitude");
    return isValidGeoCoord(lat, lng) ? lat : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "latitude");
    const lng = obsNumber(o, "longitude");
    return isValidGeoCoord(lat, lng) ? lat : null;
  }},
];

const LONGITUDE_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "snmpGeocodedLatitude");
    const lng = obsNumber(o, "snmpGeocodedLongitude");
    return isValidGeoCoord(lat, lng) ? lng : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "metavarLatitude");
    const lng = obsNumber(o, "metavarLongitude");
    return isValidGeoCoord(lat, lng) ? lng : null;
  }},
  { sourceKind: "fortigate-firewall", pick: (o) => {
    const lat = obsNumber(o, "latitude");
    const lng = obsNumber(o, "longitude");
    return isValidGeoCoord(lat, lng) ? lng : null;
  }},
];

// Raw SNMP sysLocation string. Only fortigate-firewall sources carry it
// (discovery-time SNMP pull is FortiGate-specific). Surfaced on the asset
// details General tab regardless of whether the geocoder produced usable
// coords — operators see what the FortiGate is telling SNMP even when
// the value couldn't be resolved to a lat/lng.
const SNMP_LOCATION_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "snmpLocation") },
];

// Auto-discovered street address from the FMG per-device address metavariable
// (operator-named via `fortigateMonitor.addressMetavar`). Only fortigate-firewall
// sources carry it; the value is whatever string the operator stored in that
// metavar. Surfaced as "Address" on the asset details General tab.
const LEARNED_ADDRESS_RULES: FieldRule[] = [
  { sourceKind: "fortigate-firewall", pick: (o) => obsString(o, "metavarAddress") },
];

// Walk priority rules in order; return the first non-empty value plus its
// source kind. Inferred sources are excluded — they're phase-1 backfill
// skeletons, not authoritative observations.
function projectField<T extends string | number>(
  sources: AssetSourceForProjection[],
  rules: FieldRule[],
): { value: T | null; source: AssetSourceKind | null } {
  for (const rule of rules) {
    if (rule.applies && !rule.applies(sources)) continue;
    // Among rows of the rule's kind, the freshest (lastSeen) speaks for the
    // kind. Ties — and callers that don't supply lastSeen — keep the first
    // row in list order, the historical behavior.
    let candidate: AssetSourceForProjection | undefined;
    let candidateSeen = -1;
    for (const s of sources) {
      if (s.sourceKind !== rule.sourceKind || s.inferred) continue;
      const t = s.lastSeen ? s.lastSeen.getTime() : 0;
      const seen = Number.isFinite(t) ? t : 0;
      if (!candidate || seen > candidateSeen) {
        candidate = s;
        candidateSeen = seen;
      }
    }
    if (!candidate) continue;
    const picked = rule.pick(candidate.observed);
    if (picked !== null && picked !== undefined && picked !== "") {
      return { value: picked as T, source: rule.sourceKind };
    }
  }
  return { value: null, source: null };
}

export interface ProjectionOptions {
  /**
   * Override the process-wide learned-location priority for this call. Pass it
   * whenever the result must be deterministic regardless of what an operator
   * has configured (tests, previews).
   */
  learnedLocation?: SourceLocationPriority;
}

export function projectAssetFromSources(
  sources: AssetSourceForProjection[],
  opts?: ProjectionOptions,
): ProjectionResult {
  const projected: ProjectedAsset = {
    hostname: null,
    serialNumber: null,
    manufacturer: null,
    model: null,
    os: null,
    osVersion: null,
    learnedLocation: null,
    ipAddress: null,
    latitude: null,
    longitude: null,
    snmpLocation: null,
    learnedAddress: null,
    productType: null,
  };
  const provenance: ProjectionProvenance = {};

  const apply = <K extends keyof ProjectedAsset>(field: K, rules: FieldRule[]): void => {
    const { value, source } = projectField(sources, rules);
    if (value !== null) {
      // The discriminated rules above guarantee string-only fields get
      // strings and number-only fields get numbers, but the type system
      // can't see through the array unification. The cast is local to
      // this assignment and safe because the rule list for each field
      // only contains pickers of the matching primitive type.
      projected[field] = value as ProjectedAsset[K];
      if (source) provenance[field] = source;
    }
  };

  apply("hostname", HOSTNAME_RULES);
  apply("serialNumber", SERIAL_RULES);
  apply("manufacturer", MANUFACTURER_RULES);
  apply("model", MODEL_RULES);
  apply("os", OS_RULES);
  apply("osVersion", OS_VERSION_RULES);
  // Every source above reads the Windows product name from the registry key
  // Microsoft froze at "Windows 10" when Windows 11 shipped, so the winning
  // value is wrong on every Windows 11 client regardless of which source won.
  // Corrected here rather than only on the way to the DB so this function's
  // output is what projectionDriftService compares against the stored row —
  // normalizing one side only would report permanent drift every cycle.
  // No-op for non-Windows, Windows Server, and undeterminable builds.
  {
    const fixed = normalizeWindowsOs({ os: projected.os, osVersion: projected.osVersion });
    projected.os = fixed.os;
    projected.osVersion = fixed.osVersion;
  }
  apply(
    "learnedLocation",
    opts?.learnedLocation
      ? buildLearnedLocationRules(opts.learnedLocation)
      : activeLearnedLocationRules,
  );
  apply("ipAddress", IP_ADDRESS_RULES);
  apply("latitude", LATITUDE_RULES);
  apply("longitude", LONGITUDE_RULES);
  apply("snmpLocation", SNMP_LOCATION_RULES);
  apply("learnedAddress", LEARNED_ADDRESS_RULES);
  apply("productType", PRODUCT_TYPE_RULES);

  return { projected, provenance };
}
