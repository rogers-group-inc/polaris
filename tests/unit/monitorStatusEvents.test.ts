/**
 * tests/unit/monitorStatusEvents.test.ts
 *
 * Which monitor transitions write a `monitor.status_changed` Event. Only up ↔
 * down: a missed poll (→warning) and the answer after it are not audit events,
 * and the climb back out of `down` neither writes a second down on one miss nor
 * hides the up that ends the outage.
 */

import { describe, it, expect } from "vitest";
import { statusEventDecision, statusEventPairs, type MonitorStatus } from "../../src/utils/monitorStatus.js";

/** Replays a status sequence the way recordProbeResult + logStatusEventIfPaired do. */
function eventsFor(seq: MonitorStatus[]): string[] {
  const written: string[] = [];
  let last: string | undefined;
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1];
    const next = seq[i];
    const d = statusEventDecision(prev, next);
    if (d === "skip") continue;
    if (d === "log" || statusEventPairs(last, next as "up" | "down")) {
      written.push(`${prev}->${next}`);
      last = next;
    }
  }
  return written;
}

describe("statusEventDecision", () => {
  it("never logs a missed poll or its recovery", () => {
    expect(statusEventDecision("up", "warning")).toBe("skip");
    expect(statusEventDecision("warning", "recovering")).toBe("skip");
    expect(statusEventDecision("down", "recovering")).toBe("skip");
  });

  it("logs the unambiguous up/down edges directly", () => {
    expect(statusEventDecision("up", "down")).toBe("log");
    expect(statusEventDecision("unknown", "down")).toBe("log");
    expect(statusEventDecision("down", "up")).toBe("log");
  });

  it("defers edges out of recovering / warning to the last status Event", () => {
    expect(statusEventDecision("warning", "up")).toBe("if-paired");
    expect(statusEventDecision("recovering", "up")).toBe("if-paired");
    expect(statusEventDecision("warning", "down")).toBe("if-paired");
    expect(statusEventDecision("recovering", "down")).toBe("if-paired");
  });

  it("skips the first measurement, same-state polls and the passive edge", () => {
    expect(statusEventDecision("unknown", "up")).toBe("skip");
    expect(statusEventDecision("up", "up")).toBe("skip");
    expect(statusEventDecision("down", "down")).toBe("skip");
    expect(statusEventDecision("passive", "down")).toBe("skip");
    expect(statusEventDecision("up", "passive")).toBe("skip");
  });
});

describe("statusEventPairs", () => {
  it("an up pairs only with a down on record", () => {
    expect(statusEventPairs("down", "up")).toBe(true);
    expect(statusEventPairs("up", "up")).toBe(false);
    expect(statusEventPairs("warning", "up")).toBe(false);
    expect(statusEventPairs(undefined, "up")).toBe(false);
  });

  it("a down pairs with anything but a down", () => {
    expect(statusEventPairs("up", "down")).toBe(true);
    expect(statusEventPairs(undefined, "down")).toBe(true);
    expect(statusEventPairs("down", "down")).toBe(false);
  });
});

describe("replayed sequences", () => {
  it("a device that misses every other poll writes nothing", () => {
    expect(eventsFor(["up", "warning", "up", "warning", "up", "warning", "up"])).toEqual([]);
  });

  it("a real outage writes one down and one up, however it climbs back", () => {
    expect(eventsFor(["up", "warning", "warning", "down", "down", "recovering", "recovering", "up"]))
      .toEqual(["warning->down", "recovering->up"]);
  });

  it("one miss during the climb back out of down is not a second outage", () => {
    expect(eventsFor(["up", "down", "recovering", "down", "recovering", "recovering", "up"]))
      .toEqual(["up->down", "recovering->up"]);
  });

  it("a second outage after a full recovery is logged again", () => {
    expect(eventsFor(["up", "down", "up", "warning", "up", "down", "recovering", "up"]))
      .toEqual(["up->down", "down->up", "up->down", "recovering->up"]);
  });
});
