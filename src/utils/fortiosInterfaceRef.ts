/**
 * src/utils/fortiosInterfaceRef.ts
 *
 * One FortiOS interface REFERENCE (a field naming another interface, such as a
 * VLAN interface's `interface`) read as a plain name. FortiOS REST returns it
 * as a string; the FortiManager device database returns references as a
 * one-element array, of strings or of `{ name }` objects. Null when absent or
 * blank.
 */
export function fortiosInterfaceRef(raw: unknown): string | null {
  const one = Array.isArray(raw) ? raw[0] : raw;
  const name = typeof one === "string"
    ? one
    : one && typeof one === "object" && typeof (one as { name?: unknown }).name === "string"
      ? (one as { name: string }).name
      : "";
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

/**
 * The interface a VLAN interface sits on (business rule 137) — its
 * `interface` reference, for a row that carries a VLAN id. Keyed on the VLAN
 * id rather than on `type === "vlan"` because the FortiManager device database
 * may hand `type` back as an enum number; a non-VLAN row (a physical port, a
 * tunnel, whose `interface` is an underlay) has no VLAN id and yields null.
 */
export function fortiosVlanParentOf(iface: { vlanid?: unknown; interface?: unknown }): string | null {
  const vid = typeof iface.vlanid === "number" ? iface.vlanid : parseInt(String(iface.vlanid ?? ""), 10);
  if (!Number.isInteger(vid) || vid < 1 || vid > 4094) return null;
  return fortiosInterfaceRef(iface.interface);
}

/**
 * The attributes Polaris reads off a FortiOS REST `/api/v2/cmdb/system/interface`
 * row, as that endpoint's `format=` filter. Without it a gate returns every one
 * of the row's ~228 attributes; with it, these plus `q_origin_key` — about a
 * fifth of the bytes (HUB1-a 7.6.8: 254 KB → 57 KB for 34 interfaces).
 *
 * Every reader of that endpoint passes this, so a field one of them needs and
 * this list lacks is silently absent, never an error. Add the field here first:
 *   - discovery (fortigateService → discoverDhcpSubnets: mgmt IP / MACs, then
 *     interface IPs, VLANs and parents, secondaries, IPv6);
 *   - monitoring (monitoringService → parseFortiCmdbInterfaceTable: type,
 *     parent, members, alias, description, mode, admin status, addresses;
 *     fortilinkInterfaceNamesFromCmdb: fortilink + members).
 *
 * Both secondary spellings are asked for: on FortiOS REST the TABLE is
 * `secondaryip` and `secondary-IP` is the enable flag (lab, 7.6.8 and 8.0.1),
 * and utils/fortiosSecondaryIp.ts takes whichever is an array. Nested tables
 * (`secondaryip`, `ipv6`'s ip6-extra-addr / ip6-prefix-list, `member`) come
 * back whole under `format=` — confirmed field-for-field against all five lab
 * gates, 2026-11-04.
 *
 * `allowaccess` is the management-access list discovery summarizes for the
 * firewall's management interface (fortinetManagementAccessService) — read
 * here so that summary costs no second read of the table.
 */
export const FORTIOS_INTERFACE_CMDB_FORMAT = [
  "name", "ip", "macaddr", "type", "interface", "vlanid", "switch-controller-mgmt-vlan",
  "secondary-IP", "secondaryip", "ipv6", "member", "alias", "description", "mode", "status", "fortilink",
  "allowaccess",
].join("|");
