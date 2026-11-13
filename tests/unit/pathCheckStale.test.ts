/**
 * tests/unit/pathCheckStale.test.ts — business rule 85(a): when a path-check
 * source's latest result is history (the host is offline, or no run has landed
 * for three intervals plus the grace).
 */

import { describe, it, expect } from "vitest";
import {
  pathResultStaleCutoff,
  pathResultStaleReason,
  STALE_AFTER_INTERVALS,
  STALE_GRACE_MS,
} from "../../src/utils/pathCheckStale.js";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

describe("pathResultStaleCutoff", () => {
  it("is three intervals plus the grace before now", () => {
    expect(pathResultStaleCutoff(300, NOW).getTime()).toBe(NOW - (STALE_AFTER_INTERVALS * 300_000 + STALE_GRACE_MS));
  });
  it("treats a missing or nonsensical interval as one minute", () => {
    expect(pathResultStaleCutoff(0, NOW).getTime()).toBe(pathResultStaleCutoff(60, NOW).getTime());
    expect(pathResultStaleCutoff(Number.NaN, NOW).getTime()).toBe(pathResultStaleCutoff(60, NOW).getTime());
  });
});

describe("pathResultStaleReason", () => {
  const ago = (ms: number) => new Date(NOW - ms);
  it("says nothing when there is no result yet, even for an offline host", () => {
    expect(pathResultStaleReason({ lastSampleAt: null, online: false }, 60, NOW)).toBeNull();
  });
  it("calls an offline host's result stale however recent it is", () => {
    expect(pathResultStaleReason({ lastSampleAt: ago(5_000), online: false }, 60, NOW)).toBe("offline");
  });
  it("keeps a recent result from an online host current", () => {
    expect(pathResultStaleReason({ lastSampleAt: ago(4 * 60_000), online: true }, 60, NOW)).toBeNull();
  });
  it("calls a result older than three intervals plus the grace late", () => {
    expect(pathResultStaleReason({ lastSampleAt: ago(5 * 60_000 + 1), online: true }, 60, NOW)).toBe("late");
  });
  it("scales with the check's interval", () => {
    expect(pathResultStaleReason({ lastSampleAt: ago(20 * 60_000), online: true }, 600, NOW)).toBeNull();
    expect(pathResultStaleReason({ lastSampleAt: ago(33 * 60_000), online: true }, 600, NOW)).toBe("late");
  });
  it("accepts an ISO string, as the browser payload carries it", () => {
    expect(pathResultStaleReason({ lastSampleAt: ago(60 * 60_000).toISOString(), online: true }, 60, NOW)).toBe("late");
  });
});
