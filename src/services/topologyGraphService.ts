/**
 * src/services/topologyGraphService.ts — Device Map topology graph builder
 *
 * Owns the full graph construction behind GET /map/sites/:id/topology
 * (src/api/routes/map.ts delegates here via buildSiteTopology): the
 * FortiGate root + sibling FortiSwitch/FortiAP nodes, switch endpoints and
 * wireless stations, subnets, and every edge class — controller-data
 * FortiLink edges, interface-name-inferred edges, LLDP edges + ghost
 * nodes, wireless-bridge edges, MCLAG ICL edges, per-edge interface
 * details, HA-standby suppression, and the shared savedLayouts embed.
 *
 * Extracted VERBATIM from the GET /sites/:id/topology handler in
 * src/api/routes/map.ts (2026-08 audit — Layer Violations: graph-
 * construction business logic + raw $queryRaw inline in a route file).
 * buildSiteTopology throws the same AppError(404, "FortiGate not found")
 * the handler threw, so route error responses are byte-identical.
 *
 * Read-only — no writer responsibilities: builds the payload from
 * Asset.fortinetTopology + the LLDP / MCLAG / interface-sample tables and
 * the TopologyLayout embed; nothing here queries a live device or mutates
 * the DB. monitorStatusToHealth / fetchRecentSampleStats are exported for
 * map.ts's GET /sites pin-health payload, which shares them.
 */

import { EXCLUDED_LIFECYCLE_STATUSES } from "../utils/assetInvariants.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { pairCableMembers, type CableMember } from "../utils/cableMembers.js";
import { controllerStampWhereOr, readFirewallDeviceName } from "../utils/fortinetParentKey.js";
import { loadIconResolutionCache, resolveIconUrl } from "./deviceIconService.js";
import { inferInterfaceTopology } from "./interfaceTopologyService.js";
import { resolveEffectiveLocation, hasLocationCodes, type LocationCodes } from "../utils/locationCodes.js";
import { getLayoutsForSite } from "./topologyLayoutService.js";

// ─── Which of a site's switches an endpoint sits on (business rule 91) ──────
//
// `Asset.lastSeenSwitch` carries a switch NAME, and a FortiLink fleet that
// renames its switch-ids per site has an "IDF-1" behind every gate — so a
// hostname-prefix match attributed every site's IDF-1 endpoints to EVERY
// site's IDF-1 (the counts were right only where names were unique). The
// dependency recompute already turns that name into one switch asset per
// endpoint, settling a shared name by the endpoint's MAC table, its sightings
// and its IPAM gate; the Device Map reads that edge. The prefix is still
// honoured — but only for a name UNIQUE among switches fleet-wide, which keeps
// an endpoint visible between discovery finalizes (the edge is refreshed on
// that cadence) and keeps a VM, which the endpoint half leaves to its vCenter
// host edge, under the switch port its MAC was learned on.

/** A site's switches, as the attribution needs them. */
export interface SiteSwitchRef { id: string; hostname: string | null }

export interface SiteEndpointAttribution {
  siteSwitchIds: string[];
  /** The site's switch hostnames that no OTHER non-retired switch carries (case-insensitively); original case. */
  uniqueHostnames: string[];
  /** lower-cased unique hostname → the site switch's id. */
  switchIdByUniqueHost: Map<string, string>;
  /** Prisma `OR` branches selecting the endpoints that sit under one of this site's switches. Empty ⇒ none can. */
  whereOr: Array<Record<string, unknown>>;
  /** The `dependencyParents` select that carries the attributing edge, for `attributeEndpointToSiteSwitch`. */
  edgeSelect: { where: Record<string, unknown>; select: { parentAssetId: true } };
}

/**
 * Which of `switches`' hostnames are unique among every non-retired switch —
 * the only names a bare `lastSeenSwitch` prefix may be trusted on.
 */
export async function buildSiteEndpointAttribution(switches: SiteSwitchRef[]): Promise<SiteEndpointAttribution> {
  const siteSwitchIds = switches.map((s) => s.id);
  const named = switches.filter((s): s is SiteSwitchRef & { hostname: string } => !!s.hostname);
  const lowered = [...new Set(named.map((s) => s.hostname.toLowerCase()))];
  const uniqueRows = lowered.length > 0
    ? await prisma.$queryRaw<Array<{ host: string }>>`
        SELECT lower(hostname) AS host
        FROM assets
        WHERE "assetType" = 'switch'
          AND "status" NOT IN ('decommissioned', 'disabled')
          AND lower(hostname) = ANY(${lowered}::text[])
        GROUP BY lower(hostname)
        HAVING COUNT(*) = 1
      `
    : [];
  const uniqueLower = new Set(uniqueRows.map((r) => r.host));
  const switchIdByUniqueHost = new Map<string, string>();
  const uniqueHostnames: string[] = [];
  for (const s of named) {
    const key = s.hostname.toLowerCase();
    if (!uniqueLower.has(key) || switchIdByUniqueHost.has(key)) continue;
    switchIdByUniqueHost.set(key, s.id);
    uniqueHostnames.push(s.hostname);
  }
  const edgeWhere = {
    parentAssetId: { in: siteSwitchIds },
    source: "endpoint",
    detectedVia: "switch-port",
  };
  const whereOr: Array<Record<string, unknown>> = [];
  if (siteSwitchIds.length > 0) whereOr.push({ dependencyParents: { some: edgeWhere } });
  for (const h of uniqueHostnames) whereOr.push({ lastSeenSwitch: { startsWith: `${h}/` } });
  return {
    siteSwitchIds,
    uniqueHostnames,
    switchIdByUniqueHost,
    whereOr,
    edgeSelect: { where: edgeWhere, select: { parentAssetId: true } },
  };
}

/**
 * The site switch one endpoint row sits on: its `switch-port` dependency edge
 * when it has one to a site switch, else the switch whose fleet-unique
 * hostname its `lastSeenSwitch` names. Null when neither places it — a shared
 * name the recompute could not settle stays OFF the map rather than on the
 * wrong switch. Pure.
 */
export function attributeEndpointToSiteSwitch(
  row: { lastSeenSwitch: string | null; dependencyParents?: Array<{ parentAssetId: string }> },
  attribution: Pick<SiteEndpointAttribution, "siteSwitchIds" | "switchIdByUniqueHost">,
): string | null {
  const edge = row.dependencyParents?.find((d) => attribution.siteSwitchIds.includes(d.parentAssetId));
  if (edge) return edge.parentAssetId;
  const lss = row.lastSeenSwitch || "";
  const slashIdx = lss.indexOf("/");
  if (slashIdx <= 0) return null;
  return attribution.switchIdByUniqueHost.get(lss.slice(0, slashIdx).toLowerCase()) ?? null;
}

/** The port half of a `lastSeenSwitch` value ("" when it carries none). */
export function portOfLastSeenSwitch(v: string | null | undefined): string {
  const lss = v || "";
  const slashIdx = lss.indexOf("/");
  return slashIdx > 0 ? lss.slice(slashIdx + 1) : "";
}

type TopologyMeta = {
  role?: "fortigate" | "fortiswitch" | "fortiap";
  controllerFortigate?: string | null;
  uplinkInterface?: string | null;
  // Switch's PHYSICAL uplink port to its controller FortiGate (e.g. "port47"),
  // from the managed-switch CMDB. Distinct from uplinkInterface (the FortiGate-
  // side logical "fortilink"). Used to label the switch side of the FG↔switch
  // edge; null for chained / dual-homed switches (FG-side + those fall to LLDP).
  uplinkPhysicalPort?: string | null;
  parentSwitch?: string | null;
  parentPort?: string | null;
  parentVlan?: number | null;
  // FortiOS's own uplink classification for an AP: "ethernet" = wired
  // uplink, "mesh" = wireless-mesh leaf (uplink is its parent AP; any wired
  // LLDP adjacency is a switch bridged BEHIND it, not an uplink).
  meshUplink?: "ethernet" | "mesh" | null;
  // Raw admin description from the managed-switch CMDB / wtp `comment`,
  // stamped by discovery. Carries a:/b:/f:/r:/jb: location codes — resolved
  // per node below via resolveEffectiveLocation (Asset.description → this;
  // notes are operator-only and never inform the map). notesSyncedFrom is a
  // legacy provenance marker from the retired description→notes sync — may
  // linger on old rows, no longer written or read.
  deviceDescription?: string | null;
  notesSyncedFrom?: string | null;
};

// Effective location codes for a topology node, or null when the node
// carries none — keeps untagged fleets' payloads noise-free.
function nodeLocation(codes: LocationCodes): LocationCodes | null {
  return hasLocationCodes(codes) ? codes : null;
}

function readTopology(raw: unknown): TopologyMeta {
  if (raw && typeof raw === "object") return raw as TopologyMeta;
  return {};
}

// Operator-friendly name for a port-side of a topology edge. "fortilink"
// is FortiOS's software-managed FortiLink meta-interface — not a physical
// port — so it's normalized to "unknown" the same way an empty/null
// value is. Anything else (real ifName, alias, MAC) passes through.
function normalizePortName(name: string | null | undefined): string {
  if (!name) return "unknown";
  const trimmed = String(name).trim();
  if (!trimmed) return "unknown";
  if (trimmed.toLowerCase() === "fortilink") return "unknown";
  return trimmed;
}

export type MonitorHealth = "up" | "degraded" | "down" | "unknown" | "passive";

// Map view's traffic-light: examines the last 10 AssetMonitorSample rows for
// the asset (independent of the global failureThreshold used by the rest of
// the app — the map intentionally uses a fixed 10-sample window for a stable
// at-a-glance signal).
//   - all 10 failed                → down (red)
//   - some failed, not all         → degraded (amber, "packet loss")
//   - all succeeded                → up (green)
//   - no samples or fewer than 10  → degraded if any failed, up if all good,
//                                    unknown if zero samples
function computeMonitorHealth(samples: { success: boolean }[]): MonitorHealth {
  if (samples.length === 0) return "unknown";
  const failed = samples.reduce((n, s) => n + (s.success ? 0 : 1), 0);
  if (samples.length >= 10 && failed === samples.length) return "down";
  if (failed === 0) return "up";
  return "degraded";
}

// Translate Asset.monitorStatus (six-state machine) to the MonitorHealth used
// by the topology graph color function.
//
// "passive" is its OWN member rather than folding into "unknown": every map and
// topology surface paints unknown grey with a "no samples yet" tooltip, which
// is flatly wrong about a device that is being polled and charted and simply
// has no down-detection automation covering it.
export function monitorStatusToHealth(status: string | null): MonitorHealth {
  switch (status) {
    case "up":         return "up";
    case "warning":
    case "recovering": return "degraded";
    case "down":       return "down";
    case "passive":    return "passive";
    default:           return "unknown";
  }
}

// Fetch last-10 samples per asset and return a Map keyed by assetId. Issued
// in parallel — N round-trips, but N is the FortiGate count and the endpoint
// is rarely hit (one call per map page load).
export async function fetchRecentSampleStats(
  assetIds: string[],
): Promise<Map<string, { samples: number; failures: number; health: MonitorHealth }>> {
  const out = new Map<string, { samples: number; failures: number; health: MonitorHealth }>();
  await Promise.all(
    assetIds.map(async (id) => {
      const rows = await prisma.assetMonitorSample.findMany({
        // Response-time poll only. This window is a fixed COUNT, not a
        // duration, so counting the ICMP loss sampler's 10s rows would shrink
        // the span these 10 samples cover from ~10 minutes to ~100 seconds
        // exactly when an asset is in trouble — the traffic light would start
        // reporting a different thing than it does the rest of the time.
        where: { assetId: id, OR: [{ probeKind: null }, { probeKind: "primary" }] },
        orderBy: { timestamp: "desc" },
        take: 10,
        select: { success: true },
      });
      const failures = rows.reduce((n, s) => n + (s.success ? 0 : 1), 0);
      out.set(id, { samples: rows.length, failures, health: computeMonitorHealth(rows) });
    }),
  );
  return out;
}

// Graph payload for the click-through modal. Shape:
//   {
//     fortigate: { id, hostname, serial, model, ip, status, lastSeen, location, subnets: [...] },
//     switches:  [{ id, hostname, serial, ip, uplinkInterface, status, model,
//                   location, deviceDescription }, ...],
//     aps:       [{ id, hostname, serial, ip, model, status, peerSwitchId, peerPort,
//                   peerVlan, peerAssetId, location, deviceDescription }, ...],
//     edges:     [{ source, target, label? }, ...]
//   }
//
// `location` is { area, building, floor, room, junctionBox } (each
// string|null) or null when the node carries no a:/b:/f:/r:/jb: codes —
// resolved server-side by utils/locationCodes.ts: the Asset.description's
// codes when it carries any (exclusively — no per-key fall-through), else
// the device admin description discovery stamped on
// fortinetTopology.deviceDescription. Notes are never a source. Drives the
// topology modal's grouping hulls + floor views.
//
// Every edge references an asset id in this payload, so the frontend can hand
// the whole object to a graph renderer (Cytoscape) without doing any extra
// lookups. APs that could not be paired to a switch port fall back to a direct
// edge from the FortiGate.
export async function buildSiteTopology(siteId: string) {
    const id = siteId;
    const fg = await prisma.asset.findFirst({
      where: { id, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: {
        id: true,
        hostname: true,
        serialNumber: true,
        manufacturer: true,
        model: true,
        ipAddress: true,
        status: true,
        lastSeen: true,
        latitude: true,
        longitude: true,
        assetType: true,
        fortinetTopology: true,
        monitored: true,
        dependencyLayer: true,
        dependencySuppressed: true,
        notes: true,
        description: true,
      },
    });
    if (!fg || fg.assetType !== "firewall") {
      throw new AppError(404, "FortiGate not found");
    }

    const fgMonitorStats = fg.monitored
      ? (await fetchRecentSampleStats([fg.id])).get(fg.id) ?? null
      : null;

    // Pre-load every uploaded device icon once so per-node resolution
    // below is sync + cache-hit (no per-asset DB roundtrip).
    const iconCache = await loadIconResolutionCache();

    const fgHostname = fg.hostname || "";
    const fgSerial = fg.serialNumber || "";
    // The FMG device name off the gate's OWN topology stamp — the key its
    // children actually carry in `controllerFortigate`. See below.
    const fgDeviceName = readFirewallDeviceName(fg.fortinetTopology);

    // Siblings: every FortiSwitch + FortiAP whose fortinetTopology points at
    // this FortiGate. Matched by stamped identity (not asset id) because the
    // discovery pipeline stamps the controller, not a foreign key.
    //
    // This used to match `controllerFortigate` against `fg.hostname` ALONE,
    // which is the one key that is NOT guaranteed to be it: children stamp
    // FMG's device NAME, while a firewall's hostname is projected from the
    // gate's own configured hostname. On an install where an operator named the
    // FMG device differently, this query returned zero siblings and the Device
    // Map drew the gate with none of its switches or APs (prod 2026-08-12).
    // Now: definitive serial, the gate's own FMG-device-name stamp (correct on
    // pre-fix data, so no re-discovery needed), then hostname.
    const controllerKeyOr = controllerStampWhereOr({
      hostname: fgHostname,
      serialNumber: fgSerial,
      deviceName: fgDeviceName,
    });
    const siblings = controllerKeyOr.length > 0
      ? await prisma.asset.findMany({
          where: {
            OR: [{ assetType: "switch" }, { assetType: "access_point" }],
            AND: [{ OR: controllerKeyOr }],
            status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
          },
          select: {
            id: true,
            hostname: true,
            serialNumber: true,
            manufacturer: true,
            model: true,
            ipAddress: true,
            status: true,
            assetType: true,
            fortinetTopology: true,
            learnedLocation: true,
            lastSeen: true,
            monitored: true,
            monitorStatus: true,
            dependencyLayer: true,
            dependencySuppressed: true,
            notes: true,
            description: true,
          },
        })
      : [];

    type EndpointSummary = {
      id: string;
      hostname: string | null;
      ipAddress: string | null;
      macAddress: string | null;
      assetType: string | null;
      assignedTo: string | null;
      port: string;
      lastSeen: Date | null;
    };
    const switches = siblings
      .filter((s) => s.assetType === "switch")
      .map((s) => {
        const t = readTopology(s.fortinetTopology);
        return {
          id: s.id,
          hostname: s.hostname,
          serial: s.serialNumber,
          model: s.model,
          ip: s.ipAddress,
          status: s.status,
          lastSeen: s.lastSeen,
          uplinkInterface: t.uplinkInterface ?? null,
          uplinkPhysicalPort: t.uplinkPhysicalPort ?? null,
          monitored: s.monitored,
          monitorHealth: s.monitored ? monitorStatusToHealth(s.monitorStatus) : null,
          dependencyLayer: s.dependencyLayer,
          dependencySuppressed: s.dependencySuppressed,
          iconUrl: resolveIconUrl({ manufacturer: s.manufacturer, model: s.model, assetType: "switch" }, iconCache),
          // Physical-location codes (a:/b:/f:/r:/jb:): Asset.description's
          // codes when present, else the device admin description. Drives
          // the Device Map's grouping hulls + floor views. Null when untagged.
          location: nodeLocation(resolveEffectiveLocation({ description: s.description, deviceDescription: t.deviceDescription })),
          deviceDescription: t.deviceDescription ?? null,
          endpointCount: 0,
          endpoints: [] as EndpointSummary[],
        };
      });

    const switchByName = new Map<string, string /* assetId */>();
    for (const s of switches) {
      if (s.hostname) switchByName.set(s.hostname, s.id);
    }

    // Endpoints attached to any of this site's FortiSwitches. Discovery
    // populates `Asset.lastSeenSwitch = "<switchHostname>/<portName>"` from
    // the FortiSwitch MAC table (Phase 7.5), and the dependency recompute
    // turns that name into ONE switch asset per endpoint (`source="endpoint"`,
    // `detectedVia="switch-port"`), settling a name several sites share by the
    // endpoint's MAC table / sightings / IPAM gate (business rule 91). That edge
    // is the attribution here; the hostname prefix is only trusted when the
    // name is unique among switches fleet-wide (see
    // buildSiteEndpointAttribution). Returns top-25 by recency per switch + the
    // total count, so the modal info panel can show "12 endpoints" with a
    // sample list while the search endpoint handles wildcards over the full set.
    const attribution = await buildSiteEndpointAttribution(switches);
    if (attribution.whereOr.length > 0) {
      const [endpointSamples, countRows] = await Promise.all([
        prisma.asset.findMany({
          where: {
            assetType: { notIn: ["firewall", "switch", "access_point"] },
            status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
            OR: attribution.whereOr,
          },
          select: {
            id: true,
            hostname: true,
            ipAddress: true,
            macAddress: true,
            assetType: true,
            assignedTo: true,
            lastSeenSwitch: true,
            lastSeen: true,
            dependencyParents: attribution.edgeSelect,
          },
          orderBy: { lastSeen: "desc" },
          take: switches.length * 25,
        }),
        // Same attribution in SQL: the edge first, the hostname prefix only
        // for a fleet-unique name. `split_part` rather than LIKE so a `_` or
        // `%` in a hostname cannot widen the match.
        prisma.$queryRaw<Array<{ switch_id: string; cnt: bigint }>>`
          SELECT COALESCE(dp."parentAssetId", sw.id) AS switch_id, COUNT(*)::bigint AS cnt
          FROM assets a
          LEFT JOIN asset_dependency_parents dp
            ON dp."assetId" = a.id
           AND dp.source = 'endpoint'
           AND dp."detectedVia" = 'switch-port'
           AND dp."parentAssetId" = ANY(${attribution.siteSwitchIds}::text[])
          LEFT JOIN assets sw
            ON sw.id = ANY(${attribution.siteSwitchIds}::text[])
           AND sw.hostname = ANY(${attribution.uniqueHostnames}::text[])
           AND split_part(a."lastSeenSwitch", '/', 1) = sw.hostname
          WHERE a."assetType" NOT IN ('firewall', 'switch', 'access_point')
            AND a."status" NOT IN ('decommissioned', 'disabled')
            AND (dp.id IS NOT NULL OR sw.id IS NOT NULL)
          GROUP BY 1
        `,
      ]);
      const countBySwitch = new Map<string, number>();
      for (const r of countRows) countBySwitch.set(r.switch_id, Number(r.cnt));
      const switchById = new Map<string, typeof switches[number]>();
      for (const s of switches) switchById.set(s.id, s);
      for (const ep of endpointSamples) {
        const switchId = attributeEndpointToSiteSwitch(ep, attribution);
        const sw = switchId ? switchById.get(switchId) : undefined;
        if (!sw) continue;
        if (sw.endpoints.length >= 25) continue; // per-switch cap
        sw.endpoints.push({
          id: ep.id,
          hostname: ep.hostname,
          ipAddress: ep.ipAddress,
          macAddress: ep.macAddress,
          assetType: String(ep.assetType),
          assignedTo: ep.assignedTo,
          port: portOfLastSeenSwitch(ep.lastSeenSwitch),
          lastSeen: ep.lastSeen,
        });
      }
      for (const s of switches) {
        s.endpointCount = countBySwitch.get(s.id) ?? 0;
      }
    }

    type StationSummary = {
      id: string | null;            // null when the MAC didn't match an inventory asset
      hostname: string | null;
      ipAddress: string | null;
      macAddress: string;
      assetType: string | null;
      ssid: string | null;
      lastSeen: Date | null;
    };
    const aps = siblings
      .filter((s) => s.assetType === "access_point")
      .map((s) => {
        const t = readTopology(s.fortinetTopology);
        const peerAssetId = t.parentSwitch ? switchByName.get(t.parentSwitch) ?? null : null;
        return {
          id: s.id,
          hostname: s.hostname,
          serial: s.serialNumber,
          model: s.model,
          ip: s.ipAddress,
          status: s.status,
          lastSeen: s.lastSeen,
          peerSwitch: t.parentSwitch ?? null,
          peerSwitchId: peerAssetId,
          peerPort: t.parentPort ?? null,
          peerVlan: t.parentVlan ?? null,
          // peerSource: "lldp" if the AP itself reported its uplink via
          // LLDP on its lan1 interface; "detected-device" if resolved
          // via the FortiSwitch MAC-table fallback. Drives the
          // edge-tooltip wording on the topology graph.
          peerSource: (t as any).peerSource ?? null,
          // "mesh" marks a wireless-mesh leaf: its real uplink is the mesh
          // backhaul to its parent AP, so wired controller/LLDP adjacencies
          // are treated as bridged-behind, not uplinks.
          meshUplink: t.meshUplink ?? null,
          monitored: s.monitored,
          monitorHealth: s.monitored ? monitorStatusToHealth(s.monitorStatus) : null,
          dependencyLayer: s.dependencyLayer,
          dependencySuppressed: s.dependencySuppressed,
          iconUrl: resolveIconUrl({ manufacturer: s.manufacturer, model: s.model, assetType: "access_point" }, iconCache),
          // Same location-code resolution as the switch nodes above.
          location: nodeLocation(resolveEffectiveLocation({ description: s.description, deviceDescription: t.deviceDescription })),
          deviceDescription: t.deviceDescription ?? null,
          stationCount: 0,
          stations: [] as StationSummary[],
        };
      });

    // Wireless stations per AP. Populated by the SNMP fapStationTable
    // scrape on monitored APs; empty arrays for APs on REST-API path or
    // unmonitored. Top-25 by lastSeen per AP — same shape as switch
    // endpoints. The topology renderer hangs each station off its AP as
    // a "wireless-station" node connected by a "wireless" edge.
    if (aps.length > 0) {
      const apIds = aps.map((a) => a.id);
      const stationRows = await prisma.assetWirelessStation.findMany({
        where: { apAssetId: { in: apIds } },
        orderBy: { lastSeen: "desc" },
        include: {
          matchedAsset: {
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          },
        },
      });
      const apById = new Map<string, typeof aps[number]>();
      for (const a of aps) apById.set(a.id, a);
      const countByAp = new Map<string, number>();
      for (const row of stationRows) {
        countByAp.set(row.apAssetId, (countByAp.get(row.apAssetId) ?? 0) + 1);
        const ap = apById.get(row.apAssetId);
        if (!ap || ap.stations.length >= 25) continue;
        ap.stations.push({
          id:         row.matchedAsset?.id ?? null,
          hostname:   row.matchedAsset?.hostname ?? null,
          ipAddress:  row.matchedAsset?.ipAddress ?? row.staIpAddr ?? null,
          macAddress: row.staMacAddr,
          assetType:  row.matchedAsset?.assetType ?? null,
          ssid:       row.ssid ?? null,
          lastSeen:   row.lastSeen,
        });
      }
      for (const a of aps) a.stationCount = countByAp.get(a.id) ?? 0;
    }

    // Subnets behind this FortiGate — shown in the modal sidebar, not as graph
    // nodes (a site with 30 subnets would blow up the graph). Include VLAN so
    // the UI can show the mapping at a glance.
    const subnets = fgHostname
      ? await prisma.subnet.findMany({
          where: { fortigateDevice: fgHostname },
          select: { id: true, cidr: true, name: true, vlan: true, status: true },
          orderBy: { cidr: "asc" },
        })
      : [];

    // Edges — FG→switch by uplinkInterface, AP→switch by peerPort, AP→FG for
    // unpaired APs.
    //
    // Edge labels are uniformly formatted `<sourcePort> ↔ <targetPort>` so
    // the operator can see at a glance which port on each side carries
    // the link. Missing sides render as "unknown" — better than a
    // one-sided label that hides the asymmetry. The "fortilink"
    // meta-interface name is folded into "unknown" since it's the
    // FortiLink software interface, not a physical port.
    //
    // `reason` populates the hover tooltip — the operator can audit
    // EXACTLY which rule + which evidence drew each edge.
    // `verifiedUplink` marks an FG→switch controller edge whose link to the
    // FortiGate is physically confirmed (interface- or LLDP-backed). The
    // FG↔switch interface edge itself is deduped into this controller edge, so
    // this flag is the only surviving "this is a real cable, not just FortiLink
    // fallback" signal the topology layout can read.
    type Edge = { source: string; target: string; label?: string; reason?: string; verifiedUplink?: boolean };
    let edges: Edge[] = [];
    const switchHostById = new Map<string, string | null>();
    for (const s of switches) switchHostById.set(s.id, s.hostname);
    const apHostById = new Map<string, string | null>();
    for (const a of aps) apHostById.set(a.id, a.hostname);
    const portLabel = (a: string | null | undefined, b: string | null | undefined): string =>
      `${normalizePortName(a)} ↔ ${normalizePortName(b)}`;
    for (const s of switches) {
      const ifLabel = s.uplinkInterface || "fortilink";
      const swLabel = s.hostname || s.id;
      const fgLabel = fg.hostname || fg.id;
      // Switch side: the real physical uplink port (e.g. "port47") from the
      // managed-switch CMDB when discovery resolved exactly one, else the
      // logical "fortilink" (normalized to "unknown"). FG side stays null →
      // the LLDP backfill below fills it (it only overwrites "unknown" halves),
      // so a CMDB switch-side port and an LLDP FG-side port compose cleanly.
      const swSidePort = s.uplinkPhysicalPort || s.uplinkInterface;
      edges.push({
        source: fg.id,
        target: s.id,
        label: portLabel(null, swSidePort),
        reason:
          `Rule: controller-data FG→switch edge.\n` +
          `Evidence: switch ${swLabel} carries Asset.fortinetTopology.controllerFortigate = "${fgLabel}" ` +
          `and uplinkInterface = "${ifLabel}"` +
          (s.uplinkPhysicalPort ? `, physical uplink port "${s.uplinkPhysicalPort}" (managed-switch CMDB)` : "") +
          ` (sourced from managed-switch/status.fgt_peer_intf_name during discovery).\n` +
          `Caveat: FortiOS reports "fortilink" on every managed switch — direct or chained — so this signal alone over-connects multi-switch fleets. ` +
          `If a more specific signal (interface-name peer-aggregate, see teal edges) marks a different switch as the direct uplink, this edge is demoted automatically.`,
      });
    }
    for (const ap of aps) {
      const apLabel = ap.hostname || ap.id;
      // A mesh leaf's (parentSwitch, parentPort) — when present from data
      // stamped before the mesh-aware discovery fix — is INVERTED: the switch
      // the AP sees over LLDP is bridged behind its LAN port, not upstream.
      // Don't draw the backwards switch→AP edge; the wireless-bridge edge
      // below carries the real relationship, and the client suppresses the
      // FG fallback once the mesh backhaul edge is drawn from station data.
      if (ap.peerSwitchId && ap.meshUplink !== "mesh") {
        const peerSwLabel = switchHostById.get(ap.peerSwitchId) || ap.peerSwitchId;
        edges.push({
          source: ap.peerSwitchId,
          target: ap.id,
          // FortiAP's wired uplink is virtually always lan1 in
          // FortiLink-managed deployments. Use that as the AP-side port
          // unless we have something better.
          label: portLabel(ap.peerPort, "lan1"),
          reason:
            `Rule: AP→switch edge from FortiSwitch MAC learning.\n` +
            `Evidence: AP ${apLabel}'s base MAC was seen on switch ${peerSwLabel} port "${ap.peerPort || "?"}" ` +
            `(switch-controller/detected-device, learned at discovery). ` +
            (ap.peerSource === "lldp"
              ? `Confirmed by LLDP advertisement on the AP's lan1 interface.`
              : `Resolved via the detected-device MAC table fallback path.`),
        });
      } else {
        edges.push({
          source: fg.id,
          target: ap.id,
          label: portLabel(null, "lan1"),
          reason:
            `Rule: AP→FortiGate fallback edge.\n` +
            `Evidence: AP ${apLabel}'s base MAC was NOT found on any managed FortiSwitch's MAC table at last discovery, ` +
            `and no LLDP neighbor was reported on its lan1 interface. ` +
            `Drawing a direct AP→FG edge so the AP still appears on the graph; real attachment unknown.`,
        });
      }
    }

    const siteAssetIds = [fg.id, ...switches.map((s) => s.id), ...aps.map((a) => a.id)];

    // HA standby members are their own firewall Assets (ipAddress=null,
    // fortinetTopology.haRole="secondary"; see the per-member write loop in
    // integrations.ts) but are redundant on the topology — the cluster is
    // represented by its active/primary member, which already carries every
    // FortiLink edge. The standby would otherwise surface as an LLDP- or
    // interface-matched remote node hanging off the same switches as the
    // primary, duplicating the cluster. Collect standby ids so we can drop
    // them (and any edge that targets them) from the graph. Keyed on haRole so
    // it covers both the FMG and standalone-FortiGate discovery paths, which
    // share the per-member write loop.
    const standbyMembers = await prisma.asset.findMany({
      where: {
        assetType: "firewall",
        fortinetTopology: { path: ["haRole"], equals: "secondary" },
      },
      select: { id: true, hostname: true },
    });
    const standbyIds = new Set(standbyMembers.map((a) => a.id));
    // Standby hostnames (+ short-form) catch the case where an LLDP row for the
    // standby never matched a Polaris asset and would otherwise render as a
    // ghost node bearing the standby's name. Mirrors the FQDN/short-form
    // handling used for sibling dedupe below.
    const standbyHostnames = new Set<string>();
    for (const m of standbyMembers) {
      if (!m.hostname) continue;
      const lower = m.hostname.toLowerCase().trim();
      if (!lower) continue;
      standbyHostnames.add(lower);
      const dotIdx = lower.indexOf(".");
      if (dotIdx > 0) standbyHostnames.add(lower.slice(0, dotIdx));
    }

    // CMDB-inferred edges from FortiOS interface naming conventions —
    // peer-serial aggregates (FortiLink-auto) plus operator-named
    // hostname aggregates (custom MCLAG between non-stacked pairs). Run
    // first so interface edges populate `existingEdge` before LLDP de-dup
    // and so the LLDP path can reuse the same dedupe set.
    const ifaceInference = await inferInterfaceTopology(siteAssetIds);

    // Refine the controller-data FG→switch edges using interface-naming
    // signal. FortiOS reports `fortilink` on every managed switch's
    // `fgt_peer_intf_name` regardless of whether it's directly cabled or
    // chained behind another FortiSwitch — so the controller-data edges
    // can over-connect a multi-switch fleet (e.g. a stacked pair where
    // only one switch is directly cabled to the FG ends up with two
    // FG→switch edges). The fix: a switch with a FortiOS-auto aggregate
    // whose name encodes the FG's serial is a confirmed-direct uplink;
    // siblings reachable from a confirmed-direct switch through inter-
    // switch interface edges are downstream and don't get a direct FG
    // edge. Switches with NO interface-edge to a confirmed-direct
    // sibling fall through and keep their controller edge — we don't
    // want to silently disconnect a switch whose aggregates we couldn't
    // parse (custom names, older firmware, etc).
    const interfaceConfirmedFgPeers = new Set<string>();
    for (const e of ifaceInference.edges) {
      if (e.sourceAssetId === fg.id) interfaceConfirmedFgPeers.add(e.targetAssetId);
      if (e.targetAssetId === fg.id) interfaceConfirmedFgPeers.add(e.sourceAssetId);
    }
    if (interfaceConfirmedFgPeers.size > 0) {
      // Build an inter-switch adjacency map from interface-only edges so we
      // can BFS from each confirmed-direct switch and find downstream
      // siblings through arbitrary chain depth.
      const interfacePeersOf = new Map<string, Set<string>>();
      for (const e of ifaceInference.edges) {
        if (e.sourceAssetId === fg.id || e.targetAssetId === fg.id) continue;
        if (!interfacePeersOf.has(e.sourceAssetId)) interfacePeersOf.set(e.sourceAssetId, new Set());
        if (!interfacePeersOf.has(e.targetAssetId)) interfacePeersOf.set(e.targetAssetId, new Set());
        interfacePeersOf.get(e.sourceAssetId)!.add(e.targetAssetId);
        interfacePeersOf.get(e.targetAssetId)!.add(e.sourceAssetId);
      }
      const reachableFromConfirmed = new Set<string>(interfaceConfirmedFgPeers);
      const queue = [...interfaceConfirmedFgPeers];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const n of interfacePeersOf.get(cur) ?? []) {
          if (!reachableFromConfirmed.has(n)) {
            reachableFromConfirmed.add(n);
            queue.push(n);
          }
        }
      }
      const switchIds = new Set(switches.map((s) => s.id));
      edges = edges.filter((e) => {
        if (e.source !== fg.id) return true;            // not an FG-out edge
        if (!switchIds.has(e.target)) return true;      // FG→AP keep as-is
        if (interfaceConfirmedFgPeers.has(e.target)) return true;
        // Demote when reachable through a confirmed-direct sibling; otherwise
        // keep as fallback to avoid orphaning an unparseable switch.
        return !reachableFromConfirmed.has(e.target);
      });
    }
    type InterfaceEdge = {
      source: string;
      target: string;
      sourceIfName: string;
      label: string;
      via: "interface";
      // "serial" / "hostname" — interface-name inference; "lldp" — a per-cable
      // edge from the parallel-links expansion below (LLDP port-pair evidence).
      matchVia: "serial" | "hostname" | "lldp";
      reason: string;
    };
    const interfaceEdges: InterfaceEdge[] = [];
    const seenIfacePair = new Set<string>();
    for (const e of ifaceInference.edges) {
      // Don't draw edges to an HA standby member — it's suppressed as a node.
      if (standbyIds.has(e.sourceAssetId) || standbyIds.has(e.targetAssetId)) continue;
      // Don't redraw an edge that fortinetTopology already covered.
      const key = `${e.sourceAssetId}|${e.targetAssetId}`;
      const reverseKey = `${e.targetAssetId}|${e.sourceAssetId}`;
      if (seenIfacePair.has(key) || seenIfacePair.has(reverseKey)) continue;
      // Skip if controller-data already gave us this pair (FortiLink uplink
      // covered by `edges` above). The interface name still appears in the
      // edge's label there, just from a different code path.
      // existingEdge isn't built yet at this point — check `edges` directly.
      const dup = edges.some(
        (g) =>
          (g.source === e.sourceAssetId && g.target === e.targetAssetId) ||
          (g.source === e.targetAssetId && g.target === e.sourceAssetId),
      );
      if (dup) continue;
      const sourceLabel =
        switchHostById.get(e.sourceAssetId) ||
        apHostById.get(e.sourceAssetId) ||
        (e.sourceAssetId === fg.id ? (fg.hostname || fg.id) : e.sourceAssetId);
      const reason = e.matchVia === "serial"
        ? `Rule: interface-name peer-serial match (interfaceTopologyService).\n` +
          `Evidence: device ${sourceLabel} has interface "${e.sourceIfName}". ` +
          `The pattern matches FortiOS's auto-named peer aggregate (uppercase alnum, optional trailing -<digits>). ` +
          `Stripping any "-N" aggregate suffix gives the peer-fragment, which case-insensitively matches the END of the target asset's serial number.\n` +
          `Skipped if multiple inventory assets end with the same fragment (ambiguous) or if the match is the source asset itself.`
        : `Rule: interface-name peer-hostname match (interfaceTopologyService, fallback when serial match yielded nothing).\n` +
          `Evidence: device ${sourceLabel} has interface "${e.sourceIfName}" — uppercase with internal dashes (operator-typed, not FortiOS-auto). ` +
          `Hostname match: target asset's hostname equals the fragment exactly OR starts with "${e.sourceIfName}-" / "${e.sourceIfName}.".\n` +
          `Skipped if multiple inventory hostnames qualify (ambiguous prefix collision).`;
      seenIfacePair.add(key);
      interfaceEdges.push({
        source: e.sourceAssetId,
        target: e.targetAssetId,
        sourceIfName: e.sourceIfName,
        label: portLabel(e.sourceIfName, e.targetIfName),
        via: "interface",
        matchVia: e.matchVia,
        reason,
      });
    }

    // Cross-site assets matched via interface name — registered as
    // remoteAssetNodes (same surface used for cross-site LLDP matches) so
    // the frontend has a real node to draw the edge to.
    type RemoteAssetNode = {
      id: string;
      hostname: string | null;
      ipAddress: string | null;
      assetType: string | null;
      model: string | null;
      iconUrl: string | null;
    };
    const remoteAssetNodes = new Map<string, RemoteAssetNode>();
    for (const r of ifaceInference.remoteAssets.values()) {
      if (standbyIds.has(r.id)) continue; // HA standby member — redundant with the primary
      remoteAssetNodes.set(r.id, {
        id: r.id,
        hostname: r.hostname,
        ipAddress: r.ipAddress,
        assetType: r.assetType,
        model: r.model,
        iconUrl: resolveIconUrl(
          { manufacturer: r.manufacturer, model: r.model, assetType: r.assetType },
          iconCache,
        ),
      });
    }

    // LLDP-derived neighbors. We pull neighbors for the FortiGate plus every
    // switch in this site, then build:
    //   - A "ghost" node for any neighbor that did NOT match a Polaris asset
    //     (e.g. an upstream ISP router, a third-party access switch). These
    //     are uniquely identified by chassisId; multiple ports onto the same
    //     remote chassis collapse to a single node.
    //   - One LLDP edge per neighbor row, source = local asset, target =
    //     matched asset OR the ghost node. Edges are de-duped against
    //     fortinetTopology edges AND interface-inferred edges so a peer
    //     link confirmed by both signals only renders once (the
    //     authoritative one wins).
    const lldpRows = await prisma.assetLldpNeighbor.findMany({
      where: { assetId: { in: siteAssetIds } },
      include: {
        matchedAsset: {
          select: { id: true, hostname: true, ipAddress: true, assetType: true, manufacturer: true, model: true },
        },
      },
    });

    type LldpNode = {
      id: string;
      hostname: string | null;
      managementIp: string | null;
      chassisId: string | null;
      systemDescription: string | null;
      capabilities: string[];
    };
    // Synthesized "ghost" nodes for non-Polaris LLDP neighbors. Stable
    // ids prefixed with `lldp:` so they don't collide with real asset
    // UUIDs, and dedup'd by chassisId so multi-link aggregates collapse.
    const lldpNodes = new Map<string, LldpNode>();
    // Cross-site LLDP-matched Polaris assets are added to `remoteAssetNodes`
    // (declared above alongside interface-inferred remotes) so cross-site
    // assets matched by EITHER pathway end up in the same node list.
    const siblingIds = new Set(siteAssetIds);
    // Seed the LLDP dedupe set with both controller edges AND interface-
    // inferred edges so a peer link confirmed by multiple signals only
    // renders once (interface > LLDP because interface is CMDB-stamped).
    const existingEdge = new Set([
      ...edges.map((e) => `${e.source}|${e.target}`),
      ...interfaceEdges.map((e) => `${e.source}|${e.target}`),
    ]);

    // Wireless-bridge detection: a FortiLink-managed switch sitting BEHIND a
    // FortiAP (its wired uplink lands on the AP's LAN port) shows up as an LLDP
    // neighbor of that AP — the inverse of the normal switch→AP uplink. We
    // detect it as an LLDP adjacency between an AP and a switch where the switch
    // is NOT the AP's controller parent, render it as a bridge edge AP→switch,
    // and (client-side) route the switch behind the AP, demoting its FortiLink
    // edge. Normal switch→AP uplinks (switch IS the AP's parentSwitch) are left
    // to the controller data as before.
    type BridgeEdge = { source: string; target: string; label?: string; reason?: string };
    const bridgeEdges: BridgeEdge[] = [];
    const apObjById = new Map(aps.map((a) => [a.id, a]));
    const switchObjById = new Map(switches.map((s) => [s.id, s]));
    const seenBridge = new Set<string>();
    for (const n of lldpRows) {
      if (!n.matchedAsset || !n.matchedAsset.id) continue;
      if (!siblingIds.has(n.matchedAsset.id)) continue; // both ends in-site
      const ap = apObjById.get(n.assetId) ?? apObjById.get(n.matchedAsset.id);
      const sw = switchObjById.get(n.assetId) ?? switchObjById.get(n.matchedAsset.id);
      if (!ap || !sw) continue; // not an AP↔switch pair
      // Normal switch→AP uplink (AP behind switch) — controller data covers it.
      // EXCEPT for a wireless-mesh leaf: its uplink is the mesh backhaul, so a
      // wired LLDP adjacency to a switch is always the switch bridged behind
      // it — even when stale discovery data stamped that switch as the AP's
      // parentSwitch (the pre-mesh-fix inversion).
      if (ap.meshUplink !== "mesh" && ap.peerSwitch && sw.hostname && ap.peerSwitch.toLowerCase() === sw.hostname.toLowerCase()) continue;
      const key = `${ap.id}|${sw.id}`;
      if (seenBridge.has(key)) continue;
      seenBridge.add(key);
      bridgeEdges.push({
        source: ap.id,
        target: sw.id,
        label: portLabel(n.localIfName, n.portId),
        reason:
          `Rule: wireless-bridge edge — FortiLink switch behind a FortiAP.\n` +
          `Evidence: ${ap.hostname || ap.id} reports LLDP neighbor ${sw.hostname || sw.id} on local port "${n.localIfName || "?"}", ` +
          `and that switch is not the AP's controller uplink — so the switch is bridged behind the AP.`,
      });
    }
    type LldpEdge = {
      source: string;
      target: string;
      label?: string;
      via: "lldp";
      /** Friendly label for the right-hand side panel — hostname / IP / chassis ID. */
      targetLabel: string;
      /** True when target is a Polaris asset (clickable); false for ghost neighbors. */
      targetIsAsset: boolean;
      /** Operator-readable explanation of why this LLDP edge was drawn. */
      reason: string;
    };
    const lldpEdges: LldpEdge[] = [];

    // Render-time fallback for stale LLDP rows whose `matchedAssetId` is
    // null but whose `systemName` actually corresponds to a sibling we
    // already have on the graph. The persist-time match in
    // `monitoringService.persistLldpNeighbors` resolves these via an
    // FQDN/short-form-aware index, but rows persisted before that fix
    // landed will keep showing as ghost nodes until the next system-info
    // pass overwrites them. This map covers the gap so a duplicate-named
    // sibling is dropped instead of double-rendered as an orange ghost.
    const siblingByHostname = new Map<string, string /* assetId */>();
    const idxSibling = (raw: string | null | undefined, assetId: string) => {
      if (!raw) return;
      const lower = raw.toLowerCase().trim();
      if (!lower) return;
      if (!siblingByHostname.has(lower)) siblingByHostname.set(lower, assetId);
      const dotIdx = lower.indexOf(".");
      if (dotIdx > 0) {
        const shortForm = lower.slice(0, dotIdx);
        if (!siblingByHostname.has(shortForm)) siblingByHostname.set(shortForm, assetId);
      }
    };
    idxSibling(fg.hostname, fg.id);
    for (const s of switches) idxSibling(s.hostname, s.id);
    for (const a of aps) idxSibling(a.hostname, a.id);

    // Backfill both halves of controller-data edges using LLDP. A single LLDP
    // row from either side gives BOTH endpoints — the source's authoritative
    // localIfName plus the target's port name as the source observed it in
    // the neighbor's LLDP advertisement (portId field). managed-switch/status
    // reports only the switch's view of its uplink (fgt_peer_intf_name), so
    // without LLDP the FG-side was stuck on "unknown"; without LLDP from the
    // switch side, the switch-side stayed "unknown" too. The cross-side
    // (`portId` on the FG's row tells us the switch's port = "port47") makes
    // a single LLDP source enough to fill in the whole edge.
    //
    // `portId` is only useful as a label when its subtype is a port-name
    // form (interfaceName / interfaceAlias / agentCircuitId / local). MAC
    // and networkAddress port-id subtypes carry hardware identifiers, not
    // operator-readable port labels — skipped so they don't pollute the edge.
    const PORT_ID_NAME_SUBTYPES = new Set(["interfaceName", "interfaceAlias", "agentCircuitId", "local"]);
    // Two confidence tiers (lower wins):
    //   1 — authoritative: the asset's own lldpLocPortTable / IF-MIB ifName
    //       lookup resolved (real port label that the asset reports for
    //       itself).
    //   2 — cross-advertised: portId in the neighbor's LLDP frame, name-form
    //       subtype (the asset doesn't have it locally but its peer just told
    //       it what the link's far end is called).
    // Synthetic `port-<digits>` values are NEVER used: that's the pattern
    // collectLldpNeighborsSnmp falls back to when the LLDP local-port table
    // can't resolve a name — the number is an ifIndex, not a port. Every real
    // FortiSwitch physical interface is `port<N>` (no hyphen), so a
    // hyphenated value is guaranteed bogus; "unknown" (→ "fortilink" label on
    // controller edges) beats a wrong port number.
    type PortLabel = { value: string; conf: 1 | 2 };
    const siblingLldpPort = new Map<string, PortLabel>();
    const SYNTHETIC_FALLBACK_RE = /^port-\d+$/i;
    const writeLabel = (k: string, value: string, conf: 1 | 2) => {
      const cur = siblingLldpPort.get(k);
      if (!cur || conf < cur.conf) siblingLldpPort.set(k, { value, conf });
    };
    for (const n of lldpRows) {
      if (!n.matchedAsset || !n.matchedAsset.id) continue;
      if (!siblingIds.has(n.matchedAsset.id)) continue;
      if (n.localIfName && !SYNTHETIC_FALLBACK_RE.test(n.localIfName)) {
        writeLabel(`${n.assetId}|${n.matchedAsset.id}`, n.localIfName, 1);
      }
      if (n.portId && n.portIdSubtype && PORT_ID_NAME_SUBTYPES.has(n.portIdSubtype) &&
          !SYNTHETIC_FALLBACK_RE.test(n.portId)) {
        writeLabel(`${n.matchedAsset.id}|${n.assetId}`, n.portId, 2);
      }
    }
    for (const e of edges) {
      const fwd = siblingLldpPort.get(`${e.source}|${e.target}`); // source's view → fills source half
      const rev = siblingLldpPort.get(`${e.target}|${e.source}`); // target's view → fills target half
      if (!fwd && !rev) continue;
      const parts = String(e.label || "").split(" ↔ ");
      let sourceHalf = parts[0] ?? "unknown";
      let targetHalf = parts[1] ?? "unknown";
      // Only overwrite halves that were previously "unknown" — controller-
      // data set a real value (rare) wins over an LLDP cross-reference.
      if (fwd && sourceHalf === "unknown") sourceHalf = fwd.value;
      if (rev && targetHalf === "unknown") targetHalf = rev.value;
      e.label = portLabel(sourceHalf, targetHalf);
    }

    // Demote FG→switch controller edges when a more-specific signal puts
    // the switch downstream of another switch. FortiOS reports `fortilink`
    // on every managed switch — direct or chained — so the controller
    // signal alone over-connects multi-switch fleets (every switch hangs
    // off the FG). Dagre LR then has to route long FG→deep-switch edges
    // around the chained switches, visually breaking the operator's "daisy
    // chain runs left-to-right" mental model and pushing tail switches
    // off-rank. Stripping the redundant FG edge gives dagre a clean
    // single-parent DAG so the chain lays out as FG → -1 → -2 → -3.
    //
    // Chain-head identification: a sibling switch is "directly connected"
    // to the FG iff the FG's LLDP advertises it as a neighbor. FortiLink
    // peer-aggregate interface names exist on BOTH ends of an inter-switch
    // link (each side names the peer's serial), so interfaceEdges alone
    // can't tell us which side is upstream — but LLDP from the FG can,
    // since LLDP is single-hop. If FG LLDP has no sibling neighbors at all
    // (data hasn't landed yet from the SNMP-LLDP fix, or LLDP is disabled
    // on FortiLink), every FG→switch edge is preserved — same behavior as
    // before so a fresh install isn't suddenly missing edges.
    const fgSiblingNeighbors = new Set<string>();
    for (const n of lldpRows) {
      if (n.assetId !== fg.id) continue;
      if (!n.matchedAsset || !n.matchedAsset.id) continue;
      if (!siblingIds.has(n.matchedAsset.id)) continue;
      fgSiblingNeighbors.add(n.matchedAsset.id);
    }
    if (fgSiblingNeighbors.size > 0) {
      const chainedTargets = new Set<string>();
      for (const e of interfaceEdges) {
        if (e.source === fg.id || e.target === fg.id) continue;
        chainedTargets.add(e.target);
      }
      edges = edges.filter((e) => {
        if (e.source !== fg.id) return true;
        // Demote when the target is in a chain AND not a chain head.
        return !(chainedTargets.has(e.target) && !fgSiblingNeighbors.has(e.target));
      });
    }

    for (const n of lldpRows) {
      let targetId: string;
      let targetLabel: string;
      let targetIsAsset: boolean;
      // Stale-row fallback: persist-time match returned null, but the
      // systemName resolves to a sibling now (FQDN ↔ short-form). Treat
      // exactly like a sibling-match — controller data has the edge.
      if (!(n.matchedAsset && n.matchedAsset.id) && n.systemName) {
        const lower = n.systemName.toLowerCase().trim();
        const siblingId = siblingByHostname.get(lower)
          ?? (lower.includes(".") ? siblingByHostname.get(lower.split(".")[0]) : undefined);
        if (siblingId) continue;
        // Unmatched neighbor whose name is a known HA standby member — suppress
        // the ghost node (the primary already represents the cluster).
        if (standbyHostnames.has(lower) || (lower.includes(".") && standbyHostnames.has(lower.split(".")[0]))) continue;
      }
      if (n.matchedAsset && n.matchedAsset.id) {
        // Skip neighbors that resolve back to a sibling node — fortinetTopology
        // has already drawn that edge from authoritative controller data, so a
        // duplicate LLDP edge would just clutter the graph. We still emit the
        // LLDP edge when the matched asset is OUTSIDE this site (e.g. a
        // separate firewall) — that's the whole point.
        if (siblingIds.has(n.matchedAsset.id)) continue;
        // Suppress HA standby members — the active/primary cluster member is
        // already on the graph and carries the same uplinks.
        if (standbyIds.has(n.matchedAsset.id)) continue;
        targetId = n.matchedAsset.id;
        targetLabel = n.matchedAsset.hostname || n.matchedAsset.ipAddress || n.matchedAsset.id;
        targetIsAsset = true;
        // Record the cross-site node so the topology payload's edge target
        // resolves to a real node on the frontend (Cytoscape errors on
        // edges referencing nonexistent nodes). Dedup'd by asset id so a
        // multi-link cross-site uplink collapses to one node.
        if (!remoteAssetNodes.has(targetId)) {
          remoteAssetNodes.set(targetId, {
            id: targetId,
            hostname: n.matchedAsset.hostname,
            ipAddress: n.matchedAsset.ipAddress,
            assetType: n.matchedAsset.assetType,
            model: n.matchedAsset.model,
            iconUrl: resolveIconUrl(
              { manufacturer: n.matchedAsset.manufacturer, model: n.matchedAsset.model, assetType: n.matchedAsset.assetType },
              iconCache,
            ),
          });
        }
      } else {
        // Synthesize a stable ghost id from chassisId (preferred) or system
        // name. This collapses multi-link aggregates to one node so the graph
        // stays readable.
        const key = n.chassisId || n.systemName || `${n.assetId}|${n.localIfName}|${n.portId ?? ""}`;
        targetId = `lldp:${key}`;
        if (!lldpNodes.has(targetId)) {
          lldpNodes.set(targetId, {
            id: targetId,
            hostname: n.systemName,
            managementIp: n.managementIp,
            chassisId: n.chassisId,
            systemDescription: n.systemDescription,
            capabilities: n.capabilities,
          });
        }
        targetLabel = n.systemName || n.managementIp || n.chassisId || "Unknown neighbor";
        targetIsAsset = false;
      }
      const key = `${n.assetId}|${targetId}`;
      const reverseKey = `${targetId}|${n.assetId}`;
      if (existingEdge.has(key) || existingEdge.has(reverseKey)) continue;
      existingEdge.add(key);
      const sourceLabel =
        switchHostById.get(n.assetId) ||
        apHostById.get(n.assetId) ||
        (n.assetId === fg.id ? (fg.hostname || fg.id) : n.assetId);
      const matchBy = n.matchedAsset
        ? (n.managementIp ? `management IP ${n.managementIp}` :
           (n.chassisIdSubtype === "macAddress" && n.chassisId) ? `chassis MAC ${n.chassisId}` :
           n.systemName ? `system name "${n.systemName}"` :
           "stored matchedAssetId")
        : "no Polaris asset matched";
      const lldpReason = n.matchedAsset
        ? `Rule: LLDP edge — observed advertisement, matched to a Polaris asset.\n` +
          `Evidence: ${sourceLabel} received an LLDP frame on local port "${n.localIfName || "?"}". ` +
          `Remote chassis-id ${n.chassisId || "(unknown)"}, port-id ${n.portId || "(unknown)"}, system name "${n.systemName || "?"}", management IP ${n.managementIp || "?"}.\n` +
          `Match resolved at persist time via ${matchBy}.\n` +
          `Source transport: ${n.source || "?"} (FortiOS REST or SNMP LLDP-MIB walk).\n` +
          `Sibling-match LLDP edges are skipped — controller-data already covers them.`
        : `Rule: LLDP edge — observed advertisement, no matching Polaris asset (rendered as a ghost node).\n` +
          `Evidence: ${sourceLabel} received an LLDP frame on local port "${n.localIfName || "?"}". ` +
          `Remote chassis-id ${n.chassisId || "(unknown)"}, port-id ${n.portId || "(unknown)"}, system name "${n.systemName || "?"}", management IP ${n.managementIp || "?"}.\n` +
          `No asset in the inventory matched by management IP, chassis MAC, or hostname (case-insensitive, FQDN-aware).\n` +
          `Source transport: ${n.source || "?"}.`;
      lldpEdges.push({
        source: n.assetId,
        target: targetId,
        // Synthetic `port-<ifIndex>` local names (SNMP collector fallback)
        // are not real ports — show "unknown" rather than a bogus number.
        label:  portLabel(
          n.localIfName && SYNTHETIC_FALLBACK_RE.test(n.localIfName) ? null : n.localIfName,
          n.portId,
        ),
        via:    "lldp",
        targetLabel,
        targetIsAsset,
        reason: lldpReason,
      });
    }

    // Tag surviving FG→switch controller edges as physically-confirmed when the
    // switch is interface-confirmed-direct OR an FG LLDP neighbor. Chained
    // switches reach the FG through their (un-deduped) inter-switch interface
    // edges, so only the chain-head FG edges need the flag.
    const physConfirmedSwitchIds = new Set<string>([...interfaceConfirmedFgPeers, ...fgSiblingNeighbors]);
    const switchIdSetFinal = new Set(switches.map((s) => s.id));
    for (const e of edges) {
      if (e.source === fg.id && switchIdSetFinal.has(e.target) && physConfirmedSwitchIds.has(e.target)) {
        e.verifiedUplink = true;
      }
    }

    // Per-edge interface details for the hover tooltip: speed / oper status /
    // error counters for the named interface on each side, from the
    // CURRENT-STATE `AssetInterface` table (one row per assetId+ifName, so a
    // plain indexed read replaces the former DISTINCT ON over the hypertable).
    // The 1h staleness bound is preserved — a tooltip showing a reading from
    // hours ago is worse than showing none. FortiOS has no duplex field, so
    // duplex isn't available. Logical/unknown ports ("fortilink" → "unknown")
    // and cross-site ghosts simply get no detail.
    //
    // Also fixes the aggregate→physical map below: the fast pinned re-walk
    // wrote ifType/ifParent as NULL and DISTINCT ON took the newest row, so a
    // pinned aggregate lost its members. The full pass always populates them.
    const ifMetricStaleCutoff = new Date(Date.now() - 60 * 60 * 1000);
    const ifMetricRows = await prisma.assetInterface.findMany({
      where: { assetId: { in: siteAssetIds }, lastSeen: { gt: ifMetricStaleCutoff } },
      select: {
        assetId: true, ifName: true, ifType: true, ifParent: true,
        speedBps: true, operStatus: true, inErrors: true, outErrors: true,
      },
    });
    const ifMetricByKey = new Map<string, { speedBps: number | null; operStatus: string | null; inErrors: number | null; outErrors: number | null }>();
    // Aggregate → physical members, per asset. A FortiLink uplink trunk (and
    // any auto-ISL aggregate) is named opaquely — for a switch the trunk is
    // named after its own serial — but the cable terminates at a single
    // physical port. When the trunk has exactly one physical member we render
    // that member instead, mirroring interfaceTopologyService.preferPhysical.
    // The ifParent linkage is populated by the FortiSwitch trunk-member overlay
    // in monitoringService (and by the FortiGate aggregate back-fill).
    const physicalByParent = new Map<string, string[]>();
    for (const r of ifMetricRows) {
      ifMetricByKey.set(`${r.assetId}|${r.ifName}`, {
        speedBps:  r.speedBps  != null ? Number(r.speedBps)  : null,
        operStatus: r.operStatus,
        inErrors:  r.inErrors  != null ? Number(r.inErrors)  : null,
        outErrors: r.outErrors != null ? Number(r.outErrors) : null,
      });
      if (r.ifType === "physical" && r.ifParent) {
        const k = `${r.assetId}|${r.ifParent}`;
        const list = physicalByParent.get(k);
        if (list) list.push(r.ifName);
        else physicalByParent.set(k, [r.ifName]);
      }
    }
    const ifDetail = (assetId: string, rawName: string | undefined) => {
      if (!assetId || !rawName) return null;
      let name = rawName.trim();
      if (!name || name === "unknown") return null;
      // Single-member aggregate → its physical member (e.g. the serial-named
      // FortiLink uplink → port52). Report the member's own metrics.
      const members = physicalByParent.get(`${assetId}|${name}`);
      if (members && members.length === 1) name = members[0];
      const m = ifMetricByKey.get(`${assetId}|${name}`);
      if (!m) return null;
      return { name, ...m };
    };
    // Swap a single-member aggregate interface name for its physical member so
    // edge LABELS show the real cabled port, not the logical aggregate (e.g.
    // the FortiOS auto-ISL trunk "2DPTD23005147-0" → "port24"). Multi-member
    // aggregates (true LACP bundles) keep the aggregate name — there's no one
    // "the physical port" to show. Mirrors ifDetail's swap and
    // interfaceTopologyService.preferPhysical.
    const preferPhysicalMember = (assetId: string, ifName: string | null): string | null => {
      if (!assetId || !ifName) return ifName;
      const members = physicalByParent.get(`${assetId}|${ifName}`);
      return members && members.length === 1 ? members[0] : ifName;
    };
    const attachIfDetails = (arr: Array<{ source: string; target: string; label?: string }>) => {
      for (const e of arr) {
        const parts = String(e.label || "").split(" ↔ ");
        const s = ifDetail(e.source, parts[0]);
        const t = ifDetail(e.target, parts[1]);
        if (s) (e as Record<string, unknown>).srcIf = s;
        if (t) (e as Record<string, unknown>).tgtIf = t;
      }
    };
    attachIfDetails(edges);
    attachIfDetails(interfaceEdges);
    attachIfDetails(lldpEdges);

    // MCLAG ICL edges between paired FortiSwitches. Each switch reports the ICL
    // from its own side (one asset_mclag_peers row per local mclag-icl-port), so
    // a pair yields mirror rows pointing at each other — dedupe to one undirected
    // edge per pair. Both endpoints are managed switches already on the graph
    // (matchedAssetId resolved by peer serial at persist time), so we only draw
    // when both ids are in-site switch nodes. This is the AUTHORITATIVE rendering
    // of the inter-switch link for an MCLAG pair: because the ICL is also a
    // FortiLink auto-ISL trunk, the same adjacency can surface as an LLDP or
    // interface-inferred edge — we strip those for MCLAG pairs below so the link
    // renders exactly once (as a sibling ICL, never as a parent/child uplink).
    const mclagRows = await prisma.assetMclagPeer.findMany({
      where: { assetId: { in: siteAssetIds }, matchedAssetId: { not: null } },
      select: { assetId: true, localPort: true, peerPort: true, matchedAssetId: true },
    });
    type MclagEdge = { source: string; target: string; label?: string; via: "mclag"; reason: string };
    const mclagEdges: MclagEdge[] = [];
    const mclagPairKeys = new Set<string>();
    for (const r of mclagRows) {
      const peerId = r.matchedAssetId as string;
      if (!switchObjById.has(r.assetId) || !switchObjById.has(peerId)) continue; // both ends in-site switches
      const pairKey = [r.assetId, peerId].sort().join("|");
      if (mclagPairKeys.has(pairKey)) continue;
      mclagPairKeys.add(pairKey);
      const a = switchObjById.get(r.assetId)!;
      const b = switchObjById.get(peerId)!;
      mclagEdges.push({
        source: r.assetId,
        target: peerId,
        label: r.localPort && r.peerPort ? `${r.localPort} ↔ ${r.peerPort}` : (r.localPort || undefined),
        via: "mclag",
        reason:
          `Rule: MCLAG Inter-Chassis Link — ${a.hostname || a.id} and ${b.hostname || b.id} are MCLAG peers (siblings, same layer).\n` +
          `Evidence: ${a.hostname || a.id} port "${r.localPort}" is flagged mclag-icl-port and resolves to peer ` +
          `${b.hostname || b.id}${r.peerPort ? ` port "${r.peerPort}"` : ""} by serial.`,
      });
    }
    // Strip any LLDP / interface-inferred edge between an MCLAG pair (either
    // direction) — the ICL is fully represented by the mclagEdge above.
    const isMclagPair = (s: string, t: string) => mclagPairKeys.has([s, t].sort().join("|"));
    const lldpEdgesOut = lldpEdges.filter((e) => !isMclagPair(e.source, e.target));

    // Inter-switch links expanded to one edge per PHYSICAL member. FortiOS
    // reports an LACP/ISL bundle between two managed FortiSwitches as a single
    // aggregate interface — usually the opaque serial-named auto-ISL trunk
    // (e.g. "2DPTD21002999-0"). Operators want the real cabled ports, and an
    // N-member bundle should render as N separate lines. `physicalByParent`
    // (back-filled onto interface samples from the managed-switch CMDB trunk
    // membership — see overlayFortiswitchTrunkMembers) gives each aggregate's
    // physical member list, so we resolve BOTH sides of every inter-switch
    // interface edge to their members and draw one edge per member, pairing
    // the two sides by natural port order. A plain single physical link stays
    // one edge. MCLAG ICLs are excluded — rendered as the single sibling
    // mclagEdge. When the CMDB membership isn't available for a side, that
    // side degrades to the interface name as-is (best effort).
    const membersOf = (assetId: string, ifName: string | null): string[] => {
      if (!ifName || ifName === "unknown") return [];
      const m = physicalByParent.get(`${assetId}|${ifName}`);
      return m && m.length >= 1 ? [...m] : [ifName];
    };
    // Natural port-name order ("port2" before "port10") so the two switches'
    // member lists pair up deterministically and intuitively.
    const naturalPort = (a: string, b: string): number => {
      const na = Number((a.match(/(\d+)\s*$/) || [])[1]);
      const nb = Number((b.match(/(\d+)\s*$/) || [])[1]);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    };
    const switchSwitchPairKey = (s: string, t: string): string | null => {
      if (!switchObjById.has(s) || !switchObjById.has(t) || s === t) return null;
      const key = [s, t].sort().join("|");
      return mclagPairKeys.has(key) ? null : key;
    };
    // Per switch-pair, gather the physical member set on each side. Two
    // sources, in priority order per side:
    //   - LLDP local ports: each switch advertises its OWN physical port in
    //     its neighbor rows, so both sides' real cabled ports come straight
    //     from LLDP — reliable even when the CMDB trunk membership hasn't been
    //     scraped. Preferred.
    //   - interface-inferred edge interface names → CMDB trunk members
    //     (`membersOf`). Fallback when LLDP gave nothing for that side.
    // Only pairs that already have an interface-inferred edge are expanded —
    // we never invent a link that wasn't inferred (LLDP only enriches).
    const pairIface = new Map<string, Map<string, Set<string>>>();
    const pairLldp = new Map<string, Map<string, Set<string>>>();
    const addTo = (map: Map<string, Map<string, Set<string>>>, pairKey: string, assetId: string, ports: string[]) => {
      let byAsset = map.get(pairKey);
      if (!byAsset) { byAsset = new Map(); map.set(pairKey, byAsset); }
      let set = byAsset.get(assetId);
      if (!set) { set = new Set(); byAsset.set(assetId, set); }
      for (const p of ports) if (p && p !== "unknown") set.add(p);
    };
    for (const e of interfaceEdges) {
      const key = switchSwitchPairKey(e.source, e.target);
      if (!key) continue;
      const parts = String(e.label || "").split(" ↔ ");
      addTo(pairIface, key, e.source, membersOf(e.source, parts[0] === "unknown" ? null : parts[0]));
      addTo(pairIface, key, e.target, membersOf(e.target, parts[1] === "unknown" ? null : parts[1]));
    }
    for (const n of lldpRows) {
      if (!n.matchedAsset?.id || !n.localIfName) continue;
      // Synthetic `port-<ifIndex>` fallback names are not physical ports — a
      // FortiSwitch physical interface is always `port<N>` (no hyphen).
      // Treating one as a cable member would mint a phantom parallel line;
      // skip it and let this side fall back to the CMDB trunk membership.
      if (SYNTHETIC_FALLBACK_RE.test(n.localIfName)) continue;
      // LLDP as CABLE evidence takes a far tighter freshness bound than LLDP
      // as a display value. persistLldpNeighbors deliberately keeps a vanished
      // neighbor row for 48h so the operator-facing Neighbor column doesn't
      // flap on a missed advertisement — but a row that outlived its cable is
      // exactly what mints a phantom parallel line here: re-patch a link from
      // port9 to port10 and the switch claims both ports for two days. Same 1h
      // bound the interface-name inference and the per-edge tooltip details
      // already use; past it this side falls back to the CMDB trunk membership
      // rather than to nothing.
      if (new Date(n.lastSeen) <= ifMetricStaleCutoff) continue;
      const key = switchSwitchPairKey(n.assetId, n.matchedAsset.id);
      if (!key || !pairIface.has(key)) continue; // enrich inferred pairs only
      addTo(pairLldp, key, n.assetId, membersOf(n.assetId, n.localIfName));
    }
    // `membersOf` returns CMDB trunk members (physical by construction) but
    // degrades to the interface name as-is when membership wasn't scraped —
    // which may be an aggregate. The repeat rule turns on exactly that
    // distinction, so classify from what the device reported. Two positive
    // signals for "this is an aggregate": the name PARENTS physical members,
    // or its own ifType says it isn't physical. Anything else — including a
    // name with no current interface row at all — is treated as physical,
    // because that is the SAFE default here: refusing to repeat costs one
    // undrawn line (named in the reason as unpaired), while wrongly repeating
    // draws a cable that doesn't exist, which is the bug this rule exists for.
    const ifTypeByKey = new Map<string, string | null>();
    for (const r of ifMetricRows) ifTypeByKey.set(`${r.assetId}|${r.ifName}`, r.ifType);
    const isAggregateName = (assetId: string, name: string): boolean => {
      if (physicalByParent.has(`${assetId}|${name}`)) return true;
      const t = ifTypeByKey.get(`${assetId}|${name}`);
      return !!t && t !== "physical";
    };
    const describeMembers = (assetId: string, ports: string[]): CableMember[] =>
      ports.map((port) => {
        const operStatus = ifMetricByKey.get(`${assetId}|${port}`)?.operStatus;
        return {
          port,
          physical: !isAggregateName(assetId, port),
          // Absent reading = unknown, which is NOT down.
          down: !!operStatus && String(operStatus).toLowerCase() !== "up",
        };
      });
    const expandedSwitchPairs = new Set<string>();
    const memberCableEdges: InterfaceEdge[] = [];
    for (const [pairKey, ifaceByAsset] of pairIface) {
      const [aId, bId] = pairKey.split("|");
      const lldpByAsset = pairLldp.get(pairKey);
      const sideMembers = (id: string): string[] => {
        const fromLldp = lldpByAsset?.get(id);
        if (fromLldp && fromLldp.size) return [...fromLldp].sort(naturalPort);
        return [...(ifaceByAsset.get(id) ?? [])].sort(naturalPort);
      };
      // How many lines, and which port sits on each end, is decided by the
      // pure `pairCableMembers`: a lone PHYSICAL member is never repeated
      // across parallel lines (one port terminates one cable) and a member the
      // device reports as down loses to a live sibling. See
      // utils/cableMembers.ts for both rules and why they exist.
      const aMembers = describeMembers(aId, sideMembers(aId));
      const bMembers = describeMembers(bId, sideMembers(bId));
      const { lines, unpaired, droppedDown } = pairCableMembers(aMembers, bMembers);
      if (lines.length === 0) continue; // neither side resolved — leave the original edge
      expandedSwitchPairs.add(pairKey);
      const aLabel = switchHostById.get(aId) || aId;
      const bLabel = switchHostById.get(bId) || bId;
      const n = lines.length;
      // Both notes go on EVERY line of the bundle: the operator opens the
      // tooltip on whichever line looks wrong, not necessarily the one that
      // lost its peer.
      const discrepancy =
        unpaired.length > 0
          ? `\nMember counts disagreed (${aLabel}: ${aMembers.length}, ${bLabel}: ${bMembers.length}). ` +
            `Not drawn: ${unpaired.join(", ")} — a physical port terminates one cable, so the surplus is ` +
            `a trunk member left configured after a re-patch, or an LLDP row whose cable moved.`
          : "";
      const stateNote =
        droppedDown.length > 0 ? `\nIgnored (link down): ${droppedDown.join(", ")}.` : "";
      for (let i = 0; i < n; i++) {
        const aPort = lines[i].a;
        const bPort = lines[i].b;
        memberCableEdges.push({
          source: aId,
          target: bId,
          sourceIfName: aPort || "unknown",
          label: portLabel(aPort, bPort),
          via: "interface",
          matchVia: "lldp",
          reason:
            `Rule: inter-switch physical member link${n > 1 ? ` (${i + 1} of ${n})` : ""}.\n` +
            `Evidence: ${aLabel} and ${bLabel} are connected over ${n} physical member port${n > 1 ? "s" : ""} ` +
            `(each side's LLDP local ports, else its managed-switch CMDB trunk members); ` +
            `this line is ${aLabel} "${aPort || "?"}" ↔ ${bLabel} "${bPort || "?"}".` +
            discrepancy + stateNote,
        });
      }
    }
    attachIfDetails(memberCableEdges);
    const interfaceEdgesOut = interfaceEdges
      .filter((e) => !isMclagPair(e.source, e.target))
      .filter((e) => !expandedSwitchPairs.has([e.source, e.target].sort().join("|")))
      .concat(memberCableEdges);
    // Final safety net for the non-expanded edges (switch↔cross-site remote,
    // etc.): swap any single-member aggregate name for its physical member so
    // no serial-named ISL trunk leaks through. No-op on physical port names
    // and on the already-expanded member edges above.
    for (const e of interfaceEdgesOut) {
      if (expandedSwitchPairs.has([e.source, e.target].sort().join("|"))) continue;
      const parts = String(e.label || "").split(" ↔ ");
      if (parts.length !== 2) continue;
      const src = preferPhysicalMember(e.source, parts[0] === "unknown" ? null : parts[0]);
      const tgt = preferPhysicalMember(e.target, parts[1] === "unknown" ? null : parts[1]);
      e.label = portLabel(src ?? parts[0], tgt ?? parts[1]);
    }

    // Drop redundant FortiLink fallback edges. FortiOS stamps
    // `fgt_peer_intf_name = "fortilink"` on every managed switch — direct or
    // chained — so an UNVERIFIED FG→switch controller edge represents the
    // FortiGate's fortilink software aggregate, not a cable. When the switch
    // is still reachable from the FortiGate through the rest of the final
    // graph (interface-inferred, LLDP, wireless-bridge, MCLAG, or other
    // controller edges), the fallback only over-connects the map — drop it.
    // A switch with NO other path to the FortiGate keeps its fallback edge so
    // it never renders orphaned. verifiedUplink edges (interface- or
    // FG-LLDP-confirmed) are real cables and are never dropped here.
    const fallbackFgSwitchEdges = new Set(
      edges.filter((e) => e.source === fg.id && switchIdSetFinal.has(e.target) && !e.verifiedUplink),
    );
    if (fallbackFgSwitchEdges.size > 0) {
      const adj = new Map<string, Set<string>>();
      const addAdj = (a: string, b: string) => {
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a)!.add(b);
        adj.get(b)!.add(a);
      };
      for (const e of edges) if (!fallbackFgSwitchEdges.has(e)) addAdj(e.source, e.target);
      for (const e of interfaceEdgesOut) addAdj(e.source, e.target);
      for (const e of lldpEdgesOut) addAdj(e.source, e.target);
      for (const e of bridgeEdges) addAdj(e.source, e.target);
      for (const e of mclagEdges) addAdj(e.source, e.target);
      const reachable = new Set<string>([fg.id]);
      const queue = [fg.id];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const n of adj.get(cur) ?? []) {
          if (!reachable.has(n)) {
            reachable.add(n);
            queue.push(n);
          }
        }
      }
      edges = edges.filter((e) => !(fallbackFgSwitchEdges.has(e) && reachable.has(e.target)));
    }
    return {
      fortigate: {
        id: fg.id,
        hostname: fg.hostname,
        serial: fg.serialNumber,
        model: fg.model,
        ip: fg.ipAddress,
        status: fg.status,
        lastSeen: fg.lastSeen,
        latitude: fg.latitude,
        longitude: fg.longitude,
        monitored: fg.monitored,
        monitorHealth: fg.monitored ? fgMonitorStats?.health ?? "unknown" : null,
        monitorRecentSamples: fgMonitorStats?.samples ?? 0,
        monitorRecentFailures: fgMonitorStats?.failures ?? 0,
        dependencyLayer: fg.dependencyLayer,
        dependencySuppressed: fg.dependencySuppressed,
        iconUrl: resolveIconUrl({ manufacturer: fg.manufacturer, model: fg.model, assetType: "firewall" }, iconCache),
        // FortiGates have no discovery-captured device description (their
        // device-side surface would be the 35-char system/global alias), so
        // location codes come from Asset.description only — enough for an
        // operator to pull the FG into a building group.
        location: nodeLocation(resolveEffectiveLocation({ description: fg.description })),
      },
      switches,
      aps,
      subnets,
      edges,
      // CMDB-inferred edges from FortiOS interface naming conventions —
      // peer-serial aggregates (FortiLink-auto) plus operator-named
      // hostname aggregates. Authoritative because they're stamped by
      // FortiOS itself; rendered with their own visual style on the
      // topology graph. Each edge references nodes already in this
      // payload (siblings or `remoteAssetNodes`).
      interfaceEdges: interfaceEdgesOut,
      // MCLAG ICL edges between sibling FortiSwitch pairs. Rendered as a distinct
      // peer/sibling link (not a parent/child uplink); the LLDP / interface
      // representations of the same ICL are stripped above so it shows once.
      mclagEdges,
      // LLDP additions: rendered separately by the topology modal so the
      // styling can distinguish authoritative fortinetTopology edges from
      // observed LLDP edges. `lldpNodes` is the array form of the Map above.
      lldpNodes: Array.from(lldpNodes.values()),
      // Cross-site Polaris assets observed via LLDP OR via interface-name
      // inference from this site — separate from `lldpNodes` (ghost
      // neighbors) so the frontend can render them with a "real asset,
      // just elsewhere" style and a click-through to the asset details
      // page. Without this, edges in `lldpEdges` / `interfaceEdges` whose
      // target is a cross-site asset id would reference nonexistent
      // Cytoscape nodes and the graph would error out on load.
      remoteAssetNodes: Array.from(remoteAssetNodes.values()),
      lldpEdges: lldpEdgesOut,
      // Wireless-bridge edges: a FortiLink switch reached behind a FortiAP
      // (LLDP-detected). Rendered like a mesh edge AP→switch; the switch routes
      // behind the AP and its FortiLink controller edge is demoted client-side.
      bridgeEdges,
      // Server-persisted (shared) node layouts, keyed by view ("flat" +
      // floor-view keys): { [view]: { view, positions, updatedBy, updatedAt } }.
      // Written via PUT /sites/:id/topology/layout (deviceMap=write); the
      // modal prefers these over its per-browser localStorage layout.
      savedLayouts: await getLayoutsForSite(fg.id),
    };
}
