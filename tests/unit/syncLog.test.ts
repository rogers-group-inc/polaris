import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));

import { makeSyncLog } from "../../src/services/discovery/syncLog.js";

describe("makeSyncLog", () => {
  beforeEach(() => {
    h.logEvent.mockReset();
  });

  it("writes an integration.sync Event with the name-prefixed message", () => {
    const syncLog = makeSyncLog("int-1", "Lab FMG", "alice");
    syncLog("warning", "3 subnets skipped");
    expect(h.logEvent).toHaveBeenCalledTimes(1);
    expect(h.logEvent).toHaveBeenCalledWith({
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
    expect(h.logEvent.mock.calls.map((c) => [c[0].actor, c[0].level, c[0].message])).toEqual([
      [undefined, "info", "[vc] a"],
      [undefined, "error", "[vc] b"],
    ]);
  });

  it("does not await the write (fire-and-forget)", () => {
    h.logEvent.mockReturnValue(new Promise(() => {}));
    const syncLog = makeSyncLog("int-3", "x", undefined);
    expect(syncLog("info", "m")).toBeUndefined();
  });
});
