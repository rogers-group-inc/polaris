/**
 * tests/unit/manufacturerProfilePortabilityService.test.ts — the own suite for
 * src/services/manufacturerProfilePortabilityService.ts (CQ-T010).
 *
 * Complements manufacturerProfilePortability.test.ts (one happy path per
 * export / preview / apply / View Code save). Adds the edges:
 *   - parseProfileFile: format / version / field-level refusals (400 + path);
 *   - exportProfile: 404, unconfigured metric rows dropped, MIB dedupe, a
 *     credential that no longer exists, layout entries for unknown widgets,
 *     no layout, the exportedAt timestamp vs the View Code form;
 *   - previewProfileImport: create vs replace per kind, the MIB resolver's
 *     manufacturer / model / generic fallbacks, an http widget never needing a
 *     MIB, an empty layout offered as nothing, labels;
 *   - applyProfileImport: a new profile vs the existing one, override clash →
 *     update, the legacy fgHwSensorTable upgrade (rule 132), credential by
 *     name, a widget without its MIB failing alone, the layout remapped to the
 *     saved widget ids, the audit Event (info / warning);
 *   - saveProfileCode: every pre-write refusal, matchPattern untouched when
 *     equal, a metric left out cleared, an override with a foreign id created,
 *     the 167(a) guard called with the dropped widgets, the error wrapping
 *     (status kept, 500 for a non-AppError), the audit Event.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const svc = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getProfileFor: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  updateMetricRow: vi.fn(),
  createOverride: vi.fn(),
  updateOverride: vi.fn(),
  deleteOverride: vi.fn(),
  createWidget: vi.fn(),
  updateWidget: vi.fn(),
  deleteWidget: vi.fn(),
  assertWidgetsUnreferenced: vi.fn(),
  setWidgetLayout: vi.fn(),
  refreshProfileCache: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/manufacturerProfileService.js", () => svc);
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { FORTIGATE_SENSOR_COLUMNS } from "../../src/services/vendorTelemetryProfiles.js";
import {
  parseProfileFile,
  exportProfile,
  previewProfileImport,
  applyProfileImport,
  saveProfileCode,
  type ProfileFile,
} from "../../src/services/manufacturerProfilePortabilityService.js";

// ─── fixtures ───────────────────────────────────────────────────────────────

const metricRow = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `m-${key}`, metricKey: key, defaultSymbol: null, defaultSymbolB: null, defaultMibId: null, defaultMibStdKey: null,
  defaultType: "scalar", defaultTransform: null, defaultAggregate: null, defaultLabel: null, defaultParsePattern: null,
  defaultParseTemplate: null, defaultSensorColumns: null, overrides: [] as any[], ...extra,
});
const overrideRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, assetType: "ups", modelPattern: null, symbol: "s", symbolB: null, mibId: null, mibStdKey: null, type: "scalar",
  transform: null, aggregate: null, label: null, parsePattern: null, parseTemplate: null, sensorColumns: null, order: 0, ...extra,
});
const widgetRow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, symbol: "sym", mibId: "mib-1", type: "scalar", widgetType: "gauge", transform: null, displayOptions: {},
  order: 0, modelPattern: null, stateMap: null, labelSymbol: null, httpCheck: null, credentialId: null, ...extra,
});
const profileOf = (extra: Record<string, unknown> = {}) => ({
  id: "p1", manufacturer: "APC", matchPattern: null, widgetLayout: null,
  metrics: [metricRow("cpu"), metricRow("temperature")], widgets: [] as any[], ...extra,
});

const mib = (moduleName: string, manufacturer: string | null = "APC", model: string | null = null) => ({ moduleName, manufacturer, model });
const fileMetric = (key: string, extra: Record<string, unknown> = {}) => ({
  metricKey: key, symbol: null, symbolB: null, mib: null, mibStdKey: null, type: "scalar", transform: null,
  aggregate: null, label: null, parsePattern: null, parseTemplate: null, overrides: [] as any[], ...extra,
});
const fileOverride = (extra: Record<string, unknown> = {}) => ({
  symbol: "s", symbolB: null, mib: null, mibStdKey: null, type: "scalar", transform: null, aggregate: null, label: null,
  parsePattern: null, parseTemplate: null, assetType: "ups", modelPattern: null, order: 0, ...extra,
});
const fileWidget = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  key, name, symbol: "sym", mib: mib("PowerNet-MIB"), type: "scalar", widgetType: "gauge", transform: null,
  displayOptions: {}, order: 0, modelPattern: null, stateMap: null, labelSymbol: null, httpCheck: null, credential: null, ...extra,
});
const fileOf = (extra: Partial<Record<keyof ProfileFile, unknown>> = {}): ProfileFile => ({
  format: "polaris.manufacturer-profile", version: 1, manufacturer: "APC", matchPattern: null,
  mibs: [], metrics: [], widgets: [], layout: null, ...extra,
}) as ProfileFile;

const MIB_ROWS = [
  { id: "mib-1", moduleName: "PowerNet-MIB", manufacturer: "APC", model: null },
  { id: "mib-model", moduleName: "PowerNet-MIB", manufacturer: "APC", model: "Smart-UPS" },
  { id: "mib-generic", moduleName: "IF-MIB", manufacturer: null, model: null },
];

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(svc)) f.mockReset();
  svc.refreshProfileCache.mockResolvedValue(undefined);
  svc.assertWidgetsUnreferenced.mockResolvedValue(undefined);
  svc.getProfileFor.mockReturnValue(null);
  svc.createProfile.mockResolvedValue({ id: "p-new" });
  svc.getProfile.mockResolvedValue(profileOf());
  svc.createOverride.mockResolvedValue({ id: "o-new" });
  svc.createWidget.mockImplementation(async (_p: string, i: any) => ({ id: `wid-${i.name}` }));
  svc.updateWidget.mockImplementation(async (id: string) => ({ id }));
  stubbed(prisma.mibFile.findMany).mockResolvedValue(MIB_ROWS);
  stubbed(prisma.credential.findMany).mockResolvedValue([{ id: "cred-1", name: "UPS Web" }]);
});

// ─── parseProfileFile ───────────────────────────────────────────────────────

describe("parseProfileFile", () => {
  it("accepts a minimal valid file", () => {
    expect(parseProfileFile(fileOf()).manufacturer).toBe("APC");
  });
  it.each([
    ["a non-object", "nope"],
    ["the wrong format", { ...fileOf(), format: "polaris.automation" }],
    ["the wrong version", { ...fileOf(), version: 2 }],
    ["an empty manufacturer", { ...fileOf(), manufacturer: "" }],
  ])("refuses %s with a 400", (_l, raw) => {
    expect(() => parseProfileFile(raw)).toThrow(AppError);
    try { parseProfileFile(raw); } catch (e) { expect((e as AppError).httpStatus).toBe(400); }
  });
  it("names the path of a nested problem", () => {
    expect(() => parseProfileFile(fileOf({ metrics: [{ ...fileMetric("cpu"), overrides: [{ ...fileOverride(), symbol: "" }] }] })))
      .toThrow(/\(at metrics\.0\.overrides\.0\.symbol\)/);
  });
  it("starts every message with the file-kind sentence", () => {
    expect(() => parseProfileFile({})).toThrow(/^Not a Polaris manufacturer profile file: /);
  });
  it("accepts a file exported before rule 132 (no sensorColumns)", () => {
    expect(() => parseProfileFile(fileOf({ metrics: [fileMetric("temperature", { symbol: "x" })] }))).not.toThrow();
  });
});

// ─── exportProfile ──────────────────────────────────────────────────────────

describe("exportProfile", () => {
  it("404s on an unknown profile", async () => {
    svc.getProfile.mockResolvedValue(null);
    await expect(exportProfile("nope")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("drops unconfigured metric rows and keeps one with only overrides", async () => {
    svc.getProfile.mockResolvedValue(profileOf({
      metrics: [metricRow("cpu"), metricRow("memory", { defaultSymbolB: "b" }), metricRow("temperature", { overrides: [overrideRow("o1")] })],
    }));
    stubbed(prisma.mibFile.findMany).mockResolvedValue([]);
    stubbed(prisma.credential.findMany).mockResolvedValue([]);
    const f = await exportProfile("p1");
    expect(f.metrics.map((m) => m.metricKey)).toEqual(["memory", "temperature"]);
  });

  it("names MIBs by module and dedupes them case-insensitively; queries only referenced ids", async () => {
    svc.getProfile.mockResolvedValue(profileOf({
      metrics: [metricRow("cpu", { defaultSymbol: "x", defaultMibId: "a", overrides: [overrideRow("o1", { mibId: "b" })] })],
      widgets: [widgetRow("w1", "W", { mibId: "a" })],
    }));
    stubbed(prisma.mibFile.findMany).mockResolvedValue([
      { id: "a", moduleName: "X-MIB", manufacturer: "APC", model: null },
      { id: "b", moduleName: "x-mib", manufacturer: "apc", model: null },
    ]);
    stubbed(prisma.credential.findMany).mockResolvedValue([]);
    const f = await exportProfile("p1");
    expect(stubbed(prisma.mibFile.findMany).mock.calls[0][0].where.id.in.sort()).toEqual(["a", "b"]);
    expect(f.mibs).toHaveLength(1);
    expect(f.metrics[0].mib).toEqual({ moduleName: "X-MIB", manufacturer: "APC", model: null });
    expect(f.metrics[0].overrides[0].mib).toEqual({ moduleName: "x-mib", manufacturer: "apc", model: null });
  });

  it("a MIB id with no row exports as null", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ metrics: [metricRow("cpu", { defaultSymbol: "x", defaultMibId: "gone" })] }));
    stubbed(prisma.mibFile.findMany).mockResolvedValue([]);
    stubbed(prisma.credential.findMany).mockResolvedValue([]);
    expect((await exportProfile("p1")).metrics[0].mib).toBeNull();
  });

  it("names a credential, nulls a deleted one, and keys widgets w1..wN", async () => {
    svc.getProfile.mockResolvedValue(profileOf({
      widgets: [widgetRow("wa", "A", { credentialId: "cred-1" }), widgetRow("wb", "B", { credentialId: "deleted" }), widgetRow("wc", "C", { displayOptions: null })],
    }));
    const f = await exportProfile("p1");
    expect(f.widgets.map((w) => [w.key, w.credential])).toEqual([["w1", { name: "UPS Web" }], ["w2", null], ["w3", null]]);
    expect(f.widgets[2].displayOptions).toEqual({});
  });

  it("maps the layout to keys and drops entries for widgets that are gone", async () => {
    svc.getProfile.mockResolvedValue(profileOf({
      widgets: [widgetRow("wa", "A")],
      widgetLayout: { version: 1, columns: [{ id: "c1", width: 6, widgets: [{ id: "wa", height: 2 }, { id: "ghost", height: 1 }] }] },
    }));
    expect((await exportProfile("p1")).layout).toEqual({ version: 1, columns: [{ id: "c1", width: 6, widgets: [{ key: "w1", height: 2 }] }] });
  });

  it("no stored layout exports null", async () => {
    expect((await exportProfile("p1")).layout).toBeNull();
  });

  it("an export carries exportedAt and no ids; withIds carries ids and no timestamp", async () => {
    svc.getProfile.mockResolvedValue(profileOf({
      metrics: [metricRow("cpu", { overrides: [overrideRow("o1")] })],
      widgets: [widgetRow("wa", "A")],
    }));
    const plain = await exportProfile("p1");
    expect(typeof plain.exportedAt).toBe("string");
    expect("id" in plain.widgets[0]).toBe(false);
    expect("id" in plain.metrics[0].overrides[0]).toBe(false);
    const code = await exportProfile("p1", { withIds: true });
    expect("exportedAt" in code).toBe(false);
    expect(code.widgets[0].id).toBe("wa");
    expect(code.metrics[0].overrides[0].id).toBe("o1");
  });

  it("the export round-trips through parseProfileFile", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ metrics: [metricRow("cpu", { defaultSymbol: "x", defaultMibId: "mib-1" })], widgets: [widgetRow("wa", "A")] }));
    const f = await exportProfile("p1");
    expect(parseProfileFile(JSON.parse(JSON.stringify(f)))).toEqual(JSON.parse(JSON.stringify(f)));
  });
});

// ─── previewProfileImport ───────────────────────────────────────────────────

describe("previewProfileImport", () => {
  it("into no existing profile: settings create, target null, cache refreshed first", async () => {
    const p = await previewProfileImport(fileOf({ manufacturer: "  APC  " }));
    expect(svc.refreshProfileCache).toHaveBeenCalled();
    expect(svc.getProfileFor).toHaveBeenCalledWith("APC");
    expect(p).toMatchObject({ manufacturer: "APC", targetProfileId: null });
    expect(p.items).toEqual([{ id: "settings", kind: "settings", label: "Profile settings", action: "create", missingMibs: [], missingCredential: null, blocked: null }]);
  });

  it("labels the settings item with the match pattern; replaces into an existing profile", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    const p = await previewProfileImport(fileOf({ matchPattern: "Schneider" }));
    expect(p.targetProfileId).toBe("p1");
    expect(p.items[0]).toMatchObject({ action: "replace", label: 'Profile settings ("also applies when" Schneider)' });
  });

  it("a metric with no symbol is not an item; its overrides still are", async () => {
    const p = await previewProfileImport(fileOf({ metrics: [fileMetric("cpu", { overrides: [fileOverride()] })] }));
    expect(p.items.map((i) => i.id)).toEqual(["settings", "override:cpu:0"]);
  });

  it("metric label joins both symbols; replace only when the row is configured", async () => {
    svc.getProfileFor.mockReturnValue(profileOf({ metrics: [metricRow("cpu", { defaultSymbol: "x" }), metricRow("memory")] }));
    const p = await previewProfileImport(fileOf({ metrics: [fileMetric("cpu", { symbol: "a", symbolB: "b" }), fileMetric("memory", { symbol: "m" })] }));
    expect(p.items.filter((i) => i.kind === "metric").map((i) => [i.label, i.action])).toEqual([
      ["cpu — a + b", "replace"],
      ["memory — m", "create"],
    ]);
  });

  it("an override replaces on the same scope (asset type case-insensitive) and labels its scope", async () => {
    svc.getProfileFor.mockReturnValue(profileOf({ metrics: [metricRow("cpu", { overrides: [overrideRow("o1", { assetType: "UPS", modelPattern: "SMT.*" })] })] }));
    const p = await previewProfileImport(fileOf({
      metrics: [fileMetric("cpu", { overrides: [
        fileOverride({ assetType: "ups", modelPattern: "SMT.*" }),
        fileOverride({ assetType: "ups", modelPattern: null }),
        fileOverride({ assetType: null, modelPattern: "X" }),
      ] })],
    }));
    expect(p.items.filter((i) => i.kind === "override").map((i) => [i.label, i.action])).toEqual([
      ["cpu — ups / SMT.*", "replace"],
      ["cpu — ups default", "create"],
      ["cpu — X", "create"],
    ]);
  });

  it("the MIB resolver: same manufacturer, the file's manufacturer, then a generic upload", async () => {
    const p = await previewProfileImport(fileOf({
      mibs: [mib("PowerNet-MIB"), mib("powernet-mib", "Schneider"), mib("IF-MIB", "Cisco"), mib("NOPE-MIB")],
    }));
    expect(p.mibs.map((m) => m.present)).toEqual([true, true, true, false]);
  });

  it("a model-specific file reference falls back to the manufacturer-wide copy", async () => {
    stubbed(prisma.mibFile.findMany).mockResolvedValue([MIB_ROWS[0]]);
    const p = await previewProfileImport(fileOf({ mibs: [mib("PowerNet-MIB", "APC", "Other-Model")] }));
    expect(p.mibs[0].present).toBe(true);
  });

  it("only a model-specific copy does not satisfy a different model", async () => {
    stubbed(prisma.mibFile.findMany).mockResolvedValue([MIB_ROWS[1]]);
    const p = await previewProfileImport(fileOf({ mibs: [mib("PowerNet-MIB", "APC", null)] }));
    expect(p.mibs[0].present).toBe(false);
  });

  it("a widget whose MIB is missing is blocked; an http widget never is", async () => {
    const p = await previewProfileImport(fileOf({
      widgets: [
        fileWidget("w1", "Temp", { mib: mib("NOPE-MIB") }),
        fileWidget("w2", "Web", { widgetType: "http", mib: mib("NOPE-MIB") }),
      ],
    }));
    const [a, b] = p.items.filter((i) => i.kind === "widget");
    expect(a).toMatchObject({ id: "widget:w1", label: "Temp (gauge)", blocked: "Upload NOPE-MIB first", missingMibs: [mib("NOPE-MIB")] });
    expect(b).toMatchObject({ blocked: null, missingMibs: [] });
  });

  it("flags an unmatched credential name (case-insensitive match passes)", async () => {
    const p = await previewProfileImport(fileOf({
      widgets: [
        fileWidget("w1", "A", { credential: { name: "ups web" } }),
        fileWidget("w2", "B", { credential: { name: "Gone" } }),
      ],
    }));
    expect(p.items.filter((i) => i.kind === "widget").map((i) => i.missingCredential)).toEqual([null, "Gone"]);
  });

  it("a widget with the same name (case-insensitive) replaces", async () => {
    svc.getProfileFor.mockReturnValue(profileOf({ widgets: [widgetRow("wa", "ups status")] }));
    const p = await previewProfileImport(fileOf({ widgets: [fileWidget("w1", "UPS Status")] }));
    expect(p.items.find((i) => i.kind === "widget")!.action).toBe("replace");
  });

  it("a layout with columns is offered; an empty one is not", async () => {
    const layout = { version: 1, columns: [{ id: "c", width: 6, widgets: [] }] };
    expect((await previewProfileImport(fileOf({ layout }))).items.map((i) => i.id)).toContain("layout");
    expect((await previewProfileImport(fileOf({ layout: { version: 1, columns: [] } }))).items.map((i) => i.id)).not.toContain("layout");
  });

  it("a bad file is refused before any read", async () => {
    await expect(previewProfileImport({ format: "x" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(svc.refreshProfileCache).not.toHaveBeenCalled();
  });
});

// ─── applyProfileImport ─────────────────────────────────────────────────────

describe("applyProfileImport", () => {
  it("creates the profile for a new manufacturer, attributed to the actor", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ id: "p-new" }));
    const r = await applyProfileImport(fileOf({ matchPattern: "x" }), ["settings"], "alice");
    expect(svc.createProfile).toHaveBeenCalledWith({ manufacturer: "APC", createdBy: "alice" });
    expect(svc.updateProfile).toHaveBeenCalledWith("p-new", { matchPattern: "x" });
    expect(r).toEqual({ profileId: "p-new", results: [{ id: "settings", ok: true }] });
  });

  it("reuses the existing profile", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    const r = await applyProfileImport(fileOf(), ["settings"]);
    expect(svc.createProfile).not.toHaveBeenCalled();
    expect(r.profileId).toBe("p1");
  });

  it("unticked items are not written (but a new profile is still created)", async () => {
    const r = await applyProfileImport(fileOf({ metrics: [fileMetric("cpu", { symbol: "x" })] }), []);
    expect(r.results).toEqual([]);
    expect(svc.updateProfile).not.toHaveBeenCalled();
    expect(svc.updateMetricRow).not.toHaveBeenCalled();
    expect(svc.createProfile).toHaveBeenCalledTimes(1);
  });

  it("a metric row is written with the resolved MIB id", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    await applyProfileImport(fileOf({ metrics: [fileMetric("cpu", { symbol: "x", mib: mib("PowerNet-MIB"), sensorColumns: undefined })] }), ["metric:cpu"]);
    expect(svc.updateMetricRow).toHaveBeenCalledWith("p1", "cpu", expect.objectContaining({ defaultSymbol: "x", defaultMibId: "mib-1", defaultSensorColumns: null }));
  });

  it("upgrades a legacy fgHwSensorTable temperature table row (rule 132)", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    await applyProfileImport(fileOf({
      metrics: [fileMetric("temperature", { symbol: "FGHWSENSORTABLE", type: "table", overrides: [fileOverride({ symbol: "fgHwSensorTable", type: "table" })] })],
    }), ["metric:temperature", "override:temperature:0"]);
    expect(svc.updateMetricRow.mock.calls[0][2]).toMatchObject({ defaultSymbol: "fgHwSensorEntValue", defaultSensorColumns: FORTIGATE_SENSOR_COLUMNS });
    expect(svc.createOverride.mock.calls[0][2]).toMatchObject({ symbol: "fgHwSensorEntValue", sensorColumns: FORTIGATE_SENSOR_COLUMNS });
  });

  it("does not upgrade a non-temperature, non-table or already-columned row", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    const cols = { nameSymbol: "n" };
    await applyProfileImport(fileOf({
      metrics: [
        fileMetric("cpu", { symbol: "fgHwSensorTable", type: "table" }),
        fileMetric("temperature", { symbol: "fgHwSensorTable", type: "scalar" }),
      ],
    }), ["metric:cpu", "metric:temperature"]);
    expect(svc.updateMetricRow.mock.calls.map((c) => c[2].defaultSymbol)).toEqual(["fgHwSensorTable", "fgHwSensorTable"]);
    svc.updateMetricRow.mockClear();
    await applyProfileImport(fileOf({ metrics: [fileMetric("temperature", { symbol: "fgHwSensorTable", type: "table", sensorColumns: cols })] }), ["metric:temperature"]);
    expect(svc.updateMetricRow.mock.calls[0][2]).toMatchObject({ defaultSymbol: "fgHwSensorTable", defaultSensorColumns: cols });
  });

  it("an override with a clashing scope updates that row; otherwise creates", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    svc.getProfile.mockResolvedValue(profileOf({ metrics: [metricRow("cpu", { overrides: [overrideRow("o1", { assetType: "UPS" })] })] }));
    await applyProfileImport(fileOf({
      metrics: [fileMetric("cpu", { overrides: [fileOverride({ assetType: "ups" }), fileOverride({ assetType: "pdu" })] })],
    }), ["override:cpu:0", "override:cpu:1"]);
    expect(svc.updateOverride).toHaveBeenCalledWith("o1", expect.objectContaining({ assetType: "ups" }));
    expect(svc.createOverride).toHaveBeenCalledWith("p1", "cpu", expect.objectContaining({ assetType: "pdu" }));
  });

  it("a widget without its MIB fails alone with a 400 message; the rest continue", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    const r = await applyProfileImport(fileOf({
      widgets: [fileWidget("w1", "Bad", { mib: mib("NOPE-MIB") }), fileWidget("w2", "Good")],
    }), ["widget:w1", "widget:w2"], "bob");
    expect(r.results).toEqual([
      { id: "widget:w1", ok: false, error: "MIB NOPE-MIB is not uploaded on this install" },
      { id: "widget:w2", ok: true },
    ]);
    expect(svc.createWidget).toHaveBeenCalledWith("p1", expect.objectContaining({ name: "Good", mibId: "mib-1", createdBy: "bob" }));
  });

  it("a widget with the same name updates; an http widget needs no MIB; the credential resolves by name", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    svc.getProfile.mockResolvedValue(profileOf({ widgets: [widgetRow("wa", "web ui")] }));
    await applyProfileImport(fileOf({
      widgets: [fileWidget("w1", "Web UI", { widgetType: "http", mib: null, credential: { name: "UPS WEB" } })],
    }), ["widget:w1"]);
    expect(svc.updateWidget).toHaveBeenCalledWith("wa", expect.objectContaining({ mibId: null, credentialId: "cred-1" }));
  });

  it("an unknown credential imports unauthenticated", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    await applyProfileImport(fileOf({ widgets: [fileWidget("w1", "A", { credential: { name: "nope" } })] }), ["widget:w1"]);
    expect(svc.createWidget.mock.calls[0][1].credentialId).toBeNull();
  });

  it("the layout is remapped to saved / existing widget ids and drops unknown keys", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    svc.getProfile.mockResolvedValue(profileOf({ widgets: [widgetRow("wa", "Existing")] }));
    await applyProfileImport(fileOf({
      widgets: [fileWidget("k1", "Existing"), fileWidget("k2", "New")],
      layout: { version: 1, columns: [{ id: "c1", width: 6, widgets: [{ key: "k1", height: 1 }, { key: "k2", height: 2 }, { key: "zz", height: 3 }] }] },
    }), ["widget:k2", "layout"]);
    expect(svc.setWidgetLayout).toHaveBeenCalledWith("p1", {
      version: 1,
      columns: [{ id: "c1", width: 6, widgets: [{ id: "wa", height: 1 }, { id: "wid-New", height: 2 }] }],
    });
  });

  it("writes manufacturer_profile.imported at info when everything worked", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    await applyProfileImport(fileOf(), ["settings"], "alice");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toEqual({
      action: "manufacturer_profile.imported",
      resourceType: "manufacturer_profile",
      resourceId: "p1",
      resourceName: "APC",
      actor: "alice",
      level: "info",
      message: "Imported 1 of 1 selected item(s) into the APC manufacturer profile",
      details: { results: [{ id: "settings", ok: true }] },
    });
  });

  it("the Event is a warning when an item failed and says (new profile) for a created one", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ id: "p-new" }));
    svc.updateProfile.mockRejectedValue(new AppError(400, "bad regex"));
    const r = await applyProfileImport(fileOf(), ["settings"]);
    expect(r.results).toEqual([{ id: "settings", ok: false, error: "bad regex" }]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      level: "warning",
      message: "Imported 0 of 1 selected item(s) into the APC manufacturer profile (new profile)",
    });
  });

  it("a non-Error throw is stringified", async () => {
    svc.getProfileFor.mockReturnValue(profileOf());
    svc.updateProfile.mockRejectedValue("plain");
    expect((await applyProfileImport(fileOf(), ["settings"])).results[0]).toEqual({ id: "settings", ok: false, error: "plain" });
  });
});

// ─── saveProfileCode ────────────────────────────────────────────────────────

describe("saveProfileCode", () => {
  it("404s on an unknown profile", async () => {
    svc.getProfile.mockResolvedValue(null);
    await expect(saveProfileCode("nope", fileOf())).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("refuses another manufacturer", async () => {
    await expect(saveProfileCode("p1", fileOf({ manufacturer: "Eaton" }))).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringContaining('This is the APC profile — "manufacturer" can\'t be changed here'),
    });
  });

  it("accepts the same manufacturer in another case", async () => {
    await expect(saveProfileCode("p1", fileOf({ manufacturer: "apc" }))).resolves.toEqual({ changes: [] });
  });

  it("refuses an unknown metric key, naming the allowed ones", async () => {
    await expect(saveProfileCode("p1", fileOf({ metrics: [fileMetric("fanSpeed")] }))).rejects.toThrow('Unknown metric "fanSpeed" — expected one of cpu, temperature');
  });

  it("refuses missing MIBs (deduped by module), ignoring http widgets", async () => {
    await expect(saveProfileCode("p1", fileOf({
      metrics: [fileMetric("cpu", { mib: mib("NOPE-MIB"), overrides: [fileOverride({ mib: mib("NOPE-MIB") })] })],
      widgets: [fileWidget("w1", "Web", { widgetType: "http", mib: mib("OTHER-MIB") })],
    }))).rejects.toThrow("MIB not uploaded on this install: NOPE-MIB — upload it or remove the reference");
  });

  it("refuses a non-http widget with no MIB", async () => {
    await expect(saveProfileCode("p1", fileOf({ widgets: [fileWidget("w1", "Temp", { mib: null })] }))).rejects.toThrow('Widget "Temp" needs a "mib"');
  });

  it("refuses an unknown credential", async () => {
    await expect(saveProfileCode("p1", fileOf({ widgets: [fileWidget("w1", "A", { credential: { name: "Gone" } })] }))).rejects.toThrow('No credential named "Gone" (widget "A")');
  });

  it("every refusal happens before any write", async () => {
    await saveProfileCode("p1", fileOf({ manufacturer: "Eaton" })).catch(() => {});
    await saveProfileCode("p1", fileOf({ metrics: [fileMetric("bad")] })).catch(() => {});
    for (const f of [svc.updateProfile, svc.updateMetricRow, svc.createWidget, svc.deleteWidget, svc.setWidgetLayout]) expect(f).not.toHaveBeenCalled();
  });

  it("the rule 167(a) guard sees exactly the widgets the file drops, before any write", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ widgets: [widgetRow("wa", "Keep"), widgetRow("wb", "Drop")] }));
    svc.assertWidgetsUnreferenced.mockRejectedValue(new AppError(409, "referenced"));
    await expect(saveProfileCode("p1", fileOf({ widgets: [fileWidget("k", "Keep", { id: "wa" })] }))).rejects.toMatchObject({ httpStatus: 409 });
    expect(svc.assertWidgetsUnreferenced).toHaveBeenCalledWith([{ id: "wb", name: "Drop" }]);
    expect(svc.deleteWidget).not.toHaveBeenCalled();
  });

  it("an unchanged matchPattern is not written", async () => {
    await saveProfileCode("p1", fileOf({ matchPattern: null }));
    expect(svc.updateProfile).not.toHaveBeenCalled();
  });

  it("a changed matchPattern is written and listed", async () => {
    expect((await saveProfileCode("p1", fileOf({ matchPattern: "Schneider" }))).changes).toEqual(["settings"]);
  });

  it("a configured metric left out is cleared back to the seed", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ metrics: [metricRow("cpu", { defaultSymbol: "x" }), metricRow("temperature")] }));
    const r = await saveProfileCode("p1", fileOf());
    expect(svc.updateMetricRow).toHaveBeenCalledTimes(1);
    expect(svc.updateMetricRow.mock.calls[0][2]).toMatchObject({ defaultSymbol: null, defaultMibId: null, defaultSensorColumns: null });
    expect(r.changes).toEqual(["cleared metric cpu"]);
  });

  it("an override whose id belongs to another profile is created, and the old one deleted", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ metrics: [metricRow("cpu", { overrides: [overrideRow("o1")] })] }));
    const r = await saveProfileCode("p1", fileOf({ metrics: [fileMetric("cpu", { overrides: [fileOverride({ id: "foreign" })] })] }));
    expect(svc.updateOverride).not.toHaveBeenCalled();
    expect(svc.createOverride).toHaveBeenCalledTimes(1);
    expect(svc.deleteOverride).toHaveBeenCalledWith("o1");
    expect(r.changes).toEqual(["added cpu override", "deleted cpu override"]);
  });

  it("the layout is written (null when the file has none) with ids remapped", async () => {
    svc.getProfile.mockResolvedValue(profileOf({ widgets: [widgetRow("wa", "A")] }));
    await saveProfileCode("p1", fileOf({
      widgets: [fileWidget("k1", "A", { id: "wa" })],
      layout: { version: 1, columns: [{ id: "c", width: 4, widgets: [{ key: "k1", height: 1 }, { key: "x", height: 1 }] }] },
    }));
    expect(svc.setWidgetLayout).toHaveBeenLastCalledWith("p1", { version: 1, columns: [{ id: "c", width: 4, widgets: [{ id: "wa", height: 1 }] }] });
    await saveProfileCode("p1", fileOf({ widgets: [fileWidget("k1", "A", { id: "wa" })] }));
    expect(svc.setWidgetLayout).toHaveBeenLastCalledWith("p1", null);
  });

  it("a refusal part-way keeps the status and says earlier changes were kept", async () => {
    svc.createWidget.mockRejectedValue(new AppError(422, "bad regex"));
    await expect(saveProfileCode("p1", fileOf({ matchPattern: "x", widgets: [fileWidget("k", "A")] }))).rejects.toMatchObject({
      httpStatus: 422,
      message: "bad regex — the changes before this point were saved",
    });
    expect(svc.refreshProfileCache).toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a non-AppError failure with no prior change is a bare 500", async () => {
    svc.setWidgetLayout.mockRejectedValue(new Error("db down"));
    await expect(saveProfileCode("p1", fileOf())).rejects.toMatchObject({ httpStatus: 500, message: "db down" });
  });

  it("writes manufacturer_profile.code_saved with the change list", async () => {
    await saveProfileCode("p1", fileOf({ matchPattern: "x" }), "carol");
    expect(eventLog.logEvent.mock.calls[0][0]).toEqual({
      action: "manufacturer_profile.code_saved",
      resourceType: "manufacturer_profile",
      resourceId: "p1",
      resourceName: "APC",
      actor: "carol",
      level: "info",
      message: "APC manufacturer profile saved from View Code",
      details: { changes: ["settings"] },
    });
  });
});
