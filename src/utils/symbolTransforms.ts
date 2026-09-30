/**
 * src/utils/symbolTransforms.ts — Pure value-transform registries consumed by
 * the manufacturer-profile resolver and the Custom MIB tab.
 *
 * Two registries live here:
 *
 *   1. Unary transforms (`TransformKind`) — applied to a single scalar reading
 *      before persistence. Used when the device's units don't match what
 *      Polaris stores natively (bytes vs MB; ratio vs percent; a DISPLAY-HINT
 *      "d-1" integer carrying one implied decimal place).
 *
 *   2. Binary combiners (`CombinerKind`) — applied to two scalar readings
 *      (`a` and `b`) to produce one number. Pairs with `type="double_scalar"`
 *      on a metric row. Used when a metric is exposed by the device as two
 *      OIDs that have to be combined (e.g. memory `used` + `total`; disk
 *      `used` + `free`).
 *
 * Pure (no I/O, no DB) so unit tests are trivial and the frontend can reuse
 * the labels.
 */

// ─── Unary transforms ────────────────────────────────────────────────────
//
// **Where these are actually applied.** Two call sites, accepting different
// lists:
//   - The custom-widget collector in `monitoringService` applies any
//     `TransformKind` set on a widget.
//   - A ManufacturerProfile METRIC row applies only what `METRIC_ROW_TRANSFORMS`
//     below names for its metric key — today `tenths_to_units` on a scalar
//     temperature row, applied by the hardware-sensor collector's
//     profile-scalar path. The write path refuses anything else on a metric
//     row, and the profile page hides the Transform select where the list is
//     empty.
//
// The split exists because metric rows used to accept the whole list and
// apply none of it: found 2026-09-16 on the owner's production install, where
// a FortiAP temperature row had carried a Celsius→Fahrenheit transform for
// months without converting anything. Wiring a transform for another metric
// means the collector applies it AND it lands in METRIC_ROW_TRANSFORMS, in the
// same change — that list is what the UI offers.
//
// There is deliberately no Celsius↔Fahrenheit transform (removed 2026-09-23).
// Polaris stores and alerts in Celsius and converts at render
// (`public/js/temp-unit.js`, `branding.temperatureUnit`); converting before
// storage would silently re-point every temperature automation's threshold and
// step each sensor's history mid-series. SCALING a raw integer into its
// canonical unit (`tenths_to_units`) is the legitimate operation.
//
// `applyCombiner` below has NO call site at all. A double-scalar row's combiner
// is read as a STATEMENT OF SHAPE — which two of used/total/free the symbols
// are — by `profileResolver` and the disk/memory collectors, not executed here.

export type TransformKind =
  | "bytes_to_mb"
  | "bytes_to_gb"
  | "mb_to_bytes"
  | "ticks_to_seconds"
  | "ratio_to_percent"
  | "percent_to_ratio"
  | "signed_to_unsigned"
  | "tenths_to_units";

export const TRANSFORM_KINDS: TransformKind[] = [
  "bytes_to_mb",
  "bytes_to_gb",
  "mb_to_bytes",
  "ticks_to_seconds",
  "ratio_to_percent",
  "percent_to_ratio",
  "signed_to_unsigned",
  "tenths_to_units",
];

export const TRANSFORM_LABELS: Record<TransformKind, string> = {
  bytes_to_mb:          "Bytes → MB",
  bytes_to_gb:           "Bytes → GB",
  mb_to_bytes:           "MB → Bytes",
  ticks_to_seconds:      "TimeTicks → Seconds",
  ratio_to_percent:      "Ratio (0..1) → Percent (0..100)",
  percent_to_ratio:      "Percent (0..100) → Ratio (0..1)",
  signed_to_unsigned:    "Signed Int32 → Unsigned (negative values shifted by 2³²)",
  tenths_to_units:       "Tenths → Units (DISPLAY-HINT d-1)",
};

export function isTransformKind(value: unknown): value is TransformKind {
  return typeof value === "string" && (TRANSFORM_KINDS as string[]).includes(value);
}

/**
 * The unary transforms a collector actually applies on a ManufacturerProfile
 * metric row, by metric key. Scalar rows only — a table walk and a
 * double-scalar pair never pass through a unary transform. A metric absent
 * here takes none, and its row shows no Transform select.
 */
export const METRIC_ROW_TRANSFORMS: Readonly<Record<string, readonly TransformKind[]>> = {
  // DISPLAY-HINT "d-1" sensor scalars (MikroTik's Temperature convention and
  // the like), scaled into °C by the hardware-sensor collector.
  temperature: ["tenths_to_units"],
};

/** The unary transforms a metric row of this key and type may carry; [] = none. */
export function metricRowTransforms(metricKey: string, type: string): readonly TransformKind[] {
  if (type !== "scalar") return [];
  return METRIC_ROW_TRANSFORMS[metricKey] ?? [];
}

/**
 * Apply the named unary transform to a raw numeric value. Returns the input
 * unchanged when `kind` is null/undefined or the value isn't a finite
 * number — null/non-numeric inputs flow through so an upstream "no data"
 * signal isn't silently coerced to 0.
 */
export function applyTransform(value: number | null | undefined, kind: TransformKind | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  if (!kind) return value;
  switch (kind) {
    case "bytes_to_mb":           return value / (1024 * 1024);
    case "bytes_to_gb":           return value / (1024 * 1024 * 1024);
    case "mb_to_bytes":           return value * 1024 * 1024;
    case "ticks_to_seconds":      return value / 100; // SNMP TimeTicks are hundredths-of-a-second
    case "ratio_to_percent":      return value * 100;
    case "percent_to_ratio":      return value / 100;
    case "signed_to_unsigned":    return value < 0 ? value + 2 ** 32 : value;
    // SMI DISPLAY-HINT "d-1" — the raw integer carries one implied decimal
    // place, so 315 means 31.5. Common on vendor sensor objects; MikroTik's
    // Temperature / Power / Voltage textual conventions all use it.
    case "tenths_to_units":       return value / 10;
    default:                      return value;
  }
}

// ─── Binary combiners ────────────────────────────────────────────────────

export type CombinerKind =
  | "a_over_b_as_percent"           // a / b × 100         (used / total → memory %)
  | "a_over_a_plus_b_as_percent"    // a / (a + b) × 100   (used / (used + free) → memory %)
  | "b_minus_a_over_b_as_percent"   // (b - a) / b × 100   (free / total → "% used" via inverse)
  | "a_minus_b"                     // a - b               (total - free = used)
  | "a_plus_b"                      // a + b               (used + free = total)
  | "a_over_b_ratio";               // a / b               (used / total → ratio 0..1)

export const COMBINER_KINDS: CombinerKind[] = [
  "a_over_b_as_percent",
  "a_over_a_plus_b_as_percent",
  "b_minus_a_over_b_as_percent",
  "a_minus_b",
  "a_plus_b",
  "a_over_b_ratio",
];

export const COMBINER_LABELS: Record<CombinerKind, string> = {
  a_over_b_as_percent:         "A / B × 100 (e.g. used / total → percent)",
  a_over_a_plus_b_as_percent:  "A / (A + B) × 100 (e.g. used / (used + free) → percent)",
  b_minus_a_over_b_as_percent: "(B − A) / B × 100 (e.g. used / total → percent when A=free, B=total)",
  a_minus_b:                   "A − B (e.g. total − free = used)",
  a_plus_b:                    "A + B (e.g. used + free = total)",
  a_over_b_ratio:              "A / B (ratio 0..1)",
};

export function isCombinerKind(value: unknown): value is CombinerKind {
  return typeof value === "string" && (COMBINER_KINDS as string[]).includes(value);
}

/**
 * Apply the named binary combiner to two raw numeric values. Returns null
 * when either input is null/undefined/non-finite (caller decides how to
 * propagate "no data"). Division-by-zero and zero-sum denominators return
 * null rather than Infinity/NaN so downstream chart code can render "—"
 * cleanly without special-casing.
 */
export function applyCombiner(
  a: number | null | undefined,
  b: number | null | undefined,
  kind: CombinerKind | null | undefined,
): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (!kind) return null;
  switch (kind) {
    case "a_over_b_as_percent":
      if (b === 0) return null;
      return (a / b) * 100;
    case "a_over_a_plus_b_as_percent": {
      const denom = a + b;
      if (denom === 0) return null;
      return (a / denom) * 100;
    }
    case "b_minus_a_over_b_as_percent":
      if (b === 0) return null;
      return ((b - a) / b) * 100;
    case "a_minus_b":
      return a - b;
    case "a_plus_b":
      return a + b;
    case "a_over_b_ratio":
      if (b === 0) return null;
      return a / b;
    default:
      return null;
  }
}
