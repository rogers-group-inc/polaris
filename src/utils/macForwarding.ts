/**
 * src/utils/macForwarding.ts
 *
 * Decoding for the switch MAC forwarding database (the CAM table), from
 * Q-BRIDGE-MIB `dot1qTpFdbTable` (RFC 4363) and BRIDGE-MIB `dot1dTpFdbTable`
 * (RFC 4188).
 *
 * Two things make this fiddly enough to be worth isolating and testing:
 *
 *   1. **The MAC is in the OID index, not a column.** Both tables index by the
 *      address itself as six decimal sub-identifiers — `dot1qTpFdbTable` after
 *      a leading FDB id, `dot1dTpFdbTable` alone. There is no "macAddress"
 *      column to read.
 *   2. **The port value is a dot1dBasePort, not an ifIndex.** Unlike PoE, the
 *      join is defined by the MIB (`dot1dBasePortIfIndex`), so it is reliable —
 *      but it must actually be performed, and forgetting it silently attributes
 *      every MAC to the wrong interface.
 *
 * Depends on nothing but the shared MAC normalizer, so the whole decision
 * table unit-tests directly.
 */

import { normalizeMacOrNull } from "./mac.js";

/** `dot1dTpFdbStatus` / `dot1qTpFdbStatus`. */
export function fdbStatusLabel(raw: number | null | undefined): string {
  switch (raw) {
    case 1:  return "other";
    case 2:  return "invalid";
    case 3:  return "learned";
    case 4:  return "self";
    case 5:  return "mgmt";
    default: return "other";
  }
}

/**
 * Statuses worth storing.
 *
 * `invalid(2)` is an aged-out entry the agent has not reaped yet — storing it
 * would put MACs on ports they have already left. `learned(3)` is a real
 * endpoint sighting; `mgmt(5)` is a configured static entry and is equally
 * real. `self(4)` is the REPORTING BRIDGE'S OWN address — it is kept for
 * completeness but says nothing about what is reachable through a port, so
 * every count and inference here excludes it. (A peer switch shows up in this
 * table as a `learned` entry on the port facing it, not as `self`.)
 */
export function fdbStatusIsUsable(status: string): boolean {
  return status === "learned" || status === "self" || status === "mgmt";
}

/**
 * Decode a MAC from six decimal OID sub-identifiers into colon-uppercase.
 * Returns null when the parts are not six valid octets.
 */
export function macFromOidParts(parts: readonly string[]): string | null {
  if (parts.length !== 6) return null;
  const octets: string[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n.toString(16).toUpperCase().padStart(2, "0"));
  }
  return octets.join(":");
}

export interface FdbIndex {
  /** dot1qFdbId — the VLAN/filtering-database id. null on the BRIDGE-MIB table. */
  fdbId: number | null;
  macAddress: string;
}

/**
 * Parse a walk suffix from either FDB table.
 *
 * `dot1qTpFdbTable` is INDEX { dot1qFdbId, dot1qTpFdbAddress } → 7 components.
 * `dot1dTpFdbTable` is INDEX { dot1dTpFdbAddress } → 6 components.
 *
 * The component COUNT is what distinguishes them, which is why the caller does
 * not need to tell us which table a row came from.
 */
export function parseFdbIndex(suffix: string): FdbIndex | null {
  const parts = suffix.split(".").filter((p) => p !== "");
  if (parts.length === 7) {
    const fdbId = Number(parts[0]);
    const mac = macFromOidParts(parts.slice(1));
    if (!Number.isInteger(fdbId) || !mac) return null;
    return { fdbId, macAddress: mac };
  }
  if (parts.length === 6) {
    const mac = macFromOidParts(parts);
    return mac ? { fdbId: null, macAddress: mac } : null;
  }
  return null;
}

/**
 * Decode the MAC from a `dot1dTpFdbAddress` / `dot1qTpFdbAddress` COLUMN value.
 *
 * Exists because the index is not always the address. RFC 4188 defines
 * `dot1dTpFdbEntry` as INDEX { dot1dTpFdbAddress } and RFC 4363 prefixes that
 * with the FDB id, which is what `parseFdbIndex` above decodes — but agents in
 * the field do not all honour it. A FortiSwitch (confirmed on a live switch,
 * 2026-08) indexes the table by an arbitrary ROW NUMBER
 * (`...17.4.3.1.3.1`, `.2`, `.3`) and publishes the address only as a column,
 * so an index-only decode yields nothing at all on the very devices this table
 * exists for.
 *
 * Accepts the OctetString shape SNMP actually delivers (a 6-byte Buffer, which
 * is a Uint8Array) as well as the textual forms some agents return. All-zero
 * is rejected by the shared normalizer: an entry with no address is not an
 * entry, and letting it through would put a junk row on a port.
 */
export function macFromFdbAddressValue(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) {
    if (v.length !== 6) return null;
    return normalizeMacOrNull(
      Array.from(v).map((b) => b.toString(16).padStart(2, "0")).join(":"),
    );
  }
  if (typeof v === "string") return normalizeMacOrNull(v);
  return null;
}

/**
 * Resolve one forwarding-database row's identity from BOTH sources: the walk
 * suffix and the address column.
 *
 * The column WINS when it is readable — it is the agent stating the address
 * outright, whereas the index is only the address on an agent that indexes the
 * table the way the RFC says. The FDB id still comes from the index, since the
 * Q-BRIDGE table carries it nowhere else; a row whose index doesn't decode
 * keeps a null VLAN rather than a guessed one.
 *
 * Returns null only when NEITHER source yields an address, which is the one
 * case where there is genuinely nothing to store.
 */
export function resolveFdbIdentity(suffix: string, addressValue: unknown): FdbIndex | null {
  const fromIndex  = parseFdbIndex(suffix);
  const fromColumn = macFromFdbAddressValue(addressValue);
  if (fromColumn) return { fdbId: fromIndex?.fdbId ?? null, macAddress: fromColumn };
  return fromIndex;
}

/**
 * Build dot1dBasePort → ifName by composing the two maps the scrape already
 * has: `dot1dBasePortIfIndex` (basePort → ifIndex) and the IF-MIB walk
 * (ifIndex → name).
 *
 * A basePort whose ifIndex is unknown is omitted rather than guessed; the
 * caller keeps the raw basePort on the row so the entry stays visible.
 */
export function basePortToIfName(
  basePortToIfIndex: ReadonlyMap<string, number>,
  ifNameByIndex: ReadonlyMap<string, string>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const [basePortRaw, ifIndex] of basePortToIfIndex.entries()) {
    const basePort = Number(basePortRaw);
    if (!Number.isInteger(basePort)) continue;
    const name = ifNameByIndex.get(String(ifIndex));
    if (name) out.set(basePort, name);
  }
  return out;
}

/** One decoded forwarding-database entry, before asset matching. */
export interface FdbEntry {
  macAddress: string;
  vlanId: number | null;
  basePort: number | null;
  ifName: string | null;
  status: string;
}

/**
 * Per-port MAC counts — the single number that separates an access port (one
 * endpoint) from an uplink or trunk (many), and the basis of any topology
 * inference drawn from this table.
 *
 * Counts `learned` entries only: a port's own `self` address says nothing about
 * what is reachable through it.
 */
export function macCountsByPort(entries: readonly FdbEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.status !== "learned" || !e.ifName) continue;
    out.set(e.ifName, (out.get(e.ifName) ?? 0) + 1);
  }
  return out;
}

/** A port's VLAN config as the interface row stores it. */
export interface PortVlanState {
  nativeVlan: number | null;
  taggedVlans: readonly number[];
  trunksAllVlans: boolean;
}

/**
 * Fill the VLAN of a forwarding-database row the switch reported without one,
 * from the VLAN config of the port it was learned on.
 *
 * Exists because the BRIDGE-MIB table has no VLAN dimension at all, and a
 * FortiSwitch answers only that one — so every row it reports is VLAN-less.
 * An ACCESS port carries exactly one VLAN, its native one, so every MAC
 * learned there is in it. A trunk carries several and the row says nothing
 * about which, so it stays null rather than taking a guess.
 *
 * `tagged` reads as "access port" only when the switch demonstrably reports a
 * tagged dimension: a switch that answered the PVID walk but none of the
 * member bitmaps has an empty tagged set on EVERY port, its trunks included,
 * and filling from that would put every MAC behind an uplink into the
 * uplink's native VLAN. So no port anywhere showing a tagged VLAN (or
 * trunk-all) means nothing is filled.
 *
 * Returns new rows; `vlanInferred` marks the ones this filled.
 */
export function fillAccessPortVlans<T extends { vlanId: number | null; ifName: string | null }>(
  entries: readonly T[],
  ports: ReadonlyMap<string, PortVlanState>,
): Array<T & { vlanInferred: boolean }> {
  let taggedDimension = false;
  for (const p of ports.values()) {
    if (p.trunksAllVlans || p.taggedVlans.length > 0) { taggedDimension = true; break; }
  }
  return entries.map((e) => {
    if (e.vlanId != null || !e.ifName || !taggedDimension) return { ...e, vlanInferred: false };
    const port = ports.get(e.ifName);
    if (!port || port.nativeVlan == null || port.trunksAllVlans || port.taggedVlans.length > 0) {
      return { ...e, vlanInferred: false };
    }
    return { ...e, vlanId: port.nativeVlan, vlanInferred: true };
  });
}

/** A forwarding-database row that has been matched to an Asset. */
export interface MatchedFdbEntry extends FdbEntry {
  matchedAssetId: string | null;
}

export interface DirectAttachment {
  ifName: string;
  assetId: string;
}

/**
 * Ports whose forwarding database shows exactly ONE learned MAC, matched to a
 * known asset — i.e. a device plugged straight into that port.
 *
 * This is the only inference this module draws, and the restriction is
 * deliberate. "Which devices are reachable through this port" is answered by
 * every row; "which device IS this port" is answered only when there is one
 * candidate. On a multi-MAC uplink the same data says the far end is a switch
 * with a whole network behind it, and picking any single MAC from that set
 * would be a guess dressed as a fact.
 *
 * Known limits, all of which push toward under-claiming rather than over-:
 *
 *   - An IP phone with a PC daisy-chained behind it puts two MACs on one access
 *     port, so that port yields nothing. Correct: the port is not one device.
 *   - A port facing a switch that currently has one client behind it looks
 *     identical to an access port. Distinguishing them needs the far end's own
 *     table (bidirectional confirmation), which is a follow-on once there is
 *     real fleet data to validate against.
 *   - A stale entry that has not aged out can name a device that has moved.
 *     The FDB is refreshed wholesale each scrape, so this self-corrects.
 *
 * `self` and `mgmt` rows are excluded: the former is the bridge's own address,
 * the latter a configured static entry rather than an observed sighting.
 */
export function inferDirectAttachments(entries: readonly MatchedFdbEntry[]): DirectAttachment[] {
  const byPort = new Map<string, MatchedFdbEntry[]>();
  for (const e of entries) {
    if (e.status !== "learned" || !e.ifName) continue;
    const list = byPort.get(e.ifName);
    if (list) list.push(e);
    else byPort.set(e.ifName, [e]);
  }

  const out: DirectAttachment[] = [];
  for (const [ifName, rows] of byPort.entries()) {
    if (rows.length !== 1) continue;
    const assetId = rows[0].matchedAssetId;
    if (!assetId) continue;
    out.push({ ifName, assetId });
  }
  return out.sort((a, b) => a.ifName.localeCompare(b.ifName));
}
