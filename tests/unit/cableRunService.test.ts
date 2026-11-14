/**
 * tests/unit/cableRunService.test.ts — the pure half of cable runs (business
 * rule 184): point validation (WGS84 [lng, lat, z?], 2..max points, rounding),
 * the ground length, and the sync status an edit leaves behind. The writes are
 * pinned against a real database in tests/integration/cableRuns.test.ts.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const { normalizePoints, runLengthM, syncStatusAfterEdit, MAX_DRAWN_POINTS } =
  await import("../../src/services/cableRunService.js");

describe("normalizePoints", () => {
  it("keeps [lng, lat] and [lng, lat, z], rounding to ~1 cm and 1 mm", () => {
    expect(normalizePoints([[-85.123456789, 37.987654321], [-85.1, 38, 431.09049]]))
      .toEqual([[-85.1234568, 37.9876543], [-85.1, 38, 431.09]]);
  });

  it("refuses too few or too many points, a bad shape and out-of-range coordinates", () => {
    expect(() => normalizePoints([[-85, 38]])).toThrow(/at least two/);
    expect(() => normalizePoints("x")).toThrow(/list of points/);
    expect(() => normalizePoints(Array.from({ length: MAX_DRAWN_POINTS + 1 }, () => [-85, 38]))).toThrow(/at most/);
    expect(() => normalizePoints([[-85, 38], [-85]])).toThrow(/Point 2/);
    expect(() => normalizePoints([[-85, 38], ["a", 38]])).toThrow(/Point 2/);
    // A survey-grid value (state plane feet) is not a latitude / longitude.
    expect(() => normalizePoints([[1230486.35, 196527.88], [1230502.79, 196527.84]])).toThrow(/not a latitude/);
  });

  it("allows a larger cap for a surveyed run", () => {
    const many = Array.from({ length: MAX_DRAWN_POINTS + 5 }, (_, i) => [-85 + i * 1e-5, 38]);
    expect(normalizePoints(many, 5000)).toHaveLength(MAX_DRAWN_POINTS + 5);
  });
});

describe("runLengthM", () => {
  it("measures the ground distance in 2D, ignoring elevation", () => {
    // One thousandth of a degree of latitude ≈ 111.2 m.
    expect(runLengthM([[-85, 38], [-85, 38.001]])).toBeCloseTo(111.19, 1);
    expect(runLengthM([[-85, 38, 100], [-85, 38.001, 400]])).toBeCloseTo(111.19, 1);
    expect(runLengthM([[-85, 38], [-85, 38.001], [-85, 38.002]])).toBeCloseTo(222.39, 1);
  });
});

describe("syncStatusAfterEdit", () => {
  it("leaves a never-sent run off and resends anything else", () => {
    expect(syncStatusAfterEdit("off")).toBe("off");
    for (const s of ["pending", "synced", "failed"]) expect(syncStatusAfterEdit(s)).toBe("pending");
  });
});
