/**
 * src/utils/conflictValue.ts
 *
 * How a reservation Conflict compares a discovered value with the live
 * reservation's (business rule 7). "Differs" means differs to the operator
 * reading the card, not differs in bytes: the conflict card renders both sides
 * as HTML, which collapses whitespace, so a trailing space, a non-breaking
 * space or a zero-width character pasted with a name raised a card whose two
 * columns read identically. The hostname is also compared case-insensitively,
 * the way DNS and DHCP treat it.
 *
 * Shared by discoveryEngine → computeConflictFields (raising) and the
 * resolveStaleReservationConflicts startup job (closing), so the two can never
 * disagree about whether a pending card still has anything to decide.
 */

/**
 * The form a reservation conflict field is compared in: Unicode NFKC,
 * zero-width characters removed, every run of whitespace (NBSP included)
 * collapsed to one space, trimmed, blank → null; the hostname is lower-cased.
 */
export function normalizeConflictValue(field: string, value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "") return null;
  return field === "hostname" ? s.toLowerCase() : s;
}

/** True when two reservation conflict values read the same (see `normalizeConflictValue`). */
export function conflictValuesEqual(
  field: string,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeConflictValue(field, a) === normalizeConflictValue(field, b);
}
