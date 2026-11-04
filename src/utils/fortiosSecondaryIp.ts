/**
 * src/utils/fortiosSecondaryIp.ts — the `system/interface` secondary-address
 * child table, read the same way on every FortiOS transport.
 *
 * The table's key is spelled differently depending on who answers:
 *
 *   FortiOS REST (/api/v2/cmdb/system/interface, 7.6.7 / 7.6.8 / 8.0.1)
 *       "secondary-IP": [ { id, ip: "10.0.0.1 255.255.255.0", ... } ]
 *       "secondaryip":  "enable" | "disable"      ← the FLAG, not the table
 *   FortiManager device DB (mirrors the CLI's `config secondaryip`)
 *       "secondaryip":  [ { id, ip: ["10.0.0.1", "255.255.255.0"], ... } ]
 *       "secondary-IP": 0 | 1                     ← the flag
 *
 * Earlier code read only `secondary-ip`, which neither transport sends, so
 * every gate's secondaries were silently dropped (confirmed against the lab
 * gates 2026-11-04: all five answer `secondary-IP`, none `secondary-ip`).
 * The reader takes whichever of the three spellings holds an ARRAY, so the
 * flag (a string or an integer) can never be mistaken for the table.
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
