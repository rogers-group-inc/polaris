/**
 * src/utils/assetWritePrune.ts — drop the fields of a discovery asset write
 * that would set what the row already holds.
 *
 * Why: every `asset.update` runs the db.ts hook chain, and which hooks fire is
 * decided by which KEYS the data carries — `hostname` reads the row twice
 * (operator override, alert rename), `ipAddress` reads it for the pins and
 * writes IP history, `ipAddress` / `status` / `hostname` / `dnsName` /
 * `macAddress` fire a dns_resolved reconcile (five or six queries). Discovery
 * staged those keys every run whether or not they changed, so an unchanged
 * device cost ~9 statements. With the equal keys gone the same write is one
 * UPDATE (efficiency audit, "skip unchanged discovery writes").
 *
 * What is NEVER dropped, because staging an equal value is itself the signal:
 *   - `ipAddress` / `ipSource` on an asset with an IP pin (`ipOverride`,
 *     `ipBlankPinned`, `primaryAddressIp`): an IP equal to the pin is what lets
 *     the db.ts guard release it, and the guard owns pinned writes;
 *   - `hostname` on an asset with a `hostnameOverride`, for the same reason;
 *   - any key the current row does not carry (unknown ⇒ keep) — and the pin
 *     columns count too: a row read without them keeps its IP and hostname.
 * `ipAddress` and `ipSource` go together: one is dropped only when both match.
 *
 * A dropped `ipAddress` still refreshes its IP history — the caller collects
 * `ipHistoryRefresh` and writes it in one batch (refreshIpHistoryLastSeen),
 * which is what the hook's per-write upsert did.
 *
 * Pure. Mutates `data` in place and reports what it removed.
 */

import { jsonEqual } from "./jsonEqual.js";

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : typeof a === "string" ? Date.parse(a) : NaN;
    const tb = b instanceof Date ? b.getTime() : typeof b === "string" ? Date.parse(b) : NaN;
    return Number.isFinite(ta) && ta === tb;
  }
  if (typeof a === "bigint" || typeof b === "bigint") {
    try { return BigInt(a as never) === BigInt(b as never); } catch { return false; }
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") return jsonEqual(a, b);
  return false;
}

const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== "";

export interface PruneResult {
  /** Keys removed from `data`. */
  pruned: string[];
  /** Set when an `ipAddress` equal to the row's was removed: refresh its history. */
  ipHistoryRefresh: { ip: string; source: string } | null;
}

export function pruneUnchangedAssetFields(
  current: Record<string, unknown>,
  data: Record<string, unknown>,
): PruneResult {
  const pruned: string[] = [];
  // A row read with a narrowed select may not carry the pin columns at all:
  // unknown counts as pinned, so the guarded keys are kept.
  const ipPinKnown = "ipOverride" in current && "ipBlankPinned" in current && "primaryAddressIp" in current;
  const ipPinned = !ipPinKnown || truthy(current.ipOverride) || truthy(current.ipBlankPinned) || truthy(current.primaryAddressIp);
  const hostPinned = !("hostnameOverride" in current) || truthy(current.hostnameOverride);
  let ipHistoryRefresh: PruneResult["ipHistoryRefresh"] = null;

  // ipAddress + ipSource travel together.
  if ("ipAddress" in data && !ipPinned && "ipAddress" in current && sameValue(data.ipAddress, current.ipAddress)) {
    const srcStaged = "ipSource" in data;
    const srcSame = !srcStaged || ("ipSource" in current && sameValue(data.ipSource, current.ipSource));
    if (srcSame) {
      const ip = data.ipAddress;
      if (typeof ip === "string" && ip) {
        const src = typeof data.ipSource === "string" ? data.ipSource : "manual";
        ipHistoryRefresh = { ip, source: src };
      }
      delete data.ipAddress;
      pruned.push("ipAddress");
      if (srcStaged) { delete data.ipSource; pruned.push("ipSource"); }
    }
  }

  for (const key of Object.keys(data)) {
    if (key === "ipAddress" || key === "ipSource") continue;
    if (key === "hostname" && hostPinned) continue;
    if (!(key in current)) continue;
    if (sameValue(data[key], current[key])) {
      delete data[key];
      pruned.push(key);
    }
  }
  return { pruned, ipHistoryRefresh };
}
