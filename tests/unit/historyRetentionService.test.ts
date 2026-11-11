/**
 * tests/unit/historyRetentionService.test.ts — business rule 158, the parts
 * that need no database: what counts as a valid alert-history period, and the
 * exact predicate for a rule-state row that is safe to delete.
 *
 * The prunes themselves run against PostgreSQL in
 * tests/integration/historyRetention.test.ts.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/assetSightingService.js", () => ({ getSightingSettings: vi.fn() }));

import {
  normalizeAlertHistoryDays,
  idleRuleStateWhere,
  DEFAULT_ALERT_HISTORY_DAYS,
  MIN_ALERT_HISTORY_DAYS,
  MAX_ALERT_HISTORY_DAYS,
} from "../../src/services/historyRetentionService.js";

describe("normalizeAlertHistoryDays", () => {
  it("accepts 0 (keep forever) and anything from the minimum to the maximum", () => {
    expect(normalizeAlertHistoryDays(0)).toBe(0);
    expect(normalizeAlertHistoryDays(MIN_ALERT_HISTORY_DAYS)).toBe(MIN_ALERT_HISTORY_DAYS);
    expect(normalizeAlertHistoryDays(DEFAULT_ALERT_HISTORY_DAYS)).toBe(365);
    expect(normalizeAlertHistoryDays(MAX_ALERT_HISTORY_DAYS)).toBe(MAX_ALERT_HISTORY_DAYS);
    expect(normalizeAlertHistoryDays("90")).toBe(90);
  });

  it("refuses a period too short to answer 'what happened last month', and nonsense", () => {
    expect(normalizeAlertHistoryDays(1)).toBeNull();
    expect(normalizeAlertHistoryDays(MIN_ALERT_HISTORY_DAYS - 1)).toBeNull();
    expect(normalizeAlertHistoryDays(MAX_ALERT_HISTORY_DAYS + 1)).toBeNull();
    expect(normalizeAlertHistoryDays(-5)).toBeNull();
    expect(normalizeAlertHistoryDays(45.5)).toBeNull();
    expect(normalizeAlertHistoryDays("soon")).toBeNull();
  });

  it("never reads a blank field as 'keep forever'", () => {
    // A cleared number input is NaN in the browser, null on the wire, and
    // Number(null) is 0 — which is the one value that turns pruning OFF.
    expect(normalizeAlertHistoryDays(null)).toBeNull();
    expect(normalizeAlertHistoryDays(undefined)).toBeNull();
    expect(normalizeAlertHistoryDays("")).toBeNull();
    expect(normalizeAlertHistoryDays("   ")).toBeNull();
    expect(normalizeAlertHistoryDays(NaN)).toBeNull();
    expect(normalizeAlertHistoryDays(true)).toBeNull();
    expect(normalizeAlertHistoryDays([])).toBeNull();
  });
});

describe("idleRuleStateWhere — a row indistinguishable from no row", () => {
  const cutoff = new Date("2026-11-04T00:00:00Z");
  const where = idleRuleStateWhere(cutoff) as Record<string, unknown>;

  it("requires every arm: clear, no alert, no timers, no half-counted run, no band bookkeeping, and idle", () => {
    // Dropping any one of these would delete a row the engine is still
    // counting on — a pending hold, a recovery timer, a live alert's link.
    expect(Object.keys(where).sort()).toEqual([
      "bandMetSince", "clearRun", "conditionMetSince", "firingSeverity", "metRun",
      "notificationId", "recoveredSince", "state", "updatedAt",
    ]);
    expect(where.state).toBe("clear");
    expect(where.notificationId).toBeNull();
    expect(where.conditionMetSince).toBeNull();
    expect(where.recoveredSince).toBeNull();
    expect(where.firingSeverity).toBeNull();
    expect(where.metRun).toBe(0);
    expect(where.clearRun).toBe(0);
    expect(where.updatedAt).toEqual({ lt: cutoff });
  });
});
