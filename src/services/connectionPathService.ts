/**
 * src/services/connectionPathService.ts — Endpoint → switch → … → FortiGate
 * connection path resolver.
 *
 * Walks the upward dependency chain from an arbitrary asset back to its
 * upstream FortiGate so the Device Map topology overlay can dim everything
 * off the path. Handles four start-cases: firewall (path is just self),
 * switch / AP (start the upward walk from self), endpoint (parse
 * `lastSeenSwitch` to find the upstream switch first).
 *
 * Source-of-truth for hops above the endpoint:
 *   1. AssetDependencyParent (preferred — handles MCLAG / multi-hop chains;
 *      override rows take precedence over computed per existing convention).
 *   2. fortinetTopology.controllerFortigate / .parentSwitch fallback when no
 *      dependency rows exist yet (fresh installs before backfillDependencyTree
 *      runs, or freshly-discovered switches that haven't been re-recomputed).
 */

import { prisma } from "../db.js";
import type { Asset } from "../generated/prisma/client.js";
import {
  buildInfraParentIndex,
  parentAssetWhereOr,
  readControllerStamp,
  readParentSwitchStamp,
  resolveInfraParentAsset,
} from "../utils/fortinetParentKey.js";

export type ConnectionHopKind = "endpoint" | "switch" | "firewall";

export interface ConnectionPathHop {
  kind: ConnectionHopKind;
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  assetType: string;
  monitorStatus: string | null;
  monitored: boolean;
  /** Port on this switch where the previous (downstream) hop plugs in.
   *  Populated on the first switch hop after an endpoint, parsed from
   *  `Asset.lastSeenSwitch` ("<switchId>/<portName>"). */
  endpointPort?: string;
  /** Local interface on this switch / AP that goes UP to the next hop.
   *  From `fortinetTopology.uplinkInterface`. */
  uplinkInterface?: string;
}

export interface ConnectionPath {
  asset: {
    id: string;
    hostname: string | null;
    ipAddress: string | null;
    macAddress: string | null;
    assetType: string;
    monitorStatus: string | null;
  };
  hops: ConnectionPathHop[];
  /** Sum across every walked hop of (parents - 1), where >1 parent indicates
   *  MCLAG / dual-homed redundancy. The chosen parent at each hop is the one
   *  with monitorStatus="up" + most recent lastMonitorAt; the rest are tracked
   *  here so the UI can hint "+N alternate uplinks". */
  alternateUplinks: number;
  /** The FortiGate at the top of the chain, when one was reached.
   *  null when the walk terminates without hitting a firewall (orphan asset
   *  with no `lastSeenSwitch`, or upstream chain not yet discovered). */
  siteId: string | null;
}

const MAX_HOPS = 16; // sanity cap against pathological data / cycles

export async function resolveConnectionPath(assetId: string): Promise<ConnectionPath | null> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) return null;

  const hops: ConnectionPathHop[] = [];
  const seen = new Set<string>([asset.id]);

  // Asset itself is the leaf hop. Kind reflects assetType so the frontend
  // doesn't have to translate again.
  const leafKind: ConnectionHopKind =
    asset.assetType === "firewall" ? "firewall" :
    asset.assetType === "switch" || asset.assetType === "access_point" ? "switch" :
    "endpoint";
  hops.push(toHop(asset, leafKind));

  // Firewall short-circuit.
  if (leafKind === "firewall") {
    return { asset: shapeAsset(asset), hops, alternateUplinks: 0, siteId: asset.id };
  }

  // For endpoints, hop 1 above leaf is the switch resolved from lastSeenSwitch.
  let walkStartId: string | null = null;
  if (leafKind === "endpoint") {
    const parsed = parseLastSeenSwitch(asset.lastSeenSwitch);
    if (parsed) {
      const sw = await findSwitchByName(parsed.switchId, asset);
      if (sw && !seen.has(sw.id)) {
        seen.add(sw.id);
        const swHop = toHop(sw, "switch");
        if (parsed.port) swHop.endpointPort = parsed.port;
        const uplink = uplinkInterfaceOf(sw);
        if (uplink) swHop.uplinkInterface = uplink;
        hops.push(swHop);
        walkStartId = sw.id;
      }
    }
  } else {
    // Switch / AP — walk starts from the leaf itself.
    walkStartId = asset.id;
    const uplink = uplinkInterfaceOf(asset);
    if (uplink) hops[0].uplinkInterface = uplink;
  }

  // Walk upward via dependency tree → firewall.
  let alternateUplinks = 0;
  let cursorId: string | null = walkStartId;
  for (let i = 0; cursorId && i < MAX_HOPS; i++) {
    const parents = await getEffectiveParents(cursorId);
    if (parents.length === 0) {
      // Fallback: read fortinetTopology.controllerFortigate (or parentSwitch
      // for an AP standing in the chain) and resolve it directly.
      const cur = await prisma.asset.findUnique({ where: { id: cursorId } });
      const fallback = await resolveTopologyFallback(cur);
      if (!fallback || seen.has(fallback.id)) break;
      seen.add(fallback.id);
      hops.push(toHop(fallback, fallback.assetType === "firewall" ? "firewall" : "switch"));
      if (fallback.assetType === "firewall") break;
      cursorId = fallback.id;
      continue;
    }
    const sorted = sortParentsByPreference(parents);
    const best = sorted[0];
    if (!best || seen.has(best.id)) break;
    seen.add(best.id);
    alternateUplinks += sorted.length - 1;
    const hopKind: ConnectionHopKind =
      best.assetType === "firewall" ? "firewall" : "switch";
    const hop = toHop(best, hopKind);
    if (hopKind === "switch") {
      const uplink = uplinkInterfaceOf(best);
      if (uplink) hop.uplinkInterface = uplink;
    }
    hops.push(hop);
    if (hopKind === "firewall") break;
    cursorId = best.id;
  }

  const last = hops[hops.length - 1];
  const siteId = last && last.kind === "firewall" ? last.id : null;
  return { asset: shapeAsset(asset), hops, alternateUplinks, siteId };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseLastSeenSwitch(s: string | null): { switchId: string; port: string } | null {
  if (!s) return null;
  const idx = s.indexOf("/");
  if (idx === -1) return { switchId: s.trim(), port: "" };
  return { switchId: s.substring(0, idx).trim(), port: s.substring(idx + 1).trim() };
}

async function findSwitchByName(switchId: string, endpoint: Asset): Promise<Asset | null> {
  // FortiSwitch discovery stamps the device's `switch-id` (a hostname-like
  // FS-XXXX-NN form) into Asset.hostname, and the device serial into
  // Asset.serialNumber. lastSeenSwitch can carry either form depending on
  // which discovery path stamped it; check both.
  const candidates = await prisma.asset.findMany({
    where: {
      assetType: "switch",
      OR: [{ hostname: switchId }, { serialNumber: switchId }],
    },
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Several switches carry this name (business rule 91 — a FortiLink fleet
  // naming its switch-ids per site). Pick by what this endpoint is known to
  // sit behind, the same way the dependency tree does: the switches whose
  // forwarding tables hold its MAC, then the gates that sighted it (freshest
  // first). Nothing decisive ⇒ no switch hop, never the first row returned.
  const controllerOr = candidates.flatMap((c) => parentAssetWhereOr(readControllerStamp(c.fortinetTopology)));
  const [controllers, macTableRows, sightings] = await Promise.all([
    controllerOr.length > 0
      ? prisma.asset.findMany({ where: { assetType: "firewall", OR: controllerOr } })
      : Promise.resolve([] as Asset[]),
    prisma.assetMacTableEntry.findMany({
      where:   { matchedAssetId: endpoint.id, status: "learned", lastSeen: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
      select:  { assetId: true },
      orderBy: { lastSeen: "desc" },
    }),
    prisma.assetFortigateSighting.findMany({
      where:   { assetId: endpoint.id, NOT: { fortigateDevice: "" } },
      select:  { fortigateDevice: true },
      orderBy: { lastSeen: "desc" },
    }),
  ]);
  const index = buildInfraParentIndex([...candidates, ...controllers]);
  const gateIds: string[] = [];
  for (const s of sightings) {
    const gate = resolveInfraParentAsset(index, { name: s.fortigateDevice }, "firewall");
    if (gate && !gateIds.includes(gate.id)) gateIds.push(gate.id);
  }
  const hit = resolveInfraParentAsset(index, { name: switchId }, "switch", {
    preferIds: [...new Set(macTableRows.map((r) => r.assetId))],
    gateIds,
  });
  return hit ? (candidates.find((c) => c.id === hit.id) ?? null) : null;
}

async function getEffectiveParents(assetId: string): Promise<Asset[]> {
  const rows = await prisma.assetDependencyParent.findMany({
    where: { assetId },
    include: { parent: true },
  });
  if (rows.length === 0) return [];
  const overrides = rows.filter((r) => r.source === "override");
  const effective = overrides.length > 0 ? overrides : rows.filter((r) => r.source === "computed");
  return effective.map((r) => r.parent);
}

function sortParentsByPreference(parents: Asset[]): Asset[] {
  return [...parents].sort((a, b) => {
    const aUp = a.monitorStatus === "up" ? 0 : 1;
    const bUp = b.monitorStatus === "up" ? 0 : 1;
    if (aUp !== bUp) return aUp - bUp;
    const aLast = a.lastMonitorAt?.getTime() ?? 0;
    const bLast = b.lastMonitorAt?.getTime() ?? 0;
    return bLast - aLast;
  });
}

/**
 * Fetch the parent asset a child's topology stamp names.
 *
 * The stamp is matched serial-first, then against the candidate's own FMG
 * device-name stamp, then its hostname (see utils/fortinetParentKey.ts) —
 * matching hostname ALONE, as this did before 2026-08, resolved nothing on
 * installs whose FMG device names differ from their gates' configured
 * hostnames, so the path simply ended at the switch.
 */
async function fetchStampedParent(
  stamp: { serial?: string | null; name?: string | null },
  assetType: string,
): Promise<Asset | null> {
  const or = parentAssetWhereOr(stamp);
  if (or.length === 0) return null;
  const candidates = await prisma.asset.findMany({ where: { assetType, OR: or } });
  if (candidates.length === 0) return null;
  // One query, then the shared precedence — never let SQL pick among matches.
  const hit = resolveInfraParentAsset(buildInfraParentIndex(candidates), stamp, assetType);
  return hit ? (candidates.find((c) => c.id === hit.id) ?? null) : null;
}

async function resolveTopologyFallback(asset: Asset | null): Promise<Asset | null> {
  if (!asset) return null;
  const controller = readControllerStamp(asset.fortinetTopology);
  const parentSwitch = readParentSwitchStamp(asset.fortinetTopology);
  // For a switch that stamps its controller, jump straight to the FortiGate.
  if (asset.assetType === "switch" && (controller.name || controller.serial)) {
    return fetchStampedParent(controller, "firewall");
  }
  // For an AP that stamps parentSwitch, hop to the switch (which on next loop
  // iteration will jump to its FortiGate via its own dependency rows or
  // controller stamp).
  if (asset.assetType === "access_point" && parentSwitch.name) {
    return fetchStampedParent(parentSwitch, "switch");
  }
  if (asset.assetType === "access_point" && (controller.name || controller.serial)) {
    return fetchStampedParent(controller, "firewall");
  }
  return null;
}

function uplinkInterfaceOf(asset: Asset): string | undefined {
  const ft = (asset.fortinetTopology as { uplinkInterface?: string } | null) ?? null;
  const v = ft?.uplinkInterface;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toHop(a: Asset, kind: ConnectionHopKind): ConnectionPathHop {
  return {
    kind,
    id: a.id,
    hostname: a.hostname,
    ipAddress: a.ipAddress,
    macAddress: a.macAddress,
    assetType: a.assetType,
    monitorStatus: a.monitorStatus,
    monitored: a.monitored,
  };
}

function shapeAsset(a: Asset) {
  return {
    id: a.id,
    hostname: a.hostname,
    ipAddress: a.ipAddress,
    macAddress: a.macAddress,
    assetType: a.assetType,
    monitorStatus: a.monitorStatus,
  };
}
