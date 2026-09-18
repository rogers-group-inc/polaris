/**
 * tests/unit/dimensionSpace.test.ts — what KIND of component a trigger reports
 * about (`dimensionSpaceOf`), and what to call it (`dimensionNounOf`).
 *
 * The space test is what business rule 32(b) turns on: a reset leaf in the
 * firing row's OWN vocabulary must answer about that component or say nothing,
 * while a leaf in another space falls back to the device-wide truth. Getting
 * "same space" wrong in either direction is a silent alerting bug — one port
 * clearing another port's alert, or a mixed tree that can never clear at all —
 * so the pairs that must and must not match are pinned here.
 */

import { describe, it, expect } from "vitest";
import { dimensionSpaceOf, dimensionNounOf } from "../../src/services/notificationTypes.js";

describe("dimensionSpaceOf", () => {
  it("puts every interface-dimensioned trigger in ONE space, metric or state", () => {
    // The pair that matters: a poeStatus alert whose reset leaf is ifOperStatus
    // is still about that port, and must not fall back to the device.
    const poe = dimensionSpaceOf({ type: "asset_state", field: "poeStatus" });
    expect(poe).not.toBeNull();
    expect(dimensionSpaceOf({ type: "asset_state", field: "ifOperStatus" })).toBe(poe);
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "ifInErrorRate" })).toBe(poe);
  });

  it("is null for a whole-device trigger — there is no component to be about", () => {
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "cpuPct" })).toBeNull();
    expect(dimensionSpaceOf({ type: "asset_state", field: "monitorStatus" })).toBeNull();
    expect(dimensionSpaceOf({ type: "host_metric", metric: "cpuPct" })).toBeNull();
    expect(dimensionSpaceOf({ type: "composite" })).toBeNull();
    expect(dimensionSpaceOf(null)).toBeNull();
    expect(dimensionSpaceOf(undefined)).toBeNull();
  });

  it("separates spaces that index their readings differently", () => {
    const iface = dimensionSpaceOf({ type: "asset_state", field: "poeStatus" });
    expect(dimensionSpaceOf({ type: "asset_state", field: "ipsecStatus" })).not.toBe(iface);
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "storageUsedPct" })).not.toBe(iface);
    // SD-WAN: a member-state reading is keyed (health check, WAN member) and a
    // rule-status reading by health check alone, so a member leaf genuinely
    // cannot answer about a rule-status dimension.
    expect(dimensionSpaceOf({ type: "asset_state", field: "sdwanMemberState" }))
      .not.toBe(dimensionSpaceOf({ type: "asset_state", field: "sdwanRuleStatus" }));
    // …and the SD-WAN metrics ARE keyed like member state, so they share it.
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "sdwanLatencyMs" }))
      .toBe(dimensionSpaceOf({ type: "asset_state", field: "sdwanMemberState" }));
  });

  it("does not depend on the order the dimension keys were declared in", () => {
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "hwSensorValue" }))
      .toBe(dimensionSpaceOf({ type: "asset_metric", metric: "hwSensorAlarm" }));
  });

  it("is null for an unknown metric rather than throwing", () => {
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "somethingWeAddNextYear" })).toBeNull();
    expect(dimensionSpaceOf({ type: "asset_state", field: "" })).toBeNull();
  });
});

describe("dimensionNounOf", () => {
  it("names the component the way an operator would, capitalized for a label", () => {
    expect(dimensionNounOf({ type: "asset_state", field: "poeStatus" })).toBe("Interface");
    expect(dimensionNounOf({ type: "asset_metric", metric: "ifInErrorRate" })).toBe("Interface");
    expect(dimensionNounOf({ type: "asset_state", field: "ipsecStatus" })).toBe("IPsec tunnel");
    expect(dimensionNounOf({ type: "asset_metric", metric: "storageUsedPct" })).toBe("Storage mount");
    expect(dimensionNounOf({ type: "asset_metric", metric: "hwSensorValue" })).toBe("Sensor");
  });

  it("is blank for a whole-device trigger, so the email row prunes away", () => {
    expect(dimensionNounOf({ type: "asset_metric", metric: "cpuPct" })).toBe("");
    expect(dimensionNounOf({ type: "asset_state", field: "monitorStatus" })).toBe("");
    expect(dimensionNounOf({ type: "event" })).toBe("");
    expect(dimensionNounOf(null)).toBe("");
  });
});
