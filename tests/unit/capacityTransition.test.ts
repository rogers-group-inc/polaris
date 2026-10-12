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
  CAPACITY_ALERT_HOLD_DEFAULT_MINUTES,
  getCapacityAlertHoldMinutes,
  setCapacityAlertHoldMinutes,
  getCapacityTransitionState,
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

/** Set the alert hold (business rule 105). */
const hold = (minutes: number): void => {
  settings.set("capacity.alertHold", { key: "capacity.alertHold", value: { minutes } });
};

const stored = (): any => settings.get("capacity.lastSeverity")?.value;

beforeEach(() => {
  settings.clear();
  loggedEvents.length = 0;
});

describe("recordCapacityTransition — the verbs (hold 0)", () => {
  // These pin which action and level a transition writes, so they run with
  // the hold off; the hold has its own describe below.
  beforeEach(() => hold(0));

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

describe("recordCapacityTransition — the hold (business rule 105)", () => {
  const T0 = new Date("2026-10-12T12:00:00.000Z");
  const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

  it("a change shorter than the hold writes nothing — the blip is discarded", async () => {
    hold(30);
    priorSeverity("ok");
    await recordCapacityTransition(snapshot("warning"), at(0));
    await recordCapacityTransition(snapshot("warning"), at(10));
    expect(loggedEvents).toEqual([]);
    expect(stored().severity).toBe("ok");
    expect(stored().pending).toMatchObject({ severity: "warning", since: at(0).toISOString() });

    // One reading back at the recorded severity throws the pending change away.
    await recordCapacityTransition(snapshot("ok"), at(20));
    expect(loggedEvents).toEqual([]);
    expect(stored().pending).toBeUndefined();

    // ...so the next disagreement starts its hold from scratch.
    await recordCapacityTransition(snapshot("warning"), at(30));
    expect(loggedEvents).toEqual([]);
    expect(stored().pending.since).toBe(at(30).toISOString());
  });

  it("a change that holds for the full window is recorded once, saying how long it held", async () => {
    hold(30);
    priorSeverity("ok");
    for (const m of [0, 10, 20]) await recordCapacityTransition(snapshot("warning"), at(m));
    expect(loggedEvents).toEqual([]);
    await recordCapacityTransition(snapshot("warning", [
      { severity: "warning", code: "autovacuum_lag", message: "autovacuum is behind", family: "autovacuum" },
    ]), at(30));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].action).toBe(CAPACITY_CHANGED_ACTION);
    expect(loggedEvents[0].details).toMatchObject({ from: "ok", to: "warning", direction: "escalated", heldSec: 1800 });
    expect(loggedEvents[0].message).toBe("Capacity ok → warning (held 30 min): autovacuum is behind");
    expect(stored()).toMatchObject({ severity: "warning", recordedAt: at(30).toISOString() });
    expect(stored().pending).toBeUndefined();

    // Recorded now — further agreeing readings write nothing.
    await recordCapacityTransition(snapshot("warning"), at(40));
    expect(loggedEvents).toHaveLength(1);
  });

  it("readings need only disagree with the record, not with each other; the latest is written", async () => {
    hold(20);
    priorSeverity("ok");
    await recordCapacityTransition(snapshot("watch"), at(0));
    await recordCapacityTransition(snapshot("critical"), at(10));
    await recordCapacityTransition(snapshot("warning"), at(20));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].details).toMatchObject({ from: "ok", to: "warning", heldSec: 1200 });
  });

  it("a recovery waits out the hold too, so a flapping host cannot clear and re-raise", async () => {
    hold(20);
    priorSeverity("warning");
    await recordCapacityTransition(snapshot("ok"), at(0));
    await recordCapacityTransition(snapshot("warning"), at(10));
    expect(loggedEvents).toEqual([]);
    await recordCapacityTransition(snapshot("ok"), at(20));
    await recordCapacityTransition(snapshot("ok"), at(30));
    expect(loggedEvents).toEqual([]);
    await recordCapacityTransition(snapshot("ok"), at(40));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].action).toBe(CAPACITY_RECOVERED_ACTION);
    expect(loggedEvents[0].message).toBe("Capacity is back to OK (was warning) (held 20 min).");
  });

  it("a gap in the readings restarts the hold — nobody watched the condition across it", async () => {
    hold(30);
    priorSeverity("ok");
    await recordCapacityTransition(snapshot("warning"), at(0));
    // Polaris was down for two hours; the next reading is not evidence the
    // condition held in between.
    await recordCapacityTransition(snapshot("warning"), at(120));
    expect(loggedEvents).toEqual([]);
    expect(stored().pending.since).toBe(at(120).toISOString());
  });

  it("the first-ever reading is a baseline, recorded at once whatever the hold", async () => {
    hold(60);
    await recordCapacityTransition(snapshot("watch"), at(0));
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0].details).toMatchObject({ direction: "initial", heldSec: 0 });
  });

  it("defaults to 30 minutes, and the setter refuses what the route would", async () => {
    expect(await getCapacityAlertHoldMinutes()).toBe(CAPACITY_ALERT_HOLD_DEFAULT_MINUTES);
    expect(CAPACITY_ALERT_HOLD_DEFAULT_MINUTES).toBe(30);
    await setCapacityAlertHoldMinutes(45);
    expect(await getCapacityAlertHoldMinutes()).toBe(45);
    await expect(setCapacityAlertHoldMinutes(-1)).rejects.toThrow();
    await expect(setCapacityAlertHoldMinutes(2.5)).rejects.toThrow();
    // A corrupt stored value falls back to the default rather than to 0.
    settings.set("capacity.alertHold", { key: "capacity.alertHold", value: { minutes: "soon" } });
    expect(await getCapacityAlertHoldMinutes()).toBe(30);
  });

  it("the transition state names the record, the pending change and the hold", async () => {
    hold(30);
    priorSeverity("ok");
    await recordCapacityTransition(snapshot("warning"), at(0));
    const state = await getCapacityTransitionState();
    expect(state).toMatchObject({
      recorded: { severity: "ok" },
      pending: { severity: "warning", since: at(0).toISOString() },
      holdMinutes: 30,
      intervalMinutes: 10,
    });
  });
});
