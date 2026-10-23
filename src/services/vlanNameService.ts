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
 * Fill the VLAN of MAC-table rows the switch reported without one, from the
 * access port each was learned on (utils/macForwarding.ts fillAccessPortVlans).
 */
export async function fillMacTableVlans<T extends { vlanId: number | null; ifName: string | null }>(
  assetId: string,
  entries: readonly T[],
): Promise<Array<T & { vlanInferred: boolean }>> {
  if (!entries.some((e) => e.vlanId == null && e.ifName)) {
    return entries.map((e) => ({ ...e, vlanInferred: false }));
  }
  const rows = await prisma.assetInterface.findMany({
    where: { assetId },
    select: { ifName: true, nativeVlan: true, taggedVlans: true, trunksAllVlans: true },
  });
  const ports = new Map<string, PortVlanState>(rows.map((r) => [r.ifName, {
    nativeVlan: r.nativeVlan,
    taggedVlans: r.taggedVlans ?? [],
    trunksAllVlans: r.trunksAllVlans === true,
  }]));
  return fillAccessPortVlans(entries, ports);
}
