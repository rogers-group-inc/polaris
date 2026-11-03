/**
 * src/services/controllerChildrenService.ts
 *
 * The FortiGate's view of its managed children: every FortiAP's wireless
 * clients and every FortiSwitch's forwarding database, read back from the
 * rows each child already holds (AssetWirelessStation, AssetMacTableEntry).
 * What feeds the firewall slide-over's Wireless and MAC Table tabs, so an
 * operator at the gate can ask "where is this MAC on the site" without
 * opening each switch and AP in turn.
 *
 * Children are found by the controller stamp through
 * utils/fortinetParentKey.ts (`controllerStampWhereOr`) — never by matching
 * `controllerFortigate` against the gate's hostname, which is the FMG device
 * name and silently misses on an install where the two differ.
 *
 * Read-only, per request. A fixed handful of queries however many children
 * the gate has: one for the children, one for their rows (an `IN` over the
 * child ids, which is bounded by one gate's FortiLink / CAPWAP fan-out), one
 * for the switches' port VLAN state and one for the gate's VLAN names.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { EXCLUDED_LIFECYCLE_STATUSES } from "../utils/assetInvariants.js";
import { controllerStampWhereOr, readFirewallDeviceName } from "../utils/fortinetParentKey.js";
import { fillAccessPortVlans, type PortVlanState } from "../utils/macForwarding.js";
import { getVlanNamesForAsset } from "./vlanNameService.js";

export type ControllerChildType = "access_point" | "switch";

export interface ControllerChild {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  model: string | null;
  serialNumber: string | null;
  monitored: boolean;
  monitorStatus: string | null;
  lastSystemInfoAt: Date | null;
}

const CHILD_SELECT = {
  id: true, hostname: true, ipAddress: true, model: true, serialNumber: true,
  monitored: true, monitorStatus: true, lastSystemInfoAt: true,
} as const;

const MATCHED_SELECT = { id: true, hostname: true, ipAddress: true, assetType: true } as const;

/**
 * The live (non-decommissioned, non-disabled) children of one gate of one
 * type, ordered by hostname. 404 when the gate does not exist; EMPTY when it
 * exposes no identity to match a stamp against.
 */
export async function listControllerChildren(
  gateId: string,
  assetType: ControllerChildType,
): Promise<ControllerChild[]> {
  const rows = await findChildren(gateId, [assetType], CHILD_SELECT);
  return rows.sort(byHostname);
}

/**
 * How many FortiAPs and FortiSwitches the gate controls — what decides
 * whether the slide-over draws the Wireless and MAC Table tabs at all, so a
 * gate with no managed children carries no tabs that can never fill. One
 * id-and-type query; the rows themselves load when a tab is clicked.
 */
export async function countControllerChildren(gateId: string): Promise<{ accessPoints: number; switches: number }> {
  const rows = await findChildren(gateId, ["access_point", "switch"], { assetType: true });
  let accessPoints = 0, switches = 0;
  for (const r of rows) {
    if (r.assetType === "access_point") accessPoints++;
    else switches++;
  }
  return { accessPoints, switches };
}

async function findChildren<S extends Record<string, true>>(
  gateId: string,
  assetTypes: ControllerChildType[],
  select: S,
) {
  const gate = await prisma.asset.findUnique({
    where: { id: gateId },
    select: { hostname: true, serialNumber: true, fortinetTopology: true },
  });
  if (!gate) throw new AppError(404, "Asset not found");
  const or = controllerStampWhereOr({
    hostname: gate.hostname,
    serialNumber: gate.serialNumber,
    deviceName: readFirewallDeviceName(gate.fortinetTopology),
  });
  // `OR: []` matches nothing in Prisma, but less obviously than this.
  if (or.length === 0) return [];
  return prisma.asset.findMany({
    where: {
      assetType: { in: assetTypes },
      status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
      AND: [{ OR: or as never }],
    },
    select,
  });
}

function byHostname(a: ControllerChild, b: ControllerChild): number {
  return String(a.hostname ?? a.id).localeCompare(String(b.hostname ?? b.id), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Every wireless client on every FortiAP the gate controls. Each station
 * carries `apAssetId`; the AP list comes back alongside so an AP with no
 * clients is still listed (and an operator can tell "no clients" from "not
 * a child of this gate").
 */
export async function getControllerWireless(gateId: string) {
  const aps = await listControllerChildren(gateId, "access_point");
  const stations = aps.length === 0 ? [] : await prisma.assetWirelessStation.findMany({
    where: { apAssetId: { in: aps.map((a) => a.id) } },
    orderBy: [{ ssid: "asc" }, { staMacAddr: "asc" }],
    select: {
      apAssetId: true, staMacAddr: true, staIpAddr: true, ssid: true, radioId: true,
      band: true, vlanId: true, bssid: true, signalStrength: true, lastSeen: true,
      matchedAsset: { select: MATCHED_SELECT },
    },
  });
  return { accessPoints: aps, stations };
}

/**
 * Every forwarding-database entry on every FortiSwitch the gate controls,
 * each tagged with `switchAssetId`. VLAN-less rows on an access port take the
 * port's native VLAN (`vlanInferred`), exactly as the switch's own MAC Table
 * tab does. VLAN names are the GATE's — the switches' VLANs are FortiLink
 * VLANs the gate defines.
 */
export async function getControllerMacTable(gateId: string) {
  const switches = await listControllerChildren(gateId, "switch");
  if (switches.length === 0) {
    return { switches: [], entries: [], vlanNames: await getVlanNamesForAsset(gateId) };
  }
  const ids = switches.map((s) => s.id);
  const rows = await prisma.assetMacTableEntry.findMany({
    where: { assetId: { in: ids } },
    orderBy: [{ assetId: "asc" }, { ifName: "asc" }, { macAddress: "asc" }],
    select: {
      assetId: true, macAddress: true, vlanId: true, basePort: true, ifName: true,
      status: true, lastSeen: true,
      matchedAsset: { select: MATCHED_SELECT },
    },
  });
  // Port VLAN state only for the switches that have a VLAN-less row to fill.
  const needFill = [...new Set(rows.filter((r) => r.vlanId == null && r.ifName).map((r) => r.assetId))];
  const [ifaces, vlanNames] = await Promise.all([
    needFill.length === 0 ? Promise.resolve([]) : prisma.assetInterface.findMany({
      where: { assetId: { in: needFill } },
      select: { assetId: true, ifName: true, nativeVlan: true, taggedVlans: true, trunksAllVlans: true },
    }),
    getVlanNamesForAsset(gateId),
  ]);
  const portsBySwitch = new Map<string, Map<string, PortVlanState>>();
  for (const i of ifaces) {
    let ports = portsBySwitch.get(i.assetId);
    if (!ports) { ports = new Map(); portsBySwitch.set(i.assetId, ports); }
    ports.set(i.ifName, {
      nativeVlan: i.nativeVlan,
      taggedVlans: i.taggedVlans ?? [],
      trunksAllVlans: i.trunksAllVlans === true,
    });
  }
  // fillAccessPortVlans decides "is there a tagged dimension" across ONE
  // switch's ports, so it runs per switch, never over the merged set.
  const bySwitch = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySwitch.get(r.assetId);
    if (list) list.push(r); else bySwitch.set(r.assetId, [r]);
  }
  const entries = [];
  for (const [switchId, list] of bySwitch) {
    const filled = fillAccessPortVlans(list, portsBySwitch.get(switchId) ?? new Map());
    for (const { assetId, ...e } of filled) entries.push({ switchAssetId: assetId, ...e });
  }
  return { switches, entries, vlanNames };
}
