import { describe, it, expect } from "vitest";
import { eventAssetIdOf } from "../../src/services/eventLogService.js";

// Event.assetId is what the asset-details Events tab queries. An alert's fire
// and clear are filed under resourceType=notification with the ALERT's id as
// resourceId, so the device has to come from details.assetId — before this
// column existed those rows never reached the device's tab at all.

describe("eventAssetIdOf", () => {
  it("uses the resource itself when it is an asset", () => {
    expect(eventAssetIdOf({ resourceType: "asset", resourceId: "a1" })).toBe("a1");
  });

  it("takes an alert event's device from details.assetId, not its resourceId", () => {
    expect(
      eventAssetIdOf({ resourceType: "notification", resourceId: "notif-9", details: { ruleId: "r1", assetId: "a1" } }),
    ).toBe("a1");
  });

  it("prefers an explicit assetId over both", () => {
    expect(
      eventAssetIdOf({ assetId: "a2", resourceType: "asset", resourceId: "a1", details: { assetId: "a3" } }),
    ).toBe("a2");
  });

  it("never reads a non-asset resourceId as an asset", () => {
    expect(eventAssetIdOf({ resourceType: "notification", resourceId: "notif-9" })).toBeNull();
    expect(eventAssetIdOf({ resourceType: "subnet", resourceId: "s1" })).toBeNull();
  });

  it("ignores a blank or non-string details.assetId", () => {
    expect(eventAssetIdOf({ resourceType: "notification", details: { assetId: "" } })).toBeNull();
    expect(eventAssetIdOf({ resourceType: "notification", details: { assetId: null } })).toBeNull();
    expect(eventAssetIdOf({ resourceType: "notification", details: { assetId: 42 } })).toBeNull();
  });

  it("returns null for an event about no asset", () => {
    expect(eventAssetIdOf({ resourceType: "integration", resourceId: "i1", details: { count: 3 } })).toBeNull();
    expect(eventAssetIdOf({})).toBeNull();
  });
});
