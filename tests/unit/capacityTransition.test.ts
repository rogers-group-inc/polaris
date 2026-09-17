/**
 * tests/unit/capacityTransition.test.ts — which audit action a capacity
 * severity transition writes.
 *
 * The verb is load-bearing, not cosmetic. The baseline "Capacity severity
 * escalated" automation triggers on `capacity.severity_changed` and RESETS on
 * `capacity.severity_recovered`, and an event-mode reset matches on the action
 * pattern alone — no details. So the two directions must stay two actions: one
 * verb for both would have the rule's reset match its own escalation and clear
 * the alert the instant it fired, which is why that rule shipped on a 24-hour
 * timer until the split existed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = new Map<string, { key: string; value: unknown }>();
const loggedEvents: any[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
    setting: {
      findUnique: vi.fn(async ({ where }: any) => settings.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create }: any) => {
        settings.set(where.key, { key: where.key, value: create.value });
        return create;
      }),
    },
  },
  getDirectStatsPool: () => null,
}));

vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => { loggedEvents.push(e); }),
}));

import {
  recordCapacityTransition,
  CAPACITY_CHANGED_ACTION,
  CAPACITY_RECOVERED_ACTION,
  type Severity,
} from "../../src/services/capacityService.js";

/** The slice of a snapshot the transition recorder actually reads. */
const snapshot = (severity: Severity, reasons: any[] = []): any => ({
  severity,
  reasons,
  appHost: { volumes: [{ paths: ["/"], roles: ["app"], freeBytes: 50, totalBytes: 100 }] },
});

/** Seed the stored severity the recorder compares against. */
const priorSeverity = (severity: Severity): void => {
  settings.set("capacity.lastSeverity", {
    key: "capacity.lastSeverity",
    value: { severity, recordedAt: "2026-01-01T00:00:00.000Z" },
  });
};

beforeEach(() => {
  settings.clear();
  loggedEvents.length = 0;
});

describe("recordCapacityTransition", () => {
  it("an escalation writes the changed verb at the severity's level", async () => {
    priorSeverity("ok");
    await recordCapacityTransition(snapshot("critical", [
      { severity: "critical", code: "disk_low", message: "/ is 4% free", family: "disk" },
    ]));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].action).toBe(CAPACITY_CHANGED_ACTION);
    expect(loggedEvents[0].level).toBe("error");
    expect(loggedEvents[0].details).toMatchObject({ from: "ok", to: "critical", direction: "escalated" });
    expect(loggedEvents[0].message).toContain("/ is 4% free");
  });

  it("a landing on ok writes the all-clear verb — the automation's reset", async () => {
    priorSeverity("critical");
    await recordCapacityTransition(snapshot("ok"));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].action).toBe(CAPACITY_RECOVERED_ACTION);
    expect(loggedEvents[0].level).toBe("info");
    expect(loggedEvents[0].details).toMatchObject({ from: "critical", to: "ok", direction: "recovered" });
    expect(loggedEvents[0].message).toBe("Capacity is back to OK (was critical).");
  });

  it("a PARTIAL recovery keeps the changed verb, so a still-degraded host stays alerting", async () => {
    // critical → warning is progress, not an all-clear. If this wrote the
    // recovery verb the alert would clear while the disk was still filling.
    priorSeverity("critical");
    await recordCapacityTransition(snapshot("warning"));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].action).toBe(CAPACITY_CHANGED_ACTION);
    expect(loggedEvents[0].details).toMatchObject({ direction: "recovered", to: "warning" });
  });

  it("the two verbs are distinct — a shared one would make the rule clear itself", () => {
    expect(CAPACITY_RECOVERED_ACTION).not.toBe(CAPACITY_CHANGED_ACTION);
  });

  it("the first-ever snapshot establishes a baseline under the changed verb", async () => {
    await recordCapacityTransition(snapshot("watch"));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].action).toBe(CAPACITY_CHANGED_ACTION);
    expect(loggedEvents[0].details).toMatchObject({ from: null, direction: "initial" });
    expect(loggedEvents[0].message).toContain("baseline");
  });

  it("no transition, no event — and the stored severity is what the next call compares against", async () => {
    priorSeverity("warning");
    await recordCapacityTransition(snapshot("warning"));
    expect(loggedEvents).toEqual([]);
    // The escalation that follows reads the stored value, not the one it skipped.
    await recordCapacityTransition(snapshot("critical"));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].details).toMatchObject({ from: "warning", to: "critical" });
  });

  it("both verbs name the install itself, so the reset finds the alert's subject", async () => {
    // The event reset is scoped to the SAME subject the alert is about, and a
    // system-scoped Event with no resourceName resolves to the Polaris-self
    // label on both sides (src/utils/alertSubject.ts). A resourceName on one
    // of them and not the other would silently stop the pair matching.
    priorSeverity("ok");
    await recordCapacityTransition(snapshot("warning"));
    priorSeverity("warning");
    await recordCapacityTransition(snapshot("ok"));
    expect(loggedEvents).toHaveLength(2);
    for (const ev of loggedEvents) {
      expect(ev.resourceType).toBe("system");
      expect(ev.resourceName).toBeUndefined();
    }
  });
});
