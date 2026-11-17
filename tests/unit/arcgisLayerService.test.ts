/**
 * tests/unit/arcgisLayerService.test.ts — ArcGIS layers read for the Device
 * Map (business rule 188): URL and filter checks, the layer hosts that count
 * as a rule-111 destination, the saved-list checks, bbox parsing and snapping,
 * and — through arcgisService's request seam — reading a layer, searching the
 * portal, listing a service's layers and querying features (by bbox, by id,
 * cached, generalised). Synthetic data only.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const LINE = "6d1f3a52-7c1e-4d4b-9a0e-2f5b8c9d0e11";
const m = vi.hoisted(() => ({ integration: { findMany: vi.fn() } }));
vi.mock("../../src/db.js", () => ({ prisma: m }));

const svc = await import("../../src/services/arcgisLayerService.js");
const { _setRequestImplForTests } = await import("../../src/services/arcgisService.js");

type Req = { url: string; method: string; form?: Record<string, string> };
let calls: Req[] = [];
let answer: (r: Req) => unknown = () => ({});
function seam(): void {
  _setRequestImplForTests(async (r) => {
    calls.push(r);
    return { status: 200, body: JSON.stringify(answer(r)) };
  });
}
afterAll(() => _setRequestImplForTests(null));

const LAYER = {
  id: LINE, url: "https://services1.arcgis.com/abc/arcgis/rest/services/Fiber/FeatureServer/0", title: "Fiber Routes",
  geometry: "line" as const, idField: "GlobalID", labelField: "NAME", popupFields: [{ name: "COUNT", alias: "Fibers" }],
  style: { color: "accent" as const, width: 3, dash: "solid" as const },
};

beforeEach(() => {
  calls = [];
  svc.clearFeatureCache();
  seam();
  m.integration.findMany.mockResolvedValue([{ config: { portalUrl: "https://www.arcgis.com", authMode: "none", layers: [LAYER] } }]);
});

describe("layerUrlProblem", () => {
  it("takes one layer of an https feature or map service", () => {
    expect(svc.layerUrlProblem(LAYER.url)).toBeNull();
    expect(svc.layerUrlProblem("https://gis.example.test/server/rest/services/X/MapServer/3/")).toBeNull();
  });
  it("refuses http, credentials, a query, a service root and a blocked host", () => {
    expect(svc.layerUrlProblem("http://gis.example.test/x/FeatureServer/0")).toMatch(/https/);
    expect(svc.layerUrlProblem("https://u:p@gis.example.test/x/FeatureServer/0")).toMatch(/credentials/);
    expect(svc.layerUrlProblem("https://gis.example.test/x/FeatureServer/0?token=1")).toMatch(/query/);
    expect(svc.layerUrlProblem("https://gis.example.test/x/FeatureServer")).toMatch(/one layer/);
    expect(svc.layerUrlProblem("https://169.254.169.254/x/FeatureServer/0")).toMatch(/blocked/);
  });
});

describe("whereProblem", () => {
  it("passes a plain clause and refuses ';' and control characters", () => {
    expect(svc.whereProblem("STATUS = 'In service'")).toBeNull();
    expect(svc.whereProblem("1=1; DROP")).toMatch(/';'/);
    expect(svc.whereProblem("a = 1\nb")).toMatch(/control/);
    expect(svc.whereProblem("x".repeat(501))).toMatch(/at most/);
  });
});

describe("layerHosts (rule 111)", () => {
  it("leaves out the portal's own host and, for ArcGIS Online, Esri's *.arcgis.com", () => {
    expect(svc.layerHosts({ portalUrl: "https://www.arcgis.com", layers: [LAYER] })).toEqual([]);
    expect(svc.layerHosts({ portalUrl: "https://gis.example.test/portal", layers: [
      { ...LAYER, url: "https://gis.example.test/server/rest/services/A/FeatureServer/0" },
      { ...LAYER, url: "https://Other.Example.test/server/rest/services/B/FeatureServer/0" },
      { ...LAYER, url: "https://services1.arcgis.com/abc/arcgis/rest/services/C/FeatureServer/0" },
    ] })).toEqual(["other.example.test", "services1.arcgis.com"]);
  });
});

describe("layersProblem", () => {
  it("accepts a good list and names the first problem otherwise", () => {
    expect(svc.layersProblem([LAYER])).toBeNull();
    expect(svc.layersProblem([LAYER, { ...LAYER }])).toMatch(/share an id/);
    expect(svc.layersProblem([LAYER, { ...LAYER, id: "11111111-2222-4333-8444-555555555555" }])).toMatch(/listed twice/);
    expect(svc.layersProblem([{ ...LAYER, idField: "bad name" }])).toMatch(/not a field name/);
    expect(svc.layersProblem([{ ...LAYER, where: "a;b" }])).toMatch(/';'/);
  });
});

describe("parseBbox / snapBbox", () => {
  it("parses west,south,east,north and refuses the rest", () => {
    expect(svc.parseBbox("-85.71,37.97,-85.69,37.99")).toEqual({ w: -85.71, s: 37.97, e: -85.69, n: 37.99 });
    expect(svc.parseBbox("1,2,3")).toBeNull();
    expect(svc.parseBbox("2,0,1,1")).toBeNull();
    expect(svc.parseBbox("-190,0,1,1")).toBeNull();
  });
  it("snaps outward to a one-tile grid, so a small pan keeps the same box", () => {
    const a = svc.snapBbox({ w: -85.7101, s: 37.9701, e: -85.6901, n: 37.9901 }, 12);
    const b = svc.snapBbox({ w: -85.7102, s: 37.9702, e: -85.6902, n: 37.9902 }, 12);
    expect(a).toEqual(b);
    expect(a.w).toBeLessThanOrEqual(-85.7101);
    expect(a.n).toBeGreaterThanOrEqual(37.9901);
  });
});

describe("readLayer / newLayerConfig", () => {
  it("reads geometry, fields and the identity fields, and builds an entry that prefers GlobalID", async () => {
    answer = () => ({
      name: "Fiber Routes", geometryType: "esriGeometryPolyline", objectIdField: "OBJECTID", globalIdField: "GlobalID", maxRecordCount: 2000,
      fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }, { name: "GlobalID", type: "esriFieldTypeGlobalID" },
        { name: "ROUTE_NAME", type: "esriFieldTypeString", alias: "Route" }, { name: "bad name", type: "esriFieldTypeString" }],
    });
    const info = await svc.readLayer({ authMode: "none" }, LAYER.url + "/");
    expect(info).toMatchObject({ geometry: "line", objectIdField: "OBJECTID", globalIdField: "GlobalID", maxRecordCount: 2000 });
    expect(info.fields.map((f) => f.name)).toEqual(["OBJECTID", "GlobalID", "ROUTE_NAME"]);
    const entry = svc.newLayerConfig(info, "0123456789abcdef0123456789abcdef");
    expect(entry).toMatchObject({ geometry: "line", idField: "GlobalID", labelField: "ROUTE_NAME", itemId: "0123456789abcdef0123456789abcdef", style: { color: "accent" } });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("refuses a table", async () => {
    answer = () => ({ name: "Owners", fields: [] });
    const info = await svc.readLayer({ authMode: "none" }, LAYER.url);
    expect(() => svc.newLayerConfig(info)).toThrow(/table/);
  });
});

describe("searchItems / serviceLayers", () => {
  it("searches feature services and lists a service's map layers", async () => {
    answer = (r) => r.url.includes("/search")
      ? { total: 1, results: [{ id: "0123456789abcdef0123456789abcdef", title: "Fiber Network", owner: "gis", url: "https://services1.arcgis.com/abc/arcgis/rest/services/Fiber/FeatureServer/", modified: 0 }] }
      : { layers: [{ id: 0, name: "Routes", geometryType: "esriGeometryPolyline" }, { id: 1, name: "Handholes", geometryType: "esriGeometryPoint" }] };
    const found = await svc.searchItems({ authMode: "none" }, { q: 'fiber "x"' });
    expect(found.items[0]).toMatchObject({ title: "Fiber Network", url: "https://services1.arcgis.com/abc/arcgis/rest/services/Fiber/FeatureServer" });
    expect(new URL(calls[0].url).searchParams.get("q")).toBe('(fiber  x) AND type:"Feature Service"');
    const subs = await svc.serviceLayers({ authMode: "none" }, found.items[0].url);
    expect(subs.map((s) => [s.name, s.geometry, s.url.slice(-2)])).toEqual([["Routes", "line", "/0"], ["Handholes", "point", "/1"]]);
  });
});

describe("queryFeatures / featuresByIds", () => {
  it("asks for the snapped bbox in 4326, generalised for the zoom, and caches the answer", async () => {
    answer = () => ({ features: [
      { attributes: { GlobalID: "{A}", NAME: "TRUNK", COUNT: 48 }, geometry: { paths: [[[-85.7000001, 37.98], [-85.71, 37.99]]] } },
      { attributes: { GlobalID: null }, geometry: { paths: [[[0, 0], [1, 1]]] } },
    ], exceededTransferLimit: true });
    const bbox = { w: -85.72, s: 37.97, e: -85.69, n: 37.99 };
    const r = await svc.queryFeatures(LINE, bbox, 16);
    expect(r.truncated).toBe(true);
    expect(r.features).toEqual([{ id: "{A}", g: [[[-85.7, 37.98], [-85.71, 37.99]]], label: "TRUNK", attrs: { COUNT: 48 } }]);
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("inSR")).toBe("4326");
    expect(Number(q.get("maxAllowableOffset"))).toBeGreaterThan(0);
    await svc.queryFeatures(LINE, bbox, 16);
    expect(calls).toHaveLength(1);
  });
  it("by id quotes text values and posts the IN list with the layer's filter", async () => {
    m.integration.findMany.mockResolvedValue([{ config: { authMode: "none", layers: [{ ...LAYER, where: "S = 1" }] } }]);
    answer = () => ({ features: [] });
    await svc.featuresByIds(LINE, ["{A}", "it's", "42"]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].form!.where).toBe("(S = 1) AND GlobalID IN ('{A}','it''s',42)");
  });
  it("404s an unknown layer", async () => {
    await expect(svc.queryFeatures("11111111-2222-4333-8444-555555555555", { w: 0, s: 0, e: 1, n: 1 }, 10)).rejects.toThrow(/not configured/);
  });
});

describe("listMapLayers", () => {
  it("returns styles and an item link, never URLs or filters", async () => {
    m.integration.findMany.mockResolvedValue([{ config: { portalUrl: "https://www.arcgis.com", layers: [{ ...LAYER, itemId: "0123456789abcdef0123456789abcdef", where: "x = 1" }] } }]);
    const [l] = await svc.listMapLayers();
    expect(l).not.toHaveProperty("url");
    expect(l).not.toHaveProperty("where");
    expect(l.itemUrl).toBe("https://www.arcgis.com/home/item.html?id=0123456789abcdef0123456789abcdef");
  });
  it("lists only a by-type layer's ticked types, and its area", async () => {
    m.integration.findMany.mockResolvedValue([{ config: { layers: [{ ...LAYER, types: TYPES, extent: [-86, 37, -85, 38] }] } }]);
    const [l] = await svc.listMapLayers();
    expect(l.types!.values.map((v) => v.value)).toEqual(["GAS"]);
    expect(l.types!.other.on).toBe(false);
    expect(l.extent).toEqual([-86, 37, -85, 38]);
  });
});

// ─── Rule 188(b): drawn by type ──────────────────────────────────────────

const RED = { color: "#e53935", width: 3, dash: "dashed" as const };
const YEL = { color: "#f4e04d", width: 3, dash: "solid" as const };
const GRY = { color: "#9aa0a6", width: 2, dash: "solid" as const };
const TYPES = {
  field: "LINE_TYPE", numeric: false,
  values: [
    { value: "GAS", label: "Gas line", on: true, style: YEL },
    { value: "OH'E", label: "OH electric line", on: false, style: RED },
  ],
  other: { on: false, style: GRY },
};

describe("typesProblem", () => {
  it("accepts good types and names bad colours, duplicates, wrong kinds and too many", () => {
    expect(svc.typesProblem(TYPES)).toBeNull();
    expect(svc.typesProblem({ ...TYPES, other: { on: true, style: { ...GRY, color: "grey" } } })).toMatch(/not a colour/);
    expect(svc.typesProblem({ ...TYPES, values: [TYPES.values[0], TYPES.values[0]] })).toMatch(/twice/);
    expect(svc.typesProblem({ ...TYPES, numeric: true })).toMatch(/not a number/);
    expect(svc.typesProblem({ ...TYPES, field: "bad name" })).toMatch(/field name/);
    const many = Array.from({ length: 51 }, (_, i) => ({ value: `T${i}`, label: "", on: true, style: YEL }));
    expect(svc.typesProblem({ ...TYPES, values: many })).toMatch(/at most 50/);
    expect(svc.layersProblem([{ ...LAYER, types: { ...TYPES, field: "x y" } }])).toMatch(/Fiber Routes: .*field name/);
  });
});

describe("typeWhere / effectiveWhere", () => {
  it("asks only for ticked types, quotes text, and adds the other bucket", () => {
    expect(svc.typeWhere({ types: TYPES })).toBe("LINE_TYPE IN ('GAS')");
    expect(svc.typeWhere({ types: { ...TYPES, other: { on: true, style: GRY } } }))
      .toBe("LINE_TYPE IN ('GAS') OR (LINE_TYPE IS NULL OR LINE_TYPE NOT IN ('GAS','OH''E'))");
    const num = { field: "KIND", numeric: true, values: [{ value: 3, label: "", on: true, style: YEL }], other: { on: false, style: GRY } };
    expect(svc.typeWhere({ types: num })).toBe("KIND IN (3)");
  });
  it("is null when everything is drawn and false when nothing is", () => {
    const all = { ...TYPES, values: TYPES.values.map((v) => ({ ...v, on: true })), other: { on: true, style: GRY } };
    expect(svc.typeWhere({ types: all })).toBeNull();
    expect(svc.typeWhere({})).toBeNull();
    const none = { ...TYPES, values: TYPES.values.map((v) => ({ ...v, on: false })) };
    expect(svc.typeWhere({ types: none })).toBe(false);
    expect(svc.effectiveWhere({ types: none, where: "S = 1" })).toBe(false);
    expect(svc.effectiveWhere({ types: TYPES, where: "S = 1" })).toBe("(S = 1) AND (LINE_TYPE IN ('GAS'))");
    expect(svc.effectiveWhere({})).toBe("1=1");
  });
  it("queryFeatures sends the types' clause, returns each feature's type, and skips ArcGIS when nothing is ticked", async () => {
    m.integration.findMany.mockResolvedValue([{ config: { authMode: "none", layers: [{ ...LAYER, types: TYPES }] } }]);
    answer = () => ({ features: [{ attributes: { GlobalID: "{A}", NAME: "T", LINE_TYPE: "GAS" }, geometry: { paths: [[[-85, 38], [-85.1, 38.1]]] } }] });
    const r = await svc.queryFeatures(LINE, { w: -86, s: 37, e: -85, n: 38 }, 14);
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("where")).toBe("LINE_TYPE IN ('GAS')");
    expect(q.get("outFields")!.split(",")).toContain("LINE_TYPE");
    expect(r.features[0].t).toBe("GAS");
    svc.clearFeatureCache();
    const none = { ...TYPES, values: TYPES.values.map((v) => ({ ...v, on: false })) };
    m.integration.findMany.mockResolvedValue([{ config: { authMode: "none", layers: [{ ...LAYER, types: none }] } }]);
    calls = [];
    expect((await svc.queryFeatures(LINE, { w: -86, s: 37, e: -85, n: 38 }, 14)).features).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("symbolStyle", () => {
  it("turns an ArcGIS line symbol into a colour, a width and a line style", () => {
    expect(svc.symbolStyle({ type: "esriSLS", color: [229, 57, 53, 255], width: 2.25, style: "esriSLSDash" })).toEqual({ color: "#e53935", width: 3, dash: "dashed" });
    expect(svc.symbolStyle({ color: [0, 0, 255, 255], width: 1, style: "esriSLSDot" })).toEqual({ color: "#0000ff", width: 1, dash: "dotted" });
    expect(svc.symbolStyle({ color: [0, 0, 0], width: 20, style: "esriSLSSolid" })!.width).toBe(8);
    expect(svc.symbolStyle({ type: "CIMSymbolReference" })).toBeNull();
  });
});

describe("extentToWgs84 (rule 188(c))", () => {
  it("keeps WGS84, converts Web Mercator, and gives up on anything else", () => {
    expect(svc.extentToWgs84({ xmin: -86, ymin: 37, xmax: -85, ymax: 38, spatialReference: { wkid: 4326 } })).toEqual([-86, 37, -85, 38]);
    const e = svc.extentToWgs84({ xmin: -9573476, ymin: 4439106, xmax: -9462156, ymax: 4579425, spatialReference: { wkid: 102100, latestWkid: 3857 } })!;
    expect(e[0]).toBeCloseTo(-86, 2);
    expect(e[1]).toBeCloseTo(37, 2);
    expect(e[3]).toBeCloseTo(38, 2);
    expect(svc.extentToWgs84({ xmin: 1, ymin: 2, xmax: 3, ymax: 4, spatialReference: { wkid: 2246 } })).toBeNull();
    expect(svc.extentToWgs84(undefined)).toBeNull();
  });
  it("readLayer reports it and newLayerConfig keeps it", async () => {
    answer = () => ({ name: "L", geometryType: "esriGeometryPolyline", fields: [], extent: { xmin: -86, ymin: 37, xmax: -85, ymax: 38, spatialReference: { wkid: 4326 } } });
    const info = await svc.readLayer({ authMode: "none" }, LAYER.url);
    expect(svc.newLayerConfig(info).extent).toEqual([-86, 37, -85, 38]);
  });
});

describe("readTypes (rule 188(b))", () => {
  const DESC = {
    name: "Utility lines", geometryType: "esriGeometryPolyline", objectIdField: "OBJECTID",
    fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }, { name: "LINE_TYPE", type: "esriFieldTypeString" },
      { name: "LEN", type: "esriFieldTypeDouble" }, { name: "NAME", type: "esriFieldTypeString" }],
    drawingInfo: { renderer: { type: "uniqueValue", field1: "LINE_TYPE", uniqueValueInfos: [
      { value: "OH", label: "OH electric line", symbol: { type: "esriSLS", color: [229, 57, 53, 255], width: 2, style: "esriSLSDash" } },
      { value: "WATER", label: "Water line", symbol: { type: "esriSLS", color: [30, 136, 229, 255], width: 2, style: "esriSLSSolid" } },
    ] } },
  };
  it("lists ArcGIS's types first with its names and styles, then the rest by count, and counts the blanks", async () => {
    answer = (r) => new URL(r.url).pathname.endsWith("/query")
      ? { features: [{ attributes: { LINE_TYPE: "OH", polaris_n: 12 } }, { attributes: { LINE_TYPE: "GAS", polaris_n: 30 } },
        { attributes: { LINE_TYPE: "MISC", polaris_n: 4 } }, { attributes: { LINE_TYPE: null, polaris_n: 7 } }] }
      : DESC;
    const t = await svc.readTypes({ authMode: "none" }, LAYER.url, "line_type");
    expect(t.field).toBe("LINE_TYPE");
    expect(t.numeric).toBe(false);
    expect(t.blank).toBe(7);
    expect(t.values.map((v) => [v.value, v.label, v.count, v.fromArcgis])).toEqual([
      ["OH", "OH electric line", 12, true], ["WATER", "Water line", 0, true], ["GAS", "GAS", 30, false], ["MISC", "MISC", 4, false],
    ]);
    expect(t.values[0].style).toEqual({ color: "#e53935", width: 3, dash: "dashed" });
    expect(t.values[2].style.color).toMatch(/^#[0-9a-f]{6}$/);
    const stats = new URL(calls[1].url).searchParams;
    expect(stats.get("groupByFieldsForStatistics")).toBe("LINE_TYPE");
  });
  it("falls back to distinct values when the service cannot group", async () => {
    answer = (r) => {
      if (!new URL(r.url).pathname.endsWith("/query")) return { ...DESC, drawingInfo: undefined };
      if (new URL(r.url).searchParams.get("groupByFieldsForStatistics")) return { error: { code: 400, message: "Unable to perform query" } };
      return { features: [{ attributes: { LINE_TYPE: "GAS" } }, { attributes: { LINE_TYPE: "SEWER" } }] };
    };
    const t = await svc.readTypes({ authMode: "none" }, LAYER.url, "LINE_TYPE");
    expect(t.values.map((v) => [v.value, v.count])).toEqual([["GAS", null], ["SEWER", null]]);
  });
  it("refuses a missing field, a decimal field and a field with more than 50 values", async () => {
    answer = (r) => new URL(r.url).pathname.endsWith("/query")
      ? { features: Array.from({ length: 51 }, (_, i) => ({ attributes: { NAME: `Line ${i}`, polaris_n: 1 } })) }
      : DESC;
    await expect(svc.readTypes({ authMode: "none" }, LAYER.url, "NOPE")).rejects.toThrow(/no field/);
    await expect(svc.readTypes({ authMode: "none" }, LAYER.url, "LEN")).rejects.toThrow(/text or whole-number/);
    await expect(svc.readTypes({ authMode: "none" }, LAYER.url, "NAME")).rejects.toThrow(/51 different values/);
  });
});
