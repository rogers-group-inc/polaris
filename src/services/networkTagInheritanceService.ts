/**
 * src/services/networkTagInheritanceService.ts
 *
 * Network tags inherited by the switches and ports that carry the network
 * (business rule 137). An operator tags a network in IP Management — a Priority
 * tag, or any other — and every port of that network's FortiGate's switches
 * that carries the network's VLAN gets the tag, and so does the switch.
 *
 * WHAT MATCHES. Only a network that knows the gate it came from: FortiManager /
 * FortiGate discovery stamps `Subnet.fortigateSerial` / `fortigateDevice` and the
 * interface's `vlan`. A network learned from a DHCP server, vCenter, a Generic
 * API feed or typed by hand has no gate, so it hands nothing down — there is no
 * way to tell which switch it is on. The gate is resolved to an asset through
 * utils/fortinetParentKey.ts, the same resolution a switch's own controller
 * stamp goes through (`controllerGateIdOf`), so the two meet on an asset id and
 * an FMG device name that differs from the gate's hostname still matches. A
 * port carries the VLAN when it is the port's native VLAN or one of its tagged
 * VLANs; a trunk set to allow ALL VLANs (a FortiLink uplink) never matches,
 * because it would inherit every network's tags and every uplink would read
 * Critical.
 *
 * WHICH TAGS. Every tag on the network except the system-managed ones —
 * `region:` (the Device Map's) and `azure:` (the Arc sync's), neither of which
 * means anything on a port — and the markers discovery itself stamps on a
 * network (`dhcp-discovered`, the integration type).
 *
 * PROVENANCE. Two writers already share both places a tag lands, so this one
 * owns only what it wrote:
 *   - a port tag is an AssetInterfaceTag row with source "network"; a row of
 *     any other source OCCUPIES its port and is never added beside or removed
 *     (a manual save naming an inherited tag converts it to manual);
 *   - a switch tag is in Asset.tags, with a NetworkTagAssignment row. A tag the
 *     switch already carried without one (hand-applied, or a tag filter's) is
 *     left alone and never claimed; one of ours an operator took off the switch
 *     stays off until the inheritance ends. Removing one of ours keeps the tag on the
 *     switch when a tag filter also owns it there (TagAutoAssignment), since
 *     that engine would not put it back.
 *
 * Reconciled fleet-wide at the end of reconcileAllTags (discovery end + the 6 h
 * tick), per switch from reconcileTagsForAsset (asset writes, a port VLAN
 * change), and after a network's tags / VLAN / status change
 * (`scheduleNetworkTagReconcile`, coalesced).
 */

import { prisma } from "../db.js";
import { chunkArray } from "../utils/chunk.js";
import { logger } from "../utils/logger.js";
import { isAzureTag, REGION_TAG_PREFIX } from "../utils/tagNormalize.js";
import {
  buildInfraParentIndex,
  controllerGateIdOf,
  resolveInfraParentAsset,
  type InfraParentCandidate,
} from "../utils/fortinetParentKey.js";
import { logEvent } from "./eventLogService.js";

const BATCH = 50;

/** The markers discovery stamps on a network it creates or claims. */
export const NETWORK_SYSTEM_TAGS: ReadonlySet<string> = new Set(["dhcp-discovered", "fortimanager", "fortigate"]);

/** Whether a network's tag is handed down to its switches and ports. */
export function isInheritableNetworkTag(tag: string): boolean {
  const lower = tag.trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith(REGION_TAG_PREFIX) || isAzureTag(lower)) return false;
  return !NETWORK_SYSTEM_TAGS.has(lower);
}

/** A switch port's VLAN configuration, as AssetInterface stores it. */
export interface PortVlans {
  nativeVlan: number | null;
  taggedVlans: number[];
  trunksAllVlans: boolean;
}

/** Native or tagged; an allow-all trunk never counts (see the header). */
export function portCarriesVlan(port: PortVlans, vlan: number): boolean {
  if (port.trunksAllVlans) return false;
  return port.nativeVlan === vlan || port.taggedVlans.includes(vlan);
}

export interface InheritanceNetwork {
  fortigateSerial: string | null;
  fortigateDevice: string | null;
  vlan: number;
  tags: string[];
}

export interface InheritancePort extends PortVlans {
  assetId: string;
  ifName: string;
}

export interface InheritancePlanInput {
  /** Every firewall — the gates a network or a switch stamp can name. */
  gates: InfraParentCandidate[];
  /** The switches in scope (the fleet, or one). */
  switches: InfraParentCandidate[];
  networks: InheritanceNetwork[];
  ports: InheritancePort[];
}

export interface InheritancePlan {
  /** assetId → ifName → the tags that port inherits. */
  ports: Map<string, Map<string, Set<string>>>;
  /** assetId → the tags that switch inherits. */
  assets: Map<string, Set<string>>;
}

/** Pure: which switch and port inherit which tags. No DB access. */
export function planNetworkTagInheritance(input: InheritancePlanInput): InheritancePlan {
  const plan: InheritancePlan = { ports: new Map(), assets: new Map() };
  const index = buildInfraParentIndex([...input.gates, ...input.switches]);

  // gate asset id → VLAN → tags its networks on that VLAN carry
  const byGate = new Map<string, Map<number, Set<string>>>();
  for (const n of input.networks) {
    const tags = n.tags.filter(isInheritableNetworkTag);
    if (tags.length === 0) continue;
    const gate = resolveInfraParentAsset(index, { serial: n.fortigateSerial, name: n.fortigateDevice }, "firewall");
    if (!gate) continue;
    const vlans = byGate.get(gate.id) ?? new Map<number, Set<string>>();
    const set = vlans.get(n.vlan) ?? new Set<string>();
    for (const t of tags) set.add(t);
    vlans.set(n.vlan, set);
    byGate.set(gate.id, vlans);
  }
  if (byGate.size === 0) return plan;

  const gateOfSwitch = new Map<string, Map<number, Set<string>>>();
  for (const s of input.switches) {
    const gateId = controllerGateIdOf(index, s);
    const vlans = gateId ? byGate.get(gateId) : undefined;
    if (vlans) gateOfSwitch.set(s.id, vlans);
  }

  for (const p of input.ports) {
    const vlans = gateOfSwitch.get(p.assetId);
    if (!vlans) continue;
    for (const [vlan, tags] of vlans) {
      if (!portCarriesVlan(p, vlan)) continue;
      const byPort = plan.ports.get(p.assetId) ?? new Map<string, Set<string>>();
      const portTags = byPort.get(p.ifName) ?? new Set<string>();
      const assetTags = plan.assets.get(p.assetId) ?? new Set<string>();
      for (const t of tags) {
        portTags.add(t);
        assetTags.add(t);
      }
      byPort.set(p.ifName, portTags);
      plan.ports.set(p.assetId, byPort);
      plan.assets.set(p.assetId, assetTags);
    }
  }
  return plan;
}

const INFRA_SELECT = { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true } as const;

/** Load what the planner needs for the fleet, or for one switch. */
async function loadPlan(assetId?: string): Promise<InheritancePlan> {
  const empty: InheritancePlan = { ports: new Map(), assets: new Map() };
  const rows = await prisma.subnet.findMany({
    where: {
      vlan: { not: null },
      status: { not: "deprecated" },
      NOT: { tags: { isEmpty: true } },
      OR: [{ fortigateSerial: { not: null } }, { fortigateDevice: { not: null } }],
    },
    select: { fortigateSerial: true, fortigateDevice: true, vlan: true, tags: true },
  });
  const networks: InheritanceNetwork[] = rows
    .filter((r) => r.vlan != null && r.tags.some(isInheritableNetworkTag))
    .map((r) => ({ fortigateSerial: r.fortigateSerial, fortigateDevice: r.fortigateDevice, vlan: r.vlan as number, tags: r.tags }));
  if (networks.length === 0) return empty;

  const [gates, switches] = await Promise.all([
    prisma.asset.findMany({ where: { assetType: "firewall" }, select: INFRA_SELECT }),
    prisma.asset.findMany({
      where: { assetType: "switch", status: { not: "decommissioned" }, ...(assetId ? { id: assetId } : {}) },
      select: INFRA_SELECT,
    }),
  ]);
  if (switches.length === 0) return empty;

  // By VLAN, not by switch id: a handful of VLAN ids narrows the largest
  // current-state table where an IN list of every switch would not.
  const vlans = [...new Set(networks.map((n) => n.vlan))];
  const ports = await prisma.assetInterface.findMany({
    where: {
      ...(assetId ? { assetId } : {}),
      trunksAllVlans: false,
      OR: [{ nativeVlan: { in: vlans } }, { taggedVlans: { hasSome: vlans } }],
    },
    select: { assetId: true, ifName: true, nativeVlan: true, taggedVlans: true, trunksAllVlans: true },
  });
  return planNetworkTagInheritance({ gates, switches, networks, ports });
}

export interface NetworkTagReconcileSummary extends Record<string, unknown> {
  assetsAdded: number;
  assetsRemoved: number;
  portsAdded: number;
  portsRemoved: number;
}

const portTagKey = (assetId: string, ifName: string, tag: string): string =>
  assetId + "\u0000" + ifName + "\u0000" + tag;

/** Diff the plan's port tags against the stored rows and write the difference. */
async function applyPortTags(plan: InheritancePlan, assetId?: string): Promise<{ added: number; removed: number }> {
  const scope = assetId ? { assetId } : {};
  const expected: { assetId: string; ifName: string; tag: string }[] = [];
  for (const [aid, byPort] of plan.ports) {
    for (const [ifName, tags] of byPort) for (const tag of tags) expected.push({ assetId: aid, ifName, tag });
  }
  const names = [...new Set(expected.map((e) => e.tag))];
  const [ours, occupying] = await Promise.all([
    prisma.assetInterfaceTag.findMany({ where: { ...scope, source: "network" }, select: { assetId: true, ifName: true, tag: true } }),
    names.length
      ? prisma.assetInterfaceTag.findMany({ where: { ...scope, tag: { in: names } }, select: { assetId: true, ifName: true, tag: true } })
      : Promise.resolve([] as { assetId: string; ifName: string; tag: string }[]),
  ]);
  const occupied = new Set(occupying.map((r) => portTagKey(r.assetId, r.ifName, r.tag)));
  const want = new Set(expected.map((e) => portTagKey(e.assetId, e.ifName, e.tag)));
  const toAdd = expected.filter((e) => !occupied.has(portTagKey(e.assetId, e.ifName, e.tag)));
  const toRemove = ours.filter((r) => !want.has(portTagKey(r.assetId, r.ifName, r.tag)));

  if (toAdd.length > 0) {
    await prisma.assetInterfaceTag.createMany({
      data: toAdd.map((e) => ({ ...e, source: "network" })),
      skipDuplicates: true,
    });
  }
  for (const chunk of chunkArray(toRemove, BATCH)) {
    await prisma.assetInterfaceTag.deleteMany({
      where: { source: "network", OR: chunk.map((r) => ({ assetId: r.assetId, ifName: r.ifName, tag: r.tag })) },
    });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/** Diff the plan's switch tags against NetworkTagAssignment and Asset.tags. */
async function applyAssetTags(plan: InheritancePlan, assetId?: string): Promise<{ added: number; removed: number }> {
  const ours = await prisma.networkTagAssignment.findMany({
    where: assetId ? { assetId } : {},
    select: { assetId: true, tag: true },
  });
  const oursSet = new Set(ours.map((r) => r.assetId + "\u0000" + r.tag));
  const toRemove = ours.filter((r) => !plan.assets.get(r.assetId)?.has(r.tag));

  const ids = [...new Set([...plan.assets.keys(), ...toRemove.map((r) => r.assetId)])];
  if (ids.length === 0) return { added: 0, removed: 0 };
  const assets = new Map<string, string[]>();
  for (const chunk of chunkArray(ids, 500)) {
    const rows = await prisma.asset.findMany({ where: { id: { in: chunk } }, select: { id: true, tags: true } });
    for (const r of rows) assets.set(r.id, Array.isArray(r.tags) ? r.tags : []);
  }

  // A tag a filter also owns on this switch stays when ours goes: the filter
  // engine sees its own provenance and would never put it back.
  const filterOwned = new Set<string>();
  if (toRemove.length > 0) {
    const registry = await prisma.tag.findMany({
      where: { name: { in: [...new Set(toRemove.map((r) => r.tag))] } },
      select: { id: true, name: true },
    });
    if (registry.length > 0) {
      const nameOf = new Map(registry.map((t) => [t.id, t.name]));
      const prov = await prisma.tagAutoAssignment.findMany({
        where: { tagId: { in: registry.map((t) => t.id) }, assetId: { in: [...new Set(toRemove.map((r) => r.assetId))] } },
        select: { tagId: true, assetId: true },
      });
      for (const p of prov) filterOwned.add(p.assetId + "\u0000" + nameOf.get(p.tagId));
    }
  }

  const next = new Map<string, string[]>();
  const claim: { assetId: string; tag: string }[] = [];
  let added = 0;
  for (const [aid, tags] of plan.assets) {
    const current = assets.get(aid);
    if (!current) continue;
    for (const tag of tags) {
      // Ours already — on the switch, or taken off it by hand, which stands
      // (the filter engine's rule too) — or someone else's, never claimed.
      if (oursSet.has(aid + "\u0000" + tag) || current.includes(tag)) continue;
      const list = next.get(aid) ?? [...current];
      list.push(tag);
      next.set(aid, list);
      claim.push({ assetId: aid, tag });
      added++;
    }
  }
  for (const r of toRemove) {
    if (filterOwned.has(r.assetId + "\u0000" + r.tag)) continue;
    const current = next.get(r.assetId) ?? assets.get(r.assetId);
    if (!current || !current.includes(r.tag)) continue;
    next.set(r.assetId, current.filter((t) => t !== r.tag));
  }

  const updates = [...next.entries()];
  for (const chunk of chunkArray(updates, BATCH)) {
    await prisma.$transaction(chunk.map(([id, tags]) => prisma.asset.update({ where: { id }, data: { tags } })));
  }
  if (claim.length > 0) {
    await prisma.networkTagAssignment.createMany({ data: claim, skipDuplicates: true });
  }
  for (const chunk of chunkArray(toRemove, BATCH)) {
    await prisma.networkTagAssignment.deleteMany({
      where: { OR: chunk.map((r) => ({ assetId: r.assetId, tag: r.tag })) },
    });
  }
  return { added, removed: toRemove.length };
}

/**
 * Reconcile inherited network tags for the whole fleet, or for one switch.
 * Idempotent: a steady state writes nothing.
 */
export async function reconcileNetworkTags(opts: { assetId?: string } = {}): Promise<NetworkTagReconcileSummary> {
  const plan = await loadPlan(opts.assetId);
  const ports = await applyPortTags(plan, opts.assetId);
  const assets = await applyAssetTags(plan, opts.assetId);
  return { assetsAdded: assets.added, assetsRemoved: assets.removed, portsAdded: ports.added, portsRemoved: ports.removed };
}

let running: Promise<void> | null = null;
let pending = false;

/**
 * Fire-and-forget fleet reconcile after a network's tags, VLAN or status
 * changed. Coalesced: edits that land while one runs fold into a single rerun,
 * so a burst of network edits costs two passes, not one each. Writes one Event
 * when anything moved.
 */
export function scheduleNetworkTagReconcile(actor?: string): void {
  if (running) {
    pending = true;
    return;
  }
  running = (async () => {
    try {
      do {
        pending = false;
        const s = await reconcileNetworkTags();
        if (s.assetsAdded || s.assetsRemoved || s.portsAdded || s.portsRemoved) {
          await logEvent({
            action: "tag.network_inherited",
            resourceType: "tag",
            actor,
            message: `Network tags inherited: switches +${s.assetsAdded} / -${s.assetsRemoved}, ports +${s.portsAdded} / -${s.portsRemoved}`,
            details: s,
          });
        }
      } while (pending);
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err) }, "network tag inheritance: reconcile failed (non-fatal)");
    } finally {
      running = null;
    }
  })();
}
