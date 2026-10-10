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
  "mac|ipv4_address|ip|hostname|host|os_name|os|type|os_version|hardware_vendor|detected_interface|interface" +
  "|switch_fortilink|fortiswitch|fortiswitch_id|switch_port|fortiswitch_port_id|fortiswitch_port_name" +
  "|ap_name|fortiap|user|detected_user|unauth_user|is_online|last_seen";

/** One parsed `user/device/query` client row — the DiscoveredInventoryDevice shape. */
export interface ParsedInventoryClient {
  device: string;
  macAddress: string;
  ipAddress: string;
  hostname: string;
  os: string;
  osVersion: string;
  hardwareVendor: string;
  interfaceName: string;
  switchName: string;
  switchPort: string;
  apName: string;
  user: string;
  isOnline: boolean;
  lastSeen: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * Parse one raw `user/device/query` client row, for both the FMG-proxied and
 * the standalone-FortiGate collectors. Field names vary by FortiOS build, and
 * a name this parser doesn't know reads as EMPTY rather than failing — which
 * is how every row's IP went missing on 7.x (prod 2026-10-10): the build
 * reports `ipv4_address`, the parser read only `ip`, and with no address the
 * detected-device claim — business rule 101's strongest — never fired. So each
 * field takes the 7.x name first and the older one after:
 *
 *   address   ipv4_address → ip
 *   OS        os_name → os → type
 *   interface detected_interface → interface
 *   user      user → detected_user → unauth_user
 *
 * Returns null for a row with neither MAC nor address, or no `last_seen`.
 */
export function parseInventoryClient(client: Record<string, any>, device: string): ParsedInventoryClient | null {
  const mac = str(client.mac);
  const ip = str(client.ipv4_address) || str(client.ip);
  if (!mac && !ip) return null;
  if (!client.last_seen) return null;
  const sw = inventorySwitchAttribution(client);
  return {
    device,
    macAddress: mac,
    ipAddress: ip,
    hostname: str(client.hostname) || str(client.host),
    os: str(client.os_name) || str(client.os) || str(client.type),
    osVersion: str(client.os_version),
    hardwareVendor: str(client.hardware_vendor),
    interfaceName: str(client.detected_interface) || str(client.interface),
    switchName: sw.switchName,
    switchPort: sw.switchPort,
    apName: str(client.ap_name) || str(client.fortiap),
    user: str(client.user) || str(client.detected_user) || str(client.unauth_user),
    isOnline: !!client.is_online,
    lastSeen: new Date(Number(client.last_seen) * 1000).toISOString(),
  };
}

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
