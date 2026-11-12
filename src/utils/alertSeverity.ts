/**
 * src/utils/alertSeverity.ts — how ALERT severities compare.
 *
 * The vocabulary is the automation ladder (`notice` → `informational` →
 * `warning` → `serious` → `critical`) plus the two legacy audit-event levels
 * that pre-redesign Notification rows still carry (`info` ranks with
 * informational, `error` with critical). An unrecognized value ranks 0 rather
 * than throwing — a severity Polaris has never heard of must not be able to
 * out-rank a critical, nor to crash a list render.
 *
 * Pure, and deliberately here rather than in a service: three callers already
 * need it — the NOC feeds' severity-first sort, the assets list's active-alert
 * indicator, and the asset slide-over's Alerts tab — and a rank map copied per
 * consumer is how one of them ends up disagreeing about what `serious` means.
 * The COLOUR counterpart is utils/severityStyle.ts (off-browser surfaces) and
 * the `.badge-level-*` / `--color-sev-*` tokens in styles.css (in-browser).
 */

export const ALERT_SEVERITY_RANK: Record<string, number> = {
  notice: 1, informational: 2, info: 2, warning: 3, serious: 4, error: 5, critical: 5,
};

/** Rank of one severity; 0 for absent or unrecognized. */
export function alertSeverityRank(severity: string | null | undefined): number {
  const key = String(severity ?? "");
  // Own keys only: "toString" / "constructor" are not severities.
  return Object.hasOwn(ALERT_SEVERITY_RANK, key) ? ALERT_SEVERITY_RANK[key]! : 0;
}

/**
 * The more severe of two severities. Ties keep `a` — callers pass the
 * incumbent first, so a tie is "nothing changed" rather than a silent swap.
 */
export function higherAlertSeverity(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return alertSeverityRank(b) > alertSeverityRank(a) ? b : a;
}
