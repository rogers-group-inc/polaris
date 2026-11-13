/**
 * tests/unit/manufacturerProfileService.test.ts — the profile write paths and
 * the cache-derived readers no other suite reaches (CQ-T010).
 *
 * Complements, does not repeat:
 *   - manufacturerProfileScope.test.ts — createOverride / updateOverride scope
 *     pair, aggregate, label, parse on overrides; updateProfile matchPattern
 *   - manufacturerProfileCache.test.ts — getProfileFor / listCachedProfiles /
 *     refreshProfileCacheIfStale
 *   - customMibLayout.test.ts — sanitizeWidgetLayout's coercions
 *   - sensorTableColumns.test.ts — readSensorColumns / sensorColumnsForWrite
 *   - manufacturerSuggestions / unprofiledManufacturers — the two pure merges
 *   - customWidgetEnablement / customWidgetCatalog / manufacturerProfilePortability
 *     — callers that mock this service
 *   - integration/deleteGuards.test.ts — rule 167(a) against a real database
 *
 * What was unreached: updateMetricRow (the metric-row write: effective-value
 * merge, MIB mutual exclusion, the row-shape rules, the metric-row transform
 * allow-list, the model-only parse fields, sensor columns cleared on a type
 * flip); createProfile's nine seeded rows and its P2002 → 409; setWidgetLayout;
 * createWidget / updateWidget (the http and state asymmetries and the
 * EFFECTIVE-type clearing the comments promise); deleteWidget / deleteProfile
 * against rule 167(a) with a mocked referrer read; listStateProbes;
 * symbolWarningsForProfile / sensorColumnSymbols; and
 * emitProfileReadinessEvents.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  symbolReadiness: vi.fn(),
  ensureRegistryLoaded: vi.fn(async () => undefined),
  dimensionTargetReferrers: vi.fn(async (_fields: unknown, _ids: readonly string[]): Promise<string[]> => []),
  validateHttpCheckDefinition: vi.fn(),
}));
vi.mock("../../src/services/oidRegistry.js", () => ({
  symbolReadiness: h.symbolReadiness,
  ensureRegistryLoaded: h.ensureRegistryLoaded,
}));
vi.mock("../../src/services/actionReferenceService.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/actionReferenceService.js")>()),
  dimensionTargetReferrers: h.dimensionTargetReferrers,
}));
vi.mock("../../src/services/credentialService.js", () => ({
  validateHttpCheckDefinition: h.validateHttpCheckDefinition,
}));

import { prisma } from "../../src/db.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { _resetAliasMap } from "../../src/utils/manufacturerNormalize.js";
import {
  METRIC_KEYS,
  createProfile,
  createWidget,
  deleteOverride,
  deleteProfile,
  deleteWidget,
  emitProfileReadinessEvents,
  listStateProbes,
  refreshProfileCache,
  sensorColumnSymbols,
  setWidgetLayout,
  symbolWarningsForProfile,
  updateMetricRow,
  updateWidget,
} from "../../src/services/manufacturerProfileService.js";

const resolved = (symbol: string) => ({ symbol, resolved: true, oid: "1.3.6", fromScope: null, fromModuleName: "X-MIB", hint: null });
const unresolved = (symbol: string, hint: unknown = { kind: "no-module" }) =>
  ({ symbol, resolved: false, oid: null, fromScope: null, fromModuleName: null, hint });

function profileRow(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    manufacturer: "Fortinet",
    matchPattern: null,
    widgetLayout: null,
    createdBy: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    metrics: [],
    widgets: [],
    ...over,
  };
}

function metricDbRow(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    profileId: "p1",
    metricKey: "cpu",
    defaultSymbol: null,
    defaultSymbolB: null,
    defaultMibId: null,
    defaultMibStdKey: null,
    defaultType: "scalar",
    defaultTransform: null,
    defaultAggregate: "none",
    defaultLabel: null,
    defaultParsePattern: null,
    defaultParseTemplate: null,
    defaultSensorColumns: null,
    overrides: [],
    ...over,
  };
}

const stateWidget = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, symbol: "fgHaStatus", mibId: "mib1", type: "table", widgetType: "state", transform: null,
  displayOptions: {}, order: 0, modelPattern: null, stateMap: { mode: "nonzero" }, labelSymbol: null,
  httpCheck: null, credentialId: null, ...over,
});

beforeEach(async () => {
  resetDbStub();
  resetEventLogStub();
  _resetAliasMap();
  h.symbolReadiness.mockReset();
  h.symbolReadiness.mockImplementation((_m: string, s: string) => resolved(s));
  h.dimensionTargetReferrers.mockReset();
  h.dimensionTargetReferrers.mockResolvedValue([]);
  h.validateHttpCheckDefinition.mockReset();
  stubbed(prisma.manufacturerProfile.findMany).mockResolvedValue([]);
  stubbed(prisma.manufacturerProfile.update).mockResolvedValue({});
  // Leave the module cache empty between tests.
  await refreshProfileCache();
});

describe("listStateProbes", () => {
  it("flattens every state widget across profiles, sorted by manufacturer then name; other widgets are skipped", async () => {
    stubbed(prisma.manufacturerProfile.findMany).mockResolvedValue([
      profileRow({ id: "p2", manufacturer: "Zyxel", widgets: [stateWidget("w3", "Fan")] }),
      profileRow({
        widgets: [
          stateWidget("w2", "PSU", { type: "scalar", modelPattern: "^FG" }),
          stateWidget("w1", "HA sync", { stateMap: { mode: "equals", values: ["2"], trueLabel: "Out of sync", falseLabel: "Synced" } }),
          { ...stateWidget("w9", "CPU gauge"), widgetType: "gauge" },
        ],
      }),
    ]);
    await refreshProfileCache();
    const probes = listStateProbes();
    expect(probes.map((p) => [p.manufacturer, p.name])).toEqual([["Fortinet", "HA sync"], ["Fortinet", "PSU"], ["Zyxel", "Fan"]]);
    expect(probes[1]).toMatchObject({ id: "w2", type: "scalar", modelPattern: "^FG" });
    expect(probes[0]!.stateMap).toMatchObject({ mode: "equals", values: ["2"], trueLabel: "Out of sync" });
  });

  it("is empty with no profiles", () => {
    expect(listStateProbes()).toEqual([]);
  });
});

describe("readiness warnings", () => {
  beforeEach(async () => {
    stubbed(prisma.manufacturerProfile.findMany).mockResolvedValue([profileRow()]);
    await refreshProfileCache();
  });

  it("symbolWarningsForProfile names what to upload, skips resolved and empty symbols", () => {
    h.symbolReadiness.mockImplementation((_m: string, s: string) => {
      if (s === "ok") return resolved(s);
      if (s === "needsImports") return unresolved(s, { kind: "imports", mibModuleName: "FORTINET-FORTIGATE-MIB", roots: [{ module: "FORTINET-CORE-MIB", symbol: "fnCore" }, { module: null, symbol: "fnRoot" }] });
      return unresolved(s);
    });
    const got = symbolWarningsForProfile("p1", [
      { symbol: "ok", mibId: null },
      { symbol: null, mibId: null },
      { symbol: "needsImports", mibId: "m" },
      { symbol: "nowhere", mibId: null },
    ]);
    expect(got).toEqual([
      "needsImports does not resolve for Fortinet: FORTINET-FORTIGATE-MIB is missing FORTINET-CORE-MIB, fnRoot — upload it too",
      "nowhere does not resolve for Fortinet: no uploaded MIB defines it — upload the vendor's MIB",
    ]);
  });

  it("an unknown profile id has no warnings", () => {
    h.symbolReadiness.mockImplementation((_m: string, s: string) => unresolved(s));
    expect(symbolWarningsForProfile("nope", [{ symbol: "x", mibId: null }])).toEqual([]);
  });

  it("sensorColumnSymbols lists name then alarm, skipping blanks", () => {
    expect(sensorColumnSymbols(null)).toEqual([]);
    expect(sensorColumnSymbols(undefined)).toEqual([]);
    expect(sensorColumnSymbols({ nameSymbol: "n", alarmSymbol: null, alarmMap: null, sensorClass: null, transform: null })).toEqual(["n"]);
    expect(sensorColumnSymbols({ nameSymbol: "n", alarmSymbol: "a", alarmMap: null, sensorClass: null, transform: null })).toEqual(["n", "a"]);
  });
});

describe("emitProfileReadinessEvents", () => {
  it("one warning Event per profile with unresolved symbols, counted across metrics, overrides and sensor columns", async () => {
    stubbed(prisma.manufacturerProfile.findMany).mockResolvedValue([
      profileRow({
        metrics: [
          metricDbRow({ defaultSymbol: "fgSysCpuUsage" }),
          metricDbRow({
            id: "m2", metricKey: "temperature", defaultSymbol: "fgHwSensorEntValue", defaultType: "table",
            defaultSensorColumns: { nameSymbol: "fgHwSensorEntName", alarmSymbol: "fgHwSensorEntAlarm" },
            overrides: [{ id: "o1", assetType: "switch", modelPattern: null, symbol: "fgHwSensorEntValue", type: "table", aggregate: "none", order: 0 }],
          }),
        ],
      }),
      profileRow({ id: "p2", manufacturer: "HPE", metrics: [metricDbRow({ id: "m3", defaultSymbol: "hpCpu" })] }),
    ]);
    await refreshProfileCache();
    h.symbolReadiness.mockImplementation((m: string, s: string) => (m === "Fortinet" && s !== "fgSysCpuUsage" ? unresolved(s) : resolved(s)));

    await expect(emitProfileReadinessEvents()).resolves.toBe(1);
    expect(h.ensureRegistryLoaded).toHaveBeenCalled();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0]![0];
    expect(ev).toMatchObject({ action: "manufacturer_profile.unresolved", level: "warning", resourceId: "p1", resourceName: "Fortinet" });
    // value column twice (metric + override) + name + alarm = 4 parts, 3 distinct symbols.
    expect(ev.message).toBe("Fortinet: 4 profile symbols do not resolve — fgHwSensorEntAlarm, fgHwSensorEntName, fgHwSensorEntValue. Telemetry using them is not being collected.");
    expect((ev.details as { unresolved: string[] }).unresolved).toHaveLength(3);
  });

  it("singular wording for one symbol; zero events when everything resolves", async () => {
    stubbed(prisma.manufacturerProfile.findMany).mockResolvedValue([profileRow({ metrics: [metricDbRow({ defaultSymbol: "x" })] })]);
    await refreshProfileCache();
    h.symbolReadiness.mockImplementation((_m: string, s: string) => unresolved(s));
    await emitProfileReadinessEvents();
    expect(eventLog.logEvent.mock.calls[0]![0].message).toContain("1 profile symbol do not resolve");
    eventLog.logEvent.mockClear();
    h.symbolReadiness.mockImplementation((_m: string, s: string) => resolved(s));
    await expect(emitProfileReadinessEvents()).resolves.toBe(0);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("createProfile", () => {
  it("creates the profile plus one unconfigured scalar row per metric key, in one transaction", async () => {
    stubbed(prisma.manufacturerProfile.create).mockResolvedValue({});
    stubbed(prisma.manufacturerProfileMetric.create).mockResolvedValue({});
    stubbed(prisma.manufacturerProfile.findUnique).mockResolvedValue(profileRow({ id: "new", manufacturer: "Aruba" }));
    const created = await createProfile({ manufacturer: "  Aruba  ", createdBy: "alice" });
    expect(created.manufacturer).toBe("Aruba");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.manufacturerProfile.create).toHaveBeenCalledWith({ data: expect.objectContaining({ manufacturer: "Aruba", createdBy: "alice" }) });
    const keys = stubbed(prisma.manufacturerProfileMetric.create).mock.calls.map((c) => c[0].data.metricKey);
    expect(keys).toEqual(METRIC_KEYS);
    for (const c of stubbed(prisma.manufacturerProfileMetric.create).mock.calls) expect(c[0].data.defaultType).toBe("scalar");
  });

  it("a blank manufacturer is a 400; a duplicate is a 409 naming it", async () => {
    await expect(createProfile({ manufacturer: "   " })).rejects.toMatchObject({ httpStatus: 400 });
    stubbed(prisma.$transaction).mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(createProfile({ manufacturer: "Fortinet" })).rejects.toMatchObject({ httpStatus: 409, message: 'A profile for "Fortinet" already exists' });
  });

  it("any other transaction failure propagates unchanged", async () => {
    stubbed(prisma.$transaction).mockRejectedValueOnce(new Error("conn reset"));
    await expect(createProfile({ manufacturer: "Fortinet" })).rejects.toThrow("conn reset");
  });
});

describe("updateMetricRow", () => {
  const echo = () => stubbed(prisma.manufacturerProfileMetric.update).mockImplementation(async ({ data }: any) => {
    const changed = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== Prisma.DbNull));
    return { ...metricDbRow(), ...changed };
  });
  const dataOf = () => stubbed(prisma.manufacturerProfileMetric.update).mock.calls[0]![0].data;

  beforeEach(() => {
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(metricDbRow());
    echo();
  });

  it("an unknown metric key is a 400, a missing row a 404", async () => {
    await expect(updateMetricRow("p1", "voltage", {})).rejects.toMatchObject({ httpStatus: 400 });
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(null);
    await expect(updateMetricRow("p1", "cpu", {})).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("writes only what was posted, bumps updatedAt and refreshes the cache", async () => {
    const row = await updateMetricRow("p1", "cpu", { defaultSymbol: "  fgSysCpuUsage  " });
    expect(row.defaultSymbol).toBe("fgSysCpuUsage");
    const d = dataOf();
    expect(d.defaultSymbol).toBe("fgSysCpuUsage");
    expect(d.defaultType).toBeUndefined();
    expect(d.defaultMibId).toBeUndefined();
    expect(d.defaultSensorColumns).toBe(Prisma.DbNull);
    expect(prisma.manufacturerProfile.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { updatedAt: expect.any(Date) } });
    expect(prisma.manufacturerProfile.findMany).toHaveBeenCalled();
  });

  it("an uploaded MIB and a standard-MIB key are mutually exclusive, the stored one included", async () => {
    await expect(updateMetricRow("p1", "cpu", { defaultMibId: "mib1", defaultMibStdKey: "std:host-resources" }))
      .rejects.toThrow(/mutually exclusive/);
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(metricDbRow({ defaultMibStdKey: "std:entity" }));
    await expect(updateMetricRow("p1", "cpu", { defaultMibId: "mib1" })).rejects.toThrow(/mutually exclusive/);
    // Clearing the stored key in the same write is fine.
    await expect(updateMetricRow("p1", "cpu", { defaultMibId: "mib1", defaultMibStdKey: null })).resolves.toBeTruthy();
  });

  it("refuses an unknown standard-MIB key and a non-string one", async () => {
    await expect(updateMetricRow("p1", "cpu", { defaultMibStdKey: "std:bogus" })).rejects.toThrow(/Unknown standard MIB key/);
    await expect(updateMetricRow("p1", "cpu", { defaultMibStdKey: 7 as never })).rejects.toThrow(/must be a string/);
  });

  it("the row shape: double_scalar needs B, table refuses a B, an unconfigured row always passes", async () => {
    await expect(updateMetricRow("p1", "memory", { defaultType: "double_scalar", defaultSymbol: "used" })).rejects.toThrow(/symbolB \(B\) is required/);
    await expect(updateMetricRow("p1", "memory", { defaultType: "table", defaultSymbol: "a", defaultSymbolB: "b" })).rejects.toThrow(/symbolB must be null on type="table"/);
    await expect(updateMetricRow("p1", "memory", { defaultType: "table" })).resolves.toBeTruthy();
    await expect(updateMetricRow("p1", "memory", { defaultType: "triple" })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("flipping a double_scalar row to scalar must clear B in the same edit; symbolB is then written null", async () => {
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(metricDbRow({ defaultType: "double_scalar", defaultSymbol: "a", defaultSymbolB: "b" }));
    // The shape check runs on the EFFECTIVE values, so the stored B refuses the flip…
    await expect(updateMetricRow("p1", "memory", { defaultType: "scalar" })).rejects.toThrow(/symbolB must be null on type="scalar"/);
    // …and clearing it alongside lands B as null.
    await updateMetricRow("p1", "memory", { defaultType: "scalar", defaultSymbolB: null });
    expect(dataOf().defaultSymbolB).toBeNull();
  });

  it("a double_scalar row keeps its B and takes a combiner, not a unary transform", async () => {
    await expect(updateMetricRow("p1", "memory", { defaultType: "double_scalar", defaultSymbol: "a", defaultSymbolB: "b", defaultTransform: "bytes_to_mb" }))
      .rejects.toThrow(/Invalid combiner for double_scalar/);
    await updateMetricRow("p1", "memory", { defaultType: "double_scalar", defaultSymbol: "a", defaultSymbolB: " b " });
    expect(dataOf().defaultSymbolB).toBe("b");
  });

  it("a metric row's transform must be one its collector applies", async () => {
    await expect(updateMetricRow("p1", "cpu", { defaultSymbol: "x", defaultTransform: "tenths_to_units" }))
      .rejects.toThrow("Transform tenths_to_units is not applied to a scalar cpu row");
    await expect(updateMetricRow("p1", "cpu", { defaultSymbol: "x", defaultTransform: "bogus" })).rejects.toThrow(/Invalid transform/);
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(metricDbRow({ metricKey: "temperature" }));
    await updateMetricRow("p1", "temperature", { defaultSymbol: "x", defaultTransform: "tenths_to_units" });
    expect(dataOf().defaultTransform).toBe("tenths_to_units");
  });

  it("parse fields belong to the model row, which needs a capturing pattern once it has a symbol", async () => {
    await expect(updateMetricRow("p1", "cpu", { defaultSymbol: "x", defaultParsePattern: "(.*)" })).rejects.toThrow(/model metric only/);
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(metricDbRow({ metricKey: "model" }));
    await expect(updateMetricRow("p1", "model", { defaultSymbol: "fsModel" })).rejects.toThrow(/parsePattern is required/);
    await expect(updateMetricRow("p1", "model", { defaultSymbol: "fsModel", defaultParsePattern: "FS-\\d+" })).rejects.toThrow(/capture group/);
    const row = await updateMetricRow("p1", "model", { defaultSymbol: "fsModel", defaultParsePattern: "(FS-\\d+)", defaultParseTemplate: "FortiSwitch $1" });
    expect(row.defaultParsePattern).toBe("(FS-\\d+)");
  });

  it("sensor columns are cleared when the stored row is flipped away from table, without the edit naming them", async () => {
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(metricDbRow({
      metricKey: "temperature", defaultType: "table", defaultSymbol: "v",
      defaultSensorColumns: { nameSymbol: "n", alarmSymbol: "a" },
    }));
    await updateMetricRow("p1", "temperature", { defaultType: "scalar" });
    expect(dataOf().defaultSensorColumns).toBe(Prisma.DbNull);
  });

  it("sensor columns on a temperature table row are kept, with the default alarm map", async () => {
    stubbed(prisma.manufacturerProfileMetric.findUnique).mockResolvedValue(metricDbRow({ metricKey: "temperature", defaultType: "table", defaultSymbol: "v" }));
    await updateMetricRow("p1", "temperature", { defaultSensorColumns: { nameSymbol: " n ", alarmSymbol: "a" } });
    expect(dataOf().defaultSensorColumns).toMatchObject({ nameSymbol: "n", alarmSymbol: "a", alarmMap: { mode: "nonzero" } });
  });
});

describe("setWidgetLayout", () => {
  it("404 for a missing profile", async () => {
    stubbed(prisma.manufacturerProfile.findUnique).mockResolvedValue(null);
    await expect(setWidgetLayout("nope", null)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("null clears the layout (DbNull)", async () => {
    stubbed(prisma.manufacturerProfile.findUnique).mockResolvedValue({ id: "p1", widgets: [{ id: "w1" }] });
    await expect(setWidgetLayout("p1", null)).resolves.toBeNull();
    expect(prisma.manufacturerProfile.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { widgetLayout: Prisma.DbNull } });
  });

  it("drops another profile's widget, and stores DbNull when nothing usable is left", async () => {
    stubbed(prisma.manufacturerProfile.findUnique).mockResolvedValue({ id: "p1", widgets: [{ id: "w1" }] });
    const kept = await setWidgetLayout("p1", { columns: [{ id: "c", width: 6, widgets: [{ id: "w1", height: 2 }, { id: "foreign" }] }] });
    expect(kept).toEqual({ version: 1, columns: [{ id: "c", width: 6, widgets: [{ id: "w1", height: 2 }] }] });
    await expect(setWidgetLayout("p1", { columns: [{ widgets: [{ id: "foreign" }] }] })).resolves.toBeNull();
    expect(stubbed(prisma.manufacturerProfile.update).mock.calls.at(-1)![0].data.widgetLayout).toBe(Prisma.DbNull);
  });
});

describe("createWidget", () => {
  beforeEach(() => {
    stubbed(prisma.manufacturerCustomWidget.create).mockImplementation(async ({ data }: any) => ({ id: "w-new", ...data }));
  });

  const base = { name: "CPU", symbol: "fgSysCpuUsage", mibId: "mib1", widgetType: "gauge" };

  it("requires a name, and a symbol + MIB on every non-http widget", async () => {
    await expect(createWidget("p1", { ...base, name: "  " })).rejects.toThrow("Widget name is required");
    await expect(createWidget("p1", { ...base, symbol: "" })).rejects.toThrow("symbol is required");
    await expect(createWidget("p1", { ...base, mibId: "" })).rejects.toThrow(/mibId is required/);
    await expect(createWidget("p1", { ...base, widgetType: "pie" })).rejects.toThrow(/Invalid widgetType/);
  });

  it("a gauge stores trimmed fields and nulls the state + http fields", async () => {
    const w = await createWidget("p1", { ...base, name: " CPU ", symbol: " fgSysCpuUsage ", stateMap: { mode: "zero" }, httpCheck: { path: "/" } });
    expect(w).toMatchObject({ id: "w-new", name: "CPU", symbol: "fgSysCpuUsage", type: "scalar", stateMap: null, httpCheck: null, credentialId: null });
    expect(h.validateHttpCheckDefinition).not.toHaveBeenCalled();
  });

  it("refuses a metric-row-only or unknown transform, and a pattern RE2 cannot compile", async () => {
    await expect(createWidget("p1", { ...base, transform: "nope" })).rejects.toThrow(/Invalid transform/);
    await expect(createWidget("p1", { ...base, modelPattern: "(?=FG)" })).rejects.toThrow(/modelPattern/);
    await expect(createWidget("p1", { ...base, type: "double_scalar" })).rejects.toThrow(/Invalid widget symbol type/);
  });

  it("a state probe needs a valid mapping and keeps a trimmed label symbol", async () => {
    await expect(createWidget("p1", { ...base, widgetType: "state", stateMap: { mode: "equals", values: [] } })).rejects.toThrow(/needs at least one comparison value/);
    const w = await createWidget("p1", { ...base, widgetType: "state", stateMap: { mode: "zero" }, labelSymbol: "  fgName " });
    expect(w.stateMap).toMatchObject({ mode: "zero" });
    expect(w.labelSymbol).toBe("fgName");
  });

  it("an http widget carries no OID, validates its check, and needs an http-typed, non-form credential", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "c1", type: "http", config: { authMode: "bearer" } });
    const w = await createWidget("p1", { name: "Health", symbol: "", mibId: "", widgetType: "http", httpCheck: { path: "/health" }, credentialId: "c1" });
    expect(w).toMatchObject({ symbol: null, mibId: null, httpCheck: { path: "/health" }, credentialId: "c1" });
    expect(h.validateHttpCheckDefinition).toHaveBeenCalledWith({ path: "/health" });

    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    await expect(createWidget("p1", { name: "H", symbol: "", mibId: "", widgetType: "http", credentialId: "gone" })).rejects.toThrow(/no longer exists/);
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "c2", type: "snmp", config: {} });
    await expect(createWidget("p1", { name: "H", symbol: "", mibId: "", widgetType: "http", credentialId: "c2" })).rejects.toThrow(/HTTP-typed credential/);
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "c3", type: "http", config: { authMode: "form" } });
    await expect(createWidget("p1", { name: "H", symbol: "", mibId: "", widgetType: "http", credentialId: "c3" })).rejects.toThrow(/device admin login/);
  });

  it("a check the credential test would refuse is refused at save too", async () => {
    h.validateHttpCheckDefinition.mockImplementation(() => { throw Object.assign(new Error("bad method"), { httpStatus: 400 }); });
    await expect(createWidget("p1", { name: "H", symbol: "", mibId: "", widgetType: "http", httpCheck: "nonsense" })).rejects.toThrow("bad method");
    expect(h.validateHttpCheckDefinition).toHaveBeenCalledWith({});
    expect(prisma.manufacturerCustomWidget.create).not.toHaveBeenCalled();
  });
});

describe("updateWidget — the EFFECTIVE type decides what survives", () => {
  const dataOf = () => stubbed(prisma.manufacturerCustomWidget.update).mock.calls[0]![0].data;

  beforeEach(() => {
    stubbed(prisma.manufacturerCustomWidget.update).mockImplementation(async ({ data }: any) => ({
      ...stateWidget("w1", "HA"),
      ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
    }));
  });

  it("404 for a missing widget", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue(null);
    await expect(updateWidget("nope", { name: "x" })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("a partial edit of a probe keeps its mapping (not written) and the http fields stay null", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue(stateWidget("w1", "HA"));
    await updateWidget("w1", { name: " HA 2 " });
    const d = dataOf();
    expect(d.name).toBe("HA 2");
    expect("stateMap" in d).toBe(false);
    expect(d.labelSymbol).toBeUndefined();
    expect(d.httpCheck).toBeNull();
  });

  it("flipping a probe to a gauge clears its mapping and label", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue(stateWidget("w1", "HA", { labelSymbol: "n" }));
    await updateWidget("w1", { widgetType: "gauge" });
    expect(dataOf()).toMatchObject({ stateMap: null, labelSymbol: null, widgetType: "gauge" });
  });

  it("a gauge becoming a probe must get a valid mapping", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue({ ...stateWidget("w1", "x"), widgetType: "gauge", stateMap: null });
    await expect(updateWidget("w1", { widgetType: "state", stateMap: { mode: "equals" } })).rejects.toThrow(/comparison value/);
    await updateWidget("w1", { widgetType: "state" });
    expect(dataOf().stateMap).toMatchObject({ mode: "nonzero" });
  });

  it("flipping to http clears the OID pair and validates the stored check", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue({ ...stateWidget("w1", "x"), widgetType: "gauge", httpCheck: { path: "/old" } });
    await updateWidget("w1", { widgetType: "http", symbol: "ignored" });
    expect(dataOf()).toMatchObject({ symbol: null, mibId: null, httpCheck: { path: "/old" }, credentialId: null });
  });

  it("flipping away from http clears the check and credential", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue({ ...stateWidget("w1", "x"), widgetType: "http", symbol: null, mibId: null, httpCheck: { path: "/" }, credentialId: "c1" });
    await updateWidget("w1", { widgetType: "value", symbol: " s ", mibId: "mib1" });
    expect(dataOf()).toMatchObject({ httpCheck: null, credentialId: null, symbol: "s", mibId: "mib1" });
  });
});

describe("rule 167(a) — deleting a widget an automation is narrowed to", () => {
  it("deleteWidget: missing is a no-op", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue(null);
    await deleteWidget("nope");
    expect(prisma.manufacturerCustomWidget.delete).not.toHaveBeenCalled();
  });

  it("deleteWidget: a referenced widget is a 409 naming it, and nothing is deleted", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue({ id: "w1", name: "PSU", profileId: "p1" });
    h.dimensionTargetReferrers.mockResolvedValue(["PSU alarm"]);
    await expect(deleteWidget("w1")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('Widget "PSU" is still named by PSU alarm. Point it') });
    expect(h.dimensionTargetReferrers).toHaveBeenCalledWith(["widgetId", "stateProbeId"], ["w1"]);
    expect(prisma.manufacturerCustomWidget.delete).not.toHaveBeenCalled();
  });

  it("deleteWidget: an unreferenced widget is deleted and the profile touched", async () => {
    stubbed(prisma.manufacturerCustomWidget.findUnique).mockResolvedValue({ id: "w1", name: "PSU", profileId: "p1" });
    await deleteWidget("w1");
    expect(prisma.manufacturerCustomWidget.delete).toHaveBeenCalledWith({ where: { id: "w1" } });
    expect(prisma.manufacturerProfile.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1" } }));
  });

  it("deleteProfile: one referrer read when nothing is named, then the delete", async () => {
    stubbed(prisma.manufacturerCustomWidget.findMany).mockResolvedValue([{ id: "w1", name: "A" }, { id: "w2", name: "B" }]);
    await deleteProfile("p1");
    expect(h.dimensionTargetReferrers).toHaveBeenCalledTimes(1);
    expect(h.dimensionTargetReferrers).toHaveBeenCalledWith(["widgetId", "stateProbeId"], ["w1", "w2"]);
    expect(prisma.manufacturerProfile.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("deleteProfile: a named widget refuses the whole delete with a 409 naming that widget (plural wording)", async () => {
    stubbed(prisma.manufacturerCustomWidget.findMany).mockResolvedValue([{ id: "w1", name: "A" }, { id: "w2", name: "B" }]);
    h.dimensionTargetReferrers.mockImplementation(async (_f: unknown, ids: readonly string[]) => (ids.includes("w2") ? ["r1", "r2"] : []));
    await expect(deleteProfile("p1")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('Widget "B" is still named by r1, r2. Point them') });
    expect(prisma.manufacturerProfile.delete).not.toHaveBeenCalled();
  });

  it("deleteProfile with no widgets never reads the automations", async () => {
    stubbed(prisma.manufacturerCustomWidget.findMany).mockResolvedValue([]);
    await deleteProfile("p1");
    expect(h.dimensionTargetReferrers).not.toHaveBeenCalled();
    expect(prisma.manufacturerProfile.delete).toHaveBeenCalled();
  });
});

describe("deleteOverride", () => {
  it("is a no-op for a missing row and touches the parent profile otherwise", async () => {
    stubbed(prisma.manufacturerProfileMetricOverride.findUnique).mockResolvedValue(null);
    await deleteOverride("nope");
    expect(prisma.manufacturerProfileMetricOverride.delete).not.toHaveBeenCalled();
    stubbed(prisma.manufacturerProfileMetricOverride.findUnique).mockResolvedValue({ id: "o1", metricRow: { profileId: "p9" } });
    await deleteOverride("o1");
    expect(prisma.manufacturerProfileMetricOverride.delete).toHaveBeenCalledWith({ where: { id: "o1" } });
    expect(prisma.manufacturerProfile.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p9" } }));
  });

  it("a failed updatedAt bump never fails the write", async () => {
    stubbed(prisma.manufacturerProfileMetricOverride.findUnique).mockResolvedValue({ id: "o1", metricRow: { profileId: "p9" } });
    stubbed(prisma.manufacturerProfile.update).mockRejectedValue(new Error("gone"));
    await expect(deleteOverride("o1")).resolves.toBeUndefined();
  });
});
