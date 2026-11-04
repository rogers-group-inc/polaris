/**
 * src/utils/regex.ts — escape text for literal use inside a RegExp.
 *
 * Six services built the same `replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` inline
 * (alert rename, efficiency advisor templates, Unraid pool members, vCenter
 * propSet names, SNMP vendor words) until 2026-11-04. Escaping is the whole
 * job: anchoring, flags and the surrounding pattern stay with the caller.
 */

/** `s` with every RegExp metacharacter backslash-escaped, so it matches itself. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
