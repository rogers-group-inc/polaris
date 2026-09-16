/**
 * src/utils/symbolTransforms.ts — Pure value-transform registries consumed by
 * the manufacturer-profile resolver and the Custom MIB tab.
 *
 * Two registries live here:
 *
 *   1. Unary transforms (`TransformKind`) — applied to a single scalar reading
 *      before persistence. Pairs with `type="scalar"` on a metric row. Used
 *      when the device's units don't match what Polaris stores natively
 *      (Celsius vs Fahrenheit; bytes vs MB; ratio vs percent).
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
// **Where these are actually applied.** `applyTransform` has ONE call site in
// `src/`: the custom-widget collector in `monitoringService`. A unary transform
// set on a ManufacturerProfile METRIC row (cpu / memory / temperature /
// storage) is stored, shown in the profile table's Transform column, and never
// applied to a reading. Found 2026-09-16 on the owner's production install,
// where a FortiAP temperature row had carried `celsius_to_fahrenheit` for
// months without converting anything.
//
// Two consequences before reaching for one of these on a metric row:
//   - It will not do what the column implies. Either wire the stream to apply
//     it, or solve the problem where it is actually solved.
//   - For temperature specifically, converting units before storage is WRONG
//     regardless: Polaris stores and alerts in Celsius and converts at render
//     (`public/js/temp-unit.js`, `branding.temperatureUnit`). Rewriting stored
//     values would silently re-point every temperature automation's threshold
//     and step each sensor's history mid-series. SCALING a raw integer into its
//     canonical unit (a DISPLAY-HINT "d-1" sensor, say) is a different and
//     legitimate operation — it just has no implementation yet.
//
// `applyCombiner` below has NO call site at all. A double-scalar row's combiner
// is read as a STATEMENT OF SHAPE — which two of used/total/free the symbols
// are — by `profileResolver` and the disk/memory collectors, not executed here.

export type TransformKind =
  | "celsius_to_fahrenheit"
  | "fahrenheit_to_celsius"
  | "bytes_to_mb"
  | "bytes_to_gb"
  | "mb_to_bytes"
  | "ticks_to_seconds"
  | "ratio_to_percent"
  | "percent_to_ratio"
  | "signed_to_unsigned"
  | "tenths_to_units";

export const TRANSFORM_KINDS: TransformKind[] = [
  "celsius_to_fahrenheit",
  "fahrenheit_to_celsius",
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
  celsius_to_fahrenheit: "Celsius → Fahrenheit",
  fahrenheit_to_celsius: "Fahrenheit → Celsius",
  bytes_to_mb:           "Bytes → MB",
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
    case "celsius_to_fahrenheit": return value * 9 / 5 + 32;
    case "fahrenheit_to_celsius": return (value - 32) * 5 / 9;
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
