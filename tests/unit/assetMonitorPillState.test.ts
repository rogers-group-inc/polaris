/**
 * tests/unit/assetMonitorPillState.test.ts — search-hit monitor Status pill
 *
 * Mirrors the precedence of `assetMonitorBadge` in public/js/assets.js:
 * unmonitored → Dependency Test overlay → Dep. Down overlay → five-state
 * machine (unknown/null → Pending).
 */

import { describe, it, expect } from "vitest";
import { assetMonitorPillState } from "../../src/services/searchService.js";

const base = {
  monitored: true,
  monitorStatus: "up",
  dependencySuppressed: false,
  dependencyTestUntil: null,
};

describe("assetMonitorPillState", () => {
  it("returns Unmonitored when monitored is false or null", () => {
    expect(assetMonitorPillState({ ...base, monitored: false })).toEqual({
      kind: "unmonitored",
      label: "Unmonitored",
    });
    expect(assetMonitorPillState({ ...base, monitored: null })).toEqual({
      kind: "unmonitored",
      label: "Unmonitored",
    });
  });

  it("unmonitored outranks the overlays (matches the assets-table pill)", () => {
    expect(
      assetMonitorPillState({
        monitored: false,
        monitorStatus: "down",
        dependencySuppressed: true,
        dependencyTestUntil: new Date(Date.now() + 60_000),
      }).kind,
    ).toBe("unmonitored");
  });

  it("maps each five-state value onto its pill", () => {
    expect(assetMonitorPillState({ ...base, monitorStatus: "up" })).toEqual({ kind: "up", label: "Up" });
    expect(assetMonitorPillState({ ...base, monitorStatus: "warning" })).toEqual({ kind: "warning", label: "Missed" });
    expect(assetMonitorPillState({ ...base, monitorStatus: "down" })).toEqual({ kind: "down", label: "Down" });
    expect(assetMonitorPillState({ ...base, monitorStatus: "recovering" })).toEqual({ kind: "recovering", label: "Recovering" });
  });

  it("renders unknown / null / unrecognized monitorStatus as Pending", () => {
    expect(assetMonitorPillState({ ...base, monitorStatus: "unknown" })).toEqual({ kind: "pending", label: "Pending" });
    expect(assetMonitorPillState({ ...base, monitorStatus: null })).toEqual({ kind: "pending", label: "Pending" });
    expect(assetMonitorPillState({ ...base, monitorStatus: "bogus" })).toEqual({ kind: "pending", label: "Pending" });
  });

  it("renders passive as its own state, NOT as Pending", () => {
    // "Pending" means never probed. A passive device is polled and charted
    // perfectly well — it simply has no down-detection automation covering it,
    // so Polaris renders no verdict (business rule 36). Folding it into the
    // unrecognized-value fallback would tell the operator the opposite.
    expect(assetMonitorPillState({ ...base, monitorStatus: "passive" })).toEqual({ kind: "passive", label: "Passive" });
  });

  it("Dep. Down overlay outranks the five-state machine", () => {
    expect(
      assetMonitorPillState({ ...base, monitorStatus: "up", dependencySuppressed: true }),
    ).toEqual({ kind: "dep-down", label: "Dep. Down" });
  });

  it("an active Dependency Test outranks Dep. Down and the probe state", () => {
    expect(
      assetMonitorPillState({
        ...base,
        monitorStatus: "up",
        dependencySuppressed: true,
        dependencyTestUntil: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ kind: "dep-test", label: "Dependency Test" });
  });

  it("an expired Dependency Test is ignored", () => {
    expect(
      assetMonitorPillState({ ...base, dependencyTestUntil: new Date(Date.now() - 1_000) }),
    ).toEqual({ kind: "up", label: "Up" });
  });

  it("maintenance outranks the frozen probe state and every overlay", () => {
    expect(
      assetMonitorPillState({
        ...base,
        status: "maintenance",
        monitorStatus: "recovering",
        dependencySuppressed: true,
        dependencyTestUntil: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ kind: "maintenance", label: "Maintenance" });
  });

  it("an unmonitored asset in maintenance still reads Unmonitored (matches the assets table)", () => {
    expect(
      assetMonitorPillState({ ...base, monitored: false, status: "maintenance" }),
    ).toEqual({ kind: "unmonitored", label: "Unmonitored" });
  });
});
