/**
 * tests/unit/notificationDimensionService.test.ts — notificationDimensionService's
 * own suite (CQ-T010).
 *
 * Complements, rather than repeats:
 *   - automationDimensionValues.test.ts — foldValuePairs and the wizard's
 *     client-side picker / sibling narrowing (no server call);
 *   - interfacePickerDescriptions.test.ts — ifNamePattern offering an
 *     interface's description, on the pin-set and PoE-fault sources;
 *   - customWidgetCatalog.test.ts — listCustomWidgetCatalog.
 *
 * What this adds, server side: listDimensionValues' refusals (a dimension the
 * metric does not take, 400), the empty-scope answer with no sample read, the
 * monitored-only scope (rule 37) and the agent-host pool for a path metric,
 * the recent window then the one widened retry (with its tighter cap), the
 * sample cap and the candidateWhere narrowing that keeps a fleet-wide scope
 * from sampling 250 devices blind (prod 2026-08-21) — and the
 * `sampledAssets` disclosure it drives; the sibling narrowing reaching the
 * query (sensor class, SD-WAN health checks any-of, state probe) and its
 * label; state-probe and path-check names; the Polaris server counted as a
 * path-check source only when asked; the PoE-fault variant chosen only for
 * `poeStatus == fault`; ifTag reading only PINNED ports' tags (rule 133(g));
 * the 300-value cap; and dimensionPickerMeta never exposing the PoE variant.
 *
 * Instants are fixed with a faked Date; no samples exist — every read is a stub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const h = vi.hoisted(() => ({
  loadScopeAssetIds: vi.fn(),
  listStateProbes: vi.fn(),
}));

vi.mock("../../src/services/notificationEngine.js", () => ({ loadScopeAssetIds: h.loadScopeAssetIds }));
vi.mock("../../src/services/manufacturerProfileService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listStateProbes: h.listStateProbes,
}));

import { listDimensionValues, dimensionPickerMeta } from "../../src/services/notificationDimensionService.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const hoursBefore = (n: number) => new Date(NOW.getTime() - n * 3600_000);
const ids = (n: number, prefix = "a") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDbStub();
  h.loadScopeAssetIds.mockReset();
  h.loadScopeAssetIds.mockResolvedValue(["a1", "a2"]);
  h.listStateProbes.mockReset();
  h.listStateProbes.mockReturnValue([]);
  stubbed(prisma.assetHardwareSensorSample.groupBy).mockResolvedValue([]);
  stubbed(prisma.assetPerfSlaSample.groupBy).mockResolvedValue([]);
  stubbed(prisma.assetStateSample.groupBy).mockResolvedValue([]);
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
  stubbed(prisma.assetInterface.findMany).mockResolvedValue([]);
  stubbed(prisma.assetInterfaceTag.findMany).mockResolvedValue([]);
  stubbed(prisma.pathCheckSource.findMany).mockResolvedValue([]);
  stubbed(prisma.pathCheck.findMany).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("listDimensionValues — refusals and the empty scope", () => {
  it("refuses a dimension the metric does not take, before reading the scope", async () => {
    await expect(listDimensionValues("cpuPct", "sensorClass", { allAssets: true })).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.loadScopeAssetIds).not.toHaveBeenCalled();
  });

  it("answers an empty scope with no sample read, naming the noun and narrowing", async () => {
    h.loadScopeAssetIds.mockResolvedValue([]);
    const res = await listDimensionValues("hwSensorValue", "sensorNamePattern", { allAssets: true }, { sensorClass: "fan" });
    expect(res).toEqual({
      metric: "hwSensorValue", dimension: "sensorNamePattern", strict: false, noun: "hardware sensors",
      narrowLabel: " of class fan", scopedAssets: 0, values: [], sampledAssets: 0, assetsWithData: 0, windowHours: 3,
    });
    expect(prisma.assetHardwareSensorSample.groupBy).not.toHaveBeenCalled();
  });

  it("resolves the scope monitored-only (rule 37)", async () => {
    await listDimensionValues("hwSensorValue", "sensorClass", { tags: ["core"] });
    expect(h.loadScopeAssetIds).toHaveBeenCalledWith({ tags: ["core"] }, { monitoredOnly: true });
  });

  it("a path metric resolves against the agent-host pool, not the scope as written", async () => {
    await listDimensionValues("pathOk", "checkId", { allAssets: true });
    const scopeArg = h.loadScopeAssetIds.mock.calls[0][0];
    expect(scopeArg).not.toEqual({ allAssets: true });
  });
});

describe("listDimensionValues — windows and the sample cap", () => {
  it("reads the last 3 hours and returns the folded values, strict for a closed enum", async () => {
    stubbed(prisma.assetHardwareSensorSample.groupBy).mockResolvedValue([
      { sensorClass: "temperature", assetId: "a1" }, { sensorClass: "temperature", assetId: "a2" }, { sensorClass: "fan", assetId: "a1" },
    ]);
    const res = await listDimensionValues("hwSensorValue", "sensorClass", { allAssets: true });
    const q = stubbed(prisma.assetHardwareSensorSample.groupBy).mock.calls[0][0];
    expect(q).toEqual({ by: ["sensorClass", "assetId"], where: { assetId: { in: ["a1", "a2"] }, timestamp: { gte: hoursBefore(3) } } });
    expect(res).toMatchObject({
      strict: true, windowHours: 3, scopedAssets: 2, sampledAssets: 2, assetsWithData: 2,
      values: [{ value: "temperature", assetCount: 2 }, { value: "fan", assetCount: 1 }],
    });
  });

  it("widens once to 48 hours over at most 100 devices before saying 'none'", async () => {
    h.loadScopeAssetIds.mockResolvedValue(ids(180));
    stubbed(prisma.assetHardwareSensorSample.groupBy)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sensorClass: "voltage", assetId: "a0003" }]);
    const res = await listDimensionValues("hwSensorValue", "sensorClass", { allAssets: true });
    const [, second] = stubbed(prisma.assetHardwareSensorSample.groupBy).mock.calls.map((c) => c[0]);
    expect(second.where.timestamp).toEqual({ gte: hoursBefore(48) });
    expect(second.where.assetId.in).toHaveLength(100);
    // The retry covered 100 of the 180 scoped devices — a partial list, disclosed.
    expect(res).toMatchObject({ windowHours: 48, scopedAssets: 180, sampledAssets: 100, values: [{ value: "voltage", assetCount: 1 }] });
  });

  it("a small scope's widened retry still reports the whole scope as sampled", async () => {
    const res = await listDimensionValues("hwSensorValue", "sensorClass", { allAssets: true });
    expect(res).toMatchObject({ windowHours: 48, scopedAssets: 2, sampledAssets: 2, values: [], assetsWithData: 0 });
  });

  it("above the cap, narrows to the devices that CAN report the dimension; complete when they fit", async () => {
    h.loadScopeAssetIds.mockResolvedValue(ids(1000));
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a0999" }, { id: "a0005" }]);
    stubbed(prisma.assetPerfSlaSample.groupBy).mockResolvedValue([{ healthCheck: "HC_Internet", assetId: "a0005" }]);
    const res = await listDimensionValues("sdwanLatencyMs", "healthCheck", { allAssets: true });
    const narrow = stubbed(prisma.asset.findMany).mock.calls[0][0];
    expect(narrow.where.AND[1]).toEqual({ assetType: "firewall" });
    expect(stubbed(prisma.assetPerfSlaSample.groupBy).mock.calls[0][0].where.assetId.in).toEqual(["a0005", "a0999"]);
    // Exhaustive over every capable device: no partial-list disclosure.
    expect(res).toMatchObject({ scopedAssets: 1000, sampledAssets: 1000, values: [{ value: "HC_Internet", assetCount: 1 }] });
  });

  it("samples the first 250 (sorted) when even the capable set exceeds the cap, and says so", async () => {
    h.loadScopeAssetIds.mockResolvedValue(ids(400).reverse());
    stubbed(prisma.asset.findMany).mockResolvedValue(ids(300).map((id) => ({ id })));
    stubbed(prisma.assetPerfSlaSample.groupBy).mockResolvedValue([{ healthCheck: "HC", assetId: "a0000" }]);
    const res = await listDimensionValues("sdwanLatencyMs", "healthCheck", { allAssets: true });
    const queried = stubbed(prisma.assetPerfSlaSample.groupBy).mock.calls[0][0].where.assetId.in;
    expect(queried).toHaveLength(250);
    expect(queried[0]).toBe("a0000");
    expect(res.sampledAssets).toBe(250);
  });

  it("an identity dimension has no candidate filter: above the cap it samples blind and discloses it", async () => {
    h.loadScopeAssetIds.mockResolvedValue(ids(300));
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a0000", hostname: "SW-1" }]);
    const res = await listDimensionValues("cpuPct", "hostnamePattern", { allAssets: true });
    // The only asset read is the pairs read itself, over 250 ids.
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0].where.id.in).toHaveLength(250);
    expect(res).toMatchObject({ sampledAssets: 250, scopedAssets: 300 });
  });

  it("caps the distinct values at 300", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue(ids(2).map((id) => ({ id, monitoredStorage: ids(200, `/m${id}/`) })));
    const res = await listDimensionValues("storageUsedPct", "mountPathPattern", { allAssets: true });
    expect(res.values).toHaveLength(300);
  });
});

describe("listDimensionValues — sibling narrowing reaches the query", () => {
  it("narrows sensor names by class", async () => {
    await listDimensionValues("hwSensorValue", "sensorNamePattern", { allAssets: true }, { sensorClass: "temperature" });
    expect(stubbed(prisma.assetHardwareSensorSample.groupBy).mock.calls[0][0].where.sensorClass).toBe("temperature");
  });

  it("narrows SD-WAN members by ANY of the chosen health checks, and labels it", async () => {
    const res = await listDimensionValues("sdwanLatencyMs", "link", { allAssets: true }, { healthCheck: "HC_A|HC_B" });
    expect(stubbed(prisma.assetPerfSlaSample.groupBy).mock.calls[0][0].where.OR).toEqual([
      { healthCheck: { contains: "HC_A", mode: "insensitive" } },
      { healthCheck: { contains: "HC_B", mode: "insensitive" } },
    ]);
    expect(res.narrowLabel).toBe(" for health checks HC_A or HC_B");
  });

  it("narrows state-probe rows by probe and names the probe", async () => {
    h.listStateProbes.mockReturnValue([{ id: "p1", name: "PSU status", manufacturer: "APC" }]);
    const res = await listDimensionValues("customStateValue", "stateRowPattern", { allAssets: true }, { stateProbeId: "p1" });
    expect(stubbed(prisma.assetStateSample.groupBy).mock.calls[0][0].where.probeId).toBe("p1");
    expect(res.narrowLabel).toBe(" for probe PSU status");
  });
});

describe("listDimensionValues — names for opaque ids", () => {
  it("labels a state probe's id with its name and manufacturer", async () => {
    h.listStateProbes.mockReturnValue([{ id: "p1", name: "PSU status", manufacturer: "APC" }]);
    stubbed(prisma.assetStateSample.groupBy).mockResolvedValue([{ probeId: "p1", assetId: "a1" }, { probeId: "p-gone", assetId: "a1" }]);
    const res = await listDimensionValues("customStateValue", "stateProbeId", { allAssets: true });
    expect(res.values).toEqual([
      { value: "p-gone", assetCount: 1 },
      { value: "p1", assetCount: 1, label: "PSU status (APC)" },
    ]);
  });

  it("names path checks, and counts the Polaris server as a source only when the automation includes it", async () => {
    stubbed(prisma.pathCheck.findMany).mockResolvedValue([{ id: "k1", name: "Portal", kind: "https" }]);
    stubbed(prisma.pathCheckSource.findMany).mockResolvedValue([{ assetId: null, checkId: "k1" }, { assetId: "a1", checkId: "k1" }]);
    const res = await listDimensionValues("pathOk", "checkId", { allAssets: true }, { includeServer: true });
    expect(stubbed(prisma.pathCheckSource.findMany).mock.calls[0][0].where).toEqual({ OR: [{ assetId: { in: ["a1", "a2"] } }, { assetId: null }] });
    expect(res.values).toEqual([{ value: "k1", assetCount: 2, label: "Portal (HTTPS)" }]);

    await listDimensionValues("pathOk", "checkId", { allAssets: true });
    expect(stubbed(prisma.pathCheckSource.findMany).mock.calls[1][0].where).toEqual({ assetId: { in: ["a1", "a2"] } });
  });

  it("with the server included, an empty agent pool still offers the server's checks", async () => {
    h.loadScopeAssetIds.mockResolvedValue([]);
    stubbed(prisma.pathCheckSource.findMany).mockResolvedValue([{ assetId: null, checkId: "k1" }]);
    const res = await listDimensionValues("pathOk", "checkId", { allAssets: true }, { includeServer: true });
    expect(res.values).toEqual([{ value: "k1", assetCount: 1 }]);
  });
});

describe("listDimensionValues — interface sources", () => {
  it("offers the PIN SET for interfaces, except for a PoE fault condition (rule 57 carve-out)", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a1", monitoredInterfaces: ["port1"] }, { id: "a2", monitoredInterfaces: [] }]);
    const pinned = await listDimensionValues("poeStatus", "ifNamePattern", { allAssets: true }, { stateOperator: "==", stateValue: "on" });
    expect(pinned.noun).toBe("monitored interfaces");
    expect(pinned.values).toEqual([{ value: "port1", assetCount: 1 }]);
    // Descriptions are read only for devices that pin something.
    expect(stubbed(prisma.assetInterface.findMany).mock.calls[0][0].where.assetId).toEqual({ in: ["a1"] });

    stubbed(prisma.assetInterface.findMany).mockResolvedValue([{ assetId: "a2", ifName: "port9", alias: null }]);
    const fault = await listDimensionValues("poeStatus", "ifNamePattern", { allAssets: true }, { stateOperator: "==", stateValue: "other-fault" });
    expect(fault.noun).toBe("PoE-capable interfaces");
    expect(fault.values).toEqual([{ value: "port9", assetCount: 1 }]);
  });

  it("offers only the tags on PINNED ports (rule 133(g))", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a1", monitoredInterfaces: ["port1"] }]);
    stubbed(prisma.assetInterfaceTag.findMany).mockResolvedValue([
      { assetId: "a1", ifName: "port1", tag: "uplink" },
      { assetId: "a1", ifName: "port2", tag: "spare" },
      { assetId: "zz", ifName: "port1", tag: "orphan" },
    ]);
    const res = await listDimensionValues("ifOperStatus", "ifTag", { allAssets: true });
    expect(res.values).toEqual([{ value: "uplink", assetCount: 1 }]);
  });
});

describe("dimensionPickerMeta", () => {
  it("lists every picker dimension with its strictness, and never the PoE-fault variant", () => {
    const meta = dimensionPickerMeta();
    expect(meta.sensorClass).toEqual({ strict: true, noun: "hardware sensors" });
    expect(meta.ifNamePattern).toEqual({ strict: false, noun: "monitored interfaces" });
    expect(meta.checkId.strict).toBe(true);
    expect(Object.values(meta).some((m) => m.noun === "PoE-capable interfaces")).toBe(false);
  });
});
