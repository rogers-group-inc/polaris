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
});
