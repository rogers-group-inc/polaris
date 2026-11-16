/**
 * tests/unit/cableRunService.test.ts — connections routed through ArcGIS lines
 * (business rule 188(a)) with a mocked database: references must be
 * `<layer uuid>/<feature id>`, only a configured LINE layer's references are
 * kept, a malformed link key is refused, and an empty list straightens the
 * link. The round trip is pinned in tests/integration/cableRuns.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const LINE = "6d1f3a52-7c1e-4d4b-9a0e-2f5b8c9d0e11";
const POINT = "0b9e2f7c-5a41-4c3d-8e6f-1a2b3c4d5e6f";

const m = vi.hoisted(() => ({
  asset: { findUnique: vi.fn() },
  integration: { findMany: vi.fn() },
  cableRunLink: { findMany: vi.fn(), upsert: vi.fn((x: unknown) => ({ op: "upsert", x })), delete: vi.fn((x: unknown) => ({ op: "delete", x })) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
const logEventsBatch = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/db.js", () => ({ prisma: m }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEventsBatch }));

const { applyRunLinkEdits, listRunLinks, FEATURE_REF_RE } = await import("../../src/services/cableRunService.js");

beforeEach(() => {
  vi.clearAllMocks();
  m.asset.findUnique.mockResolvedValue({ assetType: "firewall", hostname: "HQ-FW01" });
  m.integration.findMany.mockResolvedValue([{ config: { layers: [
    { id: LINE, geometry: "line" }, { id: POINT, geometry: "point" },
  ] } }]);
  m.cableRunLink.findMany.mockResolvedValue([]);
});

describe("FEATURE_REF_RE", () => {
  it("takes a layer uuid, a slash and an identity value", () => {
    expect(FEATURE_REF_RE.test(`${LINE}/{3F2504E0-4F89-11D3-9A0C-0305E82C3301}`)).toBe(true);
    expect(FEATURE_REF_RE.test(`${LINE}/1234`)).toBe(true);
    expect(FEATURE_REF_RE.test("not-a-uuid/1")).toBe(false);
    expect(FEATURE_REF_RE.test(`${LINE}/a/b`)).toBe(false);
    expect(FEATURE_REF_RE.test(`${LINE}/has space`)).toBe(false);
  });
});

describe("applyRunLinkEdits", () => {
  it("keeps only references to a configured line layer, in order, de-duplicated", async () => {
    await applyRunLinkEdits("site-1", {
      "iface|a|b": [`${LINE}/2`, `${POINT}/7`, `${LINE}/1`, `${LINE}/2`, "11111111-2222-4333-8444-555555555555/9"],
    }, "alice");
    expect(m.cableRunLink.upsert).toHaveBeenCalledTimes(1);
    const arg = m.cableRunLink.upsert.mock.calls[0][0] as { create: { runIds: string[] } };
    expect(arg.create.runIds).toEqual([`${LINE}/2`, `${LINE}/1`]);
    expect(logEventsBatch).toHaveBeenCalledTimes(1);
  });

  it("an empty list deletes a stored route, and an unchanged one writes nothing", async () => {
    m.cableRunLink.findMany.mockResolvedValue([{ pathKey: "iface|a|b", runIds: [`${LINE}/1`] }, { pathKey: "iface|a|c", runIds: [`${LINE}/1`] }]);
    await applyRunLinkEdits("site-1", { "iface|a|b": [], "iface|a|c": [`${LINE}/1`] }, "alice");
    expect(m.cableRunLink.delete).toHaveBeenCalledTimes(1);
    expect(m.cableRunLink.upsert).not.toHaveBeenCalled();
  });

  it("refuses a malformed key, a malformed reference and too many lines", async () => {
    await expect(applyRunLinkEdits("site-1", { "no-pipes": [] }, "a")).rejects.toThrow(/Not a link key/);
    await expect(applyRunLinkEdits("site-1", { "iface|a|b": ["x"] }, "a")).rejects.toThrow(/Not an ArcGIS line reference/);
    await expect(applyRunLinkEdits("site-1", { "iface|a|b": Array.from({ length: 21 }, (_, i) => `${LINE}/${i}`) }, "a")).rejects.toThrow(/at most 20/);
  });

  it("refuses a site that is not a FortiGate", async () => {
    m.asset.findUnique.mockResolvedValue({ assetType: "switch", hostname: "sw" });
    await expect(applyRunLinkEdits("site-1", {}, "a")).rejects.toThrow(/Site not found/);
  });
});

describe("listRunLinks", () => {
  it("returns path key → references, skipping empty rows", async () => {
    m.cableRunLink.findMany.mockResolvedValue([{ pathKey: "k|a|b", runIds: [`${LINE}/1`] }, { pathKey: "k|a|c", runIds: [] }]);
    expect(await listRunLinks("site-1")).toEqual({ "k|a|b": [`${LINE}/1`] });
  });
});
