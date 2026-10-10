/**
 * src/utils/inventoryLocality.ts — is a device-inventory sighting LOCAL to
 * the gate that reported it?
 *
 * FortiOS's device inventory (`user/device/query`) is not purely a list of
 * LAN clients: a ZTNA access proxy session creates an inventory entry on the
 * gate the user connects THROUGH, carrying the client's identity (MAC,
 * hostname, IP) relayed by FortiClient — with a fresh `last_seen` and no
 * physical presence behind that gate at all (prod 2026-08: a roaming user's
 * dock MAC held a fresh entry on a gate three sites away, which won the
 * asset's learned location and primary MAC every discovery run).
 *
 * So before an inventory row is allowed to LOCATE a device — name the
 * endpoint gate, fill learnedLocation, stake an IP claim, stamp the MAC
 * entry's device, corroborate a DHCP claim — it must show local evidence:
 *
 *   • FortiSwitch attribution on the row itself (`fortiswitch_id` /
 *     `switch_fortilink` + port) — the gate's own FortiLink saw the client
 *     on a managed switch port; wired-local by definition.
 *   • FortiAP attribution (`ap_name` / `fortiap`) — associated to one of the
 *     gate's own APs; wireless-local by definition.
 *   • An ARP binding for the same MAC on the same gate this cycle — the gate
 *     resolved the address on its own wire within the last few minutes. This
 *     covers clients on the gate's own LAN ports (no managed switch/AP), and
 *     it is deliberately INDEPENDENT evidence: a DHCP lease can't corroborate
 *     an inventory row, because the inventory row's own job (in
 *     `scoreAddressClaim`) is to corroborate the lease — a stale lease plus the
 *     ZTNA entry it left behind must not vouch for each other.
 *
 * Absence of ARP is never negative evidence on its own (the read fails
 * routinely — offline gate, no monitor scope), which is why the predicate
 * requires POSITIVE evidence rather than rejecting on a missing signal: a
 * row with switch/AP attribution stays local even when the gate's ARP read
 * failed, and a row with none of the three simply doesn't get to locate.
 * A non-local row still contributes what it truly knows — presence (the
 * device is alive somewhere), OS/vendor fingerprints, the user sighting.
 */

/**
 * Extract FortiSwitch attribution from a raw `user/device/query` client row.
 * Field names vary by FortiOS build: older builds emit `switch_fortilink` /
 * `fortiswitch` / `switch_port` (numeric), 7.x builds emit `fortiswitch_id` /
 * `fortiswitch_port_id` (numeric) / `fortiswitch_port_name` ("port43").
 * Shared by the FMG-proxied and standalone-FortiGate parsers so the fallback
 * chains can't drift. `switchPort` comes back BARE ("43") — the sync layer
 * renders it as `${switchName}/port${switchPort}`, so a port_name's own
 * "port" prefix is stripped rather than doubled.
 */
export function inventorySwitchAttribution(
  client: Record<string, any>,
): { switchName: string; switchPort: string } {
  const switchName = client.switch_fortilink || client.fortiswitch || client.fortiswitch_id || "";
  const rawPort = client.switch_port ?? client.fortiswitch_port_id ?? client.fortiswitch_port_name;
  const switchPort = rawPort != null && rawPort !== ""
    ? String(rawPort).replace(/^port/i, "")
    : "";
  return { switchName: String(switchName), switchPort };
}

/**
 * The `format=` field list both inventory queries request. One constant so
 * adding a field (as the fortiswitch_* aliases were, 2026-08) lands on both
 * transports at once.
 */
export const INVENTORY_QUERY_FORMAT =
  "mac|ip|hostname|host|os|type|os_version|hardware_vendor|interface" +
  "|switch_fortilink|fortiswitch|fortiswitch_id|switch_port|fortiswitch_port_id|fortiswitch_port_name" +
  "|ap_name|fortiap|user|detected_user|is_online|last_seen";

/** Key shape shared by the index and the predicate: `MAC|device-lower`. */
function macDeviceKey(mac: string, device: string): string {
  return `${mac}|${device.toLowerCase()}`;
}

/**
 * Build the (MAC, gate) index from this run's ARP tables. MACs normalize to
 * colon-uppercase (the shape discovery uses everywhere); rows missing either
 * half are skipped.
 */
export function buildArpMacDeviceIndex(
  arpRows: ReadonlyArray<{ fortigateDevice?: string | null; mac?: string | null }> | null | undefined,
): Set<string> {
  const index = new Set<string>();
  for (const row of arpRows || []) {
    if (!row?.mac || !row.fortigateDevice) continue;
    const mac = String(row.mac).toUpperCase().replace(/-/g, ":");
    index.add(macDeviceKey(mac, String(row.fortigateDevice)));
  }
  return index;
}

/**
 * True when this inventory row carries local evidence for its own gate.
 * `inv.macAddress` may be raw (dash-separated / lowercase) — normalized here
 * so callers can pass the DiscoveredInventoryDevice as-is.
 */
export function inventorySightingIsLocal(
  inv: {
    device?: string | null;
    macAddress?: string | null;
    switchName?: string | null;
    apName?: string | null;
  },
  arpMacDeviceIndex: ReadonlySet<string>,
): boolean {
  if (inv.switchName || inv.apName) return true;
  if (!inv.macAddress || !inv.device) return false;
  const mac = String(inv.macAddress).toUpperCase().replace(/-/g, ":");
  return arpMacDeviceIndex.has(macDeviceKey(mac, String(inv.device)));
}
