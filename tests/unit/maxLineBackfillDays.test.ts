import { describe, it, expect } from "vitest";
import { maxLineBackfillDays, MAX_LINE_BACKFILL_CAP_DAYS } from "../../src/services/sampleRollupService.js";

const DAY = 86_400_000;
// Fixed reference instant so the test is deterministic (no Date.now()).
const NOW = Date.UTC(2026, 10, 6, 15, 30, 0); // 2026-11-06T15:30:00Z
const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 10));

describe("maxLineBackfillDays", () => {
  it("defaults (7d detail, 7d compress-after) rebuild the days after now - 6d, today included", () => {
    const days = maxLineBackfillDays(NOW, [7, 7], [7, 7, 7, 7]);
    // now - 6d = 2026-10-31T15:30 → first UTC midnight after it is 11-01.
    expect(iso(days)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    for (const d of days) {
      expect(d.getTime() % DAY).toBe(0);
      expect(d.getTime()).toBeGreaterThanOrEqual(NOW - 6 * DAY);
    }
  });

  it("is bounded by the smallest of detail retention and every compress-after window", () => {
    expect(maxLineBackfillDays(NOW, [3, 7], [7, 7, 7, 7])).toHaveLength(2);   // 3-1 = 2 days back
    expect(maxLineBackfillDays(NOW, [7, 7], [7, 4, 7, 7])).toHaveLength(3);   // 4-1 = 3
  });

  it("treats compression off (0) and FOREVER detail as unbounded, up to the cap", () => {
    const days = maxLineBackfillDays(NOW, [-1, -1], [0, 0, 0, 0]);
    expect(days[0].getTime()).toBeGreaterThanOrEqual(NOW - (MAX_LINE_BACKFILL_CAP_DAYS - 1) * DAY);
    expect(days).toHaveLength(MAX_LINE_BACKFILL_CAP_DAYS - 1);
  });

  it("ignores a stream whose detail tier is off, and is empty when none keeps detail", () => {
    expect(maxLineBackfillDays(NOW, [0, 5], [7, 7, 7, 7])).toHaveLength(4);
    expect(maxLineBackfillDays(NOW, [0, 0], [7, 7, 7, 7])).toEqual([]);
  });

  it("is empty when the window is a day or less", () => {
    expect(maxLineBackfillDays(NOW, [1, 7], [7, 7, 7, 7])).toEqual([]);
    expect(maxLineBackfillDays(NOW, [7, 7], [1, 7, 7, 7])).toEqual([]);
  });

  it("starts a full day after the newest already-compressed chunk", () => {
    const compressedThrough = Date.UTC(2026, 10, 3, 0, 0, 0); // chunk ends 11-03 00:00
    // +1 day margin → 11-04 00:00, already a midnight.
    expect(iso(maxLineBackfillDays(NOW, [7, 7], [7, 7, 7, 7], compressedThrough)))
      .toEqual(["2026-11-04", "2026-11-05", "2026-11-06"]);
    // A compressed chunk older than the window changes nothing.
    expect(maxLineBackfillDays(NOW, [7, 7], [7, 7, 7, 7], NOW - 20 * DAY)).toHaveLength(6);
  });

  it("an exact-midnight now still includes today's slice", () => {
    const midnight = Date.UTC(2026, 10, 6);
    const days = iso(maxLineBackfillDays(midnight, [7, 7], [7, 7, 7, 7]));
    expect(days[0]).toBe("2026-10-31");
    expect(days[days.length - 1]).toBe("2026-11-06");
  });
});
