/**
 * src/utils/cidr.ts
 *
 * All IP math lives here. Never do string manipulation on IPs elsewhere.
 */

import { Netmask } from "netmask";

export type IpVersion = "v4" | "v6";

// ─── Parsing & Normalisation ──────────────────────────────────────────────────

/**
 * Normalise a CIDR string so the host bits are always zeroed.
 * e.g. "10.1.1.5/24" → "10.1.1.0/24"
 */
export function normalizeCidr(cidr: string): string {
  const block = new Netmask(cidr);
  return `${block.base}/${block.bitmask}`;
}

/**
 * Detect whether a CIDR string is IPv4 or IPv6.
 */
export function detectIpVersion(cidr: string): IpVersion {
  return cidr.includes(":") ? "v6" : "v4";
}

/**
 * Return true if the string is a valid CIDR notation.
 */
export function isValidCidr(cidr: string): boolean {
  try {
    if (!cidr.includes("/")) return false;
    if (detectIpVersion(cidr) === "v4") {
      new Netmask(cidr); // throws on invalid
    } else {
      const [addr, prefix] = cidr.split("/");
      if (!addr || !prefix) return false;
      const prefixNum = parseInt(prefix, 10);
      if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 128) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true if the given string is a valid dotted-quad IPv4 address
 * (octets validated ≤ 255). The discovery services previously retyped a
 * raw `\d{1,3}` regex at 8 sites, which accepted impossible octets like
 * 999.1.1.1 — this is the sanctioned inline guard for IPv4-only contexts;
 * use isValidIpAddress when IPv6 is also acceptable.
 */
export function isValidIpv4(ip: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  return ip.split(".").every((octet) => parseInt(octet) <= 255);
}

/**
 * Return true if the given IP address (without prefix) is a valid IPv4 or IPv6 address.
 */
export function isValidIpAddress(ip: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  if (ipv4Regex.test(ip)) {
    return ip.split(".").every((octet) => parseInt(octet) <= 255);
  }
  return ipv6Regex.test(ip);
}

/**
 * RFC 1918 private-range check (10/8, 172.16/12, 192.168/16). IPv4 only —
 * returns false for IPv6 or anything that isn't a valid address.
 */
export function isPrivateIpv4(ip: string): boolean {
  if (!isValidIpAddress(ip) || ip.includes(":")) return false;
  const parts = ip.split(".").map(Number);
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

/**
 * Loopback check for source-IP gating: IPv4 127.0.0.0/8, IPv6 ::1, and the
 * IPv6-mapped IPv4 forms (`::ffff:127.0.0.1`) Node hands out for v4
 * connections on dual-stack sockets.
 */
export function isLoopbackIp(ip: string): boolean {
  if (!ip) return false;
  let candidate = ip.trim();
  if (candidate.toLowerCase().startsWith("::ffff:") && candidate.includes(".")) {
    candidate = candidate.slice(7);
  }
  if (candidate === "::1") return true;
  if (!isValidIpAddress(candidate) || candidate.includes(":")) return false;
  return candidate.split(".").map(Number)[0] === 127;
}

/**
 * RFC 1918 private-range OR loopback check for source-IP gating (the Dash
 * wallboard's app-level gate). Accepts:
 *   - the three RFC 1918 ranges (via isPrivateIpv4)
 *   - IPv4 loopback 127.0.0.0/8 and IPv6 loopback ::1 (via isLoopbackIp)
 *   - IPv6-mapped IPv4 forms (`::ffff:10.0.0.1`) — Node hands these out for
 *     v4 connections on dual-stack sockets, so they must be unwrapped before
 *     the v4 tests.
 * Deliberately NOT accepted: fc00::/7 (ULA) and 169.254/16 (link-local) —
 * the operator-facing contract is "RFC 1918 + loopback", nothing broader.
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (!ip) return false;
  if (isLoopbackIp(ip)) return true;
  let candidate = ip.trim();
  if (candidate.toLowerCase().startsWith("::ffff:") && candidate.includes(".")) {
    candidate = candidate.slice(7);
  }
  if (!isValidIpAddress(candidate) || candidate.includes(":")) return false;
  return isPrivateIpv4(candidate);
}

/** The three RFC 1918 ranges, in the order operators expect to read them. */
export const RFC1918_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] as const;

/**
 * Is this IPv4 CIDR fully contained inside RFC 1918 private space? Used to
 * validate operator-entered source-IP scopes for surfaces that must never be
 * opened to public networks (the /api docs page). False for anything
 * unparseable, IPv6, or a range that straddles a private/public boundary —
 * callers normalize through normalizeAllowlistCidr first, so a well-formed
 * canonical CIDR is what usually arrives here. Loopback (127/8) is deliberately
 * NOT included: gating surfaces treat loopback as always allowed, so a
 * loopback entry in an allow-list is noise, not scope.
 */
export function isRfc1918Cidr(cidr: string): boolean {
  return RFC1918_RANGES.some((outer) => cidrContains(outer, cidr));
}

/**
 * First IPv4 address of a FortiOS "a.b.c.d-e.f.g.h" range string (a bare IP
 * is treated as a single-address range). Null for empty / non-IPv4 input and
 * for the FortiOS "any" placeholder 0.0.0.0.
 */
export function parseRangeFirstIp(rangeStr: string): string | null {
  if (!rangeStr) return null;
  const ip = rangeStr.split("-")[0].trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && ip !== "0.0.0.0") return ip;
  return null;
}

/**
 * The bare address out of an INTERFACE address string, whatever shape the
 * transport reported it in: "10.4.1.1", "10.4.1.1/24" (SNMP ipAddrTable
 * joined with its mask) and the FortiOS CMDB pair "10.4.1.1 255.255.255.0"
 * all yield "10.4.1.1". Empty string for null / blank input.
 *
 * Exists because the shapes are NOT interchangeable to a string comparison,
 * which is what an operator's `!= 0.0.0.0` automation and the auto-monitor
 * dead-parent check both are: "0.0.0.0 0.0.0.0" is the same unaddressed
 * interface as "0.0.0.0" and must not read as a different value.
 */
export function bareInterfaceIp(raw: string | null | undefined): string {
  if (raw == null) return "";
  return raw.trim().split(/[\s/]/)[0] ?? "";
}

/**
 * True when an interface address gives no evidence of a usable address: never
 * sampled (null), empty, or the "unaddressed" placeholder 0.0.0.0 in any of
 * the shapes above.
 */
export function interfaceIpIsUnaddressed(raw: string | null | undefined): boolean {
  const ip = bareInterfaceIp(raw);
  return ip === "" || ip === "0.0.0.0";
}

/**
 * Fully expand an IPv6 address: `::` filled with zero groups, every group
 * zero-padded to 4 hex digits. Input is assumed syntactically valid.
 */
export function expandIpv6(ip: string): string {
  const halves = ip.split("::");
  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    groups = [...left, ...Array(missing).fill("0000"), ...right];
  } else {
    groups = ip.split(":");
  }
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * Reverse-DNS PTR query name for an IPv4 or IPv6 address
 * (`d.c.b.a.in-addr.arpa` / nibble-reversed `ip6.arpa`).
 */
export function ipToPtrName(ip: string): string {
  if (ip.includes(":")) {
    const full = expandIpv6(ip);
    const hex = full.replace(/:/g, "");
    return hex.split("").reverse().join(".") + ".ip6.arpa";
  }
  return ip.split(".").reverse().join(".") + ".in-addr.arpa";
}

/**
 * Sort comparator putting IPv4 addresses in numeric order, so `.2` precedes
 * `.10` instead of following it. Anything that is not a dotted quad (an IPv6
 * address, a hostname that reached a list of addresses) sorts after every
 * IPv4 address, then lexicographically among itself — a stable, arbitrary
 * order beats throwing inside a sort.
 */
export function compareIpv4(a: string, b: string): number {
  const aOk = isValidIpv4(a);
  const bOk = isValidIpv4(b);
  if (aOk && bOk) return ipToInt(a) - ipToInt(b);
  if (aOk !== bOk) return aOk ? -1 : 1;
  return a.localeCompare(b);
}

// ─── Containment & Overlap ────────────────────────────────────────────────────

/**
 * Return true if `inner` is fully contained within `outer`.
 * Both must be IPv4 CIDRs.
 */
export function cidrContains(outer: string, inner: string): boolean {
  try {
    const outerBlock = new Netmask(outer);
    const innerBlock = new Netmask(inner);
    // inner must start at or after outer's base and end at or before its last
    // address. `broadcast` is UNDEFINED for a /31 and a /32 (there is no
    // broadcast address in a point-to-point or host route), and the previous
    // non-null assertion made `contains(undefined)` throw straight into the
    // catch below — so every /31 and /32 inner reported "not contained",
    // silently. That took out the two callers that pass a host route: the
    // region-tag propagation to assets addressed out of an enclosed gate's
    // subnet, and the sighting-to-subnet enrichment on the asset panel; it
    // would also have refused a /32 subnet inside its own block. `last` is the
    // last address for those prefixes and the last USABLE host for wider ones,
    // so prefer `broadcast` where it exists to keep the wider case unchanged.
    const innerEnd = innerBlock.broadcast ?? innerBlock.last;
    return outerBlock.contains(innerBlock.base) && outerBlock.contains(innerEnd);
  } catch {
    return false;
  }
}

/**
 * Return true if two CIDRs overlap at all (either contains the other or they
 * share any addresses).
 */
export function cidrOverlaps(a: string, b: string): boolean {
  try {
    const blockA = new Netmask(a);
    const blockB = new Netmask(b);
    return blockA.contains(blockB.base) || blockB.contains(blockA.base);
  } catch {
    return false;
  }
}

/**
 * Return true if the given IP address is within the CIDR range.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const block = new Netmask(cidr);
    return block.contains(ip);
  } catch {
    return false;
  }
}

/**
 * Pre-compile a list of CIDRs into a reusable "which of these contains this IP?"
 * test, returning the first matching CIDR or null.
 *
 * Exists for the loops that ask the question once per asset: `ipInCidr` builds a
 * fresh Netmask per call, so testing n assets against m subnets constructs n*m
 * of them — at 2000 assets and a few hundred subnets that is the dominant cost
 * of a map-region reconcile, and it repeats per region. Parsing each CIDR once
 * makes the inner loop a pair of integer comparisons.
 *
 * Unparseable CIDRs are dropped rather than throwing: the caller is matching
 * against discovery-supplied rows, and one bad row must not blind the rest.
 * IPv4 only (Netmask), same as `ipInCidr` — an IPv6 address simply matches
 * nothing.
 */
export function buildCidrMatcher(cidrs: string[]): (ip: string) => string | null {
  const blocks: Array<{ cidr: string; block: Netmask }> = [];
  for (const cidr of cidrs) {
    try {
      blocks.push({ cidr, block: new Netmask(cidr) });
    } catch {
      /* skip unparseable */
    }
  }
  return (ip: string): string | null => {
    if (!ip) return null;
    for (const b of blocks) {
      try {
        if (b.block.contains(ip)) return b.cidr;
      } catch {
        /* not an IPv4 address this block can evaluate */
      }
    }
    return null;
  };
}

/**
 * Normalize a single operator-entered allow-list entry to a canonical IPv4
 * CIDR (host bits zeroed), or null if it isn't a valid IPv4 CIDR / bare IPv4
 * address. A bare address becomes a /32. IPv4-only — the Netmask matcher
 * (ipMatchesAnyCidr) can't evaluate IPv6, so IPv6 entries are rejected here
 * rather than silently stored and never matched. Used by the Dash wallboard's
 * custom source-IP allow-list.
 */
export function normalizeAllowlistCidr(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const withPrefix = s.includes("/") ? s : `${s}/32`;
  if (detectIpVersion(withPrefix) !== "v4") return null;
  if (!isValidCidr(withPrefix)) return null;
  try {
    return normalizeCidr(withPrefix);
  } catch {
    return null;
  }
}

// ipMatchesAnyCidr was retired 2026-08 (audit): it was an IPv4-only subset of
// utils/ipAllowlist.ipMatchesAllowlist with the same ::ffff: unwrapping — the
// Dash wallboard gate (its only caller) now uses the allowlist matcher.

// ─── Allocation Helpers ───────────────────────────────────────────────────────

/**
 * Return the total number of usable host addresses in a CIDR block.
 * /31 and /32 are handled as special cases (RFC 3021).
 */
export function usableHostCount(cidr: string): number {
  const block = new Netmask(cidr);
  if (block.bitmask === 32) return 1;
  if (block.bitmask === 31) return 2;
  return block.size - 2; // subtract network and broadcast
}

/**
 * Given a parent CIDR and a list of already-allocated child CIDRs,
 * find the first available sub-block of the requested prefix length.
 *
 * Returns the CIDR string of the next available block, or null if none found.
 */
export function findNextAvailableSubnet(
  parentCidr: string,
  allocatedCidrs: string[],
  requestedPrefix: number
): string | null {
  const parent = new Netmask(parentCidr);
  const blockSize = Math.pow(2, 32 - requestedPrefix);

  // Convert base IP to a 32-bit integer
  const baseInt = ipToInt(parent.base);
  const endInt = ipToInt(parent.broadcast!);

  let candidate = baseInt;

  while (candidate + blockSize - 1 <= endInt) {
    const candidateCidr = `${intToIp(candidate)}/${requestedPrefix}`;
    const hasOverlap = allocatedCidrs.some((existing) =>
      cidrOverlaps(candidateCidr, existing)
    );

    if (!hasOverlap) {
      return normalizeCidr(candidateCidr);
    }

    candidate += blockSize;
  }

  return null;
}

// ─── Enumeration ─────────────────────────────────────────────────────────────

export interface EnumeratedIp {
  address: string;
  type: "network" | "broadcast" | "host";
}

export function enumerateSubnetIps(
  cidr: string,
  page: number = 1,
  pageSize: number = 256
): { addresses: EnumeratedIp[]; total: number } {
  const block = new Netmask(cidr);
  const baseInt = ipToInt(block.base);
  const broadcastInt = ipToInt(block.broadcast!);
  const total = broadcastInt - baseInt + 1;

  const startIdx = (page - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);
  const addresses: EnumeratedIp[] = [];

  for (let i = startIdx; i < endIdx; i++) {
    const ip = intToIp(baseInt + i);
    let type: EnumeratedIp["type"];
    if (block.bitmask >= 31) {
      type = "host";
    } else if (i === 0) {
      type = "network";
    } else if (i === total - 1) {
      type = "broadcast";
    } else {
      type = "host";
    }
    addresses.push({ address: ip, type });
  }

  return { addresses, total };
}

// ─── Conversion Utilities ─────────────────────────────────────────────────────

// ─── Template packing / anchor allocation ───────────────────────────────────

export interface PackedEntry<T> {
  /** Caller-supplied source entry. */
  entry: T;
  /** Byte offset (relative to anchor start) where this subnet begins. */
  offset: number;
  /** The prefix length of the packed subnet. */
  prefixLength: number;
}

export interface PackResult<T> {
  packed: PackedEntry<T>[];
  /** Total span from offset 0 to end of last entry (in addresses). */
  totalSpan: number;
  /** Smallest prefix length whose block fully contains all packed entries. */
  containingPrefix: number;
}

/**
 * Pack a series of subnet sizes sequentially, padding each entry's offset
 * up to its own prefix boundary. Returns per-entry offsets plus the smallest
 * prefix length whose block fully contains the whole group.
 *
 * The packer preserves caller order; put larger subnets (smaller prefix
 * numbers) first to avoid alignment padding holes.
 */
export function packTemplateEntries<T extends { prefixLength: number }>(
  entries: T[]
): PackResult<T> {
  if (!entries.length) return { packed: [], totalSpan: 0, containingPrefix: 32 };

  let cursor = 0;
  const packed: PackedEntry<T>[] = [];
  for (const e of entries) {
    const size = 2 ** (32 - e.prefixLength);
    // Align cursor up to the next multiple of size (prefix alignment).
    if (cursor % size !== 0) cursor = Math.ceil(cursor / size) * size;
    packed.push({ entry: e, offset: cursor, prefixLength: e.prefixLength });
    cursor += size;
  }
  const totalSpan = cursor;
  // Smallest block that fully contains totalSpan addresses.
  const containingSize = 2 ** Math.ceil(Math.log2(totalSpan));
  const containingPrefix = 32 - Math.log2(containingSize);
  return { packed, totalSpan, containingPrefix };
}

export interface AnchoredPackResult<T> {
  /** Absolute CIDRs for each packed entry, in caller order. */
  assignments: Array<{ entry: T; cidr: string }>;
  /** The anchor CIDR the group was placed into. */
  anchorCidr: string;
  /** The effective anchor prefix actually used (may be smaller-number than requested). */
  effectiveAnchorPrefix: number;
}

/**
 * Pack a template's worth of entries into a single anchor-aligned region of
 * the parent block.
 *
 * - Entries are packed in caller order, each aligned to its own prefix.
 * - The effective anchor prefix = `min(requestedAnchorPrefix, smallest-prefix-that-contains-the-group)`.
 *   (i.e. whichever block is larger). This guarantees all entries fit.
 * - The first anchor-aligned region inside `parentCidr` that has no overlap
 *   with any `allocatedCidrs` is chosen.
 *
 * Returns null if no free region is available (caller should surface a
 * "no room" error).
 */
export function packIntoAnchor<T extends { prefixLength: number }>(
  parentCidr: string,
  allocatedCidrs: string[],
  entries: T[],
  requestedAnchorPrefix: number
): AnchoredPackResult<T> | null {
  if (!entries.length) {
    return { assignments: [], anchorCidr: parentCidr, effectiveAnchorPrefix: requestedAnchorPrefix };
  }

  const parent = new Netmask(parentCidr);
  const packed = packTemplateEntries(entries);

  // Effective anchor is the larger of (requested, containing) — i.e. smaller prefix number.
  let effectiveAnchorPrefix = Math.min(requestedAnchorPrefix, packed.containingPrefix);
  if (effectiveAnchorPrefix < parent.bitmask) effectiveAnchorPrefix = parent.bitmask;

  const anchorSize = 2 ** (32 - effectiveAnchorPrefix);
  const baseInt = ipToInt(parent.base);
  const endInt = ipToInt(parent.broadcast!);

  let candidate = baseInt;
  while (candidate + anchorSize - 1 <= endInt) {
    const anchorCidr = `${intToIp(candidate)}/${effectiveAnchorPrefix}`;
    const hasOverlap = allocatedCidrs.some((existing) => cidrOverlaps(anchorCidr, existing));
    if (!hasOverlap) {
      const assignments = packed.packed.map((p) => ({
        entry: p.entry,
        cidr: `${intToIp(candidate + p.offset)}/${p.prefixLength}`,
      }));
      return { assignments, anchorCidr, effectiveAnchorPrefix };
    }
    candidate += anchorSize;
  }
  return null;
}

// ─── Active-scan target expansion ────────────────────────────────────────────
//
// A **Discovery** (business rule 34) is configured as a handful of operator-typed
// targets and executed as an ordered list of addresses to probe. That expansion
// lives here rather than in the scan service for the reason at the top of this
// file: it is IP math, and it needs ipToInt/intToIp, which are private to it.

/** One operator-typed scan target. */
export interface ScanTarget {
  kind: "cidr" | "range" | "single";
  /** "10.4.0.0/24" | "10.4.0.10-10.4.0.60" | "10.4.0.7" */
  value: string;
}

/** Why an address the operator asked for is not going to be probed. */
export type ScanTargetDropReason =
  | "invalid"        // unparseable, or not IPv4
  | "excluded"       // loopback / link-local / multicast / unspecified
  | "cap";           // over maxTargets

export interface ExpandScanTargetsResult {
  /** Ordered, deduped, ready to probe. */
  addresses: string[];
  /** addresses.length — the number actually scannable. */
  total: number;
  /** How many the operator asked for that aren't in `addresses`. */
  dropped: number;
  /** dropped, broken out, so the UI can say WHY rather than just "some". */
  droppedBy: Record<ScanTargetDropReason, number>;
  /** Per-target verdicts, in input order, for the step-2 preview. */
  perTarget: { target: ScanTarget; count: number; error?: string }[];
}

/**
 * Hard ceiling on one scan's address count. A /16 is 65k probes; nothing an
 * operator means by "scan my network" needs more, and the cap is what keeps a
 * fat-fingered /8 from becoming a 16-million-address sweep. Overflow is
 * REPORTED (droppedBy.cap), never silently truncated — see business rule 34(c).
 */
export const SCAN_MAX_TARGETS = 65536;

/**
 * Addresses that are never probed, whatever the operator typed. This is
 * netGuard's blocklist MINUS its RFC1918 allowance, because RFC1918 is the
 * entire point of a Discovery. Link-local matters most: 169.254.169.254 is the
 * cloud-metadata address, and a scan that dialled it from a cloud-hosted
 * Polaris would be asking the hypervisor for credentials.
 */
function isExcludedScanTarget(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (o[0] === 0) return true;                        // 0.0.0.0/8 unspecified
  if (o[0] === 127) return true;                      // loopback
  if (o[0] === 169 && o[1] === 254) return true;      // link-local incl. metadata
  if (o[0] >= 224) return true;                       // multicast + reserved + broadcast
  return false;
}

/**
 * Expand one target to its addresses, or throw with an operator-facing reason.
 *
 * A CIDR drops its network and broadcast addresses — probing them finds
 * nothing and, for the broadcast, is the one address in the range that can
 * provoke replies from every host at once. /31 and /32 keep every address
 * (RFC 3021), matching what usableHostCount already says about them.
 */
function expandOneTarget(t: ScanTarget): string[] {
  const value = (t.value || "").trim();
  if (!value) throw new Error("Empty target");

  if (t.kind === "single") {
    if (!isValidIpv4(value)) throw new Error(`Not an IPv4 address: ${value}`);
    return [value];
  }

  if (t.kind === "range") {
    const parts = value.split("-").map((s) => s.trim());
    if (parts.length !== 2) throw new Error(`Not a range (expected "start-end"): ${value}`);
    if (!isValidIpv4(parts[0]) || !isValidIpv4(parts[1])) {
      throw new Error(`Range endpoints must be IPv4 addresses: ${value}`);
    }
    const from = ipToInt(parts[0]);
    const to = ipToInt(parts[1]);
    if (to < from) throw new Error(`Range runs backwards: ${value}`);
    // Bounded here as well as at the caller: a 10.0.0.1-10.255.255.254 range
    // would otherwise materialise 16M strings before the cap could drop them.
    if (to - from + 1 > SCAN_MAX_TARGETS) {
      throw new Error(`Range covers more than ${SCAN_MAX_TARGETS} addresses: ${value}`);
    }
    const out: string[] = [];
    for (let n = from; n <= to; n++) out.push(intToIp(n));
    return out;
  }

  // kind === "cidr"
  if (!isValidCidr(value) || detectIpVersion(value) !== "v4") {
    throw new Error(`Not an IPv4 CIDR: ${value}`);
  }
  const block = new Netmask(value);
  if (block.size > SCAN_MAX_TARGETS + 2) {
    throw new Error(`${normalizeCidr(value)} covers more than ${SCAN_MAX_TARGETS} addresses`);
  }
  const first = ipToInt(block.base);
  // Derived from size, NOT from block.broadcast: the netmask package leaves
  // `broadcast` undefined for /31 and /32 (there is no broadcast address at
  // those prefix lengths), so reading it would collapse a /31 to one address.
  const last = first + block.size - 1;
  const out: string[] = [];
  if (block.bitmask >= 31) {
    for (let n = first; n <= last; n++) out.push(intToIp(n));
    return out;
  }
  for (let n = first + 1; n < last; n++) out.push(intToIp(n));
  return out;
}

/**
 * Expand operator-typed scan targets into the ordered, deduped address list a
 * Discovery run probes.
 *
 * Pure. Ordering is numeric by address (via compareIpv4) rather than by input
 * order, so overlapping targets read as one sweep and the run's progress
 * advances through the network rather than jumping about. Dedup is what makes
 * overlapping targets safe to type: "10.4.0.0/24" plus "10.4.0.50" is 254
 * probes, not 255.
 *
 * Nothing here throws — a bad target is reported in `perTarget[].error` and
 * counted in `droppedBy.invalid`, because one mistyped row must not cost the
 * operator the other nine.
 */
export function expandScanTargets(
  targets: ScanTarget[],
  maxTargets: number = SCAN_MAX_TARGETS,
): ExpandScanTargetsResult {
  const cap = Math.max(1, Math.min(maxTargets, SCAN_MAX_TARGETS));
  const seen = new Set<string>();
  const droppedBy: Record<ScanTargetDropReason, number> = { invalid: 0, excluded: 0, cap: 0 };
  const perTarget: { target: ScanTarget; count: number; error?: string }[] = [];

  for (const target of targets || []) {
    let expanded: string[];
    try {
      expanded = expandOneTarget(target);
    } catch (err) {
      droppedBy.invalid += 1;
      perTarget.push({ target, count: 0, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let kept = 0;
    for (const ip of expanded) {
      if (isExcludedScanTarget(ip)) { droppedBy.excluded += 1; continue; }
      // A duplicate is not a drop — the operator asked for it twice and gets
      // it once, which is the point of deduping rather than a loss to report.
      if (seen.has(ip)) continue;
      if (seen.size >= cap) { droppedBy.cap += 1; continue; }
      seen.add(ip);
      kept += 1;
    }
    perTarget.push({ target, count: kept });
  }

  const addresses = Array.from(seen).sort(compareIpv4);
  return {
    addresses,
    total: addresses.length,
    dropped: droppedBy.invalid + droppedBy.excluded + droppedBy.cap,
    droppedBy,
    perTarget,
  };
}

function ipToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function intToIp(int: number): string {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join(".");
}
