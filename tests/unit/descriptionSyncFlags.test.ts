/**
 * tests/unit/descriptionSyncFlags.test.ts — the per-device-class Description
 * Sync toggles and their fallback to the legacy `syncDescriptions` master key.
 */

import { describe, it, expect } from "vitest";
import {
  descriptionSyncFlags,
  descriptionSyncEnabledForRole,
  anyDescriptionSyncEnabled,
} from "../../src/utils/descriptionSyncFlags.js";

describe("descriptionSyncFlags", () => {
  it("is all off for an empty or missing config", () => {
    const off = { fortigate: false, fortiswitch: false, fortiap: false };
    expect(descriptionSyncFlags({})).toEqual(off);
    expect(descriptionSyncFlags(null)).toEqual(off);
    expect(descriptionSyncFlags(undefined)).toEqual(off);
  });

  it("inherits the legacy master toggle for every class never written", () => {
    expect(descriptionSyncFlags({ syncDescriptions: true })).toEqual({
      fortigate: true, fortiswitch: true, fortiap: true,
    });
  });

  it("lets an explicit per-class key win over the legacy toggle, either way", () => {
    expect(descriptionSyncFlags({ syncDescriptions: true, syncApDescriptions: false })).toEqual({
      fortigate: true, fortiswitch: true, fortiap: false,
    });
    expect(descriptionSyncFlags({ syncDescriptions: false, syncSwitchDescriptions: true })).toEqual({
      fortigate: false, fortiswitch: true, fortiap: false,
    });
  });

  it("ignores a non-boolean per-class value and falls back", () => {
    expect(descriptionSyncFlags({ syncDescriptions: true, syncApDescriptions: "no" }).fortiap).toBe(true);
  });
});

describe("descriptionSyncEnabledForRole", () => {
  const cfg = { syncFortigateDescriptions: true, syncSwitchDescriptions: false, syncApDescriptions: true };
  it("answers per role", () => {
    expect(descriptionSyncEnabledForRole(cfg, "fortigate")).toBe(true);
    expect(descriptionSyncEnabledForRole(cfg, "fortiswitch")).toBe(false);
    expect(descriptionSyncEnabledForRole(cfg, "fortiap")).toBe(true);
  });
  it("is false for an unknown or missing role", () => {
    expect(descriptionSyncEnabledForRole({ syncDescriptions: true }, "server")).toBe(false);
    expect(descriptionSyncEnabledForRole({ syncDescriptions: true }, undefined)).toBe(false);
  });
});

describe("anyDescriptionSyncEnabled", () => {
  it("is true when one class is on", () => {
    expect(anyDescriptionSyncEnabled({ syncApDescriptions: true })).toBe(true);
  });
  it("is false when every class is explicitly off, whatever the legacy key says", () => {
    expect(anyDescriptionSyncEnabled({
      syncDescriptions: true,
      syncFortigateDescriptions: false, syncSwitchDescriptions: false, syncApDescriptions: false,
    })).toBe(false);
  });
});
