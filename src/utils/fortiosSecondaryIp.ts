/**
 * src/utils/fortiosSecondaryIp.ts — the `system/interface` secondary-address
 * child table, read the same way on every FortiOS transport.
 *
 * The table and its enable flag sit under two keys that differ only in
 * spelling — the CLI's `set secondary-IP enable` + `config secondaryip`:
 *
 *   FortiOS REST (/api/v2/cmdb/system/interface, 7.6.8 / 8.0.1)
 *       "secondaryip":  [ { id, q_origin_key, ip: "10.0.0.1 255.255.255.0", ... } ]
 *       "secondary-IP": "enable" | "disable"      ← the FLAG, not the table
 *   FortiManager device DB — not observed; assumed to follow the CLI the same
 *       way, possibly with `ip` as an [ip, mask] array and the flag as 0 | 1.
 *
 * Read off HUB1-a (7.6.8) with two real secondaries on 2026-11-04. An earlier
 * note here had the two REVERSED: it was written from gates with no
 * secondaries, where both keys looked like scalars. Earlier code read only
 * `secondary-ip`, which no transport sends, so secondaries were silently
 * dropped. The reader takes whichever of the three spellings holds an ARRAY,
 * so the flag (a string or an integer) can never be mistaken for the table,
 * whichever way round a transport spells them. A REST read with `format=`
 * must name `secondaryip` (utils/fortiosInterfaceRef.ts →
 * FORTIOS_INTERFACE_CMDB_FORMAT), or the table is not returned at all.
 */

const TABLE_KEYS = ["secondary-IP", "secondaryip", "secondary-ip"] as const;

/** The interface row's secondary-address rows, or [] when it has none. */
export function fortiosSecondaryIpRows(iface: unknown): unknown[] {
  if (!iface || typeof iface !== "object") return [];
  const row = iface as Record<string, unknown>;
  for (const k of TABLE_KEYS) {
    const v = row[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * Each secondary row's address as FortiOS gave it — "x.x.x.x y.y.y.y" or the
 * first element of the [ip, mask] array — untrimmed of its mask; empty and
 * non-string entries are skipped. Callers apply their own unaddressed /
 * validity filter, as they do for the primary.
 */
export function fortiosSecondaryIpStrings(iface: unknown): string[] {
  const out: string[] = [];
  for (const sec of fortiosSecondaryIpRows(iface)) {
    const ip = (sec as { ip?: unknown } | null)?.ip;
    const raw = Array.isArray(ip) ? ip[0] : ip;
    if (typeof raw === "string" && raw.trim()) out.push(raw.trim());
  }
  return out;
}
