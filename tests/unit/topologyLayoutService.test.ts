/**
 * tests/unit/topologyLayoutService.test.ts
 *
 * Pure validators of the shared topology-layout service — view-key grammar
 * and positions-blob sanitization. The DB-touching functions are covered by
 * tests/integration/topologyLayout.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  isValidViewKey,
  sanitizePositions,
  MAX_LAYOUT_NODES,
  MAX_VIEW_KEY_LEN,
} from "../../src/services/topologyLayoutService.js";
import { AppError } from "../../src/utils/errors.js";

describe("isValidViewKey", () => {
  it("accepts the flat view and computeFloorViews-style keys", () => {
    expect(isValidViewKey("flat")).toBe(true);
    expect(isValidViewKey("b|plant 4|mill")).toBe(true);
    expect(isValidViewKey("f|plant 4|mill|2nd floor")).toBe(true);
    // Arealess building view — computeFloorViews emits an empty area segment.
    expect(isValidViewKey("b||shop")).toBe(true);
    // Area view — the Base → area drill-down level.
    expect(isValidViewKey("a|pugmill")).toBe(true);
    // Room and junction-box views, a skipped level left empty.
    expect(isValidViewKey("r|mine|||north closet")).toBe(true);
    expect(isValidViewKey("jb||shop|||305")).toBe(true);
  });

  it("accepts saved-view keys (rule 147): topo, v:<uuid>, its floor views and its topo", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(isValidViewKey("topo")).toBe(true);
    expect(isValidViewKey(`v:${id}`)).toBe(true);
    expect(isValidViewKey(`v:${id}|topo`)).toBe(true);
    expect(isValidViewKey(`v:${id}|f|plant|mill|1`)).toBe(true);
    // A saved view has no "flat" of its own — its base IS v:<id>.
    expect(isValidViewKey(`v:${id}|flat`)).toBe(false);
    expect(isValidViewKey("v:not-a-uuid")).toBe(false);
    expect(isValidViewKey(`v:${id}|x|y`)).toBe(false);
  });

  it("rejects non-strings, empty, oversize, control chars, and foreign prefixes", () => {
    expect(isValidViewKey(undefined)).toBe(false);
    expect(isValidViewKey(42)).toBe(false);
    expect(isValidViewKey("")).toBe(false);
    expect(isValidViewKey("x|whatever")).toBe(false);
    expect(isValidViewKey("j|whatever")).toBe(false);
    expect(isValidViewKey("Flat")).toBe(false); // view keys are exact, not case-folded
    expect(isValidViewKey("b|a\nb")).toBe(false);
    expect(isValidViewKey("b|" + "x".repeat(MAX_VIEW_KEY_LEN))).toBe(false);
  });
});

describe("sanitizePositions", () => {
  it("round-trips a valid blob", () => {
    const blob = { "node-1": { x: 130, y: 95 }, "node-2": { x: -260, y: 0 } };
    expect(sanitizePositions(blob)).toEqual(blob);
  });

  it("drops extraneous properties on entries", () => {
    const out = sanitizePositions({ n: { x: 1, y: 2, z: 3, note: "hi" } });
    expect(out).toEqual({ n: { x: 1, y: 2 } });
  });

  it("rejects non-object roots", () => {
    for (const bad of [null, [], "positions", 7]) {
      expect(() => sanitizePositions(bad)).toThrow(AppError);
    }
  });

  it("rejects malformed entries (missing / non-finite / non-numeric coords)", () => {
    expect(() => sanitizePositions({ n: null })).toThrow(AppError);
    expect(() => sanitizePositions({ n: { x: 1 } })).toThrow(AppError);
    expect(() => sanitizePositions({ n: { x: "1", y: 2 } })).toThrow(AppError);
    expect(() => sanitizePositions({ n: { x: Number.NaN, y: 2 } })).toThrow(AppError);
    expect(() => sanitizePositions({ n: { x: Infinity, y: 2 } })).toThrow(AppError);
  });

  it("rejects out-of-range coordinates and oversize blobs", () => {
    expect(() => sanitizePositions({ n: { x: 1e8, y: 0 } })).toThrow(AppError);
    const big: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i <= MAX_LAYOUT_NODES; i++) big[`n${i}`] = { x: 0, y: 0 };
    expect(() => sanitizePositions(big)).toThrow(AppError);
  });

  it("carries a 400 httpStatus on every rejection", () => {
    try {
      sanitizePositions({ n: { x: Number.NaN, y: 0 } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).httpStatus).toBe(400);
    }
  });
});
