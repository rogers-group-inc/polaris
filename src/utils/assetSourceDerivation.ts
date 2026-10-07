/**
 * src/utils/assetSourceDerivation.ts
 *
 * Pure (no-DB) derivation: given an Asset row, produce the list of
 * AssetSource rows that should exist for it under the phase-1 backfill
 * model. The backfill job and the shadow-write Prisma extension both call
 * this so the rules live in one place.
 *
 * Sources are derived from two legacy conventions:
 *   1. `assetTag` prefixes — "entra:<deviceId>", "ad:<objectGUID>",
 *      "fortigate:<serial>" — set by discovery in the current single-row
 *      model. These produce the row's *primary* source.
 *   2. `tags` markers — "ad-guid:<guid>" stamped by the AD↔Entra cross-link
 *      handshake, indicating an AD source existed pre-merge before Entra
 *      took over the assetTag. These produce *inferred* secondary rows that
 *      a real AD discovery run will replace with truth.
 *
 * Assets with no recognizable source tag fall through to a single "manual"
 * source keyed on the Asset.id itself (collision-free random UUID).
 *
 * `observed` blobs are intentionally minimal here — phase 1 is about
 * populating shape; phase 2 cutover writes the rich source-shaped payload.
 */

export type DerivedSourceKind =
  | "entra"
  | "ad"
  | "fortigate-firewall"
  | "fortiswitch"
  | "fortiap"
  | "manual";

export interface DerivedSource {
  sourceKind: DerivedSourceKind;
  externalId: string;
  integrationId: string | null;
  inferred: boolean;
  observed: Record<string, unknown>;
}

export interface AssetSnapshot {
  id: string;
  assetTag: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
  hostname: string | null;
  ipAddress: string | null;
  os: string | null;
  osVersion: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  assetType: string | null;
  status: string | null;
  learnedLocation: string | null;
  dnsName: string | null;
  latitude: number | null;
  longitude: number | null;
  acquiredAt: Date | null;
  lastSeen: Date | null;
  createdBy: string | null;
}

export function deriveAssetSources(asset: AssetSnapshot): DerivedSource[] {
  const out: DerivedSource[] = [];
  const tag = asset.assetTag?.trim() || null;
  const tags = Array.isArray(asset.tags) ? asset.tags : [];

  // 1. Primary source from assetTag prefix.
  if (tag?.startsWith("entra:")) {
    const deviceId = tag.slice("entra:".length).trim();
    if (deviceId) {
      out.push({
        sourceKind: "entra",
        externalId: deviceId.toLowerCase(),
        integrationId: asset.discoveredByIntegrationId,
        inferred: false,
        observed: buildEntraObserved(asset, deviceId, tags),
      });
    }
  } else if (tag?.startsWith("ad:")) {
    const guid = tag.slice("ad:".length).trim();
    if (guid) {
      out.push({
        sourceKind: "ad",
        externalId: guid.toLowerCase(),
        integrationId: asset.discoveredByIntegrationId,
        inferred: false,
        observed: buildAdObserved(asset, guid, tags),
      });
    }
  } else if (tag?.startsWith("fgt:")) {
    // Firewall asset created by the FortiGate or FortiManager discovery path.
    // Discovery's assetTag prefix is "fgt:" (used as the Device Map's stable
    // lookup key); externalId on the source row is the canonical
    // serialNumber field on the Asset row, which the discovery code uses for
    // re-discovery via the in-memory bySerial index.
    const tagSerial = tag.slice("fgt:".length).trim();
    const serial = (asset.serialNumber || tagSerial).trim();
    if (serial) {
      out.push({
        sourceKind: "fortigate-firewall",
        externalId: serial,
        integrationId: asset.discoveredByIntegrationId,
        inferred: false,
        observed: buildFortigateFirewallObserved(asset, serial),
      });
    }
  }

  // Fallback path for Fortinet infrastructure assets that don't carry an
  // assetTag prefix today. FortiGate firewalls have the `fgt:` tag (added
  // later, so pre-tag firewalls also rely on this fallback); managed
  // FortiSwitch and FortiAP assets have no tag at all and identify via
  // `assetType` + `manufacturer="Fortinet"` + `serialNumber`. Each maps to
  // its own sourceKind. The next FMG/FortiGate discovery run writes the
  // explicit AssetSource row with the rich observed blob; this fallback
  // covers the gap so backfill produces the right source row immediately.
  if (
    out.length === 0 &&
    (asset.manufacturer || "").toLowerCase() === "fortinet" &&
    asset.serialNumber
  ) {
    if (asset.assetType === "firewall") {
      out.push({
        sourceKind: "fortigate-firewall",
        externalId: asset.serialNumber,
        integrationId: asset.discoveredByIntegrationId,
        inferred: false,
        observed: buildFortigateFirewallObserved(asset, asset.serialNumber),
      });
    } else if (asset.assetType === "switch") {
      out.push({
        sourceKind: "fortiswitch",
        externalId: asset.serialNumber,
        integrationId: asset.discoveredByIntegrationId,
        inferred: false,
        observed: buildFortiswitchObserved(asset, asset.serialNumber),
      });
    } else if (asset.assetType === "access_point") {
      out.push({
        sourceKind: "fortiap",
        externalId: asset.serialNumber,
        integrationId: asset.discoveredByIntegrationId,
        inferred: false,
        observed: buildFortiapObserved(asset, asset.serialNumber),
      });
    }
  }

  // 2. Recover an AD source when Entra has taken over the assetTag but a
  //    pre-merge AD record existed. The `ad-guid:<guid>` tag is the
  //    breadcrumb left by the cross-link handshake. We can't recover what
  //    AD originally said about the device (Entra's fields long since
  //    overwrote it), so the row is marked `inferred=true` and lands with
  //    an empty observed blob — a real AD discovery run replaces it.
  if (tag?.startsWith("entra:")) {
    for (const t of tags) {
      if (typeof t !== "string") continue;
      if (!t.startsWith("ad-guid:")) continue;
      const guid = t.slice("ad-guid:".length).trim();
      if (!guid) continue;
      // Avoid double-emitting if an "ad:" assetTag also somehow exists.
      if (out.some((s) => s.sourceKind === "ad" && s.externalId === guid.toLowerCase())) continue;
      out.push({
        sourceKind: "ad",
        externalId: guid.toLowerCase(),
        integrationId: null, // AD integration linkage not reconstructable
        inferred: true,
        observed: { objectGuid: guid.toLowerCase(), recovered: "ad-guid-tag" },
      });
    }
  }

  // 3. vCenter-discovered assets (tag "vcenter") are owned by explicit
  //    vcenter-vm / vcenter-host source rows written by syncVcenterDevices.
  //    There is no legacy tag convention to derive from — suppress the
  //    manual fallback so the shadow-write doesn't mint a spurious manual
  //    row in the window before the explicit upsert lands.
  if (out.length === 0 && tags.includes("vcenter")) {
    return [];
  }

  // 3a. Unraid / TrueNAS SCALE assets — explicit workload source rows written
  //     by syncWorkloadDevices; same suppression for the same reason.
  if (out.length === 0 && (tags.includes("unraid") || tags.includes("truenas"))) {
    return [];
  }

  // 3b. Azure Arc assets (tag "azurearc") are owned by an explicit `arc`
  //     source row written by syncArcDevices — same story as vCenter, no
  //     legacy assetTag convention to derive from. Suppress the manual
  //     fallback so the shadow-write can't mint a spurious manual row in the
  //     window between Asset.create and the explicit arc upsert.
  if (out.length === 0 && tags.includes("azurearc")) {
    return [];
  }

  // 4. Manual fallback when no source tag matched.
  if (out.length === 0) {
    out.push({
      sourceKind: "manual",
      externalId: asset.id,
      integrationId: null,
      inferred: false,
      observed: asset.createdBy ? { createdBy: asset.createdBy } : {},
    });
  }

  return out;
}

function findSidTag(tags: string[]): string | null {
  for (const t of tags) {
    if (typeof t !== "string") continue;
    if (t.startsWith("sid:")) return t.slice("sid:".length).trim() || null;
  }
  return null;
}

function buildEntraObserved(asset: AssetSnapshot, deviceId: string, tags: string[]): Record<string, unknown> {
  const sid = findSidTag(tags);
  const out: Record<string, unknown> = {
    deviceId: deviceId.toLowerCase(),
    displayName: asset.hostname,
    operatingSystem: asset.os,
    operatingSystemVersion: asset.osVersion,
    accountEnabled: asset.status !== "disabled" && asset.status !== "decommissioned",
  };
  if (sid) out.onPremisesSecurityIdentifier = sid;
  return out;
}

function buildAdObserved(asset: AssetSnapshot, guid: string, tags: string[]): Record<string, unknown> {
  const sid = findSidTag(tags);
  const out: Record<string, unknown> = {
    objectGuid: guid.toLowerCase(),
    cn: asset.hostname,
    dnsHostName: asset.dnsName ?? asset.hostname,
    ouPath: asset.learnedLocation,
    operatingSystem: asset.os,
    operatingSystemVersion: asset.osVersion,
    accountDisabled: asset.status === "disabled" || asset.status === "decommissioned",
    whenCreated: asset.acquiredAt?.toISOString() ?? null,
    lastLogonTimestamp: asset.lastSeen?.toISOString() ?? null,
  };
  if (sid) out.objectSid = sid;
  return out;
}

function buildFortigateFirewallObserved(asset: AssetSnapshot, serial: string): Record<string, unknown> {
  return {
    serial,
    hostname: asset.hostname,
    model: asset.model,
    osVersion: asset.osVersion,
    mgmtIp: asset.ipAddress,
    latitude: asset.latitude,
    longitude: asset.longitude,
  };
}

function buildFortiswitchObserved(asset: AssetSnapshot, serial: string): Record<string, unknown> {
  return {
    serial,
    switchId: asset.hostname,
    model: asset.model,
    osVersion: asset.osVersion,
    mgmtIp: asset.ipAddress,
    controllerFortigate: asset.learnedLocation,
  };
}

function buildFortiapObserved(asset: AssetSnapshot, serial: string): Record<string, unknown> {
  return {
    serial,
    name: asset.hostname,
    model: asset.model,
    osVersion: asset.osVersion,
    mgmtIp: asset.ipAddress,
    controllerFortigate: asset.learnedLocation,
  };
}
