/**
 * tests/unit/manufacturerProfilePortability.test.ts — exporting a manufacturer
 * profile to a portable file and importing it item by item.
 *
 * What must hold: the file carries no install ids (MIBs and credentials by
 * NAME); a preview says, per item, whether it creates or REPLACES and what it is
 * missing; a widget whose MIB is not on this install is blocked rather than
 * imported broken; apply imports ONLY the ticked items and keeps going past a
 * failing one. Prisma and the profile service's writers are mocked; the
 * planning is what's under test. A live round-trip against the dev stack is in
 * the commit that added this.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mibFindMany = vi.fn();
const credFindMany = vi.fn();
const svc = {
  getProfile: vi.fn(), getProfileFor: vi.fn(), createProfile: vi.fn(), updateProfile: vi.fn(),
  updateMetricRow: vi.fn(), createOverride: vi.fn(), updateOverride: vi.fn(),
  createWidget: vi.fn(), updateWidget: vi.fn(), deleteWidget: vi.fn(), deleteOverride: vi.fn(),
  setWidgetLayout: vi.fn(), refreshProfileCache: vi.fn(),
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    mibFile:    { findMany: (...a: unknown[]) => mibFindMany(...a) },
    credential: { findMany: (...a: unknown[]) => credFindMany(...a) },
  },
}));
vi.mock("../../src/services/manufacturerProfileService.js", () => svc);
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));

const port = await import("../../src/services/manufacturerProfilePortabilityService.js");

const PROFILE = {
  id: "p1", manufacturer: "APC", matchPattern: null,
  widgetLayout: { version: 1, columns: [{ id: "c1", width: 6, widgets: [{ id: "w-status", height: 1 }] }] },
  createdBy: null, createdAt: "", updatedAt: "",
  metrics: [{
    id: "m1", metricKey: "temperature", defaultSymbol: "upsAdvBatteryTemperature", defaultSymbolB: null,
    defaultMibId: "mib-pn", defaultMibStdKey: null, defaultType: "scalar", defaultTransform: null,
    defaultAggregate: "none", defaultLabel: null, defaultParsePattern: null, defaultParseTemplate: null, overrides: [],
  }],
  widgets: [
    { id: "w-status", name: "UPS Status", symbol: "upsBasicOutputStatus", mibId: "mib-pn", type: "scalar", widgetType: "state",
      transform: null, displayOptions: {}, order: 1, modelPattern: null, stateMap: { mode: "notEquals", values: [2] },
      labelSymbol: null, httpCheck: null, credentialId: null },
    { id: "w-web", name: "Web UI", symbol: null, mibId: null, type: "scalar", widgetType: "http",
      transform: null, displayOptions: {}, order: 2, modelPattern: null, stateMap: null,
      labelSymbol: null, httpCheck: { path: "/" }, credentialId: "cred-1" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.getProfile.mockResolvedValue(PROFILE);
  svc.refreshProfileCache.mockResolvedValue(undefined);
  mibFindMany.mockResolvedValue([{ id: "mib-pn", moduleName: "PowerNet-MIB", manufacturer: "APC", model: null }]);
  credFindMany.mockResolvedValue([{ id: "cred-1", name: "UPS web login" }]);
});

describe("exportProfile", () => {
  it("names MIBs and credentials, maps the layout to file keys, and carries no row ids", async () => {
    const file = await port.exportProfile("p1");
    expect(file.mibs).toEqual([{ moduleName: "PowerNet-MIB", manufacturer: "APC", model: null }]);
    expect(file.widgets[0].mib).toEqual({ moduleName: "PowerNet-MIB", manufacturer: "APC", model: null });
    expect(file.widgets[1].credential).toEqual({ name: "UPS web login" });
    expect(file.layout?.columns[0].widgets).toEqual([{ key: "w1", height: 1 }]);
    const json = JSON.stringify(file);
    for (const id of ["mib-pn", "cred-1", "w-status", "w-web", "\"p1\"", "\"m1\""]) expect(json).not.toContain(id);
  });

  it("round-trips through its own schema", async () => {
    const file = await port.exportProfile("p1");
    expect(() => port.parseProfileFile(JSON.parse(JSON.stringify(file)))).not.toThrow();
  });
});

describe("parseProfileFile", () => {
  it("refuses something that is not a profile file, saying where", () => {
    expect(() => port.parseProfileFile({ format: "polaris.automation", version: 1 })).toThrow(/Not a Polaris manufacturer profile file/);
  });
});

describe("previewProfileImport", () => {
  it("into an existing profile: every item replaces, nothing missing", async () => {
    const file = await port.exportProfile("p1");
    svc.getProfileFor.mockReturnValue(PROFILE);
    const p = await port.previewProfileImport(file);
    expect(p.targetProfileId).toBe("p1");
    expect(p.items.map((i) => [i.id, i.action])).toEqual([
      ["settings", "replace"], ["metric:temperature", "replace"],
      ["widget:w1", "replace"], ["widget:w2", "replace"], ["layout", "replace"],
    ]);
    expect(p.mibs.every((m) => m.present)).toBe(true);
  });

  it("blocks a widget whose MIB this install lacks, and flags an unmatched credential", async () => {
    const file = await port.exportProfile("p1");
    svc.getProfileFor.mockReturnValue(null);
    mibFindMany.mockResolvedValue([]);   // no PowerNet-MIB here
    credFindMany.mockResolvedValue([]);  // no credential of that name
    const p = await port.previewProfileImport(file);
    const byId = Object.fromEntries(p.items.map((i) => [i.id, i]));
    expect(byId["widget:w1"].blocked).toBe("Upload PowerNet-MIB first");
    // The metric row still imports (its MIB is optional), with the warning.
    expect(byId["metric:temperature"].blocked).toBeNull();
    expect(byId["metric:temperature"].missingMibs).toHaveLength(1);
    // An HTTP check has no MIB; only its credential is missing.
    expect(byId["widget:w2"].blocked).toBeNull();
    expect(byId["widget:w2"].missingCredential).toBe("UPS web login");
    expect(p.mibs).toEqual([{ moduleName: "PowerNet-MIB", manufacturer: "APC", model: null, present: false }]);
  });
});

describe("View Code (exportProfile withIds + saveProfileCode)", () => {
  it("the code view carries row ids and no timestamp; the export carries neither id", async () => {
    const code = await port.exportProfile("p1", { withIds: true });
    expect(code.widgets.map((w) => w.id)).toEqual(["w-status", "w-web"]);
    expect(code.exportedAt).toBeUndefined();
    const file = await port.exportProfile("p1");
    expect(file.widgets[0].id).toBeUndefined();
    expect(file.exportedAt).toBeTruthy();
  });

  it("updates rows that keep their id, creates rows without one, deletes rows left out", async () => {
    const code = await port.exportProfile("p1", { withIds: true });
    code.widgets[0].name = "UPS State";                                   // edited in place
    code.widgets.splice(1, 1);                                            // Web UI removed
    code.widgets.push({ ...code.widgets[0], id: undefined, key: "w9", name: "New one" }); // added
    code.metrics = [];                                                    // temperature row removed
    svc.updateWidget.mockResolvedValue({ id: "w-status" });
    svc.createWidget.mockResolvedValue({ id: "w-new" });

    const out = await port.saveProfileCode("p1", code, "dmoore");

    expect(svc.updateWidget.mock.calls[0][0]).toBe("w-status");
    expect(svc.updateWidget.mock.calls[0][1]).toMatchObject({ name: "UPS State" });
    expect(svc.createWidget).toHaveBeenCalledTimes(1);
    expect(svc.deleteWidget).toHaveBeenCalledWith("w-web");
    expect(svc.updateMetricRow).toHaveBeenCalledWith("p1", "temperature", expect.objectContaining({ defaultSymbol: null }));
    expect(out.changes).toEqual(["cleared metric temperature", "added widget New one", "deleted widget Web UI"]);
  });

  it("refuses before writing anything: another manufacturer, a missing MIB, an unknown metric, an unknown credential", async () => {
    const code = await port.exportProfile("p1", { withIds: true });
    await expect(port.saveProfileCode("p1", { ...code, manufacturer: "Eaton" })).rejects.toThrow(/can't be changed here/);

    const typo = JSON.parse(JSON.stringify(code));
    typo.widgets[0].mib.moduleName = "TYPO-MIB";
    await expect(port.saveProfileCode("p1", typo)).rejects.toThrow(/MIB not uploaded on this install: TYPO-MIB/);

    const badKey = JSON.parse(JSON.stringify(code));
    badKey.metrics[0].metricKey = "fanSpeed";
    await expect(port.saveProfileCode("p1", badKey)).rejects.toThrow(/Unknown metric "fanSpeed"/);

    const badCred = JSON.parse(JSON.stringify(code));
    badCred.widgets[1].credential = { name: "nobody" };
    await expect(port.saveProfileCode("p1", badCred)).rejects.toThrow(/No credential named "nobody"/);

    for (const fn of [svc.updateMetricRow, svc.updateWidget, svc.createWidget, svc.deleteWidget, svc.updateProfile]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("says the earlier changes were kept when a row is refused part-way", async () => {
    const code = await port.exportProfile("p1", { withIds: true });
    code.matchPattern = "APC|Schneider";
    svc.updateMetricRow.mockRejectedValue(Object.assign(new Error("Invalid regex"), { httpStatus: 400 }));
    await expect(port.saveProfileCode("p1", code)).rejects.toThrow(/Invalid regex — the changes before this point were saved/);
  });
});

describe("applyProfileImport", () => {
  it("imports only the ticked items into a new profile and keeps going past a failure", async () => {
    const file = await port.exportProfile("p1");
    svc.getProfileFor.mockReturnValue(null);
    svc.createProfile.mockResolvedValue({ id: "p-new" });
    svc.getProfile.mockResolvedValue({ ...PROFILE, id: "p-new", metrics: [], widgets: [], widgetLayout: null });
    svc.updateMetricRow.mockRejectedValue(new Error("Unknown metric"));
    svc.createWidget.mockResolvedValue({ id: "w-new" });

    const res = await port.applyProfileImport(file, ["metric:temperature", "widget:w1", "layout"], "dmoore");

    expect(res.profileId).toBe("p-new");
    expect(svc.updateProfile).not.toHaveBeenCalled();          // settings not ticked
    expect(svc.createWidget).toHaveBeenCalledTimes(1);          // w2 not ticked
    expect(svc.createWidget.mock.calls[0][1]).toMatchObject({ name: "UPS Status", mibId: "mib-pn" });
    expect(svc.setWidgetLayout.mock.calls[0][1].columns[0].widgets).toEqual([{ id: "w-new", height: 1 }]);
    expect(res.results).toEqual([
      { id: "metric:temperature", ok: false, error: "Unknown metric" },
      { id: "widget:w1", ok: true },
      { id: "layout", ok: true },
    ]);
  });
});
