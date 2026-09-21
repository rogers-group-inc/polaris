/**
 * src/utils/vipAddressFacts.ts
 *
 * The VIP half of business rule 77, kept pure so it unit-tests without a
 * database or a FortiGate.
 *
 * A FortiGate virtual IP is a fact ABOUT an address — "traffic to this address
 * is translated to that one" — and it is not the same fact as who holds the
 * address or how the gate hands it out. Business rule 23 already split those
 * last two into `sourceType` (ownership) and `dhcpBinding` (how it is served);
 * `vipInfo` is the third column, and the mistake this module exists to prevent
 * is any surface collapsing the three back into one.
 *
 * What lives here:
 *   • `parseVipRow` — one tolerant reader for the two encodings a
 *     `firewall/vip` row arrives in, so the per-subnet discover and the two
 *     full-discovery paths cannot drift on field handling;
 *   • `vipIpRoles` — the addresses one VIP puts on the map, each with the role
 *     it plays, which is what the badge tooltip and the notes line name;
 *   • `vipInfoSnapshot` / `vipInfoDiffers` — the stored snapshot's shape and
 *     the only comparison allowed to trigger a write, because this runs per VIP
 *     address per pass;
 *   • `decideVipDhcpBinding` — what a VIP row may learn from a DHCP entry at
 *     the same address, which is the binding and nothing else.
 */

import { parseRangeFirstIp } from "./cidr.js";
import type { DhcpBinding } from "./infraDhcpBinding.js";

/** The role an address plays in a VIP. Mirrors discovery Phase 3c's vocabulary. */
export type VipRole = "external" | "mapped" | "realserver";

/** One `firewall/vip` row, normalized away from its transport's encoding. */
export interface ParsedVip {
  /** FortiManager's DEVICE NAME for the gate, never the gate's own hostname. */
  device: string;
  name: string;
  extip: string;
  mappedips: string[];
  realservers: string[];
  extintf: string;
  isVirtualServer: boolean;
}

/** The snapshot stored in `Reservation.vipInfo`. Shape is load-bearing: the IP
 *  panel's badge tooltip and the composed status pill both read these keys. */
export interface VipInfoSnapshot {
  name: string;
  device: string;
  extip: string;
  role: VipRole;
  isVirtualServer: boolean;
}

/**
 * Classify a raw row as a load-balance Virtual Server and extract its backend
 * pool IPs.
 *
 * Structural-first (a non-empty realservers pool) with the type string only
 * confirming, because FortiManager has encoded CMDB enums as integers on some
 * releases while FortiOS REST returns them as strings — so the string match
 * exists to catch a VS whose pool is currently empty, not to decide the common
 * case. Pool members sharing one IP on different ports collapse to one entry.
 *
 * Deliberately duplicated from `parseVipServerInfo` in fortimanagerService
 * rather than imported: that module reaches a FortiManager at import time in
 * every consumer that touches it, and this one is imported by a pure util. The
 * two are pinned together by tests/unit/vipAddressFacts.test.ts, which asserts
 * both produce the same verdict on the same rows.
 */
function classifyServer(raw: unknown): { isVirtualServer: boolean; realservers: string[] } {
  const row = (raw ?? {}) as Record<string, unknown>;
  const realservers: string[] = [];
  if (Array.isArray(row.realservers)) {
    for (const rs of row.realservers as unknown[]) {
      const entry = (rs ?? {}) as Record<string, unknown>;
      const rawIp = Array.isArray(entry.ip) ? (entry.ip as unknown[])[0] : entry.ip;
      const ip = parseRangeFirstIp(String(rawIp ?? ""));
      if (ip && !realservers.includes(ip)) realservers.push(ip);
    }
  }
  const isVirtualServer = realservers.length > 0 || String(row.type ?? "") === "server-load-balance";
  return { isVirtualServer, realservers };
}

/**
 * Read one `firewall/vip` row into `ParsedVip`, or null when it carries no
 * usable external address.
 *
 * Handles both encodings on every field, because the same CMDB table arrives
 * three ways in this codebase: FortiOS REST direct (`extip` a plain string,
 * `mappedip` a list of `{ range }` objects), the FortiManager JSON-RPC
 * fields-projected get (both flattened — `extip` a single-element array,
 * `mappedip` a list of bare range strings), and the FortiManager REST proxy,
 * which returns the device's own REST shape. Parsing only one of them is how
 * proxy-mode mapped IPs were silently dropped before; a reader that accepts all
 * three cannot regress that way again.
 */
export function parseVipRow(raw: unknown, deviceName: string): ParsedVip | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const name = String(row.name ?? "").trim();
  if (!name) return null;

  const extipRaw = Array.isArray(row.extip) ? (row.extip as unknown[])[0] : row.extip;
  const extip = parseRangeFirstIp(String(extipRaw ?? ""));
  if (!extip) return null;

  const mappedips: string[] = [];
  if (Array.isArray(row.mappedip)) {
    for (const m of row.mappedip as unknown[]) {
      const source = typeof m === "string" ? m : ((m ?? {}) as Record<string, unknown>).range;
      const ip = parseRangeFirstIp(String(source ?? ""));
      if (ip && !mappedips.includes(ip)) mappedips.push(ip);
    }
  }

  const extintfRaw = Array.isArray(row.extintf) ? (row.extintf as unknown[])[0] : row.extintf;
  const { isVirtualServer, realservers } = classifyServer(row);

  return {
    device: deviceName,
    name,
    extip,
    mappedips,
    realservers,
    extintf: String(extintfRaw ?? ""),
    isVirtualServer,
  };
}

/**
 * Every address one VIP puts on the map, with the role it plays there.
 *
 * Order is external → mapped → realserver, and a duplicate address keeps its
 * FIRST role: an address that is both a VIP's external and its own mapped IP
 * (a hairpin) is named by the more externally-visible of the two, which is the
 * one an operator reading the row is trying to reconcile against the gate.
 */
export function vipIpRoles(vip: ParsedVip): Array<{ ip: string; role: VipRole }> {
  const out: Array<{ ip: string; role: VipRole }> = [];
  const seen = new Set<string>();
  const push = (ip: string, role: VipRole): void => {
    if (!ip || seen.has(ip)) return;
    seen.add(ip);
    out.push({ ip, role });
  };
  push(vip.extip, "external");
  for (const ip of vip.mappedips) push(ip, "mapped");
  for (const ip of vip.realservers) push(ip, "realserver");
  return out;
}

/** The snapshot to store for one (vip, address) pair. */
export function vipInfoSnapshot(vip: ParsedVip, role: VipRole): VipInfoSnapshot {
  return {
    name: vip.name,
    device: vip.device,
    extip: vip.extip,
    role,
    isVirtualServer: vip.isVirtualServer,
  };
}

/**
 * Has the stored snapshot drifted from what the gate reports?
 *
 * Compared field by field rather than by deep equality because the stored value
 * is JSON that older rows may carry extra keys on, and because this decides
 * whether to WRITE: it runs per VIP address per discover pass, and a comparison
 * that reported "changed" on key order would put a write on every address on
 * every pass. `extip` is deliberately part of the comparison even on the
 * external row, where it repeats the address — a VIP re-pointed at a new
 * external IP is exactly the drift an operator needs the tooltip to catch up on.
 */
export function vipInfoDiffers(current: unknown, next: VipInfoSnapshot): boolean {
  if (!current || typeof current !== "object") return true;
  const cur = current as Record<string, unknown>;
  return (
    cur.name !== next.name ||
    cur.device !== next.device ||
    cur.extip !== next.extip ||
    cur.role !== next.role ||
    !!cur.isVirtualServer !== next.isVirtualServer
  );
}

/** The subset of a `Reservation` the VIP binding decision reads. */
export interface VipReservationRow {
  sourceType: string;
  macAddress?: string | null;
  dhcpBinding?: string | null;
}

/** The subset of a discovered DHCP entry it reads. */
export interface VipDhcpEntry {
  /** "dhcp-reservation" = a real reserved-address entry; "dhcp-lease" = dynamic. */
  type: "dhcp-reservation" | "dhcp-lease";
  macAddress?: string | null;
}

export interface VipBindingPatch {
  dhcpBinding?: DhcpBinding;
  /** Only ever set when the row had none — the DHCP entry's MAC. */
  macAddress?: string;
}

/** MAC comparison in the Asset/Reservation storage form (upper, colon-separated). */
function normalizeMacForCompare(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const t = mac.trim();
  if (!t) return null;
  return t.toUpperCase().replace(/-/g, ":");
}

/**
 * What a `vip` row should learn from a DHCP entry found at the same address.
 * Returns null when nothing changed.
 *
 * This is `decideInfraDhcpBinding` applied to the other source type that holds
 * an address the gate may ALSO be serving, and it keeps that function's three
 * deliberate omissions for the same reasons (business rule 23): `sourceType` is
 * never flipped — the VIP is still what owns this address, and Phase 5's
 * succession path is the only thing allowed to decide otherwise, and only once
 * the gate stops reporting the VIP; `expiresAt` is never stamped, or the row
 * would expire on the gate's lease clock and be re-created every cycle; and
 * `macAddress` is filled from the DHCP entry only, and only into a blank, since
 * that is the MAC the gate actually saw requesting the address.
 *
 * What it adds is why business rule 77 exists: before this, a VIP row was the
 * one row that could sit on a leased address and say nothing about the lease,
 * so the IP panel showed "VIP" and an operator had no way to learn a client was
 * holding the address too.
 */
export function decideVipDhcpBinding(
  row: VipReservationRow,
  entry: VipDhcpEntry,
): VipBindingPatch | null {
  if (row.sourceType !== "vip") return null;

  const patch: VipBindingPatch = {};

  const binding: DhcpBinding = entry.type === "dhcp-reservation" ? "reservation" : "lease";
  if (row.dhcpBinding !== binding) patch.dhcpBinding = binding;

  const entryMac = normalizeMacForCompare(entry.macAddress);
  if (entryMac && !normalizeMacForCompare(row.macAddress)) patch.macAddress = entryMac;

  return Object.keys(patch).length > 0 ? patch : null;
}
