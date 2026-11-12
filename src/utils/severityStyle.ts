/**
 * src/utils/severityStyle.ts — one severity → colour map for every surface
 * that paints an alert OUTSIDE the browser: Teams cards and alert emails.
 * (In-browser surfaces use the `.badge-level-*` / `.sev-*` CSS classes in
 * styles.css, which stay the source of truth there — including the acknowledge
 * page, which is an ordinary logged-in page since business rule 25 and so
 * reads the same tokens the in-app badges do.)
 *
 * Pure. Kept apart from the notification services so the email builder can use
 * it without dragging Prisma in.
 */

/** Hex WITHOUT a leading "#" — the shape Teams MessageCard themeColor wants. */
const SEVERITY_HEX: Record<string, string> = {
  // current notification severities
  notice: "6b7280",
  informational: "2563eb",
  warning: "d97706",
  serious: "ea580c",
  critical: "dc2626",
  // the engine's pseudo-severity for a recovery
  resolved: "16a34a",
  // legacy audit-event levels (pre-migration rows / event payloads)
  info: "2563eb",
  error: "dc2626",
};

const FALLBACK_HEX = "808080";

export function severityHex(severity: string | null | undefined): string {
  const key = String(severity ?? "");
  // Own keys only: "constructor" must fall back, not return Object.
  return Object.hasOwn(SEVERITY_HEX, key) ? SEVERITY_HEX[key]! : FALLBACK_HEX;
}

/**
 * The colour a `down` monitor state is DRAWN in — one entry per severity,
 * mirrored by `DOWN_SEV_COLOR` in public/js/chart-severity.js.
 *
 * Down is not inherently red. Red is what `critical` looks like, and critical
 * happens to be the default severity of every down automation Polaris seeds. An
 * operator who says an outage on this device class is only worth a `warning`
 * has said something about how it should read, and painting it in the same red
 * as a critical outage overrides that on every surface at once.
 *
 * DELIBERATELY NOT the `SEVERITY_HEX` values above. Those colour a whole alert
 * — an email's severity bar, a Teams card — where nothing else competes. These
 * land on the response-time chart and the Last-30-min strip, which already
 * spend amber on a below-threshold miss (#ffc107), blue on a recovering probe
 * (#0288d1) and grey on a dependency-explained one (#9aa0a6). Each value here
 * is pulled deliberately deeper than its neighbour in that vocabulary so the
 * two stay tellable apart:
 *
 *   critical      #d32f2f  the red every surface already used — unchanged, so
 *                          a default install looks exactly as it did
 *   serious       #e65100  deep orange, well clear of the miss amber
 *   warning       #f9a825  the operator's "yellow", a shade under #ffc107
 *   informational #1565c0  darker than the recovering blue
 *   notice        #546e7a  darker than the dependency grey
 *
 * The warning/amber pair is the closest of the four and it is a real limit
 * rather than a bug: a warning-severity outage and the misses that built it are
 * two shades of one yellow. They stay separable by shape and by tooltip — the
 * misses are the climb, the down is the verdict — and by the pill, which names
 * the state outright. An unrecognized severity falls back to the red, because
 * that is what Down has always been.
 */
const DOWN_SEVERITY_HEX: Record<string, string> = {
  notice: "546e7a",
  informational: "1565c0",
  warning: "f9a825",
  serious: "e65100",
  critical: "d32f2f",
};

/** Hex WITHOUT a leading "#". */
export function downSeverityHex(severity: string | null | undefined): string {
  const key = String(severity ?? "");
  return Object.hasOwn(DOWN_SEVERITY_HEX, key) ? DOWN_SEVERITY_HEX[key]! : DOWN_SEVERITY_HEX.critical!;
}

/** Same colour, CSS-ready — what the alert-email response-time chart strokes a
 *  down probe with. */
export function downSeverityCss(severity: string | null | undefined): string {
  return `#${downSeverityHex(severity)}`;
}

/** Same colour, CSS-ready. */
export function severityCss(severity: string | null | undefined): string {
  return `#${severityHex(severity)}`;
}
