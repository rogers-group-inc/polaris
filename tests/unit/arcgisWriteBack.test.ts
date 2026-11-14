/**
 * tests/unit/arcgisWriteBack.test.ts — the pure half of the cable-run
 * write-back (services/arcgisWriteBackService.ts, business rule 185): which
 * layer URLs and configs are usable, what about a layer stops or only limits
 * write-back, and how one run becomes an ArcGIS feature.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const {
  featureLayerUrlProblem, writeBackConfigProblem, layerProblems, featureFor, POLARIS_FIELD_MAP,
} = await import("../../src/services/arcgisWriteBackService.js");

const LAYER = "https://services.example.com/abc/arcgis/rest/services/Telecom/FeatureServer/3";

describe("featureLayerUrlProblem", () => {
  it("takes one https layer of a feature service", () => {
    expect(featureLayerUrlProblem(LAYER)).toBeNull();
    expect(featureLayerUrlProblem(LAYER + "/")).toBeNull();
  });
  it("refuses http, a whole service, a query string, credentials and blocked hosts", () => {
    expect(featureLayerUrlProblem(LAYER.replace("https", "http"))).toMatch(/https/);
    expect(featureLayerUrlProblem(LAYER.replace(/\/3$/, ""))).toMatch(/layer number/);
    expect(featureLayerUrlProblem(LAYER + "?token=x")).toMatch(/query/);
    expect(featureLayerUrlProblem(LAYER.replace("https://", "https://u:p@"))).toMatch(/credentials/);
    expect(featureLayerUrlProblem("https://169.254.169.254/arcgis/rest/services/x/FeatureServer/0")).toMatch(/blocked/);
  });
});

describe("writeBackConfigProblem", () => {
  const ok = { writeBackEnabled: true, authMode: "apiKey" as const, featureLayerUrl: LAYER, fieldMap: { polarisId: "EXT_ID" } };
  it("is null when off, and when on with a layer, a sign-in and the Polaris ID mapped", () => {
    expect(writeBackConfigProblem({})).toBeNull();
    expect(writeBackConfigProblem(ok)).toBeNull();
  });
  it("needs a sign-in, a layer and the Polaris ID field", () => {
    expect(writeBackConfigProblem({ ...ok, authMode: "none" })).toMatch(/sign-in/);
    expect(writeBackConfigProblem({ ...ok, featureLayerUrl: "" })).toMatch(/layer/);
    expect(writeBackConfigProblem({ ...ok, fieldMap: {} })).toMatch(/Polaris ID/);
  });
});

const INFO = {
  name: "Telecom Routes", geometryType: "esriGeometryPolyline", hasZ: false, wkid: 4326, objectIdField: "OBJECTID",
  capabilities: ["Create", "Delete", "Query", "Update", "Editing"],
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID", length: null, editable: false, codedValues: null },
    { name: "EXT_ID", type: "esriFieldTypeString", alias: "Ext", length: 64, editable: true, codedValues: null },
    { name: "INSTALL_METHOD", type: "esriFieldTypeString", alias: "Method", length: 4, editable: true,
      codedValues: [{ code: "UG", name: "Underground" }, { code: "AE", name: "Aerial, power" }] },
  ],
};

describe("layerProblems", () => {
  it("passes a polyline layer with the mapped fields, warning about z and an unmapped code", () => {
    const r = layerProblems(INFO, { fieldMap: { polarisId: "EXT_ID", placement: "INSTALL_METHOD" }, valueMap: { placement: { trench: "UG", electric_pole: "AE" } } });
    expect(r.problems).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/telephone_pole/);
    expect(r.warnings.join(" ")).toMatch(/no z values/);
  });
  it("stops on a point layer, a missing capability, an unknown or read-only field", () => {
    const r = layerProblems(
      { ...INFO, geometryType: "esriGeometryPoint", capabilities: ["Query", "Create"] },
      { fieldMap: { polarisId: "NOPE", name: "OBJECTID" } },
    );
    const text = r.problems.join(" | ");
    expect(text).toMatch(/not lines/);
    expect(text).toMatch(/does not allow Update/);
    expect(text).toMatch(/no field "NOPE"/);
    expect(text).toMatch(/"OBJECTID" cannot be edited/);
  });
});

describe("featureFor", () => {
  const run = {
    id: "11111111-1111-4111-8111-111111111111", name: "Yard line", medium: "fiber", placement: "trench",
    points: [[-85.7, 37.98, 201.5], [-85.71, 37.99]], notes: "n", lengthM: 1234.5678,
    updatedAt: new Date("2026-11-13T12:00:00Z"), version: 2, arcgisObjectId: null, deletedAt: null, site: { hostname: "FGT-HQ" },
  };
  it("maps attributes by the field map and values by the value map", () => {
    const f = featureFor(run, { fieldMap: { polarisId: "EXT_ID", placement: "INSTALL_METHOD", lengthM: "LEN", site: "FAC" }, valueMap: { placement: { trench: "UG" } } }, { hasZ: false });
    expect(f.attributes).toEqual({ EXT_ID: run.id, INSTALL_METHOD: "UG", LEN: 1234.57, FAC: "FGT-HQ" });
    expect(f.geometry).toEqual({ paths: [[[-85.7, 37.98], [-85.71, 37.99]]], spatialReference: { wkid: 4326 } });
  });
  it("keeps z (0 where a point has none) for a z-enabled layer", () => {
    const f = featureFor(run, { fieldMap: POLARIS_FIELD_MAP }, { hasZ: true });
    expect(f.geometry).toEqual({ paths: [[[-85.7, 37.98, 201.5], [-85.71, 37.99, 0]]], spatialReference: { wkid: 4326 }, hasZ: true });
    expect(f.attributes.UPDATED_AT).toBe(Date.parse("2026-11-13T12:00:00Z"));
    expect(f.attributes.MEDIUM).toBe("fiber");
  });
});
