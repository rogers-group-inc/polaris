/**
 * src/services/mapSitesService.ts — the Device Map's site reads.
 *
 * Extracted from src/api/routes/map.ts on 2026-11-06 (CQ-B044): the
 * `/map/sites` list, the owner fields a topology GET judges `canEditLayout`
 * on, and the topology modal's site-scoped endpoint search. Read-only. The
 * graph itself is topologyGraphService.buildSiteTopology; the per-caller
 * write-scope judgement (rule 141 (e)) stays in the route, which has the
 * request.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { EXCLUDED_LIFECYCLE_STATUSES } from "../utils/assetInvariants.js";
import { controllerStampWhereOr, readFirewallDeviceName } from "../utils/fortinetParentKey.js";
import {
  attributeEndpointToSiteSwitch,
  buildSiteEndpointAttribution,
  monitorStatusToHealth,
  fetchRecentSampleStats,
  portOfLastSeenSwitch,
} from "./topologyGraphService.js";
import { downAlertAcknowledgedByAsset } from "./nocDashboardService.js";

/**
 * Every live firewall with coordinates, optionally narrowed to the given
 * region names (`region:<name>` tags; empty = all), each with its subnet
 * count, monitor health, recent sample counts and — for a down site — whether
 * its down alert is acknowledged. `createdBy` / `tags` ride along for the
 * route's `canEditLayout`.
 */
export async function listMapSites(regionNames: string[]) {
  const regionWhere = regionNames.length
    ? { tags: { hasSome: regionNames.map((n) => "region:" + n) } }
    : {};
  const sites = await prisma.asset.findMany({
    where: {
      assetType: "firewall",
      latitude: { not: null },
      longitude: { not: null },
      status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
      ...regionWhere,
    },
    select: {
      id: true,
      hostname: true,
      // Rule 141 (e): `canEditLayout` per site is judged on these.
      createdBy: true,
      tags: true,
      serialNumber: true,
      model: true,
      ipAddress: true,
      latitude: true,
      longitude: true,
      status: true,
      monitorStatus: true,
      lastSeen: true,
      learnedLocation: true,
      monitored: true,
      dependencyLayer: true,
      dependencySuppressed: true,
    },
    orderBy: { hostname: "asc" },
  });

  const monitorStats = await fetchRecentSampleStats(
    sites.filter((s) => s.monitored).map((s) => s.id),
  );

  // Acknowledged-ness of each DOWN site's down alert, so the map widgets can
  // fade an outage someone already owns. Bounded to the down sites only.
  const downAck = await downAlertAcknowledgedByAsset(
    sites.filter((s) => s.monitored && s.monitorStatus === "down").map((s) => s.id),
  );

  // Subnet counts per FortiGate — the `fortigateDevice` column on Subnet
  // stores the FMG-side device name, which (for auto-discovered FortiGates)
  // matches the Asset's hostname or learnedLocation. One query, grouped.
  const hostnames = sites.map((s) => s.hostname).filter((h): h is string => !!h);
  const subnetCounts = hostnames.length
    ? await prisma.subnet.groupBy({
        by: ["fortigateDevice"],
        where: { fortigateDevice: { in: hostnames } },
        _count: { _all: true },
      })
    : [];
  const countByName = new Map<string, number>();
  for (const row of subnetCounts) {
    if (row.fortigateDevice) countByName.set(row.fortigateDevice, row._count._all);
  }

  return sites.map((s) => {
    const stats = s.monitored ? monitorStats.get(s.id) : null;
    return {
      ...s,
      subnetCount: s.hostname ? countByName.get(s.hostname) ?? 0 : 0,
      // Derive the dot's health from Asset.monitorStatus (the five-state
      // machine), NOT the raw 10-sample window — so the Status Map's red
      // "down" dots agree with the Down Assets / Status Summary widgets,
      // which key off monitorStatus. The recent sample counts still ride
      // along for the tooltip's "X/Y samples failed" detail.
      monitorHealth: s.monitored ? monitorStatusToHealth(s.monitorStatus) : null,
      monitorRecentSamples: stats?.samples ?? 0,
      monitorRecentFailures: stats?.failures ?? 0,
      // true = the down alert is acknowledged; false = unacknowledged;
      // absent = no active down alert (or the site isn't down).
      ...(downAck.has(s.id) ? { alertAcknowledged: downAck.get(s.id) } : {}),
    };
  });
}

/** The fields rule 141 (e) judges a site's layout write on; null = no such asset. */
export async function getSiteLayoutOwner(id: string): Promise<{ createdBy: string | null; tags: string[] } | null> {
  return prisma.asset.findUnique({ where: { id }, select: { createdBy: true, tags: true } });
}

/**
 * Site-scoped endpoint search for the topology modal: `q` as a
 * case-insensitive substring of hostname / IP / MAC / assignedTo / DNS name,
 * among endpoints attributed to one of THIS site's switches (their
 * `switch-port` dependency edge, or a hostname prefix only when the switch's
 * name is fleet-unique — business rule 91). Capped at 25: search is for
 * finding one endpoint, not browsing. 404 when `id` is not a live firewall.
 */
export async function searchSiteEndpoints(id: string, q: string) {
  const fg = await prisma.asset.findFirst({
    where: { id, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
    select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
  });
  if (!fg || fg.assetType !== "firewall") throw new AppError(404, "FortiGate not found");

  // Match children by serial / FMG device name / hostname — hostname alone
  // misses every install whose FMG device name differs from the gate's
  // configured hostname. See utils/fortinetParentKey.ts.
  const controllerKeyOr = controllerStampWhereOr({
    hostname: fg.hostname,
    serialNumber: fg.serialNumber,
    deviceName: readFirewallDeviceName(fg.fortinetTopology),
  });
  const siblingSwitches = controllerKeyOr.length > 0
    ? await prisma.asset.findMany({
        where: {
          assetType: "switch",
          AND: [{ OR: controllerKeyOr }],
          status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
        },
        select: { id: true, hostname: true },
      })
    : [];
  // Which switch an endpoint sits on is its `switch-port` dependency edge,
  // or a hostname prefix only when the name is unique fleet-wide (business
  // rule 91 — the per-site "IDF-1" of a FortiLink fleet). Same rule as the
  // topology payload's `endpointCount` / `endpoints[]`.
  const attribution = await buildSiteEndpointAttribution(siblingSwitches);
  if (attribution.whereOr.length === 0) return { q, results: [] };

  const matches = await prisma.asset.findMany({
    where: {
      assetType: { notIn: ["firewall", "switch", "access_point"] },
      status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
      OR: attribution.whereOr,
      AND: [
        {
          OR: [
            { hostname:    { contains: q, mode: "insensitive" } },
            { ipAddress:   { contains: q, mode: "insensitive" } },
            { macAddress:  { contains: q, mode: "insensitive" } },
            { assignedTo:  { contains: q, mode: "insensitive" } },
            { dnsName:     { contains: q, mode: "insensitive" } },
          ],
        },
      ],
    },
    select: {
      id: true, hostname: true, ipAddress: true, macAddress: true,
      assetType: true, assignedTo: true, lastSeenSwitch: true, lastSeen: true,
      dependencyParents: attribution.edgeSelect,
    },
    orderBy: { lastSeen: "desc" },
    take: 25,
  });

  const switchHostById = new Map<string, string | null>();
  for (const s of siblingSwitches) switchHostById.set(s.id, s.hostname);
  const results = matches.map((m) => {
    const switchId = attributeEndpointToSiteSwitch(m, attribution);
    return {
      id:         m.id,
      hostname:   m.hostname,
      ipAddress:  m.ipAddress,
      macAddress: m.macAddress,
      assetType:  String(m.assetType),
      assignedTo: m.assignedTo,
      switchId,
      // The RESOLVED switch's name — the same string as the stamp except
      // when two sites share it, where this is the one the device sits on.
      switchHostname: switchId ? (switchHostById.get(switchId) ?? null) : null,
      port: portOfLastSeenSwitch(m.lastSeenSwitch),
      lastSeen:   m.lastSeen,
    };
  });
  return { q, results };
}
