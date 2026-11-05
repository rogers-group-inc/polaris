/**
 * tests/unit/sortByTime.test.ts — src/utils/sortByTime.ts
 *
 * The pasted comparator it replaced returned NaN on a missing timestamp, so a
 * history list with one bad entry sorted in an engine-defined order. These
 * pin: valid timestamps order exactly as before, mixed Date / ISO / epoch
 * inputs compare as instants, a bad or missing time sinks to the oldest end,
 * equal times keep their incoming order, and the sort is in place.
 */

import { describe, it, expect } from "vitest";
import { sortNewestFirst, sortOldestFirst } from "../../src/utils/sortByTime.js";

type Row = { id: string; lastSeen?: Date | string | number | null };

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("sortNewestFirst", () => {
  it("orders valid timestamps newest first, whatever form they arrive in", () => {
    const rows: Row[] = [
      { id: "a", lastSeen: "2026-11-01T00:00:00Z" },
      { id: "b", lastSeen: new Date("2026-11-03T00:00:00Z") },
      { id: "c", lastSeen: Date.parse("2026-11-02T00:00:00Z") },
    ];
    expect(ids(sortNewestFirst(rows, (r) => r.lastSeen))).toEqual(["b", "c", "a"]);
  });

  it("sinks a missing or invalid timestamp to the end", () => {
    const rows: Row[] = [
      { id: "missing" },
      { id: "old", lastSeen: "2026-01-01T00:00:00Z" },
      { id: "garbage", lastSeen: "not a date" },
      { id: "new", lastSeen: "2026-11-01T00:00:00Z" },
      { id: "null", lastSeen: null },
    ];
    expect(ids(sortNewestFirst(rows, (r) => r.lastSeen))).toEqual(["new", "old", "missing", "garbage", "null"]);
  });

  it("is stable for equal timestamps and sorts in place", () => {
    const t = "2026-11-05T10:00:00Z";
    const rows: Row[] = [{ id: "x", lastSeen: t }, { id: "y", lastSeen: new Date(t) }, { id: "z", lastSeen: t }];
    const out = sortNewestFirst(rows, (r) => r.lastSeen);
    expect(out).toBe(rows);
    expect(ids(rows)).toEqual(["x", "y", "z"]);
  });
});

describe("sortOldestFirst", () => {
  it("orders oldest first with a bad timestamp at the front (the oldest end)", () => {
    const rows: Row[] = [
      { id: "new", lastSeen: "2026-11-02T00:00:00Z" },
      { id: "bad", lastSeen: "nope" },
      { id: "old", lastSeen: "2026-11-01T00:00:00Z" },
    ];
    expect(ids(sortOldestFirst(rows, (r) => r.lastSeen))).toEqual(["bad", "old", "new"]);
  });
});
