/**
 * src/utils/cableMembers.ts
 *
 * Pairing decision for the Device Map's inter-switch physical-member
 * expansion: given each side's resolved member ports, how many cable lines
 * should be drawn and which port sits on each end.
 *
 * Pure — the caller (topologyGraphService) resolves the member lists from
 * LLDP local ports and managed-switch CMDB trunk membership, stamps each
 * member's physical/link-state facts, and renders whatever this returns.
 *
 * Two rules, both learned from the same prod symptom (a 1-cable link between
 * two FortiSwitches drawn as two parallel lines that named the SAME far-end
 * port on both):
 *
 *   1. A physical port terminates exactly ONE cable, so a lone physical
 *      member can never be the far end of two lines. The previous behaviour
 *      padded the short side by repeating its only member across
 *      max(a, b) lines — which is precisely how one real cable rendered as
 *      two whenever the far switch's evidence claimed an extra member. An
 *      AGGREGATE name is still repeated: it labels the whole bundle, and a
 *      side whose CMDB trunk membership hasn't been scraped degrades to that
 *      name rather than to its members.
 *
 *   2. Link state breaks ties, it does not filter. A member the device
 *      reports as anything but `up` can't be carrying a cable right now, so
 *      it loses to a live sibling — but a side that resolved exactly one
 *      member keeps it whatever its state, since a genuinely down link
 *      should render (greyed, via the edge tooltip's operStatus) rather than
 *      disappear from the map. A member with NO reading is kept: unknown is
 *      not down.
 */

export interface CableMember {
  /** Port name as it should appear on the edge label. */
  port: string;
  /**
   * False ONLY when the name is known to be an aggregate / bundle (the opaque
   * serial-named auto-ISL trunk). A name the caller couldn't classify counts
   * as physical: refusing to repeat it costs one undrawn line, while wrongly
   * repeating it draws a cable that doesn't exist.
   */
  physical: boolean;
  /**
   * True ONLY when the device reported a link state for this port and it
   * isn't "up". An absent reading is not down.
   */
  down: boolean;
}

interface CableLine {
  /** Port on the A side, or null when that side resolved no members at all. */
  a: string | null;
  b: string | null;
}

export interface CablePairing {
  lines: CableLine[];
  /**
   * Members of the longer side left without a far end, in the order they
   * were dropped. Non-empty means the two sides disagreed about how many
   * cables run between them — surfaced in the edge's operator-visible
   * reason text rather than silently drawn.
   */
  unpaired: string[];
  /** Members dropped by the link-state tiebreak (rule 2). */
  droppedDown: string[];
}

/**
 * Decide the cable lines between two switches from each side's member list.
 * Members are paired positionally, so the caller passes them in the order it
 * wants paired (natural port order).
 */
export function pairCableMembers(
  aSide: CableMember[],
  bSide: CableMember[],
): CablePairing {
  const droppedDown: string[] = [];
  // Rule 2 — link state as a tiebreak. Only a side with something to fall
  // back on drops anything.
  const liveSide = (side: CableMember[]): CableMember[] => {
    if (side.length < 2) return side;
    const live = side.filter((m) => !m.down);
    if (live.length === 0) return side;
    for (const m of side) if (m.down) droppedDown.push(m.port);
    return live;
  };
  const a = liveSide(aSide);
  const b = liveSide(bSide);

  const max = Math.max(a.length, b.length);
  if (max === 0) return { lines: [], unpaired: [], droppedDown };

  const min = Math.min(a.length, b.length);
  // Rule 1 — how many lines. A side that resolved nothing still lets the
  // other side draw its members against a null far end (the pre-existing
  // "portX ↔ unknown" rendering); a lone AGGREGATE name is repeated across
  // the bundle; a lone PHYSICAL port is not.
  const short = a.length <= b.length ? a : b;
  const repeatShortSide = min === 0 || (min === 1 && !short[0].physical);
  const count = repeatShortSide ? max : min;

  const portAt = (side: CableMember[], i: number): string | null => {
    const m = side[i];
    if (m) return m.port;
    // Repeat the lone member (aggregate name) onto every line.
    return side.length === 1 ? side[0].port : null;
  };

  const lines: CableLine[] = [];
  for (let i = 0; i < count; i++) {
    lines.push({ a: portAt(a, i), b: portAt(b, i) });
  }

  const longer = a.length >= b.length ? a : b;
  const unpaired = longer.slice(count).map((m) => m.port);

  return { lines, unpaired, droppedDown };
}
