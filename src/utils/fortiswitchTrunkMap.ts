/**
 * src/utils/fortiswitchTrunkMap.ts
 *
 * Decoding for the FortiSwitch trunk→physical-port map published as a single
 * OctetString at `1.3.6.1.4.1.12356.106.3.1.0` (`fsTrunkMember.0`).
 *
 * Observed on FortiSwitchOS 7.6.6 (FS-124E-FPOE):
 *
 *   8EF5920000001-0: port23 ::8EPTQ21000003-0: port27 ::GT61FTK21000002: port24 ::
 *
 * Each entry is `<trunk name>: <local physical port>`, separated by `::`. This
 * is the switch stating its own adjacencies. The trunk names the switch
 * auto-creates are built from the SERIAL NUMBER of the device at the far end,
 * so it names those peers directly instead of leaving them to be inferred.
 *
 * The scalar carries the LAGs an operator configured by hand in the same
 * string, and those are named for whatever is plugged into them:
 *
 *   _FlInK1_ICL0_: port51 ::Cohesity Node 2: port2 ::PLPCORTSC2: port9 ::
 *
 * So a trunk name is a member/parent edge always and a peer identity only
 * sometimes — see `isPeerSerialTail` for the shape test that separates them.
 *
 * ── Why the names look mangled ───────────────────────────────────────────────
 *
 * The trunk name is the peer's serial, suffixed `-0` for a switch, then
 * **left-truncated to 15 characters**. That single rule explains what looks
 * like two different conventions:
 *
 *   S108EF5920000001 + "-0" = 18 chars → rightmost 15 → 8EF5920000001-0
 *   FGT61FTK21000002        = 16 chars → rightmost 15 → GT61FTK21000002
 *
 * A switch appears to lose three leading characters and a FortiGate only one,
 * purely because the `-0` consumes two of the fifteen.
 *
 * ── Consequence for matching ────────────────────────────────────────────────
 *
 * Do NOT try to reconstruct the serial: that would hard-code the 15-char cap
 * and break the day a firmware release changes it. Match by SUFFIX instead —
 * strip any trailing `-<n>`, then find the asset whose serial ENDS WITH what
 * remains. That is correct under any cap, and it degrades safely: a tail short
 * enough to match two devices resolves to nothing rather than to a guess.
 */

/** One `<trunk>: <port>` pair, exactly as the device reported it. */
export interface TrunkPortEntry {
  /** Trunk name as published, e.g. "8EF5920000001-0". */
  trunkName: string;
  /** Local physical port the trunk uses, e.g. "port23". */
  localPort: string;
  /**
   * `trunkName` with any trailing `-<n>` removed — the fragment to suffix-match
   * against an asset serial. For "8EF5920000001-0" this is "8EF5920000001".
   */
  peerSerialTail: string;
}

/** Trailing member/index suffix. Only `-0` has been observed in the field;
 *  the pattern is general so a future `-1` cannot silently break matching. */
const TRUNK_SUFFIX = /-\d+$/;

/**
 * Shortest tail worth suffix-matching against serials. Real tails are 13–15
 * characters (a 16-char serial minus what the 15-char cap ate); the floor
 * exists so ordinary short port names ("port23", "lan1") never trigger the
 * peer lookup at all, and so a degenerate tail can't suffix-match half the
 * fleet's serials.
 */
const MIN_PEER_TAIL_LEN = 10;

/**
 * Is this fragment worth suffix-matching against a serial at all?
 *
 * Not every trunk name is a peer serial. A FortiSwitch also carries the LAGs
 * an operator configured by hand, named for what is plugged into them ("PLPCORTSC2",
 * "Cohesity Node 2", "_FlInK1_ICL0_"), and those share the scalar with the
 * auto-created FortiLink trunks. A name with a space or an underscore in it is
 * not a serial, and a short one that happens to be alphanumeric could suffix-
 * match a real serial by accident — which would attach the trunk to a device
 * that is nowhere near it. Both checks are the same shape test, applied by
 * `trunkPeerNameTail` before a name is treated as a peer identity and by
 * `matchTrunkPeer` before the lookup runs.
 */
function isPeerSerialTail(tail: string): boolean {
  if (tail.length < MIN_PEER_TAIL_LEN) return false;
  return /^[A-Za-z0-9]+$/.test(tail);
}

/**
 * The peer-serial tail of an interface NAME shaped like a FortiLink trunk
 * ("8EF5920000001-0", "GT61FTK21000002"), or null for anything else.
 *
 * The trunk aggregates the switch auto-creates toward its FortiLink peers
 * appear in the ifTable under these names, so the interface inventory can
 * carry rows whose name IS a peer identity. This is the shape test the
 * inventory's trunk-preservation pass runs before doing any DB work: strip
 * the `-<n>` member suffix, then require a serial-plausible tail (alnum,
 * long enough that a match against an asset serial means something).
 */
export function trunkPeerNameTail(ifName: string | null | undefined): string | null {
  const name = (ifName ?? "").trim();
  if (!name) return null;
  const tail = name.replace(TRUNK_SUFFIX, "");
  if (!isPeerSerialTail(tail)) return null;
  return tail;
}

/** A parenthesised role word the IF-MIB name of a trunk can carry. */
const TRUNK_ROLE_SUFFIX = /\s*\([A-Za-z-]+\)\s*$/;

/**
 * An interface name with a trailing `(role)` suffix removed, or the name
 * unchanged when it has none.
 *
 * A FortiSwitch's ifTable can list a trunk with its role appended — observed
 * on an FS-248E: `1CD11A4549B7-0(primary)`, `_FlInK1_ICL0_(primary)` — while
 * `fsTrunkMember` and the controller CMDB name the same trunk without it. The
 * trunk-member overlay uses this to find the row a trunk name refers to.
 */
export function stripTrunkRoleSuffix(ifName: string): string {
  return ifName.replace(TRUNK_ROLE_SUFFIX, "");
}

/**
 * Parse the raw OctetString into entries.
 *
 * Tolerant by construction: entries are `::`-separated with inconsistent
 * spacing and a trailing separator, and a malformed chunk is skipped rather
 * than failing the whole scrape — this is an undocumented vendor string, so
 * the format is treated as something to survive, not something to trust.
 */
export function parseTrunkPortMap(raw: string | null | undefined): TrunkPortEntry[] {
  const text = (raw ?? "").trim();
  if (!text) return [];

  const out: TrunkPortEntry[] = [];
  const seen = new Set<string>();
  for (const chunk of text.split("::")) {
    const part = chunk.trim();
    if (!part) continue;
    const colon = part.indexOf(":");
    if (colon <= 0) continue;

    const trunkName = part.slice(0, colon).trim();
    const localPort = part.slice(colon + 1).trim();
    if (!trunkName || !localPort) continue;
    // A port name with whitespace in it would mean the separator assumption is
    // wrong; skip rather than store something nonsensical.
    if (/\s/.test(localPort)) continue;

    const key = `${trunkName}|${localPort}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      trunkName,
      localPort,
      peerSerialTail: trunkName.replace(TRUNK_SUFFIX, ""),
    });
  }
  return out;
}

/**
 * Resolve a trunk's peer-serial tail to an asset id by suffix match.
 *
 * Returns null when nothing matches, and — deliberately — also when MORE than
 * one serial ends with the tail. An ambiguous match would attach a trunk to the
 * wrong device, which is worse than leaving it unresolved: the port would be
 * drawn against the wrong neighbour on the map and, if it ever gated alerting,
 * would suppress the wrong port.
 */
export function matchTrunkPeer(
  peerSerialTail: string,
  serialToAssetId: ReadonlyMap<string, string>,
): string | null {
  const tail = peerSerialTail.trim().toUpperCase();
  if (!isPeerSerialTail(tail)) return null;

  let hit: string | null = null;
  for (const [serial, assetId] of serialToAssetId.entries()) {
    if (!serial.toUpperCase().endsWith(tail)) continue;
    if (hit && hit !== assetId) return null; // ambiguous — refuse to guess
    hit = assetId;
  }
  return hit;
}

/**
 * Group parsed entries into the `trunk -> [member ports]` shape the interface
 * overlay takes.
 *
 * The SNMP scalar states one `<trunk>: <port>` pair per member, so a trunk
 * carrying two links appears as two entries under the same name — the overlay
 * wants them as one list. Insertion order is preserved (the device publishes
 * members in port order) and duplicates are already gone by parse time, so
 * this is a pure regroup with no dedupe of its own.
 *
 * Exists so the SNMP path can feed `overlayFortiswitchTrunkMembers` the same
 * map the controller-CMDB path builds, instead of a second overlay that would
 * be free to disagree with it about what a member row looks like.
 */
export function trunkMemberMap(entries: readonly TrunkPortEntry[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of entries) {
    const members = map.get(e.trunkName);
    if (members) members.push(e.localPort);
    else map.set(e.trunkName, [e.localPort]);
  }
  return map;
}
