/**
 * src/utils/serialNumber.ts — is this string actually a serial number?
 *
 * Extracted from `services/duplicateSerialConflictService.ts` (business rule
 * 83), which was the first caller and for a while the only one. It needs to be
 * shared because a value that cannot identify a device must not be allowed to
 * BECOME an asset's serial in the first place — rejecting it only at the
 * conflict sweep meant the junk still landed on `Asset.serialNumber`, was still
 * rendered to operators, and was still what a human compared two records by.
 *
 * WHAT MAKES A "SERIAL" NOT ONE
 * SMBIOS serial fields are free text the board vendor is supposed to program at
 * manufacture and frequently doesn't. What comes back instead is a placeholder
 * ("To Be Filled By O.E.M.", "Default string", "System Serial Number") or a
 * repeated character — values that are IDENTICAL on every unit of that model.
 * Three sources feed these to us: the Polaris Agent reading SMBIOS/DMI on the
 * host, Azure Arc reading it in-guest, and Intune's enrollment-time inventory.
 *
 * WHY REJECTING BEATS STORING
 *   - `polaris-agent` is the TOP-priority serial source in the projection, so a
 *     placeholder OVERWRITES a real serial a cloud source already had. Rejecting
 *     the value lets the projection fall through to the next source, which is
 *     the honest answer — an empty serial is a known unknown, a shared
 *     placeholder is a wrong known.
 *   - Rule 83's duplicate-serial sweep reads two assets sharing a serial as one
 *     device recorded twice, so a fleet-wide placeholder is a fleet-wide pile of
 *     false conflict cards. `MAX_PLAUSIBLE_DUPLICATES` was the blunt net for the
 *     ones this list hasn't met; keeping both is deliberate.
 *
 * The agent carries its own copy of this list (`agent/internal/collectors/
 * serialnumber.go`) so a placeholder never goes on the wire at all. That copy
 * does NOT make this one redundant: agents in the field upgrade on their own
 * schedule, and Arc/Intune/FortiOS feed junk this end has to catch regardless.
 * Keep the two lists in sync when either changes.
 */

/**
 * The vendor defaults, matched case-insensitively after trimming.
 * Keep in sync with `placeholderSerials` in agent/internal/collectors/serialnumber.go.
 */
export const PLACEHOLDER_SERIALS = new Set([
  "0",
  "00000000",
  "123456789",
  "0123456789",
  "1234567890",
  "base board serial number",
  "chassis serial number",
  "default string",
  "invalid",
  "n/a",
  "na",
  "no asset tag",
  "none",
  "not applicable",
  "not available",
  "not specified",
  "null",
  "o.e.m.",
  "oem",
  "system serial number",
  "to be filled by o.e.m.",
  "to be filled by oem",
  "tobefilledbyoem",
  "unknown",
  "unspecified",
  "x",
  "xxxxxxx",
]);

/** A serial too short to be one. Real Fortinet/Dell/HP serials are 7+. */
export const MIN_SERIAL_LENGTH = 4;

/**
 * Is this string a serial that identifies a specific piece of hardware?
 *
 * Rejects the SMBIOS placeholders, anything under `MIN_SERIAL_LENGTH`, and any
 * value that is a single character repeated (`0000000`, `XXXXXXXX`) — the shape
 * every "we didn't program one" serial takes.
 */
export function isUsableSerial(raw: string | null | undefined): boolean {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length < MIN_SERIAL_LENGTH) return false;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_SERIALS.has(lower)) return false;
  // A single repeated character, whatever it is.
  if (/^(.)\1+$/.test(trimmed)) return false;
  return true;
}

/**
 * The trimmed serial, or null when the value cannot identify a device.
 *
 * This is the form the projection and the ingest paths want: "give me the value
 * to store, or nothing". Callers deciding whether an EXISTING value is worth
 * acting on (the conflict sweep) want the boolean instead.
 */
export function usableSerialOrNull(raw: string | null | undefined): string | null {
  if (!isUsableSerial(raw)) return null;
  return (raw as string).trim();
}
