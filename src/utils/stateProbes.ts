/**
 * src/utils/stateProbes.ts
 *
 * The 0/1 half of the Manufacturer Profile probe framework: turning whatever a
 * device actually returns for a status-shaped OID into a boolean an automation
 * can fire on.
 *
 * Why this exists: plenty of the most useful things a device publishes are not
 * gauges. They are flags — an alarm bit, a PSU present/failed, a fan-tray OK,
 * an RPS status, a redundancy-lost indicator. Alerting on those through a
 * numeric threshold ("alarm >= 1") happens to work for a 0/1 INTEGER and breaks
 * for everything else: enumerations that use 2 for the bad state (or 1 for the
 * GOOD one), TruthValue's SNMPv2 `true(1) / false(2)`, and string statuses
 * ("ok" / "alarm"). So the mapping from a raw reading to true/false is operator
 * DECLARED per probe, evaluated here, and stored already-normalized — the
 * automation engine then only ever compares 0 or 1 and cannot be wrong about a
 * vendor's polarity.
 *
 * Kept dependency-free (no Prisma, no SNMP types) so the whole decision table
 * unit-tests directly. This is the single source of truth for the mapping: the
 * collector evaluates it at scrape time, the profile editor validates against
 * it, and the automation builder renders its labels.
 */

/**
 * How a raw reading becomes true.
 *
 * `nonzero` is the default because it is right for the largest family of MIB
 * objects — the plain alarm bit, where 0 means "nothing wrong" and any set bit
 * means something is. Everything else exists because a real MIB somewhere
 * inverts or enumerates that:
 *   nonzero   value != 0                     fgHwSensorEntAlarm-style alarm bit
 *   zero      value == 0                      "0 = failed" health registers
 *   equals    value ∈ values                  enum where specific codes are bad
 *   notEquals value ∉ values                  enum where ONE code is the good one
 *                                             (TruthValue: true when != 1)
 *   gte/lte   value >= / <= values[0]         thresholded status registers
 * Comparisons are numeric when both sides parse as numbers, and otherwise
 * case-insensitive string compares — the same probe definition then covers a
 * device that answers `2` and one that answers `"alarm"` for the same object.
 */
export const STATE_MAP_MODES = [
  "nonzero",
  "zero",
  "equals",
  "notEquals",
  "gte",
  "lte",
] as const;

type StateMapMode = (typeof STATE_MAP_MODES)[number];

/** Modes that read `values`; the others ignore it entirely. */
const STATE_MODES_NEEDING_VALUES: ReadonlySet<StateMapMode> = new Set<StateMapMode>([
  "equals",
  "notEquals",
  "gte",
  "lte",
]);

/** Modes that compare against exactly one value rather than a set. */
const SINGLE_VALUE_MODES: ReadonlySet<StateMapMode> = new Set<StateMapMode>(["gte", "lte"]);

const DEFAULT_TRUE_LABEL = "Alarm";
const DEFAULT_FALSE_LABEL = "OK";

/** Longest label we store — these render in a table cell and an alert subject. */
const STATE_LABEL_MAX = 32;
/** Cap on the comparison set. An enum needing more than this is really a gauge. */
const STATE_VALUES_MAX = 20;

export interface StateMap {
  mode: StateMapMode;
  /** Comparison operand(s) for the modes that take them; [] otherwise. */
  values: string[];
  /** What to call the true state ("Alarm", "Failed", "Present"). */
  trueLabel: string;
  /** What to call the false state ("OK", "Normal", "Absent"). */
  falseLabel: string;
  /**
   * Which polarity is the one an operator wants to hear about. Drives the
   * default the automation builder pre-selects and the colour the asset tab
   * paints the pill — NOT the mapping itself, so a probe whose interesting
   * state is the FALSE one ("link present") stays expressible without
   * contorting the mode.
   */
  trueIsProblem: boolean;
}

export const DEFAULT_STATE_MAP: StateMap = {
  mode: "nonzero",
  values: [],
  trueLabel: DEFAULT_TRUE_LABEL,
  falseLabel: DEFAULT_FALSE_LABEL,
  trueIsProblem: true,
};

function isStateMapMode(v: unknown): v is StateMapMode {
  return typeof v === "string" && (STATE_MAP_MODES as readonly string[]).includes(v);
}

function cleanLabel(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  return (s || fallback).slice(0, STATE_LABEL_MAX);
}

/**
 * Coerce a stored/posted state map into the canonical shape, filling defaults.
 * Never throws — an unreadable map degrades to "any non-zero value is the
 * problem", which is both the commonest real meaning and the safe direction:
 * the probe keeps reporting instead of silently producing no readings.
 * Use `validateStateMap` for the authoring path, where an operator typo should
 * be a 400 rather than a silent default.
 */
export function normalizeStateMap(raw: unknown): StateMap {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode: StateMapMode = isStateMapMode(o.mode) ? o.mode : DEFAULT_STATE_MAP.mode;
  const values = STATE_MODES_NEEDING_VALUES.has(mode)
    ? (Array.isArray(o.values) ? o.values : [])
        .filter((v) => typeof v === "string" || typeof v === "number")
        .map((v) => String(v).trim())
        .filter((v) => v !== "")
        .slice(0, SINGLE_VALUE_MODES.has(mode) ? 1 : STATE_VALUES_MAX)
    : [];
  return {
    mode,
    values,
    trueLabel: cleanLabel(o.trueLabel, DEFAULT_TRUE_LABEL),
    falseLabel: cleanLabel(o.falseLabel, DEFAULT_FALSE_LABEL),
    trueIsProblem: o.trueIsProblem === undefined ? true : !!o.trueIsProblem,
  };
}

/**
 * Authoring-time check. Returns a human-readable reason, or null when the map
 * is usable. The caller turns a reason into a 400 — a probe saved with an
 * empty comparison set would evaluate every reading to false and look healthy
 * forever, which is the one failure mode worth refusing outright.
 */
export function validateStateMap(raw: unknown): string | null {
  const o = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!o) return "State map must be an object";
  if (o.mode !== undefined && !isStateMapMode(o.mode)) {
    return `Invalid state mode — expected one of ${STATE_MAP_MODES.join(" | ")}`;
  }
  const map = normalizeStateMap(raw);
  if (STATE_MODES_NEEDING_VALUES.has(map.mode) && map.values.length === 0) {
    return `Mode "${map.mode}" needs at least one comparison value`;
  }
  if (SINGLE_VALUE_MODES.has(map.mode) && !Number.isFinite(Number(map.values[0]))) {
    return `Mode "${map.mode}" needs a numeric comparison value`;
  }
  if (map.trueLabel.toLowerCase() === map.falseLabel.toLowerCase()) {
    return "The two state labels must differ";
  }
  return null;
}

/** Numeric view of a raw reading, or null when it isn't number-shaped. */
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Compare one raw reading against one operand, numerically when both are
 *  numbers and case-insensitively as strings otherwise. */
function looseEquals(raw: unknown, operand: string): boolean {
  const rn = asNumber(raw);
  const on = asNumber(operand);
  if (rn !== null && on !== null) return rn === on;
  return String(raw ?? "").trim().toLowerCase() === operand.trim().toLowerCase();
}

/**
 * Evaluate one raw reading to 1 (true), 0 (false), or null.
 *
 * **null means "no reading", and that is load-bearing.** A sensor that is
 * absent, non-readable, or answers something the mode can't compare must not
 * come back as 0: 0 is a positive claim that the device is healthy, it would
 * clear an active alert, and on a probe whose interesting state is the false
 * one it would fire a brand-new alert about a sensor that isn't there. The
 * collector drops nulls, so the row simply stops being reported and the
 * engine's vanished-dimension sweep handles it.
 */
export function evaluateStateMap(raw: unknown, map: StateMap): 0 | 1 | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = asNumber(raw);
  switch (map.mode) {
    case "nonzero":
      return n === null ? null : n !== 0 ? 1 : 0;
    case "zero":
      return n === null ? null : n === 0 ? 1 : 0;
    case "equals":
      return map.values.some((v) => looseEquals(raw, v)) ? 1 : 0;
    case "notEquals":
      // An unmatched string against a numeric operand set is a real "not equal",
      // so this stays a 1 rather than a null — the operand set is the authority
      // on what the good state looks like.
      return map.values.some((v) => looseEquals(raw, v)) ? 0 : 1;
    case "gte": {
      const t = asNumber(map.values[0]);
      return n === null || t === null ? null : n >= t ? 1 : 0;
    }
    case "lte": {
      const t = asNumber(map.values[0]);
      return n === null || t === null ? null : n <= t ? 1 : 0;
    }
    default:
      return null;
  }
}

/** Operator-facing name for a 0/1 value. */
export function stateLabel(value: 0 | 1 | null, map: StateMap): string {
  if (value === null) return "—";
  return value === 1 ? map.trueLabel : map.falseLabel;
}

/**
 * Join a value walk with an optional label walk on the shared OID suffix.
 *
 * A status table is only useful if its rows are NAMEABLE: an alert that says
 * "row .14 is in Alarm" tells an operator nothing, and the index differs per
 * model so it can't be learned once. Vendors publish the name as a sibling
 * column of the same table (fgHwSensorEntName beside fgHwSensorEntAlarm), which
 * means the two walks share an index suffix and join on it.
 *
 * Falls back to the bare suffix when there's no label column or the row has no
 * label, so a probe still works — just less legibly — against a table with no
 * name column. Pure: the collector does the walking.
 */
export function joinStateRows(
  values: Map<string, unknown>,
  labels: Map<string, unknown> | null,
  map: StateMap,
): Array<{ rowKey: string; rowLabel: string; value: 0 | 1; raw: string }> {
  const out: Array<{ rowKey: string; rowLabel: string; value: 0 | 1; raw: string }> = [];
  for (const [suffix, raw] of values.entries()) {
    const v = evaluateStateMap(raw, map);
    if (v === null) continue;
    const rowKey = suffix || "";
    const rawLabel = labels?.get(suffix);
    const label = typeof rawLabel === "string" ? rawLabel.trim() : rawLabel != null ? String(rawLabel).trim() : "";
    out.push({
      rowKey,
      rowLabel: label || rowKey || "(single value)",
      value: v,
      raw: String(raw ?? ""),
    });
  }
  return out;
}
