/**
 * src/utils/safeText.ts — input checks that sit BEHIND output encoding.
 *
 * Every place Polaris renders a name or a serial now encodes it for the context it
 * lands in (`jsArg` for an inline handler, `escapeHtml` for markup, the CSV and
 * webhook escapers). These checks are the second layer: a value that is a
 * hostname-shaped identifier, or a label with no control characters, cannot
 * become a problem in a context nobody has thought of yet (scan findings F167,
 * F176, F177, F197, F235; business rule 109). They are deliberately permissive —
 * quotes, spaces and Unicode stay legal in a name — and refuse only what no real
 * name contains.
 *
 * Pure.
 */

// C0 controls, DEL, NEL and the Unicode line / paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** True when `s` holds no control character, line break or separator. */
export function hasNoControlChars(s: string): boolean {
  return !CONTROL.test(s);
}

/** Remove control characters (a multipart filename, for instance), then trim. */
export function stripControlChars(s: string): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, "").trim();
}

// A device serial is letters and digits: FortiGate FGT60F0000000001, FortiSwitch
// S108FF..., FortiAP FP231K... A reported value outside this shape is not one.
const DEVICE_SERIAL = /^[A-Za-z0-9]{6,32}$/;

/**
 * The serial, trimmed, if it has the shape of a device serial; otherwise null.
 * Use where a device-reported serial is about to be stored.
 */
export function deviceSerialOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return DEVICE_SERIAL.test(t) ? t : null;
}
