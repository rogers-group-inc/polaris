/**
 * src/utils/fortinetSerialPattern.ts
 *
 * Pure (no I/O) parser for FortiOS interface names that encode a peer
 * device's identity. Used by the topology layer to infer authoritative
 * inter-Fortinet device edges from interface lists — a stronger signal than
 * LLDP because it's CMDB-stamped by FortiOS itself when FortiLink topology
 * is configured.
 *
 * Two naming pathways the parser must accept:
 *
 *   1. FortiOS-auto peer-serial aggregates. When a managed FortiSwitch joins
 *      another FortiSwitch or its controller FortiGate via FortiLink, FortiOS
 *      creates an interface named after the peer device's SERIAL NUMBER,
 *      truncated to fit the 15-char Linux ifname limit, with optional `-N`
 *      aggregate suffix. Truncation drops characters from the FRONT of the
 *      serial until the result + suffix fits. Shape (the values below are
 *      synthetic -- never paste real fleet serials into this file):
 *
 *        Asset serial         Interface name on peer switch
 *        FGT61FTK22000001  →  GT61FTK22000001        (drops "F",  16→15 chars)
 *        S108FFTV23000001  →  8FFTV23000001-0        (drops "S10", 16→13+suffix)
 *
 *   2. Operator-customized aggregates. When MCLAG / cross-stack uplinks are
 *      hand-built, operators commonly name the aggregate after the peer
 *      switch's HOSTNAME instead, e.g. `HILLTOP2-T1024E` for a peer named
 *      `HILLTOP2-T1024E`. These names usually contain internal dashes that
 *      the FortiOS-auto path doesn't.
 *
 * Match strategy (resolved by the topology service, not this file):
 *   - Try serial-fragment match first: assetSerial.endsWith(peerFragment).
 *     Handles arbitrary front-truncation deterministically.
 *   - Fall back to hostname match: assetHostname starts with peerFragment
 *     followed by a separator. Rarer; only used when serial-match found
 *     nothing.
 *   - Both matches are case-insensitive.
 *
 * Negative cases the parser must reject (real FortiOS port names):
 *   port1, port-14, wan1, internal, fortilink, lan/lan1, mesh1, mgmt, x2,
 *   _FlInK1_ICL0_ (MCLAG ICL — handled separately, not via interface name).
 */

// Loose pattern for "this interface name looks like a Fortinet peer
// interface": uppercase letters/digits with optional internal dashes,
// 8–30 chars, must start and end with alnum (no leading/trailing dash).
// The trailing `-N` aggregate suffix is split off in code, not in the regex,
// so operator-named aggregates like `HILLTOP2-T1024E` (no numeric suffix)
// also match.
const PEER_INTERFACE_NAME_RE = /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/;
const MIN_LEN = 8;
const MAX_LEN = 30;

export interface ParsedPeerInterface {
  /** The original interface name as reported by FortiOS. */
  interfaceName: string;
  /**
   * Peer-identity fragment — interface name with any `-N` aggregate
   * suffix stripped. Compare against asset.serialNumber via
   * `serialMatchesPeerInterface` (endsWith) or asset.hostname via
   * `hostnameMatchesPeerInterface` (exact / prefix-with-separator).
   */
  peerFragment: string;
  /** Aggregate index from a `-N` suffix, when present. */
  aggregateIndex: number | null;
}

/**
 * Returns a parsed peer-interface descriptor when `name` looks like a
 * FortiOS peer-interface (auto-stamped serial OR operator-named
 * hostname aggregate), or null when it doesn't.
 *
 * Negative cases (returns null): standard port names like "port1", "wan1",
 * "internal", "fortilink", "lan", "mesh1", names with non-alphanumeric
 * characters other than internal dashes, names with leading/trailing
 * dashes, names with underscores (e.g. MCLAG ICL `_FlInK1_ICL0_`),
 * mixed-case names.
 */
export function parseFortinetPeerInterface(name: string | null | undefined): ParsedPeerInterface | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return null;
  if (!PEER_INTERFACE_NAME_RE.test(trimmed)) return null;

  // FortiOS-auto aggregate suffix is always a trailing `-<digits>`. Anything
  // else with a dash is an operator-named aggregate where the dash is part
  // of the peer's hostname.
  const dashIdx = trimmed.lastIndexOf("-");
  if (dashIdx > 0) {
    const tail = trimmed.slice(dashIdx + 1);
    if (/^\d+$/.test(tail)) {
      const fragment = trimmed.slice(0, dashIdx);
      // Reject e.g. `ABC-12` where the fragment is too short to be a
      // meaningful identity. 6 chars matches the shortest plausible
      // Fortinet serial-fragment / hostname.
      if (fragment.length >= 6) {
        return { interfaceName: trimmed, peerFragment: fragment, aggregateIndex: Number(tail) };
      }
    }
  }
  return { interfaceName: trimmed, peerFragment: trimmed, aggregateIndex: null };
}

/**
 * True when `assetSerial` could be the full serial of which
 * `parsed.peerFragment` is the FortiOS-truncated form. Asset serial must:
 *   - be longer than (or equal to) the peer fragment
 *   - end with the fragment (case-insensitive)
 */
export function serialMatchesPeerInterface(parsed: ParsedPeerInterface, assetSerial: string | null | undefined): boolean {
  if (!assetSerial) return false;
  const a = assetSerial.toUpperCase().trim();
  const f = parsed.peerFragment.toUpperCase();
  if (a.length < f.length) return false;
  return a.endsWith(f);
}

/**
 * True when `assetHostname` matches the operator-named aggregate
 * `parsed.peerFragment`. The hostname must either:
 *   - equal the fragment exactly (case-insensitive), or
 *   - start with the fragment followed by `-` or `.` (FQDN/suffix separator)
 *
 * The trailing-separator rule prevents `HILLTOP2` from matching an unrelated
 * `HILLTOP21` — operator-typed aggregate names should be a complete
 * hostname or a meaningful prefix, not a substring collision.
 *
 * A numbered sibling is not a prefix match. When the parser split a `-N`
 * suffix off (`JEFFERSON-222E-1` → fragment `JEFFERSON-222E`), the operator
 * may simply have named the aggregate after a peer whose hostname ends in a
 * number — so `JEFFERSON-222E-6` is a DIFFERENT device in the same family,
 * not the peer. Such a hostname matches only when it is the whole interface
 * name (`hostnameMatchesFullPeerInterface`).
 */
export function hostnameMatchesPeerInterface(parsed: ParsedPeerInterface, assetHostname: string | null | undefined): boolean {
  if (!assetHostname) return false;
  if (hostnameMatchesFullPeerInterface(parsed, assetHostname)) return true;
  const h = assetHostname.toUpperCase().trim();
  const f = parsed.peerFragment.toUpperCase();
  if (h.length < f.length) return false;
  if (h === f) return true;
  if (parsed.aggregateIndex !== null && /^-\d+(?:$|[.-])/.test(h.slice(f.length))) return false;
  return h.startsWith(f + "-") || h.startsWith(f + ".");
}

/**
 * True when `assetHostname` is the interface name as reported — suffix
 * included — exactly or as the short form of an FQDN. The topology service
 * tries this before the fragment match, so an aggregate named `NAME-1`
 * resolves to the device called `NAME-1` even when a `NAME` also exists.
 */
export function hostnameMatchesFullPeerInterface(parsed: ParsedPeerInterface, assetHostname: string | null | undefined): boolean {
  if (!assetHostname) return false;
  const h = assetHostname.toUpperCase().trim();
  const n = parsed.interfaceName.toUpperCase();
  return h === n || h.startsWith(n + ".");
}
