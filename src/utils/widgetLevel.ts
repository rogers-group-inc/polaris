/**
 * A custom widget's own warning and critical levels (business rule 181) — one
 * reading of `warningAt` / `criticalAt` / `warningWhen` for every surface that
 * asks "is this widget in warning?": the asset card's colour and caption, the
 * `customWidgetLevel` automation condition, and the alert email's chart.
 *
 * The levels live on the widget (a manufacturer profile widget's
 * `displayOptions`, a Generic API widget's definition), entered in the widget's
 * own unit and compared with the stored reading — the same number an
 * automation on `customWidgetValue` compares. `warningWhen` gives the direction
 * for BOTH levels: "above" (the default — load, current, temperature) or
 * "below" (battery charge, runtime). A level counts as reached at the
 * threshold itself: "warn at 90" warns at 90.
 */

export interface WidgetLevels {
  warningAt: number | null;
  criticalAt: number | null;
  below: boolean;
}

/** 0 = normal, 1 = warning, 2 = critical. */
export type WidgetLevel = 0 | 1 | 2;

export const WIDGET_LEVEL_NAMES: Record<WidgetLevel, string> = { 0: "normal", 1: "warning", 2: "critical" };

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The levels a widget's options define, or null when it defines neither. */
export function widgetLevelsOf(opts: Record<string, unknown> | null | undefined): WidgetLevels | null {
  if (!opts) return null;
  const warningAt = finite(opts.warningAt);
  const criticalAt = finite(opts.criticalAt);
  if (warningAt === null && criticalAt === null) return null;
  return { warningAt, criticalAt, below: opts.warningWhen === "below" };
}

/** The level one reading is at, or null when there is no reading or no level to reach. */
export function widgetLevel(value: number | null | undefined, levels: WidgetLevels | null): WidgetLevel | null {
  if (!levels || typeof value !== "number" || !Number.isFinite(value)) return null;
  const reached = (at: number | null) => at !== null && (levels.below ? value <= at : value >= at);
  if (reached(levels.criticalAt)) return 2;
  if (reached(levels.warningAt)) return 1;
  return 0;
}

/**
 * A problem with the two thresholds as entered, or null. Critical must lie
 * beyond warning in the direction that is the problem — above it for "above",
 * below it for "below" — or the card could read critical before warning.
 */
export function widgetLevelsProblem(levels: WidgetLevels | null): string | null {
  if (!levels || levels.warningAt === null || levels.criticalAt === null) return null;
  if (levels.below ? levels.criticalAt > levels.warningAt : levels.criticalAt < levels.warningAt) {
    return levels.below
      ? "Critical at must be at or below Warning at (the warning side is \"at or below\")"
      : "Critical at must be at or above Warning at";
  }
  return null;
}
