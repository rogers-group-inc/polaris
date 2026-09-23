/**
 * src/utils/hardwareIdentity.ts
 *
 * Normalization for hardware identifiers used to match the SAME physical
 * machine across integrations that share no other key.
 *
 * The motivating case: Active Directory carries no hardware identity at all
 * (objectGuid / cn / dnsHostName / objectSid / ouPath), and Azure Arc carries
 * no MAC. So an AD-discovered server and an Arc-discovered machine have
 * nothing definitive in common — only the hostname, which is a heuristic.
 * The Polaris Agent bridges them: it runs ON the host, reads the SMBIOS
 * serial, and stamps it onto whatever asset it was installed on. Arc reads
 * the same SMBIOS field, so a serial match ties the two together.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN INLINE `.trim()`: a hardware serial is
 * a genuinely dangerous match key if taken at face value, in three distinct
 * ways, and every one of them fails by MERGING UNRELATED MACHINES — the
 * worst possible failure mode for an inventory tool, because it destroys
 * data and looks like nothing at all.
 *
 *   1. **Vendor placeholders.** A large fraction of white-box and some
 *      tier-1 hardware ships with the serial literally set to
 *      "To Be Filled By O.E.M.", "System Serial Number", "Default string",
 *      "None", "Not Specified", "0123456789" or all-zeros. Thousands of
 *      unrelated machines report the identical string.
 *   2. **Our own agent's SKU fallback — FIXED in agent 0.20.1, but still
 *      in the data.** Windows publishes no serial in the registry at all, and
 *      the collector used to fall back to `SystemSKU` from the BIOS key, which
 *      is a MODEL SKU: every machine of that model reported the same value.
 *      The collector now reads the real SMBIOS table (see readPlatformDMI in
 *      agent/internal/collectors/systeminfo_windows.go), but agents in the
 *      field upgrade on their own schedule and assets stamped by an older one
 *      keep the SKU until that agent next reports. Treat this as live.
 *   3. **Virtualization.** Some hypervisors and cloning workflows leave
 *      duplicate serials across a template's descendants.
 *
 * Cases 1 and 3 are handled here by rejecting known-junk shapes. Case 2
 * cannot be — a SKU is a perfectly well-formed string — so callers MUST also
 * apply the uniqueness guard: build the index, then DROP any key that maps
 * to more than one asset (see `indexUniqueBy`). A key that is ambiguous in
 * the data is not an identity, whatever it looks like.
 *
 * Pure — no DB, no I/O.
 */

import { PLACEHOLDER_SERIALS, MIN_SERIAL_LENGTH } from "./serialNumber.js";

/**
 * The placeholder list and the length floor are shared with the projection and
 * the rule 83 conflict sweep (utils/serialNumber.ts) — three private copies of
 * "what is not a serial" is how they drift apart. What stays local is the
 * stricter NORMALIZATION below: this file builds a MATCH KEY, so it also folds
 * case and internal whitespace and rejects values with no alphanumeric content,
 * none of which the other two callers need.
 */
/**
 * Normalize a hardware serial for use as a match key, or return null when
 * the value is not usable as an identity.
 *
 * Returns the UPPERCASED, whitespace-collapsed form so two sources that
 * disagree only on case or internal spacing still match — Arc reports the
 * raw SMBIOS string while the agent reads a registry value that some OEMs
 * pad differently.
 *
 * Rejects: empty/non-string, known placeholders, anything shorter than
 * MIN_SERIAL_LENGTH, all-zero / all-same-character strings, and values with
 * no alphanumeric content.
 */
export function normalizeHardwareSerial(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  // Collapse internal runs of whitespace so "VMware-56 4d  aa" and
  // "VMware-56 4d aa" are the same key.
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;

  if (PLACEHOLDER_SERIALS.has(collapsed.toLowerCase())) return null;
  if (collapsed.length < MIN_SERIAL_LENGTH) return null;

  // Must carry at least one alphanumeric character — a serial of "----" or
  // "...." is a placeholder wearing a different costume.
  if (!/[a-z0-9]/i.test(collapsed)) return null;

  // All-same-character (0000000, FFFFFFF, XXXXXXX) is never a real identity.
  const bare = collapsed.replace(/[^a-z0-9]/gi, "");
  if (bare.length > 0 && /^(.)\1*$/.test(bare)) return null;

  return collapsed.toUpperCase();
}

/**
 * Build a key → value index that DROPS any key seen more than once.
 *
 * This is the uniqueness guard that makes serial matching safe. Normalization
 * above cannot catch every non-unique value — our own agent's Windows SKU
 * fallback produces a well-formed string shared by every machine of a model —
 * so the last line of defence is the data itself: if a key resolves to two
 * different assets, it is not an identity and must not be matched on.
 *
 * Ambiguous keys are returned separately so the caller can log them; a fleet
 * with many collisions is worth telling an operator about rather than
 * silently narrowing the match cascade.
 */
export function indexUniqueBy<T>(
  entries: Iterable<{ key: string | null; value: T; id: string }>,
): { index: Map<string, T>; ambiguous: Set<string> } {
  const seenIdByKey = new Map<string, string>();
  const index = new Map<string, T>();
  const ambiguous = new Set<string>();

  for (const { key, value, id } of entries) {
    if (!key) continue;
    if (ambiguous.has(key)) continue;

    const priorId = seenIdByKey.get(key);
    if (priorId === undefined) {
      seenIdByKey.set(key, id);
      index.set(key, value);
      continue;
    }
    // Same asset reporting the key twice (two sources agreeing) is fine.
    if (priorId === id) continue;

    // Two different assets: the key is not an identity.
    ambiguous.add(key);
    index.delete(key);
  }

  return { index, ambiguous };
}
