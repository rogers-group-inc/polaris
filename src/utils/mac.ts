/**
 * src/utils/mac.ts
 *
 * Shared MAC-address normalization. The storage convention across Polaris is
 * colon-separated UPPERCASE (e.g. "AA:BB:CC:DD:EE:FF") — see the pervasive
 * `.toUpperCase().replace(/-/g, ":")` pattern in the discovery services and the
 * comment at the top of `normalizeMacKey` in src/services/discovery/discoveryEngine.ts.
 *
 * `normalizeMacOrNull` additionally rejects empty, malformed, and all-zero
 * MACs by returning null, so callers can skip writing a meaningless value.
 * FortiOS reports `00:00:00:00:00:00` for unconfigured / virtual interfaces;
 * stamping that onto an Asset would be worse than leaving the field null (it
 * would collide in the byMac index and re-create the very duplicate the
 * firewall-mgmt-MAC capture is meant to prevent).
 *
 * Four shapes, one home: `macColonUpperOrNull` (loose upper-colon),
 * `normalizeMacOrNull` (strict upper-colon — Asset storage), `macHexKeyOrNull`
 * (strict bare-hex — match indexes), `normalizeMacLowerColon` (FortiOS wire
 * form — DHCP push / quarantine).
 *
 * The bottom of the file additionally owns the PLACEHOLDER-MAC vocabulary — the
 * synthetic MAC Polaris generates when an operator reserves an IP for a device
 * that isn't racked yet. See the section header there.
 */

const ALL_ZERO_HEX = "000000000000";

/**
 * LOOSE normalize: colon-separated uppercase, or null when the input is
 * empty / not exactly 12 hex digits. Accepts the all-zero MAC — use this
 * where zero must still be READABLE (global search, so an operator can find a
 * straggler; expanding a stored side-table row), and `normalizeMacOrNull`
 * anywhere a MAC is about to be written onto an asset.
 */
export function macColonUpperOrNull(raw: unknown): string | null {
  if (!raw) return null;
  const hex = String(raw).toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Normalize a raw MAC to colon-separated uppercase, or null when the input is
 * empty / not exactly 12 hex digits / all-zero.
 */
export function normalizeMacOrNull(raw: string | null | undefined): string | null {
  return isAllZeroMac(raw) ? null : macColonUpperOrNull(raw);
}

/**
 * True when the input is a well-formed MAC whose 48 bits are all zero, in any
 * separator style. The all-zero MAC is never a device's address — it is how
 * FortiOS, agents and DHCP tables spell "no MAC" — so every write that makes a
 * MAC part of an asset or a reservation treats it as absent (business rule 97). Malformed input
 * answers false: format errors are the caller's validation, not this check's.
 */
export function isAllZeroMac(raw: unknown): boolean {
  const norm = macColonUpperOrNull(raw);
  return norm !== null && norm.replace(/:/g, "") === ALL_ZERO_HEX;
}

/**
 * Bare-hex UPPERCASE matching key ("AABBCCDDEEFF"), or null when the input
 * is empty / not exactly 12 hex digits / all-zero. This is the shape for
 * cross-asset MAC match indexes (discovery byMac, duplicate-hostname merge
 * grouping) — all-zero is rejected so two unrelated devices reporting
 * 00:00:00:00:00:00 can never collide into one identity.
 */
export function macHexKeyOrNull(raw: string | null | undefined): string | null {
  const norm = normalizeMacOrNull(raw);
  return norm === null ? null : norm.replace(/:/g, "");
}

/**
 * FortiOS wire form: colon-separated LOWERCASE. Unrecognizable input passes
 * through lowercased (unchanged historical behavior — the device rejects it
 * with its own error, which is more actionable than silently dropping the
 * value client-side). Use for DHCP-reservation push and quarantine-object
 * matching; use `normalizeMacOrNull` for Asset storage.
 */
export function normalizeMacLowerColon(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return mac.toLowerCase();
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Normalize a list of raw MACs to distinct, valid, colon-uppercase form,
 * preserving first-seen order. Empty / malformed / all-zero entries are
 * dropped (loopback and tunnel interfaces report all-zero MACs). Used to
 * collect every physical interface MAC off a FortiGate so the firewall is
 * recognized in discovery's byMac index regardless of which interface a peer
 * sighted it on.
 */
export function normalizeMacsDistinct(raws: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const norm = normalizeMacOrNull(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

// ─── Placeholder MACs ────────────────────────────────────────────────────────
//
// A DHCP reservation is a MAC→IP binding, so reserving an IP for a device that
// hasn't been racked yet needs a MAC before the device exists to supply one.
// The IP panel's "Generate" button synthesizes one; these helpers give it a
// recognizable operator-settable prefix so discovery can later tell it apart
// from an observed MAC and adopt the real one (see
// services/placeholderMacAdoptionService.ts and business rule 26 in polaris-business-rules).
//
// The prefix is the ONLY marker — there is no boolean column on Reservation
// saying "this one is fake". That's deliberate: the prefix is visible on the
// FortiGate itself, so an operator reading the gate's reserved-address table
// can tell which entries are waiting on a real device without consulting
// Polaris.

/**
 * Default placeholder prefix. Locally-administered unicast by construction
 * (bit 1 of the first octet set, bit 0 clear), so the IEEE will never assign it
 * to a vendor and it cannot collide with a real manufacturer's OUI. Three
 * octets leaves 24 random bits, which is plenty for the handful of pending
 * reservations an install carries, while making a false positive against a real
 * device's MAC effectively impossible.
 *
 * NOTE for installs that predate this: every MAC the Generate button produced
 * before now begins "02:" and does NOT match this default. Those rows are left
 * alone (nothing regresses); an operator who wants them adopted sets the prefix
 * to "02" — accepting that a bare "02" also matches genuine KVM / Docker /
 * FortiOS-HA MACs.
 */
export const DEFAULT_PLACEHOLDER_MAC_PREFIX = "02:0F:5E";

/** Longest prefix we accept — a 6-octet "prefix" would be a single MAC. */
const MAX_PLACEHOLDER_PREFIX_OCTETS = 5;

/**
 * Normalize an operator-typed placeholder prefix to colon-separated UPPERCASE,
 * or null when it isn't usable. Accepts any separator (or none): "020f5e",
 * "02-0f-5e" and "02:0F:5E" all normalize identically.
 *
 * Rejects a prefix whose first octet is NOT locally-administered unicast. That
 * rejection is the load-bearing one: pointing this at a real vendor OUI would
 * make every reservation carrying that vendor's genuine MAC look like a
 * placeholder, and discovery would then feel free to overwrite it. A
 * locally-administered prefix cannot be assigned to a vendor, so no real
 * device's factory MAC can ever fall inside the placeholder space.
 */
export function normalizePlaceholderPrefix(raw: unknown): string | null {
  // Strings only. This sits behind a JSON API, and coercing a number would let
  // `42` arrive as the prefix "42" — valid hex by accident, and not what any
  // caller meant.
  if (typeof raw !== "string") return null;
  const hex = raw.toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const octets = hex.length / 2;
  if (octets > MAX_PLACEHOLDER_PREFIX_OCTETS) return null;
  const first = parseInt(hex.slice(0, 2), 16);
  // bit 1 = locally administered, bit 0 = multicast.
  if ((first & 0x02) !== 0x02 || (first & 0x01) !== 0) return null;
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Does this MAC sit inside the placeholder space?
 *
 * Both sides are reduced to bare hex first, so storage form (upper-colon),
 * FortiOS wire form (lower-colon) and an operator's dashes all compare equal.
 * An unparseable MAC or prefix answers false — this predicate gates a write
 * that overwrites a stored value, so anything it can't positively identify as
 * a placeholder must be treated as a real MAC and left alone.
 */
export function isPlaceholderMac(
  mac: string | null | undefined,
  prefix: string | null | undefined,
): boolean {
  const macHex = macHexKeyOrNull(mac);
  if (macHex === null) return false;
  const normPrefix = normalizePlaceholderPrefix(prefix);
  if (normPrefix === null) return false;
  return macHex.startsWith(normPrefix.replace(/:/g, ""));
}

/**
 * Build a placeholder MAC: the prefix, then random octets out to 48 bits.
 *
 * `randomBytes` is injected so tests are deterministic; callers pass nothing
 * and get crypto-quality randomness. An invalid prefix falls back to the
 * default rather than throwing — this runs behind a UI button, and refusing to
 * produce a MAC because a stored setting drifted would be worse than producing
 * a correct one under the default.
 */
export function generatePlaceholderMac(
  prefix?: string | null,
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const normPrefix = normalizePlaceholderPrefix(prefix) ?? DEFAULT_PLACEHOLDER_MAC_PREFIX;
  const prefixOctets = normPrefix.split(":");
  const need = 6 - prefixOctets.length;
  const bytes = randomBytes(need);
  const tail: string[] = [];
  for (let i = 0; i < need; i++) {
    tail.push((bytes[i]! & 0xff).toString(16).padStart(2, "0").toUpperCase());
  }
  return [...prefixOctets, ...tail].join(":");
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
