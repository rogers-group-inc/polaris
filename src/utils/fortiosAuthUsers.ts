/**
 * src/utils/fortiosAuthUsers.ts — a FortiGate's authenticated-user table
 * (`GET /api/v2/monitor/user/firewall`: FSSO, RSSO, captive-portal and
 * firewall-policy logins) as user sightings for the gate's own clients
 * (business rule 186).
 *
 * An auth session names a user and an ADDRESS, not a device. An address is
 * not an identity — it recycles — so a session is joined only to a client the
 * SAME gate is seeing online at that address in the same discovery pass: its
 * detected-device inventory row. The row carries the MAC that identifies the
 * device, and the session rides it as `authUser`. A session no online row
 * answers for is counted and dropped, never matched by address alone.
 *
 * Shared by the standalone-FortiGate and FMG-proxied collectors so the field
 * fallbacks cannot drift. The row shape has not been seen on a gate with live
 * sessions yet (the lab answers with an empty table on 7.6.8 and 8.0.1), so
 * every field takes each name FortiOS builds are known to use.
 */

import { isIpv6Address } from "./cidr.js";

/** One parsed auth session. */
export interface FortiosAuthSession {
  ipAddress: string;
  /** As the gate reports it — `DOMAIN\user` for FSSO, a bare name otherwise. */
  user: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/**
 * Parse the `results` of `user/firewall`. Address `ipaddr` → `ip` →
 * `ipv4_address`; user `username` → `user_name` → `user`. IPv6 sessions and
 * rows missing either half are dropped (the inventory join is IPv4).
 */
export function parseFortiosAuthSessions(results: unknown): FortiosAuthSession[] {
  if (!Array.isArray(results)) return [];
  const out: FortiosAuthSession[] = [];
  for (const r of results as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object") continue;
    const ipAddress = str(r.ipaddr) || str(r.ip) || str(r.ipv4_address);
    const user = str(r.username) || str(r.user_name) || str(r.user);
    if (!ipAddress || !user || isIpv6Address(ipAddress)) continue;
    out.push({ ipAddress, user });
  }
  return out;
}

/**
 * Put each session on the gate's ONLINE inventory row at the same address.
 * An address that two online rows claim, or that carries sessions for two
 * different users, decides nothing. Mutates the rows; returns how many
 * sessions found a row and how many did not.
 */
export function attachAuthUsers<T extends { ipAddress: string; isOnline: boolean; authUser?: string }>(
  rows: T[],
  sessions: ReadonlyArray<FortiosAuthSession>,
): { matched: number; unmatched: number } {
  const rowsByIp = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.isOnline || !r.ipAddress) continue;
    const list = rowsByIp.get(r.ipAddress) ?? [];
    list.push(r);
    rowsByIp.set(r.ipAddress, list);
  }
  const userByIp = new Map<string, string | null>();
  for (const s of sessions) {
    const prior = userByIp.get(s.ipAddress);
    if (prior === undefined) userByIp.set(s.ipAddress, s.user);
    else if (prior !== null && prior.toLowerCase() !== s.user.toLowerCase()) userByIp.set(s.ipAddress, null);
  }
  let matched = 0;
  let unmatched = 0;
  for (const [ip, user] of userByIp) {
    const candidates = rowsByIp.get(ip);
    if (user === null || !candidates || candidates.length !== 1) { unmatched++; continue; }
    candidates[0]!.authUser = user;
    matched++;
  }
  return { matched, unmatched };
}
