/**
 * src/utils/vlanNames.ts
 *
 * VLAN id → name, read off the VLAN interfaces a device already reports.
 *
 * A VLAN has no name of its own in the data Polaris collects — it has the name
 * of the interface that carries it. On a FortiGate that is the VLAN interface
 * (`Users_VL30`, `vlanid 30`); on a FortiLink-managed FortiSwitch the VLANs ARE
 * the controller FortiGate's VLAN interfaces on the FortiLink, which is why the
 * service reads the gate's rows for a switch.
 *
 * One VLAN id can sit under several parents on one gate (VLAN 30 on the
 * FortiLink AND on port5, with different names). Picking either would put a
 * wrong name on a port, so a tie is settled only by a FortiLink parent and
 * otherwise leaves the id unnamed — the caller shows the number.
 *
 * Pure — no DB access.
 */

import { isVlanId } from "./portVlans.js";

/** The AssetInterface columns this reads. */
export interface VlanInterfaceRow {
  ifName: string;
  ifParent: string | null;
  vlanId: number | null;
}

const FORTILINK_PARENT = /fortilink/i;

/** Names by VLAN id, from one device's VLAN interfaces. Ambiguous ids are omitted. */
export function vlanNamesFromInterfaces(rows: readonly VlanInterfaceRow[]): Map<number, string> {
  const byId = new Map<number, VlanInterfaceRow[]>();
  for (const r of rows) {
    if (r.vlanId == null || !isVlanId(r.vlanId) || !r.ifName) continue;
    const list = byId.get(r.vlanId);
    if (list) list.push(r);
    else byId.set(r.vlanId, [r]);
  }
  const out = new Map<number, string>();
  for (const [id, list] of byId.entries()) {
    const names = new Set(list.map((r) => r.ifName));
    if (names.size === 1) { out.set(id, list[0].ifName); continue; }
    const onFortilink = new Set(list.filter((r) => r.ifParent && FORTILINK_PARENT.test(r.ifParent)).map((r) => r.ifName));
    if (onFortilink.size === 1) out.set(id, [...onFortilink][0]);
  }
  return out;
}

/**
 * Layer name maps, first wins per id: the device's OWN VLAN interfaces before
 * its controller's, since a name the device states itself is the closer one.
 */
export function mergeVlanNames(...layers: ReadonlyArray<ReadonlyMap<number, string>>): Map<number, string> {
  const out = new Map<number, string>();
  for (const layer of layers) {
    for (const [id, name] of layer.entries()) if (!out.has(id)) out.set(id, name);
  }
  return out;
}
