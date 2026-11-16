/**
 * tests/unit/customWidgetEnablementService.test.ts — CQ-T010 own suite for
 * src/services/customWidgetEnablementService.ts (business rules 130 / 131).
 *
 * Complements tests/unit/customWidgetEnablement.test.ts, which drives the REAL
 * profile resolver over a stubbed cache. Here `findDbProfile` is mocked, so
 * each case states which profile governs the asset outright, and the suite
 * covers what that one does not: the two read helpers the scheduler leans on,
 * the subject handed to the resolver, the cache refresh before the governing
 * check, the 404s, de-duplication, the audit Event shape, and the contract
 * "one Event per asset CHANGED" (polaris-change-impact → snmp-mibs-profiles.md).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const resolver = vi.hoisted(() => ({
  findDbProfile: vi.fn(),
  refreshProfileCacheIfStale: vi.fn(async () => false),
}));
vi.mock("../../src/services/profileResolver.js", () => ({ findDbProfile: resolver.findDbProfile }));
vi.mock("../../src/services/manufacturerProfileService.js", () => ({
  refreshProfileCacheIfStale: resolver.refreshProfileCacheIfStale,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  widgetProfileForAsset,
  widgetAppliesToModel,
  enabledWidgetIdsForAsset,
  assetIdsWithEnabledWidgets,
  listWidgetCandidates,
  setWidgetAssets,
  setWidgetEnabledForAsset,
} from "../../src/services/customWidgetEnablementService.js";

const p = prisma as any;

const WIDGET = {
  id: "w1", name: "Battery", modelPattern: "^Smart-UPS", profileId: "p-apc",
  profile: { manufacturer: "APC", matchPattern: null },
};

/** Governing profile by manufacturer: APC → p-apc, anything else → none. */
function governByManufacturer() {
  resolver.findDbProfile.mockImplementation((s: { manufacturer: string | null }) =>
    s.manufacturer === "APC" ? { id: "p-apc" } : null);
}

function asset(id: string, model: string | null, manufacturer = "APC", hostname: string | null = `host-${id}`) {
  return { id, hostname, ipAddress: null, manufacturer, os: null, model, assetType: "ups", monitored: true, monitorStatus: "up" };
}

async function expectAppError(promise: Promise<unknown>, status: number, re?: RegExp) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (re) expect((err as AppError).message).toMatch(re);
}

function eventsWritten(): Array<{ action: string; resourceId?: string }> {
  return eventLog.logEventsBatch.mock.calls.flatMap((c) => c[0] as Array<{ action: string; resourceId?: string }>);
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  resolver.findDbProfile.mockReset();
  resolver.refreshProfileCacheIfStale.mockReset();
  resolver.refreshProfileCacheIfStale.mockResolvedValue(false);
  governByManufacturer();
  stubbed(p.manufacturerCustomWidget.findUnique).mockResolvedValue(WIDGET);
  stubbed(p.assetCustomWidgetEnable.createMany).mockResolvedValue({ count: 0 });
  stubbed(p.assetCustomWidgetEnable.deleteMany).mockResolvedValue({ count: 0 });
  stubbed(p.assetCustomWidgetEnable.findMany).mockResolvedValue([]);
  stubbed(p.asset.findMany).mockResolvedValue([]);
});

describe("widgetProfileForAsset", () => {
  it("asks the resolver with the asset's identity and no MIB module", () => {
    resolver.findDbProfile.mockReturnValue({ id: "p-x" });
    expect(widgetProfileForAsset({ manufacturer: "APC", os: "AOS", model: "SRT", assetType: "ups" })).toEqual({ id: "p-x" });
    expect(resolver.findDbProfile).toHaveBeenCalledWith({ manufacturer: "APC", os: "AOS", model: "SRT", assetType: "ups", mibModule: null });
  });

  it("passes absent os / assetType as null", () => {
    widgetProfileForAsset({ manufacturer: null, model: null });
    expect(resolver.findDbProfile).toHaveBeenCalledWith({ manufacturer: null, os: null, model: null, assetType: null, mibModule: null });
  });

  it("returns null when nothing governs (cache cold or no profile)", () => {
    resolver.findDbProfile.mockReturnValue(null);
    expect(widgetProfileForAsset({ manufacturer: "Juniper", model: null })).toBeNull();
  });
});

describe("widgetAppliesToModel", () => {
  it("no pattern (null, undefined, empty) admits every model, even a null one", () => {
    expect(widgetAppliesToModel(null, null)).toBe(true);
    expect(widgetAppliesToModel(undefined, "x")).toBe(true);
    expect(widgetAppliesToModel("", "x")).toBe(true);
  });

  it("matches case-insensitively and treats a null model as the empty string", () => {
    expect(widgetAppliesToModel("smart", "SMART-UPS")).toBe(true);
    expect(widgetAppliesToModel("^$", null)).toBe(true);
    expect(widgetAppliesToModel("^Smart", undefined)).toBe(false);
  });

  it("a pattern RE2 cannot compile matches nothing", () => {
    expect(widgetAppliesToModel("(", "(")).toBe(false);
    // Backreferences are outside RE2.
    expect(widgetAppliesToModel("(a)\\1", "aa")).toBe(false);
  });
});

describe("enabledWidgetIdsForAsset", () => {
  it("returns the asset's switched-on widget ids as a set", async () => {
    stubbed(p.assetCustomWidgetEnable.findMany).mockResolvedValue([{ widgetId: "w1" }, { widgetId: "w2" }]);
    const ids = await enabledWidgetIdsForAsset("a1");
    expect([...ids].sort()).toEqual(["w1", "w2"]);
    expect(p.assetCustomWidgetEnable.findMany).toHaveBeenCalledWith({ where: { assetId: "a1" }, select: { widgetId: true } });
  });

  it("is empty for an asset with nothing on", async () => {
    await expect(enabledWidgetIdsForAsset("a1")).resolves.toEqual(new Set());
  });
});

describe("assetIdsWithEnabledWidgets", () => {
  it("is ONE distinct read across the whole table", async () => {
    stubbed(p.assetCustomWidgetEnable.findMany).mockResolvedValue([{ assetId: "a1" }, { assetId: "a2" }]);
    const ids = await assetIdsWithEnabledWidgets();
    expect(ids).toEqual(new Set(["a1", "a2"]));
    expect(p.assetCustomWidgetEnable.findMany).toHaveBeenCalledTimes(1);
    expect(p.assetCustomWidgetEnable.findMany).toHaveBeenCalledWith({ distinct: ["assetId"], select: { assetId: true } });
  });
});

describe("listWidgetCandidates", () => {
  it("refreshes the profile cache before the governing check", async () => {
    await listWidgetCandidates("p-apc", "w1");
    expect(resolver.refreshProfileCacheIfStale).toHaveBeenCalledTimes(1);
  });

  it("404s an unknown widget, and a widget of another profile", async () => {
    stubbed(p.manufacturerCustomWidget.findUnique).mockResolvedValueOnce(null);
    await expectAppError(listWidgetCandidates("p-apc", "nope"), 404, /Widget not found/);
    await expectAppError(listWidgetCandidates("p-other", "w1"), 404);
    expect(p.asset.findMany).not.toHaveBeenCalled();
  });

  it("keeps hostname order, filters on governance + model, and maps the row shape", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([
      { ...asset("a1", "Smart-UPS 1500"), assetType: null, monitorStatus: null },
      asset("a2", "Back-UPS"),
      asset("a3", "Smart-UPS 750", "Eaton"),
    ]);
    stubbed(p.assetCustomWidgetEnable.findMany).mockResolvedValue([{ assetId: "a1" }]);
    const rows = await listWidgetCandidates("p-apc", "w1");
    expect(rows).toEqual([
      { id: "a1", hostname: "host-a1", ipAddress: null, model: "Smart-UPS 1500", assetType: null, monitored: true, monitorStatus: null, enabled: true },
    ]);
    const q = stubbed(p.asset.findMany).mock.calls[0]![0];
    expect(q.orderBy).toEqual({ hostname: "asc" });
    expect(q.where).toEqual({ manufacturer: { equals: "APC", mode: "insensitive" }, status: { not: "decommissioned" } });
    expect(p.assetCustomWidgetEnable.findMany).toHaveBeenCalledWith({ where: { widgetId: "w1" }, select: { assetId: true } });
  });

  it("an enabled row for an asset that no longer falls under the widget is not listed", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([asset("a2", "Back-UPS")]);
    stubbed(p.assetCustomWidgetEnable.findMany).mockResolvedValue([{ assetId: "a2" }]);
    await expect(listWidgetCandidates("p-apc", "w1")).resolves.toEqual([]);
  });
});

describe("setWidgetAssets", () => {
  it("dedupes both lists and drops from disable any id also in enable", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([asset("a1", "Smart-UPS")]);
    stubbed(p.assetCustomWidgetEnable.createMany).mockResolvedValue({ count: 1 });
    await setWidgetAssets("p-apc", "w1", { enable: ["a1", "a1"], disable: ["a1", "a9", "a9"] });
    expect(stubbed(p.asset.findMany).mock.calls[0]![0].where).toEqual({ id: { in: ["a1"] } });
    expect(p.assetCustomWidgetEnable.deleteMany).toHaveBeenCalledWith({ where: { widgetId: "w1", assetId: { in: ["a9"] } } });
    expect(stubbed(p.assetCustomWidgetEnable.createMany).mock.calls[0]![0].data).toHaveLength(1);
  });

  it("refuses an enable id that names no asset (400) and writes nothing", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([asset("a1", "Smart-UPS")]);
    await expectAppError(setWidgetAssets("p-apc", "w1", { enable: ["a1", "ghost"] }), 400, /does not apply to 1 of the selected/);
    expect(p.$transaction).not.toHaveBeenCalled();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("refuses an asset governed by another profile, and one whose model the pattern excludes", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([asset("a1", "Smart-UPS", "Eaton"), asset("a2", "Back-UPS")]);
    await expectAppError(setWidgetAssets("p-apc", "w1", { enable: ["a1", "a2"] }), 400, /Battery.*2 of the selected/);
  });

  it("disable takes any id without reading assets", async () => {
    stubbed(p.assetCustomWidgetEnable.deleteMany).mockResolvedValue({ count: 1 });
    await expect(setWidgetAssets("p-apc", "w1", { disable: ["gone"] }, "bob")).resolves.toEqual({ enabled: 0, disabled: 1 });
    expect(p.asset.findMany).not.toHaveBeenCalled();
  });

  it("an empty change writes no rows and no Events (one empty batch)", async () => {
    await expect(setWidgetAssets("p-apc", "w1", {})).resolves.toEqual({ enabled: 0, disabled: 0 });
    expect(eventsWritten()).toEqual([]);
  });

  it("writes the Events in ONE batch, shaped for the asset", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([asset("a1", "Smart-UPS"), asset("a2", "Smart-UPS 3000")]);
    stubbed(p.assetCustomWidgetEnable.createMany).mockResolvedValue({ count: 2 });
    await setWidgetAssets("p-apc", "w1", { enable: ["a1", "a2"] }, "alice");
    expect(eventLog.logEventsBatch).toHaveBeenCalledTimes(1);
    expect(eventLog.logEventsBatch.mock.calls[0]![0][0]).toEqual({
      action: "asset.custom_widget.enabled",
      resourceType: "asset",
      resourceId: "a1",
      resourceName: "host-a1",
      actor: "alice",
      level: "info",
      message: 'Custom widget "Battery" (APC) switched on for polling',
      details: { widgetId: "w1", profileId: "p-apc" },
    });
  });

  it("writes no disabled Events when nothing was removed", async () => {
    stubbed(p.assetCustomWidgetEnable.deleteMany).mockResolvedValue({ count: 0 });
    await setWidgetAssets("p-apc", "w1", { disable: ["a1", "a2"] });
    expect(eventsWritten()).toEqual([]);
  });

  // BUG: setWidgetAssets writes a "disabled" Event for EVERY id in `disable`
  // once deleteMany removed at least one row. disable: ["a1", "a2"] where only
  // a1 was switched on (deleteMany count 1) writes two
  // `asset.custom_widget.disabled` Events, telling a2's history it was switched
  // off when nothing changed. The contract is one Event per asset CHANGED:
  // only a1's.
  it.fails("audits only the assets whose switch actually went off", async () => {
    stubbed(p.assetCustomWidgetEnable.deleteMany).mockResolvedValue({ count: 1 });
    await setWidgetAssets("p-apc", "w1", { disable: ["a1", "a2"] });
    expect(eventsWritten()).toHaveLength(1);
  });

  // BUG: the enable half audits every id in `enable`, including assets that
  // were already switched on (createMany skipDuplicates creates nothing for
  // them). enable: ["a1"] with a1 already on returns { enabled: 0 } yet writes
  // an `asset.custom_widget.enabled` Event "switched on for polling". Expected:
  // no Event for an asset whose switch did not move.
  it.fails("does not audit an enable for an asset already switched on", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([asset("a1", "Smart-UPS")]);
    stubbed(p.assetCustomWidgetEnable.createMany).mockResolvedValue({ count: 0 });
    const res = await setWidgetAssets("p-apc", "w1", { enable: ["a1"] });
    expect(res.enabled).toBe(0);
    expect(eventsWritten()).toEqual([]);
  });
});

describe("setWidgetEnabledForAsset", () => {
  it("404s an unknown asset", async () => {
    stubbed(p.asset.findUnique).mockResolvedValue(null);
    await expectAppError(setWidgetEnabledForAsset("nope", "w1", true), 404, /Asset not found/);
  });

  it("404s an unknown widget (no profile filter on this path)", async () => {
    stubbed(p.manufacturerCustomWidget.findUnique).mockResolvedValue(null);
    await expectAppError(setWidgetEnabledForAsset("a1", "w1", false), 404, /Widget not found/);
  });

  it("switching on upserts on (assetId, widgetId) with the actor and leaves an existing row unchanged", async () => {
    stubbed(p.asset.findUnique).mockResolvedValue(asset("a1", "Smart-UPS"));
    await setWidgetEnabledForAsset("a1", "w1", true, "alice");
    expect(p.assetCustomWidgetEnable.upsert).toHaveBeenCalledWith({
      where: { assetId_widgetId: { assetId: "a1", widgetId: "w1" } },
      create: { assetId: "a1", widgetId: "w1", enabledBy: "alice" },
      update: {},
    });
    expect(eventsWritten()).toEqual([expect.objectContaining({ action: "asset.custom_widget.enabled", resourceId: "a1", actor: "alice" })]);
  });

  it("without an actor stores enabledBy null", async () => {
    stubbed(p.asset.findUnique).mockResolvedValue(asset("a1", "Smart-UPS"));
    await setWidgetEnabledForAsset("a1", "w1", true);
    expect(stubbed(p.assetCustomWidgetEnable.upsert).mock.calls[0]![0].create.enabledBy).toBeNull();
  });

  it("switching off for an asset no longer governed is allowed and audited", async () => {
    stubbed(p.asset.findUnique).mockResolvedValue({ ...asset("a1", "Smart-UPS", "Eaton"), hostname: null });
    await setWidgetEnabledForAsset("a1", "w1", false, "bob");
    expect(p.assetCustomWidgetEnable.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", widgetId: "w1" } });
    const [ev] = eventsWritten() as Array<Record<string, unknown>>;
    expect(ev).toMatchObject({ action: "asset.custom_widget.disabled", resourceId: "a1", message: expect.stringMatching(/switched off/) });
    expect(ev!.resourceName).toBeUndefined();
  });

  it("refuses switching on a model the pattern excludes (400) without writing", async () => {
    stubbed(p.asset.findUnique).mockResolvedValue(asset("a1", "Back-UPS"));
    await expectAppError(setWidgetEnabledForAsset("a1", "w1", true), 400, /does not apply to this asset/);
    expect(p.assetCustomWidgetEnable.upsert).not.toHaveBeenCalled();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });
});
