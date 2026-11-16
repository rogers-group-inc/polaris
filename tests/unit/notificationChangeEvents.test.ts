/**
 * tests/unit/notificationChangeEvents.test.ts — the bridge from the
 * current-state persist functions to the engine's event path (CQ-T010).
 *
 * Contract: ZERO cost when no `change` rule subscribes (no Event writes), one
 * Event per change item otherwise, resourceType "asset" + resourceId so the
 * engine resolves the asset and its region, and never a throw into a scrape.
 * wirelessRoamEventsWanted is pinned in wirelessRoamEventsGate.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { subscribed } = vi.hoisted(() => ({ subscribed: vi.fn() }));
vi.mock("../../src/services/notificationRuleService.js", () => ({ isChangeActionSubscribed: subscribed }));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { maybeEmitChangeEvents } from "../../src/services/notificationChangeEvents.js";

const ACTION = "change.lldp_neighbor";

beforeEach(() => {
  resetEventLogStub();
  subscribed.mockReset();
  subscribed.mockResolvedValue(true);
});

const batch = () => eventLog.logEventsBatch.mock.calls[0]![0];

describe("maybeEmitChangeEvents", () => {
  it("an empty diff asks nothing and writes nothing", async () => {
    await maybeEmitChangeEvents(ACTION, "a1", "sw-01", []);
    expect(subscribed).not.toHaveBeenCalled();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("no subscribing rule → no Event writes (the common case)", async () => {
    subscribed.mockResolvedValue(false);
    await maybeEmitChangeEvents(ACTION, "a1", "sw-01", [{ label: "port1" }]);
    expect(subscribed).toHaveBeenCalledWith(ACTION);
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("subscribed → one batched Event per item, in order, against the asset", async () => {
    await maybeEmitChangeEvents(ACTION, "a1", "sw-01", [
      { label: "port1", details: { neighbor: "sw-02" } },
      { label: "port2" },
    ]);
    expect(eventLog.logEventsBatch).toHaveBeenCalledTimes(1);
    expect(batch()).toEqual([
      {
        action: ACTION,
        resourceType: "asset",
        resourceId: "a1",
        resourceName: "sw-01",
        actor: "system:change-detector",
        level: "info",
        message: `${ACTION}: port1`,
        details: { neighbor: "sw-02", change: ACTION },
      },
      {
        action: ACTION,
        resourceType: "asset",
        resourceId: "a1",
        resourceName: "sw-01",
        actor: "system:change-detector",
        level: "info",
        message: `${ACTION}: port2`,
        details: { change: ACTION },
      },
    ]);
  });

  it("an asset with no name falls back to each item's label for resourceName", async () => {
    await maybeEmitChangeEvents(ACTION, "a1", null, [{ label: "port1" }, { label: "port2" }]);
    expect(batch().map((e) => e.resourceName)).toEqual(["port1", "port2"]);
  });

  it("`change` in details is always the action, even if an item supplied one", async () => {
    await maybeEmitChangeEvents(ACTION, "a1", "sw-01", [{ label: "p", details: { change: "spoofed", x: 1 } }]);
    expect(batch()[0]!.details).toEqual({ change: ACTION, x: 1 });
  });

  it("a failing subscription lookup never throws into the scrape", async () => {
    subscribed.mockRejectedValue(new Error("db down"));
    await expect(maybeEmitChangeEvents(ACTION, "a1", "sw-01", [{ label: "p" }])).resolves.toBeUndefined();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("a failing batch write never throws into the scrape", async () => {
    eventLog.logEventsBatch.mockRejectedValue(new Error("db down"));
    await expect(maybeEmitChangeEvents(ACTION, "a1", "sw-01", [{ label: "p" }])).resolves.toBeUndefined();
  });

  it("asks the subscription once per call, however many items", async () => {
    await maybeEmitChangeEvents(ACTION, "a1", "sw-01", Array.from({ length: 50 }, (_, i) => ({ label: `p${i}` })));
    expect(subscribed).toHaveBeenCalledTimes(1);
    expect(batch()).toHaveLength(50);
  });
});
