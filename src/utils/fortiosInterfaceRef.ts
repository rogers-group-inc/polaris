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
