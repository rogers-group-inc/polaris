/**
 * tests/unit/sdwanCadence.test.ts
 *
 * The SD-WAN stream's own cadence (split out of the system-info pass 2026-09):
 * which integration configs arm it and at what interval
 * (sdwanIntervalFromConfig), and which assets it reaches (sdwanShouldQueue —
 * the ONE predicate both due paths and the runner's pickup re-check share).
 * The due-set wiring against a real integration row is in
 * tests/integration/computeDueWork.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  sdwanIntervalFromConfig,
  sdwanShouldQueue,
  SDWAN_INTERVAL_DEFAULT_SEC,
  SDWAN_INTERVAL_MIN_SEC,
  SDWAN_INTERVAL_MAX_SEC,
} from "../../src/services/monitoringService.js";

describe("sdwanIntervalFromConfig", () => {
  it("defaults to 60s when pullSdwan is on and no interval is stored", () => {
    expect(SDWAN_INTERVAL_DEFAULT_SEC).toBe(60);
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true }, false)).toBe(60);
    expect(sdwanIntervalFromConfig("fortimanager", { pullSdwan: true }, false)).toBe(60);
  });

  it("honours a stored interval on both Fortinet integration types", () => {
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true, sdwanIntervalSeconds: 300 }, false)).toBe(300);
    expect(sdwanIntervalFromConfig("fortimanager", { pullSdwan: true, sdwanIntervalSeconds: 120 }, false)).toBe(120);
  });

  it("is null when the toggle is off or absent", () => {
    expect(sdwanIntervalFromConfig("fortigate", {}, false)).toBeNull();
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: false, sdwanIntervalSeconds: 60 }, false)).toBeNull();
    // Only a real boolean arms it — the same `=== true` the old system-info gate used.
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: "true" }, false)).toBeNull();
  });

  it("is null for a non-Fortinet integration even with the flag set", () => {
    expect(sdwanIntervalFromConfig("activedirectory", { pullSdwan: true }, false)).toBeNull();
    expect(sdwanIntervalFromConfig(null, { pullSdwan: true }, false)).toBeNull();
  });

  it("is null when FortiOS REST is unreachable (FMG proxy, no FortiGate token)", () => {
    expect(sdwanIntervalFromConfig("fortimanager", { pullSdwan: true }, true)).toBeNull();
  });

  it("clamps a stored value into range and falls back on garbage", () => {
    // The PUT path merges config unvalidated, so the read side clamps too.
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true, sdwanIntervalSeconds: 5 }, false)).toBe(SDWAN_INTERVAL_MIN_SEC);
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true, sdwanIntervalSeconds: 999_999 }, false)).toBe(SDWAN_INTERVAL_MAX_SEC);
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true, sdwanIntervalSeconds: 90.7 }, false)).toBe(90);
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true, sdwanIntervalSeconds: "abc" }, false)).toBe(60);
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true, sdwanIntervalSeconds: 0 }, false)).toBe(60);
    expect(sdwanIntervalFromConfig("fortigate", { pullSdwan: true, sdwanIntervalSeconds: -30 }, false)).toBe(60);
  });
});

describe("sdwanShouldQueue", () => {
  const rest = { interfacesPolling: "rest_api" };

  it("queues a firewall polled over FortiOS REST when an interval is armed", () => {
    expect(sdwanShouldQueue({ assetType: "firewall" }, rest, 60)).toBe(true);
  });

  it("does not queue without an armed interval", () => {
    expect(sdwanShouldQueue({ assetType: "firewall" }, rest, null)).toBe(false);
    expect(sdwanShouldQueue({ assetType: "firewall" }, rest, 0)).toBe(false);
  });

  it("keeps the old reach: REST only, so a gate moved to SNMP interfaces is left alone", () => {
    expect(sdwanShouldQueue({ assetType: "firewall" }, { interfacesPolling: "snmp" }, 60)).toBe(false);
    expect(sdwanShouldQueue({ assetType: "firewall" }, { interfacesPolling: null }, 60)).toBe(false);
  });

  it("never reaches a managed FortiSwitch or FortiAP", () => {
    expect(sdwanShouldQueue({ assetType: "switch" }, rest, 60)).toBe(false);
    expect(sdwanShouldQueue({ assetType: "access_point" }, rest, 60)).toBe(false);
  });
});
