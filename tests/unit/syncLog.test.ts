import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

import { makeSyncLog } from "../../src/services/discovery/syncLog.js";

describe("makeSyncLog", () => {
  beforeEach(() => {
    resetEventLogStub();
  });

  it("writes an integration.sync Event with the name-prefixed message", () => {
    const syncLog = makeSyncLog("int-1", "Lab FMG", "alice");
    syncLog("warning", "3 subnets skipped");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent).toHaveBeenCalledWith({
      action: "integration.sync",
      resourceType: "integration",
      resourceId: "int-1",
      resourceName: "Lab FMG",
      actor: "alice",
      level: "warning",
      message: "[Lab FMG] 3 subnets skipped",
    });
  });

  it("passes an absent actor through as undefined and keeps each level", () => {
    const syncLog = makeSyncLog("int-2", "vc", undefined);
    syncLog("info", "a");
    syncLog("error", "b");
    expect(eventLog.logEvent.mock.calls.map((c) => [c[0].actor, c[0].level, c[0].message])).toEqual([
      [undefined, "info", "[vc] a"],
      [undefined, "error", "[vc] b"],
    ]);
  });

  it("does not await the write (fire-and-forget)", () => {
    eventLog.logEvent.mockReturnValue(new Promise<undefined>(() => {}));
    const syncLog = makeSyncLog("int-3", "x", undefined);
    expect(syncLog("info", "m")).toBeUndefined();
  });
});
