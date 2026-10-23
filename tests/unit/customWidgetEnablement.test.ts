/**
 * tests/unit/customWidgetEnablement.test.ts — business rule 130: a manufacturer
 * custom widget APPLIES to every asset its profile + model pattern match, but
 * POLLS only the assets it is switched on for.
 *
 * The risks are switching a widget on for a device it cannot read (another
 * vendor, a model the pattern excludes), losing the per-asset audit trail on a
 * bulk change, and the widget cadence drifting off the hardware-sensor
 * interval. Prisma and the event writer are mocked; the rules are under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const widgetFindUnique = vi.fn();
const assetFindMany = vi.fn();
const assetFindUnique = vi.fn();
const enableFindMany = vi.fn();
const enableCreateMany = vi.fn();
const enableDeleteMany = vi.fn();
const enableUpsert = vi.fn();
const logEventsBatch = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    manufacturerCustomWidget: { findUnique: (...a: unknown[]) => widgetFindUnique(...a) },
    asset: {
      findMany:   (...a: unknown[]) => assetFindMany(...a),
      findUnique: (...a: unknown[]) => assetFindUnique(...a),
    },
    assetCustomWidgetEnable: {
      findMany:   (...a: unknown[]) => enableFindMany(...a),
      createMany: (...a: unknown[]) => enableCreateMany(...a),
      deleteMany: (...a: unknown[]) => enableDeleteMany(...a),
      upsert:     (...a: unknown[]) => enableUpsert(...a),
    },
    // $transaction([...]) over already-started promises: resolve them in order.
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEventsBatch: (...a: unknown[]) => logEventsBatch(...a),
}));

// Business rule 131: "applies" means the widget's profile GOVERNS the asset,
// decided by profileResolver.findDbProfile over the warm profile cache. The
// cache is stubbed with in-memory profiles; the resolver itself is real.
const profiles = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock("../../src/services/manufacturerProfileService.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProfileFor: (m: string | null | undefined) =>
    profiles.list.find((p) => String(p.manufacturer).toLowerCase() === String(m ?? "").trim().toLowerCase()) ?? null,
  listCachedProfiles: () => profiles.list,
  refreshProfileCacheIfStale: async () => false,
}));

function profile(id: string, manufacturer: string, matchPattern: string | null = null) {
  return { id, manufacturer, matchPattern, createdBy: null, createdAt: "", updatedAt: "", metrics: [], widgets: [] };
}

const svc = await import("../../src/services/customWidgetEnablementService.js");
const { customWidgetIntervalSec } = await import("../../src/services/monitoringService.js");

const WIDGET = {
  id: "w1", name: "Battery Status", modelPattern: "^Smart-UPS", profileId: "p-apc",
  profile: { manufacturer: "APC", matchPattern: null },
};

beforeEach(() => {
  profiles.list = [profile("p-apc", "APC")];
  for (const f of [widgetFindUnique, assetFindMany, assetFindUnique, enableFindMany, enableCreateMany, enableDeleteMany, enableUpsert, logEventsBatch]) f.mockReset();
  widgetFindUnique.mockResolvedValue(WIDGET);
  enableCreateMany.mockResolvedValue({ count: 0 });
  enableDeleteMany.mockResolvedValue({ count: 0 });
  logEventsBatch.mockResolvedValue(0);
});

describe("widgetAppliesToModel", () => {
  it("admits every model when there is no pattern, and tests the pattern case-insensitively", () => {
    expect(svc.widgetAppliesToModel(null, "anything")).toBe(true);
    expect(svc.widgetAppliesToModel("^smart-ups", "Smart-UPS 1500")).toBe(true);
    expect(svc.widgetAppliesToModel("^Smart-UPS", "Back-UPS 700")).toBe(false);
    expect(svc.widgetAppliesToModel("^Smart-UPS", null)).toBe(false);
  });
});

describe("listWidgetCandidates", () => {
  it("lists only assets the widget applies to, each with its switch state", async () => {
    assetFindMany.mockResolvedValue([
      { id: "a1", hostname: "ups-dc", ipAddress: "10.0.0.2", manufacturer: "APC", model: "Smart-UPS 1500", assetType: "other", monitored: true, monitorStatus: "up" },
      { id: "a2", hostname: "ups-closet", ipAddress: "10.0.0.3", manufacturer: "APC", model: "Back-UPS 700", assetType: "other", monitored: true, monitorStatus: "up" },
      { id: "a3", hostname: "ups-lab", ipAddress: null, manufacturer: "APC", model: "Smart-UPS 3000", assetType: "other", monitored: false, monitorStatus: null },
    ]);
    enableFindMany.mockResolvedValue([{ assetId: "a3" }]);

    const rows = await svc.listWidgetCandidates("p-apc", "w1");
    expect(rows.map((r) => [r.id, r.enabled])).toEqual([["a1", false], ["a3", true]]);
  });

  it("404s a widget that belongs to a different profile", async () => {
    await expect(svc.listWidgetCandidates("p-other", "w1")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("setWidgetAssets", () => {
  it("refuses to switch a widget on for a device it does not apply to", async () => {
    assetFindMany.mockResolvedValue([
      { id: "a1", hostname: "ups-dc", manufacturer: "APC", model: "Smart-UPS 1500" },
      { id: "fw", hostname: "fw-1", manufacturer: "Fortinet", model: "FortiGate-60F" },
    ]);
    await expect(svc.setWidgetAssets("p-apc", "w1", { enable: ["a1", "fw"] }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect(enableCreateMany).not.toHaveBeenCalled();
  });

  it("enables and disables in one transaction and audits each asset changed", async () => {
    assetFindMany.mockResolvedValue([{ id: "a1", hostname: "ups-dc", manufacturer: "APC", model: "Smart-UPS 1500" }]);
    enableCreateMany.mockResolvedValue({ count: 1 });
    enableDeleteMany.mockResolvedValue({ count: 1 });

    const out = await svc.setWidgetAssets("p-apc", "w1", { enable: ["a1"], disable: ["a9"] }, "dmoore");

    expect(out).toEqual({ enabled: 1, disabled: 1 });
    expect(enableCreateMany.mock.calls[0][0]).toMatchObject({
      data: [{ assetId: "a1", widgetId: "w1", enabledBy: "dmoore" }],
      skipDuplicates: true,
    });
    const events = logEventsBatch.mock.calls[0][0];
    expect(events.map((e: { action: string; resourceId: string }) => [e.action, e.resourceId])).toEqual([
      ["asset.custom_widget.enabled", "a1"],
      ["asset.custom_widget.disabled", "a9"],
    ]);
  });

  it("an id in both lists is enabled, not also disabled", async () => {
    assetFindMany.mockResolvedValue([{ id: "a1", hostname: "ups-dc", manufacturer: "APC", model: "Smart-UPS 1500" }]);
    await svc.setWidgetAssets("p-apc", "w1", { enable: ["a1"], disable: ["a1"] });
    expect(enableDeleteMany.mock.calls[0][0]).toEqual({ where: { widgetId: "w1", assetId: { in: [] } } });
  });
});

describe("setWidgetEnabledForAsset", () => {
  it("switches on with an upsert and off with a delete, auditing either way", async () => {
    assetFindUnique.mockResolvedValue({ id: "a1", hostname: "ups-dc", manufacturer: "APC", model: "Smart-UPS 1500" });
    await svc.setWidgetEnabledForAsset("a1", "w1", true, "dmoore");
    expect(enableUpsert).toHaveBeenCalledTimes(1);
    await svc.setWidgetEnabledForAsset("a1", "w1", false, "dmoore");
    expect(enableDeleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", widgetId: "w1" } });
    expect(logEventsBatch).toHaveBeenCalledTimes(2);
  });

  it("refuses to switch on for an asset the widget does not apply to, but always allows off", async () => {
    assetFindUnique.mockResolvedValue({ id: "a2", hostname: "ups-closet", manufacturer: "APC", model: "Back-UPS 700" });
    await expect(svc.setWidgetEnabledForAsset("a2", "w1", true)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.setWidgetEnabledForAsset("a2", "w1", false)).resolves.toBeUndefined();
  });
});

describe("a profile reached through its matchPattern (business rule 131)", () => {
  // The HP profile's "also applies when" covers the Aruba spelling no alias
  // folds in. Its widgets must reach those assets exactly as its telemetry
  // rows do — and must never reach an asset keyed to another profile.
  const HP_WIDGET = {
    id: "w-hp", name: "PSU status", modelPattern: null, profileId: "p-hp",
    profile: { manufacturer: "HP", matchPattern: "aruba|procurve" },
  };
  beforeEach(() => {
    profiles.list = [profile("p-apc", "APC"), profile("p-hp", "HP", "aruba|procurve")];
    widgetFindUnique.mockResolvedValue(HP_WIDGET);
  });

  it("widgetProfileForAsset: keyed first, then matchPattern over manufacturer + os, never stealing a keyed asset", () => {
    expect(svc.widgetProfileForAsset({ manufacturer: "HP", model: null })?.id).toBe("p-hp");
    expect(svc.widgetProfileForAsset({ manufacturer: "Aruba Networks", model: "2930F" })?.id).toBe("p-hp");
    expect(svc.widgetProfileForAsset({ manufacturer: null, os: "ProCurve K.16", model: null })?.id).toBe("p-hp");
    // APC is keyed to its own profile; an OS that happens to match HP's pattern does not move it.
    expect(svc.widgetProfileForAsset({ manufacturer: "APC", os: "aruba-bridge", model: null })?.id).toBe("p-apc");
    expect(svc.widgetProfileForAsset({ manufacturer: "Juniper", model: null })).toBeNull();
  });

  it("the picker reads past the manufacturer filter and keeps only governed assets", async () => {
    assetFindMany.mockResolvedValue([
      { id: "hp1", hostname: "sw-hp", ipAddress: null, manufacturer: "HP", os: null, model: "2530", assetType: "switch", monitored: true, monitorStatus: "up" },
      { id: "ar1", hostname: "sw-aruba", ipAddress: null, manufacturer: "Aruba Networks", os: null, model: "2930F", assetType: "switch", monitored: true, monitorStatus: "up" },
      { id: "apc", hostname: "ups", ipAddress: null, manufacturer: "APC", os: "aruba-bridge", model: "Smart-UPS", assetType: "other", monitored: true, monitorStatus: "up" },
      { id: "jn1", hostname: "rtr", ipAddress: null, manufacturer: "Juniper", os: "Junos", model: "MX204", assetType: "router", monitored: true, monitorStatus: "up" },
    ]);
    enableFindMany.mockResolvedValue([]);

    const rows = await svc.listWidgetCandidates("p-hp", "w-hp");
    expect(rows.map((r) => r.id)).toEqual(["hp1", "ar1"]);
    // No manufacturer clause: SQL cannot express the pattern.
    expect(assetFindMany.mock.calls[0][0].where).toEqual({ status: { not: "decommissioned" } });
  });

  it("the switch turns on for a matchPattern-routed asset and stays refused for a keyed-elsewhere one", async () => {
    assetFindUnique.mockResolvedValueOnce({ id: "ar1", hostname: "sw-aruba", manufacturer: "Aruba Networks", os: null, model: "2930F", assetType: "switch" });
    await svc.setWidgetEnabledForAsset("ar1", "w-hp", true);
    expect(enableUpsert).toHaveBeenCalledTimes(1);

    assetFindUnique.mockResolvedValueOnce({ id: "apc", hostname: "ups", manufacturer: "APC", os: "aruba-bridge", model: "Smart-UPS", assetType: "other" });
    await expect(svc.setWidgetEnabledForAsset("apc", "w-hp", true)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("a profile with no matchPattern keeps the cheap manufacturer-filtered query", async () => {
    widgetFindUnique.mockResolvedValue(WIDGET);
    assetFindMany.mockResolvedValue([]);
    enableFindMany.mockResolvedValue([]);
    await svc.listWidgetCandidates("p-apc", "w1");
    expect(assetFindMany.mock.calls[0][0].where).toEqual({
      manufacturer: { equals: "APC", mode: "insensitive" }, status: { not: "decommissioned" },
    });
  });
});

describe("customWidgetIntervalSec", () => {
  it("is the resolved hardware-sensor interval", () => {
    expect(customWidgetIntervalSec({ temperatureIntervalSeconds: 60 })).toBe(60);
    expect(customWidgetIntervalSec({ temperatureIntervalSeconds: 300 })).toBe(300);
  });
});
