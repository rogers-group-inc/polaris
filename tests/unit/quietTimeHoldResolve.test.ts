/**
 * tests/unit/quietTimeHoldResolve.test.ts
 *
 * The precedence inside `resolveQuietHold` (business rule 92), read straight
 * off a mocked catalog: an automation with no setting is held by a matching
 * global schedule; one that says "Ignore Global Quiet Time"
 * (`quietTime = {ignoreGlobal: true}`) is never quiet, whatever the global
 * schedules say; one with its own policy is judged by that policy alone — held
 * inside its own window, free outside it even while a global window is open.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  schedules: [] as any[],
  rules: [] as any[],
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    quietTimeSchedule: { findMany: vi.fn(async () => db.schedules) },
    notificationRule: { findMany: vi.fn(async () => db.rules) },
    asset: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
  },
}));
vi.mock("../../src/services/scopeRelationIndex.js", () => ({
  decorateRelationLeafHits: vi.fn(async () => {}),
}));

import { resolveQuietHold, bumpQuietTimeCache } from "../../src/services/quietTimeHoldService.js";

const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] };
const LUNCH = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "12:00", endTime: "13:00" }] };
const NIGHT = new Date(2026, 9, 3, 23, 0, 0, 0);
const NOON = new Date(2026, 9, 3, 12, 30, 0, 0);

beforeEach(() => {
  bumpQuietTimeCache();
  db.schedules = [{ id: "g1", name: "Nights", scope: {}, quiet: { windows: [NIGHTLY] }, createdAt: new Date(2026, 0, 1) }];
  db.rules = [
    { id: "r-ignore", name: "Core down", quietTime: { ignoreGlobal: true } },
    { id: "r-own", name: "Lunch-quiet", quietTime: { windows: [LUNCH] } },
    { id: "r-bad", name: "Hand-edited", quietTime: { windows: "tonight" } },
  ];
});

describe("resolveQuietHold precedence", () => {
  it("holds an automation with no setting of its own by the matching global schedule", async () => {
    const hold = await resolveQuietHold({ ruleId: "r-plain", severity: "warning", metric: "cpuPct", assetId: "a1", now: NIGHT });
    expect(hold?.source).toEqual({ kind: "global", id: "g1", name: "Nights" });
    expect(hold?.windowEnd).toEqual(new Date(2026, 9, 4, 6, 0, 0, 0));
  });

  it("never holds an automation that ignores the global quiet times", async () => {
    expect(await resolveQuietHold({ ruleId: "r-ignore", severity: "warning", metric: "cpuPct", assetId: "a1", now: NIGHT })).toBeNull();
    expect(await resolveQuietHold({ ruleId: "r-ignore", severity: "critical", metric: "cpuPct", assetId: "a1", now: NIGHT, send: "reminder" })).toBeNull();
  });

  it("answers per kind of send from the policy's per-severity map", async () => {
    db.rules.push({ id: "r-tree", name: "Tree", quietTime: { windows: [NIGHTLY], held: {
      warning: { alerts: true, alertReminders: true, escalations: false, escalationReminders: false },
    } } });
    bumpQuietTimeCache();
    const ask = (send: "fire" | "reminder" | "escalation" | "escalationReminder", severity = "warning") =>
      resolveQuietHold({ ruleId: "r-tree", severity, metric: "cpuPct", assetId: "a1", now: NIGHT, send });
    expect((await ask("fire"))?.source.id).toBe("r-tree");
    expect((await ask("reminder"))?.source.id).toBe("r-tree");
    expect(await ask("escalation")).toBeNull();
    expect(await ask("escalationReminder")).toBeNull();
    // A severity with no entry is not held — and the global schedule does not
    // step in, because the automation has a quiet time of its own.
    expect(await ask("fire", "critical")).toBeNull();
  });

  it("judges an automation with its own policy by that policy alone", async () => {
    // 23:00: the global night window is open, the automation's lunch window is not.
    expect(await resolveQuietHold({ ruleId: "r-own", severity: "warning", metric: "cpuPct", assetId: "a1", now: NIGHT })).toBeNull();
    const hold = await resolveQuietHold({ ruleId: "r-own", severity: "warning", metric: "cpuPct", assetId: "a1", now: NOON });
    expect(hold?.source).toEqual({ kind: "automation", id: "r-own", name: "Lunch-quiet" });
    expect(hold?.windowEnd).toEqual(new Date(2026, 9, 3, 13, 0, 0, 0));
  });

  it("treats an unreadable own policy as no setting — the global schedules apply", async () => {
    const hold = await resolveQuietHold({ ruleId: "r-bad", severity: "warning", metric: "cpuPct", assetId: "a1", now: NIGHT });
    expect(hold?.source.kind).toBe("global");
  });

  it("a rule-less alert is never quiet", async () => {
    expect(await resolveQuietHold({ ruleId: null, severity: "warning", metric: "cpuPct", assetId: "a1", now: NIGHT })).toBeNull();
  });
});
