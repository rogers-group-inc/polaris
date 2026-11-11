/**
 * src/utils/discoveredSubnetName.ts — the device suffix of a discovered
 * network's name. FortiGate discovery names a network
 * `<origin>: <interface> (<device>)` when it creates or first claims it; later
 * runs re-point `Subnet.fortigateDevice` but never rebuilt the name, so a gate
 * renamed in FortiManager left every network it serves showing the old name.
 */

/**
 * The network's name with its trailing `(<oldDevice>)` swapped for
 * `(<newDevice>)`, or null when nothing should change: the device name did not
 * change, either side is empty, or the name no longer ends with the old
 * device's suffix (an operator renamed it — their name is kept as typed).
 * Only the suffix moves, so an operator edit to the rest of the name survives.
 */
export function renameDeviceSuffix(
  name: string | null | undefined,
  oldDevice: string | null | undefined,
  newDevice: string | null | undefined,
): string | null {
  if (!name || !oldDevice || !newDevice || oldDevice === newDevice) return null;
  const suffix = ` (${oldDevice})`;
  if (!name.endsWith(suffix)) return null;
  return `${name.slice(0, -suffix.length)} (${newDevice})`;
}

/**
 * Heals a name an earlier run left stale: the name is still exactly the
 * generated `<prefix> (<something>)` (prefix = `<origin>: <interface>`) but
 * `<something>` is not the serving device. That is the state every network
 * re-pointed before the suffix was kept in step is in — `fortigateDevice`
 * already holds the new name, so `renameDeviceSuffix` has no old name to
 * compare. Returns the rebuilt name, or null when it is current or was not
 * generated from this prefix (an operator's name is never touched).
 */
export function rebuildStaleGeneratedName(
  name: string | null | undefined,
  prefix: string,
  device: string | null | undefined,
): string | null {
  if (!name || !prefix || !device) return null;
  const head = `${prefix} (`;
  if (!name.startsWith(head) || !name.endsWith(")") || name.length <= head.length + 1) return null;
  const want = `${prefix} (${device})`;
  return name === want ? null : want;
}
