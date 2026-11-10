/**
 * src/services/monitoring/fortiswitchTrunks.ts — overlayFortiswitchTrunkMembers (CQ-B061, moved verbatim from monitoringService.ts):
 * stamps a FortiSwitch trunk's member ports onto the interface list — shared by the
 * SNMP and the FortiOS REST interface collectors.
 */

import { stripTrunkRoleSuffix } from "../../utils/fortiswitchTrunkMap.js";
import { InterfaceSample } from "./types.js";

/**
 * Back-fill the trunk → physical-member relationship onto a managed
 * FortiSwitch's interface list, mirroring what `collectSystemInfoFortinet`
 * already does for FortiGate aggregates (the `set members "portN"` back-fill).
 *
 * SNMP IF-MIB surfaces the FortiLink uplink trunk and its physical member as
 * flat, unrelated rows — the parent/member edge lives outside it, in the
 * controller CMDB or the `fsTrunkMember` scalar. Both feed this one overlay so
 * they cannot disagree about what a member row looks like. For each trunk we:
 *   - mark the trunk row `ifType="aggregate"` (only when SNMP left it null or
 *     guessed "physical" — never clobber a real aggregate type)
 *   - stamp `ifParent=<trunk>` + `ifType="physical"` on each member row.
 *
 * `synthesizeMissing` decides what happens to a member the interface list has
 * no row for, and the two sources genuinely differ. The CMDB describes ports
 * IF-MIB may not have returned at all, so it synthesizes the row (the
 * FortiGate-aggregate back-fill does the same). The scalar comes out of the
 * SAME walk as the interface list, so a member missing from it means the walk
 * named its ports something else — `ifName` failed and `ifDescr` (the
 * operator's port DESCRIPTION on a FortiSwitch) stood in. Synthesizing then
 * invents a second identity for a port already in the list under its label,
 * in the one table that IS the identity of record for interface names, so that
 * caller passes false and back-fills only.
 *
 * Downstream, `interfaceTopologyService.preferPhysical` and the controller-
 * edge swap in `map.ts` render a single-member trunk as its physical port
 * (e.g. the serial-named FortiLink uplink → `port52`). Multi-member LACP
 * bundles keep the trunk name (no single physical port to show).
 *
 * A trunk row the walk named with a role suffix (`1CD11A4549B7-0(primary)`,
 * see `stripTrunkRoleSuffix`) is RENAMED to the trunk's own name. Otherwise
 * the members point at a parent no row carries, so the System tab lists them
 * flat and the topology layer cannot resolve the trunk to its port; and the
 * suffix keeps the name out of every other place that names trunks (the
 * peer-serial inference, FortiLink trunk preservation). Only a row whose
 * stripped name the trunk map itself lists is renamed.
 *
 * Mutates `interfaces` in place; returns the number of member links stamped.
 */
export function overlayFortiswitchTrunkMembers(
  interfaces: InterfaceSample[],
  trunkMembers: Map<string, string[]>,
  opts: { synthesizeMissing?: boolean } = {},
): number {
  if (trunkMembers.size === 0) return 0;
  const byName = new Map<string, InterfaceSample>();
  for (const i of interfaces) byName.set(i.ifName, i);
  const suffixedByBase = new Map<string, InterfaceSample>();
  for (const i of interfaces) {
    const base = stripTrunkRoleSuffix(i.ifName);
    if (base !== i.ifName && !suffixedByBase.has(base)) suffixedByBase.set(base, i);
  }
  let links = 0;
  for (const [trunkName, members] of trunkMembers) {
    if (members.length === 0) continue;
    let trunkRow = byName.get(trunkName);
    if (!trunkRow) {
      const suffixed = suffixedByBase.get(trunkName);
      if (suffixed) {
        const oldName = suffixed.ifName;
        suffixed.ifName = trunkName;
        byName.delete(oldName);
        byName.set(trunkName, suffixed);
        // A VLAN or member already parented on the suffixed name follows it.
        for (const i of interfaces) if (i.ifParent === oldName) i.ifParent = trunkName;
        trunkRow = suffixed;
      }
    }
    if (trunkRow && (!trunkRow.ifType || trunkRow.ifType === "physical")) {
      trunkRow.ifType = "aggregate";
    }
    for (const memberName of members) {
      const existing = byName.get(memberName);
      if (existing) {
        if (!existing.ifParent) existing.ifParent = trunkName;
        if (!existing.ifType) existing.ifType = "physical";
      } else if (opts.synthesizeMissing !== false) {
        const synthetic: InterfaceSample = {
          ifName:   memberName,
          ifType:   "physical",
          ifParent: trunkName,
        };
        interfaces.push(synthetic);
        byName.set(memberName, synthetic);
      } else {
        continue; // unknown member port — see synthesizeMissing above
      }
      links++;
    }
  }
  return links;
}
