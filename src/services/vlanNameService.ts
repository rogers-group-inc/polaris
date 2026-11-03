/**
 * src/services/vlanNameService.ts
 *
 * VLAN names for one asset, and the MAC table's VLAN fill — what lets the
 * Interfaces and MAC Table tabs show `Users_VL30` instead of `30`.
 *
 * Names come from VLAN interfaces already in AssetInterface (see
 * utils/vlanNames.ts for the tie rule): the asset's own first, then its
 * controller FortiGate's, resolved through utils/fortinetParentKey.ts — never
 * by matching `controllerFortigate` against a hostname. An asset with no
 * controller stamp (a non-Fortinet switch, a FortiGate itself) reads only its
 * own rows, and an id nothing names is simply absent: the UI shows the number.
 *
 * Read-only, per request. Two or three small indexed queries; nothing here
 * runs on a ticking loop.
 */

import { prisma } from "../db.js";
import {
  buildInfraParentIndex,
  parentAssetWhereOr,
  readControllerStamp,
  resolveInfraParentAsset,
} from "../utils/fortinetParentKey.js";
import { fillAccessPortVlans, type PortVlanState } from "../utils/macForwarding.js";
import { mergeVlanNames, vlanNamesFromInterfaces, type VlanInterfaceRow } from "../utils/vlanNames.js";

const VLAN_IFACE_SELECT = { ifName: true, ifParent: true, vlanId: true } as const;

async function vlanInterfacesOf(assetId: string): Promise<VlanInterfaceRow[]> {
  return prisma.assetInterface.findMany({
    where: { assetId, ifType: "vlan", vlanId: { not: null } },
    select: VLAN_IFACE_SELECT,
  });
}

async function controllerGateIdOf(fortinetTopology: unknown): Promise<string | null> {
  const stamp = readControllerStamp(fortinetTopology);
  const or = parentAssetWhereOr(stamp);
  if (or.length === 0) return null;
  const candidates = await prisma.asset.findMany({
    where: { assetType: "firewall", OR: or as never },
    select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
  });
  const hit = resolveInfraParentAsset(buildInfraParentIndex(candidates), stamp, "firewall");
  return hit?.id ?? null;
}

/**
 * VLAN id → name for one asset, as a plain object keyed by the id's string
 * (the JSON shape both tabs read). Empty when nothing names any VLAN.
 */
export async function getVlanNamesForAsset(assetId: string): Promise<Record<string, string>> {
  const [asset, own] = await Promise.all([
    prisma.asset.findUnique({ where: { id: assetId }, select: { fortinetTopology: true } }),
    vlanInterfacesOf(assetId),
  ]);
  if (!asset) return {};
  const gateId = await controllerGateIdOf(asset.fortinetTopology);
  const gate = gateId && gateId !== assetId ? await vlanInterfacesOf(gateId) : [];
  const merged = mergeVlanNames(vlanNamesFromInterfaces(own), vlanNamesFromInterfaces(gate));
  const out: Record<string, string> = {};
  for (const [id, name] of merged.entries()) out[String(id)] = name;
  return out;
}

/**
 * Every port's VLAN configuration (native, tagged, trunk-all) for a set of
 * assets, in ONE query: asset id → ifName → state. ALL of an asset's ports,
 * not just the ones a caller will print — fillAccessPortVlans decides whether
 * a switch reports a tagged dimension across every port it has.
 */
export async function readPortVlans(assetIds: readonly string[]): Promise<Map<string, Map<string, PortVlanState>>> {
  const out = new Map<string, Map<string, PortVlanState>>();
  if (assetIds.length === 0) return out;
  const rows = await prisma.assetInterface.findMany({
    where: { assetId: { in: [...assetIds] } },
    select: { assetId: true, ifName: true, nativeVlan: true, taggedVlans: true, trunksAllVlans: true },
  });
  for (const r of rows) {
    let ports = out.get(r.assetId);
    if (!ports) { ports = new Map(); out.set(r.assetId, ports); }
    ports.set(r.ifName, {
      nativeVlan: r.nativeVlan,
      taggedVlans: r.taggedVlans ?? [],
      trunksAllVlans: r.trunksAllVlans === true,
    });
  }
  return out;
}

/**
 * The MAC Table's per-port VLAN line — what the port is CONFIGURED to carry,
 * beside the VLAN each entry was learned in: ifName → { nativeVlan,
 * taggedVlans, trunksAllVlans }, for the ports in `ifNames` only, and only
 * when the port states something (a port with no native, no tagged and no
 * trunk-all is absent, and the UI says nothing rather than "native —").
 */
export function portVlansFor(
  ports: ReadonlyMap<string, PortVlanState> | undefined,
  ifNames: Iterable<string | null>,
): Record<string, PortVlanState> {
  const out: Record<string, PortVlanState> = {};
  if (!ports) return out;
  for (const n of ifNames) {
    if (!n || out[n]) continue;
    const p = ports.get(n);
    if (!p || (p.nativeVlan == null && p.taggedVlans.length === 0 && !p.trunksAllVlans)) continue;
    out[n] = { nativeVlan: p.nativeVlan, taggedVlans: [...p.taggedVlans], trunksAllVlans: p.trunksAllVlans };
  }
  return out;
}

/**
 * Fill the VLAN of MAC-table rows the switch reported without one, from the
 * access port each was learned on (utils/macForwarding.ts fillAccessPortVlans).
 * `ports` is the switch's readPortVlans result when the caller already has it
 * (the MAC Table route reads it anyway for the per-port VLAN line); without
 * it the ports are read here, and only when a row needs filling.
 */
export async function fillMacTableVlans<T extends { vlanId: number | null; ifName: string | null }>(
  assetId: string,
  entries: readonly T[],
  ports?: ReadonlyMap<string, PortVlanState>,
): Promise<Array<T & { vlanInferred: boolean }>> {
  if (!entries.some((e) => e.vlanId == null && e.ifName)) {
    return entries.map((e) => ({ ...e, vlanInferred: false }));
  }
  const resolved = ports ?? (await readPortVlans([assetId])).get(assetId) ?? new Map<string, PortVlanState>();
  return fillAccessPortVlans(entries, resolved);
}
