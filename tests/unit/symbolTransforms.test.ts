/**
 * tests/unit/symbolTransforms.test.ts — the unit conversions a profile row can
 * name, and the "no data" contract every one of them has to honour.
 *
 * These sit between a raw SNMP varbind and a stored sample, so a wrong one is
 * a chart that is confidently wrong rather than obviously broken — a MikroTik
 * sensor reading 315 °C instead of 31.5 is the case that prompted this file.
 * The registry/label/apply trio is pinned together because a kind added to one
 * and not the others is either unreachable from the UI or a runtime no-op.
 */

import { describe, it, expect } from "vitest";
import {
  TRANSFORM_KINDS, TRANSFORM_LABELS, applyTransform, isTransformKind,
  COMBINER_KINDS, COMBINER_LABELS, applyCombiner,
  METRIC_ROW_TRANSFORMS, metricRowTransforms,
} from "../../src/utils/symbolTransforms.js";

describe("metricRowTransforms — what a metric row may carry", () => {
  it("offers tenths_to_units on a scalar temperature row", () => {
    expect(metricRowTransforms("temperature", "scalar")).toEqual(["tenths_to_units"]);
  });

  it("offers nothing on a table or double-scalar row, whatever the metric", () => {
    // A table walk and a double-scalar pair never pass through a unary transform.
    expect(metricRowTransforms("temperature", "table")).toEqual([]);
    expect(metricRowTransforms("temperature", "double_scalar")).toEqual([]);
  });

  it("offers nothing on a metric whose collector applies no transform", () => {
    // The 2026-09-16 failure: these accepted the whole list and applied none.
    for (const key of ["cpu", "memory", "storage", "model", "interfaces"]) {
      expect(metricRowTransforms(key, "scalar")).toEqual([]);
    }
  });

  it("names only registered kinds", () => {
    for (const kinds of Object.values(METRIC_ROW_TRANSFORMS)) {
      for (const k of kinds) expect(isTransformKind(k)).toBe(true);
    }
  });
});

describe("the registry is internally consistent", () => {
  it("every kind has a label, and every label a kind", () => {
    // A kind with no label renders blank in the profile dropdown; a label with
    // no kind is an option that fails validation on save.
    expect(Object.keys(TRANSFORM_LABELS).sort()).toEqual([...TRANSFORM_KINDS].sort());
    expect(Object.keys(COMBINER_LABELS).sort()).toEqual([...COMBINER_KINDS].sort());
  });

  it("every kind actually changes something, or is deliberately identity", () => {
    // Guards the switch in applyTransform: a kind added to the list but not to
    // the switch falls through `default:` and silently does nothing.
    const identity = new Set(["signed_to_unsigned"]); // identity for positive input
    for (const kind of TRANSFORM_KINDS) {
      const out = applyTransform(64, kind);
      if (identity.has(kind)) continue;
      expect(out, `${kind} left 64 unchanged — missing from the switch?`).not.toBe(64);
    }
  });

  it("recognises its own kinds and nothing else", () => {
    for (const k of TRANSFORM_KINDS) expect(isTransformKind(k)).toBe(true);
    expect(isTransformKind("divide_by_seven")).toBe(false);
    expect(isTransformKind(null)).toBe(false);
  });
});

describe("no-data flows through as no-data", () => {
  it("never coerces null, undefined or a non-finite reading to a number", () => {
    // An upstream "the device did not answer" must not become 0, which would
    // chart as a real reading of zero.
    for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(applyTransform(v as any, "tenths_to_units")).toBeNull();
    }
  });

  it("passes a value through untouched when no transform is named", () => {
    expect(applyTransform(42, null)).toBe(42);
    expect(applyTransform(42, undefined)).toBe(42);
  });

  it("keeps a legitimate zero", () => {
    expect(applyTransform(0, "tenths_to_units")).toBe(0);
  });
});

describe("the conversions", () => {
  it("tenths_to_units reads a DISPLAY-HINT d-1 integer as one decimal place", () => {
    // MIKROTIK-MIB's Temperature / Power / Voltage textual conventions are all
    // "d-1": the raw integer carries one implied decimal.
    expect(applyTransform(315, "tenths_to_units")).toBe(31.5);
    expect(applyTransform(-55, "tenths_to_units")).toBe(-5.5);
  });

  it("has no Celsius↔Fahrenheit transform — temperature converts at render only", () => {
    // Polaris stores and alerts in Celsius; converting before storage would
    // re-point every temperature automation's threshold.
    expect(isTransformKind("celsius_to_fahrenheit")).toBe(false);
    expect(isTransformKind("fahrenheit_to_celsius")).toBe(false);
    expect(applyTransform(100, "celsius_to_fahrenheit" as any)).toBe(100);
  });

  it("converts bytes on binary multiples, not decimal ones", () => {
    expect(applyTransform(1024 * 1024, "bytes_to_mb")).toBe(1);
    expect(applyTransform(1024 ** 3, "bytes_to_gb")).toBe(1);
    expect(applyTransform(1, "mb_to_bytes")).toBe(1024 * 1024);
  });

  it("reads TimeTicks as hundredths of a second", () => {
    expect(applyTransform(360000, "ticks_to_seconds")).toBe(3600);
  });

  it("converts between ratio and percent", () => {
    expect(applyTransform(0.5, "ratio_to_percent")).toBe(50);
    expect(applyTransform(50, "percent_to_ratio")).toBe(0.5);
  });

  it("shifts a negative Int32 into unsigned space and leaves a positive alone", () => {
    // SNMP counters that overflowed Int32 arrive negative from some agents.
    expect(applyTransform(-1, "signed_to_unsigned")).toBe(2 ** 32 - 1);
    expect(applyTransform(7, "signed_to_unsigned")).toBe(7);
  });
});

describe("combiners", () => {
  it("compute the percent forms a double_scalar memory row describes", () => {
    expect(applyCombiner(25, 100, "a_over_b_as_percent")).toBe(25);
    expect(applyCombiner(25, 75, "a_over_a_plus_b_as_percent")).toBe(25);
    expect(applyCombiner(25, 100, "b_minus_a_over_b_as_percent")).toBe(75);
  });

  it("compute the arithmetic forms", () => {
    expect(applyCombiner(10, 4, "a_minus_b")).toBe(6);
    expect(applyCombiner(10, 4, "a_plus_b")).toBe(14);
    expect(applyCombiner(10, 4, "a_over_b_ratio")).toBe(2.5);
  });

  it("refuse to divide by zero rather than emitting Infinity", () => {
    // Infinity survives JSON round-trips as null and charts as a gap; a
    // deliberate null says "no reading" in the same breath.
    for (const kind of ["a_over_b_as_percent", "b_minus_a_over_b_as_percent", "a_over_b_ratio"] as const) {
      expect(applyCombiner(1, 0, kind), kind).toBeNull();
    }
    expect(applyCombiner(0, 0, "a_over_a_plus_b_as_percent")).toBeNull();
  });

  it("pass no-data through", () => {
    expect(applyCombiner(null, 10, "a_over_b_as_percent")).toBeNull();
    expect(applyCombiner(10, null, "a_over_b_as_percent")).toBeNull();
  });
});
